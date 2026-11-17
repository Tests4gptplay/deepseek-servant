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
const cleaner = await import('../src/native-cleaner/plugin.mjs')
const { sessionDirectory } = await import('../src/native-cleaner/jsonl-adapter.mjs')
const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog')
const expected = process.argv[2] ?? 'candidate', mode = process.argv[3] ?? 'native'
assert.ok(['baseline', 'candidate'].includes(expected)); assert.ok(['native', 'ptc'].includes(mode))
const directory = await fs.mkdtemp(join(tmpdir(), 'dss-closed-receipts-')), checks = [], errors = [], pushes = [], observations = []
const sha = value => createHash('sha256').update(value).digest('hex')
const scriptSha256 = sha(await fs.readFile(new URL(import.meta.url)))
const check = (name, actual, wanted) => { assert.deepEqual(actual, wanted, name); checks.push(name) }
const until = async (name, read) => {
  const end = Date.now() + 30000
  for (;;) { const result = await read(); if (result) return result; if (Date.now() > end) throw Error('Normal test boundary not reached: ' + name); await new Promise(resolve => setTimeout(resolve, 10)) }
}
const finalResponseReady = Promise.withResolvers(), releaseFinalResponse = Promise.withResolvers()
let closingSession, releasedDuringStop = false, runningBeforeDispose = false, observedDisposedBeforeCompletion = false
const g = gitFixture(join(directory, 'objects.git'), 'sha1', async command => {
  if (command.op !== 'push') return
  pushes.push(command.commit)
  const row = rt && [...rt.roleRecords.values()].find(row => row.identity.role === 'Foreground')
  if (!row) return
  const path = records.change(rt.prefix + 'roles/' + sha(row.identity.workId), {}).path
  let proposed
  try { proposed = JSON.parse(body(command.commit, path)).value } catch { return }
  if (proposed.stopIntent?.phase === 'stopping' && !releasedDuringStop) {
    // Hold only this real transport response while the already-running model finishes normally.
    // No rejection or synthetic event: this orders two existing asynchronous ports.
    releasedDuringStop = true
    releaseFinalResponse.resolve()
    await sdk.ctx.agents.get(row.sessionId).whenIdle()
  }
  if (!proposed.completedRound || persistedLog !== undefined) return
  const session = closingSession
  assert.ok(session, 'Original actual Session reference captured while native was still running')
  observedDisposedBeforeCompletion = sdk.ctx.agents.get(row.sessionId) === undefined && sdk.ctx.sessions.get(row.sessionId) === undefined
  const file = join(sessionDirectory(join(directory, 'sessions'), session.header), 'session.v' + session.header.version + '.jsonl')
  persistedLog = await fs.readFile(file, 'utf8')
  persistedAtCommit = command.commit
})
const filesAt = revision => g.git(['ls-tree', '-r', '--name-only', revision]).toString().trim().split('\n').map(path => path.replace(/^dss-coop\//, ''))
const body = (revision, path) => g.git(['show', revision + ':dss-coop/' + path]).toString()
const head = () => g.git(['rev-parse', 'refs/heads/main']).toString().trim()
let rt, sdk, jp, lp, model, records, foreground, beforeFinish, finalCommit, retainedNativeEvents, persistedLog, persistedAtCommit
const recordCalls = [], toolValues = new Map()
class Model extends LlmAdapter {
  next = 0
  async *stream(input) {
    const step = this.next++
    if (step === 3) {
      beforeFinish = head()
      for (const call of recordCalls) check('receipt exists before normal round completes: ' + call, filesAt(beforeFinish).includes('technical/command-receipts/' + sha(input.sessionId + ':' + call) + '.json'), true)
      closingSession = sdk.ctx.sessions.get(input.sessionId)
      finalResponseReady.resolve()
      await releaseFinalResponse.promise
      yield { type: 'text-delta', index: 0, text: 'The requested memory was saved.' }
      yield { type: 'finish', reason: 'stop' }; return
    }
    assert.ok(step < 3, 'One normal Foreground round only')
    const name = step === 0 ? 'dss_snapshot' : 'dss_record'
    const args = step === 0 ? {} : { snapshotId: toolValues.get(input.sessionId).snapshotId,
      path: rt.conversation.foregroundRoot + '/Foreground_Cache.md', text: step === 1 ? 'Original memory.\n' : 'Normal second write.\n', append: step === 2 }
    const callId = 'normal-' + step
    const outer = mode === 'ptc' ? { name: 'run_code', input: { code: 'return await tools.' + name + '(' + JSON.stringify(args) + ')', description: 'Save the requested DSS memory.' } } : { name, input: args }
    yield { type: 'tool-call-delta', index: 0, name: outer.name, id: callId, argumentsDelta: JSON.stringify(outer.input) }
    yield { type: 'finish', reason: 'tool-calls' }
  }
}
try {
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
  model = new Model(); ctx.llm.registerAdapter(['normal-receipt-wire'], model)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call' && event.data.name === 'dss_record') recordCalls.push(String(event.data.callId))
    if (event.type === 'tool/ptc-dispatch-start' && event.data.name === 'dss_record') recordCalls.push(String(event.data.subCallId))
    const content = event.type === 'tool/result' ? event.data.message.content : event.type === 'tool/ptc-dispatch' ? event.data.content : undefined
    for (const block of content ?? []) if (block.type === 'text') { try { const value = JSON.parse(block.text); if (value?.snapshotId) toolValues.set(String(session.id), value) } catch {} }
    if (event.type === 'turn/end') retainedNativeEvents = session.snapshotEvents()
  })
  await cleaner.apply(ctx, {}, { onFailure: (error, stage) => errors.push({ stage, error: String(error) }) })
  records = new GitAuthorityStore(g.files, 'native-receipts-instance')
  const shared = new GitAuthorityStore(g.files, 'shared')
  const config = { scope: 'native-receipts', mode: 'git', member: 'A', primary: true, collaborationId: 'native-receipts', instanceUUID: randomUUID(), workerSeats: 1, workspace,
    foreground: { provider: 'normal-receipt-wire', model: 'scripted' }, background: { provider: 'normal-receipt-wire', model: 'scripted' } }
  rt = new FrameworkRoleRuntime(ctx, g.files, records, config, { sharedRecords: shared, members: () => ['A'], resources: () => [], heartbeat: async () => {}, error: (error, origin) => errors.push({ error: String(error), origin }) })
  await rt.conversation.send('normal-user-input', { id: 'normal-user-input', text: 'Save two short notes in your Foreground memory.', role: 'user', participantId: 'A', recipient: 'ai', createdAt: new Date().toISOString() }, { reevaluate: true, gitReplay: 'session-only' })
  await rt.start()
  await until('normal model reached its final response', () => closingSession)
  await finalResponseReady.promise
  runningBeforeDispose = sdk.ctx.agents.get(closingSession.id).status === 'running'
  check('actual native is running immediately before public Runtime.dispose', runningBeforeDispose, true)
  await rt.dispose()
  foreground = [...rt.roleRecords.values()].find(row => row.identity.role === 'Foreground')
  check('normal closure persisted Foreground completion and stop', !!foreground?.completedRound && !!foreground?.stopped, true)
  check('normal model finish was ordered during original stopping publication', releasedDuringStop, true)
  check('native owner and Session detached before completion push', observedDisposedBeforeCompletion, true)
  check('native completed naturally during closure', retainedNativeEvents.filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind, 'completed')
  check('native producer created two real record calls', recordCalls.length, 2)
  check('native command identity uses actual Session ID', String(foreground.sessionId).startsWith('dss-'), true)
  check('normal callback errors are absent', errors, [])
  const roleKey = rt.prefix + 'roles/' + sha(foreground.identity.workId), rolePath = records.change(roleKey, {}).path
  const commits = [...new Set(pushes)]
  finalCommit = commits.find(commit => {
    try { return JSON.parse(body(commit, rolePath)).value.completedRound === true && JSON.parse(body(g.git(['rev-parse', commit + '^']).toString().trim(), rolePath)).value.completedRound !== true } catch { return false }
  })
  assert.ok(finalCommit, 'Existing normal completedRound publication')
  check('native JSONL was read before the exact role completion push', persistedAtCommit, finalCommit)
  const storedRows = persistedLog.trim().split('\n').map(line => JSON.parse(line))
  for (const id of recordCalls) {
    const success = retainedNativeEvents.find(e => mode === 'ptc' ? e.type === 'tool/ptc-dispatch' && String(e.data.subCallId) === id && !e.data.isError : e.type === 'tool/result' && String(e.data.message.toolCallId) === id && !e.data.message.isError)
    assert.ok(success)
    const encoded = sessionFormatCatalog.encodeCurrentEvent(success)
    check('actual original JSONL already contains successful native event: ' + id, storedRows.some(row => { try { assert.deepEqual(row, encoded); return true } catch { return false } }), true)
  }
  const retirementPaths = recordCalls.map(id => 'technical/command-receipts/' + sha(foreground.sessionId + ':' + id) + '.json')
  for (const path of retirementPaths) check('exact receipt retained only in baseline: ' + path, filesAt(finalCommit).includes(path), expected === 'baseline')
  const changes = g.git(['diff-tree', '--no-commit-id', '--name-only', '-r', finalCommit]).toString().trim().split('\n').map(path => path.replace(/^dss-coop\//, '')).sort()
  check('existing role commit contains only role plus candidate exact deletes', changes, [rolePath, ...(expected === 'candidate' ? retirementPaths : [])].sort())
  const beforeReceipts = filesAt(beforeFinish).filter(path => path.startsWith('technical/command-receipts/') && !retirementPaths.includes(path))
  check('real initial consume produced an unrelated receipt', beforeReceipts.length > 0, true)
  for (const path of beforeReceipts) check('unrelated receipt preserved: ' + path, body(finalCommit, path), body(beforeFinish, path))
  check('real memory bytes survive combined retirement', body(finalCommit, rt.conversation.foregroundRoot + '/Foreground_Cache.md'), 'Original memory.\nNormal second write.\n')
  check('real ordinary or PTC success events retained for review', recordCalls.every(id => retainedNativeEvents.some(e => mode === 'ptc' ? e.type === 'tool/ptc-dispatch' && String(e.data.subCallId) === id && !e.data.isError : e.type === 'tool/result' && String(e.data.message.toolCallId) === id && !e.data.message.isError)), true)
  observations.push({ mode, expected, foreground, beforeFinish, finalCommit, changes, recordCalls, unrelatedReceipts: beforeReceipts, commits: commits.length, gitOperations: Object.fromEntries([...new Set(g.events.map(e => e.op))].map(op => [op, g.events.filter(e => e.op === op).length])) })
  console.log(JSON.stringify({ status: 'passed', expected, mode, scriptSha256, assertions: checks.length, checks, observations, nativeEvents: retainedNativeEvents, nativeJsonl: persistedLog, nativeJsonlSha256: sha(persistedLog), limits: 'Real SDK AgentLoop plus production public Runtime.dispose. Deterministic normal model final response is released during the real original stopping publication and the transport awaits native idle; this is controlled ordering of real asynchronous ports, not failure injection. Actual JSONL is read after SDK disposal and before the original completedRound push. Local Git CLI objects/CAS via controlled transport acquisition. No React/HTTP click, remote GitHub, Windows or unknown-outcome acceptance. Only Foreground retainClosedRound is under test.', ...evidence() }, null, 2))
} finally {
  await rt?.dispose(); await sdk?.ctx.get('nativeSessionCleaner')?.drain(); await lp?.dispose(); await jp?.dispose(); await sdk?.close(); await g.files.close?.(); await g.repo.releaseCache(); hooks.deregister(); await fs.rm(directory, { recursive: true, force: true })
}
