import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Real production Artifact tool, capture/publication and original-result retirement.
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
const { retirePhysicalArtifact } = await import('../src/framework/physical-artifact-publication.ts')
const { retirePhysicalPublicationsFromEvents } = await import('../src/framework/physical-publication-retirement.ts')
const { paths, encodeJson } = await import('../src/framework/task-files.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const checks=[],check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name)}
const rejects=async(name,action,re)=>{await assert.rejects(action,re);checks.push(name)}
const originalOpen=fs.open,originalRename=fs.rename
const read=(files,p)=>withSnapshot(files,s=>files.read(s,p))
const readBytes=(files,p)=>withSnapshot(files,s=>files.readBytes(s,p))
const stageRoot=(task,command)=>paths.run(task.taskId)+'/.artifacts/'+hash(command)
// FsInfo / FsTarget follow the actual official dsh-v0.2.1-rc.5 contract:
// review/artifact-boundaries-official records upstream source URLs/blob hashes.
// Opaque string versions have no prescribed syntax; file size may be absent.
function capability(body=Buffer.from([239,187,191,0,255,17]), hooks={}) {
  const target=Object.freeze({targetKey:'remote-capability:uncharted/原件',displayPath:'remote original',
    toString(){throw new Error('Native target must not become a Node path')}})
  const calls={resolve:0,stat:0,read:0,cwds:[],signals:[],maxRead:0}
  return {target,calls,fs:{
    async resolve(_path,options){calls.resolve++;calls.cwds.push(options.cwd);calls.signals.push(options.signal);return target},
    async stat(value,signal){assert.equal(value,target);signal?.throwIfAborted();calls.stat++;
      return hooks.stat ? hooks.stat(calls.stat) : {type:'file',version:'opaque revision α / ? []'}},
    async readByteRange(value,{offset,length},signal){assert.equal(value,target);signal?.throwIfAborted();calls.read++;calls.maxRead=Math.max(calls.maxRead,length);
      await hooks.beforeRead?.(offset,length);return body.subarray(offset,offset+length)},
    processPath(){throw new Error('Native source process path must not be requested')},
  }}
}
async function fixture(directory,name='one',native=capability()) {
  const files=new PhysicalLocalFiles(path.join(directory,'local'))
  const task={version:1,taskId:'00000000-0000-4000-8000-'+hash(name).slice(0,12),route:'P',owner:'A',members:['A'],lifecycleId:'first',status:'running',sourcePath:'tasks/'+name+'_P.md',archiveFolder:name+'_'+'00000000-0000-4000-8000-'+hash(name).slice(0,12)}
  await files.replace(paths.task(task.taskId),encodeJson(task));await files.replace(task.sourcePath,'Task ID: '+task.taskId+'\nOriginal requirement')
  const input={taskId:task.taskId,sourcePath:'remote original',destinationPath:paths.archive(task)+'/original.bin'}
  const options={cwd:'native agent cwd',taskOwner:{taskId:task.taskId,lifecycleId:task.lifecycleId,hostKey:'host'},signal:new AbortController().signal}
  const artifacts=new FrameworkArtifacts(native,files,{run(){throw new Error('Physical artifact used generic transaction')}},'unused fallback')
  return {files,task,input,options,native,artifacts,run(command='exec:first',inputOverride={}){return artifacts.preserve(command,{...input,...inputOverride},options)}}
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const successEvents=(f,id='first')=>[
  {type:'tool/call',data:{callId:id,name:'dss_preserve_artifact',arguments:JSON.stringify({snapshotId:Buffer.from(JSON.stringify({taskId:f.task.taskId})).toString('base64url'),sourcePath:f.input.sourcePath,destinationPath:f.input.destinationPath})}},
  {type:'tool/result',data:{message:{toolCallId:id,isError:false}}},
]
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dss-artifact-boundaries-'))
try {
  const optional=await fixture(path.join(directory,'optional'))
  const first=await optional.run()
  check('Official optional-size FsInfo captures actual remote opaque source',Array.from(await readBytes(optional.files,first.path)),[239,187,191,0,255,17])
  check('Optional size does not become an artifact length guess',first.bytes,6)
  check('Source metadata uses only initial and final official stat calls',optional.native.calls.stat,2)
  check('The actual Agent cwd reaches native resolve',optional.native.calls.cwds,['native agent cwd'])
  check('The original cancellation signal reaches resolve',optional.native.calls.signals,[optional.options.signal])
  check('Artifact source remains a capability, no target-path parsing',optional.native.target.targetKey,'remote-capability:uncharted/原件')
  const empty=await fixture(path.join(directory,'empty'),'empty',capability(Buffer.alloc(0)))
  check('Absent optional size accepts zero-byte original',(await empty.run()).bytes,0)
  check('Empty original still executes the authorized byte-read seam',empty.native.calls.read,1)
  for(const [name,stat] of [
    ['version-only',n=>({type:'file',version:n===1?'opaque-first':'opaque-second'})],
    ['same-size-version',n=>({type:'file',version:n===1?'opaque-first':'opaque-second',size:6})],
    ['length-mismatch',()=>({type:'file',version:'opaque',size:7})],
    ['no-longer-file',n=>({type:n===1?'file':'directory',version:'opaque'})],
    ['disappeared',n=>n===1?{type:'file',version:'opaque'}:undefined],
  ]) {
    const f=await fixture(path.join(directory,name),name,capability(undefined,{stat}))
    await rejects('Official metadata change rejected: '+name,()=>f.run(),/changed while being captured/)
    check('No archive published after '+name,await f.files.fileInfo(f.input.destinationPath),undefined)
  }
  const denied=await fixture(path.join(directory,'final-denial'),'final-denial',capability(undefined,{stat:n=>{
    if(n===2)throw Object.assign(new Error('native final stat denied'),{code:'FS_PERMISSION_DENIED'});
    return {type:'file',version:'opaque'}
  }}))
  await rejects('Final native denial is surfaced without path fallback',()=>denied.run(),/native final stat denied/)
  check('Final native denial never publishes bytes',await denied.files.fileInfo(denied.input.destinationPath),undefined)
  // Same Task, two independent commands: one is inside its actual capture loop.
  const f=await fixture(path.join(directory,'same-task'),'same-task')
  const one=await f.run(),entered=deferred(),release=deferred(),heldNative=capability(Buffer.alloc(500000,27),{
    beforeRead:async offset=>{if(!offset){entered.resolve();await release.promise}}
  })
  const heldService=new FrameworkArtifacts(heldNative,f.files,{run(){throw Error('generic transaction')}},'unused')
  const heldPath=paths.archive(f.task)+'/held.bin'
  const held=heldService.preserve('exec:held',{...f.input,destinationPath:heldPath},f.options)
  await entered.promise
  const heldRoot=stageRoot(f.task,'exec:held'),heldFact=await read(f.files,heldRoot+'/publication.json'),heldOwner=await read(f.files,heldRoot+'/original.raw.capture.json')
  await retirePhysicalArtifact(f.files,f.task.taskId,'exec:first')
  check('Successful individual retirement survives actual shared-parent ENOTEMPTY',await f.files.fileInfo(stageRoot(f.task,'exec:first')+'/publication.json'),undefined)
  check('Retirement never removes active sibling publication fact',await read(f.files,heldRoot+'/publication.json'),heldFact)
  check('Retirement never removes active sibling capture ownership',await read(f.files,heldRoot+'/original.raw.capture.json'),heldOwner)
  check('Retirement preserves active sibling raw partial',!!await f.files.fileInfo(heldRoot+'/original.raw.copying'),true)
  check('Retirement leaves successful archived original unchanged',await f.files.fingerprint(one.path),{sha256:one.sha256,bytes:one.bytes})
  await f.files.replace('unrelated.txt','still available')
  check('No Task-wide queue blocks unrelated physical write',await read(f.files,'unrelated.txt'),'still available')
  release.resolve();const two=await held
  check('Independent sibling capture completes original bytes after retirement',two.sha256,hash(Buffer.alloc(500000,27)))
  await retirePhysicalArtifact(f.files,f.task.taskId,'exec:held')
  check('Last retirement removes only now-empty shared parent',existsSync(path.join(f.files.directory,paths.run(f.task.taskId),'/.artifacts')),false)
  // Two retiring finished commands while a third actual publication remains.
  const concurrent=await fixture(path.join(directory,'concurrent'),'concurrent')
  const results=await Promise.all(['a','b','c'].map(id=>concurrent.run('exec:'+id,{destinationPath:paths.archive(concurrent.task)+'/'+id+'.bin'})))
  const third=await read(concurrent.files,stageRoot(concurrent.task,'exec:c')+'/publication.json')
  await Promise.all(['a','b'].map(id=>retirePhysicalArtifact(concurrent.files,concurrent.task.taskId,'exec:'+id)))
  check('Concurrent retirements preserve another command fact byte-for-byte',await read(concurrent.files,stageRoot(concurrent.task,'exec:c')+'/publication.json'),third)
  check('Concurrent retirements do not remove any archived deliverable',await Promise.all(results.map(r=>concurrent.files.fingerprint(r.path))),results.map(r=>({sha256:r.sha256,bytes:r.bytes})))
  await retirePhysicalArtifact(concurrent.files,concurrent.task.taskId,'exec:c')
  check('Concurrent test leaves no completed publication directories',existsSync(path.join(concurrent.files.directory,paths.run(concurrent.task.taskId),'/.artifacts')),false)
  // Native persisted Session events locate each exact publication independently.
  const cold=await fixture(path.join(directory,'cold'),'cold')
  await cold.run();await cold.run('exec:second',{destinationPath:paths.archive(cold.task)+'/second.bin'})
  await retirePhysicalPublicationsFromEvents(cold.files,'exec',successEvents(cold))
  check('Cold successful original event retires first result with second pending',await cold.files.fileInfo(stageRoot(cold.task,'exec:first')+'/publication.json'),undefined)
  check('Cold event retains second result pending its own evidence',!!await cold.files.fileInfo(stageRoot(cold.task,'exec:second')+'/publication.json'),true)
  await retirePhysicalPublicationsFromEvents(cold.files,'exec',successEvents(cold,'second'))
  check('Second cold result retires its own exact command',await cold.files.fileInfo(stageRoot(cold.task,'exec:second')+'/publication.json'),undefined)
  // ENOTEMPTY is tolerated only for the shared parent, not this owned command.
  const foreign=await fixture(path.join(directory,'foreign'),'foreign')
  const kept=await foreign.run(),foreignPath=stageRoot(foreign.task,'exec:first')+'/user-added.txt'
  await foreign.files.replace(foreignPath,'preserve this exact user addition')
  await rejects('Unexpected command-local contents are not silently discarded',()=>retirePhysicalArtifact(foreign.files,foreign.task.taskId,'exec:first'),{code:'ENOTEMPTY'})
  check('Unexpected command-local file survives failed empty-directory cleanup',await read(foreign.files,foreignPath),'preserve this exact user addition')
  check('Command-local cleanup does not change actual deliverable',await foreign.files.fingerprint(kept.path),{sha256:kept.sha256,bytes:kept.bytes})
  for(const code of ['EACCES','EPERM','EBUSY','EIO']) {
    const io=await fixture(path.join(directory,code),code);await io.run();const remove=io.files.removeEmptyDirectory.bind(io.files)
    io.files.removeEmptyDirectory=async p=>{if(p===paths.run(io.task.taskId)+'/.artifacts')throw Object.assign(new Error('actual cleanup failure'),{code});return remove(p)}
    await rejects('Shared-parent '+code+' remains visible',()=>retirePhysicalArtifact(io.files,io.task.taskId,'exec:first'),{code})
  }
  // Use the actual registered tool and original successful Session flush hook.
  const tool=await fixture(path.join(directory,'tool'),'tool'),registry=new Map(),events=[],errors=[]
  let callback,dispose;const flushed=[]
  const agent={id:'native-agent',session:{snapshotEvents:()=>events}}
  const ctx={on(_name,cb){callback=cb;return()=>{}},effect(cb){dispose=cb()},systemPrompt:{section(){}},tools:{register:t=>registry.set(t.name,t)},sessions:{async flush(){flushed.push(events.at(-1)?.data.message.toolCallId)}}}
  installFrameworkRoleTools(ctx,agent,{role:'Planner',taskId:tool.task.taskId,lifecycleId:tool.task.lifecycleId,owner:'A',member:'A',workId:'planner',executionId:'tool-execution'},
    {files:tool.files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:e=>errors.push(e),transact:async()=>{throw Error('generic')},
      artifacts:{preserve:(_agent,input,_binding,command,options)=>tool.artifacts.preserve(command,input,{...tool.options,...options})}})
  const execute=(name,input,id)=>registry.get(name).execute(input,{agent,callId:id,signal:new AbortController().signal})
  const view=await execute('dss_snapshot',{},'view'),args={snapshotId:view.snapshotId,sourcePath:tool.input.sourcePath,destinationPath:tool.input.destinationPath}
  const actual=await execute('dss_preserve_artifact',args,'first')
  const secondArgs={...args,destinationPath:paths.archive(tool.task)+'/second.bin'}
  const secondActual=await execute('dss_preserve_artifact',secondArgs,'second')
  for(const [id,input] of [['first',args],['second',secondArgs]]) {
    const call={type:'tool/call',data:{callId:id,name:'dss_preserve_artifact',arguments:JSON.stringify(input)}},result={type:'tool/result',data:{message:{toolCallId:id,isError:false}}}
    events.push(call,result);callback(agent.session,result)
    // Read the exact expected result path while the original async callback drains.
    // This bounded test wait does not introduce any production retry/monitor.
    for(let n=0;await tool.files.fileInfo(stageRoot(tool.task,'tool-execution:'+id)+'/publication.json');n++) {
      if(n===1000)throw Error('Native retirement callback did not finish');await new Promise(r=>setImmediate(r))
    }
    if(id==='first')check('Actual native first success retains second command result',!!await tool.files.fileInfo(stageRoot(tool.task,'tool-execution:second')+'/publication.json'),true)
  }
  await dispose()
  check('Same-Task original success callbacks do not report false ENOTEMPTY errors',errors,[])
  check('Each original native result uses existing Session flush',flushed,['first','second'])
  check('Registered tool retains both real artifact outputs',await Promise.all([actual,secondActual].map(r=>tool.files.fingerprint(r.path))),[actual,secondActual].map(r=>({sha256:r.sha256,bytes:r.bytes})))
  console.log(JSON.stringify({passed:checks.length,checks,sourceHashes:Object.fromEntries(loaded),limits:[
    'Official DSH contract verified from source at declared release and current upstream, not inferred from fixtures.',
    'Node/Linux real physical publication/retirement with controlled official-shaped ctx.fs/SDK/Session ports; native Windows/DSH acceptance not executed.',
    'No full dependency TypeScript typecheck or build; no userDB, desktop, deploy, Git push or storage-size cap.',
  ]},null,2))
} finally {await fs.rm(directory,{recursive:true,force:true});hooks.deregister()}
