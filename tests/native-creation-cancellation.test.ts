import test, { type TestContext } from 'node:test'
import { DshAgentGateway } from '../src/adapters/dsh/agents.js'
import { DshAgentCreationCancelled } from '../src/adapters/dsh/host-types.js'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions,{SessionId} from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
async function fixture(t:TestContext){const ctx=new Context();t.after(()=>ctx.fiber.dispose());for(const p of [Llm,Sessions,Projections,Prompt,Tools,Agents])await ctx.plugin(p as any);const directory=await mkdtemp(join(tmpdir(),'dss-native-cancel-'));await ctx.plugin(Jsonl,{root:directory,compression:'none'});await ctx.plugin(Loop,{agents:[]});return ctx}

test('gateway cancels held composition with exact reason and fences late setup', {timeout:5000}, async t=>{
 const ctx=await fixture(t), gateway=new DshAgentGateway(ctx), entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>(), late=Promise.withResolvers<void>(), c=new AbortController(), reason=new Error('Helper owns this recovery');let commits=0
 const opening=gateway.create({sessionId:'gateway-composition',cwd:process.cwd(),role:'worker',signal:c.signal,
  setup:async()=>{entered.resolve();await release.promise;late.resolve();return {commit(){commits++}}}}).catch(e=>e)
 await entered.promise;c.abort(reason)
 const failure=await opening;assert.ok(failure instanceof DshAgentCreationCancelled);assert.equal(failure.cause,reason);assert.equal(failure.executionStopped,true);assert.match(failure.message,/cleanup is not independently acknowledged/)
 assert.equal(gateway.hasLiveOwner('gateway-composition'),false);assert.equal(gateway.get('gateway-composition'),undefined)
 release.resolve();await late.promise;await Promise.resolve();assert.equal(commits,0)
 const next=await gateway.create({sessionId:'gateway-composition',cwd:process.cwd(),role:'worker'});await next.dispose()
})
test('gateway keeps preset resolution owned and does not create after cancellation', async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),c=new AbortController();let creates=0,settled=false
 const ctx={get:(key:string)=>key==='agentPresets'?{resolve:async()=>{entered.resolve();await release.promise;return{id:'controlled'}}}:undefined,
  agents:{get:()=>undefined,create:async()=>{creates++;throw new Error('must not create')}}} as unknown as Context
 const gateway=new DshAgentGateway(ctx)
 const opening=gateway.create({sessionId:'preset-pending',cwd:'/synthetic',role:'worker',signal:c.signal}).catch(e=>{settled=true;return e})
 await entered.promise;c.abort(new Error('cancel'));await Promise.resolve();assert.equal(settled,false);release.resolve()
 const error=await opening;assert.ok(error instanceof DshAgentCreationCancelled);assert.equal(error.executionStopped,true);assert.equal(creates,0)
})
test('gateway cancellation during history flush joins flush and real disposal, preserving failure',async()=>{
 for(const fails of [false,true]){
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),c=new AbortController();let disposals=0,settled=false
 const native={agent:{inject:()=>{},session:{}},dispose:async()=>{disposals++;if(fails)throw new Error('real close failed')}}
 const ctx={get:()=>undefined,agents:{get:()=>undefined,create:async()=>native},sessions:{flush:async()=>{entered.resolve();await release.promise}}} as unknown as Context
 const gateway=new DshAgentGateway(ctx),reason=new Error('cancel after create')
 const opening=gateway.create({sessionId:'flush-'+fails,cwd:'/synthetic',role:'worker',signal:c.signal,recentExchanges:[[]]}).catch(e=>{settled=true;return e})
 await entered.promise;c.abort(reason);await Promise.resolve();assert.equal(settled,false);assert.equal(disposals,0);release.resolve()
 const error=await opening;assert.ok(error instanceof DshAgentCreationCancelled);assert.equal(error.cause,reason);assert.equal(error.executionStopped,!fails);assert.equal(disposals,1);assert.equal(gateway.get('flush-'+fails),undefined)
 }
})

for (const phase of ['persistence', 'publication'] as const) test(`gateway cancellation during ${phase} keeps real acquisition owned until its stop can be confirmed`, { timeout: 5000 }, async t => {
 const ctx = await fixture(t), gateway = new DshAgentGateway(ctx), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
 const controller = new AbortController(), reason = new Error('close exact creation'), sessionId = 'owned-' + phase
 if (phase === 'persistence') {
  const persistence = ctx.sessionPersistence, create = persistence.create.bind(persistence)
  t.mock.method(persistence, 'create', async (...args: Parameters<typeof create>) => { entered.resolve(); await gate.promise; return create(...args) })
 } else ctx.on('agent/created', async ({ agent }) => { if (String(agent.id) === sessionId) { entered.resolve(); await gate.promise } })
 let settled = false
 const opening = gateway.create({ sessionId, cwd: process.cwd(), role: 'worker', signal: controller.signal }).catch(error => error).finally(() => { settled = true })
 await entered.promise; controller.abort(reason)
 await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false, 'no detached acquisition or assumed rollback')
 gate.resolve()
 const failure = await opening
 assert.ok(failure instanceof DshAgentCreationCancelled); assert.equal(failure.cause, reason); assert.equal(failure.executionStopped, true)
 assert.equal(gateway.hasLiveOwner(sessionId), false); assert.equal(gateway.get(sessionId), undefined)
 const next = await gateway.create({ sessionId, cwd: process.cwd(), role: 'worker', resume: await gateway.exists(sessionId) }); await next.dispose()
})

test('post-setup cancellation preserves failure from the actual returned handle disposal', async () => {
 const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), c = new AbortController()
 const closeFailure = new Error('actual owned handle close failed')
 const ctx = { get: () => undefined, agents: { get: () => undefined, create: async (options: any) => {
  await options.setup({ on: () => {} }, { session: {} }); entered.resolve(); await gate.promise
  return { agent: {}, dispose: async () => { throw closeFailure } }
 } } } as unknown as Context
 const opening = new DshAgentGateway(ctx).create({ sessionId: 'post-setup-failure', cwd: '/synthetic', role: 'worker', signal: c.signal }).catch(error => error)
 await entered.promise; c.abort(new Error('close')); gate.resolve()
 const error = await opening
 assert.ok(error instanceof DshAgentCreationCancelled); assert.equal(error.executionStopped, false); assert.match(error.message, /actual owned handle close failed/)
})
