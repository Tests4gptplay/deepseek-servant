import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
const root=new URL('../src/',import.meta.url),loaded=new Map(),data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64')
const hooks=registerHooks({resolve(s,c,next){
 if(s==='@deepseek-ai/dsh-agent')return{url:data('export function installModelSelection(){throw new Error("No model configuration in this test")}'),shortCircuit:true}
 if(s==='@deepseek-ai/dsh-llm')return{url:data('export const MessageId=x=>x,freezeMessage=x=>x,errorChain=x=>String(x)'),shortCircuit:true}
 if(s==='@deepseek-ai/dsh-session')return{url:data('export const SessionId=x=>x,deriveEventMessage=x=>x,isAppendSurfaceEvent=()=>false'),shortCircuit:true}
 if(c.parentURL?.endsWith('/adapters/dsh/agents.ts')&&s==='./sessions.ts')return{url:data('export const deriveNativeInputs=()=>new Map()'),shortCircuit:true}
 if(c.parentURL?.endsWith('/adapters/dsh/agents.ts')&&s==='./progress.js')return{url:data('export const observeDshProgress=()=>()=>{}'),shortCircuit:true}
 if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}
 return next(s,c)},load(u,c,next){if(u.startsWith(root.href)&&u.endsWith('.ts')){const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return next(u,c)}})
const {DshAgentGateway}=await import('../src/adapters/dsh/agents.ts')
const {retireNativeSession}=await import('../src/adapters/dsh/native-cleaner.ts')
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const calls=[],live=new Map(),warnings=[];let failClose=false,next=0,retireResolve
const cleaner={register(agent){const token=++next;calls.push(['register',agent.id,token]);return{closed:r=>calls.push(['closed',token,r.status])}},retire(id){calls.push(['retire',id]);return new Promise(r=>retireResolve=r)}}
const ctx={get:k=>k==='nativeSessionCleaner'?cleaner:undefined,logger:()=>({warn:(...x)=>warnings.push(x)}),sessions:{flush:async()=>{}},agents:{get:id=>live.get(id)}}
ctx.agents.create=ctx.agents.resume=async input=>{const id=input.sessionId??input.resumeSessionId,agent={id,session:{requestHeader:()=>undefined},status:'idle'};const scope={on:()=>()=>{},effect:()=>{}};live.set(id,agent);await input.setup(scope,agent);return{agent,dispose:async()=>{calls.push(['native-close',id]);if(failClose){failClose=false;throw new Error('real handle failure')}live.delete(id)}}}
try{
 const gateway=new DshAgentGateway(ctx)
 const first=await gateway.create({sessionId:'owned-session',role:'Worker',cwd:'/',setup:()=>calls.push(['business-setup'])})
 check(calls.slice(0,2),[['register','owned-session',1],['business-setup']])
 await first.dispose();check(calls.slice(-2),[['native-close','owned-session'],['closed',1,'closed']]);check(calls.some(x=>x[0]==='retire'),false)
 const second=await gateway.create({sessionId:'owned-session',role:'Worker',cwd:'/'})
 failClose=true;await assert.rejects(second.dispose(),/real handle failure/);assertions++
 check(calls.at(-1),['closed',2,'failed'])
 await second.dispose();check(calls.at(-1),['closed',2,'closed'])
 check(calls.filter(x=>x[0]==='closed'&&x[1]===1).length,1)
 // The existing retirement promise acknowledges durable responsibility only.
 // It is caller-owned and does not hold unrelated admission or claim deletion.
 let accepted=false
 const retirement=retireNativeSession(ctx,'owned-session').then(()=>{accepted=true})
 check(retirement instanceof Promise,true);check(calls.at(-1),['retire','owned-session'])
 await Promise.resolve();check(accepted,false)
 const independent=await gateway.create({sessionId:'independent-session',role:'Helper',cwd:'/'})
 check(independent.id??independent.sessionId,'independent-session')
 check(accepted,false)
 retireResolve();await retirement;check(accepted,true)
 await independent.dispose()
 cleaner.retire=()=>Promise.reject(new Error('journal acceptance failed'))
 await assert.rejects(retireNativeSession(ctx,'failed-retirement'),/journal acceptance failed/);assertions++
 check(warnings.length,0) // The caller retains/report its real failure, not a logged success.
 const before=calls.length
 await assert.rejects(retireNativeSession({get:()=>undefined},'unavailable-cleaner'),/original Host responsibility is retained/);assertions++
 check(calls.length,before)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual Gateway/Host adapter with explicit native SDK and handle contract stubs; no native DSH/Windows or restart retirement proof.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{hooks.deregister()}
