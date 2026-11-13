import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { sourceRoot, hooks, evidence, hash, loaded } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const supplemental = registerHooks({ resolve(s, c, next) {
  if (s === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw Error("Markdown outside member recovery test")}', shortCircuit: true }
  return next(s, c)
} })
const { z } = await import('zod')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles, withSnapshot, withOperationChannel } = await import('../src/framework/transactions.ts')
const { GitAuthorityStore, SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { preparePhysicalTask, initializeTask, paths, readJson, readMemberStatus, taskLifecycle, taskLifecycleKey, isTerminalTask } = await import('../src/framework/task-files.ts')
const { FrameworkTaskIndex } = await import('../src/framework/task-index.ts')
const { readTaskCleanupRecord } = await import('../src/framework/cleaner.ts')
const { taskFamily } = await import('../src/framework/task-relations.ts')
const { memberRecoveryEligible, scanMemberRecovery } = await import('../src/framework/recovery.ts')
const { DshSessionReader } = await import('../src/adapters/dsh/sessions.ts')
const { ExecutionControls } = await import('../src/framework/execution-control.ts')
const { publishTaskResume } = await import('../src/framework/task-resume.ts')
const { submitTaskCancellation } = await import('../src/framework/task-cancellation.ts')
const { physicalControlSignalSources } = await import('../src/framework/physical-control-signal-sources.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
const runtimeSource = readFileSync(new URL('framework/role-runtime.ts', sourceRoot), 'utf8')
const serviceSource = readFileSync(new URL('framework/service.ts', sourceRoot), 'utf8')
const toolSource = readFileSync(new URL('framework/role-tools.ts', sourceRoot), 'utf8')
for (const [name, body] of [['role-runtime', runtimeSource], ['service', serviceSource], ['role-tools', toolSource]]) loaded.set('framework/' + name + '.ts', hash(body))
const method = (source, name) => {
  const js = stripTypeScriptTypes(source, { mode: 'transform' }), m = new RegExp('\\n    (?:async )?' + name + '\\(').exec(js)
  assert(m, name); const start = m.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start + m[0].length)); assert(next, name)
  return js.slice(start, start + m[0].length + next.index)
}
const parseStart = toolSource.indexOf('export function parseDirectSignal('), parseEnd = toolSource.indexOf('\nexport ', parseStart + 1)
assert(parseStart >= 0 && parseEnd > parseStart)
const parseDirectSignal = new Function(stripTypeScriptTypes(toolSource.slice(parseStart, parseEnd).replace('export ', ''), { mode: 'transform' }) + '\nreturn parseDirectSignal')()
const deps = { PhysicalLocalFiles, GitFiles, withSnapshot, withOperationChannel, paths, readJson, readMemberStatus, taskLifecycle, taskLifecycleKey, isTerminalTask, FrameworkTaskIndex, readTaskCleanupRecord, taskFamily, memberRecoveryEligible, scanMemberRecovery, DshSessionReader, parseDirectSignal, randomUUID, hash }
const Runtime = new Function(...Object.keys(deps), 'return class {\n' + ['roleKey', 'requestKey', 'serialWork', 'manuallyCleared', 'rememberTerminalTask', 'taskMetadata', 'scanMembers', 'readStartupRecoveryFacts', 'startup', 'beforeTaskUse', 'retryStartupTasks', 'resumeImportedTask', 'startupRecovery', 'startMaintenance', 'scheduleTaskResume', 'resumeTask'].map(n => method(runtimeSource, n)).join('\n') + '\n}')(...Object.values(deps))
const serviceDeps = { PhysicalLocalFiles, withOperationChannel, withSnapshot, readTaskCleanupRecord, readJson, paths, taskLifecycle, z, publishTaskResume, submitTaskCancellation, physicalControlSignalSources }
const Service = new Function(...Object.keys(serviceDeps), 'return class {\n' + method(serviceSource, 'taskControl') + '\n}')(...Object.values(serviceDeps))
const checks = [], outcomes = [], check = (name, value, expected) => { assert.deepEqual(value, expected, name); checks.push({ name, value }) }
const gate = () => { let release; const promise = new Promise(r => { release = r }); return { promise, release } }
const limit = async (p, label) => { let timer; try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Unexpected wait: ' + label)), 5000) })]) } finally { clearTimeout(timer) } }
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-inbox-metadata-')), baseline = process.env.DSS_MEMBER_INBOX_BASELINE === '1'
async function run(mode) {
  const sdk = mode === 'local' ? await openDshStorageFixture(path.join(root, 'records'), path.join(root, 'locator')) : undefined
  const repo = sdk ? undefined : new Repository(), files = sdk ? new PhysicalLocalFiles(path.join(root, 'local')) : new GitFiles(repo, new SessionGitOperations())
  // The controlled transport supplies direct-child directory metadata and sizes,
  // like the real repository interface, while GitFiles retains its fixed view.
  if (repo) repo.listDirectory = async (snapshot, prefix) => [...repo.views.get(snapshot)].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(([path, body]) => ({ path, type: 'blob', sha: hash(body), size: Buffer.byteLength(body) }))
  const records = sdk?.adapter ?? new GitAuthorityStore(files, mode), controls = new ExecutionControls(records, mode, undefined, files, records, '80000000-0000-4000-8000-000000000099')
  const rt = new Runtime(), wakes = [], errors = []
  Object.assign(rt, { files, records, controls, prefix: 'framework-runtime/' + hash(mode) + '/', config: { mode, member: 'A' }, ctx: sdk?.ctx ?? {}, bootId: 'controlled-boot', roleRecords: new Map(), knownTaskLifecycles: new Map(), pendingTaskControlDiscovery: new Map(), startTaskControlDiscovery() {}, observedTerminalTasks: new Map(), closed: false,
    // Native creation/admission and organizer continuation are explicit ports.
    environment: mode === 'local' ? { beforeTaskUse: async () => true } : {}, startSafetyResolutionLoad() {}, processObservations: async () => {},
    wake: async r => { wakes.push(r) }, startOwnedPump() {}, pump: async () => {}, queueOrganizerLedger: async () => {}, error: e => { errors.push(e.message) }, active: r => r.nativeState === 'running' || r.nativeState === 'waiting' })
  const set = async (p, v) => { if (repo) { put(repo, p, v); head(repo) } else if (v === undefined) await files.delete(p); else await files.replace(p, v) }
  const create = async (n, route = 'P') => {
    const taskId = '80000000-0000-4000-8000-' + String(n).padStart(12, '0'), source = 'tasks/recovery-' + n + '_' + route + '.md'
    await set(source, 'Saved user requirement ' + n)
    if (!repo) return withSnapshot(files, s => preparePhysicalTask(files, s, source, { taskId, owner: 'A', members: ['A'] }))
    const plan = await withSnapshot(files, s => initializeTask(files, s, source, 'A', ['A'], taskId))
    for (const change of plan.changes) await set(change.path, change.bytes ?? change.content)
    return withSnapshot(files, s => readJson(files, s, paths.task(taskId)))
  }
  let metadataCalls = [], lists = [], rows = 0, block
  const list = files.listDirectory.bind(files), listMetadata = !repo && files.records.listMetadata.bind(files.records)
  files.listDirectory = async (s, p, selection) => { const result = await list(s, p, selection); lists.push({ p, rows: result.length }); return result }
  if (!repo) {
    const exact = files.fileMetadata.bind(files)
    files.fileMetadata = async p => { metadataCalls.push(p); return exact(p) }
    files.records.listMetadata = async (p, recursive, skip) => {
      if (block?.prefix === p) { block.entered.release(); await block.release.promise }
      const result = await listMetadata(p, recursive, skip); if (p.endsWith('/A_Inbox/')) rows += result.length; return result
    }
  }
  const scan = selected => withSnapshot(files, s => rt.scanMembers(s, selected)), reset = () => { lists = []; metadataCalls = []; rows = 0; wakes.length = 0 }
  const service = new Service(), connection = { files, records, sharedRecords: records, scope: mode, identity: { instanceUUID: '80000000-0000-4000-8000-000000000099' }, registration: { member: 'A' }, transactions: new FrameworkTransactions(files, records, mode) }, access = { connection }
  Object.assign(service, { running: new Map([[mode, { runtime: rt, connection }]]), withAccessOperation: (_input, fn) => fn(access), controls: () => controls, beforeLocalTaskUse: async () => true })
  const drain = async () => { if (rt.maintenance?.size) await limit(Promise.all([...rt.maintenance.values()]), 'owned maintenance') }
  const submit = async (task, intent, suffix) => {
    const commandId = mode + ':' + suffix
    const result = await service.taskControl({ mode, taskId: task.taskId, intent, commandId })
    if (rt.maintenance?.size) await limit(Promise.all([...rt.maintenance.values()]), 'resume maintenance')
    return result
  }
  try {
    const task = await create(1), other = await create(2), organizer = await create(3, 'O'), inbox = paths.inbox(task.taskId, 'A'), member = paths.member(task.taskId, 'A'), inboxDirectory = inbox.slice(0, inbox.lastIndexOf('/'))
    reset(); await scan([task]); const ordinaryCost = { lists: [...lists], exact: [...metadataCalls], memberRows: rows }
    for (let i = 0; i < 32; i++) await set(inboxDirectory + '/unrelated-' + i + '.md', 'Retained sibling ' + i)
    await set(member + '/workers/kept/notes.md', 'Saved actual Worker continuation')
    reset(); await rt.startup(); await drain()
    check(mode + ' actual startup discovers two P Tasks, not O', wakes.filter(w => w.role !== 'Helper').map(w => [w.taskId, w.role]).sort(), [[task.taskId, 'Worker'], [other.taskId, 'Planner']].sort())
    check(mode + ' startup retains Helper recovery facts', wakes.filter(w => w.role === 'Helper').length, mode === 'local' ? 2 : 1)
    const startupCost = { lists: [...lists], exact: [...metadataCalls], memberRows: rows }
    check(mode + ' Inbox query route', mode === 'local' ? metadataCalls.length : lists.filter(x => x.p === inboxDirectory).length, mode === 'local' && !baseline ? 2 : mode === 'local' ? 0 : 1)
    if (!repo) check('Local unchanged dynamic workers and STATE discovery', lists.some(x => x.p === paths.state('A', task.taskId)), true)
    for (const body of ['', 'x', '中文', '\uFEFF']) {
      await set(inbox, body); const result = await scan([task])
      check(mode + ' eligibility body nonempty ' + JSON.stringify(body), result[0]?.inboxHasContent ?? false, body.length > 0)
    }
    await set(inbox, undefined); check(mode + ' absent Inbox', await scan([task]), [])
    await set(inbox, 'Recreated same Inbox'); check(mode + ' recreated same-name Inbox', (await scan([task])).length, 1)
    await set(paths.memberStatus(task.taskId, 'A'), JSON.stringify({ state: 'complete' })); check(mode + ' completed member stays excluded', await scan([task]), [])
    await set(paths.memberStatus(task.taskId, 'A'), JSON.stringify({ state: 'running' }))
    for (const status of ['complete', 'cancelled']) check(mode + ' terminal Task excluded ' + status, await scan([{ ...task, status }]), [])
    check(mode + ' Organizer not member recovery', await scan([organizer]), [])
    reset(); await submit(task, 'paused', 'pause'); check(mode + ' actual pause entry creates no wake', wakes, [])
    reset(); const submitted = await submit(task, 'running', 'resume')
    check(mode + ' actual service submission accepted', submitted.submitted, true)
    check(mode + ' service publication/schedule/resume produces Worker target', wakes.map(w => [w.role, w.taskId]), [['Worker', task.taskId]])
    check(mode + ' errors after actual entries', errors, [])
    const resumeCost = { lists: [...lists], exact: [...metadataCalls], memberRows: rows }
    const added = await create(4); reset(); if (mode === 'local') { rt.resumeImportedTask(added.taskId); await drain() } else await rt.startupRecovery()
    check(mode + ' imported Task selected recovery includes new Task', wakes.some(w => w.taskId === added.taskId), true)
    await set(paths.task(added.taskId), undefined);
    check(mode + ' deleted Task leaves current recovery inventory', (await scan()).some(w => w.taskId === added.taskId), false)
    if (!repo) {
      await fs.unlink(path.join(files.directory, inbox)); await fs.mkdir(path.join(files.directory, inbox)); check('Local same-name directory excluded', await scan([task]), [])
      await fs.rmdir(path.join(files.directory, inbox)); await fs.symlink(path.join(files.directory, paths.inbox(other.taskId, 'A')), path.join(files.directory, inbox)); check('Local same-name symlink excluded', await scan([task]), [])
      await fs.unlink(path.join(files.directory, inbox)); await set(inbox, 'After non-file replacement'); check('Local regular recreation included', (await scan([task])).length, 1)
      // Hold only the member-directory enumeration actually used by the old
      // lookup. No claim of a naturally hung filesystem is made by this fixture.
      block = { prefix: inboxDirectory + '/', entered: gate(), release: gate() }; let settled = false
      const pending = scan([task]).then(value => { settled = true; return value })
      if (baseline) { await limit(block.entered.promise, 'old member directory query'); check('Baseline exact known Inbox still waits on full member list', settled, false) }
      else { await limit(pending, 'exact Inbox bypasses old directory list'); check('Candidate exact known Inbox does not call old member list', settled, true) }
      const otherResult = await limit(scan([other]), 'other Task recovery'); check('Separate Task scan remains independent', otherResult.length, 1)
      block.release.release(); await pending; block = undefined
    } else {
      await set(inbox, ''); const old = await files.snapshot(); await set(inbox, 'New Git head body')
      try { check('Git old fixed snapshot remains empty', await rt.scanMembers(old, [task]), []) } finally { await old.release() }
      check('Git new snapshot discovers replacement', (await scan([task])).length, 1)
      check('Git never invokes Local fileMetadata', metadataCalls.length, 0)
    }
    outcomes.push({ mode, ordinaryCost, startupCost, resumeCost })
  } finally { block?.release.release(); if (sdk) { await files.close(); await sdk.close() } }
}
try {
  await run('local'); await run('git')
  console.log(JSON.stringify({ status: 'passed', baseline, assertions: checks.length, checks, outcomes, ...evidence(), limits: 'Actual extracted Service.taskControl -> publishTaskResume -> scheduleTaskResume -> resumeTask and startup -> per-Task startupRecovery -> scanMembers and imported-Task recovery bodies; real PhysicalLocalFiles, SDK storage, Zod and control implementation. Native admission/pump, Organizer continuation, initial observation/safety pass and already-restored Task access are explicit ports. GitFiles/authority use controlled fixed-snapshot transport, not a live remote. Synthetic directory stall establishes wait scope, not observed user-device latency. No Windows, whole native Agent, typecheck or package build claimed.' }, null, 2))
} finally { supplemental.deregister(); hooks.deregister(); await fs.rm(root, { recursive: true, force: true }) }
