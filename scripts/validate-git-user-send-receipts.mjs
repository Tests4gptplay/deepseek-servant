// Actual FrameworkService send/sendStored/checkScope/prepareConversationWrite,
// FrameworkClientController, FrameworkConversation, FrameworkTransactions and
// GitFiles. Service construction/account acquisition and immutable Git transport
// are controlled ports. No real Host lifecycle, GUI, GitHub or Dulwich is run.
// Original-operation marker verification is separately covered by the existing
// validate-git-disconnect-cancellation.mjs; this repository resolves by accepted ID.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { Repository, put, head } from './test-support/controlled-git/repository.mjs'
const { FrameworkService } = await import(new URL('framework/service.ts', sourceRoot))
const { FrameworkConversation, foregroundNotification } = await import(new URL('framework/conversation.ts', sourceRoot))
const { FrameworkClientController } = await import(new URL('framework/client-contracts.ts', sourceRoot))
const { FrameworkTransactions } = await import(new URL('framework/command-transactions.ts', sourceRoot))
const { GitFiles, FilesOutcomeUnknownError } = await import(new URL('framework/transactions.ts', sourceRoot))
const { SessionGitOperations } = await import(new URL('framework/git-authority.ts', sourceRoot))
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts', sourceRoot))
const { GitConflictError } = await import(new URL('experimental/private-git/github.ts', sourceRoot))
const { GitCommitOutcomeUnknownError } = await import(new URL('experimental/private-git/contracts.ts', sourceRoot))
const digest = value => createHash('sha256').update(value).digest('hex')
const tick = () => new Promise(setImmediate)
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve } }
const scratch = await mkdtemp(join(tmpdir(), 'dss-user-send-'))
const handles = [], outcomes = []; let assertions = 0
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); assertions++; outcomes.push(name) }
async function rejects(name, action, expected) { await assert.rejects(action, expected); assertions++; outcomes.push(name) }
const receiptPath = path => path.includes('/command-receipts/') || path.includes('/.command-receipts/')
const input = (id, extra = {}) => ({ mode: 'git', collaborationId: 'shared', storageScope: 'test-scope', id,
  createdAt: '2026-11-10T09:00:00.000Z', timezoneOffsetMinutes: 0,
  text: 'Original complete user message ' + id, recipient: 'ai', device: 'dsh-web', ...extra })
