import { z } from 'zod'
import { AsyncLocalStorage } from 'node:async_hooks'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual service open/stop/relocation methods and physical cleanup files.
// Native runtime/workspace/registration are controlled ports, not a full DSH
// host or Windows acceptance test. Tests assert ordering, not elapsed speed.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const baseline = process.env.DSS_MANUAL_CLEANUP_BASELINE
const sourceAt = url => baseline && ['manual-cleanup.ts', 'service.ts'].includes(path.basename(fileURLToPath(url)))
  ? readFileSync(path.join(baseline, 'src/framework', path.basename(fileURLToPath(url))), 'utf8') : readFileSync(url, 'utf8')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(){return {type:'root',children:[]}}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/role-tools.ts', root).href) return { url: data(`export function workerPaths(){throw new Error('Worker tool paths are outside this cleanup check')}`), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      const source = sourceAt(new URL(url)); loaded.set(url.slice(root.href.length), hash(source))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { taskHistoryChange } = await import('../src/framework/task-history.ts')
const { FrameworkSafetyNet } = await import('../src/framework/safety-net.ts')
const { requiresUserAction } = await import('../src/framework/client-error.ts')
const { FilesConflictError, FilesOutcomeUnknownError, withSnapshot, withOperationChannel } = await import('../src/framework/transactions.ts')
const serviceSource = sourceAt(new URL('framework/service.ts', root))
loaded.set('framework/service.ts', hash(serviceSource))
const serviceJs = stripTypeScriptTypes(serviceSource, { mode: 'transform' })
function method(name, optional = false) {
  const match = new RegExp('\\n    (?:async )?' + name + '\\(').exec(serviceJs)
  if (!match && optional) return ''
  assert.ok(match, 'actual service method ' + name)
  const start = match.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(serviceJs.slice(start + match[0].length))
  assert.ok(next); return serviceJs.slice(start, start + match[0].length + next.index)
}
let current
const Service = new Function('DshWorkspaceAdapter', 'openFrameworkConnection', 'withOperationChannel', 'ConversationAttachments', 'FrameworkRoleRuntime',
  'PhysicalLocalFiles', 'FrameworkManualCleanup', 'createRecorderCapacity', 'pendingLocalInitializationOriginal', 'abortedBy', 'z', 'requiresUserAction', 'FilesConflictError', 'FilesOutcomeUnknownError',
  'return class {\n' + ['open', 'quiesceRecords', 'stopRunning', 'serialMode', 'withManualCleanup', 'cleanupRecords', 'report', 'captureSafety', 'deliverSafetyFaults', 'refreshErrors', 'changed', 'diagnosticScope'].map(name => method(name)).join('\n') + method('stopManualCleanup', true) + '\n}')(
    class { async resolve() { return { directory: current.directory } } }, async () => current.connection,
    withOperationChannel, class { async initialize() {} }, function (_ctx, files) { assert.equal(files, current.files); return current.runtime },
    PhysicalLocalFiles, FrameworkManualCleanup, () => ({}), async () => undefined,
    (signal, error) => !!signal?.aborted && (error === signal.reason || error?.name === 'AbortError' && error.cause === signal.reason), z, requiresUserAction, FilesConflictError, FilesOutcomeUnknownError,
  )
