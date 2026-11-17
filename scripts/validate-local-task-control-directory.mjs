import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'

// Actual physical file operations and the actual Cleaner entry, with explicitly
// constructed Task/Recorder observation inputs. No Service/native-agent fixture,
// Windows device, network Git, or cross-process filesystem adversary is claimed.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: 'data:text/javascript,const s=new Proxy(function(){},{get(_t,k){if(k===%22parse%22)return v=>v;return s},apply(){return s}});export const z=s;', shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw Error(%22Markdown is outside this filesystem test%22)}', shortCircuit: true }
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
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return next(url, context)
  }
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkCleaner } = await import('../src/framework/cleaner.ts')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-task-control-parent-'))
const files = new PhysicalLocalFiles(path.join(sandbox, 'records'))
const cleaner = new FrameworkCleaner(files, { run() { throw Error('Cleaner must not use a transaction in Local mode') } })
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (operation, expected) => { await assert.rejects(operation, expected); assertions++ }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const failSafe = promise => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Controlled test did not reach its awaited boundary')), 5000) })]).finally(() => clearTimeout(timer)) }
const logical = id => 'task-runs/' + id + '/control.json'
const physical = p => path.join(files.directory, ...p.split('/'))
const task = id => ({ version: 1, taskId: id, owner: 'member', route: 'P', status: 'complete', sourcePath: 'tasks/source_' + id + '_P.md' })
const clean = async id => { const t = task(id); return cleaner.clean(t, { status: 'ready', task: t, family: [t] }) }
const read = async p => { const snapshot = await files.snapshot(); try { return await files.read(snapshot, p) } finally { await snapshot.release() } }
const seed = async (id, text = 'old') => { await files.replace('task-runs/' + id + '/member/Reply.md', 'original Task support'); if (text !== undefined) await files.replace(logical(id), text) }
const absent = async id => { await rejects(() => fs.stat(physical('task-runs/' + id)), { code: 'ENOENT' }) }
const events = []
const event = (name, value) => events.push({ name, ...value })
try {
  let callbacks = 0
  await rejects(() => files.updateInExistingDirectory(logical('missing'), async () => { callbacks++; return { value: 'not-accepted', content: 'bad' } }), /no longer exists/)
  check(callbacks, 0); await absent('missing')

  // First control write uses the already initialized Task root, not a new
  // container. No sibling enumeration occurs.
  await files.replace('task-runs/first/member/Reply.md', 'initialized')
  const oldReaddir = fs.readdir
  fs.readdir = async () => { throw Error('No directory enumeration belongs to a fixed-file update') }
  try {
    check(await files.updateInExistingDirectory(logical('first'), async bytes => { check(bytes, undefined); return { value: 'accepted', content: 'first-control' } }), 'accepted')
  } finally { fs.readdir = oldReaddir }
  check(await read(logical('first')), 'first-control')
  check(await read('task-runs/first/member/Reply.md'), 'initialized')

  // Existing same-file mutation ordering is shared across handles; another Task
  // stays available even while A's original decide callback is unresolved.
  await seed('A'); await seed('B')
  const entered = deferred(), release = deferred(); let secondEntered = false
  const held = files.updateInExistingDirectory(logical('A'), async bytes => { check(Buffer.from(bytes).toString(), 'old'); entered.resolve(); await release.promise; return { value: 'A1', content: 'A1' } })
  await failSafe(entered.promise)
  const second = new PhysicalLocalFiles(files.directory)
  const queued = second.updateInExistingDirectory(logical('A'), async bytes => { secondEntered = true; check(Buffer.from(bytes).toString(), 'A1'); return { value: 'A2', content: 'A2' } })
  check(await failSafe(files.updateInExistingDirectory(logical('B'), async () => ({ value: 'B', content: 'B' }))), 'B')
  check(secondEntered, false); release.resolve(); check(await held, 'A1'); check(await queued, 'A2'); await second.close()

  // Baseline actual updateAsync recreates the Task root after actual Cleaner.
  await seed('baseline')
  const bEntered = deferred(), bRelease = deferred()
  const baseline = files.updateAsync(logical('baseline'), async () => { bEntered.resolve(); await bRelease.promise; return { value: 'late', content: 'late-baseline' } })
  await failSafe(bEntered.promise); check((await clean('baseline')).status, 'released'); await absent('baseline')
  bRelease.resolve(); check(await baseline, 'late'); check(await read(logical('baseline')), 'late-baseline')
  event('baseline-recreates-after-Cleaner', { reproduced: true })

  // Candidate queued/deciding write must preserve its original failure rather
  // than recreating the container or manufacturing an accepted result.
  await seed('candidate')
  const cEntered = deferred(), cRelease = deferred()
  const candidate = files.updateInExistingDirectory(logical('candidate'), async () => { cEntered.resolve(); await cRelease.promise; return { value: 'must-not-return', content: 'late-candidate' } })
  candidate.catch(() => {})
  await failSafe(cEntered.promise); check((await clean('candidate')).status, 'released'); await absent('candidate')
  cRelease.resolve(); await rejects(() => candidate, /no longer exists/); await absent('candidate')
  event('candidate-preserves-deleted-Task', { passed: true })

  // Exercise the real syscall windows. Explicit reconstruction is represented
  // by creating the same Task root and new-life file after actual Cleaner.
  // High-level recovery admission/lifecycle is tested separately.
  for (const boundary of ['before-temp-open', 'after-temp-open', 'before-rename', 'after-rename']) {
    const id = boundary, p = logical(id); await seed(id)
    const entered = deferred(), release = deferred(), originalOpen = fs.open, originalRename = fs.rename
    let intercepted = false
    fs.open = async function(name, ...args) {
      if (!intercepted && String(name).startsWith(physical('task-runs/' + id) + path.sep) && path.basename(String(name)).startsWith('.dss-write-') && boundary.includes('temp-open')) {
        intercepted = true
        if (boundary === 'before-temp-open') { entered.resolve(); await release.promise; return originalOpen.call(this, name, ...args) }
        const handle = await originalOpen.call(this, name, ...args), writeFile = handle.writeFile
        handle.writeFile = async function(...values) { entered.resolve(); await release.promise; return writeFile.apply(this, values) }
        return handle
      }
      return originalOpen.call(this, name, ...args)
    }
    fs.rename = async function(from, to) {
      if (!intercepted && to === physical(p) && boundary.includes('rename')) {
        intercepted = true
        if (boundary === 'before-rename') { entered.resolve(); await release.promise; return originalRename.call(this, from, to) }
        const result = await originalRename.call(this, from, to); entered.resolve(); await release.promise; return result
      }
      return originalRename.call(this, from, to)
    }
    const operation = files.updateInExistingDirectory(p, async () => ({ value: 'old-write-result', content: 'old-write' }))
    operation.catch(() => {})
    try {
      await failSafe(entered.promise)
      check((await clean(id)).status, 'released'); await absent(id)
      // Bypass the same-file queue deliberately only to model the actual
      // recovery writer, which reconstructs Task support before metadata.
      await files.replace('task-runs/' + id + '/member/Reply.md', 'new-lifecycle')
      await fs.writeFile(physical(p), 'new-lifecycle-control')
      release.resolve()
      if (boundary === 'after-rename') check(await operation, 'old-write-result')
      else await rejects(() => operation, boundary === 'before-rename' ? { code: 'ENOENT' } : /directory changed/)
      check(await read(p), 'new-lifecycle-control')
      check((await fs.readdir(physical('task-runs/' + id))).filter(name => name.startsWith('.dss-write-')), [])
      event(boundary, { newLifecyclePreserved: true, originalResult: boundary === 'after-rename' ? 'published-before-cleanup' : 'rejected-unpublished' })
    } finally { release.resolve(); fs.open = originalOpen; fs.rename = originalRename }
  }

  // Callback/IO/cancellation retain exact errors; no hidden retry or leftover
  // temporary file. Ordinary replace still creates its own requested directory.
  await seed('errors')
  const originalError = Error('original-decision-failure')
  await rejects(() => files.updateInExistingDirectory(logical('errors'), async () => { throw originalError }), error => error === originalError)
  check(await read(logical('errors')), 'old')
  const controller = new AbortController(), cancel = Error('original-cancel')
  await rejects(() => files.updateInExistingDirectory(logical('errors'), async () => { controller.abort(cancel); return { value: 'not-accepted', content: 'not-written' } }, controller.signal), error => error === cancel)
  check(await read(logical('errors')), 'old')
  const originalRename = fs.rename, io = Object.assign(Error('original-rename-failure'), { code: 'EIO' }); let renameCalls = 0
  fs.rename = async function(from, to) { if (to === physical(logical('errors'))) { renameCalls++; throw io } return originalRename.call(this, from, to) }
  try { await rejects(() => files.updateInExistingDirectory(logical('errors'), async () => ({ value: 'bad', content: 'bad' })), error => error === io) }
  finally { fs.rename = originalRename }
  check(renameCalls, 1); check(await read(logical('errors')), 'old')
  check((await fs.readdir(physical('task-runs/errors'))).filter(name => name.startsWith('.dss-write-')), [])
  await files.replace('ordinary/new/file.txt', 'unchanged-public-API')
  check(await read('ordinary/new/file.txt'), 'unchanged-public-API')

  // Closing drains only this handle's accepted operations. An independent Task
  // handle is not closed, and the original error stays the caller's result.
  await seed('close')
  const closeEntered = deferred(), closeRelease = deferred(), closeError = Error('held-original-write-failure')
  const closeWrite = files.updateInExistingDirectory(logical('close'), async () => { closeEntered.resolve(); await closeRelease.promise; throw closeError })
  closeWrite.catch(() => {}); await failSafe(closeEntered.promise)
  let closed = false; const closing = files.close().then(() => { closed = true })
  await Promise.resolve(); check(closed, false)
  const independent = new PhysicalLocalFiles(files.directory)
  check(await failSafe(independent.updateInExistingDirectory(logical('B'), async () => ({ value: 'independent', content: 'independent' }))), 'independent')
  await rejects(async () => files.updateInExistingDirectory(logical('B'), async () => ({ value: 'after-close' })), /storage is closed/)
  closeRelease.resolve(); await rejects(() => closeWrite, error => error === closeError); await closing; check(closed, true)
  await independent.close()
  console.log(JSON.stringify({ assertions, events, scope: 'Native Local file methods and actual FrameworkCleaner.clean with assembled Task/observation; not full Host/Service, Windows, Git, or cross-process safety', sourceSha256: Object.fromEntries(loaded) }, null, 2))
} finally { await files.close(); hooks.deregister(); await fs.rm(sandbox, { recursive: true, force: true }) }
