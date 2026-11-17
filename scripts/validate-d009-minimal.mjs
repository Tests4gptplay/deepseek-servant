import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Source-selected red/green test. Real PhysicalLocalFiles and HostLoop observe
// ordinary direct input + STATE files; the runtime's source methods choose the
// exact live execution and consume the original signal. Only native send/open,
// storage, and unrelated Markdown/skill/schema dependencies are controlled.
const selected = process.env.DSS_SOURCE_ROOT ?? fileURLToPath(new URL('..', import.meta.url))
const root = path.resolve(selected)
const sourceRoot = pathToFileURL(path.join(root, 'src') + path.sep)
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(){throw new Error('Markdown outside this test')}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', sourceRoot).href)
        return { url: data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skills outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts'))
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    return next(url, context)
  }
})
const { PhysicalLocalFiles } = await import(pathToFileURL(path.join(root, 'src/framework/physical-local-files.ts')).href)
const { FrameworkHostLoop } = await import(pathToFileURL(path.join(root, 'src/framework/host-loop.ts')).href)
const { GitFiles, withOperationChannel, withSnapshot } = await import(pathToFileURL(path.join(root, 'src/framework/transactions.ts')).href)
const { SessionGitOperations } = await import(pathToFileURL(path.join(root, 'src/framework/git-authority.ts')).href)
const { Repository, put, head } = await import(pathToFileURL(path.join(root, 'scripts/test-support/controlled-git/repository.mjs')).href)
const { parseDirectSignal } = await import(pathToFileURL(path.join(root, 'src/framework/role-tools.ts')).href)
const { taskLifecycle } = await import(pathToFileURL(path.join(root, 'src/framework/task-files.ts')).href)
const source = stripTypeScriptTypes(readFileSync(path.join(root, 'src/framework/role-runtime.ts'), 'utf8'), { mode: 'transform' })
function method(name) {
  const match = new RegExp('\\n    (?:async )?' + name + '\\(').exec(source)
  assert(match, `Missing production runtime method ${name}`)
  const start = match.index + 1
  const next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(source.slice(start + match[0].length))
  assert(next, `No end for ${name}`)
  return source.slice(start, start + match[0].length + next.index)
}
const names = ['roleKey', 'requestKey', 'active', 'executing', 'addressedSignals', 'consumeWakeSignals', 'taskNoticeState', 'rememberTaskNotice', 'taskNotificationOwner', 'scheduleTaskNotification', 'notifyDirect', 'notifyTask', 'taskNoticeConsumption', 'serialWork', 'startMaintenance']
const Runtime = new Function('withOperationChannel', 'taskLifecycle', 'randomUUID', 'SessionId', 'parseDirectSignal', 'withSnapshot', 'PhysicalLocalFiles', 'hash', 'return class {\n' + names.map(method).join('\n') + '\n}')(withOperationChannel, taskLifecycle, randomUUID, value => value, parseDirectSignal, withSnapshot, PhysicalLocalFiles, value => createHash('sha256').update(value).digest('hex'))
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-direct-routing-'))
let caseNumber = 0
async function fixture(active = [], signals = []) {
  const files = new PhysicalLocalFiles(path.join(scratch, 'case-' + ++caseNumber))
  const state = new Map(), wakes = [], sends = [], errors = []
  const storage = { get: async key => structuredClone(state.get(key)), set: async (key, value) => { state.set(key, structuredClone(value)) }, list: async () => [] }
  const nativeOwners = new Map()
  const runtime = Object.assign(new Runtime(), {
    config: { member: 'A' }, files, closed: false, roleRecords: new Map(),
    native: { get(workId, executionId) { const owner = nativeOwners.get(workId); return !executionId || owner?.executionId === executionId ? owner : undefined } },
    taskNotices: new WeakMap(), taskNoticeObservations: new WeakMap(), taskNoticeClock: 0, wakeConsumptions: new Map(), assertOrganizerBusiness() {},
    ctx: { agents: { get: () => undefined }, get: () => undefined },
    error(error) { errors.push(error) }
  })
  for (const item of active) {
    const { role, taskId, workerId, directId } = item
    const workId = runtime.roleKey(role, taskId, workerId, directId), executionId = 'execution-' + nativeOwners.size
    const sessionId = 'session-' + executionId
    runtime.roleRecords.set(workId, { identity: { workId, executionId, role, ...(taskId ? { taskId, member: 'A' } : {}), ...(workerId ? { workerId } : {}) }, sessionId, generation: 1,
      lastWake: { id: 'accepted-' + executionId, role, taskId, workerId, reason: 'notification', sources: directId ? [{ path: `state/${role}_A_Direct_${directId}`, version: 'accepted' }] : [] } })
    const owner = { executionId, sessionId, observe: () => ({ state: 'running' }),
      send: async (body, id, mode) => { sends.push({ workId, body: JSON.parse(body), id, mode }) } }
    nativeOwners.set(workId, owner)
  }
  for (const taskId of new Set(active.map(item => item.taskId).filter(Boolean))) {
    const sourcePath = `tasks/${taskId}_P.md`
    await files.replace(`tasks/${taskId}.json`, JSON.stringify({ version: 1, taskId, route: 'P', owner: 'A', members: ['A'], status: 'running', sourcePath, archiveFolder: taskId, workspaceFolder: `Task_${taskId}` }))
    await files.replace(sourcePath, `Task ID: ${taskId}\nAn ordinary P Task.`)
  }
  for (const { role, id } of signals) {
    await files.replace(`direct/${id}.md`, `Explicit external ${role} item ${id}`)
    await files.replace(`state/${role}_A_Direct_${id}`, '')
  }
  const identity = { member: 'A', primary: true, scope: 'direct-routing', instanceUUID: '10000000-0000-4000-8000-000000000001' }
  const actions = {
    startup: async () => {}, observe: async () => {}, observeLocal: async () => {},
    readRoundStarted: observation => runtime.taskNoticeObservations.set(observation, runtime.taskNoticeClock),
    executing: (...args) => runtime.executing(...args),
    wake: async request => { wakes.push(request); return true },
    notifyDirect: request => runtime.notifyDirect(request),
    error: error => errors.push(error), admitDiscovered: async () => {}
  }
  const { FrameworkTransactions: Transactions } = await import(pathToFileURL(path.join(root, 'src/framework/command-transactions.ts')).href)
  const host = new FrameworkHostLoop(files, new Transactions(files, storage, 'direct-routing'), storage, identity, () => ['A'], actions)
  await host.start(); await host.firstPoll
  async function drain() {
    for (let i = 0; i < 25; i++) {
      const pending = [...runtime.maintenance?.values() ?? []]
      if (!pending.length) return
      await Promise.all(pending)
    }
    throw new Error('Native notice maintenance did not settle')
  }
  await drain()
  return { files, host, runtime, wakes, sends, errors, drain, async close() { await host.stop(); await files.close() } }
}
try {
  // An active Task Planner is unrelated to an explicit direct Planner ID.
  let f = await fixture([{ role: 'Planner', taskId: '11111111-1111-4111-8111-111111111111' }], [{ role: 'Planner', id: 'direct-b' }])
  check(f.wakes.length, 1)
  check(f.runtime.requestKey(f.wakes[0]), f.runtime.roleKey('Planner', undefined, undefined, 'direct-b'))
  check(f.sends, [])
  check(f.errors, [])
  await f.close()

  // Two distinct direct Planner IDs may proceed independently; Worker seats
  // remain scoped to their own direct ID and the existing native admission.
  f = await fixture([{ role: 'Planner', directId: 'direct-a' }, { role: 'Worker', directId: 'worker-a', workerId: 'worker-a' }],
    [{ role: 'Planner', id: 'direct-b' }, { role: 'Worker', id: 'worker-b' }])
  check(f.wakes.length, 2)
  check(f.wakes.map(request => f.runtime.requestKey(request)).sort(), [f.runtime.roleKey('Planner', undefined, undefined, 'direct-b'), f.runtime.roleKey('Worker', undefined, 'worker-b', 'worker-b')].sort())
  check(f.errors, [])
  await f.close()

  // An ordinary Worker with the same worker ID does not own the Direct work ID.
  f = await fixture([{ role: 'Worker', taskId: '22222222-2222-4222-8222-222222222222', workerId: 'same' }], [{ role: 'Worker', id: 'same' }])
  check(f.wakes.length, 1)
  check(f.runtime.requestKey(f.wakes[0]), f.runtime.roleKey('Worker', undefined, 'same', 'same'))
  check(f.sends, [])
  check(f.errors, [])
  await f.close()

  // Repeated observation of the original signal must not wake/inject a second time.
  // The existing source-version-aware consumeWakeSignals method then deletes it.
  f = await fixture([{ role: 'Planner', directId: 'direct-a' }, { role: 'Worker', directId: 'worker-a', workerId: 'worker-a' }],
    [{ role: 'Planner', id: 'direct-a' }, { role: 'Worker', id: 'worker-a' }])
  check(f.wakes, [])
  check(f.sends, [])
  await f.host.poll(); await f.drain()
  check(f.wakes, [])
  check(f.sends, [])
  for (const [role, id] of [['Planner', 'direct-a'], ['Worker', 'worker-a']]) {
    const workId = f.runtime.roleKey(role, undefined, role === 'Worker' ? id : undefined, id)
    const record = f.runtime.roleRecords.get(workId)
    const path = `state/${role}_A_Direct_${id}`
    const info = await f.files.fileMetadata(path)
    record.lastWake.sources = [{ path, version: info.version }]
    const binding = { ...record.identity, direct: { inputPath: `direct/${id}.md`, signalPath: path } }
    check((await f.runtime.consumeWakeSignals(binding)).signals, [path])
    check(await f.files.fileMetadata(path), undefined)
  }
  await f.host.poll(); await f.drain()
  check(f.wakes, [])
  check(f.sends, [])
  check(f.errors, [])
  await f.close()

  // Git protocol input is one atomic authorized commit. Real GitFiles + Host
  // must route it despite an unrelated active Task Planner.
  const repo = new Repository()
  put(repo, 'direct/git-item.md', 'Third-party original direct requirement')
  put(repo, 'state/Planner_A_Direct_git-item', '')
  head(repo)
  const git = new GitFiles(repo, new SessionGitOperations())
  const gitState = new Map(), gitWakes = [], gitErrors = []
  const gitStorage = { get: async key => structuredClone(gitState.get(key)), set: async (key, value) => { gitState.set(key, structuredClone(value)) }, list: async () => [] }
  const running = new Runtime()
  running.roleRecords = new Map()
  running.native = { get: () => ({ observe: () => ({ state: 'running' }) }) }
  running.ctx = { agents: { get: () => undefined }, get: () => undefined }
  running.roleRecords.set(running.roleKey('Planner', '11111111-1111-4111-8111-111111111111'), {
    identity: { role: 'Planner', workId: running.roleKey('Planner', '11111111-1111-4111-8111-111111111111'), taskId: '11111111-1111-4111-8111-111111111111' },
    sessionId: 'ordinary-task', generation: 1
  })
  const { FrameworkTransactions: Transactions } = await import(pathToFileURL(path.join(root, 'src/framework/command-transactions.ts')).href)
  const gitHost = new FrameworkHostLoop(git, new Transactions(git, gitStorage, 'git-direct'), gitStorage,
    { member: 'A', primary: true, scope: 'direct-routing', instanceUUID: '10000000-0000-4000-8000-000000000001' }, () => ['A'],
    { startup: async () => {}, observe: async () => {}, observeLocal: async () => {}, executing: (...args) => running.executing(...args),
      wake: async request => { gitWakes.push(request); return true }, error: error => gitErrors.push(error), admitDiscovered: async () => {} })
  await gitHost.start(); await gitHost.firstPoll
  check(gitWakes.length, 1)
  check(gitWakes[0].sources.map(source => source.path), ['state/Planner_A_Direct_git-item'])
  check(running.requestKey(gitWakes[0]), running.roleKey('Planner', undefined, undefined, 'git-item'))
  check(gitErrors, [])
  // Existing Git initial-claim chain consumes only the observed Direct source.
  const directWake = gitWakes[0]
  const directWorkId = running.requestKey(directWake)
  const directRecord = { identity: { workId: directWorkId, executionId: 'git-direct-exec', role: 'Planner' },
    sessionId: 'git-direct-session', generation: 1, lastWake: directWake }
  running.roleRecords.set(directWorkId, directRecord)
  running.files = git
  running.config = { member: 'A' }
  running.closed = false
  running.wakeConsumptions = new Map()
  running.assertOrganizerBusiness = () => {}
  running.taskCommandOwner = () => undefined
  running.transactions = new Transactions(git, gitStorage, 'git-direct-claim')
  check((await running.consumeWakeSignals({ ...directRecord.identity, direct: {
    inputPath: 'direct/git-item.md', signalPath: 'state/Planner_A_Direct_git-item' } })).signals,
    ['state/Planner_A_Direct_git-item'])
  check(await withSnapshot(git, snapshot => git.read(snapshot, 'state/Planner_A_Direct_git-item')), undefined)
  check(await withSnapshot(git, snapshot => git.read(snapshot, 'direct/git-item.md')), 'Third-party original direct requirement')
  await gitHost.poll()
  check(gitWakes.length, 1)
  check(gitErrors, [])
  await gitHost.stop()

  console.log(JSON.stringify({ status: 'passed', assertions, scope: 'Actual HostLoop start/poll, PhysicalLocalFiles and controlled GitFiles direct input/STATE, source runtime identity/executing/consumption methods; controlled native/storage/remote transport. No real DSH, UI, or remote network.' }))
} finally {
  await fs.rm(scratch, { recursive: true, force: true })
  hooks.deregister()
}
