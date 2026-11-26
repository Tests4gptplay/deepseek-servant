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
const { GitAuthorityStore, SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { paths, taskInitializationFiles } = await import('../src/framework/task-files.ts')
const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const cleaner = await import('../src/native-cleaner/plugin.mjs')
const root = await fs.mkdtemp(join(tmpdir(), 'dss-silent-round-'))
const workspace = join(root, 'workspace'), taskId = randomUUID()
const errors = [], native = [], helperInputs = [], toolResults = new Map(), steps = new Map()
const mode = process.argv[2] ?? 'local'
const repeat = process.argv[3] === 'repeat'
const organizer = process.argv[3] === 'organizer'
const controlled = mode === 'git' && process.argv.includes('--controlled-cas')
const childId = randomUUID()
assert(['local', 'git'].includes(mode))
let rt, task, sdk, jp, lp, files, git, records
async function until(label, observation, interval = 50) {
  const end = Date.now() + (mode === 'git' ? 240_000 : 30_000)
  while (Date.now() < end) {
    const answer = await observation()
    if (answer) return answer
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error(label + ': ' + JSON.stringify({ errors, native, helperInputs, restores: await records.list(rt.prefix + 'restores/'), roles: [...rt.roleRecords.values()], wakes: await records.list(rt.prefix + 'wakes/') }, null, 2))
}
function result(sessionId, name) {
  return toolResults.get(sessionId)?.findLast(x => x.name === name)?.value
}
class Model extends LlmAdapter {
  async *stream(input) {
    const sessionId = String(input.sessionId)
    const owner = [...rt.roleRecords.values()].find(row => row.sessionId === sessionId)
    assert(owner, 'Native input must be bound to a real role')
    // The real SDK has already delivered this input to the adapter. The
    // scripted model must not await a later Host/Git bookkeeping write.
    const { role, executionId, workerId } = owner.identity
    const key = sessionId + ':' + owner.delivery?.request.id
    const step = steps.get(key) ?? 0
    steps.set(key, step + 1)
    if (!step) native.push({ role, executionId, workerId, generation: owner.generation, wake: owner.delivery?.request.id })
    let call
    if (role === 'Planner' && owner.generation <= 2 || role === 'Worker') {
      if (step === 0) call = ['dss_claim', {}]
      else if (owner.generation === 2 && step === 1) call = ['dss_snapshot', {}]
      else if (!repeat && role === 'Planner' && owner.generation === 2 && step === 2
        && owner.delivery.request.reason === 'startup-recovery') {
        call = ['dss_worker_assign', { snapshotId: result(sessionId, 'dss_snapshot').snapshotId, childId: 'line-a',
          contract: 'Make the actual checkpoint.', decision: 'This is the next assigned role.' }]
      } else if (role === 'Worker' && owner.generation === 2 && step === 2) {
        call = ['dss_worker_deliver', { snapshotId: result(sessionId, 'dss_snapshot').snapshotId, reply: 'A new checkpoint after correction.' }]
      }
    }
    if (role === 'Planner' && step > 0 && result(sessionId, 'dss_claim')?.signals?.some(path => path.endsWith('/Planner_line-a-Worker-G2'))) {
      // Stop the fixture at the real receipt boundary. The next business action
      // is outside this test, not another scripted silent end to count.
      await new Promise((resolve, reject) => {
        if (input.signal.aborted) reject(input.signal.reason)
        else input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
      })
    }
    if (organizer && role === 'Organizer' && step === 0) call = ['dss_claim', {}]
    if (organizer && role === 'Helper' && step === 0) call = ['dss_claim', {}]
    if (organizer && role === 'Helper' && step === 1) {
      await new Promise((resolve,reject) => {
        if(input.signal.aborted) reject(input.signal.reason)
        else input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true})
      })
      return
    }
    if (role === 'Helper') {
      const first = owner.delivery?.request.context?.silentRound
      if (first?.target.role === 'Worker') {
        if (step === 0) call = ['dss_snapshot', { taskId }]
        else if (step === 1) call = ['dss_restore', { target: first.target, facts: 'Exact Worker ended before handoff.', hypotheses: 'No successor accepted.',
          actionsTaken: 'Read the running task and original notification.', continuation: 'Continue this Worker line and publish its checkpoint.' }]
      }
    }
    if (call) {
      const [name, args] = call
      yield { type: 'tool-call-delta', index: 0, name, id: randomUUID(), argumentsDelta: JSON.stringify(args) }
      yield { type: 'finish', reason: 'tool-calls' }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'End native round.' }
    yield { type: 'finish', reason: 'stop' }
  }
}

