import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ModeRouter } from '../src/mode-router/mode-router.js'
import { SharedForeground } from '../src/mode-router/shared-foreground.js'
import type { ServantView } from '../src/contracts/views.js'
import { foregroundMemoryPath } from '../src/experimental/private-git/protocol.js'
import { mergeRepositoryGuide } from '../src/experimental/private-git/repository-guide.js'
import { CoopSettingsSchema, type CoopSettings, type GitChange, type GitRepository, type GitSnapshot, type PendingDraft, type RepoConnection, type RoleBinding, type UserIntent } from '../src/experimental/private-git/contracts.js'
import type { CoopStore } from '../src/experimental/private-git/cache.js'
import { GitConflictError, GitHubClient, GitHubError, GitHubMembers, inspectPrivateRepo } from '../src/experimental/private-git/github.js'
import { digest, GitJournal, json, readJson, readText, textChanges } from '../src/experimental/private-git/journal.js'
import { CoopConsumer, type CoopAgentPort, type CoopPhysicalState } from '../src/experimental/private-git/consumer.js'
import { RoleWriter } from '../src/experimental/private-git/role-writer.js'
import { CoopNativeAgents } from '../src/experimental/private-git/native-agents.js'
import { isProtocolPath, legacySignal, readOutcome, signalDisposition } from '../src/experimental/private-git/outcome.js'
import { statusPath } from '../src/experimental/private-git/status.js'
import { CoopSync } from '../src/experimental/private-git/sync.js'
import { conversationPage } from '../src/experimental/private-git/conversation.js'
import { CoopService } from '../src/experimental/private-git/service.js'
import type { CoopCredentials } from '../src/experimental/private-git/credentials.js'
import { actionPath, executionPath, joinPath, planPath, roleCommandSchema, taskPath, type CoopCommand, type RoleAction, type RoleOutcome, type RootTask } from '../src/experimental/private-git/protocol.js'

const connection = (id: number): RepoConnection => ({ identity: { id, login: 'participant-' + id }, repository: {
  id: 77, fullName: 'example/private-collaboration', branch: 'main', private: true, permissions: { pull: true, push: true, admin: id === 1 },
} })
class MemoryStore implements CoopStore {
  instanceId: string
  settings = CoopSettingsSchema.parse({ ownerRepo: 'example/private-collaboration', workspace: process.cwd(), workerSeats: 2 })
  values = new Map<string, unknown>()
  constructor(id = 1) { this.instanceId = 'instance-' + id; this.values.set('connection', connection(id)) }
  async configure(settings: CoopSettings) { this.settings = settings }
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined }
  async put(key: string, value: unknown) { this.values.set(key, JSON.parse(JSON.stringify(value))) }
  async remove(key: string) { this.values.delete(key) }
  entries<T>(prefix: string): Array<[string, T]> { return [...this.values].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]> }
  connection() { return this.get<RepoConnection>('connection') }
  drafts() { return this.entries<PendingDraft>('draft/').map(([, value]) => value) }
  async close() {}
}
class MemoryRepo implements GitRepository {
  head = 'h0'; files = new Map<string, string>(); blobs = new Map<string, string>()
  writes: Array<{ head: string; changes: readonly GitChange[] }> = []
  offline = false; conflictOnce = false; loseReply = false
  async connect() { return connection(1) }
  async snapshot(): Promise<GitSnapshot> {
    if (this.offline) throw new GitHubError(0, 'network unavailable')
    return { head: this.head, tree: this.head, files: new Map(this.files) }
  }
  async read(snapshot: GitSnapshot, path: string) { const sha = snapshot.files.get(path); return sha ? this.blobs.get(sha) : undefined }
  async commit(base: GitSnapshot, changes: readonly GitChange[]) {
    if (this.offline) throw new GitHubError(0, 'network unavailable')
    if (this.conflictOnce) { this.conflictOnce = false; this.head = 'h-conflict'; throw new GitConflictError() }
    if (base.head !== this.head) throw new GitConflictError()
    for (const change of changes) {
      if (change.content === null) this.files.delete(change.path)
      else { const sha = digest(change.content); this.files.set(change.path, sha); this.blobs.set(sha, change.content) }
    }
    this.head = 'h' + (this.writes.length + 1)
    this.writes.push({ head: this.head, changes })
    if (this.loseReply) { this.loseReply = false; throw new GitHubError(0, 'connection lost after commit') }
    return { commit: this.head, replay: false }
  }
  async seed(changes: GitChange[]) { await this.commit(await this.snapshot(), changes) }
}
class Agents implements CoopAgentPort {
  starts: RoleAction[] = []
  states = new Map<string, CoopPhysicalState>()
  async start(action: RoleAction) {
    assert.equal(this.states.has(action.binding.executionId), false, 'execution is only started once')
    this.starts.push(action)
    this.states.set(action.binding.executionId, { busy: true, finished: false, transcript: '', jobs: [] })
  }
  state(id: string) { return this.states.get(id) }
  finish(action: RoleAction, transcript = 'Complete native assistant text') { this.states.set(action.binding.executionId, { busy: false, finished: true, transcript, jobs: [] }) }
  async release(id: string) { this.states.delete(id) }
  async dispose() { this.states.clear() }
  latest(role: string): RoleAction { const value = this.starts.filter(action => action.binding.role === role).at(-1); assert.ok(value, 'started ' + role); return value }
}
function instance(repo: MemoryRepo, id = 1) {
  const cache = new MemoryStore(id), journal = new GitJournal(repo, String(id)), agents = new Agents()
  let wakes = 0
  const consumer = new CoopConsumer({ repo, cache, journal: () => journal, agents, wake: () => { wakes++ } })
  return { cache, journal, agents, consumer, get wakes() { return wakes }, tick: async (count = 1) => { for (let n = 0; n < count; n++) await consumer.consume(await repo.snapshot()) } }
}
type Instance = ReturnType<typeof instance>
async function input(repo: MemoryRepo, target: Instance, id: string, text: string) {
  const source: UserIntent = { id, text, participantId: String(target.cache.connection()!.identity.id), instanceId: target.cache.instanceId, createdAt: new Date().toISOString() }
  await target.cache.put('user-source/' + id, source)
  const path = 'dss-coop/conversations/' + source.participantId + '/2026-10-26/' + id
  await repo.seed([...textChanges(path + '/text', text), { path: 'dss-coop/intents/' + source.participantId + '/' + id + '.json',
    content: json({ ...source, text: undefined, textPath: path + '/text' }) },
    { path: path + '/entry.json', content: json({ ...source, text: undefined, textPath: path + '/text', role: 'user' }) }])
}
async function write(target: Instance, action: RoleAction, command: CoopCommand) {
  const writer = target.consumer.writer, b = action.binding
  if (action.stateProtocol === 1 && command.op === 'outcome' && command.text) {
    const { text, memory, note, kind, resultStatus, ...rest } = command
    const record = await writer.execute(b, { op: 'entry', id: command.id + '-body', kind: b.role === 'planner' ? 'memory' : 'reply',
      text: [text, memory].filter(Boolean).join('\n') })
    const noteRecord = note ? await writer.execute(b, { op: 'entry', id: command.id + '-note', kind: 'note', text: note }) : undefined
    return writer.execute(b, { ...rest, turn_signal: command.turn_signal ?? legacySignal(b.role, command),
      ...(b.role === 'planner' ? { memoryPath: record.textPath } : { replyPath: record.textPath }),
      ...(noteRecord ? { notePath: noteRecord.textPath } : {}) })
  }
  return writer.execute(b, command)
}
const review = { reported: 'Produced the requested artifact', checked: 'Opened the actual artifact and ran the named check', discrepancy: 'None', decision: 'Accepted', next: 'Integrate the shared result' }
async function root(repo: MemoryRepo, target: Instance) {
  await input(repo, target, 'origin-1', 'Build the shared deliverable without changing accepted content.')
  await target.tick()
  assert.equal(target.agents.starts.length, 0, 'a dispatch write does not start an agent')
  await target.tick()
  const foreground = target.agents.latest('foreground')
  await write(target, foreground, { op: 'root', id: 'root', title: 'Shared deliverable', goal: 'Build the deliverable', initialPlan: 'Split, execute, review and integrate' })
  await write(target, foreground, { op: 'outcome', id: 'out', kind: 'handoff_planner', taskId: 'task-origin-1', text: 'I have created the collaboration task.', prerequisitePaths: [] })
  assert.equal(target.agents.starts.length, 1, 'a role outcome write alone does not dispatch the planner')
  target.agents.finish(foreground)
  await target.tick(2)
  return target.agents.latest('planner')
}

