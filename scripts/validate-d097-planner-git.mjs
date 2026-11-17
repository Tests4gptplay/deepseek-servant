// Real SDK/Agent/Host with controlled local Git CLI objects and CAS, not GitHub.
// PREPARE creates an actual P Task and lets an opt-in timed native question remain unanswered.
// RESUME starts a new SDK/Host from the saved native Session and Git object history.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
import { evidence, sdkHostRoot } from './test-support/dsh-sdk-runtime.mjs'
process.env.DSS_AUDIT_SOURCE_ROOT=path.resolve(fileURLToPath(new URL('../',import.meta.url)))
const { gitFixture } = await import('./test-support/helper-consume-git-fixture.mjs')
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
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { GitAuthorityStore } = await import('../src/framework/git-authority.ts')
const { submitTaskCancellation } = await import('../src/framework/task-cancellation.ts')
const { taskArchiveHostKey } = await import('../src/framework/task-archive.ts')

const root=process.env.DSS_PLANNER_GIT_ROOT, mode=process.env.DSS_PLANNER_GIT_CASE
assert(root&&path.isAbsolute(root)&&['prepare','resume','stop-prepare','stop-resume','cancel-prepare','cancel-resume'].includes(mode))
await fs.mkdir(path.join(root,'workspace'),{recursive:true})
const trace=[],mark=(event,data={})=>{trace.push({event,...data});console.log(event,JSON.stringify(data))}
const until=async(name,fn)=>{const end=Date.now()+20000;while(true){const value=await fn();if(value)return value;if(Date.now()>end)throw Error('Watchdog: '+name);await new Promise(r=>setTimeout(r,10))}}
const replay=['resume','stop-resume','cancel-resume'].includes(mode)
const original=replay?JSON.parse(await fs.readFile(path.join(root,'original.json'),'utf8')):undefined
const outputs=new Map(),answerColors=new Map(),askCalls=[]
function tool(name,input,id){return[{type:'tool-call-delta',index:0,name,id,argumentsDelta:JSON.stringify(input)},{type:'finish',reason:'tool-calls'}]}
function readAnswer(request,callId){
  const colors=[]
  for(const message of request.messages??[]){
    if(message.role!=='user'||message.source?.kind!=='user-question-reply'||message.source.callId!==callId)continue
    for(const block of message.content??[]){
      if(block.type!=='text')continue
      let payload;try{payload=JSON.parse(block.text)}catch{continue}
      if(payload.kind==='answer_to_pending_question'&&payload.tool==='ask_user_question'&&payload.callId===callId){
        assert.deepEqual(payload.answers?.map(x=>x.id),['choice'])
        assert.deepEqual(payload.answers[0].selected,['Green'])
        colors.push(payload.answers[0].selected[0])
      }
    }
  }
  assert.deepEqual(colors,['Green'],'Original native reply must enter this actual model request once')
  mark('model-observed-answer',{session:request.sessionId,callId,color:colors[0]})
  return colors[0]
}
class Model extends LlmAdapter{
  stages=new Map()
  async *stream(request){
    const stage=this.stages.get(request.sessionId)??0;this.stages.set(request.sessionId,stage+1)
    const supports=name=>request.tools.some(t=>t.name===name)
    mark('model',{session:request.sessionId,stage,planner:supports('dss_worker_assign'),ask:supports('ask_user_question')})
    if(!supports('dss_worker_assign')){yield{type:'text-delta',index:0,text:'No unrelated role work is assigned.'};yield{type:'finish',reason:'stop'};return}
    if(replay){
      if(!answerColors.has(request.sessionId)){
        const replyPresent=request.messages?.some(message=>message.role==='user'&&message.source?.kind==='user-question-reply'&&message.source.callId===original.callId)
        if(replyPresent){answerColors.set(request.sessionId,readAnswer(request,original.callId));yield*tool('dss_snapshot',{},'git-resumed-snapshot');return}
        yield{type:'text-delta',index:0,text:'Rechecking the original unanswered P Task without inventing an answer.'};yield{type:'finish',reason:'stop'};return
      }
      const view=outputs.get(request.sessionId)?.get('git-resumed-snapshot')
      if(view?.snapshotId&&!outputs.get(request.sessionId)?.has('git-resumed-note')){assert(view.binding?.recordPath);yield*tool('dss_record',{snapshotId:view.snapshotId,path:view.binding.recordPath,text:`Answer to original color question: ${answerColors.get(request.sessionId)}. Conclusion: use ${answerColors.get(request.sessionId)}.\n`,append:true},'git-resumed-note');return}
      yield{type:'text-delta',index:0,text:'Original answer recorded in Planner Note.'};yield{type:'finish',reason:'stop'};return
    }
    if(stage===0){yield*tool('dss_claim',{},'git-claim');return}
    if(stage===1){const view=outputs.get(request.sessionId)?.get('git-claim');assert(view?.snapshotId&&view.binding?.recordPath);yield*tool('dss_record',{snapshotId:view.snapshotId,path:view.binding.recordPath,text:'Question: Which color? P Task is still running; user choice unresolved.\n',append:true},'git-question-note');return}
    if(stage===2){assert(supports('ask_user_question'));yield*tool('ask_user_question',{questions:[{id:'choice',question:'Which color should this P Task use?',options:[{label:'Blue'},{label:'Green'}]}],timeout:1},'git-original-choice');return}
    yield{type:'text-delta',index:0,text:'Pending original question retained.'};yield{type:'finish',reason:'stop'}
  }
}
let sdk,jp,rt,originalAgent,originalCall,g
try{
  g=gitFixture(path.join(root,'repo.git'),'sha1',async command=>{
    if(command.op==='push')mark('real-git-cas-push',{expected:command.expected,commit:command.commit,ref:command.ref})
  },replay)
  sdk=await openDshStorageFixture(path.join(root,'storage'),path.join(root,'locator'))
  new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{});new UserQuestionService(sdk.ctx)
  sdk.ctx.baseUrl=new URL('file://'+sdkHostRoot+'/__dss_sdk_test_entry__.mjs').href
  const loader=sdk.ctx.plugin(Loader,{baseUrl:sdk.ctx.baseUrl});await loader.await()
  const presets=sdk.ctx.plugin(AgentPresetRegistry,{default:'timed-test'});await presets.await()
  await sdk.ctx.agentPresets.register({id:'timed-test',plugins:[{id:'tool-ask-user',name:'@deepseek-ai/dsh-tool-ask-user',config:{mode:'timed',timeout:120}}]})
  assert.deepEqual(await sdk.ctx.agentPresets.list(),[{id:'timed-test'}])
  jp=sdk.ctx.plugin(jsonl,{root:path.join(root,'sessions'),compression:'none'});await jp.await()
  new LocalFileSystem(sdk.ctx,{cwd:path.join(root,'workspace'),diffBasisMaxBytes:1048576});new WorkingDirectoryService(sdk.ctx,{defaultDirectory:path.join(root,'workspace')})
  const wp=sdk.ctx.plugin(WorkspaceRegistry);await wp.await();const lp=sdk.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10});await lp.await()
  await cleaner.apply(sdk.ctx,{}, {onFailure(e,stage){throw Error(stage,{cause:e})}})
  sdk.ctx.llm.registerAdapter(['git-planner-evidence'],new Model())
  sdk.ctx.on('user-questions/request',async(request,next)=>{originalAgent=request.agent;originalCall=request.wait?.callId;askCalls.push({session:String(originalAgent.session.id),callId:originalCall});mark('ask-request',askCalls.at(-1));return next()})
  sdk.ctx.on('session/event',(session,event)=>{if(['tool/call','tool/result','turn/end'].includes(event.type)){mark(event.type,{session:String(session.id),data:event.data});if(event.type==='tool/result'){let value;for(const block of event.data.message.content??[])if(block.type==='text')try{value=JSON.parse(block.text)}catch{}const rows=outputs.get(String(session.id))??new Map();rows.set(String(event.data.message.toolCallId),value);outputs.set(String(session.id),rows)}}})
  const files=g.files,records=new GitAuthorityStore(files,'d097-git-evidence'),scope='d097-git-evidence'
  rt=new FrameworkRoleRuntime(sdk.ctx,files,records,{scope,mode:'git',member:'Evidence',primary:true,workspace:path.join(root,'workspace'),workerSeats:1,collaborationId:'planner-git-question',instanceUUID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',presetId:'timed-test',foreground:{provider:'git-planner-evidence',model:'controlled'},background:{provider:'git-planner-evidence',model:'controlled'}},{members:()=>['Evidence'],resources:()=>[],heartbeat:async()=>{},error:(error,context)=>{mark('runtime-error',{error:String(error),context});return true}})
  await rt.start()
  const read=async file=>{const snapshot=await files.snapshot();try{return await files.read(snapshot,file)}finally{await snapshot.release()}}
  if(!replay){
    await withSnapshot(files,snapshot=>files.commit(snapshot,[{path:'tasks/planner_git_question_P.md',content:'# Original P Task\nAsk user which color; save the answer in Planner Note.\n'}],'Create actual P Task'))
    await until('actual Git Planner question',()=>askCalls.length)
    const record=await until('actual P Planner',()=>[...rt.roleRecords.values()].find(row=>row.identity.role==='Planner'&&row.sessionId===String(originalAgent.session.id)))
    assert(record.identity.taskId&&sdk.ctx.agents.get(originalAgent.id)===originalAgent&&sdk.ctx.agents.roots().includes(originalAgent))
    await until('official timed pending result',()=>outputs.get(record.sessionId)?.get('git-original-choice')?.pending===true)
    await until('native Planner idle',()=>originalAgent.status==='idle')
    assert.equal(sdk.ctx.sessionProjections.stateOf(originalAgent.session,'userQuestions').questions.active[0].state,'continued')
    assert.equal(JSON.parse(await read('tasks/'+record.identity.taskId+'.json')).status,'running')
    await fs.writeFile(path.join(root,'original.json'),JSON.stringify({sessionId:record.sessionId,workId:record.identity.workId,executionId:record.identity.executionId,taskId:record.identity.taskId,callId:originalCall},null,2))
    mark('before-host-close',{record:rt.roleRecords.get(record.identity.workId),questionState:'continued'})
    if(mode==='stop-prepare'){
      await rt.requestExecutionStop('explicit-user-stop',record.identity.workId,record.identity.executionId)
      await until('exact stopped original',()=>rt.roleRecords.get(record.identity.workId)?.stopped)
      assert(await rt.controls.execution(record.identity))
      mark('user-stopped',{record:rt.roleRecords.get(record.identity.workId)})
    }
    if(mode==='cancel-prepare'){
      const task=JSON.parse(await read('tasks/'+record.identity.taskId+'.json'))
      const confirmed=await submitTaskCancellation({files,member:'Evidence',commandHostKey:taskArchiveHostKey(records.root,scope,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),transact:(id,input,options,build)=>rt.transactions.run(id,input,options,build)},{taskId:record.identity.taskId},'explicit-task-cancel')
      assert(confirmed?.result.cancelledTaskIds.includes(record.identity.taskId))
      await rt.taskCancellationPublished(task,confirmed)
      await until('cancelled exact Planner stopped',async()=>{await rt.loop.poll();return rt.roleRecords.get(record.identity.workId)?.stopped})
      assert.equal(JSON.parse(await read('tasks/'+record.identity.taskId+'.json')).status,'cancelled')
      mark('task-cancelled',{record:rt.roleRecords.get(record.identity.workId),confirmed})
    }
  }else{
    await rt.loop.poll()
    const record=rt.roleRecords.get(original.workId)
    if(mode==='stop-resume'||mode==='cancel-resume'){
      assert.equal(sdk.ctx.agents.get(original.sessionId),undefined)
      assert.equal(record?.identity.executionId,original.executionId)
      if(mode==='stop-resume')assert(await rt.controls.execution(record.identity))
      else assert.equal(JSON.parse(await read('tasks/'+original.taskId+'.json')).status,'cancelled')
      mark('terminal-control-preserved',{record,mode})
    }else{
      const agent=await until('original native Session resumed',()=>sdk.ctx.agents.get(original.sessionId))
      assert.equal(rt.roleRecords.get(original.workId)?.sessionId,original.sessionId)
      const accepted=sdk.ctx.userQuestions.answer(agent,original.callId,{answers:[{id:'choice',selected:['Green']}]})
      assert.equal(accepted,true)
      mark('cold-answer',{returned:accepted})
      await until('model wrote original Note',async()=>{const body=await read('task-runs/'+original.taskId+'/Evidence/Planner_Memory.md');return body?.includes('Conclusion: use Green.')})
      assert.equal(sdk.ctx.sessionProjections.stateOf(agent.session,'userQuestions').questions.active.length,0)
      mark('cold-note',{body:await read('task-runs/'+original.taskId+'/Evidence/Planner_Memory.md')})
    }
  }
  mark('case-complete',{mode,head:g.git(['rev-parse','refs/heads/main']).toString().trim(),casPushes:trace.filter(row=>row.event==='real-git-cas-push').length,sdk:evidence()})
}finally{
  await rt?.dispose();await sdk?.ctx.get('nativeSessionCleaner')?.drain();await jp?.dispose();await sdk?.close()
  await fs.writeFile(path.join(root,mode+'-result.json'),JSON.stringify(trace,null,2))
}
