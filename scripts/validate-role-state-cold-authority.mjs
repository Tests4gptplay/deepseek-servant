import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { hooks } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
import { gitFixture } from './w129/real-git-cli-fixture.mjs'

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
const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { GitAuthorityStore } = await import('../src/framework/git-authority.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { paths, taskInitializationFiles } = await import('../src/framework/task-files.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const cleaner = await import('../src/native-cleaner/plugin.mjs')
const phase = process.argv[2], mode = process.argv[3]
if (!phase) {
  for (const m of ['local','git']) {
    const dir = await fs.mkdtemp(join(tmpdir(),'dss-authority-cold-'))
    try {
      for (const step of ['crash','resume']) {
        const child = spawnSync(process.execPath,[fileURLToPath(import.meta.url),step,m,dir],{stdio:'inherit',env:process.env,timeout:240000})
        assert.equal(child.status,step==='crash'?42:0, m+' '+step)
      }
    } finally {await fs.rm(dir,{recursive:true,force:true})}
  }
  process.exit(0)
}
const root = process.argv[4], workspace = join(root,'workspace')
const taskId = '09a3b30e-fa3f-4fde-91f4-bba50da06c88'
const errors = [], toolResults = new Map(), helperInputs = [], steps = new Map()
let rt, task, sdk, jp, lp, files, git, records
const result = (session,name) => toolResults.get(session)?.findLast(x=>x.name===name)?.value
async function until(label, check) {
  const end=Date.now()+90000
  while(Date.now()<end){const found=await check();if(found)return found;await new Promise(r=>setTimeout(r,30))}
  throw Error(label+': '+JSON.stringify({errors, roles:[...rt.roleRecords.values()].map(r=>[r.identity,r.sessionId,r.generation]), results:[...toolResults.entries()]}))
}
const headerFile = join(root,'previous.json')
class Model extends LlmAdapter {
  async *stream(input) {
    const id=String(input.sessionId), owner=[...rt.roleRecords.values()].find(r=>r.sessionId===id)
    assert(owner)
    const {role,workerId}=owner.identity
    if(mode==='git') await until('native input committed',()=>rt.roleRecords.get(owner.identity.workId)?.delivery?.confirmed)
    const step=steps.get(id)??0
    steps.set(id,step+1)
    let call
    if(phase==='crash' && role==='Worker' && workerId==='cold') {
      const ctx=sdk.ctx, agent=ctx.agents.get(id)
      assert(agent)
      const job=ctx.jobs.start({owner:id,kind:'bash',label:'producer interrupted by real process exit',
        run:()=>({cancel(){},done:new Promise(()=>{})})})
      await ctx.sessions.flush(agent.session)
      assert(agent.session.snapshotEvents().some(e=>e.type==='job/registered'&&e.data.jobId===job))
      assert(!agent.session.snapshotEvents().some(e=>e.type==='job/settled'&&e.data.jobId===job))
      await fs.writeFile(headerFile,JSON.stringify({owner,job}))
      process.exit(42)
    }
    if(role==='Planner' && phase==='crash' && owner.identity.taskId===taskId) {
      if(step===0)call=['dss_claim',{}]
      if(step===1)call=['dss_worker_assign',{snapshotId:result(id,'dss_claim').snapshotId,childId:'cold',contract:'Return durable fresh result.',decision:'Worker continuation'}]
    }
    if(phase==='resume' && role==='Worker' && workerId==='cold') {
      const prior=JSON.parse(await fs.readFile(headerFile,'utf8')).owner
      assert.notEqual(owner.identity.executionId,prior.identity.executionId)
      if(step===0)call=['dss_claim',{}]
      if(step===1)call=['dss_worker_deliver',{snapshotId:result(id,'dss_claim').snapshotId,reply:'fresh result after real crash'}]
    }
    if(phase==='resume'&&role==='Planner'&&step===0)call=['dss_claim',{}]
    if(call) {
      yield {type:'tool-call-delta',index:0,name:call[0],id:randomUUID(),argumentsDelta:JSON.stringify(call[1])}
      yield {type:'finish',reason:'tool-calls'}
      return
    }
    if(phase==='resume'&&role==='Planner'&&owner.identity.taskId===taskId&&result(id,'dss_claim')?.signals?.some(p=>p.includes('Planner_cold-Worker-'))) {
      await new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}))
      return
    }
    yield {type:'text-delta',index:0,text:'End fixture work.'}
    yield {type:'finish',reason:'stop'}
  }
}
try {
  await fs.mkdir(workspace,{recursive:true})
  sdk = await openDshStorageFixture(join(root, 'storage'), join(root, 'locator'))
  const ctx = sdk.ctx
  const ar = ctx.plugin(AgentRegistry); await ar.await(); new SessionStore(ctx); new SessionProjectionRegistry(ctx); new LlmRuntime(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); const te = ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native')); await te.await(); new LocalJobRegistry(ctx, {})
  const jobTools = ctx.plugin(await import('@deepseek-ai/dsh-tool-jobs')); await jobTools.await()
  jp = ctx.plugin(jsonl, { root: join(root, 'sessions'), compression: 'none' }); await jp.await()
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 1048576 })
  const wd = ctx.plugin(WorkingDirectoryService, { defaultDirectory: workspace }); await wd.await()
  const wp = ctx.plugin(WorkspaceRegistry); await wp.await()
  lp = ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 }); await lp.await()
  await cleaner.apply(ctx, {}, { onFailure: (error, stage) => errors.push({ error: String(error), stage }) })
  ctx.llm.registerAdapter(['silent-round-wire'], new Model())
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'tool/result') return
    const name = session.snapshotEvents().find(e => e.type === 'tool/call' && e.data.callId === event.data.message.toolCallId)?.data.name
    const raw = event.data.message.content.find(block => block.type === 'text')?.text
    let value; try { value = JSON.parse(raw) } catch { value = raw }
    if (event.data.message.isError) errors.push({ name, error: value })
    const key = String(session.id), results = toolResults.get(key) ?? []
    results.push({ name, value }); toolResults.set(key, results)
    if (value?.helperNotifications) helperInputs.push(...value.helperNotifications)
  })
  if (mode === 'local') {
    files = new PhysicalLocalFiles(join(root, 'records'))
    records = sdk.adapter
  } else {
    git = gitFixture(join(root, 'objects.git'), 'sha1', undefined, phase === 'resume', true)
    files = git.files
    records = new GitAuthorityStore(files, 'silent-round-instance')
  }
  const config = { scope: 'silent-round', mode, member: 'A', primary: true, collaborationId: 'silent-round', instanceUUID: '11111111-1111-4111-8111-111111111111', workerSeats: 1, workspace,
    background: { provider: 'silent-round-wire', model: 'scripted' } }
  rt = new FrameworkRoleRuntime(ctx, files, records, config, { sharedRecords: mode === 'git' ? new GitAuthorityStore(files, 'shared') : records,
    members: () => ['A'], resources: () => [], heartbeat: async () => {}, error: (error, origin) => errors.push({ error: String(error), origin }) })
  task = {version:1,taskId,route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/'+taskId+'.md',archiveFolder:taskId}
  if(phase==='crash') {
    const changes=[{path:paths.task(taskId),content:JSON.stringify(task)},{path:task.sourcePath,content:'Original Task'},
      ...taskInitializationFiles(task),{path:paths.state('A',taskId)+'/Planner_Inbox',content:''}]
      .filter((r,i,a)=>a.findLastIndex(x=>x.path===r.path)===i)
    if(mode==='local')for(const c of changes)await files.replace(c.path,c.content)
    else await rt.transactions.run('seed-authority',{}, {reevaluate:true},async()=>changes)
    await rt.start()
    await until('the old native producer starts',()=>false)
  } else {
    const {owner,job}=JSON.parse(await fs.readFile(headerFile,'utf8'))
    const {DshSessionReader}=await import('../src/adapters/dsh/sessions.ts')
    const readEvents=()=>new DshSessionReader(sdk.ctx).events(owner.sessionId)
    const events=await readEvents()
    assert(events.some(e=>e.type==='job/registered'&&e.data.jobId===job))
    assert(!events.some(e=>e.type==='job/settled'&&e.data.jobId===job))
    assert.equal(sdk.ctx.jobs.list(owner.sessionId).length,0)
    await rt.start()
    await until('Worker publishes fresh durable result',async()=> (await withSnapshot(files,s=>files.read(s,paths.member(taskId,'A')+'/workers/cold/reply.md')))?.includes('fresh result after real crash'))
    await until('Planner claims the real Worker handback',()=>[...toolResults.values()].flat().some(c=>c.name==='dss_claim'&&c.value?.signals?.some(p=>p.includes('Planner_cold-Worker-'))))
    assert(!(await readEvents()).some(e=>e.type==='job/settled'&&e.data.jobId===job),'Original producer history was not forged')
    console.log('PASS',mode,'real process exit, no old producer settlement, new Worker result and actual Planner claim')
  }
} finally {
  await rt?.dispose(); await sdk?.ctx.get('nativeSessionCleaner')?.drain()
  await lp?.dispose();await jp?.dispose();await sdk?.close();await files?.close?.();await git?.repo.releaseCache()
}