test('a malformed task stays isolated, keeps one error record, and recovers after the record is repaired', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  const contract = taskPath('broken') + '/contract.json', joined = joinPath('broken', '1', target.cache.instanceId)
  await repo.seed([{ path: contract, content: '{malformed' },
    { path: joined, content: json({ taskId: 'broken', participantId: '1', instanceId: target.cache.instanceId, state: 'paused' }) }])
  await target.tick()
  const retained = target.cache.values.size
  await target.tick(10)
  assert.equal(target.cache.values.size, retained)
  assert.equal(target.cache.entries('read-error/').length, 1)
  assert.equal(repo.writes.length, 1)
  await input(repo, target, 'healthy-input', 'Continue a separate conversation.')
  await target.tick(2)
  assert.equal(target.agents.latest('foreground').binding.sourceIntentId, 'healthy-input')
  await repo.seed([{ path: contract, content: json({ id: 'broken', status: 'active', coordinatorParticipantId: '1' }) }])
  await target.tick()
  assert.equal(target.cache.get('read-error/' + contract), undefined)
})

test('mode default isolates Git, selection persists, and switching does not dispose background endpoints', async () => {
  let selected: 'LOCAL' | 'PRIVATE_GIT_EXPERIMENTAL' = 'LOCAL', gitCalls = 0, localCalls = 0
  const router = new ModeRouter({ read: () => selected, write: async mode => { selected = mode } }, {
    LOCAL: { call: async () => ++localCalls }, PRIVATE_GIT_EXPERIMENTAL: { call: async () => ++gitCalls },
  })
  await router.call('LOCAL', 'view', {})
  assert.equal(gitCalls, 0)
  await router.select('PRIVATE_GIT_EXPERIMENTAL')
  assert.throws(() => router.call('LOCAL', 'send', {}), /mode changed/)
  await router.call('LOCAL', 'view', {})
  await router.call('PRIVATE_GIT_EXPERIMENTAL', 'send', {})
  assert.equal(localCalls, 2); assert.equal(gitCalls, 1)
})

test('Git journal rebases a competing HEAD, deduplicates lost replies and preserves large Unicode text', async () => {
  const repo = new MemoryRepo(), journal = new GitJournal(repo, '1'), text = 'x'.repeat(65535) + '🌠' + '正文'.repeat(60000)
  repo.conflictOnce = true
  await journal.transact('large', { body: text }, async () => textChanges('dss-coop/records/large', text))
  assert.equal(await readText(repo, await repo.snapshot(), 'dss-coop/records/large'), text)
  repo.loseReply = true
  await assert.rejects(journal.transact('reply-loss', { text: 'stable' }, async () => [{ path: 'dss-coop/records/stable.json', content: 'stable' }]), /lost after commit/)
  const count = repo.writes.length
  assert.equal((await journal.transact('reply-loss', { text: 'stable' }, async () => { throw new Error('must not rebuild committed data') })).replay, true)
  assert.equal(repo.writes.length, count)
  await assert.rejects(journal.transact('reply-loss', { text: 'different' }, async () => []), /reused/)
})

test('private repository and actual account checks stop public writes and redact token-bearing errors', async () => {
  const requests: string[] = [], secret = 'private-example-secret'
  let privateRepo = true, account = 1
  const client = new GitHubClient(async () => ({ value: secret, source: 'native' }), async url => {
    requests.push(url)
    if (url.endsWith('/user')) return Response.json({ id: account, login: 'participant-' + account })
    return Response.json({ id: 77, full_name: 'example/private-collaboration', private: privateRepo, default_branch: 'main', permissions: { push: true, admin: true } })
  })
  await client.session(session => inspectPrivateRepo(session, { ownerRepo: 'example/private-collaboration', repositoryId: 77, participantId: 1 }))
  privateRepo = false
  await assert.rejects(client.session(session => inspectPrivateRepo(session, { ownerRepo: 'example/private-collaboration' })), /public/)
  privateRepo = true; account = 2
  await assert.rejects(client.session(session => inspectPrivateRepo(session, { ownerRepo: 'example/private-collaboration', participantId: 1 })), /account changed/)
  const broken = new GitHubClient(async () => ({ value: secret, source: 'native' }), async () => { throw new Error('request failed ' + secret) })
  await assert.rejects(broken.session(session => session.request('GET', '/user')), error => !String(error).includes(secret) && String(error).includes('[redacted]'))
  assert.ok(requests.every(url => !url.includes(secret)))
})

test('GitHub invitation states follow actual responses and collaborators pagination', async () => {
  let accepted = false
  const client = new GitHubClient(async () => ({ value: 'secret', source: 'native' }), async (url, options) => {
    if (url.endsWith('/user')) return Response.json({ id: 1, login: 'owner' })
    if (url.includes('/collaborators?')) {
      const page = new URL(url).searchParams.get('page')
      return Response.json(page === '1' ? Array.from({ length: 100 }, (_, n) => ({ id: n + 1, login: 'member-' + n, permissions: { push: true } })) : [{ id: 101, login: 'last', permissions: { push: true } }])
    }
    if (options?.method === 'PUT') return accepted ? new Response(null, { status: 204 }) : Response.json({ id: 31 })
    return Response.json({ id: 77, full_name: 'example/private-collaboration', private: true, default_branch: 'main', permissions: { admin: true } })
  })
  const members = new GitHubMembers(client, () => ({ ownerRepo: 'example/private-collaboration' }))
  assert.equal((await members.invite('member')).status, 'pending')
  accepted = true
  assert.equal((await members.invite('member')).status, 'accepted')
  assert.equal((await members.collaborators()).length, 101)
})

test('a Worker without a task assignment does not run', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  const forged: RoleBinding = { participantId: '1', instanceId: target.cache.instanceId, role: 'worker', actionId: 'forged', executionId: 'forged-execution',
    sessionId: 'forged-session', generation: 1, epoch: 1, fence: 'forged', outputPath: 'dss-coop/forged/outcome.json' }
  await repo.seed([{ path: actionPath(forged), content: json({ id: 'forged', binding: forged, state: 'active', input: 'run a remote command', trigger: 'fake', createdAt: '' }) }])
  await target.tick(2)
  assert.equal(target.agents.starts.length, 0)
})

