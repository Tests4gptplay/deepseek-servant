import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { AgentModel, modelSelectionProjectionDefinition, installModelSelection } from '@deepseek-ai/dsh-agent'
const dir=await mkdtemp(join(process.cwd(),'scripts/.rc3-projections-')), checks=[]
const check=(name,a,b)=>{assert.deepEqual(a,b,name);checks.push(name)}
const flush=()=>new Promise(setImmediate)
try {
 await build({entryPoints:['src/adapters/dsh/foreground-activity.ts'],outfile:join(dir,'activity.mjs'),bundle:true,format:'esm',platform:'node',packages:'external'})
 const {ensureForegroundActivity}=await import(pathToFileURL(join(dir,'activity.mjs')))
 const ctx=new Context();new SessionStore(ctx)
 const session=ctx.sessions.create(SessionId('rc3-lifecycle-fixture'),{meta:{cwd:'/tmp'}})
 const reader=ensureForegroundActivity(ctx)
 check('Absent native capability is unavailable without an artificial wait',reader.available(),false)
 check('An early request reads undefined rather than a fake turn',reader.read(session),undefined)
 const register=scope=>{new SessionProjectionRegistry(scope)}
 let provider=ctx.plugin(register)
 // Commit before the awaited public handle is published: its real fold must catch up.
 session.append('turn/start',{turn:1})
 await provider;await flush()
 check('Late official capability publishes ready handle',reader.available(),true)
 check('The first ready read folds the already-arrived real Session event',reader.read(session).turn,1)
 const second=ensureForegroundActivity(ctx);await flush()
 await reader.dispose()
 check('Disposed reader is unavailable',reader.available(),false)
 check('Disposing one owner leaves the other real registration alive',second.read(session).turn,1)
 session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 check('Actual native turn end updates the retained official handle',second.read(session).end,'completed')
 await provider.dispose();await flush()
 check('Native service unload clears published reader',second.available(),false)
 provider=ctx.plugin(register);await provider;await flush()
 check('Native service reload restores one ready reader over existing history',second.read(session).end,'completed')
 await second.dispose()
 const transient=ensureForegroundActivity(ctx);const released=transient.dispose();await released;await flush()
 check('Disposal during asynchronous registration never publishes a usable reader',transient.read(session),undefined)
 check('Disposed pending registration remains unavailable',transient.available(),false)
 // Actual AgentModel and actual registered selection projection, no model/network.
 const handle=await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
 const options={provider:'fixture',model:'old',reasoningEffort:'high'}
 const model=new AgentModel(handle.readerFor(session),session,options)
 check('Official new Agent uses its options fallback',model.current(),options)
 model.select({provider:'fixture',model:'new'})
 check('Official pending selection overrides initial options',model.current(),{provider:'fixture',model:'new'})
 const resumed=new AgentModel(handle.readerFor(session),session,{provider:'fixture',model:'other-default'})
 check('Resumed Agent retains its recorded pending selection without an extra installer state',resumed.current(),{provider:'fixture',model:'new'})
 const off=installModelSelection(ctx)
 check('Official one-argument installer returns a lifecycle disposer',typeof off,'function');off()
 await handle.dispose();await provider.dispose()
 console.log(JSON.stringify({passed:checks.length,checks,limits:'Actual official rc3 Context, SessionStore, SessionProjectionRegistry and AgentModel, with controlled Session events and no live model or UI. No runtime profile was touched.'},null,2))
}finally{await rm(dir,{recursive:true,force:true})}
