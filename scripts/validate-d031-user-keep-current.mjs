import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { Worker } from 'node:worker_threads'
import { createElement as h } from 'react'
import { localFilesWorkerSource, historicalProducer } from './test-support/historical-v44/load-sql-producer.mjs'

const sourceRoot = new URL('../src/', import.meta.url), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { materializeLegacyLocalFiles, keepCurrentLocalUpgradeTarget, readLegacyLocalOriginal, localStartupUpgradeKey } = await import('../src/framework/local-startup-upgrade.ts')
const { auditLocalUpgradeSource } = await import('../src/framework/local-upgrade-source-audit.ts')
const { assessLocalUpgradeCompletion, retireLocalUpgradeRecords, readLocalUpgradeCompleted } = await import('../src/framework/local-upgrade-completion.ts')
const { localUpgradeView } = await import('../src/framework/local-upgrade-view.ts')
const { LocalUpgradeStatus } = await import('../src/framework/client-upgrade-status.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkService } = await import('../src/framework/service.ts')
const { installFrameworkTransport } = await import('../src/framework/transport.ts')
const { renderToStaticMarkup } = await import(new URL('../node_modules/react-dom/server.node.js', import.meta.url))
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
const note = 'debug/2026-11-07.md', body = 'Original Helper report', scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-d031-choice-'))
let checks = 0
const check = (value, expected, label) => { assert.deepEqual(value, expected, label); checks++ }
const rejection = async (work, match) => { await assert.rejects(work, match); checks++ }
class DiskRecords {
  constructor(root) { this.root = root; this.records = new LocalRecordFiles(path.join(root, 'records')); this.key = localStartupUpgradeKey(path.join(root, 'files')) }
  file(key) { return key === this.key ? 'upgrade.json' : hash(key) + '.json' }
  async get(key) { const raw = await this.records.read(this.file(key)); return raw === undefined ? undefined : JSON.parse(raw) }
  async set(key, value) {
    const pausePath = process.argv[4] ?? note, published = value.files?.find(file => file.path === pausePath && file.status === 'published')
    if (process.argv[2] === '--producer' && key === this.key && published) {
      process.send?.({ boundary: true, target: path.join(this.root, 'files', pausePath), stage: path.join(this.root, 'files', published.stagePath), fact: path.join(this.root, 'records/upgrade.json') })
      await new Promise(() => setInterval(() => {}, 1000))
    }
    await this.records.replace(this.file(key), JSON.stringify(value))
  }
  async delete(key) { await this.records.delete(this.file(key)) }
  async list() { throw Error('No generic record scan belongs to this test.') }
}
if (process.argv[2] === '--producer') {
  const root = process.argv[3]
  await materializeLegacyLocalFiles(path.join(root, 'files'), new DiskRecords(root), { deferActivation: true })
  throw Error('The actual post-rename boundary was not reached.')
}
const outcomes = []
async function seed(root, paths = [note]) {
  const directory = path.join(root, 'files'); await fs.mkdir(directory, { recursive: true })
  const worker = new Worker(localFilesWorkerSource, { eval: true, workerData: { databasePath: path.join(directory, 'dss-files.sqlite'), writer: true } })
  try {
    await new Promise((resolve, reject) => {
      worker.on('error', reject)
      worker.on('message', message => {
        if (message.startupError) reject(Error(message.startupError.message))
        else if (message.ready) worker.postMessage({ id: 1, method: 'commit', args: { changes: paths.map(item => typeof item === 'string' ? { path: item, content: body } : item), dependencies: [], revision: 'old-helper-report' } })
        else if (message.id === 1) message.error ? reject(Error(message.error.message)) : resolve()
      })
    })
  } finally { await worker.terminate() }
  return directory
}
async function stoppedProducer(root, pausePath = note) {
  const child = fork(fileURLToPath(import.meta.url), ['--producer', root, pausePath], { silent: true }); child.stdout.resume()
  let boundary
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  const stopped = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('message', async message => {
      if (!message.boundary) return
      boundary = message
      try { check(existsSync(message.target), true, 'real target after rename'); check(existsSync(message.stage), false, 'original stage consumed'); child.kill('SIGTERM') }
      catch (error) { child.kill('SIGTERM'); reject(error) }
    })
    child.on('exit', (code, signal) => resolve({ code, signal }))
  }); clearTimeout(timer)
  check(stopped.signal, 'SIGTERM', 'real process stop')
  assert.ok(boundary)
  return boundary
}
async function settingsClickFlow(directory, records, owner, service, conflict, storageScope) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://controlled.test/' })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const routes = new Map(), effects = []
  service.subscribeChanged = () => () => {}
  service.withSafetyOperation = async (_method, _payload, work) => work()
  service.errorPresentation = () => undefined
  const ctx = { inject(_names, fn) { fn({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    effect(effect) { effects.push(effect()) } }); return { dispose: async () => { for (const effect of effects) await effect?.() } } } }
  const dispose = installFrameworkTransport(ctx, service)
  const route = routes.get('/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget')
  check([route.methods, route.requestBody], [['POST'], 'buffered'], 'real native transport route registered')
  let calls = 0, reply, submitted
  const api = { view: async () => ({ revision: 'fixture', activeMode: 'local', collaborationId: 'fixture', storageScope,
      settings: { name: 'DSS', userName: 'User', localDirectory: directory, ownerRepo: '', repositoryDirectory: '', collaborationId: 'fixture', workerSeats: 0, workspace: '' },
      connection: { status: 'connected', participating: true }, messages: [], tasks: [], legacyTasks: [], archives: [], resources: [], executions: [],
      localUpgrade: await localUpgradeView(directory, records, { result: owner.result }) }),
    history: async () => ({ messages: [], order: [], storageScope }), subscribeChanged: () => () => {},
    keepCurrentLocalUpgradeTarget: async payload => {
      submitted = structuredClone(payload)
      calls++; const envelope = { type: 'client-request', rpcId: 'rpc-' + calls, method: 'deepseek-servant-framework/keepCurrentLocalUpgradeTarget', payload }
      const response = await route.fetch(new Request('https://controlled.test/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) }))
      const data = await response.json(); reply = data.result
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.value
    } }
  const root = createRoot(document.getElementById('root'))
  try {
    await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en', settingsOnly: true })))
    const button = label => [...document.querySelectorAll('button')].find(item => item.textContent === label)
    for (let attempt = 0; attempt < 20 && !button('Choose to keep current state'); attempt++)
      await React.act(async () => new Promise(resolve => setTimeout(resolve, 5)))
    if (!button('Choose to keep current state')) console.error('SETTINGS_HTML', document.body.innerHTML.slice(0, 4000))
    check(!!button('Choose to keep current state'), true, 'actual Settings panel renders exact eligible choice')
    check((await records.get(records.key)).files.find(item => item.path === note).status, 'owned', 'no choice before user clicks')
    await React.act(async () => button('Choose to keep current state').click())
    check(calls, 0, 'first click is only a local review, not RPC')
    check((await records.get(records.key)).files.find(item => item.path === note).status, 'owned', 'first click did not save choice')
    await React.act(async () => button('Cancel choice').click())
    check(calls, 0, 'cancelled choice sends no RPC')
    check((await records.get(records.key)).files.find(item => item.path === note).status, 'owned', 'cancelled choice does not write')
    await React.act(async () => button('Choose to keep current state').click())
    await React.act(async () => button('Confirm keeping current state without exporting this row').click())
    for (let attempt = 0; attempt < 30 && !reply; attempt++)
      await React.act(async () => new Promise(resolve => setTimeout(resolve, 5)))
    await React.act(async () => new Promise(resolve => setTimeout(resolve, 10)))
    check(calls, 1, 'second click calls exact native route once')
    check(submitted, { mode: 'local', storageScope, operationId: conflict.operationId, path: note,
      confirmation: 'keep-current-with-original-unexported' }, 'Settings submitted exact row, scope and operation')
    check(reply, { ok: true, value: { saved: true } }, 'real route reached Service and returned saved')
    check((await records.get(records.key)).files.find(item => item.path === note).status, 'kept-current-unexported', 'user-confirmed route persisted choice')
    return { calls, operationId: conflict.operationId }
  } finally { await React.act(async () => root.unmount()); await dispose(); dom.window.close() }
}
try {
  for (const disposition of ['deleted', 'replaced']) {
    const root = path.join(scratch, disposition), directory = await seed(root), originalSql = await fs.readFile(path.join(directory, 'dss-files.sqlite'))
    const boundary = await stoppedProducer(root), records = new DiskRecords(root)
    const persisted = await records.get(records.key), file = persisted.files.find(item => item.path === note)
    check([file.status, file.ready, !!file.owned], ['owned', true, true], 'original ready fact')
    if (disposition === 'deleted') await fs.unlink(boundary.target)
    else { await fs.writeFile(boundary.target + '.new', 'New user content'); await fs.rename(boundary.target + '.new', boundary.target) }
    const conflict = await materializeLegacyLocalFiles(directory, new DiskRecords(root), { deferActivation: true })
    check(conflict.issues.some(issue => issue.path === note && issue.code === 'target-conflict'), true, 'real conflict before user choice')
    const pending = { status: 'pending', scope: 'local-sql-physical-upgrade', report: conflict }
    const view = await localUpgradeView(directory, records, { result: pending })
    check(view.conflicts, [{ path: note, operationId: conflict.operationId }], 'exact UI choice projection')
    const html = renderToStaticMarkup(h(LocalUpgradeStatus, { value: view, tr: (cn) => cn, onKeepCurrent: async () => {} }))
    check(html.includes('选择保留当前状态'), true, 'UI renders explicit choice')
    check(html.includes('只保留在原 SQL'), false, 'UI does not claim SQL is the only copy')
    const access = { connection: { files: new PhysicalLocalFiles(directory), scope: 'local-test-scope' } }
    let agentStarts = 0
    const owner = { controller: new AbortController(), work: Promise.resolve(pending), result: pending,
      agent: { start: () => { agentStarts++; return materializeLegacyLocalFiles(directory, records, { deferActivation: true })
        .then(report => ({ status: 'pending', scope: 'local-sql-physical-upgrade', report })) } } }
    const service = Object.assign(Object.create(FrameworkService.prototype), {
      access: async () => access, checkScope: (_access, scope) => check(scope, 'local-test-scope', 'scope checked'),
      localUpgrades: new Map([[directory, owner]]), storage: records, changed: () => {}, report: () => {},
    })
    const input = { mode: 'local', storageScope: 'local-test-scope', operationId: conflict.operationId, path: note,
      confirmation: 'keep-current-with-original-unexported' }
    await rejection(() => service.keepCurrentLocalUpgradeTarget({ ...input, confirmation: 'no' }), /Confirm keeping/)
    await rejection(() => service.keepCurrentLocalUpgradeTarget({ ...input, operationId: 'wrong' }), /changed/)
    if (disposition === 'deleted') await settingsClickFlow(directory, records, owner, service, conflict, 'local-test-scope')
    else check(await service.keepCurrentLocalUpgradeTarget(input), { saved: true }, 'explicit UI RPC saves exact choice')
    await owner.work
    check(agentStarts, 1, 'one continuation of existing Agent')
    const selected = await records.get(records.key), selectedFile = selected.files.find(item => item.path === note)
    check(selectedFile.status, 'kept-current-unexported', 'not falsely published')
    check(selectedFile.keptCurrent.target, disposition === 'deleted' ? 'absent' : 'different-inode', 'actual target state recorded')
    check(selectedFile.keptCurrent.selectedAt.length > 0, true, 'decision time recorded')
    const selectedAt = selectedFile.keptCurrent.selectedAt
    check(await service.keepCurrentLocalUpgradeTarget(input), { saved: true }, 'same choice retry accepted')
    check(agentStarts, 1, 'same choice retry does not restart Agent')
    check((await new DiskRecords(root).get(records.key)).files.find(item => item.path === note).keptCurrent.selectedAt, selectedAt, 'cold persisted choice unchanged')
    const fresh = await materializeLegacyLocalFiles(directory, new DiskRecords(root), { deferActivation: true })
    check([fresh.status, fresh.published, fresh.alreadyPresent, fresh.keptCurrent], ['complete', 0, 0,
      [{ path: note, target: disposition === 'deleted' ? 'absent' : 'different-inode' }]], 'cold report truthfully marks unexported')
    const assessment = await assessLocalUpgradeCompletion(directory, records)
    check(assessment.pending, [], 'only explicitly retained row no longer blocks finish')
    const audit = await auditLocalUpgradeSource(directory, records)
    check(audit.issues, [], 'original source audit has no unresolved conversion claim')
    check(audit.onlyOriginalBytesInSql.some(item => item.path === note), true, 'original-only bytes remain visible')
    const completed = { kind: 'dss-local-upgrade-result', directory, operationId: conflict.operationId, completedAt: new Date().toISOString(), report: fresh,
      cleanup: assessment.cleanup, sourceAudit: audit }
    check(await retireLocalUpgradeRecords(records, completed, 'test-one-time-wake'), undefined, 'existing exact retirement accepts resolved result')
    const after = await readLocalUpgradeCompleted(directory, new DiskRecords(root))
    check(after.report.keptCurrent, fresh.keptCurrent, 'compact result retains unexported decision after original operation retirement')
    check(await records.get(records.key), undefined, 'old transient operation retired only after compact fact')
    check(hash(await fs.readFile(path.join(directory, 'dss-files.sqlite'))), hash(originalSql), 'original SQL preserved')
    check(Buffer.from((await readLegacyLocalOriginal(directory, note)).bytes).toString(), body, 'original row manually retrievable after finish')
    check(disposition === 'deleted' ? existsSync(boundary.target) : await fs.readFile(boundary.target, 'utf8'),
      disposition === 'deleted' ? false : 'New user content', 'user physical state unchanged')
    const completedView = await localUpgradeView(directory, new DiskRecords(root))
    const completedHtml = renderToStaticMarkup(h(LocalUpgradeStatus, { value: completedView, tr: cn => cn }))
    check(completedHtml.includes('部分旧原文未导出') && completedHtml.includes('原 SQL 仍保留'), true, 'UI keeps decision visible after completion')
    outcomes.push({ disposition, conflict: conflict.issues.find(issue => issue.path === note)?.code, agentStarts,
      finalStatus: after.report.status, retained: after.report.keptCurrent, originalOnly: audit.onlyOriginalBytesInSql.map(item => item.path) })
    await access.connection.files.close()
  }
  for (const caseName of ['preexisting-target', 'before-no-replace', 'delivered-target']) {
    const root = path.join(scratch, caseName), directory = await seed(root), records = new DiskRecords(root)
    const target = path.join(directory, note)
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (caseName === 'preexisting-target') await fs.writeFile(target, 'Existing independent content')
    const report = await materializeLegacyLocalFiles(directory, records, { deferActivation: true,
      ...(caseName === 'before-no-replace' ? { onProgress: async ({ step }) => {
        if (step === 'ready') await fs.writeFile(target, 'Independent winner before publication')
      } } : {}) })
    const pending = { status: 'pending', scope: 'local-sql-physical-upgrade', report }
    const view = await localUpgradeView(directory, records, { result: pending })
    const html = renderToStaticMarkup(h(LocalUpgradeStatus, { value: view, tr: cn => cn, onKeepCurrent: async () => {} }))
    check(view.conflicts, [], caseName + ' does not present ready-stage-absent choice')
    check(html.includes('选择保留当前状态'), false, caseName + ' has no misleading stage-absent UI')
    if (caseName === 'delivered-target') {
      check(report.status, 'complete', 'delivered target completes ordinarily')
      check(report.published, 1, 'delivered target is actually published')
    } else {
      check(report.issues.some(issue => issue.code === 'target-conflict' && issue.path === note), true, caseName + ' still reports actual target conflict')
      await rejection(() => keepCurrentLocalUpgradeTarget(directory, records, report.operationId, note),
        /Only the original unresolved ready-stage target conflict/, caseName + ' cannot select unrelated conflict')
      if (caseName === 'before-no-replace') {
        const file = (await records.get(records.key)).files.find(item => item.path === note)
        check(existsSync(path.join(directory, file.stagePath)), true, 'original ready stage remains after no-replace conflict')
      }
    }
  }
  {
    const root = path.join(scratch, 'task-source-not-selectable'), sourcePath = 'debug/task-source.md', directory = await seed(root,
      [{ path: sourcePath, content: body }, { path: 'tasks/t.json', content: JSON.stringify({ sourcePath }) }])
    const records = new DiskRecords(root), report = await materializeLegacyLocalFiles(directory, records, { deferActivation: true })
    check(report.issues.some(issue => issue.code === 'source-row' && issue.path === sourcePath), true, 'actual one-time Agent materialize defers original Task source')
    check((await records.get(records.key)).files.some(item => item.path === sourcePath), false, 'Task source has no generic ready-stage publication to select')
    const view = await localUpgradeView(directory, records, { result: { status: 'pending', scope: 'local-sql-physical-upgrade', report } })
    check(view.conflicts, [], 'Task source is not a user choice even when old SQL remains')
    await rejection(() => keepCurrentLocalUpgradeTarget(directory, records, report.operationId, sourcePath), /no matching publication responsibility/)
  }
  {
    const first = 'debug/a.md', second = 'debug/b.md', root = path.join(scratch, 'two-ui-clients')
    const directory = await seed(root, [first, second])
    await fs.unlink((await stoppedProducer(root, first)).target)
    await fs.unlink((await stoppedProducer(root, second)).target)
    const records = new DiskRecords(root), conflict = await materializeLegacyLocalFiles(directory, records, { deferActivation: true })
    check(conflict.issues.filter(issue => issue.choice === 'ready-stage-absent').map(issue => issue.path), [first, second], 'two real ready-stage conflicts from successive stopped producer processes')
    const pending = { status: 'pending', scope: 'local-sql-physical-upgrade', report: conflict }
    let starts = 0
    const owner = { controller: new AbortController(), work: Promise.resolve(pending), result: pending,
      agent: { start: () => { starts++; return Promise.resolve(pending) } } }
    const access = { connection: { files: new PhysicalLocalFiles(directory), scope: 'two-client-scope' } }
    const service = Object.assign(Object.create(FrameworkService.prototype), { access: async () => access,
      checkScope: (_access, scope) => check(scope, 'two-client-scope', 'two-client scope checked'),
      localUpgrades: new Map([[directory, owner]]), storage: records, changed: () => {}, report: () => {},
      subscribeChanged: () => () => {}, withSafetyOperation: async (_method, _payload, work) => work(), errorPresentation: () => undefined })
    const routes = new Map(), effects = []
    const ctx = { inject(_names, fn) { fn({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
      effect(effect) { effects.push(effect()) } }); return { dispose: async () => { for (const effect of effects) await effect?.() } } } }
    const dispose = installFrameworkTransport(ctx, service)
    const route = routes.get('/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget')
    const call = async (path, rpcId) => (await route.fetch(new Request('https://controlled.test/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId,
        method: 'deepseek-servant-framework/keepCurrentLocalUpgradeTarget', payload: { mode: 'local', storageScope: 'two-client-scope', operationId: conflict.operationId,
          path, confirmation: 'keep-current-with-original-unexported' } }) }))).json()
    const originalGet = records.get.bind(records)
    let reads = 0, release, entered
    const held = new Promise(resolve => { release = resolve }), firstRead = new Promise(resolve => { entered = resolve })
    records.get = async key => {
      const value = await originalGet(key)
      if (key === records.key && ++reads === 1) { entered(); await held }
      return value
    }
    try {
      const firstCall = call(first, 'client-one')
      await firstRead
      const secondReply = await call(second, 'client-two')
      check(secondReply.result.ok, false, 'second simultaneous Settings RPC does not falsely claim saved')
      check(secondReply.result.error.message.includes('refresh and retry'), true, 'second Settings RPC gets exact retry instruction')
      release()
      const firstReply = await firstCall
      check(firstReply.result, { ok: true, value: { saved: true } }, 'first Settings RPC saves its exact row')
      check((await originalGet(records.key)).files.filter(x => x.status === 'kept-current-unexported').map(x => x.path), [first], 'second simultaneous RPC did not overwrite first choice')
      const retry = await call(second, 'client-two-retry')
      check(retry.result, { ok: true, value: { saved: true } }, 'second row can be deliberately retried')
      check((await originalGet(records.key)).files.filter(x => x.status === 'kept-current-unexported').map(x => x.path), [first, second], 'both choices retained after user retry')
      check(starts, 2, 'one Agent continuation per successful user choice, none for rejected RPC')
    } finally { await dispose(); await access.connection.files.close() }
  }
  console.log(JSON.stringify({ status: 'passed', checks, outcomes, historicalProducer,
    limits: 'Actual frozen old SQLite Worker, current Local publisher and Linux no-replace; actual post-rename SIGTERM with controlled pre-fact pause. Full FrameworkPage Settings UI in ReactDOM/JSDOM with two actual clicks, production Transport registration and Service method against controlled Host connection carrier/access/Agent continuation ports. Not installed DSH Host/browser/model or real model cost measurement. Exact SourceAudit, retirement, cold local records and original SQL checked. No user incident or Windows claim.' }, null, 2))
} finally { hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
