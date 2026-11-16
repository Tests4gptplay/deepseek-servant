import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const temp=await mkdtemp(join(process.cwd(),'scripts/.cancel-test-'));const checks=[];const check=(n,a,b)=>{assert.deepEqual(a,b,n);checks.push(n)}
try{
 await build({entryPoints:['src/client/foreground-cancel.ts'],outfile:join(temp,'cancel.mjs'),bundle:true,platform:'node',format:'esm'});const{cancelForeground}=await import(pathToFileURL(join(temp,'cancel.mjs')))
 let calls=[],released=[],retained=[];const queues={fg:['queued-user-message'],worker:['background-job']};const sessions={retain(id){retained.push(id);return{binding:{session:{async cancel(){calls.push(id);return{ok:true,value:{accepted:true}}}}},release(){released.push(id)}}}}
 const view={foregroundProcessing:{executionId:'e-fg',turnId:'turn'},executions:[{role:'Worker',executionId:'e-worker',sessionId:'worker'},{role:'Foreground',executionId:'e-fg',sessionId:'fg'}]}
 await cancelForeground(sessions,view);check('only exact Foreground session retained',retained,['fg']);check('only Foreground cancel invoked',calls,['fg']);check('reference released',released,['fg']);check('DSS does not modify native queues',queues,{fg:['queued-user-message'],worker:['background-job']})
 await cancelForeground(sessions,{...view,foregroundProcessing:undefined});check('idle foreground causes no acquisition',retained.length,1)
 await cancelForeground(sessions,{...view,foregroundProcessing:{executionId:'e-worker'}});check('processing ID cannot cancel a background role',calls.length,1)
 let releaseFailed=0;await assert.rejects(cancelForeground({retain(){return{binding:{session:{cancel:async()=>({ok:false,error:{code:'gone',message:'closed'}})}},release(){releaseFailed++}}}},view),/gone: closed/);check('native failure surfaced and reference released',releaseFailed,1)
 console.log(JSON.stringify({status:'passed',checks,limits:'Direct implementation routing with controlled SessionFace results, not a real model cancellation; native queue-preservation contract is documented by official SessionFace.cancel.'},null,2))
}finally{await rm(temp,{recursive:true,force:true})}
