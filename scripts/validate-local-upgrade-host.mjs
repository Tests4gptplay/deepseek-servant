import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Real production conversation methods and Linux physical files. Markdown's
// parser, native DSH imports and unrelated role tools are explicit controlled
// ports. These checks do not claim native UI/Windows/typecheck acceptance.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'koffi') return {url:new URL('./helpers/fixture-no-replace-koffi.mjs',import.meta.url).href,shortCircuit:true}
    if (specifier === 'zod') return {url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true}
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){const children=[];for(const m of text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g))children.push({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}});return {type:'root',children}}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/skills.ts',root).href) return {url:data(`export const frameworkSkillIndexPath='technical/skills/catalog.json';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw Error('Skill parsing is outside this Host check')} export function refreshPhysicalFrameworkSkillIndex(){throw Error('Skill parsing is outside this Host check')}`),shortCircuit:true}
      if (existsSync(fileURLToPath(url))) return {url:url.href,shortCircuit:true}
    }
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url.startsWith(root.href)&&url.endsWith('.ts')) {
      const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(root.href.length),createHash('sha256').update(source).digest('hex'))
      return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
    }
    return next(url,context)
  },
})
const { restoreLegacyTask, legacyTaskNeedsRestoration } = await import('../src/framework/local-upgrade-task.ts')
const { legacyConversationNeedsRestoration } = await import('../src/framework/local-upgrade-conversation.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { taskArchiveHostKey } = await import('../src/framework/task-archive.ts')
const { taskInitializationFiles } = await import('../src/framework/task-files.ts')
const scratch=process.argv[2]==='--restore'?process.argv[3]:await fs.mkdtemp(path.join(os.tmpdir(),'dss-upgrade-host-'))
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',instance='20000000-0000-4000-8000-000000000001',scope='exact-original-scope',hostKey=taskArchiveHostKey(undefined,scope,instance)
const task={version:1,taskId:id,route:'P',owner:'owner',members:['owner'],status:'running',sourcePath:'tasks/original_P.md',archiveFolder:id}
const names=[],check=(n,a,b)=>{assert.deepEqual(a,b);names.push(n)},hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,null,2)+'\n'
class DiskRecords{
 constructor(directory){this.files=new LocalRecordFiles(path.join(directory,'host-records'))}
 async get(k){const bytes=await this.files.read(hash(k)+'.json');return bytes===undefined?undefined:JSON.parse(bytes)}
 async set(k,v){await this.files.replace(hash(k)+'.json',json(v))}
 async delete(k){await this.files.delete(hash(k)+'.json')}
 async list(){throw Error('No global Host-record scan')}
}
const sourcePathFor=root=>path.join(root,'files'),note='task-runs/'+id+'/owner/Planner_Memory.md'
async function seed(root,released=false){
 const directory=sourcePathFor(root);await fs.mkdir(directory,{recursive:true});const db=new DatabaseSync(path.join(directory,'dss-files.sqlite'))
 db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT')
 const put=(p,v)=>{const bytes=Buffer.from(typeof v==='string'?v:json(v));db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)').run(p,'','fixture',bytes.length,bytes)}
 const value={...task,...(released?{status:'complete'}:{})}
 put('tasks/'+id+'.json',value);put(task.sourcePath,'Task ID: '+id+'\n# Preserve original requirement\n')
 for(const file of taskInitializationFiles(value))put(file.path,file.content??'')
 put(note,'original authored notes');put('state/owner/'+id+'/Planner_Inbox','')
 if(released)put('archives/'+id+'/state.json',{version:1,taskId:id,lifecycles:{'':{hosts:{[hostKey]:{released:true}},cleanup:{phase:'released'}}}})
 db.close();return value
}
if(process.argv[2]==='--restore'){
 const phase=process.argv[4],directory=sourcePathFor(scratch)
 await restoreLegacyTask(directory,id,hostKey,new DiskRecords(scratch),{onProgress:p=>{
  if(phase==='metadata'&&p.path==='tasks/'+id+'.json'&&p.step==='published'||phase==='source'&&p.path===task.sourcePath&&p.step==='published'||phase==='history-source'&&p.path===task.sourcePath&&p.step==='published'||phase==='signal'&&p.path==='state/owner/'+id+'/Planner_Inbox'&&p.step==='ready')process.exit(79)
 }})
 throw Error('Requested exit boundary was not reached')
}
const serviceSource=readFileSync(new URL('framework/service.ts',root),'utf8'),serviceJs=stripTypeScriptTypes(serviceSource,{mode:'transform'})
loaded.set('framework/service.ts',hash(serviceSource))
const method=name=>{const m=new RegExp('\n    (?:async )?'+name+'\\(').exec(serviceJs);assert.ok(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(serviceJs.slice(start+m[0].length));assert.ok(next,name);return serviceJs.slice(start,start+m[0].length+next.index)}
let agentConfigurations=[],agentStarts=0
class ControlledAgent{constructor(_ctx,_storage,config){this.config=config;agentConfigurations.push(config)}async start(){agentStarts++;return {status:'not-needed'}}}
const dependencies={PhysicalLocalFiles,legacyTaskNeedsRestoration,legacyConversationNeedsRestoration,LocalStartupUpgradeAgent:ControlledAgent,taskArchiveHostKey}
const Service=new Function(...Object.keys(dependencies),'return class {\n'+['startLocalUpgrade','beforeLocalTaskDiscovery','beforeLocalTaskUse','prepareConversationWrite'].map(method).join('\n')+'\n}')(...Object.values(dependencies))
const newService=records=>Object.assign(new Service(),{storage:records,ctx:{},localUpgrades:new Map(),accesses:new Map(),running:new Map(),opening:new Map(),changes:0,errors:[],changed(){this.changes++},report(_mode,error){this.errors.push(error)}})
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await sleep(10)}throw Error('Controlled condition did not settle')}
async function harness(root,service){
 const files=new PhysicalLocalFiles(sourcePathFor(root)),records=service.storage,events=[],discovered=[],errors=[],workspaces=[]
 const connection={files,scope,identity:{instanceUUID:instance}}
 const loop=new FrameworkHostLoop(files,{run(){throw Error('No SQL/Git transaction')}},records,{scope,member:'owner',primary:true,instanceUUID:instance},()=>['owner'],{
  startup:async()=>{},observe:async()=>{},executing:()=>false,error:e=>errors.push(e),clean:async()=>false,releaseTask:async()=>{},sealBusiness:async()=>{},
  discoverTask:async(t,s)=>{if(!await service.beforeLocalTaskDiscovery(connection,t))return false;discovered.push({id:t.taskId,source:await files.read(s,t.sourcePath)});},
  initializeWorkspace:async t=>{workspaces.push(t.taskId)},
  wake:async wake=>{events.push(wake);for(const entry of wake.sources)await files.deleteObserved(entry.path,entry.version);return true},
 })
 return {files,connection,loop,events,discovered,errors,workspaces,async close(){await loop.stop();await files.close()}}
}
try{
 const startupRoot=path.join(scratch,'owner'),records=new DiskRecords(startupRoot),service=newService(records),physical=new PhysicalLocalFiles(sourcePathFor(startupRoot))
 service.startLocalUpgrade({files:{},scope,identity:{instanceUUID:instance}},'/actual/workspace',{collaborationId:'actual-chat'})
 check('Current SQL/Git adapters do not trigger physical upgrade',agentStarts,0)
 const connection={files:physical,scope,identity:{instanceUUID:instance}},settings={collaborationId:'actual-chat',presetId:'existing',background:{provider:'existing',model:'existing'}}
 service.startLocalUpgrade(connection,'/actual/workspace',settings);service.startLocalUpgrade(connection,'/actual/workspace',settings)
 check('Actual physical startup owns one native execution',agentStarts,1)
 check('Existing model/preset/workspace/Host identity are passed through',[agentConfigurations[0].model,agentConfigurations[0].presetId,agentConfigurations[0].cwd,agentConfigurations[0].hostKey],[settings.background,'existing','/actual/workspace',hostKey])
 const one=Promise.resolve({status:'complete',taskId:id,issues:[]});agentConfigurations[0].onTaskRestoration(id,one)
 check('Actual Task tool operation is retained without another queue',service.localUpgrades.get(physical.directory).tasks.get(id),one)
 let localResumed=0
 service.accesses.set('git',new Promise(()=>{}))
 const localAccess={connection,legacyConversation:{original:true},conversation:{scope:{collaborationId:'actual-chat'},async resumePhysicalPublication(){localResumed++}}}
 service.accesses.set('local',Promise.resolve(localAccess))
 agentConfigurations[0].onConversationRestoration('actual-chat',Promise.resolve({status:'complete',collaborationId:'actual-chat',issues:[]}))
 await until(()=>localResumed===1&&localAccess.legacyConversation===undefined)
 check('Local conversation restoration never waits for unrelated Git access',localResumed,1)
 agentConfigurations[0].onConversationRestoration('different-scope',Promise.resolve({status:'complete',collaborationId:'different-scope',issues:[]}));await sleep(20)
 check('Different scope never replaces current Local history',localResumed,1)

 await physical.close()
 check('Host startup hook is called after a real connection and before runtime creation',serviceSource.indexOf('this.startLocalUpgrade(connection, workspace.directory, settings);')<serviceSource.indexOf('runtime = new FrameworkRoleRuntime'),true)
 check('Ordinary access cannot start migration',/private access[\s\S]*?private async withAccessOperation/.exec(serviceSource)[0].includes('startLocalUpgrade('),false)
 for(const phase of ['metadata','source','signal','history-source']){
  const directory=path.join(scratch,phase);await seed(directory,phase==='history-source')
  const exited=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--restore',directory,phase],{encoding:'utf8'})
  check('Real process exit after '+phase,exited.status,79)
  const records=new DiskRecords(directory),service=newService(records),h=await harness(directory,service)
  await h.loop.start();await h.loop.firstPoll
  if(phase==='metadata'||phase==='source')check('Cold partial '+phase+' cannot discover/initialize old Task',h.discovered.some(t=>t.id===id),false)
  if(phase==='history-source'){
   check('Released history source does not become a Task',existsSync(path.join(sourcePathFor(directory),'tasks/'+id+'.json')),false)
   check('Released history source creates no native initial reservation',Object.values(h.loop.record.initial).length,0)
  }
  if(phase==='signal')await fs.writeFile(path.join(sourcePathFor(directory),note),'user edit after own material restoration')
  const work=restoreLegacyTask(sourcePathFor(directory),id,hostKey,records)
  service.localUpgrades.set(h.files.directory,{controller:new AbortController(),tasks:new Map([[id,work]]),conversations:new Map(),independentTasks:new Set()})
  check('Real interrupted '+phase+' restoration completes',(await work).status,'complete')
  await h.loop.poll()
  if(phase!=='history-source')check('Restored '+phase+' task becomes discoverable with original source',h.discovered.some(t=>t.id===id&&t.source==='Task ID: '+id+'\n# Preserve original requirement\n'),true)
  if(phase==='signal')check('Continuation never rewrites already restored user edit',await fs.readFile(path.join(sourcePathFor(directory),note),'utf8'),'user edit after own material restoration')
  check('Interrupted '+phase+' reports no Host errors',h.errors.map(e=>e.message),[])
  await h.close()
 }
 const parallel=path.join(scratch,'parallel');await seed(parallel);const pr=new DiskRecords(parallel),ps=newService(pr),h=await harness(parallel,ps)
 const independent={...task,taskId:other,sourcePath:'tasks/independent_P.md',archiveFolder:other}
 await h.files.createIfAbsent(independent.sourcePath,'Task ID: '+other+'\n# Independent\n')
 for(const change of taskInitializationFiles(independent))await h.files.createIfAbsent(change.path,change.content??'')
 await h.files.createIfAbsent('tasks/'+other+'.json',json(independent));await h.files.createIfAbsent('state/owner/'+other+'/Planner_Inbox','')
 let release,paused=false;const pause=new Promise(r=>release=r)
 const work=restoreLegacyTask(h.files.directory,id,hostKey,pr,{onProgress:async p=>{if(p.path==='tasks/'+id+'.json'&&p.step==='published'){paused=true;await pause}}})
 ps.localUpgrades.set(h.files.directory,{controller:new AbortController(),tasks:new Map([[id,work]]),conversations:new Map(),independentTasks:new Set()})
 await until(()=>paused);await h.loop.start();await until(()=>h.events.some(e=>e.taskId===other))
 check('Unrelated Task runs while old metadata waits for its actual restore',h.discovered.some(t=>t.id===other),true)
 check('Held old Task has not been admitted',h.discovered.some(t=>t.id===id),false)
 release();await work;await h.loop.firstPoll;await h.loop.poll()
 check('Only original Task advances after its own source is present',h.events.some(e=>e.taskId===id),true)
 check('Original source generates no duplicate initialization',Object.values(h.loop.record.initial).some(t=>t.taskId===id),false)
 check('Parallel Host reports no source-missing failure',h.errors.map(e=>e.message),[])
 await h.close()
 console.log(JSON.stringify({status:'passed',assertions:names.length,names,platform:process.platform,runtime:process.version,limits:'Real Host methods/files and four OS subprocess exits; extracted actual service methods use a controlled native Agent constructor. No actual DSH activation/model, Windows/Koffi addon, power-loss or full dependency-backed typecheck.',sourceHashes:Object.fromEntries([...loaded].sort()),scriptHash:hash(readFileSync(fileURLToPath(import.meta.url)))},null,2))
}finally{hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
