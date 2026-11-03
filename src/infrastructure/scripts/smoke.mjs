// Isolated smoke checks: synthetic local configuration; never uses a real database.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const socket=createServer();
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const env={...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),API_PUBLIC_URL:`http://127.0.0.1:${port}`,
 DATABASE_URL:'postgresql://127.0.0.1:9/unavailable',REDIS_URL:'redis://127.0.0.1:9',
 ERPNEXT_URL:'http://127.0.0.1:9',FRAPPE_API_KEY:'local-test',FRAPPE_API_SECRET:'local-test',
 KEYCLOAK_BASE_URL:'http://127.0.0.1:9',DATA_ENCRYPTION_KEY:randomBytes(32).toString('base64')};
function launch(file){let output='';const child=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);return {child,output:()=>output};}
async function stop(child){if(child.exitCode!==null)return;child.kill('SIGTERM');await new Promise(resolve=>{const timeout=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('exit',()=>{clearTimeout(timeout);resolve();});});}
const api=launch('dist/server.mjs');
try{
 const deadline=Date.now()+10000;
 while(!api.output().includes('listening')){assert.equal(api.child.exitCode,null,api.output());if(Date.now()>deadline)throw Error('API startup timeout');await new Promise(r=>setTimeout(r,50));}
 const origin=`http://127.0.0.1:${port}`;
 const get=path=>fetch(origin+path);
 assert.equal((await get('/livez')).status,200);
 assert.match(await (await get('/docs')).text(),/swagger-ui/);
 assert.equal((await get('/docs/swagger-ui-bundle.js')).status,200);
 const swaggerInit=await get('/docs/init.js');assert.equal(swaggerInit.status,200);
 const swaggerScript=await swaggerInit.text();
 assert.match(swaggerScript,/usePkceWithAuthorizationCodeGrant:true/);
 assert.match(swaggerScript,/clientId:'frontend-konektag'/);
 const redirectHtml=await (await get('/docs/oauth2-redirect.html')).text();
 assert.match(redirectHtml,/oauth2-redirect\\.js/);
 const redirectJs=await get('/docs/oauth2-redirect.js');
 assert.equal(redirectJs.status,200);
 assert.match(redirectJs.headers.get('content-type')||'',/javascript/);
 assert.match(await redirectJs.text(),/swaggerUIRedirectOauth2/);
 const spec=await (await get('/openapi.json')).json();assert.equal(spec.openapi,'3.1.0');assert.equal(Object.keys(spec.paths).length,307);
 assert.equal((await get('/api/account/balance')).status,401);
 const invalidLegal=await get('/api/legal-documents');assert.equal(invalidLegal.status,422);assert.deepEqual(await invalidLegal.json(),{error:'legal_country_required'});
 assert.equal((await fetch(origin+'/api/pay/payments',{method:'POST',body:'{}',headers:{'content-type':'application/json'}})).status,401);
 const legacyPost=await fetch(origin+'/v1/payments',{method:'POST',body:'{}',headers:{'content-type':'application/json'}});
 assert.equal(legacyPost.status,401);assert.deepEqual(await legacyPost.json(),{error:'Invalid API key'});
 assert.equal((await get('/v1/payments/existing')).status,401);
 assert.equal((await get('/missing')).status,404);
 const health=await get('/api/internal/health');assert.equal(health.status,503);assert.deepEqual((await health.json()).checks,{postgresql:false,redis:false});
 console.log('HTTP smoke passed: docs, OpenAPI, real validation, anonymous denial, dependency failure');
}finally{await stop(api.child);}
for(const [file,marker] of [['dist/outbox-worker.mjs','Starting dispatcher'],['dist/accounting-worker.mjs','Standalone entry point starting']]){
 const worker=launch(file);
 try{
  const deadline=Date.now()+5000;
  while(!worker.output().includes(marker)){
   assert.equal(worker.child.exitCode,null,worker.output());
   if(Date.now()>deadline)throw Error('Worker startup timeout');await new Promise(r=>setTimeout(r,50));
  }
  console.log(`${file}: independent entry point starts (database deliberately unavailable; no event processed)`);
 }finally{await stop(worker.child);}
}
