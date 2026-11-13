import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
// Actual Host source/task discovery, physical store and real DSH technical
// storage. Native role wake execution is captured, not simulated as completed.
const supplemental = registerHooks({ resolve(s, c, next) { if (s === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw new Error("Markdown outside Host metadata test")}', shortCircuit: true }; return next(s, c) } })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { paths } = await import('../src/framework/task-files.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-host-exact-observation-'))
const checks = [], metrics = [], errors = [], fixtures = []
const check = (name, value, expected) => { let error; try { assert.deepEqual(value, expected) } catch (e) { error = e.message } checks.push({ name, passed: !error, ...(error ? { value, expected, error } : {}) }) }
const gate = () => { let release; const promise = new Promise(r => { release = r }); return { promise, release } }
const bounded = promise => { let timer; return Promise.race([promise.then(() => true), new Promise(r => { timer = setTimeout(() => r(false), 500) })]).finally(() => clearTimeout(timer)) }
let tracked, counter
const nativeReaddir = fs.readdir, nativeLstat = fs.lstat, nativeOpen = fs.open
fs.readdir = async function(p, ...args) { if (counter) { counter.allReaddir++; if (String(p) === tracked) counter.readdir++ } return nativeReaddir.call(this, p, ...args) }
fs.lstat = async function(p, ...args) { if (counter) { counter.allLstat++; if (path.dirname(String(p)) === tracked) counter.childLstat++ } return nativeLstat.call(this, p, ...args) }
fs.open = async function(p, ...args) { const h = await nativeOpen.call(this, p, ...args); if (counter) { const captured = counter, child = path.dirname(String(p)) === tracked; captured.allOpen++; if (child) captured.fileOpen++; const stat = h.stat.bind(h); h.stat = async (...args) => { captured.allHandleStat++; if (child) captured.handleStat++; return stat(...args) } } return h }
async function fixture(n, name) {
  const directory = path.join(root, name), files = new PhysicalLocalFiles(path.join(directory, 'local'))
  const sdk = await openDshStorageFixture(path.join(directory, 'records'), path.join(directory, 'locator'))
  const records = sdk.adapter, transactions = new FrameworkTransactions(files, records, name)
  const found = [], wakes = [], events = [], pending = new Set()
  let block, onFound
  const selected = files.listDirectory.bind(files), exact = files.fileMetadata?.bind(files), metadata = files.records.listMetadata.bind(files.records)
  files.records.listMetadata = async (...args) => { const result = await metadata(...args); if (counter && args[0] === 'tasks/') { counter.metadataLists++; counter.metadataRows += result.length } return result }
  const awaitBlock = async target => { if (block?.target === target) { const b = block; b.entered.release(); await b.release.promise } }
  files.listDirectory = async (s, p, selection) => { if (p === 'tasks/' && selection?.paths?.length === 1) await awaitBlock(selection.paths[0]); return selected(s, p, selection) }
  files.fileMetadata = async target => { if (counter && target.startsWith('tasks/')) counter.exactEntries++; await awaitBlock(target); return exact(target) }
  const host = new FrameworkHostLoop(files, transactions, records, { member: 'A', primary: true, scope: name, instanceUUID: '00000000-0000-4000-8000-000000000001' }, () => ['A'], {
    startup: async () => {}, observe: async () => {}, observeLocal: async () => {}, executing: () => false,
    discoverTask: async task => { found.push(structuredClone(task)); events.push('Task:' + task.taskId); onFound?.(task) },
    wake: async wake => { wakes.push(wake); return false }, error: error => errors.push(error.message),
    sealBusiness: async () => {}, clean: async () => false, releaseTask: async () => {},
  })
  const f = { files, host, sdk, found, wakes, events, directory,
    hold(target) { block = { target, entered: gate(), release: gate() }; return block },
    release() { block?.release.release(); block = undefined },
    observe(fn) { onFound = fn },
    async poll() { const promise = host.poll(); pending.add(promise); try { await promise } finally { pending.delete(promise) } },
    async close() { this.release(); await Promise.allSettled(pending); await host.stop(); await files.close(); await sdk.close() },
  }
  fixtures.push(f)
  for (let i = 0; i < n; i++) await files.replace('tasks/task-' + i + '_P.md', 'original user work ' + i)
  await f.poll(); await f.poll(); await f.poll(); found.length = 0; wakes.length = 0
  return f
}
try {
  for (const n of [1, 2, 8, 32]) {
    const f = await fixture(n, 'cost-' + n)
    tracked = path.join(f.directory, 'local', 'tasks'); counter = { tasks: n, rootEntries: 2 * n, metadataLists: 0, metadataRows: 0, exactEntries: 0, readdir: 0, childLstat: 0, fileOpen: 0, handleStat: 0, allReaddir: 0, allLstat: 0, allOpen: 0, allHandleStat: 0 }
    await f.poll(); metrics.push(counter); counter = undefined
    check(n + ' Task warm poll retains one discovery enumeration', metrics.at(-1).metadataLists, 1)
    check(n + ' Task warm poll enumerates each root entry once', metrics.at(-1).metadataRows, 2 * n)
    check(n + ' known Tasks use one exact metadata lookup each', metrics.at(-1).exactEntries, n)
    check(n + ' Tasks remain discovered', new Set(f.found.map(t => t.taskId)).size, n)
    await f.close(); fixtures.splice(fixtures.indexOf(f), 1)
  }
  const f = await fixture(2, 'changes'), { files } = f
  const read = async target => { const s = await files.snapshot(); try { return await files.read(s, target) } finally { await s.release() } }
  const id = async source => /Task ID: ([a-f0-9-]+)/.exec(await read(source))[1]
  const a = await id('tasks/task-0_P.md'), b = await id('tasks/task-1_P.md'), aPath = paths.task(a), saved = await read(aPath)
  // Hold only A's actual per-Task reobservation after the root discovery.
  let hold = f.hold(aPath), seenB = gate(); f.observe(t => { if (t.taskId === b) seenB.release() }); f.found.length = 0
  let poll = f.poll(); await hold.entered.promise
  check('B Task discovery proceeds while A exact recheck waits', await bounded(seenB.promise), true)
  const changed = JSON.parse(saved); changed.userNote = 'changed after discovery'
  await files.replace(aPath, JSON.stringify(changed)); f.release(); await poll
  check('A uses metadata changed after discovery', f.found.find(t => t.taskId === a)?.userNote, 'changed after discovery')
  f.observe(undefined); f.found.length = 0; hold = f.hold(aPath); poll = f.poll(); await hold.entered.promise
  await files.delete(aPath); f.release(); await poll
  check('Removed known Task does not reuse earlier metadata', f.found.some(t => t.taskId === a), false)
  await files.replace(aPath, saved); f.found.length = 0; await f.poll()
  check('Recreated known Task is discovered next round', f.found.some(t => t.taskId === a), true)
  // Existing root discovery remains responsible for a new source. Change that
  // exact source after its stale root entry but before source initialization.
  await files.replace('tasks/new-name_P.md', 'earlier source body')
  hold = f.hold('tasks/new-name_P.md'); poll = f.poll(); await hold.entered.promise
  await files.replace('tasks/new-name_P.md', 'latest source body'); f.release(); await poll
  const freshId = await id('tasks/new-name_P.md')
  check('New source initialization reads latest same-name body', (await read(paths.inbox(freshId, 'A'))).trim(), 'latest source body')
  check('New source retains assigned Task identity', (await read('tasks/new-name_P.md')).includes('Task ID: ' + freshId), true)
  f.found.length = 0; await f.poll(); check('New source Task discovered following round', f.found.some(t => t.taskId === freshId), true)
  // A discovered source which is removed before initialization stays absent.
  await files.replace('tasks/remove-before_P.md', 'remove before initialization')
  hold = f.hold('tasks/remove-before_P.md'); poll = f.poll(); await hold.entered.promise
  await files.delete('tasks/remove-before_P.md'); f.release(); await poll
  check('Removed source not recreated', await read('tasks/remove-before_P.md'), undefined)
  check('No pending reservation for a removed source', Object.values(f.host.record.initial).some(x => x.physicalSourcePath === 'tasks/remove-before_P.md'), false)
  // An ordinary directory at the same observed name is not a Task file.
  hold = f.hold(aPath); poll = f.poll(); await hold.entered.promise
  await files.delete(aPath); await fs.mkdir(path.join(f.directory, 'local', aPath)); f.found.length = 0; f.release(); await poll
  check('File replaced by directory is skipped, not parsed', f.found.some(t => t.taskId === a), false)
  await fs.rmdir(path.join(f.directory, 'local', aPath)); await files.replace(aPath, saved)
  f.found.length = 0; await f.poll(); check('File restored after directory is discoverable', f.found.some(t => t.taskId === a), true)
  check('Ordinary/change cases have no Host errors', errors, [])
  // Keep directory-list semantics when a previously ordinary name changes to
  // a symbolic link before reobservation. No link target is ever read.
  hold = f.hold(aPath); poll = f.poll(); await hold.entered.promise
  await files.delete(aPath); await fs.symlink(path.basename(paths.task(b)), path.join(f.directory, 'local', aPath))
  f.found.length = 0; f.release(); let symlinkError
  try { await poll } catch (error) { symlinkError = error.message }
  check('Exact reobservation keeps prior skip of a replaced symlink', errors, [])
  check('Symlink is never parsed as the Task target', f.found.some(t => t.taskId === a), false)
  await fs.unlink(path.join(f.directory, 'local', aPath)); await files.replace(aPath, saved)

  const failed = checks.filter(x => !x.passed)
  console.log(JSON.stringify({ status: failed.length ? 'failed' : 'passed', assertions: checks.length, failures: failed.length, checks, metrics, ...evidence(), limits: 'Actual FrameworkHostLoop.poll/startSource/startTask, PhysicalLocalFiles and recovered SDK technical storage. Native role execution is captured, account/model/network are not exercised. Metadata syscall counts are controlled Linux counts, not Windows elapsed-time or heap benchmarks. The root dynamic discovery remains one enumeration; this test specifically removes repeated sibling enumeration for already known paths.' }, null, 2))
  if (failed.length) process.exitCode = 1
} finally { counter = undefined; for (const f of fixtures) await f.close(); fs.readdir = nativeReaddir; fs.lstat = nativeLstat; fs.open = nativeOpen; supplemental.deregister(); hooks.deregister(); await fs.rm(root, { recursive: true, force: true }) }
