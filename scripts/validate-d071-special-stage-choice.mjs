import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { createRequire } from 'node:module'
import { hooks as sdkHooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const oldRoot = new URL('./test-support/historical-v44/conversation-producer/src/', import.meta.url)
const oldHashes = JSON.parse(readFileSync(new URL('./test-support/historical-v44/conversation-producer/SOURCE.json', import.meta.url))).files
const oldHooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(oldRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(oldRoot.href) && url.endsWith('.ts')) {
      const bytes = readFileSync(new URL(url)), name = 'src/' + url.slice(oldRoot.href.length)
      assert.equal(hash(bytes), oldHashes[name], 'frozen v44 source ' + name)
      return { format: 'module', source: stripTypeScriptTypes(bytes.toString(), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { LocalFiles: OldFiles } = await import(new URL('framework/local-files.ts', oldRoot))
const { FrameworkTransactions: OldTransactions } = await import(new URL('framework/command-transactions.ts', oldRoot))
const { FrameworkConversation: OldConversation } = await import(new URL('framework/conversation.ts', oldRoot))
const { initializeTask } = await import(new URL('framework/task-files.ts', oldRoot))
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { restoreLegacyTask, localTaskUpgradeKey } = await import('../src/framework/local-upgrade-task.ts')
const { restoreLegacyConversationScope, localConversationUpgradeKey } = await import('../src/framework/local-upgrade-conversation.ts')
const { publishLegacyNativeSkill } = await import('../src/framework/local-upgrade-skill.ts')
const { localSkillUpgradeKey } = await import('../src/framework/local-upgrade-mapping.ts')
const { materializeLegacyLocalFiles } = await import('../src/framework/local-startup-upgrade.ts')
const { assessLocalUpgradeCompletion, retireLocalUpgradeRecords, readLocalUpgradeCompleted } = await import('../src/framework/local-upgrade-completion.ts')
const { keepRetainedSpecialLocalUpgradeStage } = await import('../src/framework/local-upgrade-special-stage-choice.ts')
const { localUpgradeView } = await import('../src/framework/local-upgrade-view.ts')
const { auditLocalUpgradeSource } = await import('../src/framework/local-upgrade-source-audit.ts')
const { FrameworkService } = await import('../src/framework/service.ts')
const { installFrameworkTransport } = await import('../src/framework/transport.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalUpgradeStatus } = await import('../src/framework/client-upgrade-status.ts')
const require = createRequire(new URL('../package.json', import.meta.url))
const React = require('react'), { createRoot } = require('react-dom/client'), { JSDOM } = require('jsdom')
const hostKey = JSON.stringify(['local', 'actual-scope', 'actual-instance'])
const taskId = '10000000-0000-4000-8000-000000000001', chatId = 'old-chat'
const skillText = '---\n' + JSON.stringify({ name: 'old-method', description: 'Original old method' }) + '\n---\nPreserve original method.\n'
class Records {
  constructor(root) { this.files = new LocalRecordFiles(path.join(root, 'host-records')) }
  async get(key) { const value = await this.files.read(hash(key) + '.json'); return value === undefined ? undefined : JSON.parse(value) }
  async set(key, value) { await this.files.replace(hash(key) + '.json', JSON.stringify(value)) }
  async delete(key) { await this.files.delete(hash(key) + '.json') }
  async list() { throw Error('No unrelated Host record scan in exact-stage test') }
}
const work = async (kind, root, skillPath, options = {}) => {
  const directory = path.join(root, 'files'), records = new Records(root)
  if (kind === 'task') return restoreLegacyTask(directory, taskId, hostKey, records, options)
  if (kind === 'conversation') return restoreLegacyConversationScope(directory, chatId, records, options)
  if (kind === 'skill') return publishLegacyNativeSkill(directory, skillPath, skillText, records, options)
  throw Error('Choose one actual specialist action')
}
if (process.argv[2] === '--stop') {
  let created = 0
  await work(process.argv[3], process.argv[4], process.argv[5], { onProgress: ({ step }) => {
    if (step === 'created' && ++created === Number(process.argv[6] ?? 1)) process.kill(process.pid, 'SIGKILL')
  } })
  throw Error('The actual shared publisher created callback was not reached')
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-d071-special-'))
let checks = 0
const check = (value, expected, label) => { assert.deepEqual(value, expected, label); checks++ }
async function serviceChoice(directory, records, assessed, choice, clickUi) {
  const storageScope = 'actual-local-scope', result = { status: 'pending', scope: 'local-sql-physical-upgrade', report: assessed.report,
    pending: assessed.pending, specialStageChoices: assessed.specialStageChoices }
  let starts = 0, calls = 0
  const owner = { controller: new AbortController(), work: Promise.resolve(result), result,
    agent: { start: async () => { starts++; const next = await assessLocalUpgradeCompletion(directory, records)
      return { status: 'pending', scope: 'local-sql-physical-upgrade', report: next.report, pending: next.pending,
        retainedSpecialStages: next.retainedSpecialStages } } } }
  const access = { connection: { files: new PhysicalLocalFiles(directory), scope: storageScope } }
  const service = Object.assign(Object.create(FrameworkService.prototype), { access: async () => access,
    checkScope: (_access, scope) => { if (scope !== storageScope) throw Error('Wrong Local scope') },
    localUpgrades: new Map([[directory, owner]]), storage: records, changed: () => {}, report: () => {},
    subscribeChanged: () => () => {}, withSafetyOperation: async (_name, _payload, work) => work(), errorPresentation: () => undefined })
  const routes = new Map(), effects = []
  const ctx = { inject(_names, fn) { fn({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    effect(effect) { effects.push(effect()) } }); return { dispose: async () => { for (const effect of effects) await effect?.() } } } }
  const dispose = installFrameworkTransport(ctx, service)
  const route = routes.get('/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget')
  assert.ok(route); checks++
  const input = { mode: 'local', storageScope, operationId: choice.operationId, path: choice.path, stageOwner: choice.owner,
    confirmation: 'keep-retained-stage-without-cleanup' }
  const call = async (payload = input) => { calls++
    return (await route.fetch(new Request('https://controlled.test/api/deepseek-servant-framework/keepCurrentLocalUpgradeTarget', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'exact-special-' + calls,
        method: 'deepseek-servant-framework/keepCurrentLocalUpgradeTarget', payload }) }))).json() }
  try {
    check((await call({ ...input, operationId: 'stale-operation' })).result.ok, false, 'Service rejects unrelated operation ID')
    check((await call({ ...input, stageOwner: { ...choice.owner, id: 'different-original-owner' } })).result.ok, false,
      'Service rejects same path with wrong owner')
    if (clickUi) {
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://controlled.test/' })
      for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }))
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      const root = createRoot(document.getElementById('root'))
      let reply
      try {
        const value = await localUpgradeView(directory, records, { result })
        check(value.retainedStageChoices.some(item => item.owner.kind === choice.owner.kind && item.owner.id === choice.owner.id
          && item.operationId === choice.operationId && item.path === choice.path), true, 'UI projection preserves specialist identity')
        await React.act(async () => root.render(React.createElement(LocalUpgradeStatus, { value, tr: (_cn, en) => en,
          onKeepStage: async (path, operationId, stageOwner) => { reply = await call({ ...input, path, operationId, stageOwner });
            if (!reply.result.ok) throw Error(reply.result.error.message) } })))
        const button = label => [...document.querySelectorAll('button')].find(item => item.textContent === label)
        check(!!button('Choose to keep this ambiguous stage'), true, 'actual specialist UI presents first choice')
        const before = calls
        await React.act(async () => button('Choose to keep this ambiguous stage').click())
        check(calls, before, 'first UI click sends no RPC')
        await React.act(async () => button('Confirm keeping this stage out of cleanup').click())
        for (let attempt = 0; attempt < 30 && !reply; attempt++) await React.act(async () => new Promise(resolve => setTimeout(resolve, 5)))
        check(reply?.result, { ok: true, value: { saved: true } }, 'second UI click reaches existing Transport and Service')
      } finally { await React.act(async () => root.unmount()); dom.window.close() }
    } else if (choice.owner.kind === 'conversation') {
      const responses = await Promise.all([call(), call()])
      check(responses.filter(item => item.result.ok).length, 1, 'two Settings clients cannot both win same live owner choice')
      check(responses.filter(item => !item.result.ok).length, 1, 'losing concurrent Settings client is told to retry')
    } else check((await call()).result, { ok: true, value: { saved: true } }, 'specialist exact RPC reaches Service')
    await owner.work
    check(starts, 1, 'selection resumes same one-time owner once')
    check((await call()).result, { ok: true, value: { saved: true } }, 'retry sees chosen owner without rewrite')
    check(starts, 1, 'idempotent retry does not wake Agent twice')
  } finally { await access.connection.files.close(); await dispose?.dispose?.() }
}
const oldCommit = async (files, changes) => { const snapshot = await files.snapshot(); try { return await files.commit(snapshot, changes, 'actual frozen old writer') } finally { await snapshot.release() } }
const skillProducer = async () => {
  const bundled = readFileSync(new URL('./test-support/historical-55fe/installed-host.js', import.meta.url), 'utf8')
  check(hash(bundled), '5a84b25b7619486ea98e7e11b140d02c0a3848e48008ac3cc2dc71a2a5a5d47a', 'frozen 55fe producer identity')
  const source = bundled.slice(bundled.indexOf('async function prepareLegacyMigration('), bundled.indexOf('async function applyLegacyMigration('))
  const fail = () => { throw Error('Task mapping is outside exact skill fixture') }
  const producer = new Function('identity', 'hash12', 'legacyDeclaredArtifacts', 'legacyMigratedTaskId', 'encodeJson', 'utf8', 'decode', 'paths', 'workerPaths', 'prepareFrameworkSkillIndex', 'frameworkSkillIndexPath', source + '\nreturn prepareLegacyMigration')(
    value => value, hash, fail, fail, value => JSON.stringify(value, null, 2) + '\n', value => Buffer.from(value), value => Buffer.from(value).toString(), {}, fail, async () => ({ changes: [], issues: [] }), 'technical/skills/catalog.json')
  const date = '2026-11-09T00:00:00Z', scope = { assistantId: 'old-assistant', workspaceId: 'old-workspace' }
  const record = { schemaVersion: 1, kind: 'skill', skillId: 'old-method', scope, revision: 1, activeVersion: 1,
    versions: [{ skillId: 'old-method', version: 1, title: 'Original method', description: 'Original method', applicability: 'Old scope', body: 'Preserve original method.', contentHash: 'original-hash', scope, status: 'active', createdAt: date, sourceResultIds: [], validations: [], uses: [], feedback: [] }], receipts: {} }
  const oldFiles = { read: async () => undefined, readBytes: async () => undefined, list: async () => [], listDirectory: async () => [] }
  const result = await producer({ mode: 'local', revision: 'old', baseline: 'actual-shipped-producer', records: [{ key: 'knowledge/skills/old-method', bytes: Buffer.from(JSON.stringify(record) + '\n') }], texts: [], tasks: [], issues: [] }, oldFiles,
    { revision: 'old' }, { id: 'old-import', owner: 'A', members: {} })
  const skillPath = result.changes.find(item => item.path.endsWith('/record.json'))?.path
  assert.ok(skillPath)
  return { skillPath, changes: result.changes }
}
async function seed(kind, root, folder = 'files') {
  const directory = path.join(root, folder), files = await OldFiles.open(directory), records = new Records(root)
  let skillPath
  try {
    if (kind === 'task') {
      const sourcePath = 'tasks/old_P.md'
      await oldCommit(files, [{ path: sourcePath, content: 'Task ID: ' + taskId + '\nOriginal task requirement' }])
      const snapshot = await files.snapshot()
      try { const planned = await initializeTask(files, snapshot, sourcePath, 'Planner_A', ['Planner_A'], taskId)
        await files.commit(snapshot, planned.changes, 'old Task creation') }
      finally { await snapshot.release() }
    } else if (kind === 'conversation') {
      const transaction = new OldTransactions(files, records, 'v44-source'), conversation = new OldConversation(files, transaction, { mode: 'local', collaborationId: chatId })
      await conversation.send('old-message', { id: 'old-message', participantId: 'old-user', createdAt: '2026-11-07T00:00:00.000Z', role: 'user', recipient: 'ai', text: 'Actual old chunked message\n' })
    } else {
      const produced = await skillProducer(); skillPath = produced.skillPath
      await oldCommit(files, produced.changes)
    }
  } finally { await files.close() }
  return { directory, records, skillPath }
}
if (process.argv[2] === '--seed-skill') {
  const produced = await seed('skill', process.argv[3], 'business')
  console.log(JSON.stringify({ skillPath: produced.skillPath }))
  oldHooks.deregister(); sdkHooks.deregister(); await fs.rm(scratch, { recursive: true, force: true })
  process.exit(0)
}
if (process.argv[2] === '--seed-conversation') {
  const produced = await seed('conversation', process.argv[3], 'business')
  console.log(JSON.stringify({ directory: produced.directory }))
  oldHooks.deregister(); sdkHooks.deregister(); await fs.rm(scratch, { recursive: true, force: true })
  process.exit(0)
}
let bodyFailure
try {
  for (const kind of ['task', 'conversation', 'skill']) {
    const root = path.join(scratch, kind), { directory, records, skillPath } = await seed(kind, root)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop', kind, root, skillPath ?? ''],
      { encoding: 'utf8', timeout: 30000, env: process.env })
    check(child.signal, 'SIGKILL', kind + ' actual O_EXCL created callback stopped process: ' + child.stderr)
    const key = kind === 'task' ? localTaskUpgradeKey(directory, taskId)
      : kind === 'conversation' ? localConversationUpgradeKey(directory, chatId) : localSkillUpgradeKey(directory, skillPath)
    const prepared = await records.get(key)
    check(prepared.kind, kind === 'task' ? 'dss-once-task-layout' : kind === 'conversation' ? 'dss-once-conversation-full-text' : 'dss-once-native-skill', kind + ' exact operation kind')
    const ambiguous = prepared.files.find(file => file.stagePath && !file.owned)
    assert.ok(ambiguous, kind + ' exact O_EXCL-before-owned gap'); checks++
    const stage = path.join(directory, ambiguous.stagePath)
    check((await fs.stat(stage)).isFile(), true, kind + ' ambiguous stage exists')
    const recovered = await work(kind, root, skillPath)
    check(recovered.status, 'complete', kind + ' cold specialist recovery completes own original')
    const operation = await records.get(key)
    check(operation.retainedStages?.length, 1, kind + ' same operation records retained stage')
    check(operation.retainedStages[0].path, ambiguous.stagePath, kind + ' retains exact path')
    check(operation.status, 'complete', kind + ' owner complete after separate original publication')
    const materialized = await materializeLegacyLocalFiles(directory, records)
    check(materialized.status, 'complete', kind + ' all-file original export follows specialist')
    const assessed = await assessLocalUpgradeCompletion(directory, records)
    const choices = assessed.specialStageChoices ?? []
    check(choices.some(choice => choice.owner.kind === kind && choice.owner.id === (kind === 'task' ? taskId : kind === 'conversation' ? chatId : skillPath)
      && choice.operationId === operation.operationId && choice.path === ambiguous.stagePath), true, kind + ' finish offers exact specialist owner')
    check(assessed.pending.some(row => row.path === ambiguous.stagePath), true, kind + ' retained stage blocks finish before explicit choice')
    const choice = choices.find(choice => choice.owner.kind === kind && choice.operationId === operation.operationId && choice.path === ambiguous.stagePath)
    assert.ok(choice); checks++
    const oldDatabase = await fs.readFile(path.join(directory, 'dss-files.sqlite'))
    const stageBefore = await fs.readFile(stage)
    await serviceChoice(directory, records, assessed, choice, kind === 'task')
    check((await keepRetainedSpecialLocalUpgradeStage(directory, records, choice)).saved, true, kind + ' repeated exact owner choice idempotent')
    check(await fs.readFile(stage), stageBefore, kind + ' stage content untouched by choice')
    check(await fs.readFile(path.join(directory, 'dss-files.sqlite')), oldDatabase, kind + ' original SQLite untouched by choice')
    const after = await assessLocalUpgradeCompletion(directory, records)
    check(after.pending.some(row => row.path === ambiguous.stagePath), false, kind + ' exact selected stage no longer blocks finish')
    check(after.retainedSpecialStages?.some(item => item.owner.kind === kind && item.owner.id === choice.owner.id && item.operationId === operation.operationId
      && item.path === ambiguous.stagePath && !!item.selectedAt), true, kind + ' final assessment retains exact disposition')
    check(after.pending, [], kind + ' selection does not bypass any other finish requirement')
    const sourceAudit = await auditLocalUpgradeSource(directory, records)
    check(sourceAudit.issues, [], kind + ' actual source audit remains independently clear')
    const completed = { kind: 'dss-local-upgrade-result', directory, operationId: materialized.operationId,
      completedAt: new Date().toISOString(), report: after.report, cleanup: after.cleanup, sourceAudit,
      retainedSpecialStages: after.retainedSpecialStages }
    check(await retireLocalUpgradeRecords(records, completed, 'fixture-original-wake'), undefined, kind + ' existing retirement succeeds')
    const coldRecords = new Records(root), cold = await readLocalUpgradeCompleted(directory, coldRecords)
    check(cold.retainedSpecialStages?.[0]?.owner, choice.owner, kind + ' final report keeps exact owner after operation retirement')
    check(await coldRecords.get(key), undefined, kind + ' temporary specialist operation retired')
    check((await localUpgradeView(directory, coldRecords))?.keptRetainedStages?.[0]?.path, ambiguous.stagePath,
      kind + ' cold UI view shows same stage after operation retirement')
    check(await fs.readFile(stage), stageBefore, kind + ' retirement does not clean user-retained stage')
    check(await fs.readFile(path.join(directory, 'dss-files.sqlite')), oldDatabase, kind + ' retirement retains original SQL')
    console.log('SPECIAL', kind, key, ambiguous.stagePath, recovered.status)
  }
  {
    const kind = 'task', root = path.join(scratch, 'multiple-task-stages'), { directory, records } = await seed(kind, root)
    const stop = count => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop', kind, root, '', String(count)],
      { encoding: 'utf8', timeout: 30000, env: process.env })
    check(stop(1).signal, 'SIGKILL', 'first original Task stage stopped at actual created boundary')
    check(stop(2).signal, 'SIGKILL', 'continuing original Task stopped at another actual created boundary')
    check((await work(kind, root)).status, 'complete', 'Task cold-continuation completes after both real interruptions')
    await materializeLegacyLocalFiles(directory, records)
    const before = await assessLocalUpgradeCompletion(directory, records), selected = before.specialStageChoices ?? []
    check(selected.length >= 2, true, 'two actual Task stages independently offered')
    check(new Set(selected.map(item => item.path)).size, selected.length, 'each offered Task stage has distinct exact path')
    check((await keepRetainedSpecialLocalUpgradeStage(directory, records, selected[0])).saved, true, 'first Task stage selected')
    const middle = await assessLocalUpgradeCompletion(directory, records)
    check(middle.pending.some(item => item.path === selected[0].path), false, 'first selected Task stage unblocks itself')
    check(middle.pending.some(item => item.path === selected[1].path), true, 'different unselected Task stage still blocks finish')
    check(middle.retainedSpecialStages?.length, 1, 'only first Task stage selected in assessment')
  }
  {
    const kind = 'conversation', root = path.join(scratch, 'moved-after-preview'), { directory, records } = await seed(kind, root)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop', kind, root, ''],
      { encoding: 'utf8', timeout: 30000, env: process.env })
    check(child.signal, 'SIGKILL', 'conversation stage exists at actual created interruption')
    check((await work(kind, root)).status, 'complete', 'specialist original conversion independently completes')
    await materializeLegacyLocalFiles(directory, records)
    const before = await assessLocalUpgradeCompletion(directory, records), choice = before.specialStageChoices?.[0]
    assert.ok(choice); checks++
    const oldDatabase = await fs.readFile(path.join(directory, 'dss-files.sqlite'))
    const moved = path.join(directory, choice.path) + '.user-moved', original = path.join(directory, choice.path)
    await fs.rename(original, moved)
    check((await keepRetainedSpecialLocalUpgradeStage(directory, records, choice)).saved, false,
      'moved after preview does not claim a now-absent selected path')
    check((await records.get(localConversationUpgradeKey(directory, chatId))).retainedStages[0].keptByUser, undefined,
      'absent selected path creates no user decision record')
    check((await assessLocalUpgradeCompletion(directory, records)).pending.some(item => item.path === choice.path), false,
      'normal finish assessment drops missing original stage path')
    check((await fs.stat(moved)).isFile(), true, 'physical user-moved file remains untouched')
    check(await fs.readFile(path.join(directory, 'dss-files.sqlite')), oldDatabase, 'moved-path assessment retains original SQL')
  }
  console.log(JSON.stringify({ status: 'passed', checks, ...evidence(), limits: 'Actual frozen v44 Task/conversation creators and SQLite writer; actual frozen 55fe skill migration producer transferred through frozen v44 SQLite writer. Current specialist functions and Linux O_EXCL SIGKILL at created callback, cold continuation. SDK dependency tree is COMBO-3, not proven byte-identical to d19. Not installed DSH Host/model, Windows or actual user incident.' }, null, 2))
} catch (error) { bodyFailure = error; throw error }
finally { oldHooks.deregister(); sdkHooks.deregister(); try { await fs.rm(scratch, { recursive: true, force: true }) }
  catch (error) { console.error('CLEANUP-FAILURE', error, 'BODY-FAILURE', bodyFailure, 'REMAINS', await fs.readdir(scratch).catch(() => []));
    if (!bodyFailure) throw error } }
