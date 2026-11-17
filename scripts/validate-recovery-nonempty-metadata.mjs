// Actual startup/resume and GitFiles -> RemoteGitRepository over real Git
// objects, plus actual SDK storage/PhysicalLocalFiles. The Git backend transport
// is a local git CLI port; no network, Dulwich wire, native Agent or model claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { tmpdir, devNull } from 'node:os'
import path from 'node:path'
import { sourceRoot, hooks, hash, loaded, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const originalRoot = process.env.DSS_RECOVERY_SOURCE_DIR
const expectBodyReads = Number(process.env.DSS_EXPECT_RECOVERY_BODY_READS ?? '0')
const frozen = registerHooks({ load(url, context, next) {
  const name = ['framework/role-runtime.ts', 'framework/recovery.ts'].find(n => url === new URL(n, sourceRoot).href)
  if (!originalRoot || !name) return next(url, context)
  const source = readFileSync(path.join(originalRoot, name), 'utf8'); loaded.set(name, hash(source))
  return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
} })
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const { GitAuthorityStore, SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { RemoteGitRepository } = await import('../src/experimental/private-git/remote-git-repository.ts')
const { GitBackendError } = await import('../src/experimental/private-git/git-object-backend.ts')
const { initializeTask, preparePhysicalTask, paths, readJson } = await import('../src/framework/task-files.ts')
const { scanMemberRecovery } = await import('../src/framework/recovery.ts')
const root = await fs.mkdtemp(path.join(tmpdir(), 'dss-recovery-nonempty-')), checks = [], observations = []
const check = (label, actual, expected) => { assert.deepEqual(actual, expected, label); checks.push(label) }
function gitFixture(directory, objectFormat) {
  execFileSync('git', ['init', '--bare', '--quiet', '--object-format=' + objectFormat, directory])
  const git = (args, input) => execFileSync('git', ['--git-dir=' + directory, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_AUTHOR_NAME: 'Recovery fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Recovery fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })
  const tree = git(['mktree'], '').toString().trim(), initial = git(['commit-tree', tree], 'Initial fixture\n').toString().trim()
  git(['update-ref', 'refs/heads/main', initial]); const events = []
  class Backend {
    closed = false; ids = new Set()
    async ready() {}
    async release() { this.closed = true }
    async storageBytes() { return [...this.ids].reduce((n, id) => n + Number(git(['cat-file', '-s', id])), 0) }
    metadata(id) {
      this.ids.add(id); const commit = git(['cat-file', 'commit', id]).toString(), root = commit.match(/^tree (\w+)/)[1]
      const visit = id => { this.ids.add(id); for (const line of git(['ls-tree', '-z', id]).toString().split('\0').filter(Boolean)) {
        const m = line.match(/^\d+ (\w+) (\w+)\t/); if (m[1] === 'tree') visit(m[2])
      } }; visit(root)
    }
    async execute(command, { signal, input }) {
      signal.throwIfAborted(); assert.equal(this.closed, false); events.push({ op: command.op, kind: command.kind, id: command.id })
      if (command.op === 'fetchHead') { const id = git(['rev-parse', 'refs/heads/main']).toString().trim(); this.metadata(id); return Buffer.from(id) }
      if (command.op === 'fetchMetadata') { this.metadata(command.revision); return Buffer.alloc(0) }
      if (command.op === 'ensureObjects') { for (const id of command.ids) { git(['cat-file', '-e', id]); this.ids.add(id) } return command.kind === 'commit' ? git(['rev-list', '--max-count=' + String(command.commitDepth ?? 1), ...command.ids]) : Buffer.alloc(0) }
      if (command.op === 'readObject') return git(['cat-file', command.kind, command.id])
      if (command.op === 'readTree') return git(['ls-tree', '-z', command.id])
      if (command.op === 'writeBlob' || command.op === 'writeTree') {
        const id = git(command.op === 'writeBlob' ? ['hash-object', '-t', 'blob', '-w', '--stdin'] : ['mktree', '-z'], input).toString().trim(); this.ids.add(id); return Buffer.from(id)
      }
      if (command.op === 'writeCommit') {
        const message = String(input).replace(/\n?$/, '\n'), id = git(['commit-tree', command.tree, ...(command.parent ? ['-p', command.parent] : [])], message).toString().trim()
        this.ids.add(id); return Buffer.from(JSON.stringify({ id, tree: command.tree, parents: command.parent ? [command.parent] : [], message, timestamp: command.timestamp }))
      }
      if (command.op === 'push') {
        try { git(['update-ref', command.ref, command.commit, command.expected || '0'.repeat(40)]) }
        catch { throw new GitBackendError('stale', 'Fixture real Git CAS conflict') } return Buffer.alloc(0)
      }
      throw Error('Unhandled real-object fixture command: ' + command.op)
    }
  }
  const repo = new RemoteGitRepository(() => ({ ownerRepo: 'fixture/recovery', branch: 'main', repositoryDirectory: 'dss-coop' }),
    async () => ({ value: 'unused-fixture', source: 'fixture' }), { remoteUrl: () => 'http://127.0.0.1:1/unused.git',
      inspectAuthority: async () => ({ identity: { id: 1, login: 'A' }, repository: { id: 1, fullName: 'fixture/recovery', branch: 'main', private: true, permissions: { pull: true, push: true, admin: false } } }) })
  const cache = repo.newCache.bind(repo); repo.newCache = (channel, transport) => cache(channel, transport ?? new Backend())
  return { repo, files: new GitFiles(repo, new SessionGitOperations()), events, git }
}
async function run(mode, objectFormat = 'sha1') {
  const sdk = await openDshStorageFixture(path.join(root, mode + '-records'), path.join(root, mode + '-locator'))
  const g = mode === 'git' ? gitFixture(path.join(root, 'objects-' + objectFormat + '.git'), objectFormat) : undefined
  const files = g?.files ?? new PhysicalLocalFiles(path.join(root, 'local')), records = g ? new GitAuthorityStore(files, 'recovery') : sdk.adapter
  const errors = [], wakes = [], rt = Object.create(FrameworkRoleRuntime.prototype)
  Object.assign(rt, { files, records, ctx: sdk.ctx, prefix: 'framework-runtime/' + hash(mode) + '/', bootId: 'actual-materials-boot', config: { mode, member: 'A' },
    roleRecords: new Map(), knownTaskLifecycles: new Map(), observedTerminalTasks: new Map(), pendingTaskControlDiscovery: new Map(), workspaces: { rememberRoot() {} },
    // Native scheduling and unrelated observation/control owners are ports, not
    // replacements for scanMembers, startup, startupRecovery or resumeTask.
    environment: mode === 'local' ? { beforeTaskUse: async () => true } : {}, controls: { taskHeld: async () => false }, closed: false,
    startSafetyResolutionLoad() {}, processObservations: async () => {}, startTaskControlDiscovery() {}, startOwnedPump() {}, pump: async () => {}, queueOrganizerLedger: async () => {},
    wake: async request => { wakes.push(request) }, error: error => errors.push(error.message), active: record => record.nativeState === 'running' || record.nativeState === 'waiting' })
  const write = async (p, body) => g ? withSnapshot(files, s => files.commit(s, [{ path: p, content: body ?? null }], 'Recovery fixture write')) : body === undefined ? files.delete(p) : files.replace(p, body)
  const create = async n => {
    const id = 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0'), source = 'tasks/request-' + n + '_P.md'
    await write(source, 'Original task ' + n)
    if (!g) return withSnapshot(files, s => preparePhysicalTask(files, s, source, { taskId: id, owner: 'A', members: ['A'] }))
    const planned = await withSnapshot(files, s => initializeTask(files, s, source, 'A', ['A'], id))
    await withSnapshot(files, s => files.commit(s, planned.changes, 'Actual Task initialization'))
    return withSnapshot(files, s => readJson(files, s, paths.task(id)))
  }
  const selectedBodies = new Set(), reads = [], originalRead = files.read.bind(files), originalList = files.list.bind(files), originalDirectory = files.listDirectory.bind(files)
  let unknown = false
  files.read = async (s, p) => { if (selectedBodies.has(p)) reads.push(p); return originalRead(s, p) }
  const omitMetadata = rows => unknown ? rows.map(row => selectedBodies.has(row.path) ? { path: row.path, version: row.version } : row) : rows
  files.list = async (...args) => omitMetadata(await originalList(...args))
  files.listDirectory = async (...args) => omitMetadata(await originalDirectory(...args))
  if (!g) { const exact = files.fileMetadata.bind(files); files.fileMetadata = async p => { const value = await exact(p); return unknown && value && selectedBodies.has(p) ? { path: value.path, version: value.version } : value } }
  const scan = task => withSnapshot(files, s => rt.scanMembers(s, [task]))
  const normalized = row => ({ inbox: row.inboxHasContent ?? row.inboxBodyBytes > 0, notes: row.workers.map(w => [w.workerId, w.noteHasContent ?? w.noteBodyBytes > 0]) })
  const drain = async () => { while (rt.maintenance?.size) await Promise.all([...rt.maintenance.values()]) }
  try {
    const task = await create(1), second = await create(2), inbox = paths.inbox(task.taskId, 'A'), note = id => paths.member(task.taskId, 'A') + '/workers/' + id + '/notes.md'
    selectedBodies.add(inbox)
    for (const id of ['ascii', 'unicode', 'space', 'bom', 'empty']) selectedBodies.add(note(id))
    for (const [id, body] of [['ascii', 'x'], ['unicode', '中文😀'], ['space', ' \n\t'], ['bom', '\uFEFF'], ['empty', '']]) await write(note(id), body)
    const members = await scan(task), facts = normalized(members[0])
    const oldGitBom = !!g && !!originalRoot, workerIds = oldGitBom ? ['ascii', 'space', 'unicode'] : ['ascii', 'bom', 'space', 'unicode']
    check(mode + ' all dynamic Note emptiness', facts.notes, [['ascii', true], ['bom', !oldGitBom], ['empty', false], ['space', true], ['unicode', true]])
    if (!originalRoot) { check(mode + ' explicit boolean Inbox', typeof members[0].inboxHasContent, 'boolean'); check(mode + ' no artificial numeric member fields', 'inboxBodyBytes' in members[0] || members[0].workers.some(w => 'noteBodyBytes' in w), false) }
    check(mode + ' each nonempty Worker retained', scanMemberRecovery(members).map(t => t.workerId), workerIds)
    if (g) {
      await withSnapshot(files, async s => {
        const entries = await originalList(s, paths.member(task.taskId, 'A') + '/workers/'), directory = await originalDirectory(s, inbox.slice(0, inbox.lastIndexOf('/')))
        check('real Git known empty Note', entries.find(e => e.path === note('empty')).empty, true)
        check('real Git known nonempty Note without length', [entries.find(e => e.path === note('unicode')).empty, entries.find(e => e.path === note('unicode')).bytes], [false, undefined])
        check('real Git known nonempty Inbox without length', [directory.find(e => e.path === inbox).empty, directory.find(e => e.path === inbox).bytes], [false, undefined])
      })
    }
    reads.length = 0; if (g) g.events.length = 0
    await scan(task)
    check(mode + ' selected body reads on real metadata', reads.length, g ? 5 * expectBodyReads : 0)
    if (g) {
      const ids = new Set([...selectedBodies].map(p => g.git(['rev-parse', 'refs/heads/main:dss-coop/' + p]).toString().trim()))
      check('actual Git body readObject calls', g.events.filter(e => e.op === 'readObject' && e.kind === 'blob' && ids.has(e.id)).length, 5 * expectBodyReads)
    }
    observations.push({ mode, objectFormat: g ? objectFormat : undefined, route: 'scan', bodyReads: [...reads], bomNoteHasContent: facts.notes.find(([id]) => id === 'bom')[1] })
    reads.length = 0; await rt.startup(); await drain()
    check(mode + ' startup all candidates and distinct Task Planner', wakes.filter(w => w.role !== 'Helper').map(w => [w.taskId, w.role, w.workerId ?? null]).sort(),
      [workerIds.map(id => [task.taskId, 'Worker', id]), [[second.taskId, 'Planner', null]]].flat().sort())
    check(mode + ' startup selected body reads', reads.length, g ? 5 * expectBodyReads : 0)
    wakes.length = 0; reads.length = 0; await rt.resumeTask(task.taskId, 'user-resume')
    check(mode + ' actual user resume preserves all Workers', wakes.map(w => w.workerId).sort(), workerIds)
    check(mode + ' resume selected body reads', reads.length, g ? 5 * expectBodyReads : 0)
    for (const body of ['', 'x', '中文😀', ' \n\t', '\uFEFF']) {
      await write(inbox, body); reads.length = 0; const result = await scan(task)
      check(mode + ' Inbox nonempty ' + JSON.stringify(body), result.length > 0, body.length > 0 && !(oldGitBom && body === '\uFEFF'))
      check(mode + ' Inbox does not request known body ' + JSON.stringify(body), reads.filter(p => p === inbox).length, g && body.length ? expectBodyReads : 0)
    }
    // API contract only: current producers supply metadata. Removing only its
    // optional fields checks the real read fallback without changing bodies.
    unknown = true
    for (const body of ['', 'x', '中文😀', ' \n\t', '\uFEFF']) {
      await write(inbox, body); reads.length = 0; const result = await scan(task)
      // Preserve the original read() contract, including TextDecoder's leading
      // BOM removal. Known physical/Git byte metadata above remains nonempty.
      const decodedNonempty = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(body)).length > 0
      check(mode + ' unknown Inbox uses actual decoded body ' + JSON.stringify(body), result.length > 0, decodedNonempty)
      check(mode + ' unknown Inbox read exactly once ' + JSON.stringify(body), reads.filter(p => p === inbox).length, 1)
      if (decodedNonempty) {
        check(mode + ' unknown Note states ' + JSON.stringify(body), normalized(result[0]).notes, facts.notes.map(([id, nonempty]) => [id, id === 'bom' ? false : nonempty]))
        check(mode + ' unknown all Notes read once', reads.length, 6)
      }
    }
    unknown = false; await write(inbox, 'Current work')
    await write(paths.memberStatus(task.taskId, 'A'), JSON.stringify({ state: 'complete' })); check(mode + ' complete member excluded', await scan(task), [])
    await write(paths.memberStatus(task.taskId, 'A'), JSON.stringify({ state: 'running' }))
    for (const id of ['ascii', 'unicode', 'space', 'bom']) await write(note(id), '')
    check(mode + ' all empty Notes restore own Planner', scanMemberRecovery(await scan(task)).map(t => [t.taskId, t.role]), [[task.taskId, 'Planner']])
    await write(inbox, undefined); check(mode + ' absent Inbox excluded', await scan(task), [])
    if (g) {
      await write(inbox, ''); const before = await files.snapshot(); await write(inbox, 'Later HEAD')
      try { check('old Git H remains empty', await rt.scanMembers(before, [task]), []) } finally { await before.release() }
      check('new Git H observes body nonempty', (await scan(task)).length, 1)
    }
    check(mode + ' no recovery errors', errors, [])
  } finally { await drain(); if (g) await g.repo.releaseCache(); else await files.close(); await sdk.close() }
}
try {
  await run('git'); await run('git', 'sha256'); await run('local')
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, observations, originalRoot, expectBodyReads, ...evidence(),
    limits: 'Intact production startup/startupRecovery/resumeTask/scanMembers/recovery and actual GitFiles/RemoteGitRepository/GitAuthorityStore on real Git SHA-1/SHA-256 objects and CAS; native Git transport uses local git CLI, not Dulwich wire or GitHub. Local uses actual SDK JSON storage and physical files. Native Agent admission, initial observation and control background owners are explicit ports. Unknown metadata is contract coverage, not an observed producer deficiency. No real model, Windows or measured latency claim.' }, null, 2))
} finally { frozen.deregister(); hooks.deregister(); await fs.rm(root, { recursive: true, force: true }) }
