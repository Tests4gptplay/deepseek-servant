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
const initialReceipt = process.argv[2] ?? 'baseline', expected = 'candidate', mode = process.argv[3] ?? 'native'
assert.ok(['baseline', 'candidate'].includes(initialReceipt))
assert.ok(['baseline', 'candidate'].includes(expected)); assert.ok(['native', 'ptc'].includes(mode))
const directory = await fs.mkdtemp(join(process.env.DSS_EVIDENCE_ROOT ?? tmpdir(), 'w036-initial-consume-')), checks = [], errors = [], pushes = [], observations = []
const sha = value => createHash('sha256').update(value).digest('hex')
const scriptSha256 = sha(await fs.readFile(new URL(import.meta.url)))
const check = (name, actual, wanted) => { assert.deepEqual(actual, wanted, name); checks.push(name) }
const until = async (name, read) => {
  const end = Date.now() + 30000
  for (;;) { const result = await read(); if (result) return result; if (Date.now() > end) throw Error('Normal test boundary not reached: ' + name); await new Promise(resolve => setTimeout(resolve, 10)) }
}
const g = gitFixture(join(directory, 'objects.git'), 'sha1', async command => {
  if (command.op !== 'push') return
  pushes.push(command.commit)
  const row = rt && [...rt.roleRecords.values()].find(row => row.identity.role === 'Foreground')
  if (!row || persistedLog !== undefined) return
  const path = records.change(rt.prefix + 'roles/' + sha(row.identity.workId), {}).path
  let proposed
  try { proposed = JSON.parse(body(command.commit, path)).value } catch { return }
  if (!proposed.completedRound) return
  const session = sdk.ctx.sessions.get(row.sessionId)
  assert.ok(session, 'Actual original native Session still exists before role completion commit')
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
  foreground = await until('normal Foreground stopped', () => { const row = [...rt.roleRecords.values()].find(row => row.identity.role === 'Foreground'); return row?.completedRound && row.stopped ? row : undefined })
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
  const request = foreground.delivery?.request ?? foreground.lastWake
  assert.ok(request, 'Original Foreground accepted wake is retained for exact audit')
  const signals = [...new Set(request.sources.filter(source => source.path.startsWith('state/') && source.path.split('/').at(-1) !== 'recovery').map(source => source.path))].sort()
  const consumeId = 'consume-wake/' + sha(JSON.stringify([config.member, typeof request.context?.originalWake === 'string' ? request.context.originalWake : request.id, signals]))
  const originalCommandId = 'conversation/git/' + config.collaborationId + '/' + consumeId
  const consumePath = 'technical/command-receipts/' + sha(originalCommandId) + '.json'
  const receipt = JSON.parse(body(beforeFinish, consumePath))
  check('real ordinary initial claim receipt has exact identity', receipt.id, originalCommandId)
  check('real ordinary initial claim receipt has no Task owner', receipt.taskOwner, undefined)
  const wakeKey = rt.prefix + 'wakes/' + sha(request.id), wakePath = records.change(wakeKey, {}).path
  await until('existing normal wake retirement', async () => await records.get(wakeKey) === undefined)
  await until('existing native retirement settled', () => !rt.roleRecords.get(foreground.identity.workId)?.nativeRetirements?.length)
  const retiredHead = head(), history = g.git(['rev-list', '--reverse', beforeFinish + '..' + retiredHead]).toString().trim().split('\n')
  const wakeRetirement = history.find(commit => {
    const paths = g.git(['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=D', '-r', commit]).toString().trim().split('\n').map(path => path.replace(/^dss-coop\//, ''))
    return paths.includes(wakePath)
  })
  assert.ok(wakeRetirement, 'Accepted existing wake deletion commit is in real main history')
  const wakeChanges = g.git(['diff-tree', '--no-commit-id', '--name-only', '-r', wakeRetirement]).toString().trim().split('\n').map(path => path.replace(/^dss-coop\//, ''))
  check('normal initial consume receipt retained only in baseline', filesAt(retiredHead).includes(consumePath), initialReceipt === 'baseline')
  check('same original wake retirement contains only owned deletions', wakeChanges.sort(), [wakePath, ...(initialReceipt === 'candidate' ? [consumePath] : [])].sort())
  check('completed memory is unchanged after initial receipt retirement', body(retiredHead, rt.conversation.foregroundRoot + '/Foreground_Cache.md'), 'Original memory.\nNormal second write.\n')
  observations.push({ initialReceipt, directory, originalCommandId, consumePath, wakePath, wakeRetirement, wakeChanges, retiredHead, receipt })
  observations.push({ mode, expected, foreground, beforeFinish, finalCommit, changes, recordCalls, unrelatedReceipts: beforeReceipts, commits: commits.length, gitOperations: Object.fromEntries([...new Set(g.events.map(e => e.op))].map(op => [op, g.events.filter(e => e.op === op).length])) })
  console.log(JSON.stringify({ status: 'passed', initialReceipt, directory, expected, mode, scriptSha256, assertions: checks.length, checks, observations, nativeEvents: retainedNativeEvents, nativeJsonl: persistedLog, nativeJsonlSha256: sha(persistedLog), limits: 'Real SDK AgentLoop with deterministic normal model responses, production FrameworkRoleRuntime/Host/conversation/tools, real JSONL flush and local Git CLI objects/CAS. Git transport authority is a controlled acquisition port. No failure injection, remote GitHub, Windows or unknown-outcome acceptance. Only Foreground normal completion is a candidate.', ...evidence() }, null, 2))
} finally {
  await rt?.dispose(); await sdk?.ctx.get('nativeSessionCleaner')?.drain(); await lp?.dispose(); await jp?.dispose(); await sdk?.close(); await g.files.close?.(); await g.repo.releaseCache(); hooks.deregister(); // Preserve original bare Git and native JSONL evidence.
}
