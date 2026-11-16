import {build} from 'esbuild'; import {mkdtemp,rm} from 'node:fs/promises'; import {join} from 'node:path'; import {pathToFileURL} from 'node:url'; import assert from 'node:assert/strict';
const tmp=await mkdtemp(join(process.cwd(),'scripts/.catalog-arrival-'));
try {
 await build({entryPoints:['/workspace/scratch/dfd5b1050ee3/outputs/dss-linux-actual-20261114/host-rc3/node_modules/@deepseek-ai/dsh-api-session-controller/src/client/sessions/manager.ts'],outfile:join(tmp,'manager.mjs'),bundle:true,platform:'node',format:'esm',packages:'external'});
 const {SessionManager}=await import(pathToFileURL(join(tmp,'manager.mjs')));let remoteCalls=0;const remote=new Proxy({}, {get(){remoteCalls++;throw Error('Unexpected remote request')}}); const m=new SessionManager(remote);const id='dss-catalog-arrival-test';
 assert.throws(()=>m.resolveTarget(id),/unknown session/);assert.equal(m.getListSnapshot().phase,'pending');
 m.handleSessionAdded({sessionId:id,cwd:'/isolated-test',running:false,blank:true,createdAt:1,updatedAt:1});await new Promise(r=>queueMicrotask(r));
 assert.equal(m.resolveTarget(id),id);assert.equal(m.getListSnapshot().items.some(x=>x.sessionId===id),true);
 const resident=m.get(id);assert.equal(resident.getSnapshot().removed,false);m.handleSessionRemoved(id);await new Promise(r=>queueMicrotask(r));assert.equal(m.resolveTarget(id),id);assert.equal(resident.getSnapshot().removed,true);assert.equal(remoteCalls,0);
 console.log(JSON.stringify({status:'passed',checks:7,limits:'Actual official SessionManager with controlled native catalog events; verifies catalog arrival plus explicit removed resident snapshot despite retained identity without remote requests, not browser failure attribution.'},null,2));
} finally {await rm(tmp,{recursive:true,force:true})}
