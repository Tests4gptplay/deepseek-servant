import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { sourceRoot, hooks, evidence, hash, loaded } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const supplemental = registerHooks({ resolve(s, c, next) {
  if (s === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw Error("Markdown outside notification claim test")}', shortCircuit: true }
  return next(s, c)
}, load(u, c, next) {
  if (u === new URL('framework/skills.ts', sourceRoot).href) return { format: 'module', source: 'export const frameworkSkillIndexPath="technical/skills/catalog.json";export function isFrameworkSkillDefinitionPath(){throw Error("Skill publication outside claim test")}export function prepareFrameworkSkillIndex(){throw Error("Skill publication outside claim test")}', shortCircuit: true }
  return next(u, c)
} })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const { GitAuthorityStore, SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { paths, readJson, assertTaskLifecycle, initializeTask } = await import('../src/framework/task-files.ts')
const { taskArchiveHostKey } = await import('../src/framework/task-archive.ts')
const { localForegroundRoleRecordPath } = await import('../src/framework/conversation.ts')
const { installFrameworkRoleTools, signalWorkerId } = await import('../src/framework/role-tools.ts')
const { helperSignalWakeHash } = await import('../src/framework/host-loop.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
const runtimeSource = readFileSync(new URL('framework/role-runtime.ts', sourceRoot), 'utf8'); loaded.set('framework/role-runtime.ts', hash(runtimeSource))
const method = name => { const js = stripTypeScriptTypes(runtimeSource, { mode: 'transform' }), m = new RegExp('\\n    (?:async )?' + name + '\\(').exec(js); assert(m, name); const start = m.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start + m[0].length)); assert(next, name); return js.slice(start, start + m[0].length + next.index) }
const dependencies = { localForegroundRoleRecordPath, taskArchiveHostKey, PhysicalLocalFiles, GitAuthorityStore, withSnapshot, hash, paths, readJson, assertTaskLifecycle, signalWorkerId, helperSignalWakeHash }
const Runtime = new Function(...Object.keys(dependencies), 'return class {\n' + ['roleKey', 'roleRecordPath', 'taskCommandOwner', 'archiveHostKey', 'assertOrganizerBusiness', 'notifications', 'addressedSignals', 'consumeWakeSignals', 'claimCurrentNotifications', 'settleNotificationClaim', 'helperResponsibilities', 'withRoleWrite', 'taskNoticeState', 'taskNoticeConsumption'].map(method).join('\n') + '\n}')(...Object.values(dependencies))
const checks = [], outcomes = []
const check = (name, value, expected) => { let error; try { assert.deepEqual(value, expected) } catch (e) { error = e.message } checks.push({ name, passed: !error, ...(error ? { value, expected, error } : {}) }) }
const rejects = async (name, fn, regex) => { let error; try { await assert.rejects(fn, regex) } catch (e) { error = e.message } checks.push({ name, passed: !error, ...(error ? { error } : {}) }) }
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-later-claim-'))
const gate = () => { let release; const promise = new Promise(r => { release = r }); return { release, promise } }
async function run(mode, role) {
  const label = mode + '-' + role, sdk = mode === 'local' ? await openDshStorageFixture(path.join(root, label, 'records'), path.join(root, label, 'locator')) : undefined
  const repository = sdk ? undefined : new Repository(), files = sdk ? new PhysicalLocalFiles(path.join(root, label, 'local')) : new GitFiles(repository, new SessionGitOperations())
  const records = sdk?.adapter ?? new GitAuthorityStore(files, label), transactions = new FrameworkTransactions(files, records, label)
  const rt = new Runtime(), binding = { role, workId: label, executionId: label + '-exec', owner: 'A', ...(role === 'Foreground' ? {} : { taskId: '10000000-0000-4000-8000-000000000001', member: 'A' }) }
  Object.assign(rt, { files, records, transactions, prefix: 'framework-runtime/' + hash(label) + '/', config: { mode, member: 'A', primary: true, scope: label, instanceUUID: '10000000-0000-4000-8000-000000000002' }, roleRecords: new Map(), roleBases: new Map(), wakeConsumptions: new Map(), closed: false,
    native: { get() {} }, taskNotices: new WeakMap(), taskNoticeClock: 0,
    conversation: { routeForegroundSignals: async rows => rows, claimForegroundSignals: () => { throw Error('Git Foreground initial signal not used in this test') } },
    forgetForegroundNotices() {}, updateWake: async () => {},
    // The exact role record is persisted through actual SDK/Git authority;
    // native producer/role-replacement coordination is an explicit seam.
    saveRole: async record => { await records.set(rt.prefix + 'roles/' + hash(binding.workId), record); rt.roleRecords.set(binding.workId, record); rt.roleBases.set(binding.workId, structuredClone(record)) },
  })
  const tools = new Map(), agent = { id: label, session: {} }, ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: t => tools.set(t.name, t) } }
  installFrameworkRoleTools(ctx, agent, binding, { files, notifications: (s, b, id) => rt.notifications(s, b, id), claimNotifications: (b, command) => rt.claimCurrentNotifications(b, command), onError: error => { throw error }, transact: (...args) => transactions.run(...args) })
  const call = (id, raw = {}) => tools.get('dss_claim').execute(raw, { agent, callId: id, signal: new AbortController().signal, concludeTurn() { throw Error('Claim must not finish the turn') } })
  const set = async (p, v) => { if (repository) { put(repository, p, v); head(repository) } else if (v === undefined) await files.delete(p); else await files.replace(p, v) }
  const read = p => withSnapshot(files, s => files.read(s, p))
  const directory = role === 'Foreground' ? 'state/' : paths.state('A', binding.taskId) + '/', signal = name => directory + role + '_' + name
  let lists = [], exact = [], block, lookupHold, metadataRows = 0, metadataCalls = 0, failures = 0
  const originalList = files.listDirectory.bind(files), originalDelete = files instanceof PhysicalLocalFiles ? files.deleteObserved.bind(files) : undefined
  files.listDirectory = async (s, p, selection) => { if (lookupHold && selection?.paths?.includes(lookupHold.target)) { lookupHold.entered.release(); await lookupHold.release.promise } const result = await originalList(s, p, selection); if (p.replace(/\/$/, '') === directory.replace(/\/$/, '')) lists.push({ selection, entries: result.length }); return result }
  if (files instanceof PhysicalLocalFiles) { const metadata = files.fileMetadata.bind(files), listing = files.records.listMetadata.bind(files.records); files.fileMetadata = async p => { exact.push(p); if (lookupHold?.target === p) { lookupHold.entered.release(); await lookupHold.release.promise } return metadata(p) }; files.records.listMetadata = async (...args) => { const rows = await listing(...args); if (args[0].replace(/\/$/, '') === directory.replace(/\/$/, '')) { metadataCalls++; metadataRows += rows.length } return rows } }
  try {
    if (binding.taskId) {
      await set('tasks/claim_P.md', 'Task ID: ' + binding.taskId + '\nOriginal requirement')
      const plan = await withSnapshot(files, s => initializeTask(files, s, 'tasks/claim_P.md', 'A', ['A'], binding.taskId))
      for (const c of plan.changes) await set(c.path, c.bytes ?? c.content)
      await set(directory + 'Planner_Inbox', undefined)
    }
    const initial = signal('initial'); await set(initial, '')
    const observed = await withSnapshot(files, async s => (await files.listDirectory(s, directory, { paths: [initial] }))[0])
    // Git test starts from an accepted already-consumed wake to isolate the
    // later-claim path. Initial Local consumption is tested through dss_claim.
    const wake = { id: label + '-wake', role, taskId: binding.taskId, sources: repository ? [] : [observed] }
    const record = { identity: binding, sessionId: label + '-session', lastWake: wake, generation: 1 }
    await rt.saveRole(record); await call('first')
    if (repository) { await set(initial, undefined); rt.wakeConsumptions.set(binding.executionId, { wakeId: wake.id, promise: Promise.resolve({ signals: [] }) }) }
    check(label + ' initial consumed once', await read(initial), undefined)
    await set(initial, ''); const later = [signal('later1'), signal('later2'), signal('later3')]
    for (const p of later) await set(p, '')
    const unrelated = directory + 'Unrelated_notice'; await set(unrelated, '')
    lists = []; exact = []; metadataRows = 0; metadataCalls = 0
    const result = await call('later')
    const measured = { lists: structuredClone(lists), exact: [...exact], ...(repository ? {} : { metadataCalls, metadataRows }) }
    check(label + ' later claim includes empty recreated signal', result.signals.includes(initial), true)
    check(label + ' later claim includes each new notification', later.every(p => result.signals.includes(p)), true)
    for (const p of [initial, ...later]) check(label + ' claimed file consumed ' + p, await read(p), undefined)
    check(label + ' unrelated file remains', await read(unrelated), '')
    if (!repository) { check(label + ' discovery retained once', lists.length, 1); check(label + ' exact known paths reobserved separately', exact.sort(), [initial, ...later].sort()) }
    else check(label + ' Git existing selected-directory reads remain', lists.filter(x => x.selection?.paths).length >= 4, true)
    await set(initial, '')
    await call('later')
    check(label + ' replay cannot consume newer empty signal', await read(initial), '')
    await call('fresh-later')
    check(label + ' new claim can consume recreated empty signal', await read(initial), undefined)
    if (!repository) {
      await set(later[0], ''); await set(later[1], '')
      const partialVersion = (await files.fileMetadata(later[1])).version
      files.deleteObserved = async (p, v, before) => { if (p === later[1] && v === partialVersion && failures++ === 0) throw Error('controlled original unlink failure'); return originalDelete(p, v, before) }
      await rejects(label + ' exact claim keeps partial failure', () => call('partial'), /controlled original unlink failure/)
      check(label + ' first signal really consumed before failure', await read(later[0]), undefined)
      await set(later[0], '')
      await call('partial')
      check(label + ' partial replay keeps recreated first empty signal', await read(later[0]), '')
      check(label + ' partial replay finishes original second signal', await read(later[1]), undefined)
      files.deleteObserved = originalDelete
      await set(later[2], '')
      const replaceVersion = (await files.fileMetadata(later[2])).version
      block = { entered: gate(), release: gate() }
      files.deleteObserved = async (p, v, before) => { if (p === later[2] && v === replaceVersion) { block.entered.release(); await block.release.promise } return originalDelete(p, v, before) }
      const pending = call('replace-after-observation'); await block.entered.promise
      await set(later[2], '')
      block.release.release(); await pending
      check(label + ' same-path empty replacement after observation survives', await read(later[2]), '')
      files.deleteObserved = originalDelete; block = undefined
      await call('consume-replacement'); check(label + ' later new claim consumes actual replacement', await read(later[2]), undefined)
      const freshPath = signal('replace-before-exact'); await set(freshPath, '')
      lookupHold = { target: freshPath, entered: gate(), release: gate() }
      const beforeExact = call('new-before-exact'); await lookupHold.entered.promise
      await set(freshPath, ''); lookupHold.release.release(); await beforeExact; lookupHold = undefined
      check(label + ' exact reobservation captures replacement made after discovery', await read(freshPath), undefined)
      await set(freshPath, ''); await call('new-before-exact')
      check(label + ' replay keeps replacement after exact captured claim', await read(freshPath), '')

    }
    await rejects(label + ' actual strict claim schema remains', () => call('invalid', { unexpected: true }), /Unrecognized|unrecognized/)
    outcomes.push({ mode, role, measured })
  } finally { block?.release.release(); lookupHold?.release.release(); if (sdk) { await files.close(); await sdk.close() } }
}
try {
  for (const [mode, role] of [['local', 'Foreground'], ['local', 'Planner'], ['git', 'Planner']]) await run(mode, role)
  const failures = checks.filter(x => !x.passed)
  console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', assertions: checks.length, failures: failures.length, checks, outcomes, ...evidence(), limits: 'Actual installed dss_claim/schema wrapper, unchanged extracted runtime claim/notification methods except candidate exact Local reobservation, actual physical files and SDK role-record persistence. Controlled native role-save/replacement coordination. Git uses actual GitFiles/GitAuthorityStore/transactions on controlled repository transport; no live remote CAS/network or native model/Windows/full build/typecheck claimed.' }, null, 2))
  if (failures.length) process.exitCode = 1
} finally { supplemental.deregister(); hooks.deregister(); await fs.rm(root, { recursive: true, force: true }) }
