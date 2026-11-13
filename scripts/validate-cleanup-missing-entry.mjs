// Current production Conversation -> real Local files -> ManualCleanup. No fault
// injection: the user deletes an indexed entry with ordinary fs.unlink.
// The separate shared-body boundary uses a physical metadata edit; it does not
// claim current send() normally creates shared bodies or prove a new incident.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {FrameworkConversation}=await import('../src/framework/conversation.ts')
const {FrameworkManualCleanup}=await import('../src/framework/manual-cleanup.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dss-cleanup-missing-entry-')),names=[],check=(name,a,b)=>{assert.deepEqual(a,b,name);names.push(name)}
let missingResult
try {
 {
  const files=new PhysicalLocalFiles(path.join(directory,'ordinary'))
  const transactions={run(){throw new Error('Physical cleanup must not use generic transactions')}},conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'c'})
  // No active Foreground: this declared lifecycle port isolates actual file
  // cleanup. It is not a Service/Host reset acceptance test.
  let prepareDuringReset
  const lifecycle={isForegroundResetComplete:async()=>false,withForegroundReset:async(_id,action)=>{await prepareDuringReset?.();return action()},prepareTaskCleanup:async()=>{},taskCleanupComplete:async()=>true}
  const cleanup=new FrameworkManualCleanup(files,transactions,conversation,lifecycle),read=p=>withSnapshot(files,s=>files.read(s,p))
  const send=id=>conversation.send(id,{id,participantId:'u',createdAt:'2026-11-11T12:00:00.000Z',role:'user',recipient:'ai',text:'Actual original '+id})
  try {
   await send('deleted-entry');await send('normal-entry')
   const index=JSON.parse(await read(conversation.indexPath)),missing=index.messages.find(m=>m.id==='deleted-entry'),normal=index.messages.find(m=>m.id==='normal-entry')
   const missingEntry=JSON.parse(await read(missing.path)),normalEntry=JSON.parse(await read(normal.path)),missingBody=await read(missingEntry.textPath)
   await fs.unlink(path.join(files.directory,missing.path))
   check('Ordinary unlink leaves the real entry absent',await read(missing.path),undefined)
   check('Index retains the two actual message references',index.messages.map(m=>m.id),['deleted-entry','normal-entry'])
   let later,laterEntry,laterBody
   prepareDuringReset=async()=>{
    await send('later-message')
    later=JSON.parse(await read(conversation.indexPath)).messages.find(m=>m.id==='later-message')
    laterEntry=JSON.parse(await read(later.path));laterBody=await read(laterEntry.textPath)
   }
   const result=await cleanup.clearConversation('real-clear','clear-foreground-conversation')
   missingResult=result
   check('The original explicit operation completes',result.cleared,true)
   check('Only selected exact index entries retire',JSON.parse(await read(conversation.indexPath)).messages.map(m=>m.id),['later-message'])
   check('Missing metadata is not recreated',await read(missing.path),undefined)
   check('Known selected metadata is removed',await read(normal.path),undefined)
   check('Unknown original body remains byte-for-byte',await read(missingEntry.textPath),missingBody)
   check('Known selected body is deleted',await read(normalEntry.textPath),undefined)
   check('Later message metadata is retained',JSON.parse(await read(later.path)).id,'later-message')
   check('Later original body is not guessed or deleted',await read(laterEntry.textPath),laterBody)
   check('Missing entry paths are reported exactly',result.missingEntries,[missing.path])
   check('No unrelated body is marked preserved',result.preservedPaths,[])
   check('Selected existing wake files retire',await Promise.all([missing,normal].map(m=>read(m.notification))),[undefined,undefined])
   check('Unselected later wake remains',await read(later.notification),'')
   check('No completed temporary plan or intent remains',await withSnapshot(files,s=>files.list(s,'technical/manual-cleanup/')),[])
   check('Later visible message remains readable',(await conversation.page(10)).messages.map(m=>({id:m.id,text:m.text})),[{id:'later-message',text:laterBody}])
  } finally {await files.close()}
 }
 // Captured Foreground outputs are a real narrow selection. A missing captured
 // entry requires its previously indexed assistant role; user entries may not
 // be silently recast as captured assistant output. Known unselected references
 // protect a shared body when they exist at plan construction.
 {
  const files=new PhysicalLocalFiles(path.join(directory,'capture'))
  const transactions={run(){throw new Error('Physical cleanup must not use generic transactions')}}
  const conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'c'})
  const lifecycle={isForegroundResetComplete:async()=>false,withForegroundReset:async(_id,action)=>action(),prepareTaskCleanup:async()=>{},taskCleanupComplete:async()=>true}
  const cleanup=new FrameworkManualCleanup(files,transactions,conversation,lifecycle),read=p=>withSnapshot(files,s=>files.read(s,p))
  const send=(id,role)=>conversation.send(id,{id,participantId:'u',createdAt:'2026-11-11T12:00:00.000Z',role,recipient:role==='user'?'ai':'human',text:'Actual original '+id})
  try {
   await send('assistant', 'assistant');await send('other', 'user')
   const index=JSON.parse(await read(conversation.indexPath)),assistant=index.messages.find(m=>m.id==='assistant'),other=index.messages.find(m=>m.id==='other')
   const assistantEntry=JSON.parse(await read(assistant.path)),otherEntry=JSON.parse(await read(other.path))
   await fs.writeFile(path.join(files.directory,other.path),JSON.stringify({...otherEntry,textPath:assistantEntry.textPath,textHash:assistantEntry.textHash},null,2)+'\n')
   const sharedPlan=await withSnapshot(files,s=>cleanup.physicalConversationPlan(s,['assistant']))
   check('Known unselected reference protects selected body',sharedPlan.preservedPaths,[assistantEntry.textPath])
   check('Shared body is absent from delete targets',sharedPlan.targets.some(t=>t.path===assistantEntry.textPath),false)
   await fs.unlink(path.join(files.directory,assistant.path))
   const capturedMissing=await withSnapshot(files,s=>cleanup.physicalConversationPlan(s,['assistant']))
   check('Captured missing assistant uses original indexed role',capturedMissing.missingEntries,[assistant.path])
   await fs.unlink(path.join(files.directory,other.path))
   await assert.rejects(()=>withSnapshot(files,s=>cleanup.physicalConversationPlan(s,['other'])),/exact owned message references/)
   names.push('Missing user entry cannot pass captured-assistant boundary')
  }finally{await files.close()}
 }
 // Exercise the whole actual React panel with the result just returned by the
 // real file operation; primitives/CSS are presentation stand-ins only.
 const require=createRequire(path.join(process.env.DSS_SDK_HOST_ROOT,'package.json')),React=require('react'),{createRoot}=require('react-dom/client'),{JSDOM}=require('jsdom'),esbuild=require('esbuild'),errors=await import('../src/framework/client-error.ts')
 const built=await esbuild.transform(await fs.readFile(new URL('../src/framework/manual-cleanup-panel.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'})
 const module={exports:{}};new Function('require','module','exports',built.code)(s=>s==='@deepseek-ai/dsh-client-ui-primitives'?{Button:({children,...p})=>React.createElement('button',p,children)}:s.endsWith('.module.css')?{}:s==='./client-error.js'?errors:require(s),module,module.exports)
 const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/'})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})
 const root=createRoot(document.querySelector('#root')),button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent===label)
 try {
  const api={cleanupPreview:async()=>({kind:'conversation',scope:'s',messageIds:[],processGroupIds:[],processSessionIds:[],wakeKeys:[]}),cleanupRecords:async()=>missingResult}
  await React.act(async()=>root.render(React.createElement(module.exports.ManualCleanupPanel,{api,storageScope:'s',tr:(_cn,en)=>en,changed:async()=>{}})))
  await React.act(async()=>button('Clear Foreground conversation').click());await React.act(async()=>button('Confirm cleanup').click())
  const text=document.querySelector('[role="status"]').textContent
  check('UI preserves the completed-operation fact',text.includes('Cleanup finished'),true)
  check('UI states unknown original bodies were not deleted',text.includes('their original body locations are unknown, so unknown bodies were not deleted'),true)
  check('UI lists the exact missing entry path',text.includes(missingResult.missingEntries[0]),true)
  check('Success does not leave the confirmation busy',button('Clear Foreground conversation').disabled,false)
 } finally {await React.act(async()=>root.unmount());dom.window.close()}
 console.log(JSON.stringify({status:'passed',assertions:names.length,tests:names,limits:'Actual current Conversation.send/PhysicalLocalFiles/ManualCleanup with real fs.unlink; real installed parser/SDK imports. Declared no-active-Foreground lifecycle, no full Service/Host/Windows acceptance. Shared-body boundary is an explicit physical metadata edit present before the narrow captured plan, not a claimed normal producer incident. React panel uses the actual returned cleanup result.',evidence:evidence()},null,2))
} finally {await fs.rm(directory,{recursive:true,force:true});hooks.deregister()}