test('three independent participants execute through readback, review, seal and separate cleanup commits', async () => {
  const repo = new MemoryRepo(), a = instance(repo, 1), b = instance(repo, 2), c = instance(repo, 3)
  const plannerA = await root(repo, a), taskId = 'task-origin-1'
  for (const [target, id] of [[b, 'join-b'], [c, 'join-c']] as const) {
    await input(repo, target, id, 'Assist participant-1 with the shared deliverable.')
    await target.tick(2)
    const fg = target.agents.latest('foreground')
    await write(target, fg, { op: 'join', id: 'join', taskId, scope: 'Help build the stated deliverable using this local workspace', capabilities: 'Implementation and verification' })
    await write(target, fg, { op: 'outcome', id: 'out', kind: 'handoff_planner', taskId, text: 'Joined the shared task.', prerequisitePaths: [] })
    target.agents.finish(fg); await target.tick(2)
  }
  const targets = [a, b, c]
  const works = targets.map((target, n) => ({ id: 'part-' + (n + 1), title: 'Bounded part ' + (n + 1), direction: 'Produce the assigned artifact', acceptance: 'Artifact opens and targeted test passes',
    participantId: String(n + 1), instanceId: target.cache.instanceId, version: 1 }))
  await write(a, plannerA, { op: 'root_plan', id: 'assign', expectedRevision: 0, works })
  for (let n = 0; n < targets.length; n++) {
    const target = targets[n]!, planner = target.agents.latest('planner'), work = works[n]!
    await write(target, planner, { op: 'claim', id: 'claim', workId: work.id, assignmentVersion: 1, scope: 'This matches my local user’s accepted scope.' })
    await write(target, planner, { op: 'participant_plan', id: 'plan', expectedRevision: 0, children: [{
      id: 'child-' + (n + 1), workId: work.id, assignmentVersion: 1, title: work.title, direction: work.direction, acceptance: work.acceptance, dependencies: [],
    }] })
    await write(target, planner, { op: 'outcome', id: 'out', kind: 'plan_ready', text: 'Ready for bounded implementation', memory: 'Complete Planner memory ' + (n + 1), note: 'Current bounded plan and later integration', prerequisitePaths: [] })
    target.agents.finish(planner)
    const count = target.agents.starts.length
    await target.tick()
    assert.equal(target.agents.starts.length, count, 'staging a Worker does not start it')
    await target.tick()
    const worker = target.agents.latest('worker')
    await write(target, worker, { op: 'entry', id: 'progress', kind: 'reply', text: 'Complete checkpoint text for participant ' + (n + 1) })
    await write(target, worker, { op: 'outcome', id: 'out', kind: 'result', resultStatus: 'done', text: 'Artifact and exact verification evidence ' + (n + 1), prerequisitePaths: [] })
    target.agents.finish(worker, 'Full Worker visible transcript ' + (n + 1))
    await target.tick(2)
    const reviewer = target.agents.latest('planner')
    await write(target, reviewer, { op: 'review', id: 'review', childId: 'child-' + (n + 1), expectedRevision: 1,
      resultExecutionId: worker.binding.executionId, accepted: true, review })
    await write(target, reviewer, { op: 'report', id: 'report', workId: work.id, assignmentVersion: 1, review, text: 'Verified participant report ' + (n + 1) })
    if (n !== 0) {
      await write(target, reviewer, { op: 'outcome', id: 'out', kind: 'wait', text: 'Waiting for coordinator integration', memory: 'All local children accepted', note: 'Review complete; wait for root result', prerequisitePaths: [] })
      target.agents.finish(reviewer); await target.tick()
    }
  }
  const coordinator = a.agents.latest('planner')
  await write(a, coordinator, { op: 'accept', id: 'accept', expectedRevision: 1, review, text: 'Integrated actual results from three participants' })
  await write(a, coordinator, { op: 'outcome', id: 'out', kind: 'complete', text: 'Shared deliverable completed', memory: 'Final coordinator memory', note: 'All current assignments accepted', prerequisitePaths: [] })
  a.agents.finish(coordinator)
  for (const target of targets) await target.tick()
  await a.tick(2)
  const delivery = a.agents.latest('foreground')
  assert.equal(delivery.binding.taskId, taskId)
  await write(a, delivery, { op: 'outcome', id: 'deliver', kind: 'respond', text: 'All three contributions are integrated. Here are the final artifact references.', prerequisitePaths: [] })
  a.agents.finish(delivery)
  await a.tick(2)
  const sealed = await repo.snapshot()
  assert.ok(sealed.files.has('dss-coop/records/' + taskId + '/manifest.json'))
  assert.ok(sealed.files.has(taskPath(taskId) + '/contract.json'), 'sealing preserves work tree until another confirmed read')
  await a.tick()
  const cleaned = await repo.snapshot()
  assert.ok(![...cleaned.files.keys()].some(path => path.startsWith(taskPath(taskId) + '/')))
  const conversation = await conversationPage(repo, new MemoryStore(), cleaned, '1')
  assert.ok(conversation.messages.some(message => message.text === 'All three contributions are integrated. Here are the final artifact references.'), 'the delivered reply remains readable after task cleanup')
  const manifest = await readJson<{ recordsPath: string }>(repo, cleaned, 'dss-coop/records/' + taskId + '/manifest.json')
  const records = await readText(repo, cleaned, manifest!.recordsPath)
  assert.match(records, /Build the shared deliverable without changing accepted content/)
  for (let n = 1; n <= 3; n++) {
    assert.ok(records.includes('Complete Planner memory ' + n))
    assert.ok(records.includes('Complete checkpoint text for participant ' + n))
    assert.ok(records.includes('Full Worker visible transcript ' + n))
    assert.ok(records.includes('Verified participant report ' + n))
  }
  assert.ok(cleaned.files.has('dss-coop/history/' + taskId + '.json'))
  assert.ok([...cleaned.files.keys()].some(path => path.startsWith('dss-coop/origins/' + taskId + '/')))
  for (const target of targets) {
    await target.tick(2)
    assert.equal(target.cache.get('grant/' + taskId), undefined)
    assert.equal(target.cache.entries('user-source/').length, 0, 'archived tasks release their local input bodies')
    assert.equal(target.cache.entries('staged/').length, 0)
    assert.equal(target.cache.entries('replacement/').length, 0)
    assert.equal(target.cache.entries('proof/' + taskPath(taskId) + '/').length, 0)
    assert.ok(target.cache.entries('consumed-input/').length > 0, 'compact consumption progress survives cleanup')
  }
})

test('GitHub requests abort stalled transport at the operation deadline', async () => {
  let observed: AbortSignal | undefined
  const client = new GitHubClient(async () => ({ value: 'test-token', source: 'test' }), async (_url, init) => {
    observed = init?.signal ?? undefined
    return await new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test transport exceeded its bounded wait')), 100)
      observed?.addEventListener('abort', () => { clearTimeout(timer); reject(observed!.reason) }, { once: true })
    })
  }, 10)
  await assert.rejects(client.session(session => session.request('GET', '/user')), /timeout/i)
  assert.equal(observed?.aborted, true)
})

test('failed native admission does not leave a phantom physical owner', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  const start = target.agents.start.bind(target.agents)
  target.agents.start = async () => { throw new Error('Native startup unavailable') }
  await input(repo, target, 'admission', 'Hello')
  await target.tick(2)
  assert.equal(target.cache.entries('physical/').length, 0)
  assert.ok(target.cache.entries('read-error/').length > 0)
  target.agents.start = start
  await target.tick()
  assert.ok(target.agents.latest('foreground'))
  assert.equal(target.cache.entries('physical/').length, 1)
})

test('closed foreground actions do not repeat consumed-input Git transactions', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'closed-input', 'Hello')
  await target.tick(2)
  const fg = target.agents.latest('foreground')
  const reply = await write(target, fg, { op: 'entry', id: 'body', kind: 'reply', text: 'Hello back' })
  await write(target, fg, { op: 'outcome', id: 'reply', turn_signal: 'respond', replyPath: reply.textPath, prerequisitePaths: [] })
  target.agents.finish(fg)
  await target.tick(2)
  let transactions = 0
  const transact = target.journal.transact.bind(target.journal)
  target.journal.transact = (id, request, build) => {
    if (id.startsWith('consume-')) transactions++
    return transact(id, request, build)
  }
  await target.tick(3)
  assert.equal(transactions, 0)
})

test('a conflicting draft preserves its error while a later healthy draft still commits', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'draft-isolation', 'Hello')
  await target.tick(2)
  const fg = target.agents.latest('foreground')
  const conflicting = executionPath(fg.binding) + '/entries/broken/reply/source.json'
  await repo.seed([{ path: conflicting, content: 'Existing immutable evidence' }])
  await assert.rejects(write(target, fg, { op: 'entry', id: 'broken', kind: 'reply', text: 'Conflicting draft' }), /immutable/)
  repo.offline = true
  await assert.rejects(write(target, fg, { op: 'entry', id: 'healthy', kind: 'reply', text: 'Healthy reply' }), /network/)
  repo.offline = false
  await target.consumer.writer.retryDrafts()
  assert.equal(await repo.read(await repo.snapshot(), conflicting), 'Existing immutable evidence')
  assert.equal(await readText(repo, await repo.snapshot(), executionPath(fg.binding) + '/entries/healthy/reply'), 'Healthy reply')
  assert.equal(target.cache.drafts().length, 1)
  assert.match(target.cache.drafts()[0].error ?? '', /immutable/)
})

test('offline role output is a draft, then reconciles once without dispatching from its write callback', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'short', 'Hello')
  await target.tick(2)
  const fg = target.agents.latest('foreground')
  const reply = await write(target, fg, { op: 'entry', id: 'body', kind: 'reply', text: 'Hello back' })
  repo.offline = true
  await assert.rejects(write(target, fg, { op: 'outcome', id: 'reply', turn_signal: 'respond', replyPath: reply.textPath, prerequisitePaths: [] }), /network/)
  assert.equal(target.cache.drafts().length, 1)
  assert.equal(target.agents.starts.length, 1)
  repo.offline = false
  await target.consumer.writer.retryDrafts()
  assert.equal(target.cache.drafts().length, 0)
  assert.equal(target.agents.starts.length, 1)
  target.agents.finish(fg); await target.tick()
  assert.equal((await readJson<RoleAction>(repo, await repo.snapshot(), actionPath(fg.binding)))?.state, 'closed')
})

test('replaced assignment rejects late results while preserving their pending evidence', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  const planner = await root(repo, target), taskId = 'task-origin-1'
  const work = { id: 'part', title: 'Part', direction: 'Bounded work', acceptance: 'Targeted check', participantId: '1', instanceId: target.cache.instanceId, version: 1 }
  await write(target, planner, { op: 'root_plan', id: 'rp', expectedRevision: 0, works: [work] })
  await write(target, planner, { op: 'claim', id: 'claim', workId: work.id, assignmentVersion: 1, scope: 'Same scope' })
  await write(target, planner, { op: 'participant_plan', id: 'plan', expectedRevision: 0, children: [{ id: 'child', workId: work.id, assignmentVersion: 1, title: 'Child', direction: 'Work', acceptance: 'Check', dependencies: [] }] })
  await write(target, planner, { op: 'outcome', id: 'out', kind: 'plan_ready', text: 'Ready', memory: 'Memory', note: 'Note', prerequisitePaths: [] })
  target.agents.finish(planner); await target.tick(2)
  const worker = target.agents.latest('worker')
  await repo.seed([{ path: taskPath(taskId) + '/plan.json', content: json({ revision: 2, works: [{ ...work, version: 2, direction: 'Revised bounded work' }] }) }])
  await assert.rejects(write(target, worker, { op: 'outcome', id: 'late', kind: 'result', resultStatus: 'done', text: 'Old evidence', prerequisitePaths: [] }), /assignment changed/)
  assert.equal((target.cache.drafts()[0] as { stale?: boolean }).stale, true)
  assert.equal((await repo.snapshot()).files.has(worker.binding.outputPath), false)
})

