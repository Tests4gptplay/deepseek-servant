import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createElement as h } from 'react'
import { Worker } from 'node:worker_threads'
import { hooks, hash, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { localFilesWorkerSource, historicalProducer } from './test-support/historical-v44/load-sql-producer.mjs'

// This exact Note path is emitted by the SHA-verified frozen v44
// taskInitializationFiles for a running O Task. The old SQLite Worker supplies
// the actual original row; this is not a complete original Host invocation.
const note = 'task-runs/10000000-0000-4000-8000-000000000001/Organizer_Note.md'
const body = 'Original authored Organizer note\n'
const otherNote = 'task-runs/10000000-0000-4000-8000-000000000001/Dispatch.md'
const { FrameworkService } = await import('../src/framework/service.ts')
const { installFrameworkTransport } = await import('../src/framework/transport.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { auditLocalUpgradeSource } = await import('../src/framework/local-upgrade-source-audit.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { materializeLegacyLocalFiles, localStartupUpgradeKey, keepRetainedLocalUpgradeStage } = await import('../src/framework/local-startup-upgrade.ts')
const { assessLocalUpgradeCompletion, retireLocalUpgradeRecords, readLocalUpgradeCompleted } = await import('../src/framework/local-upgrade-completion.ts')
const { localUpgradeView } = await import('../src/framework/local-upgrade-view.ts')
const { LocalUpgradeStatus } = await import('../src/framework/client-upgrade-status.ts')
const { renderToStaticMarkup } = await import(new URL('../node_modules/react-dom/server.node.js', import.meta.url))

class Records {
  constructor(root) { this.files = new LocalRecordFiles(path.join(root, 'records')) }
  async get(key) { const value = await this.files.read(hash(key) + '.json'); return value === undefined ? undefined : JSON.parse(value) }
  async set(key, value) { await this.files.replace(hash(key) + '.json', JSON.stringify(value)) }
  async delete(key) { await this.files.delete(hash(key) + '.json') }
  async list() { throw Error('Addressed disk record test must not scan Host storage') }
}

if (process.argv[2] === '--stop') {
  const root = process.argv[3], phase = process.argv[4], stoppedPath = process.argv[5] ?? note
  await materializeLegacyLocalFiles(path.join(root, 'files'), new Records(root), {
    deferActivation: process.argv[6] === 'defer', onProgress: ({ step, path: logical }) => {
      if (phase.startsWith('created') && step === 'created' && logical === stoppedPath) process.kill(process.pid, 'SIGKILL')
    },
  })
  throw Error('The requested real stop boundary was not reached')
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-d071-ambiguity-'))
const results = []
const expectProjection = true
let assertions = 0
function check(actual, expected, reason) { assert.deepEqual(actual, expected, reason); assertions++ }
async function seed(root, paths = [note]) {
  const directory = path.join(root, 'files'); await fs.mkdir(directory, { recursive: true })
  const worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath: path.join(directory, 'dss-files.sqlite'), writer: true } })
  try {
    await new Promise((resolve, reject) => {
      worker.on('error', reject)
      worker.on('message', message => {
        if (message.startupError) reject(Error(message.startupError.message))
        else if (message.ready) worker.postMessage({ id: 1, method: 'commit', args: { changes: paths.map(item => typeof item === 'string' ? { path: item, content: item === note ? body : 'Original authored dispatch\n' } : item), dependencies: [], revision: 'old-note' } })
        else if (message.id === 1) message.error ? reject(Error(message.error.message)) : resolve()
      })
    })
  } finally { await worker.terminate() }
  return directory
}
const require = createRequire(new URL('../package.json', import.meta.url))
const React = require('react'), { createRoot } = require('react-dom/client'), { JSDOM } = require('jsdom'), esbuild = require('esbuild')
const source = fileURLToPath(new URL('../src/', import.meta.url))
const entry = `export { FrameworkPage } from ${JSON.stringify(path.join(source, 'framework/client-page.tsx'))};`
const built = await esbuild.build({ stdin: { contents: entry, resolveDir: source, loader: 'ts' }, bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', logLevel: 'silent', plugins: [{ name: 'controlled-css-port', setup(api) {
    api.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'css', namespace: 'css' }))
    api.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: 'export default {}', loader: 'js' }))
  } }] })
