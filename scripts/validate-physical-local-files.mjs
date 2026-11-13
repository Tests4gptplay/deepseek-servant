import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual physical adapter, guide initializer and command boundary, fresh Linux
// scratch only. Schema/native DSH integrations are not under test. This is not
// Windows/device, product cutover, full typecheck, or a multi-file atomic test.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const schema = `const schema = new Proxy(function () {}, { get(_t, key) { if (key === 'parse') return value => value; return schema }, apply() { return schema } }); export const z = schema;`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: 'data:text/javascript;base64,' + Buffer.from(schema).toString('base64'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { PhysicalLocalFiles, PhysicalLocalPublicationRequiredError } = await import('../src/framework/physical-local-files.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { initializeRoleGuides } = await import('../src/framework/role-guides.ts')
const { foregroundGuidePath } = await import('../src/framework/foreground-prompt.ts')
const { foregroundFullGuide } = await import('../src/framework/role-prompts.ts')
const { observeFileReads } = await import('../src/framework/file-read-observation.ts')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-physical-adapter-'))
const root = path.join(sandbox, 'root'), files = new PhysicalLocalFiles(root), second = new PhysicalLocalFiles(root)
let assertions = 0
const check = (value, expected) => { assert.deepEqual(value, expected); assertions++ }
const rejects = async (action, expected) => { await assert.rejects(action, expected); assertions++ }
const filename = logical => path.join(root, ...logical.split('/'))
try {
  const view = await files.snapshot()
  check(view.consistency, 'physical-live')
  check(view.revision.startsWith('local-view:'), true)
  check(await files.read(view, 'tasks/task.json'), undefined)
  check(await files.listDirectory(view, ''), [])
  await rejects(() => fs.lstat(root), { code: 'ENOENT' })
  const note = 'task-runs/task/member/workers/a/notes.md'
  await files.replace(note, 'first\n')
  check(await fs.readFile(filename(note), 'utf8'), 'first\n')
  await fs.writeFile(filename(note), 'external\n')
  check(await files.read(view, note), 'external\n')
  await files.append(note, 'next\n')
  check(await files.read(view, note), 'external\nnext\n')
  const observation = []
  await observeFileReads(view, (...row) => observation.push(row), () => files.read(view, note))
  check(observation.length, 1)
  check(observation[0], ['file:' + note, createHash('sha256').update('external\nnext\n').digest('hex')])
  check(await files.update(note, bytes => ({ value: bytes.length })), Buffer.byteLength('external\nnext\n'))
  check(await files.read(view, note), 'external\nnext\n')
  await rejects(() => files.update(note, () => { throw new Error('decide failed') }), /decide failed/)
  check(await files.read(view, note), 'external\nnext\n')
  await rejects(() => files.update(note, async () => ({ value: 1, content: 'bad' })), /synchronous/)
  check(await files.read(view, note), 'external\nnext\n')
  await files.replace('counter.json', '0')
  await Promise.all(Array.from({ length: 80 }, (_, i) => (i % 2 ? files : second).update('counter.json', bytes => ({ value: undefined, content: String(Number(Buffer.from(bytes).toString()) + 1) }))))
  check(await files.read(view, 'counter.json'), '80')
  check(await files.update('counter.json', () => ({ value: 'deleted', content: null })), 'deleted')
  check(await files.read(view, 'counter.json'), undefined)
  await files.replace('state/member/task/Planner_Inbox', '')
  await files.replace('state/member/task/Other', 'other')
  const listed = await files.listDirectory(view, 'state/member/task', { names: ['Planner_Inbox'] })
  check(listed.map(({ path, bytes, empty }) => ({ path, bytes, empty })), [{ path: 'state/member/task/Planner_Inbox', bytes: 0, empty: true }])
  check(await files.listDirectoryNames(view, 'state/member/task', { namePrefix: 'Planner_' }), ['state/member/task/Planner_Inbox'])
  const nextList = await files.listDirectory(view, 'state/member/task', { names: ['Planner_Inbox'] })
  check(listed[0].version === nextList[0].version, true)
  const secondView = await second.snapshot()
  check((await second.listDirectory(secondView, 'state/member/task', { names: ['Planner_Inbox'] }))[0].version, listed[0].version)
  await files.replace('state/member/task/Planner_Inbox', '')
  check((await files.listDirectory(view, 'state/member/task', { names: ['Planner_Inbox'] }))[0].version === listed[0].version, false)
  await secondView.release()
  await files.replace('archives/root/record.md', 'root')
  await files.replace('archives/root/child/record.md', 'child')
  const childDirectory = filename('archives/root/child'), originalReadDir = fs.readdir
  fs.readdir = async (directory, ...args) => {
    if (directory === childDirectory) throw new Error('Child should not be traversed')
    return originalReadDir(directory, ...args)
  }
  try { check((await files.list(view, 'archives/root', { archiveScope: { root: 'archives/root', childTaskIds: ['child'] } })).map(row => row.path), ['archives/root/record.md']) }
  finally { fs.readdir = originalReadDir }
  const canceled = new AbortController(), cancelledView = await files.snapshot({ signal: canceled.signal })
  canceled.abort()
  await rejects(() => files.read(cancelledView, note), { name: 'AbortError' })
  await rejects(() => second.read(view, note), /belongs to another store/)
  await rejects(() => files.commit(view, [{ path: note, content: 'unsafe' }], 'old atomic command'), PhysicalLocalPublicationRequiredError)
  await rejects(() => files.commit(view, [{ path: note, content: 'unsafe' }, { path: 'other', content: 'unsafe' }], 'multi'), PhysicalLocalPublicationRequiredError)
  check(await files.read(view, note), 'external\nnext\n')
  check((await files.commit(view, [], 'observation')).observationOnly, true)
  let storageCalls = 0, built = false
  const records = { get: async () => { storageCalls++; return undefined }, set: async () => { storageCalls++ }, list: async () => { storageCalls++; return [] } }
  const tx = new FrameworkTransactions(files, records, 'scratch')
  await rejects(() => tx.run('unported', {}, {}, async () => { built = true; return [{ path: note, content: 'unsafe' }] }), PhysicalLocalPublicationRequiredError)
  await rejects(() => tx.confirmed('unported', {}), PhysicalLocalPublicationRequiredError)
  check([storageCalls, built], [0, false])

  // Real ordinary production function uses the physical route, no transaction
  // journal/receipt or mocked business initializer; reopen reads actual bytes.
  const guideResults = await Promise.all([initializeRoleGuides(files, tx), initializeRoleGuides(second, tx)])
  check(guideResults.map(row => row.status).sort(), ['created', 'unchanged'])
  check(await fs.readFile(filename(foregroundGuidePath), 'utf8'), foregroundFullGuide())
  check((await initializeRoleGuides(files, tx)).status, 'unchanged')
  await files.replace(foregroundGuidePath, 'User customized reference\n')
  check((await initializeRoleGuides(files, tx, undefined, { missingOnly: true })).status, 'unchanged')
  check(await files.read(view, foregroundGuidePath), 'User customized reference\n')
  await files.replace(foregroundGuidePath, new Uint8Array([255, 254, 0]))
  check((await initializeRoleGuides(files, tx)).unreviewedSections, ['non-UTF-8 guide (original bytes preserved)'])
  check([...await files.readBytes(view, foregroundGuidePath)], [255, 254, 0])
  check(storageCalls, 0)
  check((await files.list(view, 'technical')).map(entry => entry.path), [foregroundGuidePath])
  await files.delete(foregroundGuidePath)
  check((await initializeRoleGuides(files, tx)).status, 'created')

  // Actual same-file queue, without interference with another file/read.
  const rename = fs.rename
  let arrived, unblock
  const entered = new Promise(resolve => { arrived = resolve }), blocked = new Promise(resolve => { unblock = resolve })
  fs.rename = async (from, to) => { if (to === filename(note)) { arrived(); await blocked } return rename(from, to) }
  let first, after
  try {
    first = files.update(note, bytes => ({ value: undefined, content: Buffer.from(bytes).toString() + 'edited\n' }))
    await entered
    after = second.append(note, 'appended\n')
    await files.replace('task-runs/another/member/note.md', 'independent')
    check(await files.read(view, 'task-runs/another/member/note.md'), 'independent')
    check(await files.read(view, note), 'external\nnext\n')
  } finally { unblock(); await Promise.all([first, after]); fs.rename = rename }
  check(await files.read(view, note), 'external\nnext\nedited\nappended\n')
  // Known Task templates: same-process absent-only creation, complete-body
  // rename, with no hardlink capability or existing-body read requirement.
  const template = 'task-runs/new/member/Planner_Memory.md'
  const originalLink = fs.link, actualRead = files.records.readBytes
  fs.link = async () => { throw new Error('This filesystem does not support hardlinks') }
  files.records.readBytes = async () => { throw new Error('A template existence check must not read its body') }
  try {
    check(await files.createIfAbsent(template, 'first author'), true)
    check(await files.createIfAbsent(template, 'replace author'), false)
  } finally { fs.link = originalLink; files.records.readBytes = actualRead }
  check(await files.read(view, template), 'first author')
  const concurrentTemplate = 'task-runs/new/member/Plan_Note.md'
  check(await Promise.all([files.createIfAbsent(concurrentTemplate, 'first'), second.createIfAbsent(concurrentTemplate, 'second')]), [true, false])
  check(await files.read(view, concurrentTemplate), 'first')
  const failedTemplate = 'task-runs/new/member/Failed.md'
  fs.rename = async (from, to) => { if (to === filename(failedTemplate)) throw Object.assign(new Error('template rename failure'), { code: 'EIO' }); return rename(from, to) }
  try { await rejects(() => files.createIfAbsent(failedTemplate, 'complete'), /template rename failure/) }
  finally { fs.rename = rename }
  check(await files.read(view, failedTemplate), undefined)
  check((await fs.readdir(filename('task-runs/new/member'))).some(name => name.startsWith('.dss-write-')), false)

  // A real prepared signal is moved once. Missing means missing, not success;
  // target replacement is one rename, and errors do not trigger delete/copy.
  const preparedSignal = 'state/member/new/.initial-signal-001', signalPath = 'state/member/new/Planner_Inbox'
  check(await files.rename(preparedSignal, signalPath), false)
  await rejects(() => fs.lstat(filename('state/member/new')), { code: 'ENOENT' })
  await files.createIfAbsent(preparedSignal, '')
  check(await files.rename(preparedSignal, signalPath), true)
  check(await files.read(view, preparedSignal), undefined)
  check(await files.read(view, signalPath), '')
  check(await files.rename(preparedSignal, signalPath), false)
  await rejects(async () => files.rename(signalPath, signalPath), /two distinct paths/)
  await files.replace(preparedSignal, 'new signal')
  fs.rename = async (from, to) => { if (from === filename(preparedSignal)) throw Object.assign(new Error('handoff failed'), { code: 'EIO' }); return rename(from, to) }
  try { await rejects(() => files.rename(preparedSignal, signalPath), /handoff failed/) }
  finally { fs.rename = rename }
  check(await files.read(view, preparedSignal), 'new signal')
  check(await files.read(view, signalPath), '')
  fs.rename = async (from, to) => { if (from === filename(preparedSignal)) throw Object.assign(new Error('destination parent missing'), { code: 'ENOENT' }); return rename(from, to) }
  try { await rejects(() => files.rename(preparedSignal, signalPath), /destination parent missing/) }
  finally { fs.rename = rename }
  check(await files.read(view, preparedSignal), 'new signal')
  check(await files.rename(preparedSignal, signalPath), true)
  check(await files.read(view, signalPath), 'new signal')
  await files.replace('handoff/a', 'a'); await files.replace('handoff/b', 'b')
  check(await Promise.all([files.rename('handoff/a', 'handoff/b'), second.rename('handoff/b', 'handoff/a')]), [true, true])
  check(await files.read(view, 'handoff/a'), 'a')
  check(await files.read(view, 'handoff/b'), undefined)

  const observe = async path => (await files.listDirectory(view, path.slice(0, path.lastIndexOf('/')), { paths: [path] }))[0]?.version
  await files.replace(signalPath, '')
  const claimed = await observe(signalPath)
  let deletionGuards = 0
  check(await files.deleteObserved(signalPath, claimed, () => { deletionGuards++ }), true)
  check(deletionGuards, 1)
  check(await files.deleteObserved(signalPath, claimed), false)
  await files.replace(signalPath, '')
  const recreated = await observe(signalPath)
  check(recreated === claimed, false)
  check(await files.deleteObserved(signalPath, claimed, () => { throw new Error('Wrong original should not enter deletion') }), false)
  check(await files.read(view, signalPath), '')
  await rejects(() => files.deleteObserved(signalPath, recreated, () => { throw new Error('execution ended') }), /execution ended/)
  check(await files.read(view, signalPath), '')
  const oldClaim = await observe(signalPath)
  let enteredSignal, resumeSignal
  const signalEntered = new Promise(resolve => { enteredSignal = resolve }), signalHeld = new Promise(resolve => { resumeSignal = resolve })
  fs.rename = async (from, to) => { if (to === filename(signalPath)) { enteredSignal(); await signalHeld } return rename(from, to) }
  let redelivery, consumption
  try {
    redelivery = second.replace(signalPath, '')
    await signalEntered
    consumption = files.deleteObserved(signalPath, oldClaim)
    await files.replace('state/unrelated/task/Worker', '')
    check(await files.read(view, 'state/unrelated/task/Worker'), '')
  } finally { resumeSignal(); await redelivery; fs.rename = rename }
  check(await consumption, false)
  check(await files.read(view, signalPath), '')
  const currentClaim = await observe(signalPath)
  // Matching actual target metadata is checked without reading file contents or
  // enumerating directories; unrelated metadata never becomes a global gate.
  const readdir = fs.readdir
  files.records.readBytes = async () => { throw new Error('Consumption must not read a signal body') }
  fs.readdir = async () => { throw new Error('Consumption must not enumerate directories') }
  try { check(await files.deleteObserved(signalPath, currentClaim), true) }
  finally { fs.readdir = readdir; files.records.readBytes = actualRead }
  check(await files.read(view, signalPath), undefined)
  // Asynchronous program-state evaluation owns only this actual state file.
  const statePath = 'archives/state-owner/state.json'
  await files.replace(statePath, '0')
  let stateEntered, stateResume
  const enteredState = new Promise(resolve => { stateEntered = resolve }), heldState = new Promise(resolve => { stateResume = resolve })
  const firstState = files.updateAsync(statePath, async bytes => { stateEntered(); await heldState; return { value: 'first', content: String(Number(Buffer.from(bytes).toString()) + 1) } })
  await enteredState
  const nextState = second.updateAsync(statePath, async bytes => ({ value: 'next', content: String(Number(Buffer.from(bytes).toString()) + 1) }))
  await files.replace('archives/other/state.json', 'independent state')
  check(await files.read(view, 'archives/other/state.json'), 'independent state')
  check(await files.read(view, statePath), '0')
  stateResume()
  check(await Promise.all([firstState, nextState]), ['first', 'next'])
  check(await files.read(view, statePath), '2')
  check(await files.updateAsync(statePath, async bytes => ({ value: await files.read(view, 'archives/other/state.json') })), 'independent state')
  check(await files.read(view, statePath), '2')
  await rejects(() => files.updateAsync(statePath, async () => { throw new Error('asynchronous decision failed') }), /asynchronous decision failed/)
  check(await files.read(view, statePath), '2')

  // Whole known directory removal: no application-side file inventory,
  // individual unlink loop, preserved signal, or active-writer prerequisite.
  const cleanRoot = 'state/member/cleanup-task'
  await files.replace(cleanRoot + '/Cleaner', '')
  await files.replace(cleanRoot + '/nested/deep/record.bin', new Uint8Array([1, 2, 3]))
  await fs.writeFile(filename(cleanRoot + '/.dss-write-orphan.tmp'), 'partial')
  await files.replace('state/member/other-task/Note.md', 'other task')
  const cleanupReadDir = fs.readdir, cleanupRm = fs.rm, removals = []
  fs.readdir = async () => { throw new Error('Application-side cleanup enumeration is forbidden') }
  fs.rm = async (directory, options) => { removals.push([directory, options]); return cleanupRm(directory, options) }
  try { await files.removeDirectory(cleanRoot) }
  finally { fs.readdir = cleanupReadDir; fs.rm = cleanupRm }
  check(removals, [[filename(cleanRoot), { recursive: true, force: true }]])
  check(await files.read(view, 'state/member/other-task/Note.md'), 'other task')
  await rejects(() => fs.lstat(filename(cleanRoot)), { code: 'ENOENT' })
  await files.removeDirectory(cleanRoot)
  assert.throws(() => files.removeDirectory(''), /relative file path/); assertions++
  const linkedRoot = 'task-runs/cleanup-with-link', outside = path.join(sandbox, 'outside-protected.txt')
  await files.replace(linkedRoot + '/Note.md', 'task body'); await fs.writeFile(outside, 'outside')
  await fs.symlink(outside, filename(linkedRoot + '/link'))
  await files.removeDirectory(linkedRoot)
  check(await fs.readFile(outside, 'utf8'), 'outside')
  const failureRoot = 'task-runs/cleanup-failure'
  await files.replace(failureRoot + '/Note.md', 'retained on failure')
  fs.rm = async target => { if (target === filename(failureRoot)) throw Object.assign(new Error('directory unavailable'), { code: 'EACCES' }); return cleanupRm(target) }
  try { await rejects(() => files.removeDirectory(failureRoot), /directory unavailable/) }
  finally { fs.rm = cleanupRm }
  check(await files.read(view, failureRoot + '/Note.md'), 'retained on failure')
  await files.removeDirectory(failureRoot)
  await rejects(() => fs.lstat(filename(failureRoot)), { code: 'ENOENT' })
  await view.release()
  await rejects(() => files.read(view, note), /released/)
  await files.close(); await files.close()
  await rejects(() => files.snapshot(), /closed/)
  const reopened = await PhysicalLocalFiles.open(root), reread = await reopened.snapshot()
  check(await reopened.read(reread, note), 'external\nnext\nedited\nappended\n')
  await reread.release(); await reopened.close()
  const legacy = path.join(sandbox, 'legacy'); await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'dss-files.sqlite'), 'not a real user database')
  const retained = await PhysicalLocalFiles.open(legacy, { requireExisting: true })
  check(retained.directory, legacy); await retained.close()
  const missingRoot = path.join(sandbox, 'missing-selected-root')
  await rejects(() => PhysicalLocalFiles.open(missingRoot, { requireExisting: true }), /existing Local directory is unavailable/)
  await rejects(() => fs.lstat(missingRoot), { code: 'ENOENT' })
  check(await fs.readFile(path.join(legacy, 'dss-files.sqlite'), 'utf8'), 'not a real user database')
  console.log(JSON.stringify({ result: 'PASS', assertions, runtime: process.version, platform: process.platform, scope: 'Actual scratch physical adapter/update/guide/template creation/prepared handoff/observed signal consume/known directory cleanup. No user DB, Windows/native DSH, or full typecheck; physical acquisition is tested independently of the full Host activation.', sources: Object.fromEntries(loaded) }, null, 2))
} finally { await second.close(); await files.close(); hooks.deregister(); await fs.rm(sandbox, { recursive: true, force: true }) }