test('conversation pages reuse immutable projections and retain older complete messages', async () => {
  const repo = new MemoryRepo(), cache = new MemoryStore()
  const changes: GitChange[] = []
  for (let n = 0; n < 75; n++) {
    const id = String(n).padStart(4, '0'), path = 'dss-coop/conversations/1/2026-10-26/' + id
    changes.push(...textChanges(path + '/text', 'Complete original ' + id), { path: path + '/entry.json', content: json({ id, role: 'user', createdAt: id, textPath: path + '/text' }) })
  }
  await repo.seed(changes)
  let reads = 0
  const read = repo.read.bind(repo); repo.read = async (...args) => { reads++; return read(...args) }
  const snapshot = await repo.snapshot(), first = await conversationPage(repo, cache, snapshot, '1')
  assert.equal(first.messages.length, 50); assert.equal(first.messages[0]!.id, '0025')
  const used = reads
  assert.deepEqual(await conversationPage(repo, cache, snapshot, '1'), first)
  assert.equal(reads, used, 'unchanged immutable messages require no blob reads')
  const older = await conversationPage(repo, cache, snapshot, '1', first.moreBefore)
  assert.equal(older.messages.length, 25); assert.equal(older.moreBefore, undefined)
  assert.equal(older.messages[0]!.text, 'Complete original 0000')
})

test('semantic command errors retire their evidence instead of blocking synchronization', async () => {
  const repo = new MemoryRepo(), target = instance(repo), planner = await root(repo, target)
  await assert.rejects(write(target, planner, { op: 'claim', id: 'invalid', workId: 'missing', assignmentVersion: 1, scope: 'Bounded work' }), /assignment/)
  await target.consumer.writer.retryDrafts()
  assert.equal(target.cache.drafts().length, 0)
  assert.ok([...repo.files.keys()].some(path => path.includes('/late-evidence/') && path.endsWith('/incident.json')))
  await write(target, planner, { op: 'outcome', id: 'corrected', kind: 'wait', text: 'Wait for assignment', memory: 'Original scope', note: 'Await current assignment', prerequisitePaths: [] })
  target.agents.finish(planner); await target.tick()
})

test('cold consumption resumes the exact saved Worker and respects explicit participation pause', async () => {
  const repo = new MemoryRepo(), target = instance(repo), planner = await root(repo, target), taskId = 'task-origin-1'
  const work = { id: 'part', title: 'Part', direction: 'Keep saved progress', acceptance: 'Finish artifact', participantId: '1', instanceId: target.cache.instanceId, version: 1 }
  await write(target, planner, { op: 'root_plan', id: 'rp', expectedRevision: 0, works: [work] })
  await write(target, planner, { op: 'claim', id: 'claim', workId: 'part', assignmentVersion: 1, scope: 'Same local scope' })
  await write(target, planner, { op: 'participant_plan', id: 'plan', expectedRevision: 0, children: [{ id: 'child', workId: 'part', assignmentVersion: 1, title: 'Child', direction: 'Continue', acceptance: 'Complete', dependencies: [] }] })
  await write(target, planner, { op: 'outcome', id: 'out', kind: 'plan_ready', text: 'Ready', memory: 'Saved memory', note: 'Saved frontier', prerequisitePaths: [] })
  target.agents.finish(planner); await target.tick(2)
  const worker = target.agents.latest('worker')
  await write(target, worker, { op: 'entry', id: 'checkpoint', kind: 'reply', text: 'Completed first segment, retained file exists' })
  await target.agents.dispose()
  const agents = new Agents(), consumer = new CoopConsumer({ repo, cache: target.cache, journal: () => target.journal, agents, wake() {} })
  await consumer.consume(await repo.snapshot())
  assert.deepEqual(agents.latest('worker').binding, worker.binding)
  assert.equal(agents.starts.filter(value => value.binding.role === 'worker').length, 1)
  await input(repo, target, 'pause', 'Pause my work')
  await target.tick(2)
  const fg = target.agents.latest('foreground')
  await write(target, fg, { op: 'control', id: 'pause', taskId, expectedRevision: 1, state: 'pause' })
  await write(target, fg, { op: 'outcome', id: 'paused', kind: 'respond', text: 'Paused', prerequisitePaths: [] })
  target.agents.finish(fg)
  const fresh = new Agents(), paused = new CoopConsumer({ repo, cache: target.cache, journal: () => target.journal, agents: fresh, wake() {} })
  await paused.consume(await repo.snapshot())
  assert.equal(fresh.starts.filter(value => value.binding.role === 'worker').length, 0)
})

for (const role of ['foreground', 'planner', 'worker'] as const) test('cold ' + role + ' resumes its native Session and queues the same role with saved progress once', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  if (role === 'foreground') { await input(repo, target, 'wake', 'Continue the requested task'); await target.tick(2) }
  else if (role === 'planner') await root(repo, target)
  else await plannedChild(repo, target)
  const action = target.agents.latest(role), b = action.binding
  const progress = await write(target, action, { op: 'entry', id: 'before-restart', kind: role === 'planner' ? 'memory' : 'reply', text: 'Saved progress before interruption' })
  await target.agents.dispose()
  const resumed: string[] = [], messages: any[] = [], sections: string[] = []
  let flushed = 0
  const scope = { systemPrompt: { section: (section: { text: string }) => sections.push(section.text) },
    tools: { schemas: () => [], register() {} }, on() {}, get() {}, effect() {} }
  const ctx = {
    get(name: string) { return name === 'sessionPersistence' ? { stat: async (id: string) => id === b.sessionId ? { id } : undefined } : undefined },
    sessions: { async flush() { flushed++ } },
    agents: {
      get() {},
      async create() { assert.fail('saved native Session must resume') },
      async resume({ resumeSessionId, setup }: any) {
        resumed.push(resumeSessionId)
        const agent = { id: resumeSessionId, ctx: scope, status: 'running', inbox: { nextTurn: [], nextStep: [] },
          session: { snapshotEvents: () => [], deriveMessages: () => [] }, followup(message: unknown) { messages.push(message) }, cancel() {} }
        await setup(scope, agent)
        return { agent, async dispose() {} }
      },
    },
  }
  const native = new CoopNativeAgents(ctx as any, target.cache)
  const cold = new CoopConsumer({ repo, cache: target.cache, journal: () => target.journal, agents: native, wake() {} })
  try {
    await cold.consume(await repo.snapshot())
    await cold.consume(await repo.snapshot())
    assert.deepEqual(resumed, [b.sessionId])
    assert.equal(messages.length, 1); assert.equal(flushed, 1)
    assert.match(messages[0].content[0].text, /^Resume the same local role after Host restart\./)
    const context = JSON.parse(messages[0].content[0].text.split('\n').slice(1).join('\n'))
    assert.deepEqual(context.binding, b)
    assert.ok(sections.includes(await readFile('src/experimental/private-git/prompts/' + role + '.md', 'utf8')))
    assert.equal(await readText(repo, await repo.snapshot(), progress.textPath!), 'Saved progress before interruption')
    assert.equal(native.state(b.executionId)?.busy, true)
  } finally { await cold.dispose() }
})

test('Planner questions reach Foreground once and a genuine goal revision authorizes its own new scope', async () => {
  const repo = new MemoryRepo(), target = instance(repo), planner = await root(repo, target), taskId = 'task-origin-1'
  await write(target, planner, { op: 'outcome', id: 'ask', kind: 'wait', question: 'Which output directory should this task use?', text: 'Need a directory', memory: 'Preserve existing content', note: 'Wait for local answer', prerequisitePaths: [] })
  target.agents.finish(planner); await target.tick(2)
  const question = target.agents.latest('foreground')
  assert.equal(question.binding.sourceIntentId, undefined)
  assert.equal((question.input as { question?: boolean }).question, true)
  await write(target, question, { op: 'outcome', id: 'question', kind: 'respond', text: 'Which output directory?', prerequisitePaths: [] })
  target.agents.finish(question); await target.tick(2)
  assert.equal(target.agents.starts.filter(value => value.id === question.id).length, 1)
  await input(repo, target, 'revision', 'Use the chosen output directory and keep the accepted artifacts.')
  await target.tick(2)
  const fg = target.agents.latest('foreground')
  await write(target, fg, { op: 'revise', id: 'revise', taskId, expectedRevision: 1, goal: 'Use the chosen output directory, preserve accepted artifacts.' })
  await write(target, fg, { op: 'outcome', id: 'handoff', kind: 'handoff_planner', taskId, text: 'Continue with this revision', prerequisitePaths: [] })
  target.agents.finish(fg); await target.tick(2)
  const context = await target.consumer.context(await repo.snapshot(), target.agents.latest('planner')) as { participationPath: string }
  const participation = await readJson<{ goalRevision: number; sourceIntentId: string }>(repo, await repo.snapshot(), context.participationPath)
  assert.equal(participation!.goalRevision, 2)
  assert.equal(participation!.sourceIntentId, 'revision')
})

