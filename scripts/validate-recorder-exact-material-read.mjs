import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
// Installed production dss_snapshot/dss_read and actual Local/Git FilesStore.
// Native Agent registration and remote Git transport are controlled ports.
// Real Zod validates every call. Unrelated Markdown/skill publication is never
// called and explicitly throws, rather than silently emulating publication.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const require = createRequire(import.meta.url), zodPath = require.resolve(process.env.DSS_ZOD_MODULE ?? 'zod'), zod = require(zodPath)
const hash = value => createHash('sha256').update(value).digest('hex')
const data = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: pathToFileURL(zodPath).href, shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data('export function fromMarkdown(){throw new Error("Markdown parsing outside this exact-read test")}'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', sourceRoot).href) return { url: data('export const frameworkSkillIndexPath="technical/skills/catalog.json";export function isFrameworkSkillDefinitionPath(){throw new Error("Skill publication outside this read test")}export function prepareFrameworkSkillIndex(){throw new Error("Skill publication outside this read test")}'), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8'); loaded.set(url.slice(sourceRoot.href.length), hash(source))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles } = await import('../src/framework/transactions.ts')
const { SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { initializeTask, dispatchPlannerObjective, paths, encodeJson, readJson } = await import('../src/framework/task-files.ts')
const { taskFamily } = await import('../src/framework/task-relations.ts')
const { taskReference } = await import('../src/framework/published-references.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-recorder-exact-read-'))
const checks = [], outcomes = []
const check = (name, value, expected) => { let error; try { assert.deepEqual(value, expected) } catch (e) { error = e.message } checks.push({ name, passed: !error, ...(error ? { value, expected, error } : {}) }) }
const rejects = async (name, fn, re) => { let error; try { await assert.rejects(fn, re) } catch (e) { error = e.message } checks.push({ name, passed: !error, ...(error ? { error } : {}) }) }
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const bounded = promise => { let timer; return Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 400) })]).finally(() => clearTimeout(timer)) }
function toolset(files, task) {
  const tools = new Map(), agent = { id: 'recorder-read-' + task.taskId, session: {} }
  const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
  installFrameworkRoleTools(ctx, agent, { role: 'Recorder', taskId: task.taskId, owner: task.owner, workId: 'recorder-' + task.taskId, executionId: 'exact-read-execution' },
    { files, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => { throw error }, transact: async () => { throw new Error('Read must not publish') } })
  return { call: (name, input) => tools.get(name).execute(input, { agent, callId: 'call-' + checks.length, signal: new AbortController().signal, concludeTurn() { throw new Error('Read must not conclude a turn') } }) }
}
async function run(mode) {
  const repository = mode === 'git' ? new Repository() : undefined
  const files = repository ? new GitFiles(repository, new SessionGitOperations()) : new PhysicalLocalFiles(path.join(root, mode))
  const channel = new AsyncLocalStorage(), reads = [], channels = []
  let block
  if (repository) repository.withChannel = (name, fn) => channel.run(name, fn)
  const rawReadBytes = files.readBytes.bind(files), rawRead = files.read.bind(files)
  const trace = async (kind, snapshot, target, fn) => { reads.push(target); channels.push(channel.getStore()); if (block?.target === target) { block.entered.release(); await block.release.promise } return fn(snapshot, target) }
  files.readBytes = (s, p) => trace('bytes', s, p, rawReadBytes)
  // Physical read internally uses readBytes, whereas Git read uses the repository directly.
  if (repository) files.read = (s, p) => trace('text', s, p, rawRead)
  const set = async (target, value) => { if (repository) { put(repository, target, value); head(repository) } else if (value === undefined) await files.delete(target); else await files.replace(target, value) }
  const apply = async changes => { for (const item of changes) await set(item.path, item.content === null ? undefined : item.bytes ?? item.content) }
  const view = async fn => { const s = await files.snapshot(); try { return await fn(s) } finally { await s.release() } }
  const load = id => view(s => readJson(files, s, paths.task(id)))
  try {
    // Real Task initialization and reciprocal O->O->P/P dispatch builders supply
    // the tested family. A terminal stage is selected for the Recorder fixture;
    // this test does not claim to run native role execution or task completion.
    const id = '10000000-0000-4000-8000-000000000001'
    await set('tasks/recorder-root_O.md', 'Task ID: ' + id + '\nRoot original')
    await apply((await view(s => initializeTask(files, s, 'tasks/recorder-root_O.md', 'A', ['A', 'B'], id))).changes)
    await apply(await view(async s => dispatchPlannerObjective(files, s, await load(id), 'branch', 'A', 'Child O original', [], 'O')))
    await apply(await view(async s => dispatchPlannerObjective(files, s, await load(id), 'other', 'B', 'Other P original')))
    let parent = await load(id), branch = await load(parent.children[0].taskId), other = await load(parent.children[1].taskId)
    await apply(await view(s => dispatchPlannerObjective(files, s, branch, 'leaf', 'A', 'Leaf original')))
    const family = await view(s => taskFamily(files, s, id))
    for (const task of family) { task.status = 'complete'; await set(paths.task(task.taskId), encodeJson(task)) }
    parent = await load(id); branch = await load(branch.taskId); const leaf = await load(branch.children[0].taskId)
    const ordinary = 'debug/exact.md', own = paths.run(id) + '/Recorder_Note.md', skill = 'skills/actual/SKILL.md'
    await set(ordinary, 'original material'); await set(own, 'own current note'); await set(skill, '\uFEFF---\nname: actual\n---\ncomplete baseline\n')
    await set('debug/binary.bin', new Uint8Array([0, 255, 1])); await set('archives/ordinary/file.md', 'direct archive file')
    const role = toolset(files, parent), opened = await role.call('dss_snapshot', {})
    const read = (target, snapshotId = opened.snapshotId) => role.call('dss_read', { snapshotId, path: target })
    reads.length = 0; channels.length = 0
    check(mode + ' ordinary bytes', (await read(ordinary)).text, 'original material')
    const ordinaryTrace = [...reads]
    check(mode + ' ordinary read accesses only exact material', reads, [ordinary])
    if (repository) check('Git exact read retains role read channel', channels.every(c => c === 'read'), true)
    reads.length = 0
    check(mode + ' own working file', (await read(own)).text, 'own current note')
    check(mode + ' own working read is exact', reads, [own])
    reads.length = 0
    const missing = await read('debug/absent.md'); check(mode + ' absent remains absent', missing.exists, false)
    check(mode + ' missing ordinary read is exact', reads, ['debug/absent.md'])
    check(mode + ' binary stays binary', (await read('debug/binary.bin')).sha256, hash(new Uint8Array([0, 255, 1])))
    const skills = await read(skill); check(mode + ' complete BOM skill text preserved', skills.text, '\uFEFF---\nname: actual\n---\ncomplete baseline\n')
    check(mode + ' skill baseline retained', typeof skills.baseReadId, 'string')
    check(mode + ' missing skill baseline retained', typeof (await read('skills/actual/absent.md')).baseReadId, 'string')
    reads.length = 0; check(mode + ' archive exact bytes', (await read('archives/ordinary/file.md')).text, 'direct archive file')
    check(mode + ' archive needs no family', reads, ['archives/ordinary/file.md'])
    await set(ordinary, 'new current material')
    check(mode + ' established snapshot semantics preserved', (await read(ordinary)).text, repository ? 'original material' : 'new current material')
    const newer = await role.call('dss_snapshot', {}); check(mode + ' fresh view sees current material', (await read(ordinary, newer.snapshotId)).text, 'new current material')
    await rejects(mode + ' actual schema rejects invalid path', () => read(7), /string|Invalid input/)
    // Child working references still invoke reciprocal family/retention. All
    // four existing working roots are covered, including the state member key.
    const references = [paths.run(leaf.taskId) + '/result.md', 'Recorder Cache/' + leaf.taskId + '/record.md', 'technical/recovery-inputs/' + leaf.taskId + '/original.md', paths.state(leaf.owner, leaf.taskId) + '/material.md']
    const mapping = Object.fromEntries(references.map((p, i) => [p, paths.archive(leaf) + '/retained/material-' + i + '.md']))
    for (const [i, reference] of references.entries()) { await set(reference, 'old working ' + i); await set(mapping[reference], 'retained ' + i) }
    await set(paths.archive(leaf) + '/retention.json', encodeJson({ version: 1, relocatedReferences: mapping }))
    const mappedView = await role.call('dss_snapshot', {})
    for (const [i, reference] of references.entries()) {
      reads.length = 0; const value = await read(reference, mappedView.snapshotId)
      check(mode + ' descendant mapping ' + i, value.text, 'retained ' + i)
      check(mode + ' descendant mapped target ' + i, value.path, mapping[reference])
      check(mode + ' reciprocal family still consulted ' + i, reads.includes(paths.task(leaf.taskId)), true)
    }
    reads.length = 0; const childRequirement = await read(taskReference(leaf.taskId, leaf.sourcePath), mappedView.snapshotId)
    check(mode + ' exact descendant requirement', childRequirement.text, 'Task ID: ' + leaf.taskId + '\nLeaf original')
    check(mode + ' requirement identity preserved', childRequirement.path, taskReference(leaf.taskId, leaf.sourcePath))
    check(mode + ' child plain source still resolves', (await read(leaf.sourcePath, mappedView.snapshotId)).text, childRequirement.text)
    const childRole = toolset(files, leaf), childView = await childRole.call('dss_snapshot', {})
    check(mode + ' ancestor requirement preserved', (await childRole.call('dss_read', { snapshotId: childView.snapshotId, path: taskReference(parent.taskId, parent.sourcePath) })).text, 'Task ID: ' + id + '\nRoot original')
    await rejects(mode + ' unrelated exact requirement still rejected', () => read(taskReference('99999999-0000-4000-8000-000000000000', 'tasks/outside_P.md'), mappedView.snapshotId), /outside this Task requirement chain/)
    await set(mapping[references[0]], 'retained changed')
    check(mode + ' mapping snapshot semantics preserved', (await read(references[0], mappedView.snapshotId)).text, repository ? 'retained 0' : 'retained changed')
    const latest = await role.call('dss_snapshot', {})
    check(mode + ' new view mapped bytes', (await read(references[0], latest.snapshotId)).text, 'retained changed')
    // A real child-reference read may wait for child metadata; an independent
    // ordinary exact read must not inherit that unrelated family dependency.
    block = { target: paths.task(leaf.taskId), entered: gate(), release: gate() }
    const waiting = read(references[0], latest.snapshotId); await block.entered.promise
    const independent = read(ordinary, latest.snapshotId)
    const advanced = await bounded(independent)
    check(mode + ' ordinary read proceeds while child reference waits', advanced, true)
    block.release.release(); await waiting; await independent; block = undefined
    // Removal is a controlled dependency experiment, not a claimed user fault.
    await set(paths.task(leaf.taskId), undefined)
    const missingChild = await role.call('dss_snapshot', {})
    let ordinaryAfterRemoval; try { ordinaryAfterRemoval = await read(ordinary, missingChild.snapshotId) } catch (error) { ordinaryAfterRemoval = { error: error.message } }
    check(mode + ' absent unrelated child does not gate ordinary bytes', ordinaryAfterRemoval.text, 'new current material')
    await rejects(mode + ' actual missing descendant reference retains validation', () => read(references[0], missingChild.snapshotId), /Task child association is missing or inconsistent/)
    await set(paths.task(leaf.taskId), encodeJson(leaf))
    // Unknown logical Task-reference syntax retains its existing resolver path,
    // rather than being reclassified as an ordinary physical filename.
    const restored = await role.call('dss_snapshot', {})
    reads.length = 0; check(mode + ' unresolved reference remains absent', (await read('task-references/unresolved', restored.snapshotId)).exists, false)
    check(mode + ' unresolved prefix retains Task resolution', reads.includes(paths.task(parent.taskId)), true)
    await rejects(mode + ' malformed encoded reference keeps parser error', () => read('task-references/' + parent.taskId + '/%', restored.snapshotId), /URI malformed/)
    await set('extra/custom.md', 'ordinary unknown namespace')
    const customView = await role.call('dss_snapshot', {})
    check(mode + ' unknown ordinary path remains readable', (await read('extra/custom.md', customView.snapshotId)).text, 'ordinary unknown namespace')
    const unassociated = 'task-runs/99999999-0000-4000-8000-000000000000/existing.md'
    await set(unassociated, 'not a mapped descendant')
    const rawView = await role.call('dss_snapshot', {})
    check(mode + ' unknown working owner preserves ordinary fallback', (await read(unassociated, rawView.snapshotId)).text, 'not a mapped descendant')
    await set(paths.task(branch.taskId), undefined)
    const unknownChildView = await childRole.call('dss_snapshot', {})
    await rejects(mode + ' unresolved prefix retains original parent-chain failure', () => childRole.call('dss_read', { snapshotId: unknownChildView.snapshotId, path: 'task-references/unresolved' }), /Task parent association differs/)
    let childOrdinary; try { childOrdinary = await childRole.call('dss_read', { snapshotId: unknownChildView.snapshotId, path: ordinary }) } catch (error) { childOrdinary = { error: error.message } }
    check(mode + ' ordinary material does not inherit unresolved-reference failure', childOrdinary.text, 'new current material')
    await set(paths.task(branch.taskId), encodeJson(branch))
    // A same-name source replaced by another Task must never be returned as the
    // old requirement. Existing requirement identity and fallback remain in use.
    await set(parent.sourcePath, 'Task ID: 99999999-0000-4000-8000-000000000001\nNew unrelated requirement')
    const reused = await role.call('dss_snapshot', {})
    await rejects(mode + ' reused source not mistaken for original', () => read(taskReference(parent.taskId, parent.sourcePath), reused.snapshotId), /belongs to different material/)
    check(mode + ' pinned old requirement still available in Git', repository ? (await read(taskReference(parent.taskId, parent.sourcePath), mappedView.snapshotId)).text : 'local-live', repository ? 'Task ID: ' + id + '\nRoot original' : 'local-live')
    await role.call('dss_snapshot_release', { snapshotId: opened.snapshotId })
    await rejects(mode + ' released read view still rejected', () => read(ordinary), /Snapshot is released/)
    outcomes.push({ mode, ordinaryTrace, familySize: family.length, ordinaryCompletedDuringChildWait: advanced, snapshotConsistency: repository ? 'revision-fixed' : 'physical-live', terminalFixture: 'Real initialization/child dispatch builders, then explicit terminal metadata fixture; no native model execution.' })
  } finally { block?.release.release(); if (!repository) await files.close() }
}
try {
  for (const mode of ['local', 'git']) await run(mode)
  const failures = checks.filter(c => !c.passed)
  console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', assertions: checks.length, failures: failures.length, checks, outcomes, zodVersion: zod.z.core.version, sourceHashes: Object.fromEntries(loaded), limits: 'Actual role registration wrapper/schema/dss_snapshot/dss_read, PhysicalLocalFiles and GitFiles; controlled native Agent registration and Git repository transport. No native DSH process, live remote Git, Windows or full build/typecheck. Existing publication/retention/Cleaner regressions run separately. Controlled missing-child and wait cases establish dependency boundaries, not user-machine incidents.' }, null, 2))
  if (failures.length) process.exitCode = 1
} finally { await fs.rm(root, { recursive: true, force: true }); hooks.deregister() }
