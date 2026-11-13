import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
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
const { FrameworkConversation, physicalForegroundSignalSources } = await import('../src/framework/conversation.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { preservePhysicalPublishedReferences, readPublishedReference } = await import('../src/framework/published-references.ts')
const { paths } = await import('../src/framework/task-files.ts')
const { taskHistoryChange } = await import('../src/framework/task-history.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const scratch=process.argv[2]==='--crash' ? process.argv[3] : await fs.mkdtemp(path.join(os.tmpdir(),'dss-physical-conversation-'))
const names=[], check=(name,actual,expected)=>{assert.deepEqual(actual,expected);names.push(name)}, rejects=async(name,action,match)=>{await assert.rejects(action,match);names.push(name)}
const transactions={run(){throw new Error('A physical conversation must not execute a SQL/Git transaction or command receipt')}}
// The controlled receiver persists its exact accepted sources before deleting a
// signal, matching the existing Runtime claim order. An arbitrary file deletion
// is not evidence of a delivered notification.
const acceptedSources=new Map(), sourceReads=[]
const observeSources=files=>p=>physicalForegroundSignalSources({get:async key=>{sourceReads.push(key);return {lastWake:{sources:acceptedSources.get(files.directory)??[]}}}},'local-test-scope',p)
const receive=async(files,rows)=>{acceptedSources.set(files.directory,[...(acceptedSources.get(files.directory)??[]),...rows]);for(const row of rows)await files.deleteObserved(row.path,row.version)}
const fixture=async name=>{const files=new PhysicalLocalFiles(path.join(scratch,name));const conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'chat'},observeSources(files));return {files,conversation}}
const message=(id,extras={})=>({id,participantId:'user',createdAt:'2026-11-08T12:13:14.015Z',role:'user',recipient:'ai',text:'原文 😀\n'+id,...extras})
const read=(files,p)=>withSnapshot(files,s=>files.read(s,p))
const index=async c=>JSON.parse(await read(c.files,c.indexPath))
const notices=files=>withSnapshot(files,s=>files.listDirectory(s,'state/',{namePrefix:'Foreground_'}))
if(process.argv[2]==='--crash') {
 const files=new PhysicalLocalFiles(scratch), conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'chat'})
 const phase=process.argv[4], create=files.createIfAbsent.bind(files), replace=files.replace.bind(files), rename=files.rename.bind(files)
 files.createIfAbsent=async(p,v)=>{const result=await create(p,v);if(phase==='entry'&&p.endsWith('/entry.json'))process.exit(86);return result}
 files.replace=async(p,v)=>{await replace(p,v);if(phase==='context'&&p===conversation.contextPath||phase==='visible'&&p===conversation.indexPath&&JSON.parse(v).publication?.visible)process.exit(86)}
 files.rename=async(...args)=>{const result=await rename(...args);if(phase==='signal')process.exit(86);return result}
 await conversation.send('original-native-call',message('process'))
 throw new Error('The requested process exit boundary was not reached')
}
try {
 const {files,conversation:c}=await fixture('ports')
 const long='多语言😀\n'.repeat(20000), first=message('first',{text:long,source:'desktop',device:'host',model:'original-model'})
 await c.send('send-first',first)
 let state=await index(c), entry=JSON.parse(await read(files,state.messages[0].path))
 check('Body is a complete ordinary dated UTF-8 text file',await fs.readFile(path.join(files.directory,entry.textPath),'utf8'),long)
 check('No new body chunks or manifest are stored',(await fs.readdir(path.dirname(path.join(files.directory,entry.textPath)))).length,1)
 check('History preserves identity/source/model and complete body',await c.read('first'),{...first,conversationContext:{version:1,position:0}})
 check('No completed publication journal/receipt remains',Object.hasOwn(state,'publication'),false)
 check('Exactly one original Foreground notice is published',(await notices(files)).length,1)
 await c.send('second-command-same-message',first)
 check('Different command with same original ID does not append',(await index(c)).messages.length,1)
 check('Same original ID does not reemit notice',(await notices(files)).length,1)
 await rejects('Changed original cannot silently replace existing identity',()=>c.send('changed', {...first,text:'different'}),/different content/)
 const ai=message('ai',{role:'assistant',participantId:'host',recipient:'human',responsePhase:'final',text:'完整回复',replyTo:'first',model:'m1'})
 await c.send('ai-call',ai,{}, {id:'ai',text:ai.text})
 await c.send('ai-call', {...ai,createdAt:'2026-11-09T00:00:00.000Z',model:'m2'}, {}, {id:'ai',text:ai.text})
 check('Exact AI publication preserves first timestamp/model',[(await c.read('ai')).createdAt,(await c.read('ai')).model],[ai.createdAt,'m1'])
 check('Context keeps original full input and explicit final',(await c.foregroundContext()).rounds,[{messageIds:['first','ai'],finalId:'ai'}])
 check('UI page reads original order',(await c.page(10)).messages.map(x=>x.id),['first','ai'])
 check('UI date page reads the preserved first date',(await c.page(10,undefined,{date:'2026-11-08'})).messages.map(x=>x.id),['first','ai'])
 check('UI older page keeps existing message cursor',(await c.page(1,'ai')).messages.map(x=>x.id),['first'])
 check('UI forward page keeps existing message cursor',(await c.page(10,undefined,{afterId:'first'})).messages.map(x=>x.id),['ai'])
 check('Search reads complete plain originals',(await c.search('完整回复')).matches.map(x=>x.message.id),['ai'])
 check('Text pagination remains explicit and preserves UTF-16 port',(await c.readText('first',65530,25)).text,long.slice(65530,65555))
 for(let i=0;i<8;i++){await c.send('human-'+i,message('human-'+i));await c.send('answer-'+i,message('answer-'+i,{role:'assistant',participantId:'host',recipient:'human',responsePhase:'final'}))}
 await c.send('current',message('current'));await c.send('interim',message('interim',{role:'assistant',participantId:'host',recipient:'human',responsePhase:'interim'}))
 const context=await c.foregroundContext()
 check('Six recent groups are retained by existing context semantics',context.rounds.length,6)
 check('Current input and interim are retained without a new gate',context.current,['current','interim'])
 const group={id:'group-a',turnId:'turn-a',startedAt:'2026-11-08T00:00:00.000Z',closed:true}
 await c.saveProcessGroups('process',[group],'host')
 check('Native process metadata still uses existing page port',(await c.page(30)).processGroups.map(x=>[x.id,x.participantId,x.afterMessageId]),[['group-a','host','interim']])
 const edited='用户直接编辑后的原文 😀'
 await fs.writeFile(path.join(files.directory,entry.textPath),edited)
 check('A normal physical text edit is readable through message', (await c.read('first')).text,edited)
 check('A normal physical text edit is readable through UI page',(await c.page(30)).messages.find(x=>x.id==='first').text,edited)
 check('A normal physical text edit is searchable',(await c.search('直接编辑')).matches.map(x=>x.message.id),['first'])
 check('A normal physical text edit is readable through text',(await c.readText('first')).text,edited)
 await c.send('send-first',first)
 check('Replaying the original send preserves the later file edit',(await c.read('first')).text,edited)
 const currentEntry=JSON.parse(await read(files,(await index(c)).messages.find(x=>x.id==='current').path))
 await fs.writeFile(path.join(files.directory,currentEntry.textPath),'edited current input')
 check('Context reads current original without a hash/version gate',(await c.foregroundContext()).messages.find(x=>x.id==='current').text,'edited current input')
 const currentEntryPath=(await index(c)).messages.find(x=>x.id==='current').path, contextBeforeEdit=await c.foregroundContext()
 await files.replace(currentEntryPath,JSON.stringify({...currentEntry,conversationContext:{version:1,position:99999}}))
 const contextAfterMetadataEdit=await c.foregroundContext()
 check('Local entry provenance edit does not change index-selected groups',[contextAfterMetadataEdit.rounds,contextAfterMetadataEdit.current],[contextBeforeEdit.rounds,contextBeforeEdit.current])
 check('Local edited entry preserves current original body',contextAfterMetadataEdit.messages.find(x=>x.id==='current').text,'edited current input')
 await files.replace(currentEntryPath,JSON.stringify({...currentEntry,id:'a-different-message'}))
 await rejects('Editable provenance never relaxes exact message identity',()=>c.foregroundContext(),/different conversation/)
 await files.replace(currentEntryPath,JSON.stringify({...currentEntry,collaborationId:'another-conversation'}))
 await rejects('Editable provenance never crosses conversation membership',()=>c.foregroundContext(),/different conversation/)
 await files.replace(currentEntryPath,'{not valid JSON')
 await rejects('Unreadable metadata is not silently guessed or discarded',()=>c.foregroundContext(),SyntaxError)
 await files.replace(currentEntryPath,JSON.stringify(currentEntry))
 await c.writeForeground('memory',{list:'重要交代',cache:'随记'})
 check('Independent Foreground records remain original files',await c.readForeground(),{list:'重要交代',cache:'随记'})
 // Interrupt each observed production write/rename, both before and after the
 // actual syscall returns. Resume from the same real index and message identity.
 const empty=await fixture('empty')
 await empty.conversation.send('empty',message('empty',{text:''}))
 check('An empty original is a readable empty physical file',(await empty.conversation.read('empty')).text,'')
 const nativeFile=path.join(scratch,'selected-original.txt');await fs.writeFile(nativeFile,'ordinary selected original')
 const attachment=await empty.conversation.attachments.selectLocal({mode:'local',collaborationId:'chat',selectionId:'selected',path:nativeFile,name:'selected-original.txt',mimeType:'text/plain'})
 await empty.conversation.send('attachment',message('attachment',{text:'',attachments:[attachment]}))
 check('Attachment-only message keeps empty text and original native path',[(await empty.conversation.read('attachment')).text,(await empty.conversation.read('attachment')).attachments[0].path],['',nativeFile])
 await empty.files.close()
 // Confirmed fresh original creation needs no immediate original read-back.
 // The separate index publication still runs its actual recovery checks.
 const known=await fixture('known-created-originals'), knownPaths=new Set(), originalReads=[]
 const knownCreate=known.files.createIfAbsent.bind(known.files), knownRead=known.files.readBytes.bind(known.files), knownIndex=known.conversation.index.bind(known.conversation)
 let collecting=false, bodyCreated=false
 known.files.createIfAbsent=async(p,v)=>{const result=await knownCreate(p,v);if(p.endsWith('/entry.json')||p.endsWith('.txt')){knownPaths.add(p);collecting=true;if(p.endsWith('.txt'))bodyCreated=true}return result}
 known.files.readBytes=async(s,p)=>{if(collecting&&knownPaths.has(p))originalReads.push(p);return knownRead(s,p)}
 known.conversation.index=async(...args)=>{if(bodyCreated)collecting=false;return knownIndex(...args)}
 await known.conversation.send('fresh-known',message('fresh-known'))
 check('Fresh entry and body creation do not re-read their confirmed originals',originalReads,[])
 check('Fresh known originals still publish the exact message',(await known.conversation.read('fresh-known')).text,message('fresh-known').text)
 check('Fresh known originals still publish one notification',(await notices(known.files)).length,1)
 await known.files.close()
 const trace=await fixture('trace'), operations=[]
 for(const method of ['createIfAbsent','replace','rename']){const original=trace.files[method].bind(trace.files);trace.files[method]=async(...args)=>{operations.push([method,args[0]]);return original(...args)}}
 await trace.conversation.send('call',message('interrupt'))
 await trace.files.close()
 for(const [step,[method,target]] of operations.entries())for(const after of [false,true]){
  const f=await fixture('interrupt-'+step+'-'+after), original=f.files[method].bind(f.files);let count=0
  f.files[method]=async(...args)=>{if(args[0]===target&&count++===operations.slice(0,step).filter(x=>x[0]===method&&x[1]===target).length){if(after)await original(...args);throw new Error('controlled publication interruption')}return original(...args)}
  await rejects('Interruption '+step+' '+(after?'after':'before')+' is visible',()=>f.conversation.send('call',message('interrupt')),/controlled publication interruption/)
  f.files[method]=original
  const seen=await notices(f.files)
  await receive(f.files,seen)
  await f.files.close()
  const reopened=new PhysicalLocalFiles(f.files.directory), resumed=new FrameworkConversation(reopened,transactions,{mode:'local',collaborationId:'chat'},observeSources(reopened))
  await resumed.resumePhysicalPublication()
  await resumed.send('call',message('interrupt'))
  check('Interruption '+step+' '+after+' exposes exactly one original',(await resumed.page(10)).messages.map(x=>x.id),['interrupt'])
  check('Interruption '+step+' '+after+' retains context exactly once',(await resumed.foregroundContext()).current,['interrupt'])
  check('Interruption '+step+' '+after+' removes only pending handoff',Object.hasOwn(await index(resumed),'publication'),false)
  check('Interruption '+step+' '+after+' never reemits consumed notice',(await notices(reopened)).length,seen.length?0:1)
  await reopened.close()
 }
 // Real subprocess exit drops every in-memory map and callback, not merely
 // the FilesStore handle. Parent reopens exactly the child-produced files.
 for(const phase of ['entry','context','visible','signal']) {
  const directory=path.join(scratch,'process-exit-'+phase)
  const outcome=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--crash',directory,phase],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.once('error',reject);child.once('close',code=>resolve({code,output}))})
  check('Actual process exits after durable '+phase,outcome.code,86)
  const files=new PhysicalLocalFiles(directory), conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'chat'},observeSources(files))
  const seen=await notices(files)
  await receive(files,seen)
  await conversation.resumePhysicalPublication();await conversation.send('original-native-call',message('process'))
  check('Process restart '+phase+' exposes one original',(await conversation.page(10)).messages.map(x=>x.id),['process'])
  check('Process restart '+phase+' retains context once',(await conversation.foregroundContext()).current,['process'])
  check('Process restart '+phase+' does not reemit a consumed signal',(await notices(files)).length,seen.length?0:1)
  await files.close()
 }
 // Missing prepared bytes are not a completed or consumed notification.
 for(const changedTarget of [false,true]){
  const f=await fixture('lost-signal-'+changedTarget), rename=f.files.rename.bind(f.files)
  f.files.rename=async()=>{throw new Error('before actual signal rename')}
  await rejects('Interrupted notification retains original publication',()=>f.conversation.send('lost',message('lost')),/before actual signal rename/)
  f.files.rename=rename
  const pending=(await index(f.conversation)).publication
  await fs.rm(path.join(f.files.directory,pending.notification.stage))
  if(changedTarget)await f.files.replace(pending.notification.path,'')
  await rejects('Missing stage '+changedTarget+' cannot claim unrelated target or absence as success',()=>f.conversation.resumePhysicalPublication(),/result is not confirmed/)
  check('Unknown original notification keeps exact pending responsibility '+changedTarget,(await index(f.conversation)).publication.commandId,pending.commandId)
  check('Unknown notification preserves original text '+changedTarget,(await f.conversation.read('lost')).text,message('lost').text)
  await f.files.close()
 }
 check('Consumed notification recovery reads only the existing Foreground role key', [...new Set(sourceReads)], ['framework-runtime/'+createHash('sha256').update('local-test-scope').digest('hex')+'/roles/'+createHash('sha256').update(JSON.stringify(['Foreground',null,null,null])).digest('hex')])
 // A changed Host timestamp after entry/body preparation still resumes the
 // first original, even when no index publication had yet become durable.
 const changed=await fixture('changed-time'), originalReplace=changed.files.replace.bind(changed.files)
 changed.files.replace=async(p,v)=>{if(p===changed.conversation.indexPath)throw new Error('before index');return originalReplace(p,v)}
 await rejects('Original AI body may exist before shared index',()=>changed.conversation.send('same-native-call',ai,{}, {id:'ai'}),/before index/)
 changed.files.replace=originalReplace
 await changed.conversation.send('same-native-call',{...ai,createdAt:'2026-11-10T00:00:00.000Z',model:'m2'},{},{id:'ai'})
 check('Interrupted first metadata fixes original date and model',[(await changed.conversation.read('ai')).createdAt,(await changed.conversation.read('ai')).model],[ai.createdAt,'m1'])
 // Actual shared-index wait must not hold unrelated body or another chat.
 const held=await fixture('independent'), real=held.files.replace.bind(held.files)
 let enter,release;const entered=new Promise(r=>{enter=r}),gate=new Promise(r=>{release=r});let firstIndex=true
 held.files.replace=async(p,v)=>{if(p===held.conversation.indexPath&&firstIndex){firstIndex=false;enter();await gate}return real(p,v)}
 const firstSend=held.conversation.send('one',message('one'));await entered
 const secondSend=held.conversation.send('two',message('two'))
 const secondEntry='conversations/local/chat/messages/message-'+createHash('sha256').update('two').digest('hex')+'/entry.json'
 for(let i=0;i<100&&!await read(held.files,secondEntry);i++)await new Promise(r=>setTimeout(r,2))
 const prepared=JSON.parse(await read(held.files,secondEntry))
 for(let i=0;i<100&&!await read(held.files,prepared.textPath);i++)await new Promise(r=>setTimeout(r,2))
 check('An independent body proceeds while shared index is occupied',await read(held.files,prepared.textPath),message('two').text)
 const other=new FrameworkConversation(held.files,transactions,{mode:'local',collaborationId:'other'})
 await other.send('other',message('other'));check('Another chat does not wait on occupied index',(await other.page(10)).messages.map(x=>x.id),['other'])
 release();await Promise.all([firstSend,secondSend]);check('Concurrent shared publication merges original order',(await held.conversation.page(10)).messages.map(x=>x.id),['one','two'])
 check('Independent same-millisecond chat messages never overwrite notices',(await notices(held.files)).length,3)
 // Referenced task material is preserved by its actual publication record,
 // including interruption after copy and task source removal before retry.
 const refs=await fixture('references'), task={taskId:'task-a',route:'P',owner:'user',sourcePath:'tasks/a_P.md',archiveFolder:'task-a',createdAt:'2026-11-08T00:00:00.000Z',status:'complete'}
 await refs.files.replace(paths.task(task.taskId),JSON.stringify(task));const source='task-runs/task-a/output.txt';await refs.files.replace(source,'actual result')
 const realRefReplace=refs.files.replace.bind(refs.files);let failFinal=true
 refs.files.replace=async(p,v)=>{if(p.includes('/published-links/')&&failFinal&&!JSON.parse(v).pending){failFinal=false;throw new Error('after reference copy')}return realRefReplace(p,v)}
 await rejects('Published task reference copy interruption is visible',()=>withSnapshot(refs.files,s=>preservePhysicalPublishedReferences(refs.files,s,'[result]('+source+')')),/after reference copy/)
 refs.files.replace=realRefReplace;await refs.files.delete(source)
 const archived=taskHistoryChange(task);await refs.files.replace(archived.path,archived.content);await refs.files.delete(paths.task(task.taskId))
 await withSnapshot(refs.files,s=>preservePhysicalPublishedReferences(refs.files,s,'[result]('+source+')'))
 check('Reference continuation survives source and runtime Task cleanup',Buffer.from(await withSnapshot(refs.files,s=>readPublishedReference(refs.files,s,task.taskId,source))).toString(),'actual result')
 const retainedIndex=JSON.parse(await read(refs.files,paths.archive(task)+'/published-links/'+createHash('sha256').update(source).digest('hex')+'.json'))
 await refs.files.replace(retainedIndex.target,'later user edit to retained original')
 check('Physical published reference reads later ordinary edits',Buffer.from(await withSnapshot(refs.files,s=>readPublishedReference(refs.files,s,task.taskId,source))).toString(),'later user edit to retained original')
 await refs.files.replace(source,'actual result')
 await withSnapshot(refs.files,s=>preservePhysicalPublishedReferences(refs.files,s,'[result]('+source+')'))
 check('Repeated physical reference preservation does not overwrite user edits',await read(refs.files,retainedIndex.target),'later user edit to retained original')
 // Actual explicit conversation clearing owns only its captured originals.
 // The lifecycle stub represents the existing native Foreground reset boundary.
 const cleanup=await fixture('cleanup'), clears=[]
 const lifecycleFor=files=>{
  // Controlled native lifecycle port persists its own complete reset, just as
  // FrameworkRoleRuntime does. The cleanup cannot use this to store a second receipt.
  const reset=id=>path.join(scratch,'native-reset-fixture',createHash('sha256').update(files.directory+'\0'+id).digest('hex')+'.json')
  return {isForegroundResetComplete:async id=>fs.readFile(reset(id),'utf8').then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error}),
    withForegroundReset:async(id,action)=>{clears.push(id);const value=await action();await fs.mkdir(path.dirname(reset(id)),{recursive:true});await fs.writeFile(reset(id),'complete');return value},prepareTaskCleanup:async()=>{},taskCleanupComplete:async()=>true}
 }
 const lifecycle=lifecycleFor(cleanup.files)
 const cleaner=new FrameworkManualCleanup(cleanup.files,transactions,cleanup.conversation,lifecycle)
 await cleanup.conversation.send('old',message('old'))
 await cleanup.conversation.writeForeground('keep-memory',{list:'retain list',cache:'retain cache'})
 await cleanup.files.replace('state/Foreground_Task_finished','')
 const oldIndex=await index(cleanup.conversation), oldEntry=JSON.parse(await read(cleanup.files,oldIndex.messages[0].path))
 const oldBody=oldEntry.textPath
 const cleanupDelete=cleanup.files.delete.bind(cleanup.files);let failDelete=true
 cleanup.files.delete=async p=>{if(p===oldBody&&failDelete){failDelete=false;throw new Error('partial conversation clear')}return cleanupDelete(p)}
 await rejects('Explicit clear reports interrupted exact file deletion',()=>cleaner.clearConversation('clear-one','clear-foreground-conversation'),/partial conversation clear/)
 check('Partial clear removes visible references before body files',(await cleanup.conversation.page(10)).messages,[])
 await cleanup.conversation.send('later',message('later'))
 cleanup.files.delete=cleanupDelete
 const result=await cleaner.clearConversation('clear-one','clear-foreground-conversation')
 check('Clear retry retains later messages',(await cleanup.conversation.page(10)).messages.map(x=>x.id),['later'])
 check('Clear retry retains later context',(await cleanup.conversation.foregroundContext()).current,['later'])
 check('Clear removes only selected old body',await read(cleanup.files,oldBody),undefined)
 check('Clear removes only selected old entry',await read(cleanup.files,oldIndex.messages[0].path),undefined)
 check('Clear preserves shared message directory',await fs.stat(path.join(cleanup.files.directory,'conversations/local/chat/messages')).then(x=>x.isDirectory()),true)
 check('Clear preserves independent Task Foreground notice',await read(cleanup.files,'state/Foreground_Task_finished'),'')
 check('Clear preserves longterm Foreground records',await cleanup.conversation.readForeground(),{list:'retain list',cache:'retain cache'})
 check('Clear reports actual selected original paths',result.deletedPaths.sort(),[oldBody,oldIndex.messages[0].path].sort())
 await cleaner.clearConversation('clear-one','clear-foreground-conversation')
 check('Completed original clear does not select future input',(await cleanup.conversation.page(10)).messages.map(x=>x.id),['later'])
 // A failed visible publication is settled as this same original before capture.
 const unfinished=await fixture('cleanup-publication'), replaceUnfinished=unfinished.files.replace.bind(unfinished.files)
 let stopVisible=true
 unfinished.files.replace=async(p,v)=>{if(p===unfinished.conversation.indexPath&&JSON.parse(v).publication?.visible&&stopVisible){stopVisible=false;await replaceUnfinished(p,v);throw new Error('after visible index')}return replaceUnfinished(p,v)}
 await rejects('Setup leaves a real unfinished published original',()=>unfinished.conversation.send('pending',message('pending')),/after visible index/)
 unfinished.files.replace=replaceUnfinished
 const pendingCleanup=new FrameworkManualCleanup(unfinished.files,transactions,unfinished.conversation,lifecycleFor(unfinished.files))
 await pendingCleanup.clearConversation('clear-pending','clear-foreground-conversation')
 check('Explicit clear captures the settled original handoff',(await unfinished.conversation.page(10)).messages,[])
 check('Explicit clear cannot leave its old signal to resurrect',(await notices(unfinished.files)).length,0)
 await unfinished.conversation.resumePhysicalPublication()
 check('A later startup does not resurrect cleared pending publication',(await unfinished.conversation.page(10)).messages,[])
 const clearTrace=await fixture('clear-trace');await clearTrace.conversation.send('old',message('old'))
 const clearOperations=[]
 for(const method of ['replace','update','delete','deleteObserved']){const original=clearTrace.files[method].bind(clearTrace.files);clearTrace.files[method]=async(...args)=>{clearOperations.push([method,args[0]]);return original(...args)}}
 await new FrameworkManualCleanup(clearTrace.files,transactions,clearTrace.conversation,lifecycleFor(clearTrace.files)).clearConversation('clear','clear-foreground-conversation')
 await clearTrace.files.close()
 for(const [step,[method,target]] of clearOperations.entries())for(const after of [false,true]){
  const f=await fixture('clear-interrupt-'+step+'-'+after);await f.conversation.send('old',message('old'))
  const original=f.files[method].bind(f.files);let count=0
  f.files[method]=async(...args)=>{if(args[0]===target&&count++===clearOperations.slice(0,step).filter(x=>x[0]===method&&x[1]===target).length){if(after)await original(...args);throw new Error('controlled clear interruption')}return original(...args)}
  const cleaning=new FrameworkManualCleanup(f.files,transactions,f.conversation,lifecycleFor(f.files))
  await rejects('Clear boundary '+step+' '+after+' reports interruption',()=>cleaning.clearConversation('clear','clear-foreground-conversation'),/controlled clear interruption/)
  f.files[method]=original
  // Before the first selection is durably accepted no deletion has started.
  const intents=await withSnapshot(f.files,s=>f.files.listDirectory(s,'technical/manual-cleanup/intents/'))
  const accepted=intents.length>0||await lifecycleFor(f.files).isForegroundResetComplete('clear')
  if(accepted)await f.conversation.send('later',message('later'))
  else check('Unaccepted clear has not removed originals',(await f.conversation.page(10)).messages.map(x=>x.id),['old'])
  await f.files.close()
  const reopened=new PhysicalLocalFiles(f.files.directory), resumed=new FrameworkConversation(reopened,transactions,{mode:'local',collaborationId:'chat'},observeSources(reopened))
  const resumedCleanup=new FrameworkManualCleanup(reopened,transactions,resumed,lifecycleFor(reopened))
  await resumedCleanup.clearConversation('clear','clear-foreground-conversation')
  check('Clear boundary '+step+' '+after+' keeps only later originals',(await resumed.page(10)).messages.map(x=>x.id),accepted?['later']:[])
  check('Clear boundary '+step+' '+after+' keeps only later context',(await resumed.foregroundContext()).current,accepted?['later']:[])
  const visible=await notices(reopened)
  check('Clear boundary '+step+' '+after+' keeps only later message notice',visible.length,accepted?1:0)
  await reopened.close()
 }
 const capture=await fixture('native-clear-capture');await capture.conversation.send('before',message('before'))
 const captureLifecycle={...lifecycleFor(capture.files),withForegroundReset:async(_id,action)=>{
  await capture.conversation.send('native-final',message('native-final',{role:'assistant',participantId:'host',recipient:'human',responsePhase:'final'}))
  await capture.conversation.saveProcessGroups('closed-process',[{...group,id:'captured-process'}],'host')
  return action(['native-final'],['captured-process'])
 }}
 await new FrameworkManualCleanup(capture.files,transactions,capture.conversation,captureLifecycle).clearConversation('clear-capture','clear-foreground-conversation')
 check('Clear includes exact native final captured by existing reset',(await capture.conversation.page(10)).messages,[])
 check('Clear includes exact closed process metadata captured by reset',(await capture.conversation.page(10)).processGroups,[])
 await capture.files.close()
 await cleanup.files.close();await unfinished.files.close()
 for(const f of [files,changed.files,held.files,refs.files])await f.close()
 console.log(JSON.stringify({status:'passed',assertions:names.length,names,limits:'Actual Linux files; controlled parser and unrelated role port; no native UI/Windows/full typecheck/production cutover',sourceHashes:Object.fromEntries(loaded)},null,2))
} finally {hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
