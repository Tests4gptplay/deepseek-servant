import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'

// Used by the existing foreground/native short-task project regression.
// Real source methods, FilesStores and Host polling; controlled account/native
// notification/remote transport seams. The parent supplies the real Zod module.
export async function verifyForegroundConversationEntry({ sourceRoot, loaded, z,
 PhysicalLocalFiles, GitFiles, withSnapshot, FrameworkTransactions, SessionGitOperations,
 Repository, put, head, FrameworkHostLoop, installFrameworkRoleTools,
 foregroundCorePrompt, foregroundShortTaskInstruction, foregroundFullGuide, upgradeForegroundGuide }) {
const { FrameworkConversation } = await import('../../src/framework/conversation.ts')
const { FrameworkClientController } = await import('../../src/framework/client-contracts.ts')
const { withOperationChannel } = await import('../../src/framework/transactions.ts')

const sourceService = readFileSync(new URL('framework/service.ts',sourceRoot),'utf8')
loaded.set('framework/service.ts',createHash('sha256').update(sourceService).digest('hex'))
const serviceJS = stripTypeScriptTypes(sourceService,{mode:'transform'})
function serviceMethod(name){const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(serviceJS);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(serviceJS.slice(start+m[0].length));assert(next,name);return serviceJS.slice(start,start+m[0].length+next.index)}
const Service = new Function('z','withOperationChannel','validateConversationAttachment','return class {\n'+['send','sendStored'].map(serviceMethod).join('\n')+'\n}')(z,withOperationChannel,()=>{throw Error('Attachments outside this test')})
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-external-conversation-'))
let count=0;const outcomes=[],check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);count++;outcomes.push(name)}
try {
 // These are the fields the production UI currently sends. No new source flag,
 // UI label, external author or third-party integration is invented here.
 for(const mode of ['local','git'])for(const recipient of ['ai','human']){
  const key=mode+'-'+recipient,repo=mode==='git'?new Repository():undefined;if(repo)head(repo)
  const files=repo?new GitFiles(repo,new SessionGitOperations()):new PhysicalLocalFiles(path.join(scratch,key)),values=new Map(),storage={get:async k=>values.get(k),set:async(k,v)=>values.set(k,v)},transactions=new FrameworkTransactions(files,storage,key),conversation=new FrameworkConversation(files,transactions,{mode,collaborationId:'shared-a'})
  const service=Object.assign(new Service(),{modeSending:new Map(),conversationBarriers:new Map(),initializing:Promise.resolve(),assertOpen(){},checkScope(){},config:()=>({settings:{collaborationId:'shared-a',userName:'B'}}),access:async()=>({conversation,connection:{files,scope:'shared-a',prepareWrite:async()=>{},identity:{login:'B'},...(mode==='git'?{repository:{identity:{id:'account-b',login:'B'}}}:{})}}),prepareConversationWrite:async()=>{},changed(){}})
  const input={mode,collaborationId:'shared-a',id:key,createdAt:'2026-11-09T00:00:00.000Z',text:'Complete original input',recipient,device:'controlled-dsh-client',timezoneOffsetMinutes:0},sent=[],controller=new FrameworkClientController({send:async value=>{sent.push(value);return service.send(value)}})
  await controller.send(input);const message=await conversation.read(key)
  check(key+': actual client forwards current contract unchanged',sent[0],input)
  check(key+': actual client retains the original draft',controller.snapshot().drafts[0].input,input)
  await controller.send(input);check(key+': sent draft is not dispatched twice',sent.length,1)
  check(key+': full original text and device preserved',[message.text,message.device],[input.text,input.device])
  check(key+': selected Host or Git account identity',message.participantId,mode==='git'?'account-b':'B')
  check(key+': existing input role',message.role,'user')
  check(key+': intent controls default context',(await conversation.foregroundContext()).messages.map(x=>x.id),recipient==='ai'?[key]:[])
  const signals=await withSnapshot(files,s=>files.listDirectory(s,'state/'))
  check(key+': intent controls existing Foreground signal',signals.map(x=>x.path.startsWith('state/Foreground_')),recipient==='ai'?[true]:[])
  await service.send(input);check(key+': unchanged send retry keeps one original',(await conversation.page(20,undefined,{date:input.createdAt.slice(0,10)})).messages.length,1)
  for(const primary of [true,false])for(const active of [true,false]){
   const wakes=[],notices=[],host=new FrameworkHostLoop(files,transactions,storage,{member:primary?'A':'B',primary,scope:key+'-'+primary+'-'+active,instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['A','B'],{startup:async()=>{},observe:async()=>{},executing:role=>active&&role==='Foreground',wake:async q=>{wakes.push(q);return false},notifyForeground:async sources=>{notices.push(sources)},error:e=>{throw e}})
   await Promise.all(await host.runSignalPoll())
   check(key+': primary='+primary+' active='+active+' existing wake',wakes.map(x=>x.role),recipient==='ai'&&primary&&!active?['Foreground']:[])
   check(key+': primary='+primary+' active='+active+' current notice',notices.map(x=>x.length),primary&&active?[signals.length]:[])
  }
  check(key+': current send does not create a Direct input',await withSnapshot(files,s=>files.list(s,'direct/')),[])
  check(key+': current send does not create a Task',await withSnapshot(files,s=>files.list(s,'tasks/')),[])
  await files.close?.()
 }
 {
  const old="Complete short user tasks yourself in this Foreground execution using the available native tools, within the user's permissions. Publish the result through dss_conversation_send. Do not dispatch a short task to Planner or Worker merely to operate local tools, and do not create a Task tree, Host/runner dependency or background handoff for work you can complete directly. Judge the actual work and user request without a word-count or time threshold. Use the existing P/O task flow when the work calls for it or the user requests that delegation. Authorized third parties can still submit directly to Planner or Worker through their existing input and signal protocol; that independent receiving and delivery route remains available.",current=foregroundFullGuide(),previous=current.replace(foregroundShortTaskInstruction,old)
  check('Current core routes new third-party inputs through shared Conversation',foregroundCorePrompt.includes('Third-party inputs, including AI submissions, enter the shared Conversation'),true)
  check('Current core does not authorize the old direct-submission default',foregroundCorePrompt.includes('Authorized third parties can still submit directly to Planner or Worker'),false)
  check('Core and full guide share the same short-task instruction',foregroundCorePrompt.includes(foregroundShortTaskInstruction)&&current.includes(foregroundShortTaskInstruction),true)
  check('Exact preceding official guide migrates',upgradeForegroundGuide(previous).text,current)
  const custom='\uFEFF'+previous.replace(/\n/g,'\r\n')+'\r\n用户自定义原文\r\n'
  check('Guide migration preserves custom bytes and separators',upgradeForegroundGuide(custom).text,'\uFEFF'+current.replace(/\n/g,'\r\n')+'\r\n用户自定义原文\r\n')
  check('Current guide does not re-migrate',upgradeForegroundGuide(current).changedRules,0)
  check('Whole custom guide is not overwritten',upgradeForegroundGuide('仅用户自定义').text,'仅用户自定义')
 }
 // An existing bound direct delivery can itself produce the next root Direct
 // notification. These are actual installed tools, Local/Git publication and
 // Host discovery; the existing role binding is a controlled accepted-work seam.
 for(const mode of ['local','git'])for(const sourceRole of ['Planner','Worker']){
  const recipientRole=sourceRole==='Planner'?'Worker':'Planner',id='accepted-'+sourceRole,next='next-'+sourceRole,inputPath='direct/'+id+'.md',signalPath='state/'+sourceRole+'_A_Direct_'+id,nextPath='direct/'+next+'.md',nextSignal='state/'+recipientRole+'_A_Direct_'+next
  const repo=mode==='git'?new Repository():undefined;if(repo){put(repo,inputPath,'Retained original');head(repo)}
  const files=repo?new GitFiles(repo,new SessionGitOperations()):new PhysicalLocalFiles(path.join(scratch,'chain-'+mode+'-'+sourceRole)),values=new Map(),storage={get:async k=>values.get(k),set:async(k,v)=>values.set(k,v)},tx=new FrameworkTransactions(files,storage,'chain-'+mode+'-'+sourceRole)
  if(!repo)await files.replace(inputPath,'Retained original')
  const tools=new Map(),agent={id:'accepted-native-'+id,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
  let concluded=0
  installFrameworkRoleTools(ctx,agent,{role:sourceRole,owner:'A',workId:id,executionId:'execution-'+id,direct:{inputPath,signalPath}}, {files,transact:(...a)=>tx.run(...a).then(()=>{}),notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:e=>{throw e}})
  const call=(name,input)=>tools.get(name).execute(input,{agent,callId:name,signal:new AbortController().signal,concludeTurn(){concluded++}}),view=await call('dss_snapshot',{})
  await call('dss_direct_deliver',{snapshotId:view.snapshotId,text:'Designated next original',resultPath:nextPath,recipientSignal:nextSignal})
  check(mode+' '+sourceRole+': actual delivery writes next input',await withSnapshot(files,s=>files.read(s,nextPath)),'Designated next original')
  check(mode+' '+sourceRole+': actual delivery retains original',await withSnapshot(files,s=>files.read(s,inputPath)),'Retained original')
  check(mode+' '+sourceRole+': actual delivery emits exact selected Direct',await withSnapshot(files,s=>files.read(s,nextSignal)),'')
  check(mode+' '+sourceRole+': actual delivery concludes turn',concluded,1)
  const wakes=[],host=new FrameworkHostLoop(files,tx,storage,{member:'A',primary:true,scope:'chain-'+mode+'-'+sourceRole,instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['A'],{startup:async()=>{},observe:async()=>{},executing:()=>false,wake:async q=>{wakes.push(q);return false},error:e=>{throw e}})
  await Promise.all(await host.runSignalPoll())
  check(mode+' '+sourceRole+': actual Host routes designated recipient',wakes.map(w=>({role:w.role,source:w.sources[0].path})),[{role:recipientRole,source:nextSignal}])
  await files.close?.()
 }
 // Current Foreground assistant output cannot stand in for a new external input.
 for(const mode of ['local','git']){
  const repo=mode==='git'?new Repository():undefined;if(repo)head(repo)
  const files=repo?new GitFiles(repo,new SessionGitOperations()):new PhysicalLocalFiles(path.join(scratch,'assistant-'+mode)),values=new Map(),storage={get:async k=>values.get(k),set:async(k,v)=>values.set(k,v)},tx=new FrameworkTransactions(files,storage,'assistant-'+mode),c=new FrameworkConversation(files,tx,{mode,collaborationId:'shared-a'})
  await c.send('external-ai-attempt',{id:'agent-output',participantId:'external-agent',createdAt:'2026-11-09T00:00:00.000Z',role:'assistant',recipient:'ai',responsePhase:'interim',text:'AI output as new input'})
  check(mode+': assistant recipient ai is not new Foreground wake',(await withSnapshot(files,s=>files.listDirectory(s,'state/'))).length,0)
  check(mode+': assistant output alone is not a current input',(await c.foregroundContext()).messages,[])
  await files.close?.()
 }
 // A Git-only writer can publish the existing complete protocol; no Host RPC
 // is necessary for reading it. This is a controlled protocol compatibility
 // check, not sender authentication or remote network conflict verification.
 {
  const {appendConversationContext,emptyConversationContext}=await import('../../src/framework/conversation-context.ts'),{foregroundNotification}=await import('../../src/framework/conversation.ts')
  const repo=new Repository();head(repo);const files=new GitFiles(repo,new SessionGitOperations()),id='git-only-agent',day='conversations/git/shared-a/2026-11-09.json',index='conversation-context/git/shared-a/index.json',message={id,participantId:'declared-publisher',createdAt:'2026-11-09T00:00:00.000Z',role:'user',recipient:'ai',device:'git-only-client',text:'Original complete Git submission'},context=appendConversationContext(emptyConversationContext(),message,day),signal='state/'+foregroundNotification('publisher',new Date(message.createdAt),0)
  await withSnapshot(files,s=>files.commit(s,[{path:day,content:JSON.stringify({version:1,messages:[{...message,conversationContext:context.provenance}]})},{path:index,content:JSON.stringify(context.index)},{path:signal,content:''}],'Publish controlled complete Conversation protocol'))
  const conversation=new FrameworkConversation(files,{}, {mode:'git',collaborationId:'shared-a'}),selected=await conversation.foregroundContext()
  check('Git-only complete protocol joins default context',selected.messages.map(x=>x.id),[id])
  check('Git-only complete protocol retains the full original',selected.messages[0].text,message.text)
  check('Git-only claimed participant is read verbatim, not authenticated by reader',selected.messages[0].participantId,'declared-publisher')
  check('Git-only body, context and notice use one controlled commit',repo.calls.length,1)
  const wakes=[],storage={get:async()=>undefined,set:async()=>{}},host=new FrameworkHostLoop(files,{},storage,{member:'A',primary:true,scope:'git-only',instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['A'],{startup:async()=>{},observe:async()=>{},executing:()=>false,wake:async q=>{wakes.push(q);return false},error:e=>{throw e}})
  await Promise.all(await host.runSignalPoll())
  check('Git-only complete protocol wakes A Foreground',wakes.map(w=>w.role),['Foreground'])
 }
 // Evaluate the proposed naive external file drop, not production send.
 // Actual reader must not be claimed to discover a body absent from context metadata.
 {
  const repo=new Repository(),day='conversations/git/shared-a/2026-11-09.json',id='raw-external'
  put(repo,day,JSON.stringify({version:1,messages:[{id,participantId:'B',createdAt:'2026-11-09T00:00:00.000Z',role:'user',recipient:'ai',text:'Raw third-party original'}]}));put(repo,'state/Foreground_B-UTC-20261109-000000000','');head(repo)
  const files=new GitFiles(repo,new SessionGitOperations()),conversation=new FrameworkConversation(files,{}, {mode:'git',collaborationId:'shared-a'})
  check('Naive daily body remains explicitly readable',(await conversation.read(id)).text,'Raw third-party original')
  check('Naive daily body absent from default context without publication metadata',(await conversation.foregroundContext()).messages,[])
 }
 return { assertions: count, outcomes }
}finally{await fs.rm(scratch,{recursive:true,force:true})}
}
