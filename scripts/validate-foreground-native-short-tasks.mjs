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
const {PhysicalLocalFiles,PhysicalLocalPublicationRequiredError}=await import('../src/framework/physical-local-files.ts')
const {installFrameworkRoleTools,parseDirectSignal,workerPaths}=await import('../src/framework/role-tools.ts')
const {foregroundCorePrompt,foregroundShortTaskInstruction,foregroundTaskRouteInstruction,foregroundGuidePath}=await import('../src/framework/foreground-prompt.ts')
const {foregroundFullGuide,frameworkRolePrompt}=await import('../src/framework/role-prompts.ts')
const {upgradeForegroundGuide}=await import('../src/framework/foreground-guide-upgrade.ts')
const {initializeRoleGuides}=await import('../src/framework/role-guides.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {paths}=await import('../src/framework/task-files.ts')
const {GitFiles,withSnapshot}=await import('../src/framework/transactions.ts')
const {SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {Repository,put,head}=await import('./test-support/controlled-git/repository.mjs')
const runtime=readFileSync(new URL('../src/framework/role-runtime.ts',import.meta.url),'utf8')
loaded.set('framework/role-runtime.ts',createHash('sha256').update(runtime).digest('hex'))
const at=runtime.indexOf('  private binding('),end=runtime.indexOf('\n  private ',at+1)
const Binding=new Function('parseDirectSignal','paths','workerPaths',stripTypeScriptTypes('class Runtime { '+runtime.slice(at,end)+' }',{mode:'transform'})+';return Runtime')(parseDirectSignal,paths,workerPaths)
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-foreground-native-'))
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const read=(files,p)=>withSnapshot(files,s=>files.read(s,p))
function role(files,binding,transactions){
 const tools=new Map([['native_tool',{execute:()=>42}]]),sections=[],agent={id:'agent-'+binding.role,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section:s=>sections.push(s)},tools:{register:t=>tools.set(t.name,t)}}
 let ended=0
 installFrameworkRoleTools(ctx,agent,binding,{files,transact:(...a)=>transactions.run(...a).then(()=>{}),notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:e=>{throw e}})
 return {tools,sections,get ended(){return ended},call:(name,input)=>tools.get(name).execute(input,{agent,callId:name,signal:new AbortController().signal,concludeTurn(){ended++}})}
}
try{
 const files=new PhysicalLocalFiles(scratch),memory=new Map(),storage={get:async k=>memory.get(k),set:async(k,v)=>memory.set(k,v)},transactions=new FrameworkTransactions(files,storage,'native-short')
 const current=foregroundFullGuide(),old='Use dss_submit_direct for an explicitly selected short Planner/Worker task, providing a new stable item identity, target member, original requirement, result location and recipient signal. It writes the input and existing direct notification together without creating a full Task tree.'
 for(const guide of [current,foregroundCorePrompt,frameworkRolePrompt('Foreground')]){check(guide.includes(foregroundShortTaskInstruction),true);check(guide.includes('Use dss_submit_direct'),false)}
 check(foregroundCorePrompt.includes('Ordinary short tasks that you can complete directly with native tools do not require loading this guide.'),true)
 check(foregroundCorePrompt.includes('before handling task decisions/submission, P/O routing, direct tasks'),false)
 const previous=current.replace(foregroundShortTaskInstruction,old)
 check(upgradeForegroundGuide(previous).text.trimEnd(),current.trimEnd())
 check(upgradeForegroundGuide(current).changedRules,0)
 const custom='\uFEFF'+previous.replace(/\n/g,'\r\n')+'\r\n用户原文 不动\r\n'
 const changed=upgradeForegroundGuide(custom);check(changed.text.startsWith('\uFEFF'),true);check(changed.text.endsWith('\r\n用户原文 不动\r\n'),true);check(changed.text.includes(foregroundShortTaskInstruction),true)
 check(upgradeForegroundGuide('我的完整自定义指南').text,'我的完整自定义指南')
 const fenced=current+'\n```\n'+old+'\n```\n';check(upgradeForegroundGuide(fenced).text,fenced)
 check((await initializeRoleGuides(files,transactions)).status,'created');check(await read(files,foregroundGuidePath),current)
 await files.replace(foregroundGuidePath,custom);check((await initializeRoleGuides(files,transactions)).status,'migrated');check(await withSnapshot(files,async s=>Buffer.from(await files.readBytes(s,foregroundGuidePath)).toString('utf8')),changed.text)
 await files.replace(foregroundGuidePath,'用户指南');check((await initializeRoleGuides(files,transactions)).status,'unchanged');check(await read(files,foregroundGuidePath),'用户指南')
 const fg=role(files,{role:'Foreground',owner:'A',workId:'foreground',executionId:'foreground'},transactions)
 check(fg.tools.has('dss_submit_direct'),false);check(fg.tools.has('dss_submit_task'),true);check(fg.tools.has('dss_supplement_task'),true);check(fg.tools.get('native_tool').execute(),42)
 check(fg.sections.find(s=>s.name==='deepseek-servant:framework-role').text,foregroundCorePrompt)
 // Retained Direct work still receives its original P/W root notification.
 // This compatibility check is not the default new-input path.
 for(const targetRole of ['Planner','Worker']){
  const id='external-'+targetRole,inputPath='direct/'+id+'.md',signal='state/'+targetRole+'_A_Direct_'+id
  await files.replace(inputPath,'Third-party original '+targetRole);await files.replace(signal,'')
  const wakes=[],loop=new FrameworkHostLoop(files,transactions,storage,{member:'A',primary:true,scope:targetRole,instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['A'],{startup:async()=>{},observe:async()=>{},executing:()=>false,wake:async w=>{wakes.push(w);return false},error:e=>{throw e}})
  await Promise.all(await loop.runSignalPoll());const wake=wakes.find(w=>w.sources.some(s=>s.path===signal));check(!!wake,true)
  const rb=new Binding();rb.config={member:'A'};rb.assertOrganizerBusiness=()=>{}
  const binding=rb.binding({identity:{role:targetRole,workId:id,executionId:id}},wake)
  check(binding.direct,{inputPath,signalPath:signal});check(binding.recordPath,'direct/'+id+'/takeover.md')
  const local=role(files,binding,transactions);check(local.tools.has('dss_direct_deliver'),true);check(local.tools.has('dss_submit_direct'),false)
  // Existing Git delivery uses real tool/build/transaction/FilesStore on a
  // controlled remote repository transport; Local was not migrated in this step.
  const repo=new Repository();put(repo,inputPath,'Third-party original '+targetRole);head(repo)
  const git=new GitFiles(repo,new SessionGitOperations()),records=new Map(),gitStorage={get:async k=>records.get(k),set:async(k,v)=>records.set(k,v)}
  const delivery=role(git,binding,new FrameworkTransactions(git,gitStorage,'external-'+targetRole)),view=await delivery.call('dss_snapshot',{})
  await delivery.call('dss_direct_deliver',{snapshotId:view.snapshotId,text:'Actual result '+targetRole,resultPath:'results/'+id+'.md',recipientSignal:'state/Foreground_'+id})
  check(await read(git,'results/'+id+'.md'),'Actual result '+targetRole);check(await read(git,'state/Foreground_'+id),'');check(await read(git,inputPath),'Third-party original '+targetRole);check(delivery.ended,1)
  await files.delete(signal)
 }
 const {verifyForegroundConversationEntry}=await import('./test-support/foreground-conversation-entry.mjs')
 const entry=await verifyForegroundConversationEntry({sourceRoot,loaded,z:zod.z,PhysicalLocalFiles,GitFiles,withSnapshot,FrameworkTransactions,SessionGitOperations,Repository,put,head,FrameworkHostLoop,installFrameworkRoleTools,foregroundCorePrompt,foregroundShortTaskInstruction,foregroundFullGuide,upgradeForegroundGuide})
 assertions+=entry.assertions
 const {verifyForegroundTaskRouting}=await import('./test-support/foreground-task-routing.mjs')
 const routing=await verifyForegroundTaskRouting({PhysicalLocalFiles,GitFiles,withSnapshot,FrameworkTransactions,SessionGitOperations,Repository,head,FrameworkHostLoop,installFrameworkRoleTools,foregroundCorePrompt,foregroundTaskRouteInstruction,foregroundFullGuide,upgradeForegroundGuide,initializeRoleGuides,foregroundGuidePath})
 assertions+=routing.assertions
 await files.close()
 console.log(JSON.stringify({status:'passed',assertions,routingAssertions:routing.assertions,routingOutcomes:routing.outcomes,routingLimits:routing.limits,conversationAssertions:entry.assertions,conversationOutcomes:entry.outcomes,zodVersion:zod.z.core.version,limits:'Actual core/generated guide, exact migration, physical initialization, installed role tools, actual client controller and Service send methods, Local/Git Conversation publication/context, Host discovery/binding and designated Direct delivery. Real Zod. Controlled account/native notification/remote Git seams and Markdown/skills adapters. Does not assert model behavior, live DSH, external client connectivity/authentication, browser UI render, full build/typecheck or Windows.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
