import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ModeRouter } from '../src/mode-router/mode-router.js'
import { CoopSettingsSchema, type CoopSettings, type GitChange, type GitRepository, type GitSnapshot, type PendingDraft, type RepoConnection, type RoleBinding, type UserIntent } from '../src/experimental/private-git/contracts.js'
import type { CoopStore } from '../src/experimental/private-git/cache.js'
import { GitConflictError, GitHubClient, GitHubError, GitHubMembers, inspectPrivateRepo } from '../src/experimental/private-git/github.js'
import { digest, GitJournal, json, readJson, readText, textChanges } from '../src/experimental/private-git/journal.js'
import { CoopConsumer, type CoopAgentPort, type CoopPhysicalState } from '../src/experimental/private-git/consumer.js'
import { RoleWriter } from '../src/experimental/private-git/role-writer.js'
import { conversationPage } from '../src/experimental/private-git/conversation.js'
import { CoopService } from '../src/experimental/private-git/service.js'
import type { CoopCredentials } from '../src/experimental/private-git/credentials.js'
import { actionPath, executionPath, joinPath, planPath, taskPath, type CoopCommand, type RoleAction, type RoleOutcome, type RootTask } from '../src/experimental/private-git/protocol.js'

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
async function write(target: Instance, action: RoleAction, command: CoopCommand) { return target.consumer.writer.execute(action.binding, command) }
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
    await write(target, worker, { op: 'entry', id: 'progress', kind: 'checkpoint', text: 'Complete checkpoint text for participant ' + (n + 1) })
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

test('offline role output is a draft, then reconciles once without dispatching from its write callback', async () => {
  const repo = new MemoryRepo(), target = instance(repo)
  await input(repo, target, 'short', 'Hello')
  await target.tick(2)
  const fg = target.agents.latest('foreground')
  repo.offline = true
  await assert.rejects(write(target, fg, { op: 'outcome', id: 'reply', kind: 'respond', text: 'Hello back', prerequisitePaths: [] }), /network/)
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
  await write(target, worker, { op: 'entry', id: 'checkpoint', kind: 'checkpoint', text: 'Completed first segment, retained file exists' })
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
