import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
const dir=await mkdtemp(join(process.cwd(),'scripts/.rc3-question-read-')),checks=[]
const check=(n,a,b)=>{assert.deepEqual(a,b,n);checks.push(n)}
try{
 await build({entryPoints:['src/framework/role-runtime.ts'],outfile:join(dir,'runtime.mjs'),bundle:true,format:'esm',platform:'node',packages:'external'})
 await build({entryPoints:['node_modules/@deepseek-ai/dsh-user-questions/src/projection.ts'],outfile:join(dir,'question.mjs'),bundle:true,format:'esm',platform:'node',packages:'external'})
 const {FrameworkRoleRuntime}=await import(pathToFileURL(join(dir,'runtime.mjs')))
 const {userQuestionProjectionDefinition}=await import(pathToFileURL(join(dir,'question.mjs')))
 const ctx=new Context();new SessionStore(ctx);new SessionProjectionRegistry(ctx)
 const session=ctx.sessions.create(SessionId('rc3-question-state-fixture'),{meta:{cwd:'/tmp'}})
 const handle=await ctx.sessionProjections.register(userQuestionProjectionDefinition)
 check('No active question remains an empty native view',ctx.sessionProjections.snapshot(session,['userQuestions']).values.userQuestions.active.length,0)
 // A real official projection folds a controlled, valid pending PTC event.
 // This is not a live model/PTC execution or question-card UI claim.
 session.append('tool/ptc-dispatch',{rootCallId:'root',parentCallId:'root',subCallId:'question',name:'ask_user_question',arguments:{questions:[{id:'choice',question:'Choose a color',options:[{label:'blue'},{label:'red'}]}],timeout:1},isError:false,content:[{type:'text',text:'{"pending":true}'}]})
 const view=ctx.sessionProjections.snapshot(session,['userQuestions']).values.userQuestions
 check('Public wire snapshot exposes the same active question as actual owning handle',view.active,handle.stateOf(session).questions.active)
 check('Pending question is genuinely present',view.active[0].callId,'question')
 const runtime=Object.create(FrameworkRoleRuntime.prototype);runtime.ctx=ctx;runtime.active=()=>false
 const request={id:'wake',sources:[]}
 await runtime.retainClosedRound({identity:{role:'Foreground'},lastWake:request},{actualAgent:{session}})
 checks.push('Actual retainClosedRound returns at native pending question without needing inbox/storage')
 await runtime.finishGitAuxiliaryRound({identity:{role:'Recorder',taskId:'task',workId:'recorder'},sessionId:String(session.id),lastWake:request})
 checks.push('Actual auxiliary round returns at native pending question without capture/retirement')
 await handle.dispose()
 check('Unloaded question capability is absent, not an invented empty projection',ctx.sessionProjections.snapshot(session,['userQuestions']).values.userQuestions,undefined)
 console.log(JSON.stringify({passed:checks.length,checks,limits:'Actual official Context/SessionStore/ProjectionRegistry and official user-question fold; actual two production early-return methods, with controlled valid Session event. Not GUI, native model or PTC execution.'},null,2))
}finally{await rm(dir,{recursive:true,force:true})}