test('settings can return to an earlier value and archived tasks remain visible', async () => {
  const cache = new MemoryStore(), repo = new MemoryRepo()
  const credentials = { describe: async () => ({ configured: false, writable: false }) } as unknown as CoopCredentials
  const service = new CoopService(cache, credentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo })
  for (const workerSeats of [2, 3, 2, 3, 2]) {
    await service.configure({ workerSeats }); await service.sync()
    assert.equal((await readJson<{ workerSeats: number }>(repo, await repo.snapshot(), 'dss-coop/instances/' + cache.instanceId + '/status.json'))!.workerSeats, workerSeats)
  }
  await repo.seed([{ path: 'dss-coop/history/accepted.json', content: json({ id: 'accepted', title: 'Accepted artifact', coordinator: '1', status: 'accepted' }) }])
  await service.sync()
  assert.deepEqual((await service.view()).tasks, [{ id: 'accepted', title: 'Accepted artifact', coordinator: '1', status: 'accepted' }])
})

test('consecutive native failures stay bounded even when their execution identifiers differ', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await root(repo, target)
  for (let n = 0; n < 4; n++) {
    const planner = target.agents.latest('planner')
    target.agents.states.set(planner.binding.executionId, { busy: false, finished: true, transcript: '', jobs: [], error: 'Provider rejected request for ' + planner.binding.executionId })
    await target.tick(2)
  }
  assert.equal(target.agents.starts.filter(action => action.binding.role === 'planner').length, 4)
  assert.match(target.cache.get<string>('runtime-error')!, /Provider rejected request/)
  await target.consumer.retryNative(); await target.tick(2)
  const retry = target.agents.latest('planner')
  await write(target, retry, { op: 'outcome', id: 'fixed', kind: 'wait', text: 'Provider recovered', memory: 'Preserved task', note: 'Await assignment', prerequisitePaths: [] })
  target.agents.finish(retry); await target.tick()
  assert.equal(target.cache.entries('native-error/').length, 0)
})

test('normal settings correction resumes a failed native action without clearing hidden state', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await root(repo, target)
  for (let n = 0; n < 4; n++) {
    const planner = target.agents.latest('planner')
    target.agents.states.set(planner.binding.executionId, { busy: false, finished: true, transcript: '', jobs: [], error: 'Invalid model route' })
    await target.tick(2)
  }
  const blocked = target.agents.latest('planner').binding.executionId
  const service = new CoopService(target.cache, {} as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo })
  service.attach(target.consumer)
  await service.configure({ provider: 'corrected', model: 'available' })
  await service.sync(); await target.tick(2)
  assert.notEqual(target.agents.latest('planner').binding.executionId, blocked)
  assert.equal(target.cache.get('runtime-error'), undefined)
})

test('a late connection response cannot restore a repository the user already changed', async () => {
  const cache = new MemoryStore(), repo = new MemoryRepo()
  let complete!: (value: RepoConnection) => void
  const response = new Promise<RepoConnection>(resolve => { complete = resolve })
  repo.connect = () => response
  const service = new CoopService(cache, {} as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo })
  const connecting = service.connect()
  const settled = connecting.catch(error => error)
  await service.configure({ ownerRepo: 'example/another-private-repository' })
  complete(connection(1))
  await settled
  assert.equal(cache.settings.ownerRepo, 'example/another-private-repository')
  assert.equal(cache.connection(), undefined)
})

test('one damaged unrelated task cannot block healthy Coop dispatch and projection', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await root(repo, target)
  await repo.seed([{ path: 'dss-coop/tasks/broken/contract.json', content: '{broken' }])
  const service = new CoopService(target.cache, { describe: async () => ({ configured: true, writable: true }) } as unknown as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo })
  service.attach(target.consumer)
  await service.sync()
  assert.equal((await service.view()).tasks.some(task => task.id === 'task-origin-1'), true)
})

test('malformed conversation and action records leave healthy foreground work available and recover after removal', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await root(repo, target)
  const badMessage = 'dss-coop/conversations/1/2026-10-26/bad/entry.json'
  const badAction = 'dss-coop/tasks/broken/actions/1/' + target.cache.instanceId + '/bad.json'
  await repo.seed([{ path: badMessage, content: '{broken' }, { path: badAction, content: '{broken' }])
  await input(repo, target, 'fresh', 'A healthy new message')
  await target.tick(2)
  assert.equal(target.agents.latest('foreground').binding.sourceIntentId, 'fresh')
  const page = await conversationPage(repo, target.cache, await repo.snapshot(), '1')
  assert.ok(page.messages.some(message => message.text === 'A healthy new message'))
  assert.equal(target.cache.entries('read-error/').length, 2)
  await repo.seed([{ path: badMessage, content: null }, { path: badAction, content: null }])
  const service = new CoopService(target.cache, { describe: async () => ({ configured: true, writable: true }) } as unknown as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo })
  service.attach(target.consumer)
  await service.sync()
  assert.equal((await service.view()).error, undefined)
})

test('closed input cleanup releases its body and retry copies without replay after restart or resend', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'cleanup-input', 'Keep this original message in Git')
  await target.tick(2)
  const foreground = target.agents.latest('foreground')
  await write(target, foreground, { op: 'outcome', id: 'reply', kind: 'respond', text: 'Saved reply', prerequisitePaths: [] })
  target.agents.finish(foreground)
  await target.tick(2)
  assert.equal(target.cache.get('user-source/cleanup-input'), undefined)
  assert.equal(target.cache.get('user-confirmed/cleanup-input'), undefined)
  assert.equal(target.cache.get('admission/' + actionPath(foreground.binding)), undefined)
  assert.equal(target.cache.entries('staged/').length, 0)
  assert.ok(target.cache.get('consumed-input/cleanup-input'))
  const agents = new Agents(), consumer = new CoopConsumer({ repo, cache: target.cache, journal: () => target.journal, agents, wake() {} })
  await consumer.consume(await repo.snapshot())
  assert.equal(agents.starts.length, 0)
  const service = new CoopService(target.cache, { describe: async () => ({ configured: true, writable: true }) } as unknown as CoopCredentials,
    new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo })
  assert.deepEqual(await service.send({ id: 'cleanup-input', text: 'Keep this original message in Git' }), { id: 'cleanup-input', state: 'CONFIRMED', commit: repo.head })
  await assert.rejects(service.send({ id: 'cleanup-input', text: 'Different input' }), /reused/)
  assert.equal(target.cache.drafts().length, 0)
  assert.ok(repo.files.has(foreground.binding.outputPath))
})

test('closed foreground cleanup retains input required by a continuing task', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await root(repo, target)
  await target.tick()
  assert.equal(target.cache.get('user-source/origin-1'), undefined, 'continuation reads the committed original from Git')
  assert.ok(target.cache.get('consumed-input/origin-1'), 'the same input must not spawn a second foreground')
  assert.ok(target.cache.get('grant/task-origin-1'))
  assert.equal(target.agents.starts.filter(action => action.binding.role === 'foreground').length, 1)
})

test('Git change intake is metadata-only and survives local cache loss without duplicate dispatch', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  const sourcePath = 'dss-coop/requests/goal.md'
  await repo.seed([{ path: sourcePath, content: 'Preserve this exact remote requirement.' }])
  const notice = { from: 'h0', to: repo.head, changes: [{ path: sourcePath, status: 'A' as const, commit: repo.head }] }
  const reads: string[] = [], originalRead = repo.read.bind(repo)
  repo.read = async (snapshot, path) => { reads.push(path); return originalRead(snapshot, path) }
  await target.consumer.notifyChanges(notice)
  await target.consumer.notifyChanges(notice)
  await target.tick(2)
  assert.equal(reads.includes(sourcePath), false)
  assert.equal(target.agents.starts.length, 1)
  const first = target.agents.latest('foreground')
  const context = await target.consumer.context(await repo.snapshot(), first) as Record<string, unknown>
  assert.equal(context.committedInput, undefined)
  assert.equal((await readJson<{ head: string }>(repo, await repo.snapshot(), 'dss-coop/instances/' + target.cache.instanceId + '/watch.json'))!.head, notice.to)
  const restarted = instance(repo)
  await restarted.tick()
  const recovered = restarted.agents.latest('foreground')
  assert.equal(recovered.binding.executionId, first.binding.executionId)
  await write(restarted, recovered, { op: 'root', id: 'remote-root', title: 'Remote goal', goal: 'Perform the requested work', initialPlan: 'Read then execute', sourcePath })
  const tasks = [...repo.files.keys()].filter(path => /^dss-coop\/tasks\/[^/]+\/contract.json$/.test(path))
  assert.equal(tasks.length, 1)
  const task = await readJson<RootTask>(repo, await repo.snapshot(), tasks[0]!)
  assert.equal(task!.sourcePath, sourcePath)
  assert.equal(await readText(repo, await repo.snapshot(), task!.originPath), 'Preserve this exact remote requirement.')
})

