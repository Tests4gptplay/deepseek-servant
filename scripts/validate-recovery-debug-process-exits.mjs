import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

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
// v56 imports the real storage adapter class. Resolve its SDK domain from the
// supplied actual Host installation; these tests still use controlled KV ports.
const sdkRequire = process.env.DSS_SDK_HOST_ROOT ? createRequire(path.join(process.env.DSS_SDK_HOST_ROOT, 'package.json')) : undefined
const storageSdkUrls = sdkRequire ? Object.fromEntries(['@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-storage-json'].map(name => [name, pathToFileURL(sdkRequire.resolve(name)).href])) : {}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (storageSdkUrls[specifier]) return { url: storageSdkUrls[specifier], shortCircuit: true }
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
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { publishPhysicalRecovery } = await import('../src/framework/physical-recovery.ts')

const {withSnapshot}=await import('../src/framework/transactions.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {FrameworkManualCleanup}=await import('../src/framework/manual-cleanup.ts')
const {frameworkStorageUsage}=await import('../src/framework/maintenance.ts')
const {publishPhysicalHelperReport}=await import('../src/framework/physical-helper-report.ts')
const {hostRecoveryDebugPath,hostRecoverySignalPath}=await import('../src/framework/recovery-debug-record.ts')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-isolated-recovery-'))
const task={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/a.md'}
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++};const rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const deps={hash:t=>createHash('sha256').update(t).digest('hex')}
const events=[],results=[];const event=(name,detail={})=>events.push({sequence:events.length,ms:performance.now(),name,...detail})
function latch(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Timed out: '+label)),5000))])}finally{clearTimeout(timer)}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const readAt=(f,p)=>withSnapshot(f,s=>f.read(s,p))
const taskAt=n=>({...task,taskId:'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),sourcePath:'tasks/'+n+'_P.md'})
const markerAt=t=>paths.state('A',t.taskId)+'/recovery'
const signalAt=(t,date='2026-11-09',suffix='probe')=>paths.state('A',t.taskId)+'/Planner_Recovery_'+date+'_'+suffix
async function seed(f,t){await f.replace(paths.task(t.taskId),JSON.stringify(t));await f.replace(t.sourcePath,'Original task '+t.taskId);await f.replace(paths.inbox(t.taskId,'A'),'Original Inbox\n')}
function makeRuntime(f){
 const v=new Map(),rs={async get(k){return structuredClone(v.get(k))},async set(k,x){v.set(k,structuredClone(x))},async list(prefix){return [...v].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)}))}}
 const r=Object.create(FrameworkRoleRuntime.prototype);Object.assign(r,{files:f,records:rs,prefix:'debug-audit/',config:{member:'A',primary:true},closed:false,transactions:{run(){throw Error('Unexpected generic transaction')}},taskRuntimeReleased:async()=>false,manuallyCleared:async()=>false,currentTask:async record=>record.identity.taskId,pending:[],roleRecords:new Map(),wakeConsumptions:new Map(),safetyRestoreWrites:new Map(),native:new Map(),controls:{execution:async()=>false,taskHeld:async()=>false},beforeTaskUse:async()=>true,observations:{mayApply:async()=>true,deferUnperformed:async()=>{throw Error('Unexpected deferral')}},observationTaskHeld:async()=>false,
  // Already-stopped producer boundary. This probe does not fake a native stop.
  trackedStop:record=>record.stopped===true,continuations:[],errors:[],arrangeNativeContinuation:async(record,context,_inspection,id)=>{r.continuations.push({taskId:record.identity.taskId,id,context});event('native-continuation-port',{taskId:record.identity.taskId});return true},error:(error,context)=>{r.errors.push({message:String(error),context})}})
 r.updateObservationRecord=async(pending,extra={})=>{const key=r.prefix+'observations/'+deps.hash(pending.id),current=await rs.get(key);const value={...current,pending,...extra};await rs.set(key,value);return value}
 return r
}
async function workerObservation(r,t,id){
 const identity={role:'Worker',workId:'work-'+id,executionId:'exec-'+id,workerId:'worker-'+id,taskId:t.taskId,member:'A',owner:'A'}
 r.roleRecords.set(identity.workId,{identity,stopped:true,sessionId:'stopped-session-'+id})
 const pending={id,checkedAt:Date.parse('2026-11-09T10:00:00Z'),cycleStartedAt:1,action:{stage:3,identity,elapsedMs:40*60_000,silentMs:40*60_000}}
 await r.records.set(r.prefix+'observations/'+deps.hash(id),{pending,stopStarted:true})
 return pending
}
function holdPrepared(f,name,match){
 const entered=latch(),release=latch(),original=f[name].bind(f);let hit=false
 f[name]=async(...args)=>{if(!hit&&match(args)){hit=true;const index=name==='appendPrepared'?4:5,save=args[index];args[index]=async prepared=>{await save(prepared);event('prepared-file-held',{path:args[0],stage:args[1]});entered.resolve();await release.promise}}return original(...args)}
 return {entered,release,restore(){f[name]=original}}
}
async function scan(f,t){
 const state=new Map(),errors=[],wakes=[],storage={get:async k=>state.get(k),set:async(k,v)=>state.set(k,structuredClone(v))}
 const scope='debug-audit-host',loop=new FrameworkHostLoop(f,new FrameworkTransactions(f,storage,scope),storage,{member:'A',primary:true,scope,instanceUUID:taskAt(999).taskId},()=>['A'],{
 startup:async()=>{},observe:async()=>{},physicalSignalSources:async()=>[],wake:async q=>{wakes.push(q);event('host-wake-port',{taskId:q.taskId,role:q.role,sources:q.sources});return false},executing:()=>false,sealBusiness:async()=>{},clean:async()=>false,releaseTask:async()=>{},initializeWorkspace:async()=>{},taskStateObserved:async()=>{},error:e=>errors.push(e)})
 const s=await f.snapshot();try{await bounded(loop.scanTask(t,s,performance.now()),'actual Host scan')}finally{await s.release();await loop.stop()}
 check(errors.length,0);return wakes
}
// Execute the actual service methods used by the panel's api.readFile.
const serviceSource=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8')
loaded.set('framework/service.ts',deps.hash(serviceSource))
function serviceMethod(name){const start=serviceSource.indexOf('    '+name);assert(start>=0);const after=serviceSource.slice(start+name.length+4).search(/\n    (?:private |async |[A-Za-z]+\()/);assert(after>=0);return serviceSource.slice(start,start+name.length+4+after)}
const {parseTaskReference,referenceTaskId}=await import('../src/framework/published-references.ts')
const {isConversationAttachmentPath}=await import('../src/framework/conversation-attachment-reference.ts')
const ReadService=new Function('withSnapshot','parseTaskReference','referenceTaskId','isConversationAttachmentPath','PhysicalLocalFiles','createHash',stripTypeScriptTypes('class ReadService {\n'+['private async readFileBytes(','async readFile('].map(serviceMethod).join('\n')+'\n}',{mode:'transform'})+'\nreturn ReadService')(withSnapshot,parseTaskReference,referenceTaskId,isConversationAttachmentPath,PhysicalLocalFiles,createHash)
function uiService(files){const service=new ReadService();Object.assign(service,{access:async()=>({connection:{files,scope:'audit'}}),checkScope:(_a,scope)=>assert.equal(scope,'audit'),foreground:(_a,operation)=>operation()});return service}
async function plannerRead(r,t,signal,recordPath){
 const binding={role:'Planner',taskId:t.taskId,owner:'A',member:'A',workId:r.roleKey('Planner',t.taskId),executionId:'read-'+t.taskId}
 const info=await r.files.fileInfo(signal);assert(info);const sources=[{path:signal,version:info.version}]
 const role={identity:binding,sessionId:'controlled-receiver',lastWake:{id:'read-wake-'+t.taskId,role:'Planner',taskId:t.taskId,sources}}
 r.roleRecords.set(binding.workId,role);await r.records.set(r.prefix+'roles/'+deps.hash(binding.workId),role)
 const installed=new Map(),agent={id:'planner-reader',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>installed.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,binding,{files:r.files,transact:async()=>{throw Error('Unexpected generic transaction')},notifications:(snapshot,b)=>r.notifications(snapshot,b),claimNotifications:b=>r.consumeWakeSignals(b),onError:()=>{}})
 const call=(name,input)=>installed.get(name).execute(input,{agent,callId:'read-'+name,signal:new AbortController().signal,concludeTurn(){}})
 const view=await call('dss_snapshot',{});await call('dss_claim',{snapshotId:view.snapshotId})
 const record=await call('dss_read',{snapshotId:view.snapshotId,path:recordPath})
 check(record.exists,true);check(record.path,recordPath);check(await readAt(r.files,signal),undefined)
 return record.text
}
const producer=fileURLToPath(new URL('./test-support/recovery-debug-producer.mjs',import.meta.url)),processes=[];let sourceHashAssertions=0
try{
 for(const family of['member','restore-debug','host'])for(const phase of['accepted','prepared','log-renamed',...(family==='restore-debug'?[]:['marker-renamed','signal-renamed'])]){
  const directory=path.join(root,family+'-'+phase);await fs.mkdir(directory,{recursive:true})
  const p=spawnSync(process.execPath,[producer,directory,family,phase],{encoding:'utf8',env:{...process.env,DSS_RECOVERY_DEBUG_SOURCE:fileURLToPath(sourceRoot)}})
  assert.equal(p.status,78,p.stderr);assertions++
  const input=JSON.parse(await fs.readFile(path.join(directory,'input.json'),'utf8')),evidence=JSON.parse(await fs.readFile(path.join(directory,'producer-evidence.json'),'utf8'))
  for(const[name,sha]of Object.entries(evidence.sourceHashes)){if(loaded.has(name)){check(loaded.get(name),sha);sourceHashAssertions++}}
  const f=new PhysicalLocalFiles(path.join(directory,'files')),r=makeRuntime(f),{t,command,day,signal,row}=input
  const fact=JSON.parse(await readAt(f,evidence.expectedFact));check(typeof fact.targets.debugPath,'string')
  const log=fact.targets.debugPath,notice=family==='host'?paths.state('A',t.taskId)+'/Planner_Helper':fact.targets.signalPath
  if(phase==='signal-renamed')await plannerRead(r,t,notice,log)
  if(phase==='prepared')await f.replace(log,'User content before original publication\n')
  const action=()=>family==='member'?r.publishPhysicalMemberRecovery(command,{taskId:t.taskId,member:'A'},{path:day,text:'Original member diagnostic\n'},signal):family==='restore-debug'?r.recordRestoreDebug(row):r.publishPhysicalHostRestoration(row)
  await bounded(action(),'cold continuation after actual exit');await action()
  const body=await readAt(f,log);check(body.split(family==='member'?'Original member diagnostic':'original '+family+' facts').length-1,1)
  if(phase==='prepared')check(body.startsWith('User content before original publication\n'),true)
  check(await readAt(f,day),'Original old log\r\n旧原文\r\n')
  if(family!=='restore-debug')check(await readAt(f,notice),phase==='signal-renamed'?undefined:'')
  processes.push({family,phase,exit:p.status,newFactTarget:log,sourceHashesMatched:true});await f.close()
 }
 console.log(JSON.stringify({status:'passed',assertions,sourceHashAssertions,behaviorAssertions:assertions-sourceHashAssertions,processInterruptions:processes.length,processes,sourceHashes:Object.fromEntries(loaded),limits:'Actual candidate writer exits immediately at real publication boundaries. Cold runtime resumes same physical files; receiver tools are actual, native admission/technical role persistence controlled. No OS power-loss or Windows claim.'},null,2))
}finally{await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