const primitives = new Proxy({}, { get(_target, key) {
  if (key === 'Button') return React.forwardRef(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children))
  if (key === 'Input') return React.forwardRef((props, ref) => React.createElement('input', { ...props, ref }))
  if (key === 'SegmentedControl') return ({ options, onChange }) => React.createElement('div', {}, options.map(option => React.createElement('button', { key: option.value, onClick: () => onChange(option.value) }, option.label)))
  if (key === 'Menu') return ({ anchor }) => anchor
  return () => null
} })
const module = { exports: {} }
new Function('require', 'module', 'exports', '__SERVANT_ICON_DATA_URI__', '__SERVANT_WELCOME_CHARACTER_DATA_URI__', '__SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__', built.outputFiles[0].text)(
  specifier => specifier === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(specifier), module, module.exports, '', '', '')
const { FrameworkPage } = module.exports
async function settingsClickFlow(directory, records, owner, route, input, beforeConfirm = async () => {}, expectedSaved = true) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://controlled.test/' })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  let calls = 0, reply, submitted
  const api = { view: async () => ({ revision: 'fixture', activeMode: 'local', collaborationId: 'fixture', storageScope: input.storageScope,
      settings: { name: 'DSS', userName: 'User', localDirectory: directory, ownerRepo: '', repositoryDirectory: '', collaborationId: 'fixture', workerSeats: 0, workspace: '' },
      connection: { status: 'connected', participating: true }, messages: [], tasks: [], legacyTasks: [], archives: [], resources: [], executions: [],
      localUpgrade: await localUpgradeView(directory, records, { result: owner.result }) }),
    history: async () => ({ messages: [], order: [], storageScope: input.storageScope }), subscribeChanged: () => () => {},
    keepCurrentLocalUpgradeTarget: async payload => {
      submitted = structuredClone(payload); calls++
      const response = await route.fetch(new Request('https://controlled.test/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'click-' + calls,
          method: 'deepseek-servant-framework/keepCurrentLocalUpgradeTarget', payload }) }))
      const data = await response.json(); reply = data.result
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.value
    } }
  const root = createRoot(document.getElementById('root'))
  try {
    await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en', settingsOnly: true })))
    const button = label => [...document.querySelectorAll('button')].find(item => item.textContent === label)
    for (let attempt = 0; attempt < 20 && !button('Choose to keep this ambiguous stage'); attempt++)
      await React.act(async () => new Promise(resolve => setTimeout(resolve, 5)))
    check(!!button('Choose to keep this ambiguous stage'), true, 'actual Settings renders stage choice')
    await React.act(async () => button('Choose to keep this ambiguous stage').click())
    check(calls, 0, 'first click is local review; no RPC')
    await React.act(async () => button('Cancel choice').click())
    check(calls, 0, 'cancel does not call RPC')
    await React.act(async () => button('Choose to keep this ambiguous stage').click())
    await beforeConfirm()
    await React.act(async () => button('Confirm keeping this stage out of cleanup').click())
    for (let attempt = 0; attempt < 30 && !reply; attempt++) await React.act(async () => new Promise(resolve => setTimeout(resolve, 5)))
    check(submitted, input, 'Settings submitted exact scope, operation, stage path, and distinct confirmation')
    check(reply, { ok: true, value: { saved: expectedSaved } }, 'production transport reached Service')
    return { calls }
  } finally { await React.act(async () => root.unmount()); dom.window.close() }
}
try {
  for (const phase of ['created', 'created-replaced']) {
    const root = path.join(scratch, phase), directory = await seed(root), records = new Records(root)
    const sqlBefore = hash(await fs.readFile(path.join(directory, 'dss-files.sqlite')))
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop', root, phase], { encoding: 'utf8', timeout: 30000, env: process.env })
    check(child.signal, 'SIGKILL', phase + ' truly stopped the process')
    const operation = await records.get(localStartupUpgradeKey(directory)), recorded = operation.files.find(file => file.path === note)
    check(recorded.status, 'prepared', phase + ' was not owned')
    check(recorded.owned, undefined, phase + ' has no durable inode identity')
    check(typeof recorded.stagePath, 'string', phase + ' saved a concrete private path')
    const stage = path.join(directory, recorded.stagePath)
    const producerIdentity = await fs.stat(stage, { bigint: true })
    if (phase === 'created-replaced') {
      // A normal editor can save an empty file by atomic replace after the
      // original stage became visible in the user's physical records folder.
      await fs.writeFile(stage + '.editor-save', '')
      await fs.rename(stage + '.editor-save', stage)
      const replacement = await fs.stat(stage, { bigint: true })
      assert.notDeepEqual([replacement.dev, replacement.ino, replacement.birthtimeNs],
        [producerIdentity.dev, producerIdentity.ino, producerIdentity.birthtimeNs], 'editor replacement did not keep the producer inode')
      assertions++
    }
    check((await fs.readFile(stage)).length, 0, phase + ' has an empty file at the same persisted path')
    const unowned = await fs.stat(stage, { bigint: true })
    const resumed = await materializeLegacyLocalFiles(directory, new Records(root))
    check(resumed.status, 'complete', phase + ' exported the original independently')
    check(await fs.readFile(path.join(directory, note), 'utf8'), body, phase + ' retained original final bytes')
    check((await fs.readFile(stage)).length, 0, phase + ' did not overwrite unowned stage')
    const after = await fs.stat(stage, { bigint: true })
    check([after.dev, after.ino, after.birthtimeNs], [unowned.dev, unowned.ino, unowned.birthtimeNs], phase + ' preserved exact unowned inode')
    const pendingBefore = await assessLocalUpgradeCompletion(directory, records)
    check(pendingBefore.pending.some(item => item.path === recorded.stagePath), true, phase + ' keeps unresolved stage visible to finish')
    const noFinishView = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report: resumed } })
    check(noFinishView.pending?.some(item => item.path === recorded.stagePath) ?? false, expectProjection,
      phase + ' projection of retained stage without finish assessment')
    const statusHtml = renderToStaticMarkup(LocalUpgradeStatus({ value: noFinishView, tr: chinese => chinese }))
    check(statusHtml.includes(recorded.stagePath), expectProjection, phase + ' actual rendered status exposes stage path only when projected')
    if (expectProjection) {
      check(statusHtml.includes(resumed.retainedStages[0].reason), true, phase + ' actual rendered status exposes retention reason')
      check(statusHtml.includes('归属待核'), true, phase + ' adds cautious Chinese stage guidance')
    }
    const finishView = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report: resumed, pending: pendingBefore.pending } })
    check(finishView.pending.some(item => item.path === recorded.stagePath), true, phase + ' projects the exact path after finish assessment')
    check(finishView.pending.filter(item => item.path === recorded.stagePath).length, 1, phase + ' does not duplicate existing finish item')
    const runningView = await localUpgradeView(directory, records, {})
    check(runningView.pending, undefined, phase + ' does not claim an unseen running stage')
    const completedView = await localUpgradeView(directory, records, { result: { status: 'complete', scope: 'local-sql-physical-upgrade', report: resumed } })
    check(completedView.pending, undefined, phase + ' does not surface old stage entries after confirmed completion')
    const assessedNoStage = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report: resumed, pending: [] } })
    check(assessedNoStage.pending, undefined, phase + ' does not revive a stage after a newer finish assessment found none')
    const otherIssue = { path: note, reason: 'An unrelated original remains pending' }
    const unfinishedReport = { ...resumed, status: 'incomplete', issues: [{ code: 'source-row', path: note, message: otherIssue.reason }] }
    const unfinishedView = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report: unfinishedReport, pending: [otherIssue] } })
    check(unfinishedView.pending.some(item => item.path === recorded.stagePath), expectProjection,
      phase + ' shows last-reported stage even when unrelated work prevents a complete finish assessment')
    check(unfinishedView.pending.filter(item => item.path === note).length, 1, phase + ' keeps the separate actual issue once')
    const storageScope = 'local-stage-choice-scope'
    const agentResult = { status: 'pending', scope: 'local-sql-physical-upgrade', report: resumed, pending: pendingBefore.pending }
    let starts = 0
    const owner = { controller: new AbortController(), work: Promise.resolve(agentResult), result: agentResult,
      agent: { start: async () => { starts++; const assessment = await assessLocalUpgradeCompletion(directory, records)
        const audit = await auditLocalUpgradeSource(directory, records)
        return assessment.pending.length || audit.issues.length
          ? { status: 'pending', scope: 'local-sql-physical-upgrade', report: assessment.report, pending: assessment.pending }
          : { status: 'complete', scope: 'local-sql-physical-upgrade', report: assessment.report, sourceAudit: audit } } } }
    const access = { connection: { files: new PhysicalLocalFiles(directory), scope: storageScope } }
    const service = Object.assign(Object.create(FrameworkService.prototype), { access: async () => access,
      checkScope: (_access, scope) => check(scope, storageScope, 'exact Local scope'),
      localUpgrades: new Map([[directory, owner]]), storage: records, changed: () => {}, report: () => {},
      subscribeChanged: () => () => {}, withSafetyOperation: async (_name, _payload, work) => work(), errorPresentation: () => undefined })
    const routes = new Map(), effects = []
    const ctx = { inject(_names, fn) { fn({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
      effect(effect) { effects.push(effect()) } }); return { dispose: async () => { for (const effect of effects) await effect?.() } } } }
    const dispose = installFrameworkTransport(ctx, service)
    const route = routes.get('/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget')
    check(!!route, true, 'existing Local choice RPC route registered')
    const call = async (payload, rpcId) => (await route.fetch(new Request('https://controlled.test/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId,
        method: 'deepseek-servant-framework/keepCurrentLocalUpgradeTarget', payload }) }))).json()
    const input = { mode: 'local', storageScope, operationId: resumed.operationId, path: recorded.stagePath,
      confirmation: 'keep-retained-stage-without-cleanup' }
    try {
      check((await records.get(localStartupUpgradeKey(directory))).retainedStages[0].keptByUser, undefined, 'no choice persisted before click')
      if (phase === 'created') {
        const click = await settingsClickFlow(directory, records, owner, route, input, async () => {
          await fs.writeFile(stage + '.editor-save', '')
          await fs.rename(stage + '.editor-save', stage)
        })
        const postPreviewReplacement = await fs.stat(stage, { bigint: true })
        check(postPreviewReplacement.ino !== after.ino, true, 'atomic replacement occurred after Settings button appeared')
        check(click.calls, 1, 'two-step Settings click sent one RPC')
      } else {
        const wrong = await call({ ...input, operationId: 'wrong' }, 'wrong-operation')
        check(wrong.result.ok, false, 'stale operation rejected')
        check((await call(input, 'explicit-choice')).result, { ok: true, value: { saved: true } }, 'exact RPC reached Service')
      }
      await owner.work
      check(starts, 1, 'only chosen owner Agent resumed once')
      const selected = (await records.get(localStartupUpgradeKey(directory))).retainedStages[0]
      check(selected.path, recorded.stagePath, 'exact stage choice persisted')
      check(typeof selected.keptByUser.selectedAt, 'string', 'decision timestamp persisted')
      check((await call(input, 'retry')).result, { ok: true, value: { saved: true } }, 'same choice retry idempotent')
      check(starts, 1, 'retry does not restart Agent')
      check((await new Records(root).get(localStartupUpgradeKey(directory))).retainedStages[0].keptByUser.selectedAt,
        selected.keptByUser.selectedAt, 'cold restart preserves exact decision')
      const pendingAfter = await assessLocalUpgradeCompletion(directory, records)
      check(pendingAfter.pending.some(item => item.path === recorded.stagePath), false, 'chosen stage alone no longer blocks finish')
      check((await fs.stat(stage, { bigint: true })).ino !== undefined, true, 'choice never removes stage')
      check((await fs.readFile(stage)).length, 0, 'stage bytes unchanged')
      const coldView = await localUpgradeView(directory, records, { result: owner.result })
      check(coldView.keptRetainedStages?.[0]?.path, recorded.stagePath, 'selected path remains visible after continuation')
      const audit = await auditLocalUpgradeSource(directory, records)
      check(audit.issues, [], 'existing source audit, not choice, verifies original conversion')
      const completed = { kind: 'dss-local-upgrade-result', directory, operationId: resumed.operationId,
        completedAt: new Date().toISOString(), report: pendingAfter.report, cleanup: pendingAfter.cleanup, sourceAudit: audit }
      check(await retireLocalUpgradeRecords(records, completed, 'fixture-one-time-wake'), undefined, 'exact retirement keeps completed report')
      const cold = await readLocalUpgradeCompleted(directory, new Records(root))
      check(cold.report.retainedStages.find(item => item.path === recorded.stagePath).keptByUser.selectedAt,
        selected.keptByUser.selectedAt, 'cold completed result retains user decision after operation retirement')
      check((await localUpgradeView(directory, new Records(root))).keptRetainedStages?.[0]?.path,
        recorded.stagePath, 'cold UI shows stage disposition after operation retirement')
      if (phase === 'created') await fs.writeFile(stage, 'Later user-controlled content')
      else await fs.unlink(stage)
      check((await localUpgradeView(directory, new Records(root))).keptRetainedStages?.[0]?.path,
        recorded.stagePath, 'later file change does not change recorded choice or claim file existence')
      results.push({ phase, stage: recorded.stagePath, chosen: selected.keptByUser, pendingAfter: pendingAfter.pending,
        originalSha256: hash(await fs.readFile(path.join(directory, 'dss-files.sqlite'))) })
    } finally { await dispose(); await access.connection.files.close() }
    check(hash(await fs.readFile(path.join(directory, 'dss-files.sqlite'))), sqlBefore, phase + ' retained original SQL')

  }
  {
    const root = path.join(scratch, 'moved-after-preview'), directory = await seed(root), records = new Records(root)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop', root, 'created'],
      { encoding: 'utf8', timeout: 30000, env: process.env })
    check(child.signal, 'SIGKILL', 'real stage creation stop before later move')
    const report = await materializeLegacyLocalFiles(directory, records)
    const stagePath = report.retainedStages[0].path, stage = path.join(directory, stagePath)
    const before = await assessLocalUpgradeCompletion(directory, records)
    const pending = { status: 'pending', scope: 'local-sql-physical-upgrade', report, pending: before.pending }
    const storageScope = 'moved-stage-scope'
    let starts = 0
    const owner = { controller: new AbortController(), work: Promise.resolve(pending), result: pending,
      agent: { start: async () => { starts++; const assessment = await assessLocalUpgradeCompletion(directory, records)
        return { status: assessment.pending.length ? 'pending' : 'complete', scope: 'local-sql-physical-upgrade',
          report: assessment.report, pending: assessment.pending } } } }
    const access = { connection: { files: new PhysicalLocalFiles(directory), scope: storageScope } }
    const service = Object.assign(Object.create(FrameworkService.prototype), { access: async () => access,
      checkScope: (_access, scope) => check(scope, storageScope, 'moved-stage scope'),
      localUpgrades: new Map([[directory, owner]]), storage: records, changed: () => {}, report: () => {},
      subscribeChanged: () => () => {}, withSafetyOperation: async (_name, _payload, work) => work(), errorPresentation: () => undefined })
    const routes = new Map(), effects = []
    const ctx = { inject(_names, fn) { fn({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
      effect(effect) { effects.push(effect()) } }); return { dispose: async () => { for (const effect of effects) await effect?.() } } } }
    const dispose = installFrameworkTransport(ctx, service)
    const route = routes.get('/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget')
    try {
      const input = { mode: 'local', storageScope, operationId: report.operationId, path: stagePath,
        confirmation: 'keep-retained-stage-without-cleanup' }
      const click = await settingsClickFlow(directory, records, owner, route, input,
        async () => fs.rename(stage, stage + '.user-moved'), false)
      check(click.calls, 1, 'moved-stage Settings click reached existing RPC once')
      await owner.work
      check(starts, 1, 'normal owner continuation reassesses missing path')
      check((await records.get(localStartupUpgradeKey(directory))).retainedStages[0].keptByUser, undefined,
        'stage moved after preview: no keep decision falsely claims an existing path')
      check((await assessLocalUpgradeCompletion(directory, records)).pending, [],
        'normal assessment naturally clears missing stage pending')
      check(await fs.readFile(stage + '.user-moved', 'utf8'), '', 'moved material untouched')
    } finally { await dispose(); await access.connection.files.close() }
  }
  {
    // These auxiliary rows use old Writer names and controlled content solely
    // to verify current finish gates; they do not claim a whole old Host run.
    const taskId = '10000000-0000-4000-8000-000000000001'
    const task = 'tasks/' + taskId + '.json', skill = 'skills/original/SKILL.md'
    const conversation = 'conversation-index/local/original/index.json'
    const root = path.join(scratch, 'semantic-gates'), directory = await seed(root, [
      note, { path: task, content: JSON.stringify({ taskId, status: 'running', sourcePath: 'task-runs/' + taskId + '/Dispatch.md' }) },
      { path: skill, content: '# Original skill\n' }, { path: conversation, content: JSON.stringify({ messages: [] }) },
    ]), records = new Records(root)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop', root, 'created', note, 'defer'],
      { encoding: 'utf8', timeout: 30000, env: process.env })
    check(child.signal, 'SIGKILL', 'real note-stage stop alongside controlled semantic rows')
    const report = await materializeLegacyLocalFiles(directory, records, { deferActivation: true })
    check(report.retainedStages.length, 1, 'same actual stage responsibility persists')
    check(report.status, 'incomplete', 'special rows were not marked converted by generic export')
    const selected = await keepRetainedLocalUpgradeStage(directory, records, report.operationId, report.retainedStages[0].path)
    check(selected.saved, true, 'exact stage disposition can be recorded without claiming conversion')
    const assessment = await assessLocalUpgradeCompletion(directory, records)
    check(assessment.report.status, 'incomplete', 'stage choice does not mark operation complete')
    check([task, skill, conversation].every(path => assessment.pending.some(item => item.path === path)), true,
      'Task, skill and conversation remain pending under existing gates')
    check((await fs.readFile(path.join(directory, 'dss-files.sqlite'))).length > 0, true, 'original SQL remains')
  }
  {
    const root = path.join(scratch, 'two-retained-stages'), directory = await seed(root, [note, otherNote]), records = new Records(root)
    for (const target of [otherNote, note]) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop', root, 'created', target],
        { encoding: 'utf8', timeout: 30000, env: process.env })
      check(child.signal, 'SIGKILL', 'real producer stop at ' + target)
    }
    const report = await materializeLegacyLocalFiles(directory, records)
    check(report.retainedStages.length, 2, 'two independently created and retained stages')
    const stages = report.retainedStages.map(item => item.path)
    const before = await assessLocalUpgradeCompletion(directory, records)
    check(stages.every(path => before.pending.some(item => item.path === path)), true, 'both stages block finish before choice')
    const storageScope = 'two-stage-scope', pending = { status: 'pending', scope: 'local-sql-physical-upgrade', report, pending: before.pending }
    let starts = 0
    const owner = { controller: new AbortController(), work: Promise.resolve(pending), result: pending,
      agent: { start: async () => { starts++; const assessment = await assessLocalUpgradeCompletion(directory, records)
        return { status: 'pending', scope: 'local-sql-physical-upgrade', report: assessment.report, pending: assessment.pending } } } }
    const access = { connection: { files: new PhysicalLocalFiles(directory), scope: storageScope } }
    const service = Object.assign(Object.create(FrameworkService.prototype), { access: async () => access,
      checkScope: (_access, scope) => check(scope, storageScope, 'two-stage scope'),
      localUpgrades: new Map([[directory, owner]]), storage: records, changed: () => {}, report: () => {} })
    const input = path => ({ mode: 'local', storageScope, operationId: report.operationId, path,
      confirmation: 'keep-retained-stage-without-cleanup' })
    try {
      // Hold the first actual operation read; a second Settings window must not overwrite it.
      const originalGet = records.get.bind(records); let release, entered, held = false
      const wait = new Promise(resolve => { release = resolve }), arrived = new Promise(resolve => { entered = resolve })
      records.get = async key => { const value = await originalGet(key)
        if (!held && key === localStartupUpgradeKey(directory)) { held = true; entered(); await wait } return value }
      const first = service.keepCurrentLocalUpgradeTarget(input(stages[0]))
      await arrived
      await assert.rejects(() => service.keepCurrentLocalUpgradeTarget(input(stages[1])), /refresh and retry/); assertions++
      release()
      check(await first, { saved: true }, 'first concurrent client saves only its exact stage')
      await owner.work
      check((await assessLocalUpgradeCompletion(directory, records)).pending.map(item => item.path), [stages[1]],
        'second real retained stage still blocks finish')
      check(await service.keepCurrentLocalUpgradeTarget(input(stages[1])), { saved: true }, 'second client explicit retry saves other stage')
      await owner.work
      check((await assessLocalUpgradeCompletion(directory, records)).pending, [], 'both exact stage choices release only stage pending')
      check(starts, 2, 'one owner continuation per accepted choice, none for rejected concurrent choice')
      check((await records.get(localStartupUpgradeKey(directory))).retainedStages.filter(item => item.keptByUser).length, 2,
        'both paths and decisions durably retained')
    } finally { await access.connection.files.close() }
  }
  console.log(JSON.stringify({ assertions, results, historicalProducer, ...evidence(), limits: [
    'Actual frozen v44 Worker row and currently shipped Local publisher on disposable Linux files; Note path independently verified against frozen taskInitializationFiles.',
    'Both SIGKILLs occur at the actual created callback; one case then uses ordinary editor-style atomic replace of that visible empty stage with another empty inode. This is a safety counterexample, not a reported user incident.',
    'The disk Records and native owner continuation ports are controlled, not a full installed DSH Host, model, Windows/macOS or power-loss acceptance test.',
    'The selected ambiguous stage remains untouched; only its exact cleanup responsibility is set aside by explicit user choice.',
    'Actual FrameworkPage ReactDOM/JSDOM click, production transport registration and Service method run; native Agent/model continuation is controlled, not executed.'
  ] }, null, 2))
} finally { hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
