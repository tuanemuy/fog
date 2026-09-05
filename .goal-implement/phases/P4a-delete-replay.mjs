import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const token=JSON.parse(await readFile('/tmp/fog-ai-local-token.json','utf8'));const fixture=JSON.parse(await readFile('/tmp/fog-p4a-api-results.json','utf8'));const log=[];
async function call(payload,status=200){const r=await fetch(token.origin+'/api/ai',{method:'POST',headers:{Authorization:'Bearer '+token.accessToken,'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));log.push({payload,status:r.status,data});return data;}
await call({operation:'content.delete',input:{kind:'memo',id:fixture.memoId,expectedVersion:2},idempotencyKey:'p4-delete-'+fixture.stamp});
const replay=await call({operation:'memos.create',input:fixture.memoRequest,idempotencyKey:fixture.memoKey});assert.equal(replay.replayed,true);assert.equal(replay.resource,null);assert.ok(!JSON.stringify(replay).includes(fixture.memoId));
const doc=await call({operation:'documents.get',input:{id:fixture.documentId}});assert.equal(doc.data.sourceMemos.length,0);assert.ok(!JSON.stringify(doc).includes(fixture.memoId));assert.ok(!JSON.stringify(doc).includes('deleted'));
await call({operation:'memos.get',input:{id:fixture.memoId}},404);
const topic=await call({operation:'topics.get',input:{id:fixture.topicId}});assert.ok(!JSON.stringify(topic).includes(fixture.memoId));
await writeFile('/tmp/fog-p4a-delete-replay.json',JSON.stringify(log,null,2));console.log({checks:log.length,replayResource:replay.resource,sourceMemos:doc.data.sourceMemos.length});
