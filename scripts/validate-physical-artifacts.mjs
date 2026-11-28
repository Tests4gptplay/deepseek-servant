import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Real production Recorder tool, physical files, merge/catalog and Host/Cleaner.
// SDK schemas, native registry identity, simple YAML and Markdown syntax are
// explicit controlled ports, not installed DSH/Windows/parser acceptance.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hash = value => createHash('sha256').update(value).digest('hex')
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'zod') return { url: data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`), shortCircuit: true }
  if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){return {type:'root',children:[...text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g)].map(m=>({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}}))}}`), shortCircuit: true }
  if (specifier === '@deepseek-ai/dsh-scope') return { url: data('export const scopeOf=scope=>scope.agent'), shortCircuit: true }
  if (specifier === '@deepseek-ai/dsh-skill') return { url: data("export const isSkillName=name=>/^[a-z][a-z0-9-]*$/.test(name)"), shortCircuit: true }
  if (specifier === 'yaml') return { url: data(`export function parse(text){return Object.fromEntries(text.split(/\\r?\\n/).filter(Boolean).map(line=>{const i=line.indexOf(':');if(i<0)throw new Error('fixture invalid YAML');return [line.slice(0,i),line.slice(i+1).trim()]}))}`), shortCircuit: true }
  if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
    const source = readFileSync(new URL(url), 'utf8'); loaded.set(url.slice(sourceRoot.href.length), hash(source))
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
} })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkArtifacts } = await import('../src/framework/artifacts.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { retirePhysicalPublicationsFromEvents } = await import('../src/framework/physical-publication-retirement.ts')
const { paths, encodeJson } = await import('../src/framework/task-files.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const checks=[],check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name)}
const rejects=async(name,action,re)=>{await assert.rejects(action,re);checks.push(name)}
const originalOpen=fs.open,originalRename=fs.rename
const read=(files,p)=>withSnapshot(files,s=>files.read(s,p))
const readBytes=(files,p)=>withSnapshot(files,s=>files.readBytes(s,p))
const stageRoot=(task,command)=>paths.run(task.taskId)+'/.artifacts/'+hash(command)
function nativeSource(filename, hooks={}) {
  const target=Object.freeze({opaque:'native-capability',toString(){throw new Error('An opaque native target must not become a Node path')}})
  const calls={resolves:0,stats:0,reads:0,maxRead:0,cwds:[],targets:[],peakBuffers:0}
  const native={
    async resolve(source,options){calls.resolves++;calls.cwds.push(options.cwd);await hooks.resolve?.(source,options);return target},
    async stat(key){assert.equal(key,target);calls.stats++;let info;try{info=await fs.stat(filename,{bigint:true})}catch(e){if(e.code==='ENOENT')return;throw e}
      return hooks.stat?.(info,calls)??{type:'file',size:Number(info.size),version:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':')}},
    async readByteRange(key,{offset,length},signal){assert.equal(key,target);signal?.throwIfAborted();calls.reads++;calls.maxRead=Math.max(calls.maxRead,length)
      await hooks.beforeRead?.(offset,length,calls)
      const handle=await originalOpen(filename,'r');let result;try{const buffer=Buffer.alloc(length),{bytesRead}=await handle.read(buffer,0,length,offset);result=buffer.subarray(0,bytesRead)}finally{await handle.close()}
      await hooks.afterRead?.(result,offset,calls);calls.peakBuffers=Math.max(calls.peakBuffers,process.memoryUsage().arrayBuffers)
      return result},
  }
  return {fs:native,calls,target}
}
async function fixture(directory,name='one',body=Buffer.from([239,187,191,0,255,128,13,10]),nativeHooks={}){
  await fs.mkdir(directory,{recursive:true})
  const files=new PhysicalLocalFiles(path.join(directory,'local'))
  const task={version:1,taskId:'00000000-0000-4000-8000-'+hash(name).slice(0,12),route:'P',owner:'A',members:['A'],lifecycleId:'first',status:'running',sourcePath:'tasks/'+name+'_P.md',archiveFolder:name+'_'+'00000000-0000-4000-8000-'+hash(name).slice(0,12)}
  await files.replace(paths.task(task.taskId),encodeJson(task));await files.replace(task.sourcePath,'Task ID: '+task.taskId+'\nOriginal requirement')
  const source=path.join(directory,'native.bin');if(body!==undefined)await fs.writeFile(source,body)
  const native=nativeSource(source,nativeHooks),input={taskId:task.taskId,sourcePath:'original/native.bin',destinationPath:paths.archive(task)+'/original.bin'}
  const transactions={run(){throw new Error('Physical artifact used generic transaction')}}
  const artifacts=new FrameworkArtifacts(native,files,transactions,'wrong fallback')
  const options={cwd:'actual native agent cwd',taskOwner:{taskId:task.taskId,lifecycleId:task.lifecycleId,hostKey:'host'},signal:new AbortController().signal}
  return {files,task,source,native,input,artifacts,options,directory,run(command='execution:save',extra={}){return artifacts.preserve(command,input,{...options,...extra})}}
}
if(process.argv[2]==='--exit'){
  const directory=process.argv[3],point=process.argv[4],saved=JSON.parse(await fs.readFile(path.join(directory,'fixture.json'),'utf8'))
  const files=new PhysicalLocalFiles(path.join(directory,'local')),native=nativeSource(path.join(directory,'native.bin'))
  const artifacts=new FrameworkArtifacts(native,files,{run(){throw Error('generic transaction')}},'unused')
  const work=stageRoot(saved.task,'execution:save')
  if(point==='partial')fs.open=async(...args)=>{const h=await originalOpen(...args);if(String(args[0])===path.join(files.directory,work+'/original.raw.copying')){const write=h.write.bind(h);h.write=async(...a)=>{await write(...a);process.exit(91)}}return h}
  if(point==='complete')fs.rename=async(from,to)=>{if(String(to)===path.join(files.directory,work+'/original.raw'))process.exit(97);return originalRename(from,to)}
  if(point==='captured')fs.rename=async(from,to)=>{const r=await originalRename(from,to);if(String(to)===path.join(files.directory,work+'/original.raw'))process.exit(92);return r}
  if(point==='bytes')fs.rename=async(from,to)=>{const r=await originalRename(from,to);if(String(to)===path.join(files.directory,saved.input.destinationPath))process.exit(93);return r}
  if(point==='manifest')fs.rename=async(from,to)=>{const r=await originalRename(from,to);if(String(to).includes('/technical/artifacts/manifests/'))process.exit(94);return r}
  if(point==='published'){const replace=files.replace.bind(files);files.replace=async(p,c)=>{await replace(p,c);if(p===work+'/publication.json'&&JSON.parse(c).published)process.exit(95)}}
  if(point==='owner-gap')fs.open=async(...args)=>{const h=await originalOpen(...args);if(String(args[0])===path.join(files.directory,work+'/original.raw.copying'))process.exit(96);return h}
  await artifacts.preserve('execution:save',saved.input,saved.options)
  throw Error('Expected process exit was not reached: '+point)
}
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dss-physical-artifacts-'))
try {
 const f=await fixture(path.join(directory,'basic'))
 const original=await fs.readFile(f.source),first=await f.run()
 check('Actual Physical preserve publishes BOM/binary originals byte-for-byte',Array.from(await readBytes(f.files,first.path)),Array.from(original))
 check('Returned actual digest/length', [first.sha256,first.bytes],[hash(original),original.length])
 check('Actual agent cwd passed through original ctx.fs resolver',f.native.calls.cwds,['actual native agent cwd'])
 check('Native bounded capture has exactly initial and final source stat',f.native.calls.stats,2)
 check('Capture raw and owner are removed after actual publication',await f.files.fileInfo(stageRoot(f.task,'execution:save')+'/original.raw.capture.json'),undefined)
 const repeated=await fixture(path.join(directory,'repeated'),'repeated',Buffer.alloc(8*1024*1024,71))
 const existing=await repeated.run('execution:first'),privateRaw=stageRoot(repeated.task,'execution:second')+'/original.raw'
 const fingerprint=repeated.files.fingerprint.bind(repeated.files),physicalRead=repeated.files.read.bind(repeated.files)
 let privateReads=0,privateBytes=0,ownerReads=0
 repeated.files.fingerprint=async(...args)=>{const result=await fingerprint(...args);if(args[0]===privateRaw){privateReads++;privateBytes+=result?.bytes??0}return result}
 repeated.files.read=async(...args)=>{if(args[1]===privateRaw+'.capture.json')ownerReads++;return physicalRead(...args)}
 const importedAgain=await repeated.run('execution:second')
 repeated.files.fingerprint=fingerprint;repeated.files.read=physicalRead
 check('An ordinary new command reuses the already published archive',importedAgain,existing)
 check('Completed command does not reread its private raw or owner',[privateReads,privateBytes,ownerReads],[0,0,0])
 check('Repeated import preserves the published original',(await repeated.files.fingerprint(existing.path)).sha256,existing.sha256)
 check('Repeated command removes only its own private raw and owner',
  [await repeated.files.fileInfo(privateRaw),await repeated.files.fileInfo(privateRaw+'.capture.json')],[undefined,undefined])
 check('Repeated command keeps its result fact until original tool success',!!await repeated.files.fileInfo(stageRoot(repeated.task,'execution:second')+'/publication.json'),true)
 const nativeCounts=[f.native.calls.resolves,f.native.calls.reads,f.native.calls.stats]
 await fs.rm(f.source)
 check('Original unretired command replay returns saved result with source missing',await f.run(),first)
 check('Confirmed replay never reopens missing native source',[f.native.calls.resolves,f.native.calls.reads,f.native.calls.stats],nativeCounts)
 await rejects('Same command cannot import a different native source',()=>f.artifacts.preserve('execution:save',{...f.input,sourcePath:'other'},f.options),/arguments changed/)
 await f.files.replace(first.path,'later user edit\0')
 const edited=await f.artifacts.read(first.path)
 check('Ordinary Local artifact read returns actual later user bytes',Buffer.from(edited.data).toString(),'later user edit\0')
 check('Read metadata describes actual current file, not stale manifest hash',edited.artifact.sha256,hash('later user edit\0'))
 await f.files.replace(first.path,new Uint8Array())
 check('User zero-length edit remains readable',(await f.artifacts.read(first.path)).data.length,0)
 await f.files.delete(first.path);await rejects('Missing original reports missing, not old hash failure',()=>f.artifacts.read(first.path),/file is missing/)
 const view=Buffer.from(JSON.stringify({taskId:f.task.taskId})).toString('base64url')
 const call={type:'tool/call',data:{callId:'save',name:'dss_preserve_artifact',arguments:JSON.stringify({snapshotId:view,...f.input})}}
 const result={type:'tool/result',data:{message:{toolCallId:'save',isError:false}}}
 await retirePhysicalPublicationsFromEvents(f.files,'execution',[call,{...result,data:{message:{toolCallId:'save',isError:true}}}])
 check('Failed original result does not retire retry fact',!!await f.files.fileInfo(stageRoot(f.task,'execution:save')+'/publication.json'),true)
 await retirePhysicalPublicationsFromEvents(f.files,'execution',[call,result])
 check('Persisted successful original result retires only exact command fact',await f.files.fileInfo(stageRoot(f.task,'execution:save')+'/publication.json'),undefined)
 const zero=await fixture(path.join(directory,'zero'),'zero',new Uint8Array())
 check('Empty native file is an actual artifact, not absent',(await zero.run()).bytes,0)
 for(const bad of ['../escape','archives/wrong/original.bin',paths.archive(zero.task)+'/records.md',paths.archive(zero.task)+'/retention.json/bytes']){
  await rejects('Invalid/foreign/reserved target rejected before native read '+bad,()=>zero.artifacts.preserve('bad'+bad,{...zero.input,destinationPath:bad},zero.options),/path|archive/)
 }
 const held=await fixture(path.join(directory,'parallel'),'held',Buffer.alloc(512*1024,65))
 const other=await fixture(held.directory,'other',Buffer.alloc(512*1024,65))
 let release,entered;const gate=new Promise(r=>release=r),entry=new Promise(r=>entered=r)
 const nativeHeld=nativeSource(held.source,{beforeRead:async()=>{entered();await gate}})
 const heldService=new FrameworkArtifacts(nativeHeld,held.files,{},'cwd')
 const pending=heldService.preserve('held',held.input,held.options)
 await entry
 check('Another actual Task completes while native source read is held',(await other.run()).bytes,512*1024)
 await held.files.replace('independent.txt','ordinary write')
 check('Unrelated direct physical writes do not wait on capture',await read(held.files,'independent.txt'),'ordinary write')
 release();await pending
 const changing=await fixture(path.join(directory,'changing'),'changing',Buffer.alloc(700*1024,1),{afterRead:async(_chunk,offset)=>{if(!offset)await fs.writeFile(path.join(directory,'changing','native.bin'),Buffer.alloc(700*1024,2))}})
 await rejects('A native source changed during capture never becomes a mixed archive',()=>changing.run(),/changed while being captured/)
 check('Changed capture does not publish destination',await changing.files.fileInfo(changing.input.destinationPath),undefined)
 check('Changed capture does not emit Cleaner',await changing.files.fileInfo(paths.state('A',changing.task.taskId)+'/Cleaner'),undefined)
 const denied=await fixture(path.join(directory,'denied'),'denied',Buffer.from('private'),{resolve:async()=>{throw Error('native permission denied')}})
 await rejects('Native permission denial is honored, no fallback read',()=>denied.run(),/native permission denied/)
 check('Denied source never reaches stat/read',[denied.native.calls.stats,denied.native.calls.reads],[0,0])
 check('Denied source has no archive',await denied.files.fileInfo(denied.input.destinationPath),undefined)
 // Existing unrelated archive bytes and user-edited same-command stage survive.
 const conflict=await fixture(path.join(directory,'conflict'),'conflict',Buffer.from('incoming'))
 await conflict.files.replace(conflict.input.destinationPath,'existing user original')
 await rejects('Existing actual archive original is never overwritten',()=>conflict.run(),/cannot be overwritten/)
 check('Existing user original remains byte exact',await read(conflict.files,conflict.input.destinationPath),'existing user original')
 const conflictStage=stageRoot(conflict.task,'execution:save')+'/original.raw'
 check('Rejected import retains its actual captured bytes',await read(conflict.files,conflictStage),'incoming')
 await conflict.files.replace(conflictStage,'user changed pending capture');await conflict.files.delete(conflict.input.destinationPath)
 await rejects('Changed accepted raw stage is preserved, not recaptured',()=>conflict.run(),/stage is missing or changed/)
 check('Changed stage survives',await read(conflict.files,conflictStage),'user changed pending capture')
 // Real process exits across capture and the actual three-file publication.
 for(const [point,exit] of [['partial',91],['complete',97],['captured',92],['bytes',93],['manifest',94],['published',95],['owner-gap',96]]){
  const f=await fixture(path.join(directory,'exit-'+point),point,Buffer.alloc(768*1024,point.length))
  await fs.writeFile(path.join(f.directory,'fixture.json'),JSON.stringify({task:f.task,input:f.input,options:{...f.options,signal:undefined}}))
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--exit',f.directory,point],{encoding:'utf8'})
  check('Actual process interrupted at '+point,child.status,exit)
  if(point==='owner-gap'){
   await rejects('Unowned partial after create/owner gap is not overwritten',()=>f.run(),/Unowned partial capture/)
   check('Unowned partial retained',!!await f.files.fileInfo(stageRoot(f.task,'execution:save')+'/original.raw.copying'),true);continue
  }
  if(point!=='partial')await fs.rm(f.source)
  const resumed=await f.run()
  check('Cold continuation completes exact original at '+point,resumed.sha256,hash(Buffer.alloc(768*1024,point.length)))
  check('Cold continuation preserves complete actual bytes at '+point,(await f.files.fingerprint(resumed.path)).sha256,resumed.sha256)
  check('Cold continuation removes capture owner at '+point,await f.files.fileInfo(stageRoot(f.task,'execution:save')+'/original.raw.capture.json'),undefined)
 }
 // Interrupted incomplete sources and partials are exact-owned, not blindly replaced.
 for(const change of ['source','partial','missing-stage']){
  const f=await fixture(path.join(directory,'changed-'+change),change,Buffer.alloc(768*1024,31))
  await fs.writeFile(path.join(f.directory,'fixture.json'),JSON.stringify({task:f.task,input:f.input,options:{...f.options,signal:undefined}}))
  const point=change==='missing-stage'?'captured':'partial',exit=point==='captured'?92:91
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--exit',f.directory,point],{encoding:'utf8'})
  check('Actual interrupted original before '+change,child.status,exit)
  const work=stageRoot(f.task,'execution:save')
  if(change==='source')await fs.writeFile(f.source,Buffer.alloc(768*1024,32))
  if(change==='partial')await fs.writeFile(path.join(f.files.directory,work+'/original.raw.copying'),Buffer.from('user changed partial'))
  if(change==='missing-stage')await f.files.delete(work+'/original.raw')
  await rejects('Cold '+change+' is not mistaken for a successful original',()=>f.run(),/changed|missing/)
  check('Cold '+change+' never creates a false archive',await f.files.fileInfo(f.input.destinationPath),undefined)
  if(change==='partial')check('Actual edited partial survives exactly',await read(f.files,work+'/original.raw.copying'),'user changed partial')
 }
 const aborted=await fixture(path.join(directory,'abort'),'abort',Buffer.alloc(700*1024,3)),controller=new AbortController()
 const abortNative=nativeSource(aborted.source,{afterRead:()=>controller.abort(new Error('authorized capture cancelled'))})
 const abortService=new FrameworkArtifacts(abortNative,aborted.files,{},'cwd')
 await rejects('Native cancellation stops the actual capture before publication',()=>abortService.preserve('abort',aborted.input,{...aborted.options,signal:controller.signal}),/capture cancelled/)
 check('Cancelled capture never publishes archive',await aborted.files.fileInfo(aborted.input.destinationPath),undefined)
 check('Cancelled fresh capture ends its own partial',await aborted.files.fileInfo(stageRoot(aborted.task,'abort')+'/original.raw.copying'),undefined)
 const appeared=await fixture(path.join(directory,'appeared'),'appeared',Buffer.from('captured bytes'))
 const noReplace=appeared.files.renameIfAbsent.bind(appeared.files);let injected=false
 appeared.files.renameIfAbsent=async(from,to)=>{if(!injected){injected=true;await appeared.files.replace(to,'appeared user original')}return noReplace(from,to)}
 await rejects('Original appearing at real rename boundary is preserved',()=>appeared.run(),/destination-exists/)
 check('Appeared archive content not replaced',await read(appeared.files,appeared.input.destinationPath),'appeared user original')
 await rejects('Replay never forces over newly appeared content',()=>appeared.run(),/cannot be overwritten/)
 // A failed manifest write resumes the original capture, even after native source disappearance.
 const manifestFail=await fixture(path.join(directory,'manifest-fail'),'manifest-fail',Buffer.from('first captured'))
 const create=manifestFail.files.createIfAbsent.bind(manifestFail.files);let failed=false
 manifestFail.files.createIfAbsent=async(p,c)=>{if(p.startsWith('technical/artifacts/manifests/')&&!failed){failed=true;throw Error('controlled manifest write failure')}return create(p,c)}
 await rejects('Actual manifest failure reports incomplete publication',()=>manifestFail.run(),/manifest write failure/)
 await fs.rm(manifestFail.source);await manifestFail.files.replace(manifestFail.input.destinationPath,'user edited after original publish')
 const manifestResumed=await manifestFail.run()
 check('Pending manifest completion does not recapture or overwrite later user body',Buffer.from((await manifestFail.artifacts.read(manifestResumed.path)).data).toString(),'user edited after original publish')
 check('Original native capture was opened only once',manifestFail.native.calls.resolves,1)
 // Large native original: fixture and actual source callback both use fixed buffers.
 const large=await fixture(path.join(directory,'large'),'large',Buffer.alloc(0)),bytes=256*1024*1024,block=Buffer.alloc(256*1024),digest=createHash('sha256')
 const handle=await originalOpen(large.source,'w');try{for(let n=0;n<bytes/block.length;n++){block.fill(n%251);digest.update(block);await handle.write(block)}}finally{await handle.close()}
 let maxWrite=0,wholeReads=0,maxConcat=0
 const concat=Buffer.concat
 Buffer.concat=function(list,total){const size=total??list.reduce((n,b)=>n+b.byteLength,0);maxConcat=Math.max(maxConcat,size);if(size>2*1024*1024)throw Error('Whole artifact concatenation');return concat(list,total)}
 fs.open=async(...args)=>{const h=await originalOpen(...args);if(String(args[0]).includes('/.artifacts/')&&/original\.raw(?:\.copying)?$/.test(String(args[0]))){h.readFile=async()=>{wholeReads++;throw Error('Whole original read')};const write=h.write.bind(h);h.write=async(buffer,offset,length,position)=>{maxWrite=Math.max(maxWrite,length);return write(buffer,offset,length,position)}}return h}
 let largeResult;const memoryBefore=process.memoryUsage()
 try{largeResult=await large.run()}finally{Buffer.concat=concat;fs.open=originalOpen}
 check('256MiB actual native source imports exact full digest',largeResult.sha256,digest.digest('hex'))
 check('256MiB actual original length preserved',largeResult.bytes,bytes)
 check('Native readByteRange window is bounded at 256KiB',large.native.calls.maxRead,256*1024)
 check('Root stage write window is bounded at 256KiB',maxWrite,256*1024)
 check('Capture never whole-reads original/stage',wholeReads,0)
 check('Capture never concatenates whole original',maxConcat<=2*1024*1024,true)
 const small=await read(large.files,stageRoot(large.task,'execution:save')+'/publication.json')
 check('Large raw bytes are not embedded in tiny phase fact',Buffer.byteLength(small)<2048,true)
 check('Large source content itself remains untouched',(await fs.stat(large.source)).size,bytes)
 // Actual installed role tool and native success-flush hook, with explicit SDK ports.
 const tool=await fixture(path.join(directory,'tool'),'tool',Buffer.from('tool original')),registry=new Map(),events=[],errors=[]
 let callback,dispose,releaseFlush,flushEntered,flushCalls=0
 const flushGate=new Promise(r=>releaseFlush=r),flushEntry=new Promise(r=>flushEntered=r)
 const agent={id:'native-agent',session:{snapshotEvents:()=>events}}
 const ctx={on(_name,cb){callback=cb;return()=>{}},effect(cb){dispose=cb()},systemPrompt:{section(){}},tools:{register:t=>registry.set(t.name,t)},sessions:{async flush(){flushCalls++;flushEntered();await flushGate}}}
 installFrameworkRoleTools(ctx,agent,{role:'Planner',taskId:tool.task.taskId,lifecycleId:tool.task.lifecycleId,owner:'A',member:'A',workId:'planner',executionId:'tool-execution'},
  {files:tool.files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:e=>errors.push(e),transact:async()=>{throw Error('generic')},
   artifacts:{preserve:(_agent,input,_binding,command,options)=>tool.artifacts.preserve(command,input,{...tool.options,...options})}})
 const execute=(name,input,id)=>registry.get(name).execute(input,{agent,callId:id,signal:new AbortController().signal})
 const view2=await execute('dss_snapshot',{},'view'),args={snapshotId:view2.snapshotId,sourcePath:tool.input.sourcePath,destinationPath:tool.input.destinationPath}
 const actual=await execute('dss_preserve_artifact',args,'save')
 check('Registered dss_preserve_artifact executes Physical production branch',await read(tool.files,actual.path),'tool original')
 const call2={type:'tool/call',data:{callId:'save',name:'dss_preserve_artifact',arguments:JSON.stringify(args)}},result2={type:'tool/result',data:{message:{toolCallId:'save',isError:false}}}
 events.push(call2,result2);callback(agent.session,result2);await flushEntry
 check('Retry fact remains while original native result flush is pending',!!await tool.files.fileInfo(stageRoot(tool.task,'tool-execution:save')+'/publication.json'),true)
 releaseFlush();await dispose()
 check('Actual native success hook cleans exact retry fact after flush',await tool.files.fileInfo(stageRoot(tool.task,'tool-execution:save')+'/publication.json'),undefined)
 check('Native result flush uses existing pipeline once',flushCalls,1)
 check('No hook cleanup error',errors,[])
 console.log(JSON.stringify({passed:checks.length,processExitPoints:7,processExitRuns:10,large:{bytes,maxWrite,maxRead:large.native.calls.maxRead,maxConcat,wholeReads,memoryBefore,memoryAfter:process.memoryUsage(),peakSourceArrayBuffers:large.native.calls.peakBuffers},checks,sourceHashes:Object.fromEntries(loaded),limits:['Node24/Linux real Local/native fixture bytes; ctx.fs, SDK registry and Session flush are explicit controlled ports, not native DSH/Windows acceptance.','Portable Node rename has the existing external-process pathname check-to-rename race; no hard-link or new filesystem requirement introduced.','Ordinary download endpoint still returns Uint8Array and therefore allocates the requested response; bounded capture does not claim streaming download.']},null,2))
} finally {fs.open=originalOpen;fs.rename=originalRename;await fs.rm(directory,{recursive:true,force:true});hooks.deregister()}
