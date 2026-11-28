// Real DSH SDK + DSS Service/Host; deterministic model, explicit opt-in timed ask.
// CASE=live | prepare | resume | stop-prepare | stop-resume | cancel-prepare | cancel-resume
//      | settled-prepare | settled-resume | complete-prepare | complete-resume.
// No role status, projection, or answer is injected.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
import { evidence, sdkHostRoot } from './test-support/dsh-sdk-runtime.mjs'
const { AgentRegistry } = await import('@deepseek-ai/dsh-agent')
const { SessionStore } = await import('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
const { LocalJobRegistry } = await import('@deepseek-ai/dsh-jobs-local')
const { WorkspaceRegistry } = await import('@deepseek-ai/dsh-workspace')
const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local')
const { WorkingDirectoryService } = await import('@deepseek-ai/dsh-working-directory')
const { UserQuestionService } = await import('@deepseek-ai/dsh-user-questions')
const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const cleaner = await import('../src/native-cleaner/plugin.mjs')
const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const { AgentPresetRegistry } = await import('@deepseek-ai/dsh-agent-preset-registry')
const { FrameworkService } = await import('../src/framework/service.ts')
const { DshSessionReader } = await import('../src/adapters/dsh/sessions.ts')

const root = process.env.DSS_PLANNER_ROOT, mode = process.env.DSS_PLANNER_CASE
assert(root && path.isAbsolute(root) && ['live','prepare','resume','stop-prepare','stop-resume','cancel-prepare','cancel-resume','settled-prepare','settled-resume','complete-prepare','complete-resume'].includes(mode))
await fs.mkdir(path.join(root,'workspace'),{recursive:true})
const trace=[], mark=(event,data={})=>{trace.push({event,...data});console.log(event,JSON.stringify(data))}
async function until(name,fn){const end=Date.now()+20000;while(true){const result=await fn();if(result)return result;if(Date.now()>end)throw Error('Watchdog: '+name);await new Promise(r=>setTimeout(r,10))}}
const outputs=new Map(), calls=[], askCalls=[], observedAnswers=new Map()
const originalIdentity=['resume','stop-resume','cancel-resume','settled-resume','complete-resume'].includes(mode)
  ? JSON.parse(await fs.readFile(path.join(root,'original.json'),'utf8')) : undefined
const originalInspect=DshSessionReader.prototype.inspect
DshSessionReader.prototype.inspect=async function(sessionId){
  const result=await originalInspect.call(this,sessionId)
  if(originalIdentity?.sessionId===sessionId)mark('inspect-original-session',{sessionId,eventCount:result.eventCount,sizeBytes:result.sizeBytes})
  return result
}
function answerInModelRequest(request,callId){
  const replies=[]
  for(const message of request.messages??[]){
    if(message.role!=='user'||message.source?.kind!=='user-question-reply'||message.source.callId!==callId)continue
    for(const block of message.content??[]){
      if(block.type!=='text')continue
      let payload;try{payload=JSON.parse(block.text)}catch{continue}
      if(payload.kind==='answer_to_pending_question'&&payload.tool==='ask_user_question'&&payload.callId===callId){
        assert.deepEqual(payload.answers?.map(answer=>answer.id),['choice'])
        assert.deepEqual(payload.answers[0].selected.length,1)
        const color=payload.answers[0].selected[0]
        assert(['Blue','Green'].includes(color),'Original question answer must be one of its real options')
        replies.push(color)
      }
    }
  }
  assert.equal(replies.length,1,'The original native reply must appear exactly once in the model request')
  mark('model-observed-answer',{session:String(request.sessionId),callId,color:replies[0]})
  return replies[0]
}
function tool(name,input,id){return [{type:'tool-call-delta',index:0,name,id,argumentsDelta:JSON.stringify(input)},{type:'finish',reason:'tool-calls'}]}
class Model extends LlmAdapter {
  stages=new Map()
  async *stream(o){
    const stage=this.stages.get(o.sessionId)??0;this.stages.set(o.sessionId,stage+1)
    const supports=name=>o.tools.some(t=>t.name===name)
    mark('model',{session:o.sessionId,stage,planner:supports('dss_worker_assign'),ask:supports('ask_user_question')})
    if(!supports('dss_worker_assign')){yield {type:'text-delta',index:0,text:'Unrelated role has no assigned test work.'};yield {type:'finish',reason:'stop'};return}
    if(['resume','stop-resume','cancel-resume','settled-resume','complete-resume'].includes(mode)){
      if(stage===0){observedAnswers.set(o.sessionId,answerInModelRequest(o,originalIdentity.callId));yield*tool('dss_snapshot',{},'planner-resumed-snapshot');return}
      if(stage===1){const value=outputs.get(o.sessionId)?.get('planner-resumed-snapshot');assert(value?.snapshotId&&value.binding?.recordPath,'Resumed original Task and Note');const color=observedAnswers.get(o.sessionId);assert(color,'Answer actually observed by the resumed model');yield*tool('dss_record',{snapshotId:value.snapshotId,path:value.binding.recordPath,text:`Answer to original color question: ${color}. Conclusion: use ${color}.\n`,append:true},'planner-resumed-conclusion');return}
      yield {type:'text-delta',index:0,text:'The original answer and conclusion are retained in the Planner Note.'};yield {type:'finish',reason:'stop'};return
    }
    if(stage===0){yield*tool('dss_claim',{},'planner-claim');return}
    if(stage===1){const value=outputs.get(o.sessionId)?.get('planner-claim');assert(value?.snapshotId&&value.binding?.recordPath,'Actual claim and bound Note');yield*tool('dss_record',{snapshotId:value.snapshotId,path:value.binding.recordPath,text:'Question: Which color? Context: original P Task remains running; choice unresolved.\n',append:true},'planner-note');return}
    if(stage===2){assert(supports('ask_user_question'),'Real timed tool mounted');yield*tool('ask_user_question',{questions:[{id:'choice',question:'Which color should this P Task use?',options:[{label:'Blue'},{label:'Green'}]}],timeout:1},'planner-choice');return}
    if(stage===4&&['live','settled-prepare','complete-prepare'].includes(mode)){const value=outputs.get(o.sessionId)?.get('planner-claim');assert(value?.snapshotId);const color=answerInModelRequest(o,originalCall);yield*tool('dss_record',{snapshotId:value.snapshotId,path:value.binding.recordPath,text:`Answer to original color question: ${color}. Conclusion: use ${color}.\n`,append:true},'planner-conclusion');return}
    if(mode==='complete-prepare'&&stage===5){yield*tool('dss_snapshot',{},'planner-complete-snapshot');return}
    if(mode==='complete-prepare'&&stage===6){const value=outputs.get(o.sessionId)?.get('planner-complete-snapshot');assert(value?.snapshotId);yield*tool('dss_complete',{snapshotId:value.snapshotId,acceptance:'The selected Green answer is recorded in the Planner Note.',resultPaths:[value.binding.recordPath]},'planner-complete');return}
    yield {type:'text-delta',index:0,text:'The pending question and any answer are retained in the original Planner Note.'};yield {type:'finish',reason:'stop'}
  }
}
let sdk,jp,service,originalAgent,originalCall,answerResult
try{
  sdk=await openDshStorageFixture(path.join(root,'storage'),path.join(root,'locator'))
  new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{});new UserQuestionService(sdk.ctx)
  sdk.ctx.baseUrl=new URL('file://'+sdkHostRoot+'/__dss_sdk_test_entry__.mjs').href
  const loader=sdk.ctx.plugin(Loader,{baseUrl:sdk.ctx.baseUrl});await loader.await()
  try{mark('loader-import',{module:Object.keys(await sdk.ctx.loader.import('@deepseek-ai/dsh-tool-ask-user'))})}catch(error){mark('loader-import-error',{message:String(error),stack:error.stack})}
  const presets=sdk.ctx.plugin(AgentPresetRegistry,{default:'timed-test'});await presets.await()
  await sdk.ctx.agentPresets.register({id:'timed-test',plugins:[{id:'tool-ask-user',name:'@deepseek-ai/dsh-tool-ask-user',config:{mode:'timed',timeout:120}}]})
  const presetRoster=await sdk.ctx.agentPresets.list();assert.deepEqual(presetRoster,[{id:'timed-test'}]);mark('preset-registered',{roster:presetRoster})
  jp=sdk.ctx.plugin(jsonl,{root:path.join(root,'sessions'),compression:'none'});await jp.await()
  new LocalFileSystem(sdk.ctx,{cwd:path.join(root,'workspace'),diffBasisMaxBytes:1048576});new WorkingDirectoryService(sdk.ctx,{defaultDirectory:path.join(root,'workspace')})
  const wp=sdk.ctx.plugin(WorkspaceRegistry);await wp.await();const lp=sdk.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10});await lp.await()
  await cleaner.apply(sdk.ctx,{}, {onFailure(e,stage){throw Error(stage,{cause:e})}})
  sdk.ctx.llm.registerAdapter(['planner-evidence'],new Model())
  sdk.ctx.on('user-questions/request',async(request,next)=>{originalAgent=request.agent;originalCall=request.wait?.callId;askCalls.push({session:String(originalAgent.session.id),callId:originalCall});mark('ask-request',askCalls.at(-1));return next()})
  sdk.ctx.on('session/event',(session,event)=>{if(['tool/call','tool/result','turn/end'].includes(event.type)){mark(event.type,{session:String(session.id),data:event.data});if(event.type==='tool/result'){let value;for(const c of event.data.message.content??[])if(c.type==='text')try{value=JSON.parse(c.text)}catch{}const rows=outputs.get(String(session.id))??new Map();rows.set(String(event.data.message.toolCallId),value);outputs.set(String(session.id),rows)}}})
  service=new FrameworkService(sdk.ctx,sdk.adapter,{name:'Planner question evidence',userName:'Evidence',localDirectory:path.join(root,'business'),ownerRepo:'',repositoryDirectory:path.join(root,'unused-git'),collaborationId:'planner-question',workerSeats:1,workspace:path.join(root,'workspace'),presetId:'timed-test',foreground:{provider:'planner-evidence',model:'controlled'},background:{provider:'planner-evidence',model:'controlled'}})
  await service.start();const active=service.running.get('local');assert(active,'Real Local Host running')
  if(!['resume','stop-resume','cancel-resume','settled-resume','complete-resume'].includes(mode)){
    const taskSource=path.join(root,'business','tasks','planner_question_P.md')
    await fs.mkdir(path.dirname(taskSource),{recursive:true});await fs.writeFile(taskSource,'# Original P Task\nAsk the user which color to use; preserve the answer in the Planner Note.\n')
    try{await until('actual Planner native ask',()=>askCalls.length)}catch(error){mark('watchdog-state',{roles:[...active.runtime.roleRecords.values()],errors:(await service.view({mode:'local',panelsOnly:true})).errors});throw error}
    const record=await until('actual Planner role',()=>[...active.runtime.roleRecords.values()].find(r=>r.identity.role==='Planner'&&r.sessionId===String(originalAgent.session.id)))
    assert.equal(record.identity.role,'Planner');assert.equal(sdk.ctx.agents.get(originalAgent.id),originalAgent);assert(sdk.ctx.agents.roots().includes(originalAgent),'Planner is a live native root, not a delegated child')
    await until('official pending result',()=>outputs.get(record.sessionId)?.get('planner-choice')?.pending===true)
    await until('normal Planner idle',()=>originalAgent.status==='idle')
    const projection=sdk.ctx.sessionProjections.stateOf(originalAgent.session,'userQuestions')
    assert.equal(projection.questions.active[0].state,'continued')
    const task=JSON.parse(await fs.readFile(path.join(root,'business','tasks',record.identity.taskId+'.json'),'utf8'))
    assert.equal(task.status,'running','Actual P Task not completed')
    mark('before-answer',{role:record.identity.role,workId:record.identity.workId,executionId:record.identity.executionId,sessionId:record.sessionId,taskId:record.identity.taskId,gitSettledWakeId:active.runtime.roleRecords.get(record.identity.workId)?.gitSettledWakeId,projection})
    await fs.writeFile(path.join(root,'original.json'),JSON.stringify({sessionId:record.sessionId,workId:record.identity.workId,executionId:record.identity.executionId,taskId:record.identity.taskId,callId:originalCall},null,2))
    if(['live','settled-prepare','complete-prepare'].includes(mode)){
      try{answerResult={returned:sdk.ctx.userQuestions.answer(originalAgent,originalCall,{answers:[{id:'choice',selected:['Green']}]})}}catch(e){answerResult={error:{code:e.code,message:e.message}}}
      mark('live-answer',answerResult)
      assert.equal(answerResult.returned,true,'The original live call must accept the late answer')
      await until('reply admitted',()=>sdk.ctx.sessionProjections.stateOf(originalAgent.session,'userQuestions').questions.active.length===0)
      await until('answer and conclusion actually recorded',async()=>{const text=await fs.readFile(path.join(root,'business',outputs.get(record.sessionId).get('planner-claim').binding.recordPath),'utf8');return text.includes('Conclusion: use Green.')})
      if(mode==='settled-prepare'){
        await until('answered Planner round settled',()=>{const current=active.runtime.roleRecords.get(record.identity.workId);return current?.gitSettledWakeId===(current.delivery?.request??current.lastWake)?.id})
        mark('answered-round-settled',{record:active.runtime.roleRecords.get(record.identity.workId)})
      }
      if(mode==='complete-prepare'){
        await until('real P Task completion',async()=>{
          const task=JSON.parse(await fs.readFile(path.join(root,'business','tasks',record.identity.taskId+'.json'),'utf8'))
          return task.status==='complete'
        })
        mark('task-complete',{taskId:record.identity.taskId})
      }
    }
    if(mode==='stop-prepare'){
      await service.stopExecution({mode:'local',workId:record.identity.workId,executionId:record.identity.executionId,commandId:'explicit-planner-stop'})
      await until('exact user-stopped Planner',()=>active.runtime.roleRecords.get(record.identity.workId)?.stopped)
      assert(await active.runtime.controls.execution(record.identity),'Explicit user stop control persisted')
      mark('user-stopped',{record:active.runtime.roleRecords.get(record.identity.workId)})
    }
    if(mode==='cancel-prepare'){
      await service.taskControl({mode:'local',taskId:record.identity.taskId,commandId:'explicit-task-cancel',intent:'cancelled'})
      await until('original Planner stopped after Task cancellation',()=>active.runtime.roleRecords.get(record.identity.workId)?.stopped)
      const metadata=JSON.parse(await fs.readFile(path.join(root,'business','tasks',record.identity.taskId+'.json'),'utf8'))
      assert.equal(metadata.status,'cancelled','User cancellation remains terminal')
      mark('task-cancelled',{record:active.runtime.roleRecords.get(record.identity.workId)})
    }
  }else{
    const original=originalIdentity
    if(mode==='complete-resume'){
      await new Promise(resolve=>setTimeout(resolve,1500))
      assert.equal(sdk.ctx.agents.get(original.sessionId),undefined,'Completed Task must not resume original Planner')
      assert.equal([...active.runtime.roleRecords.values()].some(row=>row.identity.role==='Planner'&&row.identity.taskId===original.taskId&&row.identity.executionId!==original.executionId),false,'Completed Task must not get a new Planner execution')
      assert.equal(JSON.parse(await fs.readFile(path.join(root,'business','tasks',original.taskId+'.json'),'utf8')).status,'complete','Completed Task remains terminal')
      assert.equal(trace.some(row=>row.event==='model'&&row.planner),false,'No Planner model request for completed Task')
      mark('complete-not-revived',{original})
    }else await until('Host startup recovery decision',()=>active.runtime.completedStartupTasks?.has(original.taskId))
    if(mode==='resume')await until('original Planner question Session resumed',()=>sdk.ctx.agents.get(original.sessionId))
    const record=active.runtime.roleRecords.get(original.workId)
    const live=sdk.ctx.agents.get(original.sessionId)
    const candidate=live??(record&&sdk.ctx.agents.get(record.sessionId))
    mark('after-startup',{original,record,liveOriginal:!!live,liveReplacement:!!candidate})
    if(mode==='stop-resume'||mode==='cancel-resume'||mode==='settled-resume'||mode==='complete-resume'){
      assert.equal(live,undefined,'User-stopped original Agent must not restart')
      assert.equal(candidate,undefined,'User-stopped Planner must not have a replacement Agent')
      if(mode==='stop-resume')assert(await active.runtime.controls.execution(record.identity),'User stop still authoritative')
      if(mode==='cancel-resume')assert.equal(JSON.parse(await fs.readFile(path.join(root,'business','tasks',original.taskId+'.json'),'utf8')).status,'cancelled','Cancelled Task remains terminal')
      if(mode==='settled-resume'){
        assert.equal(record.gitSettledWakeId,(record.delivery?.request??record.lastWake)?.id,'Old settled Planner row still authoritative')
        assert(trace.some(row=>row.event==='inspect-original-session'),'Current cold-start path reads settled Planner Session')
      }
      answerResult={stopped:true,kind:mode}
      mark('terminal-control-preserved',answerResult)
    }else{
    if(candidate){try{answerResult={returned:sdk.ctx.userQuestions.answer(candidate,original.callId,{answers:[{id:'choice',selected:['Green']}]})}}catch(e){answerResult={error:{code:e.code,message:e.message}}}}else answerResult={unavailable:'original Agent not live; no later native answer target'}
    mark('cold-answer',answerResult)
    assert.equal(answerResult.returned,true,'The original continued call must accept the cold late answer')
    await until('cold answer settled and conclusion recorded',async()=>{
      const activeQuestions=sdk.ctx.sessionProjections.stateOf(candidate.session,'userQuestions').questions.active
      const text=await fs.readFile(path.join(root,'business','task-runs',original.taskId,'Evidence','Planner_Memory.md'),'utf8')
      return !activeQuestions.length&&text.includes('Conclusion: use Green.')
    })
    }
  }
  await fs.writeFile(path.join(root,mode+'-result.json'),JSON.stringify({trace,answerResult,sdk:evidence()},null,2))
  console.log('PLANNER_EVIDENCE_COMPLETE')
}finally{await service?.dispose();await sdk?.ctx.get('nativeSessionCleaner')?.drain();await jp?.dispose();await sdk?.close()}
