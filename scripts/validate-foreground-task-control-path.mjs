import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual installed tools, real Zod schemas and physical files. Only unrelated
// Markdown/skill dependencies and external execution seams are controlled. No native DSH,
// Windows, full typecheck or production cutover is asserted by this script.
const sourceRoot=new URL('../src/',import.meta.url),loaded=new Map()
const require=createRequire(import.meta.url),zodPath=require.resolve(process.env.DSS_ZOD_MODULE ?? 'zod'),zod=require(zodPath)
const data=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64')
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='zod')return{url:pathToFileURL(zodPath).href,shortCircuit:true}
 if(specifier==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(text){if(text.includes('['))throw new Error('Markdown links outside this test');return {type:'root',children:[]}}`),shortCircuit:true}
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot.href)&&specifier.endsWith('.js')){
 const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
 if(url.href===new URL('framework/skills.ts',sourceRoot).href)return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`),shortCircuit:true}
 if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
 return next(specifier,context)},load(url,context,next){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {foregroundFullGuide}=await import('../src/framework/role-prompts.ts')
const {upgradeForegroundGuide}=await import('../src/framework/foreground-guide-upgrade.ts')
const {paths,readJson,taskLifecycle}=await import('../src/framework/task-files.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {publishTaskResume}=await import('../src/framework/task-resume.ts')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-control-tool-path-')),files=new PhysicalLocalFiles(root)
const read=p=>withSnapshot(files,s=>files.read(s,p))
const memory=new Map(),store={get:async k=>memory.get(k),set:async(k,v)=>memory.set(k,structuredClone(v)),list:async prefix=>[...memory].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value})),delete:async k=>memory.delete(k)}
const controls=new ExecutionControls(store,'tool-path',()=> '2026-11-09T00:00:00.000Z',files,store,'instance')
const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002']
const tasks=ids.map(taskId=>({version:1,taskId,route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/source_'+taskId+'_P.md'}))
let assertions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,re)=>{await assert.rejects(fn,re);assertions++}
const runtimeSource=readFileSync(new URL('../src/framework/role-runtime.ts',import.meta.url),'utf8')
loaded.set('framework/role-runtime.ts',createHash('sha256').update(runtimeSource).digest('hex'))
const start=runtimeSource.indexOf('      taskControl: {',runtimeSource.indexOf('  private services()')),end=runtimeSource.indexOf('\n      cancelTask:',start)
assert(start>0&&end>start)
const literal=stripTypeScriptTypes('const services={'+runtimeSource.slice(start,end)+'};',{mode:'transform'})
const runtime={files,controls,records:store,config:{primary:true,member:'A',collaborationId:'collab'},roleRecords:new Map(),stopOperations:new Map(),transactions:{run(){throw Error('No generic Local transaction')}},archiveHostKey:()=> 'test-host',scheduleTaskResume:(...args)=>scheduled.push(args),taskControlPublished:(...args)=>publications.push(args)}
const dependencies={PhysicalLocalFiles,GitAuthorityStore,withSnapshot,readTaskCleanupRecord,readJson,paths,taskLifecycle,publishTaskResume}
const taskControl=new Function(...Object.keys(dependencies),literal+'return services.taskControl;').call(runtime,...Object.values(dependencies))
const binding={role:'Foreground',owner:'A',member:'A',workId:'Foreground',executionId:'fg-execution',collaborationId:'collab',recordPath:'state/foreground/Foreground_Memory.md'}
runtime.roleRecords.set(binding.workId,{identity:{role:'Foreground',executionId:binding.executionId},sessionId:'fixture-session',generation:1})
const scheduled=[],effects=[],publications=[]
function install(b,control=taskControl){
 const tools=new Map(),sections=[],agent={id:'agent-'+b.role,session:{}},ctx={on:()=>()=>{},effect:fn=>effects.push(fn),systemPrompt:{section:s=>sections.push(s)},tools:{register:t=>tools.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,b,{files,taskControl:control,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),transact:async()=>{throw Error('No generic transaction')},onError:e=>{throw e}})
 return{tools,sections,call:async(name,input,id=name)=>{const tool=tools.get(name);const validated=tool.parameters?.parse?tool.parameters.parse(input):input;return tool.execute(validated,{agent,callId:id,signal:new AbortController().signal})}}
}
try{
 for(const task of tasks){await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(paths.inbox(task.taskId,'A'),'existing Task')}
 const fg=install(binding),general=await fg.call('dss_snapshot',{})
 check('taskControlPath' in general,false)
 check(fg.sections.find(s=>s.name==='deepseek-servant:framework-binding').text.includes('technical/authority'),false)
 const a=await fg.call('dss_snapshot',{taskId:ids[0]}),b=await fg.call('dss_snapshot',{taskId:ids[1]})
 check(a.taskControlPath,paths.run(ids[0])+'/control.json');check(b.taskControlPath,paths.run(ids[1])+'/control.json')
 const request={snapshotId:a.snapshotId,path:a.taskControlPath,append:false,text:JSON.stringify({taskId:ids[0],intent:'paused'})}
 const result=await fg.call('dss_record',request,'pause-original')
 check(publications.map(([task,intent])=>[task.taskId,intent]),[[ids[0],'paused']])
 check(result.intent,'paused');check(await controls.taskHeld(ids[0]),true);check(await controls.taskHeld(ids[1]),false)
 const saved=JSON.parse(await read(a.taskControlPath));check(saved.taskId,ids[0]);check(Object.values(saved.commands).length,1)
 check(await read(b.taskControlPath),undefined)
 check([...memory.keys()].some(key=>key.includes('/tasks/')||key.includes('/commands/')),false)
 check(await fg.call('dss_record',request,'pause-original'),result)
 await rejects(()=>fg.call('dss_record',{...request,text:JSON.stringify({taskId:ids[0],intent:'running'})},'pause-original'),/different arguments/)
 await rejects(()=>fg.call('dss_record',{...request,text:JSON.stringify({taskId:ids[1],intent:'paused'})},'wrong-task'),/selected snapshot/)
 await rejects(()=>fg.call('dss_record',{...request,text:JSON.stringify({taskId:ids[0],intent:'paused',executions:{}})},'bad-field'),/Unrecognized|unrecognized/)
 await rejects(()=>fg.call('dss_record',{...request,append:true},'append'),/append:false/)
 await rejects(()=>fg.call('dss_record',{...request,path:b.taskControlPath},'wrong-path'),/Foreground|write|record|writable/)
 const worker=install({role:'Worker',owner:'A',member:'A',taskId:ids[0],workerId:'w',workId:'worker',executionId:'worker'})
 const w=await worker.call('dss_snapshot',{})
 check('taskControlPath' in w,false)
 await rejects(()=>worker.call('dss_record',{...request,snapshotId:w.snapshotId},'worker-control'),/Only Foreground/)
 // A real legacy binding still uses exactly the Git static tool address. The
 // callback below tests address routing only; actual Git authority is covered
 // separately and this is not called a Git backend acceptance test.
 const gitPath='technical/authority/shared/framework-user-controls/scope.json',gitCalls=[]
 const gitAddress=install(binding,{path:gitPath,write:async(...args)=>{gitCalls.push(args);return{intent:'paused'}}})
 const gv=await gitAddress.call('dss_snapshot',{taskId:ids[0]})
 check(gv.taskControlPath,gitPath);check(gitAddress.sections.find(s=>s.name==='deepseek-servant:framework-binding').text.includes(gitPath),true)
 await gitAddress.call('dss_record',{...request,snapshotId:gv.snapshotId,path:gitPath},'git-address');check(gitCalls.length,1)
 // Resume uses the same existing UserResume publication and schedule, not a
 // new control acknowledgement or Task. The original Task metadata is retained.
 const beforeResume=await read(paths.task(ids[0]))
 const resumed=await fg.call('dss_record',{...request,text:JSON.stringify({taskId:ids[0],intent:'running'})},'resume-original')
 check(resumed.intent,'running');check(await controls.taskHeld(ids[0]),false)
 check(scheduled.length,1);check(scheduled[0],[ids[0],'agent-Foreground:resume-original',''])
 check(await read(paths.task(ids[0])),beforeResume)
 // A current snapshot of a restored lifecycle exposes the same Task file,
 // while the existing selected-lifecycle rule rejects mismatched input.
 await files.replace(paths.task(ids[1]),JSON.stringify({...tasks[1],lifecycleId:'restored-lifecycle'}))
 const restored=await fg.call('dss_snapshot',{taskId:ids[1]})
 await rejects(()=>fg.call('dss_record',{...request,path:restored.taskControlPath,snapshotId:restored.snapshotId,text:JSON.stringify({taskId:ids[1],intent:'paused'})},'restored-wrong-life'),/current lifecycle/)
 check((await fg.call('dss_record',{...request,path:restored.taskControlPath,snapshotId:restored.snapshotId,text:JSON.stringify({taskId:ids[1],lifecycleId:'restored-lifecycle',intent:'paused'})},'restored-pause')).lifecycleId,'restored-lifecycle')
 const guide=foregroundFullGuide()
 const newPath=guide.split('\n').find(line=>line.startsWith('Use the existing dss_record'))
 check(newPath.includes('taskControlPath returned by dss_snapshot'),true)
 const oldPath='Use the existing dss_record at the exact sourceLocations.taskControlPath supplied by this Foreground binding, with that snapshotId, append:false and text containing only the JSON request {"taskId":"<selected taskId>","lifecycleId":"<current lifecycleId>","intent":"paused"} or intent "running" for resume.'
 const currentFirst=newPath.match(/^[\s\S]*?\.(?= |$)/)[0]
 const oldLocal='Local controls use exact Task/lifecycle, execution and command records in the existing scoped StoragePort; this tool address is a validated request address, not a literal file-write destination.'
 const currentLocal='Local Task controls live in task-runs/<taskId>/control.json and are reclaimed with that Task directory; this tool submits the validated request without replacing the file envelope.'
 const previous=guide.replace(currentFirst,oldPath).replace(currentLocal,oldLocal)
 check(upgradeForegroundGuide(previous).text,guide)
 const customized='\uFEFF'+previous.replace(/\n/g,'\r\n')+'\r\n用户自有文字不动\r\n'
 const upgraded=upgradeForegroundGuide(customized).text
 check(upgraded.startsWith('\uFEFF'),true);check(upgraded.endsWith('\r\n用户自有文字不动\r\n'),true)
 check(upgradeForegroundGuide(guide).changedRules,0)
 check(upgradeForegroundGuide('用户完整自定义指南').text,'用户完整自定义指南')
 check(upgradeForegroundGuide(guide+'\n```\n'+oldPath+'\n```\n').text,guide+'\n```\n'+oldPath+'\n```\n')
 console.log(JSON.stringify({assertions,scope:'Actual registered role tools and real Zod -> actual extracted Runtime taskControl writer -> real per-Task controls/physical files; supplied Context/native RoleRecord. Static Git address routing only, not remote Git or full DSH.',zodVersion:require(path.join(path.dirname(zodPath),'package.json')).version,sourceSha256:Object.fromEntries(loaded)},null,2))
}finally{for(const effect of effects){const dispose=effect();if(typeof dispose==='function')await dispose()}await files.close();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