test('unchanged idle synchronization creates no native execution and reads no task documents', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  target.cache.settings = { ...target.cache.settings, remoteEnabled: true }
  await repo.seed([{ path: 'dss-coop/reference.md', content: 'On-demand only.' }])
  Object.defineProperty(repo, 'changes', { value: async () => [] })
  const service = new CoopService(target.cache, {} as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo })
  service.attach(target.consumer)
  const reads: string[] = [], originalRead = repo.read.bind(repo)
  repo.read = async (snapshot, path) => { reads.push(path); return originalRead(snapshot, path) }
  await service.sync(); await service.sync()
  assert.equal(reads.includes('dss-coop/reference.md'), false)
  assert.equal(target.agents.starts.length, 0)
})

async function plannedChild(repo: MemoryRepo, target: Instance, signal: 'done' | 'rework' | 'wait' = 'done') {
  const planner = await root(repo, target)
  const work = { id: 'part', title: 'Part', direction: 'Bounded work', acceptance: 'Open the artifact', participantId: '1', instanceId: target.cache.instanceId, version: 1 }
  await write(target, planner, { op: 'root_plan', id: 'rp', expectedRevision: 0, works: [work] })
  await write(target, planner, { op: 'claim', id: 'claim', workId: work.id, assignmentVersion: 1, scope: 'Same scope' })
  await write(target, planner, { op: 'participant_plan', id: 'plan', expectedRevision: 0, children: [
    { id: 'child', workId: work.id, assignmentVersion: 1, title: 'Child', direction: 'Work', acceptance: 'Check', dependencies: [] },
  ] })
  await write(target, planner, { op: 'outcome', id: 'out', turn_signal: signal, text: 'Planning finished', prerequisitePaths: [] })
  await target.tick(2)
  return planner
}

test('CAH role signals have explicit routing and remain compatible with committed 0.2.0 outcomes', async () => {
  for (const signal of ['done', 'rework']) assert.equal(signalDisposition('planner', signal)?.kind, 'plan_ready')
  assert.equal(signalDisposition('planner', 'handoff')?.kind, 'continue')
  assert.equal(signalDisposition('planner', 'complete')?.kind, 'complete')
  for (const signal of ['wait', 'need_user', 'error']) assert.equal(signalDisposition('planner', signal)?.kind, 'wait')
  assert.equal(signalDisposition('worker', 'continue')?.kind, 'continue')
  assert.deepEqual(signalDisposition('worker', 'complete'), { kind: 'result', resultStatus: 'done' })
  for (const signal of ['blocked', 'error']) assert.deepEqual(signalDisposition('worker', signal), { kind: 'result', resultStatus: 'failed' })
  assert.equal(signalDisposition('worker', 'done'), undefined)
  const repo = new MemoryRepo(), target = instance(repo)
  const planner = await root(repo, target)
  delete planner.stateProtocol
  await repo.seed([{ path: actionPath(planner.binding), content: json(planner) }])
  await write(target, planner, { op: 'outcome', id: 'legacy', kind: 'wait', text: 'Legacy result', prerequisitePaths: [] })
  const legacy = await readJson<RoleOutcome>(repo, await repo.snapshot(), planner.binding.outputPath)
  delete legacy!.turn_signal
  await repo.seed([{ path: planner.binding.outputPath, content: json(legacy) }])
  const value = await readOutcome(repo, await repo.snapshot(), planner.binding)
  assert.equal(value?.turn_signal, 'wait')
})

test('the bound protocol body, not prose or a mismatched ID, completes a role', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'bound', 'Hello'); await target.tick(2)
  const foreground = target.agents.latest('foreground'), b = foreground.binding
  for (const binding of [{ ...b, taskId: 'wrong-task' }, { ...b, executionId: 'wrong-execution' }]) {
    await repo.seed([{ path: b.outputPath, content: json({ binding, turn_signal: 'respond' }) }])
    assert.equal(await readOutcome(repo, await repo.snapshot(), b), undefined)
    await target.tick()
    assert.equal((await readJson<RoleAction>(repo, await repo.snapshot(), actionPath(b)))?.state, 'active')
  }
  await repo.seed([{ path: b.outputPath, content: json({ binding: b, text: 'complete respond done' }) }])
  await target.tick()
  assert.equal((await readJson<RoleAction>(repo, await repo.snapshot(), actionPath(b)))?.state, 'active')
  await repo.seed([{ path: b.outputPath, content: json({ binding: b, turn_signal: 'respond' }) },
    { path: statusPath(b, 'completed'), content: json({ version: 1, kind: 'completed', binding: b, turn_signal: 'respond', outcomePath: b.outputPath }) }])
  await target.tick()
  assert.equal((await readJson<RoleAction>(repo, await repo.snapshot(), actionPath(b)))?.state, 'closed')
  assert.equal(target.agents.state(b.executionId)?.busy, true, 'native reply ending is not required')
  target.agents.finish(foreground, 'Final native transcript retained')
  await target.tick()
  assert.equal(target.agents.state(b.executionId), undefined)
  assert.equal(await readText(repo, await repo.snapshot(), executionPath(b) + '/transcript'), 'Final native transcript retained')
  const restarted = instance(repo); await restarted.tick(2)
  assert.equal(restarted.agents.starts.length, 0, 'closed Git signal cannot replay after cache loss')
})

test('Planner done and rework release Workers while the native Planner reply is still open', async () => {
  for (const signal of ['done', 'rework'] as const) {
    const repo = new MemoryRepo(), target = instance(repo)
    const planner = await plannedChild(repo, target, signal)
    assert.equal(target.agents.state(planner.binding.executionId)?.busy, true)
    assert.equal(target.agents.latest('worker').binding.childId, 'child')
    await target.tick(2)
    assert.equal(target.agents.starts.filter(a => a.binding.role === 'worker').length, 1)
  }
})

test('Worker complete, blocked and error each wake Planner once without waiting for native completion', async () => {
  for (const signal of ['complete', 'blocked', 'error'] as const) {
    const repo = new MemoryRepo(), target = instance(repo)
    const planner = await plannedChild(repo, target), worker = target.agents.latest('worker')
    await write(target, worker, { op: 'outcome', id: 'out', turn_signal: signal, text: 'Artifact or concrete blocker', prerequisitePaths: [] })
    await target.tick(3)
    assert.notEqual(target.agents.latest('planner').binding.executionId, planner.binding.executionId)
    assert.equal(target.agents.starts.filter(a => a.binding.role === 'planner').length, 2)
    assert.equal(target.agents.state(worker.binding.executionId)?.busy, true)
    const outcome = await readOutcome(repo, await repo.snapshot(), worker.binding)
    assert.equal(outcome?.turn_signal, signal)
    assert.equal(outcome?.resultStatus, signal === 'complete' ? 'done' : 'failed')
  }
})

test('Worker continue and Planner handoff advance generations, with physical Worker seats retained until drain', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  target.cache.settings.workerSeats = 1
  const planner = await plannedChild(repo, target), worker = target.agents.latest('worker')
  await write(target, worker, { op: 'outcome', id: 'out', turn_signal: 'continue', text: 'Saved bounded progress', prerequisitePaths: [] })
  await target.tick(2)
  const next = await readJson<RoleAction>(repo, await repo.snapshot(), actionPath(worker.binding))
  assert.equal(next?.binding.generation, 2)
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'worker').length, 1, 'occupied seat is not double-booked')
  assert.equal(target.agents.latest('planner'), planner, 'continuation does not request acceptance')
  target.agents.finish(worker); await target.tick()
  assert.equal(target.agents.latest('worker').binding.generation, 2)

  const otherRepo = new MemoryRepo(), other = instance(otherRepo), current = await root(otherRepo, other)
  await write(other, current, { op: 'outcome', id: 'out', turn_signal: 'handoff', text: 'Next planning generation', prerequisitePaths: [] })
  await other.tick(2)
  assert.equal(other.agents.latest('planner').binding.generation, 2)
  assert.equal(other.agents.state(current.binding.executionId)?.busy, true)
})

test('Planner wait does not release untouched pending directions; need_user reaches Foreground once', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await plannedChild(repo, target, 'wait')
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'worker').length, 0)
  const otherRepo = new MemoryRepo(), other = instance(otherRepo), planner = await root(otherRepo, other)
  await write(other, planner, { op: 'outcome', id: 'out', turn_signal: 'need_user', question: 'Choose the output location.', text: 'Waiting for user input', prerequisitePaths: [] })
  await other.tick(3)
  assert.equal(other.agents.starts.filter(a => a.binding.role === 'foreground').length, 2)
  assert.equal((other.agents.latest('foreground').input as { question: boolean }).question, true)
})

