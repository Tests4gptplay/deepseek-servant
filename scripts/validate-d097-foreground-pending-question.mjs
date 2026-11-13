// Actual SDK/Service and DSS React question card with a deterministic model fixture.
// The fixture explicitly chooses optional timeout:1; it is not a product default.
// D012 owns draft persistence across tab unmounts, so this test makes no such claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openQuestionUi} from './test-support/d097-question-ui.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {AgentRegistry}=await import('@deepseek-ai/dsh-agent'),{SessionStore}=await import('@deepseek-ai/dsh-session'),{SessionProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection')
const {LlmRuntime,LlmAdapter}=await import('@deepseek-ai/dsh-llm'),{ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt'),{AgentLoop}=await import('@deepseek-ai/dsh-agent-loop')
const {LocalJobRegistry}=await import('@deepseek-ai/dsh-jobs-local'),{WorkspaceRegistry}=await import('@deepseek-ai/dsh-workspace'),{LocalFileSystem}=await import('@deepseek-ai/dsh-fs-local'),{WorkingDirectoryService}=await import('@deepseek-ai/dsh-working-directory')
const {UserQuestionService}=await import('@deepseek-ai/dsh-user-questions'),ask=await import('@deepseek-ai/dsh-tool-ask-user'),jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl')
const cleaner=await import('../src/native-cleaner/plugin.mjs'),{FrameworkService}=await import('../src/framework/service.ts')
const root=process.env.DSS_QUESTION_ROOT;assert(root&&path.isAbsolute(root),'Explicit owned fixture root required')
await fs.mkdir(path.join(root,'workspace'),{recursive:true})
const trace=[],mark=(event,data={})=>{trace.push({event,...data});console.log(event,JSON.stringify(data))}
async function until(name,fn){const end=Date.now()+20000;while(true){const x=await fn();if(x)return x;if(Date.now()>end)throw Error('Experiment watchdog expired: '+name);await new Promise(r=>setTimeout(r,10))}}
const results=[];let originalAgent,questionCall,service,jp,sdk,answerResult,ui,model
class Model extends LlmAdapter{
 stages=new Map()
 async *stream(o){
  const stage=this.stages.get(o.sessionId)??0;this.stages.set(o.sessionId,stage+1)
  const supports=n=>o.tools.some(t=>t.name===n);mark('model',{sessionId:o.sessionId,stage,foreground:supports('dss_conversation_read')})
  if(!supports('dss_conversation_read')){yield{type:'text-delta',index:0,text:'No unrelated work requested.'};yield{type:'finish',reason:'stop'};return}
  const call=(name,input,id)=>[{type:'tool-call-delta',index:0,name,id,argumentsDelta:JSON.stringify(input)},{type:'finish',reason:'tool-calls'}]
  if(stage===0){yield*call('dss_conversation_read',{},'read-input');return}
  if(stage>2&&this.readNext){this.readNext=false;yield*call('dss_conversation_read',{},'read-later-input');return}
  if(stage===1){assert(supports('ask_user_question'),'Actual tool advertised');yield*call('ask_user_question',{timeout:1,questions:[{id:'choice',question:'Which color should the next step use?',options:[{label:'Blue'},{label:'Green'}]}]},'choose-color');return}
  yield{type:'text-delta',index:0,text:'Independent useful work is complete; the color choice is still unanswered.'};yield{type:'finish',reason:'stop'}
 }
}
try{
 sdk=await openDshStorageFixture(path.join(root,'storage'),path.join(root,'locator'))
 new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{});new UserQuestionService(sdk.ctx)
 ask.apply(sdk.ctx,{mode:'timed',timeout:120})
 jp=sdk.ctx.plugin(jsonl,{root:path.join(root,'sessions'),compression:'none'});await jp.await()
 new LocalFileSystem(sdk.ctx,{cwd:path.join(root,'workspace'),diffBasisMaxBytes:1048576});new WorkingDirectoryService(sdk.ctx,{defaultDirectory:path.join(root,'workspace')})
 const wp=sdk.ctx.plugin(WorkspaceRegistry);await wp.await();const lp=sdk.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10});await lp.await()
 await cleaner.apply(sdk.ctx,{}, {onFailure(e,stage){throw Error(stage,{cause:e})}})
 model=new Model();sdk.ctx.llm.registerAdapter(['question-evidence'],model)
 // Passive observation only: leave the original request/Promise/result untouched.
 sdk.ctx.on('user-questions/request',async(request,next)=>{originalAgent=request.agent;questionCall=request.wait?.callId;mark('question-request',{agentId:originalAgent.id,callId:questionCall});return next()})
 sdk.ctx.on('session/event',(session,event)=>{if(['tool/call','tool/result','turn/close'].includes(event.type)){mark(event.type,{sessionId:session.header.id,data:event.data});if(event.type==='tool/result')results.push(event.data.message)}})
 service=new FrameworkService(sdk.ctx,sdk.adapter,{name:'Question evidence',userName:'Evidence',localDirectory:path.join(root,'business'),ownerRepo:'',repositoryDirectory:path.join(root,'unused-git'),collaborationId:'native-question',workerSeats:1,workspace:path.join(root,'workspace'),foreground:{provider:'question-evidence',model:'controlled'},background:{provider:'question-evidence',model:'controlled'}})
 await service.start();const active=service.running.get('local');assert(active,'Actual Local Service running')
 await service.send({mode:'local',collaborationId:'native-question',id:'question-input',createdAt:new Date().toISOString(),text:'Ask my color choice; wait one second, then finish the independent work while I decide.',recipient:'ai',device:'isolated-evidence'})
 await until('ordinary SDK pending result',()=>results.some(r=>r.content?.some(c=>c.type==='text'&&c.text.includes('"pending":true'))))
 assert(originalAgent&&questionCall,'Original exact agent/call captured from ordinary request')
 await until('ordinary model idle after pending',()=>originalAgent.status==='idle')
 const projection=sdk.ctx.sessionProjections.stateOf(originalAgent.session,'userQuestions')
 assert.equal(projection.questions.active[0].state,'continued')
 assert.equal(sdk.ctx.agents.get(originalAgent.id),originalAgent,'Original answer owner remains live')
 ui=await openQuestionUi(sdk.ctx,originalAgent,service,mark)
 assert(ui.container.textContent.includes('Work continued'),'Official publisher produced ordinary continued card')
 await ui.tab();assert.equal(ui.container.querySelector('input[type=radio]'),null)
 await ui.tab();await ui.choose('Blue')
 model.readNext=true
 await service.send({mode:'local',collaborationId:'native-question',id:'later-input',createdAt:new Date().toISOString(),text:'While I decide, note that the next task will be separate.',recipient:'ai',device:'isolated-evidence'})
 await until('ordinary later input read',()=>results.some(r=>r.toolCallId==='read-later-input'))
 await until('later native turn idle',()=>originalAgent.status==='idle')
 assert.equal(sdk.ctx.agents.get(originalAgent.id),originalAgent,'Ordinary new chat keeps the original pending owner')
 assert.equal([...active.runtime.roleRecords.values()].find(r=>r.identity.role==='Foreground').sessionId,originalAgent.session.header.id)
 await ui.refresh();assert.equal(ui.container.querySelector('input[type=radio]').checked,true,'New ordinary chat preserves original question draft')
 await ui.submit()
 await until('actual late reply admitted',()=>sdk.ctx.sessionProjections.stateOf(originalAgent.session,'userQuestions').questions.active.length===0)
 await until('answered normal foreground retired',()=>sdk.ctx.agents.get(originalAgent.id)!==originalAgent)
 answerResult={answered:true,settled:sdk.ctx.sessionProjections.stateOf(originalAgent.session,'userQuestions').questions.settled}
 mark('answer-settled',answerResult)
 assert.deepEqual(answerResult.settled[0].answers,[{id:'choice',selected:['Blue']}])
 await fs.writeFile(path.join(root,'evidence.json'),JSON.stringify({trace,answerResult,sdk:evidence()},null,2)+'\n')
 console.log('LIVE_UI_OBSERVATION_COMPLETE')
}finally{
 await ui?.close();await service?.dispose();await sdk?.ctx.get('nativeSessionCleaner')?.drain();await jp?.dispose();await sdk?.close()
 if(sdk)await fs.writeFile(path.join(root,'final-evidence.json'),JSON.stringify({trace,answerResult,sdk:evidence()},null,2)+'\n')
}