function repository() {
  const repo = new Repository(), trace = { reads: [], commits: [], conflicts: 0, resolutions: [] }, controls = {}
  const commit = repo.commitPrepared.bind(repo)
  // Like production prepareCommit, equal scope/base/writes/message retain a
  // deterministic operation identity; do not randomize it in the fixture.
  for (const name of ['read', 'readBytes']) {
    const original = repo[name].bind(repo)
    repo[name] = async (snapshot, path) => { trace.reads.push(path); return original(snapshot, path) }
  }
  repo.commitPrepared = async (snapshot, changes, message, operation) => {
    trace.commits.push({ operation, paths: changes.map(row => row.path) })
    await tick(); await controls.before?.({ operation, changes })
    if (repo.head !== operation.expectedHead && !repo.accepted.has(operation.id)) { trace.conflicts++; throw new GitConflictError() }
    const loss = controls.loseAck; controls.loseAck = undefined
    if (loss === 'before') { repo.resolution = { status: 'unknown' }; throw new GitCommitOutcomeUnknownError(operation) }
    const result = await commit(snapshot, changes, message, operation)
    if (loss === 'after') { repo.resolution = { status: 'unknown' }; throw new GitCommitOutcomeUnknownError(operation) }
    return result
  }
  const resolve = repo.resolveCommit.bind(repo)
  repo.resolveCommit = async operation => { trace.resolutions.push(operation.id); return resolve(operation) }
  return { repo, trace, controls }
}
function handle(f, mode = 'git', local) {
  const rows = new Map(), records = { get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)),
    delete: async key => rows.delete(key), list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }
  const operations = new SessionGitOperations(), files = local ?? new GitFiles(f.repo, operations)
  const tx = new FrameworkTransactions(files, records, 'test-scope'), options = [], run = tx.run.bind(tx)
  tx.run = (id, request, option, build) => { options.push({ id, option: { ...option } }); return run(id, request, option, build) }
  const conversation = new FrameworkConversation(files, tx, { mode, collaborationId: 'shared' })
  const connection = { files, transactions: tx, scope: 'test-scope', identity: { login: 'member' }, prepareWrite: async () => {},
    ...(mode === 'git' ? { repository: { identity: { id: 'account-member', login: 'member' } } } : {}) }
  const access = { connection, conversation }
  // No constructor/bootstrap side effects. These acquisition and notification
  // ports are explicit substitutes; the four production send methods are intact.
  const service = Object.assign(Object.create(FrameworkService.prototype), { closed: false, modeSending: new Map(), conversationBarriers: new Map(), initializing: Promise.resolve(),
    access: async () => access, config: () => ({ settings: { collaborationId: 'shared', userName: 'member' } }), changed() {} })
  const value = { f, files, tx, operations, rows, options, conversation, service }; handles.push(value); return value
}
const daily = (f, day = '2026-11-10') => JSON.parse(f.repo.bodies.get('dss-coop/conversations/git/shared/' + day + '.json'))
const signal = value => 'state/' + foregroundNotification('member', new Date(value.createdAt), value.timezoneOffsetMinutes)
const noReceiptEffects = (name, f) => {
  check(name + ': no receipt read', f.trace.reads.some(receiptPath), false)
  check(name + ': no receipt write/delete', f.trace.commits.some(row => row.paths.some(receiptPath)), false)
}
try {
  for (const recipient of ['ai', 'human']) {
    const f = repository(), h = handle(f), message = input('normal-' + recipient, { recipient })
    await h.service.send(message)
    check(recipient + ': one actual daily original', daily(f).messages.map(row => [row.id, row.text]), [[message.id, message.text]])
    check(recipient + ': user Git path selects session-only', h.options.at(-1).option.gitReplay, 'session-only')
    check(recipient + ': existing notification semantics', f.repo.bodies.has('dss-coop/' + signal(message)), recipient === 'ai')
    check(recipient + ': actual reader retains text', (await h.conversation.read(message.id)).text, message.text)
    const before = f.trace.commits.length
    await h.service.send(message)
    check(recipient + ': same input rereads existing original without commit', f.trace.commits.length, before)
    noReceiptEffects(recipient, f)
    check(recipient + ': no replacement storage ledger', h.rows.size, 0)
  }
  {
    const f = repository(), h = handle(f), message = input('ui-retry'), sent = []; let loseResponse = true
    const controller = new FrameworkClientController({ send: async value => { sent.push(structuredClone(value)); const result = await h.service.send(value); if (loseResponse) { loseResponse = false; throw new Error('Controlled HTTP response lost after service completed') } return result } })
    await rejects('actual controller retains failed send after response loss', () => controller.send(message), /response lost/)
    check('UI failed state', controller.snapshot().drafts[0].state, 'failed')
    check('UI original frozen input', controller.snapshot().drafts[0].input, message)
    const committed = f.repo.calls.length
    await controller.send(controller.snapshot().drafts[0].input)
    check('UI retry dispatches exactly unchanged input', sent, [message, message])
    check('UI retry becomes sent', controller.snapshot().drafts[0].state, 'sent')
    check('UI retry adds no commit or notification', f.repo.calls.length, committed)
    await controller.send(message)
    check('UI sent draft not dispatched again', sent.length, 2)
    noReceiptEffects('UI retry', f)
  }
  {
    const f = repository(), first = handle(f), message = input('new-connection')
    await first.service.send(message)
    put(f.repo, signal(message), undefined); head(f.repo)
    await first.tx.closeGitSession(new Error('Controlled original connection closed')); first.operations.close()
    const next = handle(f), committed = f.repo.calls.length
    await next.service.send(message)
    check('new connection uses daily ID/body without prior operation', next.operations.rows.size, 0)
    check('new connection does not reappend', daily(f).messages.length, 1)
    check('new connection does not recreate consumed notification', f.repo.bodies.has('dss-coop/' + signal(message)), false)
    check('new connection match does not publish', f.repo.calls.length, committed)
    await rejects('same day/message ID with different business text rejects', () => next.service.send({ ...message, text: 'Different text' }), /different content/)
    check('mismatch preserves original', daily(f).messages[0].text, message.text)
    await rejects('original storage scope check remains', () => next.service.send({ ...message, storageScope: 'different' }), /destination changed/)
    await rejects('original collaboration check remains', () => next.service.send({ ...message, collaborationId: 'different' }), /selection changed/)
    noReceiptEffects('new connection', f)
  }
  {
    const f = repository(), a = handle(f), b = handle(f), message = input('same-id-race'), held = gate(); let started = 0
    f.controls.before = async () => { started++; if (started === 2) held.resolve(); await held.promise }
    await Promise.all([a.service.send(message), b.service.send(message)])
    check('two independent sends reached CAS together', started, 2)
    check('same scope/base/payload preserves deterministic operation identity', new Set(f.trace.commits.map(row => row.operation.id)).size, 1)
    check('competing same-ID publication is accepted once', f.repo.accepted.size, 1)
    check('competing same-ID publication keeps one message', daily(f).messages.length, 1)
    check('competing same-ID publication keeps one notification', [...f.repo.bodies.keys()].filter(path => path.startsWith('dss-coop/state/Foreground_')).length, 1)
    noReceiptEffects('same-ID CAS', f)
  }
  {
    const f = repository(), a = handle(f), b = handle(f), first = input('cas-first'), second = input('cas-second'), held = gate(); let started = 0
    f.controls.before = async () => { started++; if (started === 2) held.resolve(); await held.promise }
    await Promise.all([a.service.send(first), b.service.send(second)])
    check('different messages on same daily file produce one proven conflict', f.trace.conflicts, 1)
    check('different messages rebuild latest daily body without loss', daily(f).messages.map(row => row.id).sort(), [first.id, second.id].sort())
    check('different messages each have one accepted publication', f.repo.accepted.size, 2)
    check('same timestamp preserves both actual notification paths', [...f.repo.bodies.keys()].filter(path => path.startsWith('dss-coop/state/Foreground_')).length, 2)
    noReceiptEffects('different-message CAS', f)
  }
  for (const loss of ['before', 'after']) {
    const f = repository(), h = handle(f), message = input('unknown-' + loss)
    f.controls.loseAck = loss
    await rejects(loss + ': original send is UNKNOWN', () => h.service.send(message), FilesOutcomeUnknownError)
    const operationId = f.trace.commits[0].operation.id
    check(loss + ': original operation retained', h.tx.ownsGitAttempt('conversation/git/shared/client-message:' + message.id), true)
    if (loss === 'before') {
      // Advance main through another actual user send before the peer publishes
      // this same message. Otherwise deterministic scope/base/payload identity
      // would make the peer confirm the original operation, not conflict it.
      const peer = handle(f)
      await peer.service.send(input('independent-before-peer', { recipient: 'human' }))
      await peer.service.send(message)
      check('before: peer publication uses another base and operation', f.repo.accepted.has(operationId), false)
    }
    const commits = f.trace.commits.length
    // A peer's or the accepted operation's visible matching body is insufficient
    // to change this original still-unresolved operation into confirmed success.
    await rejects(loss + ': visible body cannot acknowledge original UNKNOWN', () => h.service.send(message), FilesOutcomeUnknownError)
    check(loss + ': no redispatch while original remains unknown', f.trace.commits.length, commits)
    check(loss + ': same original operation is resolved', f.trace.resolutions.at(-1), operationId)
    const independent = handle(f)
    await independent.service.send(message)
    check(loss + ': separate handle may observe current target', f.trace.commits.length, commits)
    await rejects(loss + ': independent observation does not settle original', () => h.service.send(message), FilesOutcomeUnknownError)
    f.repo.resolution = loss === 'after' ? undefined : { status: 'conflict', head: f.repo.head }
    await h.service.send(message)
    check(loss + ': proven outcome releases original attempt', h.tx.ownsGitAttempt('conversation/git/shared/client-message:' + message.id), false)
    check(loss + ': resolution/convergence does not republish', f.trace.commits.length, commits)
    check(loss + ': original text remains single', daily(f).messages.filter(row => row.id === message.id).map(row => row.text), [message.text])
    noReceiptEffects('UNKNOWN ' + loss, f)
  }
  {
    const f = repository(), h = handle(f), message = input('old-receipt')
    const command = 'conversation/git/shared/client-message:' + message.id
    const old = 'technical/command-receipts/' + digest(command) + '.json'
    // Produce a genuine preceding-version durable send and another command via
    // the unchanged default transaction path; retain their actual atomic bytes.
    const { mode, collaborationId, storageScope, ...body } = message
    await h.conversation.send('client-message:' + message.id, { ...body, role: 'user', participantId: 'account-member', username: 'member' }, { reevaluate: true })
    await h.tx.run('independent-old-command', {}, {}, async () => [{ path: 'old-independent.txt', content: 'Keep original' }])
    const actualOther = 'technical/command-receipts/' + digest('independent-old-command') + '.json'
    const expected = [f.repo.bodies.get('dss-coop/' + old), f.repo.bodies.get('dss-coop/' + actualOther)]
    check('preceding default send owns a valid original receipt', JSON.parse(expected[0]).id, command)
    check('preceding independent receipt is present', JSON.parse(expected[1]).id, 'independent-old-command')
    f.trace.reads.length = 0; f.trace.commits.length = 0
    await h.service.send(message); await h.service.send(message)
    check('old receipts remain byte-for-byte untouched', [f.repo.bodies.get('dss-coop/' + old), f.repo.bodies.get('dss-coop/' + actualOther)], expected)
    check('old-message match creates no replacement commit', f.trace.commits.length, 0)
    noReceiptEffects('retained old receipts', f)
  }
  {
    const files = new PhysicalLocalFiles(join(scratch, 'local')), h = handle(undefined, 'local', files), message = input('local', { mode: 'local' })
    await h.service.send(message); await h.service.send(message)
    check('Local actual physical send stays outside generic transactions', h.options.length, 0)
    check('Local original text remains readable', (await h.conversation.read(message.id)).text, message.text)
  }
  {
    const f = repository(), h = handle(f)
    await h.conversation.send('actual-ai-default-boundary', { id: 'ai-message', text: 'Original assistant reply', role: 'assistant', participantId: 'member', createdAt: '2026-11-10T09:01:00.000Z', recipient: 'human', responsePhase: 'final' }, { reevaluate: true })
    check('AI conversation entry keeps its original reevaluate option', h.options.at(-1).option.reevaluate, true)
    check('AI path default options unchanged', h.options.at(-1).option.gitReplay, undefined)
    await h.conversation.claimForegroundSignals('claim-default-boundary', ['state/Foreground_boundary'])
    check('notification claim keeps its original options', { reevaluate: h.options.at(-1).option.reevaluate, gitReplay: h.options.at(-1).option.gitReplay }, { reevaluate: true, gitReplay: undefined })
  }
  {
    const f = repository(), h = handle(f)
    const group = { id: 'foreground-process', turnId: 'session-turn', startedAt: '2026-11-10T09:00:00.000Z', closed: true }
    await h.conversation.saveProcessGroups('session', [group], 'member')
    check('process metadata uses session-only', h.options.at(-1).option.gitReplay, 'session-only')
    check('actual daily original keeps its process group', daily(f).processGroups[0].id, group.id)
    const before = f.trace.commits.length
    await h.conversation.saveProcessGroups('session', [group], 'member')
    check('same process group adds no new commit', f.trace.commits.length, before)
    noReceiptEffects('process metadata', f)
  }
  console.log(JSON.stringify({ status: 'passed', assertions, outcomes,
    limits: 'Actual full source Service prototype send methods, Controller, Conversation and transaction/GitFiles modules. Controlled acquisition, immutable-CAS repository and response failure; no Service constructor/Host bootstrap, React render, real network or Dulwich. AI boundary exercises actual Conversation default, not native AI execution. Cross-connection uses separate handles and closed volatile operation store; no process restart.',
    ...evidence() }, null, 2))
} finally {
  for (const h of handles) { await h.tx.closeGitSession(new Error('Controlled suite completion')); h.operations.close(); await h.files.close?.() }
  await rm(scratch, { recursive: true, force: true }); hooks.deregister()
}
