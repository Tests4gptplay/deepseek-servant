import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { evidence, hooks } from './test-support/dsh-sdk-runtime.mjs'
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
const { withSnapshot, withOperationChannel } = await import('../src/framework/transactions.ts')
const cleaner = await import('../src/native-cleaner/plugin.mjs')
const { sessionDirectory } = await import('../src/native-cleaner/jsonl-adapter.mjs')
const mode = process.argv[2] ?? 'native'; assert.ok(['native', 'ptc'].includes(mode))
const directory = await fs.mkdtemp(join(tmpdir(), 'dss-existing-direct-')), checks = [], errors = []
const sha = value => createHash('sha256').update(value).digest('hex')
const scriptSha256 = sha(await fs.readFile(new URL(import.meta.url)))
const check = (name, actual, wanted) => { assert.deepEqual(actual, wanted, name); checks.push(name) }
const turnsEnded = Promise.withResolvers()
const g = gitFixture(join(directory, 'objects.git'), 'sha1')
const head = () => g.git(['rev-parse', 'refs/heads/main']).toString().trim()
const pathsAt = revision => g.git(['ls-tree', '-r', '--name-only', revision]).toString().trim().split('\n').map(path => path.replace(/^dss-coop\//, ''))
const body = (revision, path) => g.git(['show', revision + ':dss-coop/' + path]).toString()
const oldBytes = await fs.readFile(new URL('./test-support/historical-55fe/installed-host.js', import.meta.url))
const oldSha256 = sha(oldBytes)
assert.equal(oldSha256, '5a84b25b7619486ea98e7e11b140d02c0a3848e48008ac3cc2dc71a2a5a5d47a')
const oldLines = oldBytes.toString().split('\n'), section = (start, end) => oldLines.slice(start - 1, end).join('\n')
const builderSource = [section(975, 980), section(1192, 1192), section(8431, 8438), 'return (async () => {', section(8859, 8871), '})()'].join('\n')
const oldBuilder = new Function('input', 'snapshot', 'files', builderSource)
const requests = ['first', 'second'].map(id => ({ id: 'existing-' + id, member: 'A', role: 'Planner', text: 'Deliver the result for retained item ' + id + '.', resultPath: 'results/' + id + '.md', recipientSignal: 'state/Foreground_' + id }))
let rt, sdk, jp, lp, records, initialCommit
const views = new Map(), readValues = new Map(), sessionEvents = new Map(), sessions = new Map(), steps = new Map(), operations = []
class Model extends LlmAdapter {
  async *stream(input) {
    const id = String(input.sessionId), step = steps.get(id) ?? 0; steps.set(id, step + 1)
    assert.ok(step < 3, 'Each retained Direct executes only snapshot/read/deliver before concludeTurn')
    const name = ['dss_snapshot', 'dss_read', 'dss_direct_deliver'][step]
    let args = {}
    if (step === 1) args = { snapshotId: views.get(id).snapshotId, path: views.get(id).binding.direct.inputPath }
    if (step === 2) {
      const text = readValues.get(id).text, header = JSON.parse(text.slice('# Direct task\n\n'.length).split('\n\n')[0])
      args = { snapshotId: views.get(id).snapshotId, resultPath: header.resultPath, recipientSignal: header.recipientSignal, text: 'Delivered ' + header.id + '.\n' }
    }
    const callId = 'normal-' + step
    operations.push({ sessionId: id, step, name, args })
    const outer = mode === 'ptc' ? { name: 'run_code', input: { code: 'return await tools.' + name + '(' + JSON.stringify(args) + ')', description: 'Finish this retained Direct delivery.' } } : { name, input: args }
    yield { type: 'tool-call-delta', index: 0, name: outer.name, id: callId, argumentsDelta: JSON.stringify(outer.input) }
    yield { type: 'finish', reason: 'tool-calls' }
  }
}
try {
  await withOperationChannel(g.files, 'foreground-write', () => withSnapshot(g.files, async snapshot => {
    const changes = []
    for (const input of requests) changes.push(...await oldBuilder(input, snapshot, g.files))
    await g.files.commit(snapshot, changes, 'Controlled retained inputs produced by exact historical builder')
  }))
  initialCommit = head()
  const workspace = join(directory, 'workspace'); await fs.mkdir(workspace)
  sdk = await openDshStorageFixture(join(directory, 'storage'), join(directory, 'locator'))
  const ctx = sdk.ctx
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx); new LlmRuntime(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx, ToolRuntime.Config({ mode })); new LocalJobRegistry(ctx, {})
  jp = ctx.plugin(jsonl, { root: join(directory, 'sessions'), compression: 'none' }); await jp.await()
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 1048576 }); new WorkingDirectoryService(ctx, { defaultDirectory: workspace })
  const wp = ctx.plugin(WorkspaceRegistry); await wp.await()
  if (mode === 'ptc') {
    const { LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
    const { LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
    const { SandboxPolicyService } = await import('@deepseek-ai/dsh-sandbox-policy')
    const { NodePtcRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')
    new LocalSubprocessRuntime(ctx); new LocalSandboxProvider(ctx, LocalSandboxProvider.Config({})); new SandboxPolicyService(ctx, SandboxPolicyService.Config({ workspaceRoot: workspace })); new NodePtcRuntime(ctx, NodePtcRuntime.Config({}))
  }
  lp = ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 }); await lp.await()
  ctx.llm.registerAdapter(['existing-direct-wire'], new Model())
  ctx.on('session/event', (session, event) => {
    const id = String(session.id); sessions.set(id, session); sessionEvents.set(id, session.snapshotEvents())
    if (sessionEvents.size === 2 && [...sessionEvents.values()].every(events => events.some(item => item.type === 'turn/end'))) turnsEnded.resolve()
    const content = event.type === 'tool/result' ? event.data.message.content : event.type === 'tool/ptc-dispatch' ? event.data.content : undefined
    for (const block of content ?? []) if (block.type === 'text') { try { const value = JSON.parse(block.text); if (value?.snapshotId) views.set(id, value); if (value?.path && value?.exists && typeof value.text === 'string') readValues.set(id, value) } catch {} }
  })
  await cleaner.apply(ctx, {}, { onFailure: (error, stage) => errors.push({ stage, error: String(error) }) })
  records = new GitAuthorityStore(g.files, 'existing-direct-instance')
  const shared = new GitAuthorityStore(g.files, 'shared')
  const config = { scope: 'existing-direct', mode: 'git', member: 'A', primary: false, collaborationId: 'existing-direct', instanceUUID: randomUUID(), workerSeats: 1, workspace,
    foreground: { provider: 'existing-direct-wire', model: 'scripted' }, background: { provider: 'existing-direct-wire', model: 'scripted' } }
  rt = new FrameworkRoleRuntime(ctx, g.files, records, config, { sharedRecords: shared, members: () => ['A'], resources: () => [], heartbeat: async () => {}, error: (error, origin) => errors.push({ error: String(error), origin }) })
  await rt.start()
  await turnsEnded.promise
  for (const id of sessionEvents.keys()) await ctx.agents.get(id).whenIdle()
  // Join the original lifecycle work only; never invoke either private completion guard.
  while (rt.workOperations?.size) await Promise.all([...rt.workOperations.values()])
  while (rt.maintenance?.size) await Promise.all([...rt.maintenance.values()])
  const beforeDispose = [...rt.roleRecords.values()].map(row => structuredClone(row)), deliveredCommit = head()
  check('two retained identities each opened one actual native session', new Set(beforeDispose.map(row => row.sessionId)).size, 2)
  check('two distinct role work identities remain separate', new Set(beforeDispose.map(row => row.identity.workId)).size, 2)
  check('only the exact existing Direct snapshot/read/deliver tools ran', operations.length, 6)
  for (const input of requests) {
    check('original historical-builder input preserved: ' + input.id, body(deliveredCommit, 'direct/' + input.id + '.md'), body(initialCommit, 'direct/' + input.id + '.md'))
    check('delivered exact independent result: ' + input.id, body(deliveredCommit, input.resultPath), 'Delivered ' + input.id + '.\n')
    check('recipient notification exists: ' + input.id, pathsAt(deliveredCommit).includes(input.recipientSignal), true)
    check('original initial input signal consumed: ' + input.id, pathsAt(deliveredCommit).includes('state/Planner_A_Direct_' + input.id), false)
  }
  const nativeJsonl = {}
  for (const [id, events] of sessionEvents) {
    check('native turn ended normally: ' + id, events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    const delivered = mode === 'native' ? events.some(event => event.type === 'tool/call' && event.data.name === 'dss_direct_deliver') : events.some(event => event.type === 'tool/ptc-dispatch-start' && event.data.name === 'dss_direct_deliver')
    check('real SDK emitted selected delivery call shape: ' + id, delivered, true)
    const call = events.find(event => event.type === (mode === 'native' ? 'tool/call' : 'tool/ptc-dispatch-start') && event.data.name === 'dss_direct_deliver')
    const result = mode === 'native'
      ? events.find(event => event.type === 'tool/result' && event.sourceEventSeqs?.includes(call.seq) && event.data.message.toolCallId === call.data.callId)
      : events.find(event => event.type === 'tool/ptc-dispatch' && event.data.subCallId === call.data.subCallId
        && event.data.parentCallId === call.data.parentCallId && event.data.rootCallId === call.data.rootCallId && event.data.name === call.data.name)
    check('delivery result follows its actual call: ' + id, result.seq > call.seq, true)
    check('actual delivery is successful: ' + id, mode === 'native' ? !!result.data.message.isError : !!result.data.isError, false)
    check('actual delivery output is not a pending-notification continuation: ' + id,
      mode === 'native' ? result.data.message.content : result.data.content, [{ type: 'text', text: 'null' }])
    const row = beforeDispose.find(row => row.sessionId === id)
    check('existing primary finish settled actual delivery: ' + id, row.gitSettledWakeId === row.lastWake.id, true)
    const session = sessions.get(id); check('actual SDK flush returns durable completion: ' + id, await ctx.sessions.flush(session), true)
    const file = join(sessionDirectory(join(directory, 'sessions'), session.header), 'session.v' + session.header.version + '.jsonl')
    nativeJsonl[id] = await fs.readFile(file, 'utf8')
  }
  await rt.dispose()
  const afterDispose = [...rt.roleRecords.values()].map(row => structuredClone(row))
  for (const row of afterDispose) {
    check('normal public dispose confirmed stopped: ' + row.sessionId, !!row.stopped, true)
    check('normal public dispose retains actual delivery completion: ' + row.sessionId, row.gitSettledWakeId === row.lastWake.id, true)
  }
  check('normal callback errors are absent', errors, [])
  console.log(JSON.stringify({ status: 'passed', mode, scriptSha256, oldSha256, builderSha256: sha(builderSource), assertions: checks.length, checks, initialCommit, deliveredCommit,
    beforeDispose, afterDispose, operations, nativeEvents: Object.fromEntries(sessionEvents), nativeJsonl, nativeJsonlSha256: Object.fromEntries(Object.entries(nativeJsonl).map(([id, bytes]) => [id, sha(bytes)])),
    gitOperations: Object.fromEntries([...new Set(g.events.map(event => event.op))].map(op => [op, g.events.filter(event => event.op === op).length])),
    limits: 'Current independent Runtime plus real SDK normal native/PTC delivery from two historical-source-produced controlled existing inputs. The exact old builder runs; old outer transaction, old Host, real user old-data provenance, upgrade, UI/preset mount, remote GitHub and Windows do not. Actual official ToolRuntime mode configuration selects the SDK mode; scoped preset mounting is static evidence only. Actual local Git objects/CAS use controlled transport acquisition. No error injection, fabricated native event, repeated source signal/initial claim, G38 change or downstream replay allegation. This probe validates only the existing completion guards.', ...evidence() }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ probeError: String(error), operations, errors, nativeEvents: Object.fromEntries(sessionEvents), roles: [...rt?.roleRecords.values() ?? []] }, null, 2))
  throw error
} finally {
  await rt?.dispose(); await sdk?.ctx.get('nativeSessionCleaner')?.drain(); await lp?.dispose(); await jp?.dispose(); await sdk?.close(); await g.files.close?.(); await g.repo.releaseCache(); hooks.deregister(); await fs.rm(directory, { recursive: true, force: true })
}