test('protocol changes are read mechanically without generic Foreground notices; business text stays on demand', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'protocol', 'Hello'); await target.tick(2)
  const foreground = target.agents.latest('foreground')
  target.cache.settings.remoteEnabled = true
  await write(target, foreground, { op: 'outcome', id: 'remote', turn_signal: 'respond', text: 'Saved response', prerequisitePaths: [] })
  let changes = [{ path: foreground.binding.outputPath, status: 'A', commit: repo.head },
    { path: 'dss-coop/events/2/receipt.json', status: 'A', commit: repo.head }]
  Object.defineProperty(repo, 'changes', { value: async () => changes })
  const reads: string[] = [], originalRead = repo.read.bind(repo)
  repo.read = async (snapshot, path) => { reads.push(path); return originalRead(snapshot, path) }
  const service = new CoopService(target.cache, {} as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo }); service.attach(target.consumer)
  await service.sync(); changes = []
  target.agents.finish(foreground); await service.sync()
  assert.ok(reads.includes(foreground.binding.outputPath))
  assert.equal(target.agents.starts.length, 1)
  for (const prefix of ['events', 'records', 'origins', 'incidents', 'status']) assert.equal(isProtocolPath('dss-coop/' + prefix + '/item'), true)
  const sourcePath = 'dss-coop/requests/new.md'
  await repo.seed([{ path: sourcePath, content: 'AI reads this business request deliberately.' }])
  changes = [{ path: sourcePath, status: 'A', commit: repo.head }]
  await service.sync(); changes = []; await service.sync()
  assert.equal(target.agents.starts.length, 2)
  assert.equal(reads.includes(sourcePath), false)
})


test('installed role contracts, schemas and writer agree on distinct record responsibilities', async () => {
  for (const role of ['foreground', 'planner', 'worker'] as const) {
    const schema = roleCommandSchema(role), kind = role === 'planner' ? 'memory' : 'reply'
    const key = role === 'planner' ? 'memoryPath' : 'replyPath'
    assert.ok(schema.safeParse({ op: 'entry', kind, text: 'Actual role work' }).success)
    assert.ok(schema.safeParse({ op: 'outcome', turn_signal: role === 'foreground' ? 'respond' : role === 'planner' ? 'done' : 'complete', [key]: 'saved/text' }).success)
    assert.equal(schema.safeParse({ op: 'entry', kind: role === 'planner' ? 'reply' : 'memory', text: 'Wrong responsibility' }).success, false)
    assert.equal(schema.safeParse({ op: 'outcome', turn_signal: 'complete', text: 'Uncommitted inline body' }).success, false)
    const prompt = await readFile('src/experimental/private-git/prompts/' + role + '.md', 'utf8')
    assert.ok(prompt.includes('kind=' + kind))
    assert.ok(prompt.includes(key))
    if (role === 'planner') assert.ok(prompt.includes('nextDirection'), 'Planner retains its child review/direction responsibility')
    if (role === 'worker') assert.ok(prompt.includes('Progress checkpoints and handoff facts belong in this Child Reply'))
  }
  const repo = new MemoryRepo(), target = instance(repo)
  const planner = await plannedChild(repo, target), worker = target.agents.latest('worker')
  await assert.rejects(target.consumer.writer.execute(worker.binding, { op: 'entry', id: 'wrong', kind: 'memory', text: 'Wrong role' }), /Invalid|invalid/)
  const result = await write(target, worker, { op: 'entry', id: 'reply-body', kind: 'reply', text: 'Saved Child Reply and evidence' })
  assert.ok(result.textPath)
  const source = await readJson<{ kind: string; writer: RoleBinding }>(repo, await repo.snapshot(), result.textPath + '/source.json')
  assert.equal(source?.kind, 'reply'); assert.equal(source?.writer.role, 'worker')
  await assert.rejects(target.consumer.writer.execute(worker.binding, {
    op: 'outcome', id: 'wrong-reference', turn_signal: 'complete', replyPath: executionPath(planner.binding) + '/entries/out-body/memory',
  }), /this turn’s committed reply/)
  assert.equal(await readOutcome(repo, await repo.snapshot(), worker.binding), undefined)
})

test('remote startup, role text, result and final status are ordered; cold recovery never dispatches from a write', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'ordered', 'Build a managed output')
  await target.tick()
  assert.equal(target.agents.starts.length, 0)
  const startedPath = [...repo.files.keys()].find(path => path.endsWith('/started.json'))!
  assert.ok(startedPath.startsWith('dss-coop/status/'))
  const startupSha = repo.files.get(startedPath)
  await target.tick()
  const fg = target.agents.latest('foreground'), b = fg.binding
  await write(target, fg, { op: 'root', id: 'root', title: 'Ordered output', goal: 'Make output', initialPlan: 'Plan and execute' })
  await target.tick(2)
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'planner').length, 0, 'root and join alone do not dispatch')
  const reply = await write(target, fg, { op: 'entry', id: 'body', kind: 'reply', text: 'The task and initial plan are saved.' })
  const textSha = repo.files.get(reply.textPath + '/manifest.json')
  const commit = repo.commit.bind(repo)
  repo.commit = async (snapshot, changes) => {
    if (changes.some(change => change.path === statusPath(b, 'completed'))) throw new GitHubError(0, 'final status network failure')
    return commit(snapshot, changes)
  }
  await assert.rejects(write(target, fg, { op: 'outcome', id: 'finish', turn_signal: 'handoff_planner',
    taskId: 'task-ordered', replyPath: reply.textPath, prerequisitePaths: [] }), /final status network/)
  const resultSha = repo.files.get(b.outputPath)
  assert.ok(resultSha, 'the result reference is already remote')
  assert.equal(await readOutcome(repo, await repo.snapshot(), b), undefined)
  await assert.rejects(target.tick(), /final status network/)
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'planner').length, 0)
  repo.commit = commit
  const cold = instance(repo) // No local drafts, running agents or previous confirmations.
  await cold.tick()
  assert.equal(cold.agents.starts.length, 0, 'recovering the final remote status still requires a later read')
  assert.ok(repo.files.has(statusPath(b, 'completed')))
  const completedSha = repo.files.get(statusPath(b, 'completed'))
  await cold.tick(2)
  assert.equal(cold.agents.starts.filter(a => a.binding.role === 'planner').length, 1)
  await cold.tick(2)
  assert.equal(cold.agents.starts.filter(a => a.binding.role === 'planner').length, 1)
  await target.consumer.writer.retryDrafts()
  assert.equal(target.cache.drafts().length, 0)
  assert.equal(repo.files.get(startedPath), startupSha)
  assert.equal(repo.files.get(b.outputPath), resultSha, 'consumer close never rewrites AI result')
  assert.equal(repo.files.get(reply.textPath + '/manifest.json'), textSha)
  assert.equal(repo.files.get(statusPath(b, 'completed')), completedSha)
  const bodyWrite = repo.writes.findIndex(w => w.changes.some(c => c.path === reply.textPath + '/manifest.json'))
  const resultWrite = repo.writes.findIndex(w => w.changes.some(c => c.path === b.outputPath))
  const finalWrite = repo.writes.findIndex(w => w.changes.some(c => c.path === statusPath(b, 'completed')))
  assert.ok(bodyWrite < resultWrite && resultWrite < finalWrite)
  assert.equal(repo.writes.filter(w => w.changes.some(c => c.path === statusPath(b, 'completed'))).length, 1)
})

test('Planner Memory and directions wait for final remote status before Worker dispatch', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  const planner = await root(repo, target), b = planner.binding
  await write(target, planner, { op: 'root_plan', id: 'assign', expectedRevision: 0, works: [
    { id: 'part', title: 'Part', direction: 'Make part', acceptance: 'Open part', participantId: '1', instanceId: target.cache.instanceId, version: 1 },
  ] })
  await write(target, planner, { op: 'claim', id: 'claim', workId: 'part', assignmentVersion: 1, scope: 'Make part' })
  await write(target, planner, { op: 'participant_plan', id: 'plan', expectedRevision: 0, children: [
    { id: 'child', workId: 'part', assignmentVersion: 1, title: 'Child', direction: 'Make part', acceptance: 'Open part', dependencies: [] },
  ] })
  const memory = await write(target, planner, { op: 'entry', id: 'memory', kind: 'memory', text: 'Assigned bounded work; inspect the resulting part.' })
  const note = await write(target, planner, { op: 'entry', id: 'note', kind: 'note', text: 'After part: integrate and deliver.' })
  await target.tick(2)
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'worker').length, 0)
  await write(target, planner, { op: 'outcome', id: 'finish', turn_signal: 'done', memoryPath: memory.textPath, notePath: note.textPath, prerequisitePaths: [] })
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'worker').length, 0)
  const outcome = await readOutcome(repo, await repo.snapshot(), b)
  assert.equal(outcome?.memoryPath, memory.textPath)
  assert.equal(outcome?.notePath, note.textPath)
  assert.equal(outcome?.textPath, memory.textPath)
  await target.tick(2)
  assert.equal(target.agents.starts.filter(a => a.binding.role === 'worker').length, 1)
})

