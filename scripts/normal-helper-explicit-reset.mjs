import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openQuestionUi} from './test-support/question-ui.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {AgentRegistry}=await import('@deepseek-ai/dsh-agent'),{SessionStore}=await import('@deepseek-ai/dsh-session'),{SessionProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection')
const {LlmRuntime,LlmAdapter}=await import('@deepseek-ai/dsh-llm'),{ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt'),{AgentLoop}=await import('@deepseek-ai/dsh-agent-loop')
const {LocalJobRegistry}=await import('@deepseek-ai/dsh-jobs-local'),{WorkspaceRegistry}=await import('@deepseek-ai/dsh-workspace'),{LocalFileSystem}=await import('@deepseek-ai/dsh-fs-local'),{WorkingDirectoryService}=await import('@deepseek-ai/dsh-working-directory')
const {UserQuestionService}=await import('@deepseek-ai/dsh-user-questions'),ask=await import('@deepseek-ai/dsh-tool-ask-user'),jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl')
const cleaner=await import('../src/native-cleaner/plugin.mjs'),{FrameworkService}=await import('../src/framework/service.ts')
const phase=process.env.DSS_QUESTION_PHASE;assert(['prepare','resume'].includes(phase));
const role=process.env.DSS_QUESTION_ROLE;assert(['Foreground','Planner','Organizer','Worker','Recorder','Helper'].includes(role))
const root=process.env.DSS_QUESTION_ROOT;assert(root&&path.isAbsolute(root));await fs.mkdir(path.join(root,'workspace'),{recursive:true});await fs.copyFile(new URL(import.meta.url),path.join(root,'executed-'+phase+'.mjs'))
const trace=[],mark=(event,data={})=>{trace.push({event,...data});console.log(event,JSON.stringify(data))}
// Test-only watchdog, never a task deadline. The recovery interval uses the explicit clock offset below; no failure is injected.
async function until(name,fn){const end=Date.now()+60000;while(true){const x=await fn();if(x)return x;if(Date.now()>end)throw Error('Experiment watchdog expired: '+name);await new Promise(r=>setTimeout(r,10))}}
const results=[],lastResults=new Map(),bindings=new Map(),snapshots=new Map();let checkId,helperFinished=false,helperSession,helperSnapshot,helperNote,helperCallCounter=0;const resetMode=process.env.DSS_RESET_MODE;assert(['baseline','explicit','no-reset'].includes(resetMode));const realNow=Date.now;let clockOffset=0;Date.now=()=>realNow()+clockOffset;let agent,ui,service,sdk,jp,notePath,outcome
const question='Which color should the next step use?',beforeText='Question: '+question+' Context: the user requested an actual color decision before the next step. Status: awaiting the user.\n',afterText='Answer to the color question: Green. Conclusion: use Green for the next step; this question is resolved.\n'
class Model extends LlmAdapter {
 stages=new Map()
 async *stream(o){
  const stage=this.stages.get(o.sessionId)??0;this.stages.set(o.sessionId,stage+1)
  const supports=n=>o.tools.some(t=>t.name===n),actualRole=supports('dss_task_restore')?'Foreground':supports('dss_worker_assign')?'Planner':supports('dss_planner_dispatch')?'Organizer':supports('dss_worker_deliver')?'Worker':supports('dss_recorder_save')?'Recorder':supports('dss_restore')?'Helper':'unknown'
  mark('model',{sessionId:o.sessionId,stage,role:actualRole})
  const call=(name,input,id)=>[{type:'tool-call-delta',index:0,name,id,argumentsDelta:JSON.stringify(input)},{type:'finish',reason:'tool-calls'}]
  if(actualRole==='Helper'){
   const hcall=(name,input,id)=>call(name,input,id+'-'+(++helperCallCounter))
   if(stage===0){yield*hcall('dss_claim',{},'helper-claim');return}
   const current=lastResults.get(o.sessionId)
   if(stage===1){
    const check=current?.helperNotifications?.find(n=>n.context?.observation?.kind==='recovery-check')
    if(check){checkId=check.id;helperSession=o.sessionId;helperSnapshot=current.snapshotId;helperNote=current.binding.recordPath;assert(helperNote);const observed=check.context.observation;yield*hcall('dss_read',{snapshotId:helperSnapshot,path:'task-runs/'+observed.taskId+'/'+observed.member+'/Plan_Note.md'},'helper-read-current-note');return}
   }
   if(checkId&&o.sessionId===helperSession){
    if(stage===2){assert(current?.exists&&current.text.includes(beforeText));yield*hcall('dss_record',{snapshotId:helperSnapshot,path:helperNote,text:'Read the actual Planner Note: the user color question remains unresolved and its context is preserved. No fault is established by waiting for this answer. This check is complete.\n',append:true},'helper-check-record');return}
    if(stage===3&&resetMode==='explicit'){yield*hcall('dss_reset_observation',{recoveryCheckId:checkId},'helper-explicit-reset');return}
    if(stage===4&&resetMode==='explicit'){assert.equal(current?.reset,true);yield*hcall('dss_reset_observation',{recoveryCheckId:checkId},'helper-repeat-reset');return}
    if(stage===5&&resetMode==='explicit')assert.equal(current?.reset,false)
    helperFinished=true
   }
   this.stages.set(o.sessionId,0)
   yield{type:'text-delta',index:0,text:'The actual member chain check is recorded.'};yield{type:'finish',reason:'stop'};return
  }
  if(actualRole===role){
   const system=o.messages.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')).join('\n')
   const line=system.split('\n').find(s=>s.startsWith('Current role and source locations: '));assert(line,'Actual injected role binding is visible to model')
   const binding=JSON.parse(line.slice('Current role and source locations: '.length));bindings.set(o.sessionId,binding)
   assert(system.includes('Before asking the user a question, use dss_record'));assert(system.includes("Waiting for the user's answer is normal operation"))
   const locations=binding.sourceLocations,note=locations.planNotePath??locations.organizerNotePath??locations.recorderNotePath??locations.notePath??binding.notePath??binding.recordPath;assert(note)
   if(stage===0){yield*call(actualRole==='Foreground'?'dss_conversation_read':'dss_claim',{},'initial-read');return}
   if(actualRole==='Foreground'&&stage===1){yield*call('dss_conversation_send',{id:'question-interim',text:'I will ask your color preference, then continue with your answer.',intent:'human',responsePhase:'interim',replyTo:'default-question-input'},'interim');return}
   if(actualRole==='Foreground'&&stage===2){yield*call('dss_snapshot',{},'open-note');return}
   const offset=actualRole==='Foreground'?2:0,raw=stage-offset,current=lastResults.get(o.sessionId);let s=raw
   if(phase==='resume'){
    if(raw===1){assert(current?.snapshotId);snapshots.set(o.sessionId,current.snapshotId);notePath=note;yield*call('dss_read',{snapshotId:current.snapshotId,path:note},'read-original-question-note');return}
    if(raw===2){assert(current?.exists&&current.text.includes(beforeText)&&!current.text.includes(afterText),'Original unanswered question is read from the real existing Note');yield*call('dss_record',{snapshotId:snapshots.get(o.sessionId),path:note,text:'Continuation after normal Host close: the original recorded color question remains unresolved; ask it again before the next step.\n',append:true},'record-question-continuation');return}
    s=raw-1
   }
   if(s===1){assert(current?.snapshotId);snapshots.set(o.sessionId,current.snapshotId);notePath=note;yield*call('dss_record',{snapshotId:current.snapshotId,path:note,text:beforeText,append:true},'record-question');return}
   if(s===2){const native=o.tools.find(t=>t.name==='ask_user_question');assert(native);assert(!Object.hasOwn(native.parameters.properties,'timeout'),'Actual default tool has no timeout parameter');yield*call('ask_user_question',{questions:[{id:'choice',question,options:[{label:'Blue'},{label:'Green'}]}]},'choose-color');return}
   if(s===3){assert.deepEqual(current,{answers:[{id:'choice',selected:['Green']}]});yield*call('dss_snapshot',{},'after-answer-view');return}
   if(s===4){assert(current?.snapshotId);yield*call('dss_record',{snapshotId:current.snapshotId,path:note,text:afterText,append:true},'record-answer');return}
   if(s===5&&actualRole==='Foreground'){yield*call('dss_conversation_send',{id:'question-final',text:'You chose Green. I recorded that choice and will use Green for the next step.',intent:'human',responsePhase:'final',replyTo:'default-question-input'},'final');return}
   yield{type:'text-delta',index:0,text:'The actual answer and conclusion are recorded in my corresponding Note.'};yield{type:'finish',reason:'stop'};return
  }
  if(actualRole==='Foreground'){
   if(stage===0){yield*call('dss_conversation_read',{},'read-helper-input');return}
   if(stage===1&&role==='Helper'){yield*call('dss_help',{facts:'Investigate the actual reproduced Planner question-lifetime defect recorded in prior planner-02 evidence. Ask the user the diagnostic presentation color and wait for the answer before continuing.'},'report-real-observation');return}
  }
  if(actualRole==='Planner'){
   if(stage===0){yield*call('dss_claim',{},'planner-claim');return}
   const current=lastResults.get(o.sessionId)
   if(stage===1&&role==='Worker'){assert(current?.snapshotId);yield*call('dss_worker_assign',{snapshotId:current.snapshotId,childId:'color-choice',contract:'Record the color question in your existing Note before asking, wait for the actual user answer, record the answer and conclusion in the same Note.',decision:'The user explicitly requested this Worker color subtask.'},'assign-color');return}
   if(stage===1&&role==='Recorder'){yield*call('dss_snapshot',{},'pre-complete-snapshot');return}
   if(stage===2&&role==='Recorder'){assert(current?.snapshotId);yield*call('dss_complete',{snapshotId:current.snapshotId,acceptance:'Completed the explicitly requested finite no-file check; Recorder still owns its archive and requested color decision.',resultPaths:[]},'complete-finite-task');return}
  }
  yield{type:'text-delta',index:0,text:'No additional work in this turn.'};yield{type:'finish',reason:'stop'}
 }
}
try{
 sdk=await openDshStorageFixture(path.join(root,'storage'),path.join(root,'locator'))
 new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{});new UserQuestionService(sdk.ctx)
 ask.apply(sdk.ctx) // Actual package default: no opt-in timed mode or timeout configured.
 jp=sdk.ctx.plugin(jsonl,{root:path.join(root,'sessions'),compression:'none'});await jp.await()
 new LocalFileSystem(sdk.ctx,{cwd:path.join(root,'workspace'),diffBasisMaxBytes:1048576});new WorkingDirectoryService(sdk.ctx,{defaultDirectory:path.join(root,'workspace')})
 const wp=sdk.ctx.plugin(WorkspaceRegistry);await wp.await();const lp=sdk.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10});await lp.await()
 await cleaner.apply(sdk.ctx,{}, {onFailure(e,stage){throw Error(stage,{cause:e})}})
 sdk.ctx.llm.registerAdapter(['question-evidence'],new Model())
 sdk.ctx.on('user-questions/request',async(request,next)=>{agent=request.agent;mark('question-request',{agentId:agent.id});ui=await openQuestionUi(sdk.ctx,agent,service,mark);return ui.answerRequest(request,next)})
 sdk.ctx.on('session/event',(session,event)=>{if(['tool/call','tool/result','turn/close'].includes(event.type)){mark(event.type,{sessionId:session.header.id,data:event.data});if(event.type==='tool/result'){results.push(event.data.message);for(const c of event.data.message.content??[])if(c.type==='text'){try{lastResults.set(session.header.id,JSON.parse(c.text))}catch{}}}}})
 service=new FrameworkService(sdk.ctx,sdk.adapter,{name:'Question evidence',userName:'Evidence',localDirectory:path.join(root,'business'),ownerRepo:'',repositoryDirectory:path.join(root,'unused-git'),collaborationId:'native-question',workerSeats:1,workspace:path.join(root,'workspace'),foreground:{provider:'question-evidence',model:'controlled'},background:{provider:'question-evidence',model:'controlled'}})
 await service.start();const active=service.running.get('local');assert(active)
 if(phase==='prepare'){
 if(['Helper','Foreground'].includes(role))await service.send({mode:'local',collaborationId:'native-question',id:'default-question-input',createdAt:new Date().toISOString(),text:role==='Helper'?'Ask Helper to investigate the already reproduced Planner question-lifetime issue. Before further diagnosis, ask me the diagnostic presentation color and wait for my answer.':'Ask my color preference and wait for the actual answer. Record the question and then my answer and conclusion in your existing note.',recipient:'ai',device:'isolated-evidence'})
 else{await fs.mkdir(path.join(root,'business','tasks'),{recursive:true});await fs.writeFile(path.join(root,'business','tasks','Question_'+(role==='Organizer'?'O':'P')+'.md'),role==='Recorder'?'Perform the finite no-file check. Recorder should ask my archive presentation color, wait for my answer, and keep the question and answer in its own Note before archiving.':role==='Worker'?'Planner should delegate a Worker to ask my color choice and wait for my answer. The Worker must record the question and answer in its corresponding Note.':'Ask my color choice and wait for my answer. Record the question and answer in your corresponding Note.')}
 }
 await until('actual default blocking question shown',()=>ui?.container.querySelector('input[type=radio]'))
 const row=[...active.runtime.roleRecords.values()].find(r=>r.sessionId===agent.session.header.id);assert.equal(row.identity.role,role)
 const owned=active.runtime.native.get(row.identity.workId);assert.equal(owned.observe().waitingForUser,true)
 assert(!results.some(r=>r.toolCallId==='choose-color'),'No tool result before actual human answer')
 const before=await fs.readFile(path.join(root,'business',notePath),'utf8');assert(before.includes(beforeText));assert(!before.includes(afterText))
 if(phase==='prepare'){
  const original={role,sessionId:agent.session.header.id,notePath,binding:bindings.get(agent.id)}
  await fs.writeFile(path.join(root,'phase-original.json'),JSON.stringify(original,null,2)+'\n')
  await service.dispose();await sdk.ctx.get('nativeSessionCleaner').drain()
  const retained=await fs.readFile(path.join(root,'business',notePath),'utf8');assert(retained.includes(beforeText)&&!retained.includes(afterText))
  outcome={phase,original,retained,waitingForUserObserved:true}
 }else{
 const taskId=row.identity.taskId,marker='state/Evidence/'+taskId+'/recovery',watchKey=active.runtime.watchKey(taskId,'Evidence')
 assert.equal(await fs.readFile(path.join(root,'business',marker),'utf8'),'','Normal Host cold recovery produced the real member marker')
 await until('actual existing recovery watch established',async()=> (await active.runtime.records.get(watchKey))?.watch?.stage===0)
 const initialWatch=(await active.runtime.records.get(watchKey)).watch
 // Controlled passage of the configured real 30-minute interval only; no state,
 // native result, fault or request is fabricated. Existing Host tick produces check.
 clockOffset+=30*60_000
 await until('real Host tick starts Helper check and normal native turn completes',()=>helperFinished&&sdk.ctx.agents.get(helperSession)?.status==='idle')
 await Promise.all([...active.runtime.workOperations.values()])
 const afterCheck=(await active.runtime.records.get(watchKey)).watch
 assert.equal(afterCheck.stage,resetMode==='no-reset'?1:0)
 assert.equal(afterCheck.cycleStartedAt===initialWatch.cycleStartedAt,resetMode==='no-reset')
 assert.equal(await fs.readFile(path.join(root,'business',marker),'utf8'),'','Reset does not consume Planner recovery marker')
 mark('recovery-reset-observation',{resetMode,checkId,initialWatch,afterCheck,helperFinished})
 await ui.choose('Green');await ui.tab();await ui.tab();assert.equal([...ui.container.querySelectorAll('input[type=radio]')][1].checked,true);await ui.submit()
 await until('post-answer Note write actually committed',()=>results.some(r=>r.toolCallId==='record-answer'&&!r.isError))
 const after=await fs.readFile(path.join(root,'business',notePath),'utf8');assert(after.includes(beforeText)&&after.includes(afterText),'Same existing Note retains both question and actual answer/conclusion')
 const answer=results.find(r=>r.toolCallId==='choose-color');assert.deepEqual(JSON.parse(answer.content.find(c=>c.type==='text').text),{answers:[{id:'choice',selected:['Green']}]})
 await until('normal turn ends',()=>agent.status==='idle'||sdk.ctx.agents.get(agent.id)!==agent)
 outcome={role,sessionId:agent.session.header.id,binding:bindings.get(agent.id),notePath,before,after,actualAnswer:answer,defaultMode:'legacy',waitingForUserObserved:true}

 outcome.phase=phase;outcome.original=JSON.parse(await fs.readFile(path.join(root,'phase-original.json'),'utf8'));assert.equal(outcome.original.notePath,notePath)
 }
 console.log('HELPER_EXPLICIT_RESET_COMPLETE',resetMode,phase)
}finally{
 await ui?.close();await service?.dispose();await sdk?.ctx.get('nativeSessionCleaner')?.drain();await jp?.dispose();await sdk?.close()
 Date.now=realNow;await fs.writeFile(path.join(root,phase+'-final-evidence.json'),JSON.stringify({trace,outcome,sdk:evidence(),limits:'Actual Local Service/SDK/default ask/official UI/real dss_record and physical Note; controlled LLM chooses tools. No model-compliance, Windows, remote Git or long-duration wall-clock test claimed.'},null,2)+'\n')
}