const names = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const read = (files, target) => withSnapshot(files, s => files.read(s, target))
const pending = files => withSnapshot(files, s => files.listDirectory(s, 'technical/manual-cleanup/intents/'))
const tick = () => new Promise(resolve => setImmediate(resolve))
const scratch = process.argv[2] === '--crash' ? process.argv[3] : await fs.mkdtemp(path.join(os.tmpdir(), 'dss-cleanup-startup-'))
const transactions = { run() { throw new Error('Manual physical cleanup must not create a generic transaction') } }
async function fixture(name, directory = path.join(scratch, name)) {
  const f = { directory, files: new PhysicalLocalFiles(directory), events: [], reports: [] }
  f.conversation = new FrameworkConversation(f.files, transactions, { mode: 'local', collaborationId: 'manual' })
  f.runtime = {
    config: { scope: directory }, conversation: f.conversation,
    async start() { f.events.push('start'); await f.onStart?.() }, setForegroundModel() {},
    async dispose() { f.events.push('runtime-dispose') }, async settleForStorageMove() { f.events.push('settle-for-move') },
    async isForegroundResetComplete() { return false },
    async withForegroundReset(_commandId, action) { await f.beforeReset?.(); return action() },
    async prepareTaskCleanup(taskId) { await f.beforeTask?.(taskId) }, async taskCleanupComplete() { return true },
  }
  f.cleanup = new FrameworkManualCleanup(f.files, transactions, f.conversation, f.runtime)
  f.connection = { files: f.files, transactions, records: {}, sharedRecords: {}, scope: directory,
    registration: { member: 'manual', instanceUUID: 'fixture', primary: true, workerSeats: 1 }, identity: { login: 'manual', instanceUUID: 'fixture' },
    async members() { return [] }, async close() { f.events.push('connection-close'); await f.files.close() }, cancelPending() {},
  }
  const settings = { localDirectory: directory, userName: 'manual', collaborationId: 'manual', workerSeats: 1, workspace: directory }
  f.service = Object.assign(new Service(), {
    ctx: {}, storage: {}, running: new Map(), reportedErrors: new Map(), startupErrors: new Map(), stopping: new WeakMap(), gitUpgrades: new Map(),
    modeConfiguration: new Map(), modeSending: new Map(), settingsCommands: new Map(), conversationBarriers: new Map(),
    localUpgrades: new Map(), accesses: new Map(), accessOpening: new Map(), backgroundOpening: new Map(), opening: new Map(), relocationOwners: new Map(), archiveViews: new Map(),
    config: () => ({ settings }), assertOpen() {}, changed() {}, startLocalUpgrade() {}, safetyCallbacks: () => ({}), deliverSafetyFaults() {},
    report(_mode, error, scope, commandId) { f.reports.push({ error: String(error), scope, commandId }) },
    cleanupFailure(_mode, error) { f.reports.push({ error: String(error), disposal: true }) }, refreshErrors() {},
    async modeReady() {}, checkScope(access, scope) { assert.equal(access.connection.scope, scope) },
    async access() { return { connection: f.connection, conversation: f.conversation } }, async closeAccess() {},
  })
  f.open = async () => { current = f; return f.service.open('local') }
  return f
}
async function seed(f, kind, commandId = 'accepted-' + kind) {
  if (kind === 'debug') { await f.files.replace('debug/2026-11-07.md', 'reviewed one'); await f.files.replace('debug/2026-11-08.md', 'reviewed two') }
  else await f.conversation.writeForeground('notes', { list: 'reviewed list', cache: 'reviewed cache' })
  const preview = await f.cleanup.previewFiles(kind), failure = new Error('Interrupt accepted cleanup before first selected file')
  const key = kind === 'debug' ? 'deleteObserved' : 'updateAsync', original = f.files[key].bind(f.files)
  f.files[key] = async (...args) => { if (preview.files.some(x => x.path === args[0])) throw failure; return original(...args) }
  try { await assert.rejects(() => kind === 'debug' ? f.cleanup.clearDebug(commandId, preview, 'clear-debug-records')
    : f.cleanup.clearPlanning(commandId, 'clear-work-planning-notes', preview), error => error === failure) }
  finally { f.files[key] = original }
  return { kind, commandId, preview }
}
function holdFile(f, selected, { after = false, fail = false } = {}) {
  const entered = deferred(), release = deferred(), key = selected.kind === 'debug' ? 'deleteObserved' : 'updateAsync'
  const original = f.files[key].bind(f.files); let held = false
  f.files[key] = async (...args) => {
    if (!held && args[0] === selected.preview.files[0].path) {
      held = true; const result = after ? await original(...args) : undefined
      entered.resolve(); await release.promise
      if (fail) throw new Error('Exact selected file I/O failed')
      return after ? result : original(...args)
    }
    return original(...args)
  }
  return { entered, release, restore: () => { f.files[key] = original } }
}
const observeStarted = async (f, held, opening) => {
  await held.entered.promise; await tick()
  check('Actual Local open reaches runtime.start while selected file is held', f.events.includes('start'), true)
  return opening
}
if (process.argv[2] === '--crash') {
  const f = await fixture('', scratch), selected = JSON.parse(await fs.readFile(path.join(scratch, 'selection.json'), 'utf8'))
  const held = holdFile(f, selected, { after: true }), opening = f.open()
  await held.entered.promise; await opening
  process.stdout.write('background-first-file-finished\n')
  // A real process handle keeps the deliberately interrupted child alive.
  const keepAlive = setInterval(() => {}, 60_000)
  await held.release.promise; clearInterval(keepAlive)
  throw new Error('SIGKILL child should not finish the held operation')
}
try {
  {
    const f = await fixture('no-pending'), active = await f.open()
    check('No accepted file cleanup creates no deferred owner', active.manualCleanup, undefined)
    check('No accepted cleanup leaves no new intent', await pending(f.files), [])
    check('Ordinary empty startup still reaches runtime.start', f.events.includes('start'), true)
    await f.service.stopRunning(active)
  }
  for (const kind of ['debug', 'planning']) {
    const f = await fixture('independent-' + kind), selected = await seed(f, kind), held = holdFile(f, selected)
    let scans = 0; const list = f.files.listDirectory.bind(f.files)
    f.files.listDirectory = async (s, target, ...args) => { if (target === 'technical/manual-cleanup/intents/') scans++; return list(s, target, ...args) }
    f.onStart = async () => {
      await f.files.replace('task-runs/independent/notes.md', 'unrelated task can run')
      await f.files.replace(selected.preview.files[0].path, 'newer same-path content')
      await f.files.replace('debug/2026-11-09.md', 'not in original preview')
    }
    const opening = f.open(), active = await observeStarted(f, held, opening)
    check(kind + ' publishes Running without awaiting file continuation', f.service.running.get('local'), active)
    check(kind + ' allows unrelated task writes', await read(f.files, 'task-runs/independent/notes.md'), 'unrelated task can run')
    check(kind + ' discovers accepted intents once', scans, 1)
    held.release.resolve(); await active.manualCleanup.work
    check(kind + ' retains later same-path writes', await read(f.files, selected.preview.files[0].path), 'newer same-path content')
    check(kind + ' finishes unchanged second selected file', await read(f.files, selected.preview.files[1].path), kind === 'debug' ? undefined : '')
    check(kind + ' retains files absent from original preview', await read(f.files, 'debug/2026-11-09.md'), 'not in original preview')
    check(kind + ' retires existing intent without a completion receipt', await pending(f.files), [])
    await f.service.stopRunning(active)
  }
  {
    const f = await fixture('same-file-order'), selected = await seed(f, 'planning')
    const entered = deferred(), release = deferred(), target = selected.preview.files[0].path, original = f.files.updateAsync.bind(f.files)
    f.files.updateAsync = (p, decide, signal) => original(p, async bytes => { if (p === target) { entered.resolve(); await release.promise } return decide(bytes) }, signal)
    const opening = f.open(); await entered.promise; const active = await opening
    let written = false; const write = f.files.replace(target, 'later queued writer').then(() => { written = true })
    await f.files.replace('task-runs/other/notes.md', 'independent queued work'); await tick()
    check('Actual same-file writer waits for admitted mutation', written, false)
    check('Other Task does not share the same-file wait', await read(f.files, 'task-runs/other/notes.md'), 'independent queued work')
    release.resolve(); await Promise.all([write, active.manualCleanup.work])
    check('Later same-file write survives original planning cleanup', await read(f.files, target), 'later queued writer')
    await f.service.stopRunning(active)
  }
  for (const kind of ['debug', 'planning']) for (const boundary of ['stop', 'move', 'startup-failure']) {
    const f = await fixture(boundary + '-' + kind), selected = await seed(f, kind), held = holdFile(f, selected, { after: true })
    const failStartup = deferred(), enteredStartup = deferred()
    if (boundary === 'startup-failure') f.onStart = async () => { enteredStartup.resolve(); await failStartup.promise }
    const opening = f.open(); if (boundary === 'startup-failure') void opening.catch(() => {})
    await held.entered.promise
    const active = boundary === 'startup-failure' ? undefined : await opening
    let stopped = false
    const shutdown = boundary === 'stop' ? f.service.stopRunning(active)
      : boundary === 'move' ? f.service.quiesceRecords({ commandId: 'move', retained: true }, new AbortController().signal)
      : (await enteredStartup.promise, failStartup.reject(new Error('Runtime startup failed')), assert.rejects(opening, /Runtime startup failed/))
    const settled = shutdown.then(() => { stopped = true }); await tick()
    check(boundary + '/' + kind + ' keeps connection alive for admitted file', f.events.includes('connection-close'), false)
    check(boundary + '/' + kind + ' still owns continuation', stopped, false)
    held.release.resolve(); await settled
    check(boundary + '/' + kind + ' closes after admitted operation settles', f.events.includes('connection-close'), true)
    const reopened = await fixture('reopened', f.directory)
    check(boundary + '/' + kind + ' leaves original intent for restart', (await pending(reopened.files)).length, 1)
    check(boundary + '/' + kind + ' stops before second selected file', await read(reopened.files, selected.preview.files[1].path), kind === 'debug' ? 'reviewed two' : selected.preview.files[1].path.endsWith('List.md') ? 'reviewed list' : 'reviewed cache')
    await reopened.files.replace(selected.preview.files[0].path, 'written while stopped'); await reopened.cleanup.resumePending()
    check(boundary + '/' + kind + ' restart finishes original remaining selection', await read(reopened.files, selected.preview.files[1].path), kind === 'debug' ? undefined : '')
    check(boundary + '/' + kind + ' restart preserves replacement', await read(reopened.files, selected.preview.files[0].path), 'written while stopped')
    check(boundary + '/' + kind + ' restart retires original intent', await pending(reopened.files), [])
    check(boundary + '/' + kind + ' requested cancellation is not a cleanup fault', f.reports.filter(x => !x.disposal).length, 0)
    await reopened.files.close()
  }
  {
    const f = await fixture('io-failure'), selected = await seed(f, 'debug'), held = holdFile(f, selected, { fail: true })
    const opening = f.open(), active = await observeStarted(f, held, opening)
    held.release.resolve(); await active.manualCleanup.work
    check('Background I/O fault retains original command in existing report', f.reports.map(x => x.commandId), [selected.commandId])
    check('Background I/O fault leaves accepted intent discoverable', (await pending(f.files)).length, 1)
    held.restore(); await f.cleanup.resumePending(); check('Later continuation retires failed intent', await pending(f.files), [])
    await f.service.stopRunning(active)
  }
  // Exercise the existing real report -> captureSafety -> pending/delivery path,
  // including a failed runtime.start. There is no error-array phase to miss.
  for (const phase of ['before-registration', 'startup-rejection', 'after-registration']) {
    const f = await fixture('report-' + phase), selected = await seed(f, 'debug'), held = holdFile(f, selected, { fail: true })
    for (const key of ['report', 'refreshErrors', 'changed', 'deliverSafetyFaults']) delete f.service[key]
    Object.assign(f.service, { safetyNet: new FrameworkSafetyNet('startup-cleanup-test'), safetyOperations: new AsyncLocalStorage(),
      safetyErrors: new WeakMap(), resolvedRoleFacts: new Set(), resolvedSafetyFaultIds: new Set(), safetyDeliveries: new Set(),
      errors: new Map(), userErrors: new Map(), listeners: new Set(), saved: new Map() })
    const recorded = deferred(), startRelease = deferred(); const repairs = []
    f.service.listeners.add(() => { if ([...(f.service.reportedErrors.get('local')?.values() ?? [])].some(x => x.commandId === selected.commandId)) recorded.resolve() })
    f.runtime.requestSafetyRepair = async fault => { repairs.push(fault) }
    if (phase !== 'after-registration') f.onStart = () => startRelease.promise
    const opening = f.open(); void opening.catch(() => {})
    await held.entered.promise
    let active
    if (phase === 'after-registration') active = await opening
    held.release.resolve(); await recorded.promise
    check(phase + ' records original cleanup failure through actual service.report', [...f.service.reportedErrors.get('local').values()].some(x => x.commandId === selected.commandId), true)
    check(phase + ' retains original intent after selected I/O fails', (await pending(f.files)).length, 1)
    if (phase !== 'after-registration') {
      check(phase + ' has no registered runtime when fault is captured', f.service.running.size, 0)
      check(phase + ' retains repair responsibility in existing Safety Net', f.service.safetyNet.pending('local', f.directory).length, 1)
      if (phase === 'startup-rejection') {
        startRelease.reject(new Error('Original runtime.start rejected')); await assert.rejects(opening, /Original runtime.start rejected/)
        check('Startup rejection does not discard earlier cleanup report', [...f.service.reportedErrors.get('local').values()].some(x => x.commandId === selected.commandId), true)
        continue
      }
      startRelease.resolve(); active = await opening
    }
    await active.manualCleanup.work; await tick()
    check(phase + ' delivers the retained fault after runtime becomes available', repairs.length, 1)
    await f.service.stopRunning(active)
  }
  // The real cleanupRecords UI endpoint can retry while startup's continuation
  // is still pending. Access and Running have distinct physical handles, as in
  // the service. Both share only LocalRecordFiles' process-local same-file order.
  for (const kind of ['debug', 'planning']) {
    const f = await fixture('ui-retry-' + kind), selected = await seed(f, kind), held = holdFile(f, selected)
    const opening = f.open(), active = await observeStarted(f, held, opening)
    const accessFiles = new PhysicalLocalFiles(f.directory), accessConversation = new FrameworkConversation(accessFiles, transactions, { mode: 'local', collaborationId: 'manual' })
    const access = { connection: { ...f.connection, files: accessFiles }, conversation: accessConversation }
    f.service.access = async () => access
    const result = await f.service.cleanupRecords({ mode: 'local', storageScope: f.directory, commandId: selected.commandId,
      action: kind, preview: selected.preview, confirmation: kind === 'debug' ? 'clear-debug-records' : 'clear-work-planning-notes' })
    check('Real UI ' + kind + ' same-command retry completes while startup continuation is pending', result.cleared, true)
    await accessFiles.replace(selected.preview.files[0].path, 'new after returned UI retry')
    held.release.resolve(); await active.manualCleanup.work
    check('Older startup ' + kind + ' continuation preserves the post-retry write', await read(f.files, selected.preview.files[0].path), 'new after returned UI retry')
    check('Concurrent UI ' + kind + ' retry leaves no orphan intent', await pending(f.files), [])
    await accessFiles.close(); await f.service.stopRunning(active)
  }
  // Task/reset intents are produced by actual accepted cleanup methods. Native
  // stopping is a controlled port; existing suite separately runs actual reset
  // persistence methods through real process interruptions.
  for (const kind of ['tasks', 'conversation']) {
    const f = await fixture('blocking-' + kind), file = await seed(f, 'debug'), blocker = new Error('Interrupted lifecycle')
    if (kind === 'tasks') {
      const task = { version: 1, taskId: 'done', route: 'P', owner: 'manual', status: 'complete', sourcePath: 'tasks/original_P.md', archiveFolder: 'original_P_done', resultPaths: [] }
      const history = taskHistoryChange(task); await f.files.replace(history.path, history.content)
      await f.files.replace('archives/original_P_done/records.md', 'selected task history')
      const preview = await f.cleanup.previewTasks(); f.beforeTask = async () => { throw blocker }
      await assert.rejects(f.cleanup.clearTasks('accepted-tasks', preview, 'clear-ended-task-records'), error => error === blocker)
    } else {
      await f.conversation.send('original', { id: 'original', participantId: 'user', createdAt: '2026-11-11T00:00:00Z', role: 'user', recipient: 'ai', text: 'reviewed original' })
      f.beforeReset = async () => { throw blocker }
      await assert.rejects(f.cleanup.clearConversation('accepted-conversation', 'clear-foreground-conversation'), error => error === blocker)
    }
    const entered = deferred(), release = deferred(); let first = true
    f[kind === 'tasks' ? 'beforeTask' : 'beforeReset'] = async () => { if (first) { first = false; entered.resolve(); await release.promise } }
    const held = holdFile(f, file), opening = f.open(); await entered.promise; await tick()
    check(kind + ' lifecycle still precedes runtime.start', f.events.includes('start'), false)
    release.resolve(); const active = await observeStarted(f, held, opening)
    check(kind + ' lifecycle finishes before unrelated file continuation', (await pending(f.files)).length, 1)
    held.release.resolve(); await active.manualCleanup.work; await f.service.stopRunning(active)
  }
  {
    const f = await fixture('default-awaited'), selected = await seed(f, 'debug'), held = holdFile(f, selected)
    let finished = false; const work = f.cleanup.resumePending().then(result => { finished = true; return result })
    await held.entered.promise; await tick(); check('Default resumePending still awaits files', finished, false)
    held.release.resolve(); check('Default resumePending returns its completed result', (await work).length, 1); await f.files.close()
  }
  for (const kind of ['debug', 'planning']) {
    const f = await fixture('kill-' + kind), selected = await seed(f, kind)
    await fs.writeFile(path.join(f.directory, 'selection.json'), JSON.stringify(selected)); await f.files.close()
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash', f.directory, kind], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; const reached = deferred(), ended = deferred()
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('background-first-file-finished')) reached.resolve() })
    child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', error => { reached.reject(error); ended.reject(error) })
    child.once('close', (code, signal) => { if (!stdout.includes('background-first-file-finished')) reached.reject(new Error(stderr || 'Child ended before boundary')); ended.resolve({ code, signal }) })
    await reached.promise; child.kill('SIGKILL'); const exit = await ended.promise
    check('Actual ' + kind + ' process killed after first background file', exit.signal, 'SIGKILL')
    const r = await fixture('restart', f.directory)
    check('Process interruption retains original ' + kind + ' intent', (await pending(r.files)).length, 1)
    await r.files.replace(selected.preview.files[0].path, 'new after SIGKILL')
    const active = await r.open(); await active.manualCleanup.work
    check('Cold startup finishes original remaining ' + kind + ' file', await read(r.files, selected.preview.files[1].path), kind === 'debug' ? undefined : '')
    check('Cold startup preserves later ' + kind + ' replacement', await read(r.files, selected.preview.files[0].path), 'new after SIGKILL')
    check('Cold startup retires ' + kind + ' intent', await pending(r.files), [])
    await r.service.stopRunning(active)
  }
  console.log(JSON.stringify({ ok: true, assertions: names.length, processInterruptions: 2, baseline: baseline ?? null, names, loadedSources: Object.fromEntries(loaded), limitations: ['Controlled native/runtime/registration ports, not a full DSH application', 'Linux SIGKILL is not physical power loss or Windows validation', 'Same-file queue is process-local, not external-editor exclusion'] }, null, 2))
} finally { hooks.deregister(); if (!process.env.DSS_KEEP_CLEANUP_FIXTURES) await fs.rm(scratch, { recursive: true, force: true }) }
