import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual dss_snapshot/dss_claim installation and physical files. Schema parsing
// and unrelated Markdown/skill dependencies are explicit stubs. No native DSH,
// Windows, full typecheck or production cutover is asserted by this script.
const sourceRoot=new URL('../src/',import.meta.url),loaded=new Map()
const data=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64')
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='zod')return{url:data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`),shortCircuit:true}
 if(specifier==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(){throw new Error('Markdown outside this test')}`),shortCircuit:true}
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot.href)&&specifier.endsWith('.js')){
 const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
 if(url.href===new URL('framework/skills.ts',sourceRoot).href)return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`),shortCircuit:true}
 if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
 return next(specifier,context)},load(url,context,next){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const { PhysicalLocalFiles }=await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools }=await import('../src/framework/role-tools.ts')
const { paths }=await import('../src/framework/task-files.ts')
const { TaskWorkspaces }=await import('../src/framework/task-workspace.ts')

const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
const { taskHistoryChange } = await import('../src/framework/task-history.ts')
const { isPhysicalWorkspaceReference } = await import('../src/framework/workspace-paths.ts')
const source = readFileSync(new URL('framework/service.ts', sourceRoot), 'utf8')
loaded.set('framework/service.ts', createHash('sha256').update(source).digest('hex'))
const start=source.indexOf('    async openWorkspaceFile('),end=source.indexOf('    async readFile(',start)
assert(start >= 0 && end > start, 'The real service native-open method must be present')
const Open = new Function('isPhysicalWorkspaceReference', 'return '+stripTypeScriptTypes('class S {\n'+source.slice(start,end)+'\n}',{mode:'transform'}))(isPhysicalWorkspaceReference)
const runtimeSource = readFileSync(new URL('framework/role-runtime.ts', sourceRoot), 'utf8')
loaded.set('framework/role-runtime.ts', createHash('sha256').update(runtimeSource).digest('hex'))
const locateSource = runtimeSource.match(/locate: (\(taskId, snapshot\) => this\.workspaces\.locate\(taskId, snapshot(?:, true)?\)),/)
assert(locateSource, 'The real runtime workspace view adapter must be present')
const locateAdapter = new Function('return (' + locateSource[1] + ')')
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-history-workspace-')),results=[]
const uuid='20000000-0000-4000-8000-000000000001',peer='20000000-0000-4000-8000-000000000002',id='10000000-0000-4000-8000-000000000001',parentId='10000000-0000-4000-8000-000000000002'
let assertions=0;const check=(name,value,expected)=>{assert.deepEqual(value,expected,name);assertions++}
const cases=[
 {name:'running-own',status:'running',own:true,where:'old'},
 {name:'running-new-assignment',status:'running',where:'new'},
 {name:'complete-own',status:'complete',own:true,where:'old'},
 {name:'cancelled-own',status:'cancelled',own:true,where:'old'},
 {name:'complete-known-role',status:'complete',remember:true,where:'old'},
 {name:'complete-no-root',status:'complete'},
 {name:'cancelled-no-root',status:'cancelled'},
 {name:'complete-other-host-only',status:'complete',peer:true},
 {name:'history-only',status:'complete',history:true},
 {name:'history-known-role',status:'complete',history:true,remember:true,where:'old'},
 {name:'complete-child-running-parent',status:'complete',child:true},
]
try {
 for(const mode of ['local','git'])for(const scenario of cases){
  const directory=path.join(temp,mode,scenario.name),repository=new Repository(),files=mode==='local'?await PhysicalLocalFiles.open(path.join(directory,'data')):new GitFiles(repository)
  try {
   const oldRoot=path.join(directory,'old'),newRoot=path.join(directory,'new'),folder='Example_'+(scenario.child?parentId:id),actual=path.join(oldRoot,folder)
   await fs.mkdir(actual,{recursive:true});const physical={owner:'A',instanceUUID:uuid,path:path.join(actual,'result.txt')};await fs.writeFile(physical.path,'Preserved original result')
   const workspace=new TaskWorkspaces(files,newRoot,'A',uuid)
   const task={version:1,taskId:id,route:'P',owner:'A',members:['A'],status:scenario.status,sourcePath:'tasks/Example_P.md',workspaceFolder:folder,workspaceResults:[physical],...(scenario.own?{hostWorkspaces:{[uuid]:oldRoot}}:scenario.peer?{hostWorkspaces:{[peer]:oldRoot}}:{})}
   const write=async(p,text)=>{if(mode==='local')await files.replace(p,text);else{put(repository,p,text);head(repository)}}
   if(scenario.child){delete task.workspaceFolder;task.parent={taskId:parentId,owner:'A',objectiveId:'objective'};await write(paths.task(parentId),JSON.stringify({version:1,taskId:parentId,route:'O',owner:'A',members:['A'],status:'running',sourcePath:'tasks/Example_O.md',workspaceFolder:folder,children:[{taskId:id,member:'A',objectiveId:'objective'}]}))}
   if(scenario.history){const change=taskHistoryChange(task);await write(change.path,change.content)}else await write(paths.task(id),JSON.stringify(task))
   if(scenario.remember)workspace.remember({taskId:id,rootTaskId:id,folder,directory:actual})
   const currentBefore=await withSnapshot(files,s=>files.read(s,paths.task(id)))
   const historyBefore=scenario.history?await withSnapshot(files,s=>files.read(s,taskHistoryChange(task).path)):undefined
   let archiveStateReads=0;const read=files.read.bind(files)
   files.read=async(snapshot,p)=>{if(p.startsWith('archives/')&&p.endsWith('/state.json')){archiveStateReads++;throw Error('Unrelated archive state is unreadable in this fixture')}return read(snapshot,p)}
   for(const role of ['Foreground','Helper']){
    const registered=new Map(),agent={id:'agent-'+role,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>registered.set(t.name,t)}}
    const binding={role,owner:'A',member:'A',workId:'work-'+role,executionId:'execution-'+role}
    installFrameworkRoleTools(ctx,agent,binding,{files,workspace:{instanceUUID:uuid,locate:locateAdapter.call({workspaces:workspace})},transact:async()=>{throw Error('No mutation expected')},notifications:async()=>[],claimNotifications:async()=>({taskId:id,signals:[]}),onError:()=>{}})
    let calls=0;const call=(name,input)=>registered.get(name).execute(input,{agent,callId:'call-'+(++calls),signal:new AbortController().signal,concludeTurn(){}})
    for(const tool of ['dss_snapshot','dss_claim']){
     const value=await call(tool,tool==='dss_snapshot'?{taskId:id}:{}),expected=scenario.where?path.join(scenario.where==='old'?oldRoot:newRoot,folder):undefined
     check(mode+'/'+scenario.name+'/'+role+'/'+tool+' exact location or no fabricated field',value.workspace?.directory,expected)
     check('Absent location is actually omitted, not serialized as a fake directory',Object.hasOwn(value,'workspace'),!!scenario.where)
     check('Source identity remains this actual Host',value.workspaceSource.instanceUUID,uuid)
     check('Archive location remains available',typeof value.archiveDirectory,'string')
     const identityPath=scenario.history?taskHistoryChange(task).path:paths.task(id)
     const identity=await call('dss_read',{snapshotId:value.snapshotId,path:identityPath})
     check('Existing actual read returns original result reference',JSON.parse(identity.text).workspaceResults,[physical])
     await call('dss_snapshot_release',{snapshotId:value.snapshotId})
    }
   }
   check('Terminal/history location does not read archive runtime state',archiveStateReads,0)
   check('Read tools do not create the new directory',await fs.stat(newRoot).catch(()=>undefined),undefined)
   check('Read tools preserve current metadata',await withSnapshot(files,s=>files.read(s,paths.task(id))),currentBefore)
   if(scenario.history)check('Read tools preserve original history and result references',await withSnapshot(files,s=>files.read(s,taskHistoryChange(task).path)),historyBefore)
   const opened=[],service=Object.assign(new Open(),{access:async()=>({connection:{identity:{instanceUUID:uuid}}}),checkScope(){},foreground:(_a,fn)=>fn(),ctx:{get:()=>({canOpenWorkspacePath:()=>true,async openWorkspacePath({path}){opened.push(path);check('Original user result bytes remain reachable',await fs.readFile(path,'utf8'),'Preserved original result')}})}})
   check('Actual service opens exact existing result independent of workspace field',(await service.openWorkspaceFile({mode,path:physical.path,reference:physical})).path,physical.path)
   check('Exactly one original native-open request',opened,[physical.path])
   results.push({mode,case:scenario.name,expectedWorkspace:scenario.where??'omitted',archiveStateReads,originalResultOpened:true})
  }finally{await files.close?.()}
 }
 console.log(JSON.stringify({status:'passed-history-workspace-reference',assertions,snapshotAndClaimCalls:cases.length*2*2*2,identityReadCalls:cases.length*2*2*2,results,sourceHashes:Object.fromEntries(loaded),limits:'Actual runtime workspace-view adapter and installFrameworkRoleTools with dss_snapshot/dss_claim/dss_read/release and TaskWorkspaces, actual Local files, controlled Git repository. Schema and unused Markdown/skill seams match the existing project test loader. Delayed claim notifications and native opener are controlled ports; original file bytes are real. No complete Host/DSH/Windows/live remote acceptance.'},null,2))
}finally{await fs.rm(temp,{recursive:true,force:true});hooks.deregister()}
