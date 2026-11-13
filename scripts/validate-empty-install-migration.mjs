import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { sourceRoot, evidence, hooks } from './test-support/dsh-sdk-runtime.mjs'
import { localFilesWorkerSource, historicalProducer } from './test-support/historical-v44/load-sql-producer.mjs'
import { Repository, put, head } from './test-support/controlled-git/repository.mjs'
const { FrameworkService } = await import(new URL('framework/service.ts', sourceRoot))
const { LocalStartupUpgradeAgent } = await import(new URL('framework/local-startup-upgrade-agent.ts', sourceRoot))
const { openFrameworkConnection } = await import(new URL('framework/connection.ts', sourceRoot))
const { LocalRecordFiles } = await import(new URL('framework/local-record-files.ts', sourceRoot))
const { DshAgentGateway } = await import(new URL('adapters/dsh/agents.ts', sourceRoot))
const { GitFiles } = await import(new URL('framework/transactions.ts', sourceRoot))
const { SessionGitOperations } = await import(new URL('framework/git-authority.ts', sourceRoot))
const { FrameworkTransactions } = await import(new URL('framework/command-transactions.ts', sourceRoot))
const { gitUpgradePackagePath } = await import(new URL('framework/git-upgrade-package.ts', sourceRoot))
const hash = x => createHash('sha256').update(x).digest('hex')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-empty-install-'))
const checks = [], observations = [], errors = []
const check = (name, actual, expected) => { let passed = true; try { assert.deepEqual(actual, expected) } catch { passed = false }; checks.push({ name, passed, actual, expected }) }
class DiskRecords {
  constructor(root) { this.files = new LocalRecordFiles(path.join(root, 'host-records')); this.reads = []; this.writes = []; this.deletes = [] }
  async get(key) { this.reads.push(key); const body = await this.files.read(hash(key) + '.json'); return body === undefined ? undefined : JSON.parse(body) }
  async set(key, value) { this.writes.push(key); await this.files.replace(hash(key) + '.json', JSON.stringify(value)) }
  async delete(key) { this.deletes.push(key); await this.files.delete(hash(key) + '.json') }
  async list() { throw Error('No Host storage scans are part of empty installation') }
}
// This controlled gateway is an observation boundary. Empty cases must never
// reach it. Nonempty control can go idle without finish and must stay pending.
let creates = 0, disposes = 0
const originalCreate = DshAgentGateway.prototype.create
DshAgentGateway.prototype.create = async function(request) {
  creates++
  return { sessionId: request.sessionId, async send() {}, async whenIdle() {}, observe() { return { state: 'idle', jobs: [] } }, async cancel() {}, async dispose() { disposes++ } }
}
const nativeContext = { agents: { get() {} }, get() {}, logger: () => ({ error() {}, warn() {} }) }
const serviceFor = (storage, ctx = nativeContext, moduleURL) => {
  const service = new FrameworkService(ctx, storage, {}, undefined, moduleURL)
  service.changed = () => {}; service.report = (_mode, error) => { errors.push(error.message); return 'controlled-report' }
  return service
}
const migrationKey = key => /^(framework-startup-upgrade-agent|framework-physical-upgrade|framework-local-upgrade|framework-local-source|framework-local-task-upgrade|framework-local-conversation-upgrade|framework-local-skill-upgrade)\//.test(key)
async function originalDatabase(directory, entries) {
  await fs.mkdir(directory, { recursive: true })
  const worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath: path.join(directory, 'dss-files.sqlite'), writer: true } })
  const pending = new Map(); let sequence = 0
  const ready = new Promise((resolve, reject) => {
    worker.on('error', reject)
    worker.on('message', message => {
      if (message.startupError) reject(Error(message.startupError.message))
      else if (message.ready) resolve()
      else { const request = pending.get(message.id); pending.delete(message.id); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result) }
    })
  })
  const call = (method, args = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args }) })
  try {
    await ready
    if (entries.length) await call('commit', { changes: entries, dependencies: [], revision: 'fixture' })
    await call('checkpoint')
  } finally { await worker.terminate() }
}
async function sqliteHashes(directory) {
  const values = {}
  for (const suffix of ['', '-wal']) {
    try { const bytes = await fs.readFile(path.join(directory, 'dss-files.sqlite' + suffix)); if (!suffix || bytes.length) values['dss-files.sqlite' + suffix] = hash(bytes) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return values
}
try {
  for (const kind of ['no-source', 'empty-original', 'nonempty-original']) {
    const root = path.join(scratch, kind), directory = path.join(root, 'files'), records = new DiskRecords(root)
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'user-original.txt'), 'user physical material\n')
    const originalTaskId = '20000000-0000-4000-8000-000000000001'
    if (kind !== 'no-source') await originalDatabase(directory, kind === 'nonempty-original' ? [
      { path: 'roles/custom.md', content: '# Original user role\n' },
      { path: 'tasks/' + originalTaskId + '.json', content: JSON.stringify({ version: 1, taskId: originalTaskId, owner: 'empty-install', route: 'P', status: 'running', sourcePath: 'tasks/original_P.md', archiveFolder: originalTaskId }) },
      { path: 'tasks/original_P.md', content: 'Task ID: ' + originalTaskId + '\nOriginal user requirement\n' }
    ] : [])
    const beforeSql = await sqliteHashes(directory), service = serviceFor(records), beforeCreates = creates
    let work, openings = 0
    const connection = await openFrameworkConnection({ mode: 'local', directory, login: 'empty-install', workerSeats: 0 }, { storage: records,
      onStorageOpened(access) { openings++; service.startLocalUpgrade(access, scratch, { collaborationId: 'default' }); work = service.localUpgrades.get(access.files.directory).work } })
    const result = await work
    await Promise.resolve()
    // This method-level harness represents the existing startup lifecycle after
    // its Local connection is published. It does not claim DSH activation.
    service.starting = Promise.resolve()
    check(kind + ': one real connection startup callback', openings, 1)
    check(kind + ': outcome', result.status, kind === 'nonempty-original' ? 'pending' : 'not-needed')
    check(kind + ': native creations', creates - beforeCreates, kind === 'nonempty-original' ? 1 : 0)
    check(kind + ': live migration owners', service.localUpgrades.size, kind === 'nonempty-original' ? 1 : 0)
    check(kind + ': original SQLite bytes retained', await sqliteHashes(directory), beforeSql)
    check(kind + ': user physical bytes retained', await fs.readFile(path.join(directory, 'user-original.txt'), 'utf8'), 'user physical material\n')
    if (kind === 'empty-original') {
      let oldSourceCallbacks = 0
      const direct = new LocalStartupUpgradeAgent({}, records, { directory, cwd: scratch, onOldSourceFound: () => { oldSourceCallbacks++ } },
        { hasLiveOwner: () => false, exists: async () => false, create: async () => { throw Error('Empty source must not launch a native Agent') } })
      const directResult = await direct.start()
      check('empty-original: no old-source callback schedules legacy signal work', oldSourceCallbacks, 0)
      check('empty-original: direct Agent exits without wake', directResult.status, 'not-needed')
    }
    const migrationWrites = records.writes.filter(migrationKey)
    if (kind !== 'nonempty-original') {
      check(kind + ': no durable migration state written', migrationWrites, [])
      const beforeReads = records.reads.length
      for (const id of ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003']) {
        await connection.files.createIfAbsent('tasks/' + id + '.json', JSON.stringify({ version: 1, taskId: id, owner: 'empty-install', route: 'P', status: 'running', sourcePath: 'tasks/' + id + '_P.md', archiveFolder: id }))
        check(kind + ': subsequent Task admitted ' + id, await service.beforeLocalTaskUse(connection, id), true)
      }
      check(kind + ': later Tasks do not re-read migration state', records.reads.length - beforeReads, 0)
      check(kind + ': no owner recreated by later Tasks', service.localUpgrades.size, 0)
    } else {
      check(kind + ': pending wake retained for real content', migrationWrites.some(k => k.startsWith('framework-startup-upgrade-agent/')), true)
      check(kind + ': actual original Task still needs its pending owner', await service.beforeLocalTaskUse(connection, originalTaskId), false)
      const earlyService = serviceFor(records)
      check(kind + ': before startup registration the actual original Task is checked', await earlyService.beforeLocalTaskUse(connection, originalTaskId), false)
      earlyService.startupState.set('local', { status: 'starting', owner: {} })
      check(kind + ': startup without its owner still checks the actual original Task', await earlyService.beforeLocalTaskUse(connection, originalTaskId), false)
    }
    observations.push({ kind, status: result.status, migrationWrites, ownerCount: service.localUpgrades.size })
    await connection.close()
  }
  for (const signal of [false, true]) {
    const root = path.join(scratch, signal ? 'git-no-originals' : 'git-no-signal'), profile = path.join(root, 'profile'), pkg = path.join(profile, 'node_modules', 'deepseek-servant')
    await fs.mkdir(path.join(pkg, 'lib'), { recursive: true }); await fs.writeFile(path.join(pkg, 'lib', 'host.js'), '// plugin stays installed\n')
    await fs.writeFile(path.join(pkg, 'user-notes.txt'), 'user material stays\n')
    if (signal) { await fs.mkdir(path.join(pkg, 'upgrades')); await fs.writeFile(path.join(pkg, gitUpgradePackagePath), JSON.stringify({ kind: 'dss-g09-git-skills-bootstrap', version: 1 })) }
    const selected = { name: 'deepseek-servant', dir: pkg, version: '0.5.0' }, services = {
      pluginPackages: { packageOf: () => selected, resolution: { entries: [{ name: selected.name, packageDir: pkg, scope: 'profile', declarer: profile }], linkedRoots: [], localPackageNames: [selected.name] } },
      profileContext: { dir: profile, installAnchor: profile }
    }, ctx = { ...nativeContext, get: name => services[name] }, records = new DiskRecords(root), repository = new Repository()
    put(repository, 'tasks/user_P.md', 'existing user task\n'); head(repository)
    const files = new GitFiles(repository, new SessionGitOperations()), transactions = new FrameworkTransactions(files, records)
    const active = { connection: { files, transactions, scope: 'git-fixture' }, runtime: { refreshSkills() {} } }
    const service = serviceFor(records, ctx, pathToFileURL(path.join(pkg, 'lib', 'host.js')).href), beforeCreates = creates
    service.startGitUpgrade(active, scratch, {}); const owner = service.gitUpgrades.get(active); await owner.work
    const label = signal ? 'Git package signal with no originals' : 'Git no source signal'
    check(label + ': no native creation', creates - beforeCreates, 0)
    check(label + ': no live migration owner', service.gitUpgrades.size, 0)
    check(label + ': no Git migration publication', repository.calls.length, 0)
    check(label + ': no migration storage state', records.writes.filter(migrationKey), [])
    check(label + ': user repository data retained', repository.bodies.get('dss-coop/tasks/user_P.md'), 'existing user task\n')
    check(label + ': plugin kept', await fs.readFile(path.join(pkg, 'lib', 'host.js'), 'utf8'), '// plugin stays installed\n')
    check(label + ': user package data kept', await fs.readFile(path.join(pkg, 'user-notes.txt'), 'utf8'), 'user material stays\n')
    check(label + ': own temporary startup file absent', await fs.stat(path.join(pkg, gitUpgradePackagePath)).then(() => false, e => { if (e.code !== 'ENOENT') throw e; return true }), true)
    await transactions.run('normal-user-task', { task: 'normal' }, {}, async () => [{ path: 'tasks/normal_P.md', content: 'new user Task\n' }])
    check(label + ': normal later Task write succeeds', repository.bodies.get('dss-coop/tasks/normal_P.md'), 'new user Task\n')
    check(label + ': later Task does not recreate migration owner', service.gitUpgrades.size, 0)
    check(label + ': later Task starts no migration Agent', creates - beforeCreates, 0)
    observations.push({ kind: label, ownerCount: service.gitUpgrades.size, originalPublications: repository.calls.length - 1 })
  }
  check('Only the deliberately unfinished nonempty control is reported', errors.length, 1)
  check('The one controlled nonempty native handle is disposed', disposes, 1)
  const passed = checks.every(row => row.passed)
  console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', checks, observations, errors, historicalProducer, ...evidence(),
    limits: 'Actual production FrameworkService, openFrameworkConnection Local callback, Local upgrade agent/reader, frozen v44 SQL producer, real Linux SQLite/files, GitFiles/FrameworkTransactions/package retirement. Native creation and profile/package service facts controlled; Git repository controlled in memory. Subsequent Task checks exercise actual admission method and Git business transaction, not full role/model execution. No live DSH activation/model, Windows, user installation or remote repository.' }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  DshAgentGateway.prototype.create = originalCreate
  hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true })
}
