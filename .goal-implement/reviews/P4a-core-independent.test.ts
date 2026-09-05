import { fork } from 'node:child_process';
import { createClient } from '@libsql/client';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createFogServices } from '../../packages/core/src/application/fog/services';
import { nodeSecretCrypto } from '../../packages/core/src/adapters/fog/crypto';
import { migrateFog } from '../../packages/core/src/adapters/fog/schema';
import { LibsqlFogUnitOfWork } from '../../packages/core/src/adapters/fog/unitOfWork';
import { UuidV7Generator } from '../../packages/core/src/application/ports/idGenerator';
const redirectUri='http://127.0.0.1:9876/callback';
const clients=[{id:'independent',name:'検証AI',redirectUris:[redirectUri]}];
const verifier='v'.repeat(43);
let dir:any,client:any,services:any,a:any,token:string,now:Date;
const children:any[]=[];
beforeEach(async()=>{
 dir=await mkdtemp(path.join(os.tmpdir(),'fog-p4-independent-'));client=createClient({url:`file:${dir}/db`});
 for(const sql of ['PRAGMA journal_mode=WAL','PRAGMA foreign_keys=ON','PRAGMA busy_timeout=5000']) await client.execute(sql);
 await migrateFog(client);now=new Date('2026-09-05T12:00:00.000Z');
 services=await createFogServices({unitOfWork:new LibsqlFogUnitOfWork(client),crypto:nodeSecretCrypto,ids:UuidV7Generator,clock:{now:()=>now},aiClients:clients});
 a=(await services.register({email:'independent@example.com',password:'independent-password'})).user;
 token=(await services.exchangeAiCode(await codeInput())).accessToken;
});
afterEach(async()=>{for(const child of children.splice(0)) if(!child.killed)child.kill();client.close();await rm(dir,{recursive:true,force:true});});
async function codeInput(){
 const r=await services.beginAiAuthorization({clientId:'independent',redirectUri,state:'separate-process',codeChallenge:nodeSecretCrypto.pkceChallenge(verifier),codeChallengeMethod:'S256'});
 await services.getAiAuthorization(a,r.requestToken);
 const approved=await services.decideAiAuthorization(a,{requestToken:r.requestToken,allow:true});
 return {clientId:'independent',redirectUri,code:new URL(approved.redirectUri).searchParams.get('code'),codeVerifier:verifier};
}
async function worker(job:any){
 const child=fork(path.resolve('apps/web/node_modules/tsx/dist/cli.mjs'),[path.resolve('.goal-implement/reviews/P4a-core-worker.ts')],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);
 let stderr='';child.stderr?.on('data',(x)=>{stderr+=x;});
 const ready=new Promise<void>((resolve,reject)=>{child.once('message',(m:any)=>m.ready?resolve():reject(m));child.once('error',reject);child.once('exit',(code)=>{if(code)reject(new Error(stderr));});});
 child.send({url:`file:${dir}/db`,now:now.toISOString(),clients,...job});await ready;
 return ()=>new Promise<any>((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.send({go:true});});
}
const count=async(table:string)=>Number((await client.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n);
test('independent OS processes atomically exchange one code using production busy_timeout',async()=>{
 const exchange=await codeInput();
 const stored=JSON.stringify((await client.execute('SELECT * FROM fog_ai_authorization_codes')).rows);
 expect(stored).not.toContain(exchange.code);expect(stored).not.toContain(verifier);
 const workers=await Promise.all([worker({exchange}),worker({exchange})]);
 const result=await Promise.all(workers.map(run=>run()));
 expect(result.filter(x=>x.ok)).toHaveLength(1);expect(result.filter(x=>!x.ok).map(x=>x.code)).toEqual(['INVALID_AI_CODE']);
 expect(await count('fog_ai_connections')).toBe(2);expect(await count('fog_ai_authorization_codes')).toBe(0);
});
test('independent OS processes and restarted process replay same durable write exactly once',async()=>{
 const request={operation:'memos.create',input:{body:'別プロセス永続保存'},idempotencyKey:'process-key'};
 const workers=await Promise.all([worker({token,request}),worker({token,request})]);const replies=await Promise.all(workers.map(run=>run()));
 expect(replies.every(x=>x.ok)).toBe(true);expect(new Set(replies.map(x=>x.result.requestId)).size).toBe(1);expect(replies.filter(x=>!x.result.replayed)).toHaveLength(1);
 const restarted=await(await worker({token,request}))();expect(restarted).toMatchObject({ok:true,result:{replayed:true,requestId:replies[0].result.requestId}});
 expect(await count('fog_memos')).toBe(1);expect(await count('fog_memo_revisions')).toBe(1);expect(await count('fog_ai_idempotency')).toBe(1);
});
test('failed document revision and topic-set delete roll back content, ledger and lastUsed; successful retry retains history',async()=>{
 const topic=await services.createTopic(a,{title:'topic',description:''});
 const doc=await services.createDocument(a,{topicId:topic.id,title:'old',body:'first alpha last',sourceMemoIds:[]});
 const patch={operation:'documents.patch',input:{id:doc.id,expectedVersion:1,find:'alpha',replace:'beta',reason:'required'},idempotencyKey:'patch'};
 await client.execute("CREATE TRIGGER fail_revision BEFORE INSERT ON fog_document_revisions BEGIN SELECT RAISE(ABORT,'injected'); END");
 await expect(services.executeAi(token,patch)).rejects.toMatchObject({code:'STORAGE_CONFLICT'});
 expect(await services.getDocument(a,doc.id)).toMatchObject({body:'first alpha last',version:1});expect(await count('fog_document_revisions')).toBe(1);expect(await count('fog_ai_idempotency')).toBe(0);expect((await services.listAiConnections(a))[0].lastUsedAt).toBeNull();
 await client.execute('DROP TRIGGER fail_revision');await services.executeAi(token,patch);
 const used=(await services.listAiConnections(a))[0].lastUsedAt;now=new Date(now.getTime()+10000);
 await client.execute("CREATE TRIGGER fail_delete_ledger BEFORE INSERT ON fog_ai_idempotency BEGIN SELECT RAISE(ABORT,'injected'); END");
 const del={operation:'content.delete',input:{kind:'topic',id:topic.id,expectedVersion:1},idempotencyKey:'topic-delete'};
 await expect(services.executeAi(token,del)).rejects.toMatchObject({code:'STORAGE_CONFLICT'});
 expect((await services.getTopic(a,topic.id)).documents).toHaveLength(1);expect((await services.trash(a)).items).toHaveLength(0);expect(await count('fog_ai_idempotency')).toBe(1);expect((await services.listAiConnections(a))[0].lastUsedAt).toBe(used);
 await client.execute('DROP TRIGGER fail_delete_ledger');await services.executeAi(token,del);await services.restore(a,{kind:'topic',id:topic.id});
 expect(await services.executeAi(token,del)).toMatchObject({replayed:true,resource:null});expect((await services.getTopic(a,topic.id)).documents).toHaveLength(1);expect(await services.documentHistory(a,doc.id)).toHaveLength(2);
});
test('every human-only core service rejects a runtime AI actor and revoked tokens reject fresh, read and replay operations',async()=>{
 const ai={kind:'ai',userId:a.userId,clientId:'independent',clientName:'検証AI'};
 const forbidden=[()=>services.memoHistory(ai,'x'),()=>services.documentHistory(ai,'x'),()=>services.rollbackMemo(ai,{id:'x',version:1,expectedVersion:1}),()=>services.rollbackDocument(ai,{id:'x',version:1,expectedVersion:1}),()=>services.trash(ai),()=>services.restore(ai,{kind:'memo',id:'x'}),()=>services.hardDelete(ai,{kind:'memo',id:'x'}),()=>services.emptyTrash(ai),()=>services.getSettings(ai),()=>services.setRetentionDays(ai,{retentionDays:30}),()=>services.exportData(ai)];
 for(const call of forbidden) await expect(call()).rejects.toMatchObject({code:'HUMAN_ONLY'});
 const request={operation:'memos.create',input:{body:'never leak old body'},idempotencyKey:'revoked-replay'};
 await services.executeAi(token,request);const connection=(await services.listAiConnections(a))[0];await services.revokeAiConnection(a,{id:connection.id});
 for(const req of [request,{...request,idempotencyKey:'fresh'},{operation:'memos.recent',input:{}},{operation:'guidance',input:{}}])await expect(services.executeAi(token,req)).rejects.toMatchObject({code:'AI_CONNECTION_UNAUTHORIZED'});
 expect(await count('fog_memos')).toBe(1);
});
