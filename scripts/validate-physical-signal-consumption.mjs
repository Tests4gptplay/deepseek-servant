import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual runtime signal-consumption methods and physical filesystem. Native DSH
// execution and unrelated parser/skill imports are explicit stubs; this does not
// claim native integration, Windows, full typecheck or production cutover.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const unexpected = `const no = () => { throw new Error('Native DSH is outside this controlled check') };`
const native = {
  '@deepseek-ai/dsh-session': `${unexpected} export const SessionId=x=>x, SessionLogOffset=x=>x, deriveEventMessage=no, isAppendSurfaceEvent=no;`,
  '@deepseek-ai/dsh-session-persistence': `export class SessionAlreadyOwnedError extends Error{}; export class SessionPersistenceNotFoundError extends Error{};`,
  '@deepseek-ai/dsh-agent': `${unexpected} export const installModelSelection=no;`,
  '@deepseek-ai/dsh-llm': `${unexpected} export const MessageId=x=>x, freezeMessage=no, errorChain=no;`,
  '@deepseek-ai/dsh-llm/assistant-stream': `${unexpected} export const expandAssistantStream=no;`,
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (native[specifier]) return { url: data(native[specifier]), shortCircuit: true }
    if (specifier === 'zod') return { url: data(`const schema=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return schema},apply(){return schema}});export const z=schema;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`${unexpected} export const fromMarkdown=no;`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/skills.ts',sourceRoot).href) return { url:data(`${unexpected} export function isFrameworkSkillDefinitionPath(){throw new Error("Skill definition classification is outside this focused test")} export const frameworkSkillIndexPath='skills/index.md', prepareFrameworkSkillIndex=no, installFrameworkSkillProvider=no, initializeFrameworkSkillIndex=no, readFrameworkSkillCatalog=no;`),shortCircuit:true }
      if (existsSync(fileURLToPath(url))) return { url:url.href,shortCircuit:true }
    }
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')) {
      const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'))
      return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
    }
    return next(url,context)
  },
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { paths } = await import('../src/framework/task-files.ts')
let assertions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,match)=>{await assert.rejects(fn,match);assertions++}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-physical-signals-'))
const files=new PhysicalLocalFiles(root)
const read=async name=>{const s=await files.snapshot();try{return await files.read(s,name)}finally{await s.release()}}
const observe=async names=>{const s=await files.snapshot();try{return await Promise.all(names.map(async name=>{
 const rows=await files.listDirectory(s,name.slice(0,name.lastIndexOf('/')+1),{paths:[name]});return rows.find(x=>x.path===name)
}))}finally{await s.release()}}
const task={taskId:'task-a',owner:'host',members:['host'],route:'P',status:'running',sourcePath:'tasks/a.md',createdAt:'2026-11-08T00:00:00.000Z'}
await files.replace(paths.task(task.taskId),JSON.stringify(task))
const runtime=Object.create(FrameworkRoleRuntime.prototype)
Object.assign(runtime,{files,closed:false,config:{member:'host',primary:true},prefix:'focused/',native:{get(){}},roleRecords:new Map(),wakeConsumptions:new Map(),records:{},
 transactions:{run(){throw new Error('Signal consumption must not use a SQL transaction or command receipt')}},
 conversation:{claimForegroundSignals(){throw new Error('Physical Foreground must consume its exact observed sources')}},
 forgotten:[],forgetForegroundNotices(_binding,signals){this.forgotten.push(...signals)},wakeUpdates:[],updateWake:async function(key,fn){this.wakeUpdates.push([key,fn({id:'helper-wake'})])}})
const binding=(role='Planner',executionId='exec-'+role)=>({workId:'work-'+executionId,executionId,role,owner:'host',...(role==='Foreground'||role==='Helper'?{}:{taskId:task.taskId,member:'host'})})
const accept=(b,sources,wakeId='wake-'+b.executionId)=>{const wake={id:wakeId,sources};runtime.roleRecords.set(b.workId,{identity:b,lastWake:wake});return wake}
try {
 const b=binding(), names=['state/host/task-a/Planner_one','state/host/task-a/Planner_two']
 for(const n of names)await files.replace(n,'')
 const sources=await observe(names);accept(b,sources)
 check(await runtime.consumeWakeSignals(b),{signals:names});for(const n of names)check(await read(n),undefined)
 // A replay of the same accepted wake never consumes a later identical empty signal.
 await files.replace(names[0],'');check(await runtime.consumeWakeSignals(b),{signals:names});check(await read(names[0]),'')
 // A fresh runtime/lost in-memory completion still uses durable source observations.
 runtime.wakeConsumptions.clear();check(await runtime.consumeWakeSignals(b),{signals:names});check(await read(names[0]),'')
 const fg=binding('Foreground');const fgNames=['state/Foreground_a','state/Foreground_b']
 for(const n of fgNames)await files.replace(n,'')
 const fgSources=await observe(fgNames);accept(fg,fgSources);await files.replace(fgNames[1],'new publication')
 check(await runtime.consumeWakeSignals(fg),{signals:fgNames});check(await read(fgNames[0]),undefined);check(await read(fgNames[1]),'new publication');check(runtime.forgotten,fgNames)
 // Partial failure leaves the original wake as continuation; a republished first signal survives retry.
 const retry=binding('Planner','retry');for(const n of names)await files.replace(n,'')
 accept(retry,await observe(names));const original=files.deleteObserved.bind(files);let fail=true
 files.deleteObserved=async(p,v,guard)=>{if(p===names[1]&&fail){fail=false;throw new Error('controlled second unlink failure')}return original(p,v,guard)}
 await rejects(()=>runtime.consumeWakeSignals(retry),/controlled second unlink failure/)
 check(await read(names[0]),undefined);check(await read(names[1]),'');await files.replace(names[0],'after failure')
 check(await runtime.consumeWakeSignals(retry),{signals:names});check(await read(names[0]),'after failure');check(await read(names[1]),undefined)
 files.deleteObserved=original
 const claimPath='state/host/task-a/Planner_later';await files.replace(claimPath,'')
 const claim={commandId:'original-claim',taskId:'task-a',sources:await observe([claimPath])};let owners=0,live=0
 await runtime.settleNotificationClaim(claim,async()=>{owners++},()=>{live++},b)
 check(await read(claimPath),undefined);check(owners,1);check(live,2)
 await files.replace(claimPath,'');await runtime.settleNotificationClaim(claim,async()=>{},()=>{},b);check(await read(claimPath),'')
 await rejects(async()=>runtime.settleNotificationClaim({...claim,sources:await observe([claimPath])},async()=>{throw new Error('ended owner')},()=>{},b),/ended owner/)
 check(await read(claimPath),'')
 const helper=binding('Helper');const helperPath='state/Helper_fault';await files.replace(helperPath,'');accept(helper,await observe([helperPath]))
 check(await runtime.consumeWakeSignals(helper),{signals:[helperPath]});check(runtime.wakeUpdates.length,1);check(runtime.wakeUpdates[0][1].signalsConsumed,true)
 const empty=binding('Planner','direct-no-signal');accept(empty,[]);check(await runtime.consumeWakeSignals(empty),{signals:[]})
 const stopped=binding('Planner','stopped');await files.replace(claimPath,'');accept(stopped,await observe([claimPath]));runtime.roleRecords.get(stopped.workId).stopped=true
 await rejects(()=>runtime.consumeWakeSignals(stopped),/ended or replaced/);check(await read(claimPath),'')
 // A held deletion for one Task does not hold another Task's consumption.
 const otherTask={...task,taskId:'task-b',sourcePath:'tasks/b.md'};await files.replace(paths.task(otherTask.taskId),JSON.stringify(otherTask))
 const one=binding('Planner','held'),two={...binding('Planner','independent'),taskId:'task-b'}
 const heldPath='state/host/task-a/Planner_held', freePath='state/host/task-b/Planner_free'
 await files.replace(heldPath,'');await files.replace(freePath,'');accept(one,await observe([heldPath]));accept(two,await observe([freePath]))
 let release,entered;const held=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r})
 files.deleteObserved=async(p,v,guard)=>{if(p===heldPath){entered();await held}return original(p,v,guard)}
 const pending=runtime.consumeWakeSignals(one);await started
 await runtime.consumeWakeSignals(two);check(await read(freePath),undefined);check(await read(heldPath),'')
 release();await pending;check(await read(heldPath),undefined);files.deleteObserved=original
 // An ended execution during a queued mutation cannot consume its signal.
 const ended=binding('Planner','during-queue');await files.replace(claimPath,'');accept(ended,await observe([claimPath]))
 files.deleteObserved=async(p,v,guard)=>{runtime.roleRecords.get(ended.workId).stopped=true;return original(p,v,guard)}
 await rejects(()=>runtime.consumeWakeSignals(ended),/ended or replaced/);check(await read(claimPath),'');files.deleteObserved=original
 console.log(JSON.stringify({status:'passed',assertions,limits:'Linux actual filesystem and real runtime methods; explicit native/schema stubs; no DSH/Windows/full typecheck/production cutover',sourceHashes:Object.fromEntries(loaded)},null,2))
} finally {await files.close();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
