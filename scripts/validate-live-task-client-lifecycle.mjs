import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {createHash} from 'node:crypto'
const root=new URL('../src/',import.meta.url),loaded=new Map(),data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64')
const hooks=registerHooks({resolve(s,c,n){if(s==='zod')return{url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true};if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}return n(s,c)},load(u,c,n){if(u.startsWith(root.href)&&u.endsWith('.ts')){const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})

const {FrameworkTaskStateObservation}=await import('../src/framework/task-state-observation.ts')
const {createClientFaults}=await import('../src/framework/client-faults.ts')
const {safetyPresentation}=await import('../src/framework/client-error.ts')
const {taskCancellationNotice}=await import('../src/framework/client-contracts.ts')
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
try {
 const rootTask={version:1,taskId:'root',lifecycleId:'l1',route:'O',sourcePath:'tasks/root_O.md',owner:'A',status:'running',children:[{taskId:'child',objectiveId:'work',member:'B'},{taskId:'sibling',objectiveId:'other',member:'B'}]}
 const child={version:1,taskId:'child',route:'P',sourcePath:'tasks/child_P.md',owner:'B',status:'running',parent:{taskId:'root',owner:'A',objectiveId:'work'}}
 const sibling={...child,taskId:'sibling',sourcePath:'tasks/sibling_P.md',parent:{...child.parent,objectiveId:'other'}}
 const emitted=[],round={},local=new FrameworkTaskStateObservation(x=>emitted.push(x),e=>{throw e},'local')
 // Local Runtime supplies its independently resolved control to localTask;
 // this display unit does not reconstruct the former Local task()/controls() path.
 local.begin(round);local.listed(round,'live',[{path:'tasks/root.json'},{path:'tasks/child.json'},{path:'tasks/sibling.json'}])
 const pause={taskId:'root',lifecycleId:'l1',intent:'paused',commandId:'pause',requestedAt:'2026-11-08'}
 local.localTask(round,'live',rootTask,pause);local.localTask(round,'live',child,pause)
 check(emitted.at(-1).task.control,'paused')
 local.localTask(round,'live',{...child,status:'complete'},undefined);check(emitted.at(-1).task.status,'complete')
 const n=emitted.length;local.localTask(round,'live',{...child,status:'complete'},undefined);check(emitted.length,n)
 // A still-running sibling changes its independently resolved control. The
 // completed child stays complete; this unit does not invent a terminal reopen.
 local.localTask(round,'live',sibling,pause);check(emitted.at(-1).task.control,'paused')
 local.localTask(round,'live',sibling,undefined);check(emitted.at(-1).task.taskId,'sibling');check(emitted.at(-1).task.control,undefined)
 const oldRound={},gitEvents=[],git=new FrameworkTaskStateObservation(x=>gitEvents.push(x),e=>{throw e},'git')
 git.begin(oldRound);git.controls(oldRound,'head',[]);git.listed(oldRound,'head',[{path:'tasks/root.json'}]);await git.task(oldRound,'head',rootTask);await git.task(oldRound,'head',{...rootTask,status:'complete'});check(gitEvents.length,1);check(gitEvents[0].task.status,'running')
 // Git metadata can arrive child-first from independent reads. Its real
 // ancestor dependency remains pending until that parent read completes.
 const familyRound={},beforeFamily=gitEvents.length
 git.begin(familyRound);git.controls(familyRound,'family',[pause]);git.listed(familyRound,'family',[{path:'tasks/root.json'},{path:'tasks/child.json'}])
 await git.task(familyRound,'family',child);check(gitEvents.length,beforeFamily)
 await git.task(familyRound,'family',rootTask)
 check(gitEvents.length,beforeFamily+2);check(gitEvents.at(-1).task.taskId,'child');check(gitEvents.at(-1).task.control,'paused')
 const beforeBoundary=emitted.length;local.viewBoundary();local.localTask(round,'live',{...rootTask,status:'cancelled'},undefined);check(emitted.length,beforeBoundary)
 const calls=[],deliveries=[],faults=createClientFaults(input=>{calls.push(input);return new Promise((resolve,reject)=>deliveries.push({resolve,reject}))})
 const ctx={mode:'local',storageScope:'scope',source:'ui-read'},e1=new Error('actual failure'),e2=new Error('actual failure')
 faults.capture(e1,ctx);faults.capture(e2,ctx);check(calls.length,1);check(faults.pending().length,1)
 deliveries[0].resolve({faultId:'fact',state:'repairing'});await new Promise(resolve=>setImmediate(resolve));check(faults.pending(),[]);check(safetyPresentation(e1).faultId,'fact');check(safetyPresentation(e2).faultId,'fact')
 faults.capture(e1,ctx);faults.flush();check(calls.length,1)
 // A new error object after delivery is a new actual observation, not a retained old pending record.
 const e3=new Error('actual failure');faults.capture(e3,ctx);check(calls.length,2);deliveries[1].reject(new Error('transport unavailable'));await new Promise(resolve=>setImmediate(resolve));check(faults.pending().length,1)
 faults.flush();check(calls.length,3);deliveries[2].resolve(undefined);await new Promise(resolve=>setImmediate(resolve));check(faults.pending(),[]);check(safetyPresentation(e3),undefined);faults.capture(e3,ctx);faults.flush();check(calls.length,3);faults.dispose()
 const tr=(cn,en)=>en;check(taskCancellationNotice({parentTaskId:'root'},tr).includes('Recorder and Cleaner do not run for this child'),true);check(taskCancellationNotice({},tr).includes('root Recorder'),true)
 const service=readFileSync(new URL('framework/service.ts',root),'utf8'),page=readFileSync(new URL('framework/client-page.tsx',root),'utf8')
 // Current physical, historical, and explicit pending original Task projections retain parent identity.
 check((service.match(/parentTaskId: task.parent.taskId/g)||[]).length,3);check(page.includes('taskCancellationNotice(task, tr)'),true);check(/authenticated browser app|浏览器应用/.test(page),false)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual task observation and fault-delivery methods, exact UI notice helper and projection source; no native DSH UI render, transport or full typecheck claimed.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{hooks.deregister()}