test('one-second remote timer coalesces event requests and stops cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const sync = new CoopSync({ sync: async () => { calls++; if (calls === 1) await pending } } as unknown as CoopService,
    { hasWork: () => true } as CoopConsumer)
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  sync.request(); sync.request(); t.mock.timers.tick(0)
  assert.equal(calls, 1)
  sync.request(); sync.request()
  release(); await flush(); t.mock.timers.tick(0); await flush()
  assert.equal(calls, 2, 'events during one fetch coalesce into one following fetch')
  t.mock.timers.tick(999); await flush(); assert.equal(calls, 2)
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 3)
  sync.dispose(); t.mock.timers.tick(5000); await flush(); assert.equal(calls, 3)
})


test('an unfinished pre-upgrade action publishes startup before resuming the same native binding', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  const b: RoleBinding = { participantId: '1', instanceId: target.cache.instanceId, role: 'foreground',
    actionId: 'legacy-pending', executionId: 'legacy-execution', sessionId: 'legacy-session', generation: 1, epoch: 0, fence: 'legacy', outputPath: '' }
  b.outputPath = executionPath(b) + '/outcome.json'
  const action: RoleAction = { id: b.actionId, binding: b, state: 'active', trigger: 'old', input: {}, createdAt: '2026-10-27T00:00:00Z' }
  await repo.seed([{ path: actionPath(b), content: json(action) }])
  await target.tick()
  assert.equal(target.agents.starts.length, 0)
  assert.ok(repo.files.has(statusPath(b, 'started')))
  await target.tick()
  assert.equal(target.agents.latest('foreground').binding.executionId, b.executionId)
  await write(target, target.agents.latest('foreground'), { op: 'outcome', id: 'finish', turn_signal: 'respond', text: 'Resumed reply', prerequisitePaths: [] })
  await target.tick()
  assert.equal((await readJson<RoleAction>(repo, await repo.snapshot(), actionPath(b)))?.state, 'closed')
})

test('task projection shows acceptance only after the Planner final status is remote', async () => {
  const repo = new MemoryRepo(), target = instance(repo), planner = await root(repo, target)
  const service = new CoopService(target.cache, { describe: async () => ({ configured: true }) } as unknown as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo }); service.attach(target.consumer)
  await write(target, planner, { op: 'accept', id: 'accept', expectedRevision: 1, review, text: 'Reviewed final artifact' })
  await service.sync()
  assert.equal((await service.view()).tasks.find(t => t.id === 'task-origin-1')?.status, 'active')
  await write(target, planner, { op: 'outcome', id: 'final', turn_signal: 'complete', text: 'Root accepted; preserve final evidence', prerequisitePaths: [] })
  await service.sync()
  assert.equal((await service.view()).tasks.find(t => t.id === 'task-origin-1')?.status, 'accepted')
})

test('Foreground working memory replaces and clears the current document without accumulating transcript entries', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'notes', 'Remember the important assignment and rewrite your scratch notes.')
  await target.tick(2)
  const fg = target.agents.latest('foreground'), cachePath = foregroundMemoryPath(fg.binding, 'Foreground_Cache')
  const listPath = foregroundMemoryPath(fg.binding, 'Foreground_List')
  await write(target, fg, { op: 'foreground_memory', id: 'list', document: 'Foreground_List', text: '- Build result; source: inputs/notes; task: task-notes; pending.' })
  const long = '自由随记。'.repeat(20_000)
  await write(target, fg, { op: 'foreground_memory', id: 'cache-1', document: 'Foreground_Cache', text: long })
  assert.equal(await repo.read(await repo.snapshot(), cachePath), long)
  await write(target, fg, { op: 'foreground_memory', id: 'cache-2', document: 'Foreground_Cache', text: 'Current topic only.' })
  assert.equal(await repo.read(await repo.snapshot(), cachePath), 'Current topic only.')
  assert.equal([...repo.files.keys()].some(path => /entries\/(cache-1|cache-2)\//.test(path)), false)
  await write(target, fg, { op: 'foreground_memory', id: 'cache-3', document: 'Foreground_Cache', text: '' })
  await write(target, fg, { op: 'foreground_memory', id: 'list-done', document: 'Foreground_List', text: '' })
  assert.equal(repo.files.has(cachePath), false); assert.equal(repo.files.has(listPath), false)
  assert.equal(roleCommandSchema('worker').safeParse({ op: 'foreground_memory', document: 'Foreground_Cache', text: 'worker' }).success, false)
  assert.equal(roleCommandSchema('planner').safeParse({ op: 'foreground_memory', document: 'Foreground_List', text: 'planner' }).success, false)
})

test('shared conversation changes only its send backend; Git input starts Foreground without automatically creating a task', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  const service = new CoopService(target.cache, { describe: async () => ({ configured: true }) } as unknown as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo }); service.attach(target.consumer)
  const localCalls: string[] = []
  const base = { assistant: { id: 'default', revision: 1, settings: { name: 'Servant', presetId: 'standard', foreground: { provider: 'chosen', model: 'foreground' }, background: {} },
    workspace: { id: 'test', directory: process.cwd() }, pendingInputs: [] }, messages: [{ id: 'local-1', role: 'user', text: 'Earlier discussion', at: '2026-10-27T00:00:00Z' }],
    tasks: [], knowledge: [], workspaces: [], runtime: { status: 'running', workerSeats: 2 }, recordStorage: { directory: process.cwd() },
    runtimeSettings: { revision: 1, workerSeats: 2 } } as ServantView
  let mode: 'LOCAL' | 'PRIVATE_GIT_EXPERIMENTAL' = 'LOCAL'
  const shared = new SharedForeground({ call: async method => { localCalls.push(method); return method === 'view' ? base : { status: 'applied' } } }, async () => service, () => mode, () => true)
  await shared.call('send', { messageId: 'local-send', text: 'Discuss locally' })
  assert.equal(localCalls.filter(m => m === 'send').length, 1)
  mode = 'PRIVATE_GIT_EXPERIMENTAL'
  await shared.call('send', { messageId: 'shared-send', text: 'Let us discuss this before implementing.' })
  await target.tick(2); await service.sync()
  assert.equal(target.agents.starts.length, 1)
  assert.equal(target.agents.latest('foreground').binding.sourceIntentId, 'shared-send')
  assert.equal([...repo.files.keys()].some(path => path.startsWith('dss-coop/tasks/')), false)
  const committed = await readJson<any>(repo, await repo.snapshot(), 'dss-coop/intents/1/shared-send.json')
  assert.equal(committed.foreground, undefined, 'local working directory stays local')
  assert.match(await readText(repo, await repo.snapshot(), committed.contextPath), /Earlier discussion/)
  assert.equal(target.cache.get<UserIntent>('user-source/shared-send')?.foreground?.model, 'foreground')
  const ui = await shared.call('view', {}) as ServantView
  assert.equal(ui.assistant.id, 'default')
  assert.ok(ui.messages.some(m => m.id === 'local-1'))
  assert.ok(ui.messages.some(m => m.id === 'git:shared-send'))
  mode = 'LOCAL'
  await shared.call('send', { messageId: 'local-again', text: 'Local again' })
  assert.equal(localCalls.filter(m => m === 'send').length, 2)
})

test('connecting publishes the directory guide once and preserves owner documentation', async () => {
  const cache = new MemoryStore(), repo = new MemoryRepo()
  await repo.seed([{ path: 'dss-coop/README.md', content: '# Owner notes\n\nKeep this paragraph.\n' }])
  const service = new CoopService(cache, { describe: async () => ({ configured: true }) } as unknown as CoopCredentials, new GitHubClient(async () => undefined))
  Object.defineProperty(service, 'repository', { value: repo })
  await service.connect()
  const text = (await repo.read(await repo.snapshot(), 'dss-coop/README.md'))!
  assert.match(text, /Keep this paragraph/)
  for (const name of ['inbox', 'Foreground_List', 'Foreground_Cache', 'outcome.json', 'records.md', '30 天', '7 天']) assert.ok(text.includes(name), name)
  assert.equal(mergeRepositoryGuide(text, cache.settings), text)
  const count = repo.writes.length
  await service.sync(); await service.sync()
  assert.equal(repo.writes.length, count)
  assert.equal(isProtocolPath('dss-coop/README.md'), true)
})

test('mode modules have no imports from Local business execution or prompts', async () => {
  const root = 'src/experimental/private-git'
  async function walk(directory: string): Promise<string[]> {
    const result: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) result.push(...await walk(join(directory, entry.name)))
    else if (/\.[cm]?tsx?$/.test(entry.name)) result.push(join(directory, entry.name))
    return result
  }
  for (const path of await walk(root)) {
    const source = await readFile(path, 'utf8')
    assert.doesNotMatch(source, /from\s+['"][^'"]*\/(runtime|roles|application|adapters\/dsh)\//, path)
  }
})
