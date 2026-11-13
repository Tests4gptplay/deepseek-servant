import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Current explicit manual cleanup contract: original confirmed selections only,
// no general transaction, no completed-file receipt and no global archive scan.
// Production methods use real Linux files. Native/SDK/parser dependencies below
// are controlled ports, not native DSH UI or Windows acceptance.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return {url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true}
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){const children=[];for(const m of text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g))children.push({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}});return {type:'root',children}}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/role-tools.ts',root).href) return {url:data(`export function workerPaths(){throw new Error('Worker paths are outside this controlled conversation check')}`),shortCircuit:true}
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
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { taskHistoryChange } = await import('../src/framework/task-history.ts')
const { frameworkStorageUsage } = await import('../src/framework/maintenance.ts')
const { withSnapshot, withOperationChannel } = await import('../src/framework/transactions.ts')
// Execute the current runtime's actual reset lifecycle and same-role queue.
// Only its technical KV storage is a physical fixture; no native Agent exists
// in these retired/no-active-Foreground scenarios, so no fake stop is asserted.
const hash=value=>createHash('sha256').update(value).digest('hex')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',root),'utf8')
loaded.set('framework/role-runtime.ts',hash(runtimeSource))
const runtimeJs=stripTypeScriptTypes(runtimeSource,{mode:'transform'})
function method(name){
 const match=new RegExp('\\n    (?:async )?'+name+'\\(').exec(runtimeJs);assert.ok(match,'actual runtime method '+name)
 const start=match.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(runtimeJs.slice(start+match[0].length));assert.ok(next)
 return runtimeJs.slice(start,start+match[0].length+next.index)
}
const Runtime=new Function('hash','withOperationChannel','return class {\n'+['roleKey','serialWork','isForegroundResetComplete','withForegroundReset'].map(method).join('\n')+'\n}')(hash,withOperationChannel)
const runtimeFor=(files,conversation)=>{
 const directory=path.join(files.directory,'.fixture-native-runtime'),filename=key=>path.join(directory,Buffer.from(key).toString('base64url')+'.json')
 const records={
  async get(key){try{return JSON.parse(await fs.readFile(filename(key),'utf8')).value}catch(error){if(error.code==='ENOENT')return;throw error}},
  async set(key,value){await fs.mkdir(directory,{recursive:true});await fs.writeFile(filename(key),JSON.stringify({key,value}))},
  async list(prefix){let names;try{names=await fs.readdir(directory)}catch(error){if(error.code==='ENOENT')return [];throw error}return (await Promise.all(names.map(name=>fs.readFile(path.join(directory,name),'utf8').then(JSON.parse)))).filter(row=>row.key.startsWith(prefix))},
 }
 return Object.assign(new Runtime(),{files,conversation,records,config:{mode:'local'},prefix:'runtime/',roleRecords:new Map()})
}
const scratch=process.argv[2]==='--crash' ? process.argv[3] : await fs.mkdtemp(path.join(os.tmpdir(),'dss-manual-cleanup-'))
const names=[],check=(name,a,b)=>{assert.deepEqual(a,b);names.push(name)},rejects=async(name,fn,re)=>{await assert.rejects(fn,re);names.push(name)}
const transactions={run(){throw new Error('Physical manual cleanup must never use a generic transaction')}}
const lifecycle={isForegroundResetComplete:async()=>false,withForegroundReset:async()=>{throw new Error('Planning/debug must not reset Foreground')},prepareTaskCleanup:async()=>{},taskCleanupComplete:async()=>true}
const fixture=async name=>{
 const files=new PhysicalLocalFiles(path.join(scratch,name)),conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'manual'})
 const cleanup=new FrameworkManualCleanup(files,transactions,conversation,lifecycle)
 return {files,conversation,cleanup,list:conversation.foregroundRoot+'/Foreground_List.md',cache:conversation.foregroundRoot+'/Foreground_Cache.md'}
}
const read=(f,p)=>withSnapshot(f,s=>f.read(s,p))
const pending=f=>withSnapshot(f,s=>f.list(s,'technical/manual-cleanup/'))
if(process.argv[2]==='--crash'){
 const f=await fixture(''),kind=process.argv[4]
 if(kind.startsWith('conversation-')){
  const runtime=runtimeFor(f.files,f.conversation),cleanup=new FrameworkManualCleanup(f.files,transactions,f.conversation,runtime)
  if(kind==='conversation-action'){
   const original=f.files.replace.bind(f.files)
   f.files.replace=async(p,body)=>{await original(p,body);if(p.startsWith('technical/manual-cleanup/commands/')&&JSON.parse(body).completed)process.exit(86)}
  }else if(kind==='conversation-native'){
   const original=runtime.records.set.bind(runtime.records)
   runtime.records.set=async(k,v)=>{await original(k,v);if(k.includes('/foreground-resets/')&&v.phase==='complete')process.exit(86)}
  }else{
   const original=f.files.delete.bind(f.files)
   f.files.delete=async p=>{const result=await original(p);if(p.startsWith('technical/manual-cleanup/commands/'))process.exit(86);return result}
  }
  await cleanup.clearConversation('actual-conversation-clear','clear-foreground-conversation')
  throw new Error('The requested reset/cleanup boundary was not reached')
 }
 const preview=JSON.parse(await fs.readFile(path.join(scratch,'reviewed-selection.json'),'utf8'))
 if(kind==='task-retire'){
  const original=f.files.delete.bind(f.files)
  f.files.delete=async p=>{const result=await original(p);if(p.startsWith('technical/manual-cleanup/commands/'))process.exit(86);return result}
  await f.cleanup.clearTasks('task-retire',preview,'clear-ended-task-records')
 }else if(kind==='planning'){
  const original=f.files.updateAsync.bind(f.files)
  f.files.updateAsync=async(p,decide)=>{const result=await original(p,decide);if(p===preview.files[0].path)process.exit(86);return result}
  await f.cleanup.clearPlanning('actual-interruption','clear-work-planning-notes',preview)
 }else{
  const original=f.files.deleteObserved.bind(f.files)
  f.files.deleteObserved=async(...args)=>{const result=await original(...args);process.exit(86);return result}
  await f.cleanup.clearDebug('actual-interruption',preview,'clear-debug-records')
 }
 throw new Error('The actual cleanup write boundary was not reached')
}
try{
 const f=await fixture('planning')
 await f.conversation.writeForeground('write',{list:'confirmed list',cache:'confirmed cache'})
 await f.files.replace(f.conversation.foregroundRoot+'/other.md','unrelated record')
 await f.files.replace('debug/2026-11-08.md','unrelated debug')
 await rejects('Physical planning without a reviewed selection performs no writes',()=>f.cleanup.clearPlanning('unreviewed','clear-work-planning-notes'),/Review/)
 check('Missing selection leaves both bodies unchanged',await f.conversation.readForeground(),{list:'confirmed list',cache:'confirmed cache'})
 const listed=[],originalList=f.files.listDirectory.bind(f.files)
 f.files.listDirectory=async(s,p,...args)=>{listed.push(p);return originalList(s,p,...args)}
 const preview=await f.cleanup.previewFiles('planning')
 check('Planning preview reads one known Foreground directory',listed,[f.conversation.foregroundRoot+'/'])
 check('Planning preview selects only actual List and Cache',preview.files.map(x=>x.path).sort(),[f.list,f.cache].sort())
 await f.files.replace(f.list,'confirmed list') // Same bytes, genuinely later write.
 const cleared=await f.cleanup.clearPlanning('clear','clear-work-planning-notes',preview)
 check('Planning clear preserves a later same-text write',await read(f.files,f.list),'confirmed list')
 check('Planning clear empties the unchanged reviewed cache',await read(f.files,f.cache),'')
 check('Planning reports the actual newer file it preserved',cleared.preservedPaths,[f.list])
 check('Planning clear does not delete other records',[await read(f.files,f.conversation.foregroundRoot+'/other.md'),await read(f.files,'debug/2026-11-08.md')],['unrelated record','unrelated debug'])
 check('Completed planning command leaves no intent or plan',await pending(f.files),[])
 await f.files.replace(f.cache,'cache after success')
 await f.cleanup.clearPlanning('clear','clear-work-planning-notes',preview)
 check('Retry with original preview cannot empty later cache',await read(f.files,f.cache),'cache after success')
 check('A completed retry also retires its intent',await pending(f.files),[])
 await rejects('A mutated preview cannot clear another path',()=>f.cleanup.clearPlanning('tampered','clear-work-planning-notes',{...preview,files:[{...preview.files[0],path:'debug/2026-11-08.md'}]}),/exact reviewed/)
 await f.files.close()
 const d=await fixture('debug')
 await d.files.replace('debug/2026-11-07.md','old daily debug')
 await d.files.replace('debug/2026-11-08.md','current daily debug')
 await d.files.replace('debug/helper-reports/material.md','actual helper report')
 await d.files.replace('debug/helper-reports/nested/keep.md','not selected')
 await d.files.replace('debug/other.txt','not a known debug record')
 await d.files.replace('task-runs/task/notes.md','independent task')
 const debugListings=[],listDebug=d.files.listDirectory.bind(d.files),recursive=d.files.list.bind(d.files)
 d.files.listDirectory=async(s,p,...args)=>{debugListings.push(p);return listDebug(s,p,...args)}
 d.files.list=async()=>{throw new Error('File cleanup preview must not recurse')}
 const debug=await d.cleanup.previewFiles('debug')
 check('Debug preview lists only the two known directories',debugListings.sort(),['debug/','debug/helper-reports/'])
 check('Debug preview includes daily originals and named reports only',debug.files.map(x=>x.path),['debug/2026-11-07.md','debug/2026-11-08.md','debug/helper-reports/material.md'])
 await d.files.append('debug/2026-11-08.md','\nnew diagnostic event')
 await d.files.replace('debug/2026-11-09.md','new daily record')
 const debugResult=await d.cleanup.clearDebug('clear-debug',debug,'clear-debug-records')
 check('Only unchanged reviewed debug files are deleted',debugResult.deletedPaths,['debug/2026-11-07.md','debug/helper-reports/material.md'])
 check('An actively appended debug file is preserved',debugResult.preservedPaths,['debug/2026-11-08.md'])
 check('New dated record and unrelated nested data remain',[await read(d.files,'debug/2026-11-09.md'),await read(d.files,'debug/helper-reports/nested/keep.md'),await read(d.files,'task-runs/task/notes.md')],['new daily record','not selected','independent task'])
 d.files.list=recursive
 check('Debug cleanup also retires its exact intent',await pending(d.files),[])
 await d.files.replace('debug/helper-reports/material.md','report recreated after success')
 await d.cleanup.clearDebug('clear-debug',debug,'clear-debug-records')
 check('Completed debug retry preserves a recreated path',await read(d.files,'debug/helper-reports/material.md'),'report recreated after success')
 const stats=await frameworkStorageUsage(d.files)
 const debugBytes=(await withSnapshot(d.files,s=>d.files.list(s,'debug/'))).reduce((n,r)=>n+r.bytes,0)
 check('Explicit storage accounting classifies all retained debug bytes',stats.permanent.debugBytes,debugBytes)
 check('Debug is longterm, while the active Task remains temporary',stats.temporaryBytes,Buffer.byteLength('independent task'))
 await d.files.close()
 // Real process exit after one completed file syscall. Later parent writes are
 // new facts; resumePending must use the stored preview and preserve them.
 for(const kind of ['planning','debug']){
  const x=await fixture('exit-'+kind)
  if(kind==='planning')await x.conversation.writeForeground('write',{list:'old list',cache:'old cache'})
  else {await x.files.replace('debug/2026-11-07.md','one');await x.files.replace('debug/2026-11-08.md','two')}
  const reviewed=await x.cleanup.previewFiles(kind)
  await fs.writeFile(path.join(x.files.directory,'reviewed-selection.json'),JSON.stringify(reviewed))
  await x.files.close()
  const outcome=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--crash',x.files.directory,kind],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.once('error',reject);child.once('close',code=>resolve({code,output}))})
  check('Actual process exits after first '+kind+' file operation',outcome.code,86)
  const files=new PhysicalLocalFiles(x.files.directory),conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'manual'}),cleanup=new FrameworkManualCleanup(files,transactions,conversation,lifecycle)
  check('Interrupted '+kind+' action retains one confirmed intent',(await pending(files)).length,1)
  await files.replace(reviewed.files[0].path,'later writer')
  const results=await cleanup.resumePending()
  check('Restart resumes only the one actually confirmed '+kind+' action',results.length,1)
  check('Restart preserves newer '+kind+' file',await read(files,reviewed.files[0].path),'later writer')
  check('Restart completes second original '+kind+' file',await read(files,reviewed.files[1].path),kind==='planning'?'':undefined)
  check('Restart retires only its completed '+kind+' intent',await pending(files),[])
  await files.replace(reviewed.files[1].path,'after completed restart')
  if(kind==='planning')await cleanup.clearPlanning('actual-interruption','clear-work-planning-notes',reviewed)
  else await cleanup.clearDebug('actual-interruption',reviewed,'clear-debug-records')
  check('Postrestart retry preserves second newer '+kind+' file',await read(files,reviewed.files[1].path),'after completed restart')
  await files.close()
 }
 // These exits distinguish the cleanup action from actual runtime reset
 // completion. Completed temporary plans must still finish/retire the reset.
 for(const phase of ['conversation-action','conversation-native','conversation-retire']){
  const x=await fixture('exit-'+phase)
  const message=id=>({id,participantId:'user',createdAt:'2026-11-08T12:00:00.000Z',role:'user',recipient:'ai',text:'original '+id})
  await x.conversation.send('old',message('old'))
  await x.files.close()
  const outcome=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--crash',x.files.directory,phase],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.once('error',reject);child.once('close',code=>resolve({code,output}))})
  check('Actual process exit reaches '+phase,outcome.code,86)
  const files=new PhysicalLocalFiles(x.files.directory),conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'manual'}),runtime=runtimeFor(files,conversation),cleanup=new FrameworkManualCleanup(files,transactions,conversation,runtime)
  check('Existing reset records actual completion at '+phase,await runtime.isForegroundResetComplete('actual-conversation-clear'),phase!=='conversation-action')
  await conversation.send('new',message('new'))
  const results=await cleanup.resumePending()
  check('Restart retires the same confirmed conversation command at '+phase,results.length,1)
  check('Restart completes the existing reset at '+phase,await runtime.isForegroundResetComplete('actual-conversation-clear'),true)
  check('Restart preserves new conversation at '+phase,(await conversation.page(10)).messages.map(m=>m.id),['new'])
  check('Restart leaves only new message signal at '+phase,(await withSnapshot(files,s=>files.listDirectory(s,'state/',{namePrefix:'Foreground_'}))).length,1)
  check('Restart leaves no duplicate cleanup plan or intent at '+phase,await pending(files),[])
  await cleanup.clearConversation('actual-conversation-clear','clear-foreground-conversation')
  check('Retired reset replay never selects later input at '+phase,(await conversation.page(10)).messages.map(m=>m.id),['new'])
  check('Restart discovers no completed cleanup again at '+phase,await cleanup.resumePending(),[])
  await files.close()
 }
 // Current Task result paths and exact old artifact manifests establish what to
 // preserve. An unrelated malformed global manifest must not be opened.
 const t=await fixture('tasks'),task={version:1,taskId:'done',route:'P',owner:'member',status:'complete',sourcePath:'tasks/original_P.md',archiveFolder:'original_P_done',resultPaths:['archives/original_P_done/current.txt']}
 const history=taskHistoryChange(task)
 await t.files.replace(history.path,history.content)
 await t.files.replace('archives/original_P_done/records.md','history selected for clearing')
 await t.files.replace('archives/original_P_done/current.txt','current result')
 const oldArtifact='archives/original_P_done/imported.bin'
 await t.files.replace(oldArtifact,'imported retained artifact')
 await t.files.replace('technical/artifacts/manifests/'+createHash('sha256').update(oldArtifact).digest('hex')+'.json',JSON.stringify({taskId:'done',path:oldArtifact}))
 await t.files.replace('technical/artifacts/manifests/unrelated.json','malformed unrelated manifest')
 const scans=[],list=t.files.list.bind(t.files)
 t.files.list=async(s,p,...rest)=>{scans.push(p);if(p.startsWith('technical/artifacts/manifests'))throw new Error('Global manifest catalog scan');return list(s,p,...rest)}
 const taskPreview=await t.cleanup.previewTasks()
 check('Task preview finds its existing terminal history',taskPreview.tasks.map(x=>x.taskId),['done'])
 check('Task preview preserves both current and imported artifact originals',taskPreview.preservedPaths.sort(),['archives/original_P_done/current.txt',oldArtifact].sort())
 check('Task preview does not recursively enumerate artifact or migration catalogs',scans.some(p=>p.startsWith('technical/')),false)
 await t.cleanup.clearTasks('clear-task',taskPreview,'clear-ended-task-records')
 check('Task manual clear removes actual history and keeps both artifact originals',[await read(t.files,'archives/original_P_done/records.md'),await read(t.files,'archives/original_P_done/current.txt'),await read(t.files,oldArtifact)],[undefined,'current result','imported retained artifact'])
 await t.cleanup.clearTasks('clear-task',taskPreview,'clear-ended-task-records')
 check('Completed Task retry recognizes existing historyCleared and leaves no new intent',await pending(t.files),[])
 // Same Task cleanup interruption after deleting the plan: the original intent
 // is its discoverable temporary completion, never a second permanent receipt.
 const r=await fixture('task-retire'),retiringTask={...task,taskId:'retire',archiveFolder:'retire_P_retire',resultPaths:[]},retiringHistory=taskHistoryChange(retiringTask)
 await r.files.replace(retiringHistory.path,retiringHistory.content)
 await r.files.replace('archives/retire_P_retire/records.md','retiring history')
 const retiringPreview=await r.cleanup.previewTasks()
 await fs.writeFile(path.join(r.files.directory,'reviewed-selection.json'),JSON.stringify(retiringPreview))
 await r.files.close()
 const taskExit=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--crash',r.files.directory,'task-retire'],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.once('error',reject);child.once('close',code=>resolve({code,output}))})
 check('Actual process exits after completed Task plan retirement',taskExit.code,86)
 const rf=new PhysicalLocalFiles(r.files.directory),rc=new FrameworkConversation(rf,transactions,{mode:'local',collaborationId:'manual'}),rm=new FrameworkManualCleanup(rf,transactions,rc,lifecycle)
 check('Task retirement interruption retains only its discoverable intent',(await pending(rf)).map(row=>row.path.split('/')[2]),['intents'])
 await rm.resumePending()
 check('Task restart retires the original completed intent without rebuilding selection',await pending(rf),[])
 await rf.close();await t.files.close()
 // Existing migration indexes remain authoritative for preserved old user
 // data. Never erase that index just to avoid discovering its mapped histories.
 const legacy=await fixture('legacy-selection'),migrationPath='technical/legacy-migrations/imported/manifest.json',sourcePath='technical/legacy-migrations/imported/source/task.json',sharedPath='technical/legacy-migrations/imported/source/shared.json'
 const manifest={version:1,id:'imported',baseline:'original-v44',source:{mode:'local'},tasks:[{oldId:'old-task',taskId:'legacy-task',continuation:'complete'},{oldId:'other-task',taskId:'other-legacy-task',continuation:'running'}],records:[{key:'task:old-task',path:sourcePath},{key:'records/old-task/one',path:sharedPath},{key:'records/other-task/one',path:sharedPath}],references:{},referenceHashes:{},messages:[]}
 await legacy.files.replace('technical/legacy-migrations/index.json',JSON.stringify({migrations:[{manifestPath:migrationPath}]}))
 await legacy.files.replace(migrationPath,JSON.stringify(manifest))
 await legacy.files.replace(sourcePath,'selected old source')
 await legacy.files.replace(sharedPath,'still needed by another old user record')
 await legacy.files.replace('archives/legacy-task/records.md','old retained history')
 await legacy.files.replace('archives/legacy-task/result.bin','old delivered result')
 await legacy.files.replace('technical/artifacts/manifests/'+hash('archives/legacy-task/result.bin')+'.json',JSON.stringify({taskId:'legacy-task',path:'archives/legacy-task/result.bin'}))
 const oldPreview=await legacy.cleanup.previewTasks()
 check('Existing indexed legacy terminal history remains visible',oldPreview.tasks.map(task=>task.taskId),['legacy-task'])
 await legacy.cleanup.clearTasks('legacy-clear',oldPreview,'clear-ended-task-records')
 check('Explicit old cleanup preserves shared original and old artifact',[await read(legacy.files,sourcePath),await read(legacy.files,sharedPath),await read(legacy.files,'archives/legacy-task/result.bin')],[undefined,'still needed by another old user record','old delivered result'])
 const updatedMap=JSON.parse(await read(legacy.files,migrationPath))
 check('Original migration map retains the other Task and exact cleared identity',[updatedMap.tasks.map(task=>task.taskId),updatedMap.clearedTasks.map(task=>task.taskId)],[['other-legacy-task'],['legacy-task']])
 await legacy.cleanup.clearTasks('legacy-clear',oldPreview,'clear-ended-task-records')
 check('Old cleanup replay uses existing disposal identity without a new permanent receipt',await pending(legacy.files),[])
 await legacy.files.close()
 // Run the component's actual async handlers with controlled React state and
 // API ports. JSX/DOM/native DSH rendering is deliberately outside this test.
 const panelSource=readFileSync(new URL('framework/manual-cleanup-panel.tsx',root),'utf8')
 loaded.set('framework/manual-cleanup-panel.tsx',hash(panelSource))
 const bodyStart=panelSource.indexOf('export function ManualCleanupPanel'),bodyEnd=panelSource.indexOf('  return <section')
 const handlerSource=panelSource.slice(bodyStart,bodyEnd)+'  return { prepare, confirm, inspectDebug, readDebug, pending, debug, debugRecord, error, result, busy };\n}'
 const Panel=new Function('useState','frameworkErrorText',stripTypeScriptTypes(handlerSource,{mode:'transform'}).replace('export function','function')+'\nreturn ManualCleanupPanel;')
 const state=[];let cursor=0
 const useState=initial=>{const key=cursor++;if(!(key in state))state[key]=initial;return[state[key],value=>{state[key]=typeof value==='function'?value(state[key]):value}]}
 const calls=[],ui=await fixture('ui-handler')
 await ui.conversation.writeForeground('write',{list:'UI reviewed list',cache:'UI reviewed cache'})
 await ui.files.replace('debug/2026-11-08.md','UI visible debug original')
 let loseReply=true
 const api={
  async cleanupPreview(input){calls.push({type:'preview',input});return input.action==='tasks'?ui.cleanup.previewTasks():ui.cleanup.previewFiles(input.action)},
  async cleanupRecords(input){calls.push({type:'clear',input});const result=input.action==='planning'?await ui.cleanup.clearPlanning(input.commandId,input.confirmation,input.preview):await ui.cleanup.clearDebug(input.commandId,input.preview,input.confirmation);if(loseReply){loseReply=false;throw new Error('controlled lost reply after actual cleanup')}return result},
  async readFile(input){calls.push({type:'read',input});return{path:input.path,text:await read(ui.files,input.path)}},
 }
 const component=Panel(useState,error=>error.message),render=()=>{cursor=0;return component({api,storageScope:'actual-scope',tr:(_cn,en)=>en,changed:async()=>{calls.push({type:'changed'})}})}
 let handlers=render()
 await handlers.inspectDebug();handlers=render()
 check('Debug view handler is read-only',calls.map(row=>row.type),['preview'])
 check('Debug view handler exposes actual known originals',handlers.debug.files.map(row=>row.path),['debug/2026-11-08.md'])
 await handlers.readDebug(handlers.debug.files[0].path);handlers=render()
 check('Debug viewer reads the actual complete stored original',handlers.debugRecord.text,'UI visible debug original')
 await handlers.prepare('planning');handlers=render()
 const accepted=structuredClone(handlers.pending)
 check('Planning prepare reuses the existing preview endpoint and no clear',calls.filter(row=>row.type==='clear').length,0)
 check('Planning prepare preserves reviewed selection for its existing confirmation',handlers.pending.filePreview.kind,'planning')
 await handlers.confirm();handlers=render()
 check('Unknown UI outcome retains the original command and reviewed selection',[handlers.pending.commandId,handlers.pending.filePreview],[accepted.commandId,accepted.filePreview])
 check('UI surfaces unknown outcome rather than claiming completion',handlers.error,'controlled lost reply after actual cleanup')
 await ui.conversation.writeForeground('later',{list:'new UI list',cache:'new UI cache'})
 await handlers.confirm();handlers=render()
 check('UI retry sends the exact same command and preview',calls.filter(row=>row.type==='clear').map(row=>[row.input.commandId,row.input.preview]),[[accepted.commandId,accepted.filePreview],[accepted.commandId,accepted.filePreview]])
 check('UI retry preserves newer List and Cache through production methods',await ui.conversation.readForeground(),{list:'new UI list',cache:'new UI cache'})
 check('Acknowledged UI cleanup dismisses confirmation and old debug view',[handlers.pending,handlers.debug,handlers.debugRecord],[undefined,undefined,undefined])
 check('UI reports preserved files without calling them deleted',handlers.result.endsWith('2'),true)
 await ui.files.close()
 console.log(JSON.stringify({status:'passed',assertions:names.length,names,limits:'Actual production manual methods with Linux physical files, real process exits/reopen. Explicit SDK/schema/parser/native lifecycle stubs. Actual component async handlers with controlled React state/API ports; JSX/DOM not rendered. No native UI, Windows, full typecheck or production cutover acceptance.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
