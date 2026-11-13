import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {createHash} from 'node:crypto'
const root=new URL('../src/',import.meta.url),loaded=new Map(),data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64')
const hooks=registerHooks({resolve(s,c,n){if(s==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(){throw Error('Markdown outside this test')}`),shortCircuit:true};if(s==='zod')return{url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true};if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(u.href.endsWith('/framework/skills.ts'))return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw Error('Skills outside this test')}export function prepareFrameworkSkillIndex(){throw Error('Skills outside this test')}`),shortCircuit:true};if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}return n(s,c)},load(u,c,n){if(u.startsWith(root.href)&&u.endsWith('.ts')){const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})

const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {assignPhysicalWorker}=await import('../src/framework/physical-worker-assignment.ts')
const {physicalReceiver}=await import('./test-support/physical-receiver.mjs')
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-worker-assignment-'))
const input={commandId:'actual-command',taskId:'task',workerRoot:'task-runs/task/A/workers/worker',contractPath:'task-runs/task/A/workers/worker/contract.md',notePath:'task-runs/task/A/workers/worker/notes.md',replyPath:'task-runs/task/A/workers/worker/reply.md',plannerMemoryPath:'task-runs/task/A/Planner_Memory.md',signalPath:'state/A/task/Worker_worker',contract:'原 contract\n',decision:'实际分派决定\n'}
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const read=async(files,p)=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
async function fixture(name){const files=new PhysicalLocalFiles(path.join(scratch,name));await files.replace('tasks/task.json',JSON.stringify({version:1,taskId:'task',route:'P',owner:'A',status:'running'}));await files.replace(input.plannerMemoryPath,'原记忆\n');await files.replace(input.replyPath,'跨轮 Reply');return files}
try {
 const trace=await fixture('trace'),calls=[]
 for(const method of ['replace','rename','createIfAbsent','delete']){const actual=trace[method].bind(trace);trace[method]=async(...args)=>{calls.push([method,...args]);return actual(...args)}}
 await assignPhysicalWorker(trace,input,()=>{},()=>{});check(await read(trace,input.plannerMemoryPath),'原记忆\n实际分派决定\n');check(await read(trace,input.replyPath),'跨轮 Reply');check(await read(trace,input.signalPath),'')
 check((await fs.readdir(path.join(trace.directory,input.workerRoot))).filter(x=>x.startsWith('.assignment-')),[])
 const originalCalls=calls.slice();const first=await read(trace,input.workerRoot+'/assignment.json');await trace.delete(input.signalPath);await trace.replace(input.contractPath,'用户改过的契约')
 await assignPhysicalWorker(trace,input,()=>{},()=>{});check(await read(trace,input.signalPath),undefined);check(await read(trace,input.contractPath),'用户改过的契约');check(await read(trace,input.workerRoot+'/assignment.json'),first);await trace.close()
 // Fail before and after each actual observable addressed filesystem operation.
 // Reconstruct the store, preserving only its actual files, then retry the same identity.
 for(const when of ['before','after'])for(let stop=0;stop<originalCalls.length;stop++){
  let files=await fixture(when+'-'+stop),step=0,hit=false,published=false
  for(const method of ['replace','rename','createIfAbsent','delete']){const actual=files[method].bind(files);files[method]=async(...args)=>{
   const ordinal=step++;if(ordinal===stop&&when==='before'){hit=true;throw Error('actual interruption')}
   const result=await actual(...args);if(method==='rename'&&args[1]===input.signalPath&&result)published=true
   if(ordinal===stop&&when==='after'){hit=true;throw Error('actual interruption')}return result
  }}
  await assert.rejects(assignPhysicalWorker(files,input,()=>{},()=>{}),/actual interruption/);assertions++;check(hit,true)
  // Model only the real receiver consuming an already-published empty signal.
  if(published && await files.fileInfo(input.signalPath)) await (await physicalReceiver(files,'A',loaded)).accept(input.signalPath)
  const dir=files.directory;await files.close();files=new PhysicalLocalFiles(dir)
  await assignPhysicalWorker(files,input,()=>{},()=>{},(await physicalReceiver(files,'A',loaded)).sources)
  check(await read(files,input.plannerMemoryPath),'原记忆\n实际分派决定\n')
  check(await read(files,input.replyPath),'跨轮 Reply')
  check(await read(files,input.signalPath),published?undefined:'')
  check((await fs.readdir(path.join(dir,input.workerRoot))).filter(x=>x.startsWith('.assignment-')),[])
  await files.close()
 }
 // Reassignment of this existing child is a current-contract update, not a
 // new job queue. Preserve Planner history and do not let an earlier wake
 // consume the newly published notification.
 const repeat=await fixture('repeat')
 await assignPhysicalWorker(repeat,input,()=>{},()=>{})
 let live=await repeat.snapshot();const oldSignal=(await repeat.listDirectory(live,'state/A/task/'))[0];await live.release()
 const revised={...input,commandId:'new-command',contract:'revised current contract',decision:'actual revised assignment\n'}
 await assignPhysicalWorker(repeat,revised,()=>{},()=>{})
 check(await read(repeat,input.contractPath),'revised current contract')
 check(await read(repeat,input.plannerMemoryPath),'原记忆\n实际分派决定\nactual revised assignment\n')
 check(await repeat.deleteObserved(input.signalPath,oldSignal.version),false)
 live=await repeat.snapshot();const newSignal=(await repeat.listDirectory(live,'state/A/task/'))[0];await live.release()
 check(await repeat.deleteObserved(input.signalPath,newSignal.version),true)
 await assignPhysicalWorker(repeat,revised,()=>{},()=>{});check(await read(repeat,input.signalPath),undefined)
 // Same content under a genuinely new command is a new requested continuation,
 // not a retry guessed from equal bytes.
 const continuation={...revised,commandId:'same-content-new-command'}
 await assignPhysicalWorker(repeat,continuation,()=>{},()=>{})
 check(await read(repeat,input.signalPath),'')
 check(await read(repeat,input.plannerMemoryPath),'原记忆\n实际分派决定\nactual revised assignment\nactual revised assignment\n')
 await repeat.close()
 // A pending assignment waits only its own actual files, not another Task.
 const independent=await fixture('independent');let unblock,entered
 const reached=new Promise(r=>entered=r),gate=new Promise(r=>unblock=r),rename=independent.rename.bind(independent)
 independent.rename=async(a,b)=>{if(b===input.contractPath){entered();await gate}return rename(a,b)}
 const firstAssignment=assignPhysicalWorker(independent,input,()=>{},()=>{});await reached
 const other={...input,taskId:'other',workerRoot:input.workerRoot.replaceAll('task/','other/'),contractPath:input.contractPath.replaceAll('task/','other/'),notePath:input.notePath.replaceAll('task/','other/'),replyPath:input.replyPath.replaceAll('task/','other/'),plannerMemoryPath:input.plannerMemoryPath.replaceAll('task/','other/'),signalPath:input.signalPath.replaceAll('task/','other/')}
 await assignPhysicalWorker(independent,other,()=>{},()=>{});check(await read(independent,other.signalPath),'');unblock();await firstAssignment;await independent.close()
 console.log(JSON.stringify({status:'passed',assertions,interruptedOperations:originalCalls.length*2,limits:'Actual physical assignment and cold file-backed store reconstruction at addressed method failures; no OS crash durability/nativeDSH/Windows or cross-process guarantee claimed.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