try {
  await fs.mkdir(workspace)
  sdk = await openDshStorageFixture(join(root, 'storage'), join(root, 'locator'))
  const ctx = sdk.ctx
  const ar = ctx.plugin(AgentRegistry); await ar.await(); new SessionStore(ctx); new SessionProjectionRegistry(ctx); new LlmRuntime(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); const te = ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native')); await te.await(); new LocalJobRegistry(ctx, {})
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
    results.push({ name, value, error: event.data.message.isError }); toolResults.set(key, results)
    if (value?.helperNotifications) helperInputs.push(...value.helperNotifications)
  })
  if (mode === 'local') {
    files = new PhysicalLocalFiles(join(root, 'records'))
    records = sdk.adapter
  } else {
    if (controlled) {
      const { Repository } = await import('./test-support/controlled-git/repository.mjs')
      const { GitConflictError } = await import('../src/experimental/private-git/github.ts')
      const repo = new Repository()
      const write = repo.commitPrepared.bind(repo)
      repo.commitPrepared = (snapshot, ...args) => {
        if (snapshot.head !== repo.head && !repo.accepted.has(args[2].id)) throw new GitConflictError()
        return write(snapshot, ...args)
      }
      files = new GitFiles(repo, new SessionGitOperations())
    } else {
      git = gitFixture(join(root, 'objects.git'), 'sha1', undefined, false, true)
      files = git.files
    }
    records = new GitAuthorityStore(files, 'silent-round-instance')
  }
  const config = { scope: 'silent-round', mode, member: 'A', primary: true, collaborationId: 'silent-round', instanceUUID: randomUUID(), workerSeats: 1, workspace,
    background: { provider: 'silent-round-wire', model: 'scripted' } }
  rt = new FrameworkRoleRuntime(ctx, files, records, config, { sharedRecords: mode === 'git' ? new GitAuthorityStore(files, 'shared') : records,
    members: () => ['A'], resources: () => [], heartbeat: async () => {}, error: (error, origin) => errors.push({ error: String(error), origin }) })
  task = { version: 1, taskId, route: organizer ? 'O' : 'P', owner: 'A', members: ['A'], status: 'running',
    sourcePath: 'tasks/' + taskId + '.md', archiveFolder: taskId }
  if(organizer) task.children=[{taskId:childId, objectiveId:'one', member:'A'}]
  const source = paths.state('A', taskId) + (organizer ? '/Organizer_Inbox' : '/Planner_Inbox')
  const changes = [{ path: paths.task(taskId), content: JSON.stringify(task) }, { path: task.sourcePath, content: 'Finish the real assigned checkpoint.' },
    ...taskInitializationFiles(task), { path: source, content: '' }]
    .filter((row, i, all) => all.findLastIndex(other => other.path === row.path) === i)
  if(organizer) changes.push({path:paths.task(childId),content:JSON.stringify({version:1, taskId:childId,route:'P',owner:'A',members:['A'],status:'running',
    sourcePath:'tasks/child.md',archiveFolder:childId,parent:{taskId,owner:'A',objectiveId:'one'}})})
  if (mode === 'local') for (const { path, content } of changes) await files.replace(path, content)
  else await rt.transactions.run('seed-silent-role', {}, { reevaluate: true }, async () => changes)
  await rt.start()
  if (organizer) {
    const workId = JSON.stringify(['Organizer', taskId, null, null])
    const role = await until('Organizer claims real state wake',()=>{const r=rt.roleRecords.get(workId);return r&&result(r.sessionId,'dss_claim')&&r})
    await until('Organizer native round classified as valid wait',()=>rt.roleRecords.get(workId)?.gitSettledWakeId===role.delivery.request.id)
    const getNotices = async()=> (await records.list(rt.prefix+'wakes/')).filter(x=>x.value.request.context?.silentRound?.target?.role==='Organizer')
    assert.deepEqual(await getNotices(),[],'An authoritative linked unfinished child is valid wait')
    const orphan={...task,children:[]}
    if(mode==='local')await files.replace(paths.task(taskId),JSON.stringify(orphan))
    else await rt.transactions.run('remove-linked-child-in-isolated-test',{}, {reevaluate:true},async()=>[{path:paths.task(taskId),content:JSON.stringify(orphan)}])
    // Re-notify from a real new signal/round, as the closed round itself was
    // valid when first classified. A new round now has no responsible child.
    const signal=paths.state('A',taskId)+'/Organizer_Owned'
    if(mode==='local')await files.replace(signal,'')
    else await rt.transactions.run('fresh-organizer-state',{}, {reevaluate:true},async()=>[{path:signal,content:''}])
    await until('same running O Task ends without valid continuation',async()=> (await getNotices()).find(x=>x.value.request.context.silentRound.target.taskId===taskId))
    console.log('PASS: '+mode+' Organizer linked child is valid wait; O without a continuation emits its exact Helper fault.')
  } else if (repeat) {
    await until('a repeated silent end is exposed to Helper', () => native.some(row => row.role === 'Helper' && row.wake.startsWith('silent-task-round:'))
      && native.filter(row => row.role === 'Planner').some(row => row.generation === 2)
      && native.filter(row => row.role === 'Helper' && row.wake.startsWith('silent-task-round:')).length >= 2)
    // Allow the original successor diagnostic to finish and existing Host
    // restoration ticks to settle; no identical stop/restart will be arranged.
    await new Promise(resolve => setTimeout(resolve, 2_300))
    const restores = (await records.list(rt.prefix + 'restores/')).map(row => row.value).filter(row => row.silentRound)
    const incidents = (await records.list(rt.prefix + 'wakes/')).map(row => row.value.request)
      .filter(request => request.context?.kind === 'task-silent-round')
    assert.equal(restores.length, 1)
    assert.deepEqual(incidents.map(item => item.context.repeated).sort(), [false, true])
    assert.equal(native.filter(row => row.role === 'Planner').length, 2)
    assert.deepEqual(errors, [])
    console.log('PASS: repeated silent end is another Helper diagnostic but no unconditional restart loop.')
  } else {
    const read = path => withSnapshot(files, snapshot => files.read(snapshot, path))
    await until('the corrected Worker actually completes the delivery tool', () => [...toolResults.values()].flat().some(call => call.name === 'dss_worker_deliver' && !call.error))
    assert.match(await read(paths.member(taskId, 'A') + '/workers/line-a/reply.md'), /A new checkpoint after correction\./)
    await until('the real Planner receives the Worker handoff', () => [...toolResults.values()].some(calls => calls.some(call => call.name === 'dss_claim' && call.value?.binding?.role === 'Planner' && call.value?.signals?.some(path => path.endsWith('/Planner_line-a-Worker-G2')))))
    const readWakes = async () => (await records.list(rt.prefix + 'wakes/')).map(row => row.value.request)
    await until('Helper follow-up is admitted with a real Worker handoff', async () => {
      const rows = await records.list(rt.prefix + 'wakes/')
      return rows.some(({ value }) => value.delivered && value.request.context?.kind === 'task-silent-round-progress'
        && value.request.context.evidence.kind === 'worker-handoff')
    }, 1000)
    const wakes = await readWakes()
    const incidents = wakes.filter(item => item.context?.kind === 'task-silent-round')
    assert.deepEqual(incidents.map(x => x.context.target.role).sort(), ['Planner', 'Worker'], 'Same boundary once; healthy Planner wait while its Worker line owns continuation is not a fault')
    const original = native.find(row => row.role === 'Planner' && row.generation === 1)
    const worker = native.find(row => row.role === 'Worker' && row.generation === 1)
    assert.equal(incidents.find(x => x.context.target.role === 'Planner').context.target.executionId, original.executionId)
    assert.equal(incidents.find(x => x.context.target.role === 'Worker').context.target.executionId, worker.executionId)
    assert(helperInputs.some(item => item.context?.target?.executionId === worker.executionId), 'Helper can read its exact incident using the production tool')
    assert.equal(native.filter(row => row.role === 'Helper' && row.wake.startsWith('silent-task-round:')).length, 2)
    const proof = wakes.find(item => item.context?.kind === 'task-silent-round-progress' && item.context.evidence.kind === 'worker-handoff')
    assert.equal(proof.context.originalTarget.executionId, worker.executionId)
    assert.notEqual(proof.context.target.executionId, worker.executionId)
    assert.equal(proof.context.evidence.recipient, 'Planner')
    const restores = (await records.list(rt.prefix + 'restores/')).map(row => row.value)
      .filter(row => row.silentRound)
    assert.equal(restores.length, 2, 'One existing scoped restore per boundary, regardless of whether Helper used the tool')
    assert.match(restores.find(x => x.silentRound.target.role === 'Planner').input.facts, /Helper ended/)
    assert.match(restores.find(x => x.silentRound.target.role === 'Worker').input.facts, /Exact Worker/)
    assert.deepEqual(errors, [])
    console.log('PASS: ' + mode + (controlled ? ' (controlled CAS transport)' : '') + ' actual DSH SDK idle/status -> scoped Helper -> correction -> Worker checkpoint -> Planner. Scripted model; no desktop, provider or remote GitHub test.')
  }
} finally {
  await rt?.dispose(); await sdk?.ctx.get('nativeSessionCleaner')?.drain()
  await lp?.dispose(); await jp?.dispose(); await sdk?.close(); await files?.close?.(); await git?.repo.releaseCache()
  hooks.deregister(); await fs.rm(root, { recursive: true, force: true })
}
