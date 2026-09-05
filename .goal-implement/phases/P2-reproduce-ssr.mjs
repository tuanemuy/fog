import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require=createRequire(process.cwd()+'/node_modules/.pnpm/seroval@1.5.4/node_modules/seroval/package.json');
const {toJSONAsync,fromCrossJSON,createPlugin}=require('seroval');
const base='http://localhost:3000';
let cookie='';
async function call(file,name,data){
 const source=await(await fetch(base+'/app/presentation/'+file+'.tsx')).text();
 const id=source.match(new RegExp(`export const ${name}.*createClientRpc\\("([^\\"]+)"\\)`))[1];
 const response=await fetch(base+'/_serverFn/'+id,{method:'POST',headers:{'content-type':'application/json',origin:base,'x-tsr-serverFn':'true',cookie},body:JSON.stringify(await toJSONAsync({data}))});
 if(response.headers.has('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
 const body=await response.text();
 if(!response.ok) throw Error(response.status+' '+body);
 return fromCrossJSON(JSON.parse(body), {refs:new Map()}).result;
}
await call('fogActions','registerFog',{email:'history-http-'+Date.now()+'@example.test',password:'local-history-check-123'});
const memo=await call('fogActions','createFogMemo',{body:'history initial'});
await call('fogMemoActions','editFogMemo',{id:memo.id,body:'history changed <budget>',expectedVersion:memo.version});
const history=await(await fetch(base+'/memos/'+memo.id+'/history',{headers:{cookie}})).text();
const timeline=await(await fetch(base+'/timeline',{headers:{cookie}})).text();
await writeFile('/tmp/fog-history-http.html',history);await writeFile('/tmp/fog-timeline-http.html',timeline);
console.log({id:memo.id,historyLength:history.length,timelineLength:timeline.length});
