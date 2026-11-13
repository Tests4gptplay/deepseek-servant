// Actual DSH SDK and DSS Local Host with controlled model. Timed mode is
// deliberately opted into for this fixture; it is not a product default.
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

const root = process.env.DSS_RECORDER_ROOT, mode = process.env.DSS_RECORDER_CASE
assert(root && path.isAbsolute(root) && ['prepare','resume','stop-prepare','stop-resume','cancel-prepare','cancel-resume'].includes(mode))
await fs.mkdir(path.join(root,'workspace'),{recursive:true})
const trace=[], outputs=new Map(), asks=[], observedAnswers=new Map()
const mark=(event,data={})=>{trace.push({event,...data});console.log(event,JSON.stringify(data))}
const until=async(name,fn)=>{const end=Date.now()+30000;while(true){const x=await fn();if(x)return x;if(Date.now()>end)throw Error('Watchdog: '+name);await new Promise(r=>setTimeout(r,10))}}
const tool=(name,input,id)=>[{type:'tool-call-delta',index:0,name,id,argumentsDelta:JSON.stringify(input)},{type:'finish',reason:'tool-calls'}]
const original=['resume','stop-resume','cancel-resume'].includes(mode)?JSON.parse(await fs.readFile(path.join(root,'original.json'),'utf8')):undefined
function answerInModelRequest(request,callId){
  const replies=[]
  for(const message of request.messages??[]){
    if(message.role!=='user'||message.source?.kind!=='user-question-reply'||message.source.callId!==callId)continue
    for(const block of message.content??[]){
      if(block.type!=='text')continue
      let payload;try{payload=JSON.parse(block.text)}catch{continue}
      if(payload.kind!=='answer_to_pending_question'||payload.tool!=='ask_user_question'||payload.callId!==callId)continue
      assert.deepEqual(payload.questions?.map(question=>question.id),['choice'],'Reply refers to the original question')
      assert.deepEqual(payload.answers?.map(answer=>answer.id),['choice'],'Reply answers the original question')
      assert.equal(payload.answers[0].selected.length,1,'Original question has one actual selection')
      assert.equal(payload.answers[0].custom,undefined,'No unrelated custom answer is substituted')
      const color=payload.answers[0].selected[0]
      assert(['Blue','Green'].includes(color),'Actual answer must match an original option')
      replies.push(color)
    }
  }
  assert.equal(replies.length,1,'Exactly one original native reply must reach the model')
  mark('recorder-model-observed-answer',{sessionId:String(request.sessionId),callId,color:replies[0]})
  return replies[0]
}
class Model extends LlmAdapter {
  stages=new Map()
  async *stream(o){
    const stage=this.stages.get(o.sessionId)??0;this.stages.set(o.sessionId,stage+1)
    const has=n=>o.tools.some(t=>t.name===n), recorder=has('dss_recorder_save'), planner=has('dss_complete')&&!recorder
    mark('model',{sessionId:o.sessionId,stage,recorder,planner,ask:has('ask_user_question')})
    if(planner){
      if(stage===0){yield*tool('dss_claim',{},'planner-claim');return}
      if(mode==='cancel-prepare'){
        if(stage===1){const x=outputs.get(o.sessionId)?.get('planner-claim');assert(x?.snapshotId&&x.binding?.recordPath);yield*tool('dss_record',{snapshotId:x.snapshotId,path:x.binding.recordPath,text:'Question: Should this P Task proceed? Context: user has not decided yet. Unanswered.\n',append:true},'planner-question-note');return}
        if(stage===2){yield*tool('ask_user_question',{questions:[{id:'proceed',question:'Should this P Task proceed?',options:[{label:'Yes'},{label:'No'}]}],timeout:1},'planner-proceed');return}
        yield{type:'text-delta',index:0,text:'P Task awaits user decision and remains incomplete.'};yield{type:'finish',reason:'stop'};return
      }
      if(stage===1){const x=outputs.get(o.sessionId)?.get('planner-claim');assert(x?.snapshotId);yield*tool('dss_complete',{snapshotId:x.snapshotId,acceptance:'Controlled original P objective finished.',resultPaths:[]},'planner-complete');return}
      yield{type:'text-delta',index:0,text:'Original P objective finished.'};yield{type:'finish',reason:'stop'};return
    }
    if(recorder){
      assert(has('ask_user_question'),'Actual native ask tool mounted for Recorder')
      if(mode==='resume'||mode==='cancel-resume'){
        if(stage===0){
          observedAnswers.set(o.sessionId,answerInModelRequest(o,original.callId))
          yield*tool('dss_snapshot',{},'recorder-resumed-snapshot');return
        }
        if(stage===1){const x=outputs.get(o.sessionId)?.get('recorder-resumed-snapshot'),color=observedAnswers.get(o.sessionId);assert(x?.snapshotId&&x.taskId&&color);yield*tool('dss_record',{snapshotId:x.snapshotId,path:`task-runs/${x.taskId}/Recorder_Note.md`,text:`Answer to original archive question: ${color}. Conclusion: use ${color} in the archive.\n`,append:true},'recorder-conclusion');return}
        if(stage===2){const x=outputs.get(o.sessionId)?.get('recorder-resumed-snapshot'),color=observedAnswers.get(o.sessionId);assert(x?.snapshotId&&x.archiveRecordsPath&&color);yield*tool('dss_recorder_save',{snapshotId:x.snapshotId,outputs:[{path:x.archiveRecordsPath,text:'# Controlled Task archive\n\n'+(mode==='cancel-resume'?'The total P Task was cancelled.':'The P objective completed.')+` The original Recorder question was answered ${color}; the conclusion was recorded before handoff.\n`}],retainedPaths:[`task-runs/${x.taskId}/Recorder_Note.md`,'tasks/recorder_question_P.md']},'recorder-save');return}
        yield{type:'text-delta',index:0,text:'Answer was recorded in the original Recorder Note.'};yield{type:'finish',reason:'stop'};return
      }
      if(stage===0){yield*tool('dss_claim',{},'recorder-claim');return}
      if(stage===1){const x=outputs.get(o.sessionId)?.get('recorder-claim');assert(x?.snapshotId&&x.taskId);yield*tool('dss_record',{snapshotId:x.snapshotId,path:`task-runs/${x.taskId}/Recorder_Note.md`,text:'Question: Which archive color? Context: total Task is '+(mode==='cancel-prepare'?'cancelled':'complete')+'; archival still pending. Unanswered.\n',append:true},'recorder-note');return}
      if(stage===2){yield*tool('ask_user_question',{questions:[{id:'choice',question:'Which color should the archive use?',options:[{label:'Blue'},{label:'Green'}]}],timeout:1},'recorder-choice');return}
      yield{type:'text-delta',index:0,text:'Original Recorder question remains unanswered; archive handoff not yet done.'};yield{type:'finish',reason:'stop'};return
    }
    yield{type:'text-delta',index:0,text:'No unrelated work requested.'};yield{type:'finish',reason:'stop'}
  }
}
let sdk,jp,service
try{
  sdk=await openDshStorageFixture(path.join(root,'storage'),path.join(root,'locator'))
  new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{});new UserQuestionService(sdk.ctx)
  sdk.ctx.baseUrl=new URL('file://'+sdkHostRoot+'/__dss_sdk_test_entry__.mjs').href
  const loader=sdk.ctx.plugin(Loader,{baseUrl:sdk.ctx.baseUrl});await loader.await()
  const presets=sdk.ctx.plugin(AgentPresetRegistry,{default:'timed-test'});await presets.await()
  await sdk.ctx.agentPresets.register({id:'timed-test',plugins:[{id:'tool-ask-user',name:'@deepseek-ai/dsh-tool-ask-user',config:{mode:'timed',timeout:120}}]})
  jp=sdk.ctx.plugin(jsonl,{root:path.join(root,'sessions'),compression:'none'});await jp.await()
  new LocalFileSystem(sdk.ctx,{cwd:path.join(root,'workspace'),diffBasisMaxBytes:1048576});new WorkingDirectoryService(sdk.ctx,{defaultDirectory:path.join(root,'workspace')})
  const wp=sdk.ctx.plugin(WorkspaceRegistry);await wp.await();const lp=sdk.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10});await lp.await()
  await cleaner.apply(sdk.ctx,{}, {onFailure(e,stage){throw Error(stage,{cause:e})}})
  sdk.ctx.llm.registerAdapter(['recorder-evidence'],new Model())
  sdk.ctx.on('user-questions/request',async(request,next)=>{asks.push({agent:request.agent,callId:request.wait?.callId});mark('ask-request',{sessionId:String(request.agent.session.id),callId:request.wait?.callId});return next()})
  sdk.ctx.on('session/event',(session,event)=>{if(['tool/call','tool/result','turn/end'].includes(event.type)){mark(event.type,{sessionId:String(session.id),data:event.data});if(event.type==='tool/result'){let value;for(const c of event.data.message.content??[])if(c.type==='text')try{value=JSON.parse(c.text)}catch{}const rows=outputs.get(String(session.id))??new Map();rows.set(String(event.data.message.toolCallId),value);outputs.set(String(session.id),rows)}}})
  service=new FrameworkService(sdk.ctx,sdk.adapter,{name:'Recorder question evidence',userName:'Evidence',localDirectory:path.join(root,'business'),ownerRepo:'',repositoryDirectory:path.join(root,'unused-git'),collaborationId:'recorder-question',workerSeats:1,workspace:path.join(root,'workspace'),presetId:'timed-test',foreground:{provider:'recorder-evidence',model:'controlled'},background:{provider:'recorder-evidence',model:'controlled'}})
  await service.start();const active=service.running.get('local');assert(active)
  if(['prepare','stop-prepare','cancel-prepare'].includes(mode)){
    const source=path.join(root,'business','tasks','recorder_question_P.md');await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,'# Original P Task\nComplete objective, then Recorder asks for archive color.\n')
    if(mode==='cancel-prepare'){
      const plannerAsk=await until('actual Planner native ask',()=>asks.find(row=>[...active.runtime.roleRecords.values()].some(record=>record.identity.role==='Planner'&&record.sessionId===String(row.agent.session.id))))
      const plannerRecord=[...active.runtime.roleRecords.values()].find(record=>record.identity.role==='Planner'&&record.sessionId===String(plannerAsk.agent.session.id))
      await until('Planner question pending',()=>outputs.get(plannerRecord.sessionId)?.get('planner-proceed')?.pending===true)
      await service.taskControl({mode:'local',taskId:plannerRecord.identity.taskId,commandId:'explicit-total-task-cancel',intent:'cancelled'})
      await until('persisted total Task cancellation',async()=>JSON.parse(await fs.readFile(path.join(root,'business','tasks',plannerRecord.identity.taskId+'.json'),'utf8')).status==='cancelled')
    }
    const {agent,callId}=await until('actual Recorder native ask',()=>asks.find(row=>[...active.runtime.roleRecords.values()].some(record=>record.identity.role==='Recorder'&&record.sessionId===String(row.agent.session.id))))
    const record=await until('actual Recorder role',()=>[...active.runtime.roleRecords.values()].find(r=>r.identity.role==='Recorder'&&r.sessionId===String(agent.session.id)))
    assert(sdk.ctx.agents.roots().includes(agent),'Recorder is an actual live native root')
    await until('actual pending tool result',()=>outputs.get(record.sessionId)?.get('recorder-choice')?.pending===true)
    await until('normal idle',()=>agent.status==='idle')
    const projection=sdk.ctx.sessionProjections.stateOf(agent.session,'userQuestions')
    assert.equal(projection.questions.active[0].state,'continued')
    const task=JSON.parse(await fs.readFile(path.join(root,'business','tasks',record.identity.taskId+'.json'),'utf8'))
    assert.equal(task.status,mode==='cancel-prepare'?'cancelled':'complete')
    const note=await fs.readFile(path.join(root,'business','task-runs',record.identity.taskId,'Recorder_Note.md'),'utf8')
    assert(note.includes('Unanswered.'))
    await assert.rejects(fs.access(path.join(root,'business',outputs.get(record.sessionId).get('recorder-claim').archiveRecordsPath)))
    mark('before-answer',{record,taskStatus:task.status,projection,note})
    await fs.writeFile(path.join(root,'original.json'),JSON.stringify({sessionId:record.sessionId,workId:record.identity.workId,executionId:record.identity.executionId,taskId:record.identity.taskId,callId},null,2))
    if(mode==='stop-prepare'){
      await service.stopExecution({mode:'local',workId:record.identity.workId,executionId:record.identity.executionId,commandId:'explicit-recorder-stop'})
      await until('original Recorder explicitly stopped',()=>active.runtime.roleRecords.get(record.identity.workId)?.stopped)
      assert(await active.runtime.controls.execution(record.identity),'Explicit user stop control persisted')
      mark('user-stopped',{record:active.runtime.roleRecords.get(record.identity.workId)})
    }
  }else{
    await until('startup decision',()=>active.runtime.completedStartupTasks?.has(original.taskId))
    if(mode==='resume'||mode==='cancel-resume')await until('original Recorder question Session resumed',()=>sdk.ctx.agents.get(original.sessionId))
    const record=active.runtime.roleRecords.get(original.workId),live=sdk.ctx.agents.get(original.sessionId)
    mark('after-startup',{record,liveOriginal:!!live})
    if(mode==='stop-resume'){
      assert.equal(live,undefined,'Explicitly user-stopped Recorder original Agent must stay stopped')
      assert(await active.runtime.controls.execution(record.identity),'Explicit Recorder stop remains authoritative')
      assert.equal(JSON.parse(await fs.readFile(path.join(root,'business','tasks',original.taskId+'.json'),'utf8')).status,'complete')
      mark('user-stop-preserved',{record})
    }
    if(live){
      const color=mode==='cancel-resume'?'Green':'Blue'
      const result=sdk.ctx.userQuestions.answer(live,original.callId,{answers:[{id:'choice',selected:[color]}]});mark('answer',{result,color})
      await until('answer and Note saved before handoff',()=>outputs.get(original.sessionId)?.has('recorder-conclusion'))
      await until('final archive save',()=>outputs.get(original.sessionId)?.get('recorder-save')?.saved===true)
      const archived=await until('AI root archive actually exists',async()=>{const dir=(await fs.readdir(path.join(root,'business','archives'))).find(name=>name.startsWith('recorder_question_'));if(!dir)return;try{return await fs.readFile(path.join(root,'business','archives',dir,'records.md'),'utf8')}catch{return}})
      assert(archived.includes(`answered ${color}`))
      assert(!archived.includes(`answered ${color==='Blue'?'Green':'Blue'}`),'Archive must follow the actual selected answer')
      if(mode==='cancel-resume')assert(archived.includes('was cancelled'))
      const archiveDirectory=(await fs.readdir(path.join(root,'business','archives'))).find(name=>name.startsWith('recorder_question_'))
      const retention=JSON.parse(await fs.readFile(path.join(root,'business','archives',archiveDirectory,'retention.json'),'utf8'))
      const retainedNote=retention.relocatedReferences?.[`task-runs/${original.taskId}/Recorder_Note.md`]
      assert(retainedNote,'Original Recorder Note must be retained before Cleaner handoff')
      const note=await fs.readFile(path.join(root,'business',retainedNote),'utf8')
      assert(note.includes('Unanswered.')&&note.includes(`Conclusion: use ${color} in the archive.`))
      assert(!note.includes(`Conclusion: use ${color==='Blue'?'Green':'Blue'} in the archive.`),'Retained Note must follow the actual selected answer')
      mark('archived-after-answer',{archived,retainedNote,note,color})
    }
  }
  await fs.writeFile(path.join(root,mode+'-result.json'),JSON.stringify({trace,sdk:evidence()},null,2))
  console.log('RECORDER_EVIDENCE_COMPLETE')
}finally{await service?.dispose();await sdk?.ctx.get('nativeSessionCleaner')?.drain();await jp?.dispose();await sdk?.close()}
