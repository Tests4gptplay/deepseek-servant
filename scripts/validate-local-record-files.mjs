import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'

// Current design: each mapped Local record is its own physical file. The actual
// LocalRecordFiles entrypoints below operate on fresh scratch data. This is a
// controlled native filesystem check, not an adapter, full typecheck, Windows
// user-device observation, Git transport, or multi-file transaction test.
const sourceURL = new URL('../src/framework/local-record-files.ts', import.meta.url)
const source = await fs.readFile(sourceURL, 'utf8')
const moduleURL = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
const { LocalRecordFiles, localRecordPath } = await import(moduleURL)
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-record-files-'))
const root = path.join(sandbox, 'records')
const records = new LocalRecordFiles(root), second = new LocalRecordFiles(root)
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (action, expected) => { await assert.rejects(action, expected); assertions++ }
const rejectsCall = async (action, expected) => rejects(async () => action(), expected)
const physical = logical => path.join(root, ...logical.split('/'))
const file = 'task-runs/task/member/Reply.md'
const empty = 'state/member/task/Planner'
const binary = 'archives/task/output.bin'
const child = async code => new Promise((resolve, reject) => {
  const worker = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  worker.stderr.on('data', chunk => { stderr += chunk })
  worker.on('error', reject)
  worker.on('close', (code, signal) => resolve({ code, signal, stderr }))
})
const deadline = async action => {
  let timer
  try { return await Promise.race([action, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Independent file waited on another file.')), 5000) })]) }
  finally { clearTimeout(timer) }
}
try {
  // Missing reads, lists and deletes neither create the root nor invent records.
  check(await records.read(file), undefined)
  check(await records.readBytes(file), undefined)
  check(await records.list(), [])
  check(await records.listDirectory(), [])
  check(await records.delete(file), false)
  await rejects(() => fs.lstat(root), { code: 'ENOENT' })

  await records.replace(file, '既有事实\n')
  check(await fs.readFile(physical(file), 'utf8'), '既有事实\n')
  check(await records.read(file), '既有事实\n')
  await records.append(file, '补充🙂\n')
  check(await records.read(file), '既有事实\n补充🙂\n')
  const beforeAppend = await fs.stat(physical(file))
  await records.append(file, new Uint8Array([0x41, 0x0a]))
  const afterAppend = await fs.stat(physical(file))
  check([afterAppend.dev, afterAppend.ino], [beforeAppend.dev, beforeAppend.ino])
  check(await records.read(file), '既有事实\n补充🙂\nA\n')
  await records.replace(empty, '')
  check(await records.read(empty), '')
  check((await records.readBytes(empty)).byteLength, 0)
  await records.replace(binary, new Uint8Array([0, 0xff, 0x80, 0x0a]))
  check([...await records.readBytes(binary)], [0, 0xff, 0x80, 0x0a])
  await rejects(() => records.read(binary), TypeError)
  await records.replace('top.txt', 'x')
  await records.replace('Recorder Cache/任务/links.json', '{}\n')
  const all = await records.list()
  check(all.map(entry => entry.path), ['Recorder Cache/任务/links.json', binary, empty, file, 'top.txt'].sort())
  for (const entry of all) {
    const bytes = (await fs.readFile(physical(entry.path))).byteLength
    check(entry, { path: entry.path, bytes, empty: bytes === 0 })
  }
  check(await records.listDirectory(), [{ path: 'top.txt', bytes: 1, empty: false }])
  check(await records.listDirectory('state/member/task/'), [{ path: empty, bytes: 0, empty: true }])
  check(await records.listDirectory('task-runs'), [])
  check(await records.list('task-runs/'), [{ path: file, bytes: Buffer.byteLength('既有事实\n补充🙂\nA\n'), empty: false }])
  check(await records.listDirectoryNames('task-runs/task/member'), [file])
  check(await records.listDirectory('absent'), [])

  // Reads always see real files, including edits performed outside this instance.
  await fs.writeFile(physical(file), 'external edit')
  check(await records.read(file), 'external edit')
  await records.replace(file, '')
  await Promise.all(Array.from({ length: 80 }, (_, i) => (i % 2 ? records : second).append(file, `${i},`)))
  check((await records.read(file)).split(',').filter(Boolean).map(Number), Array.from({ length: 80 }, (_, i) => i))

  // Hold the actual rename. Same-file append waits; another file and reads do not.
  const rename = fs.rename
  let enter, unblock
  const entered = new Promise(resolve => { enter = resolve })
  const blocked = new Promise(resolve => { unblock = resolve })
  fs.rename = async (from, to) => {
    if (to === physical(file)) { enter(); await blocked }
    return rename(from, to)
  }
  let replacement, append
  try {
    const old = await records.read(file)
    replacement = records.replace(file, 'replacement')
    await entered
    const suffix = new Uint8Array([0x2b, 0x41])
    append = second.append(file, suffix)
    suffix[1] = 0x42 // The accepted write must not retain mutable caller storage.
    await deadline(records.replace('independent.txt', 'independent'))
    check(await records.read('independent.txt'), 'independent')
    check(await records.read(file), old)
    check((await records.list('task-runs')).map(entry => entry.path), [file])
  } finally {
    unblock()
    await Promise.all([replacement, append])
    fs.rename = rename
  }
  check(await records.read(file), 'replacement+A')

  // A failed publish leaves the previous target intact and does not poison its
  // next exact-file mutation. No unlink-target fallback is allowed.
  fs.rename = async (from, to) => {
    if (to === physical(file)) throw Object.assign(new Error('injected rename denied'), { code: 'EACCES' })
    return rename(from, to)
  }
  try { await rejects(() => records.replace(file, 'must not publish'), { code: 'EACCES' }) }
  finally { fs.rename = rename }
  check(await records.read(file), 'replacement+A')
  check((await fs.readdir(path.dirname(physical(file)))).filter(name => name.startsWith('.dss-write-')), [])
  await second.append(file, '+after failure')
  check(await records.read(file), 'replacement+A+after failure')

  // Fail during writing the temporary file, before rename can be reached.
  const open = fs.open
  fs.open = async (target, ...args) => {
    const handle = await open(target, ...args)
    if (path.basename(String(target)).startsWith('.dss-write-')) {
      handle.writeFile = async bytes => {
        await handle.write(bytes.subarray(0, 2))
        throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' })
      }
    }
    return handle
  }
  try { await rejects(() => records.replace(file, 'partial temporary bytes'), { code: 'ENOSPC' }) }
  finally { fs.open = open }
  check(await records.read(file), 'replacement+A+after failure')
  check((await fs.readdir(path.dirname(physical(file)))).filter(name => name.startsWith('.dss-write-')), [])

  // A stopped process before rename retains the old body; after rename the full
  // new body exists even if the caller never receives completion. Neither case
  // produces a durable receipt, recovery journal or fabricated acknowledgement.
  const beforeStop = await records.read(file)
  const stopBefore = await child(`
    import fs from 'node:fs/promises';
    const { LocalRecordFiles } = await import(${JSON.stringify(moduleURL)});
    fs.rename = async () => process.exit(31);
    await new LocalRecordFiles(${JSON.stringify(root)}).replace(${JSON.stringify(file)}, 'unpublished');
  `)
  check(stopBefore.code, 31)
  check(await records.read(file), beforeStop)
  const abandoned = (await fs.readdir(path.dirname(physical(file)))).filter(name => name.startsWith('.dss-write-'))
  check(abandoned.length, 1)
  check((await records.list('task-runs')).map(entry => entry.path), [file])
  check(await fs.readFile(path.join(path.dirname(physical(file)), abandoned[0]), 'utf8'), 'unpublished')
  const stopAfter = await child(`
    import fs from 'node:fs/promises';
    const { LocalRecordFiles } = await import(${JSON.stringify(moduleURL)});
    const rename = fs.rename;
    fs.rename = async (...args) => { await rename(...args); process.exit(32); };
    await new LocalRecordFiles(${JSON.stringify(root)}).replace(${JSON.stringify(file)}, 'published before stop');
  `)
  check(stopAfter.code, 32)
  check(await records.read(file), 'published before stop')
  check((await fs.readdir(path.dirname(physical(file)))).filter(name => name.startsWith('.dss-write-')), abandoned)

  // An ordinary reader owns its opened handle, not a content-version lock.
  // Simulate the exact interleaving of a replacement after open, before read.
  let changedDuringRead = false
  fs.open = async (target, ...args) => {
    const handle = await open(target, ...args)
    if (!changedDuringRead && target === physical(file)) {
      changedDuringRead = true
      const sibling = physical('read-interleave.txt')
      await fs.writeFile(sibling, 'replacement during read')
      await fs.rename(sibling, physical(file))
    }
    return handle
  }
  try { check(await records.read(file), 'published before stop') }
  finally { fs.open = open }
  check(await records.read(file), 'replacement during read')
  await records.replace(file, 'published before stop')

  // Data is never silently interpreted as an absent file on access failure.
  fs.open = async (target, ...args) => {
    if (target === physical(file)) throw Object.assign(new Error('injected read denied'), { code: 'EACCES' })
    return open(target, ...args)
  }
  try { await rejects(() => records.read(file), { code: 'EACCES' }) }
  finally { fs.open = open }
  for (const invalid of ['', '.', '..', '../outside', 'a/../b', '/absolute', 'a//b', 'a/', 'a\\b', 'a\0b', 'a\nb', 'a\rb', '.dss-write-00000000-0000-0000-0000-000000000000.tmp']) {
    await rejectsCall(() => records.replace(invalid, 'forbidden'), /relative file path/)
  }
  await rejects(() => records.list('../outside'), /relative file path/)
  await rejectsCall(() => new LocalRecordFiles('relative'), /absolute root/)
  check(localRecordPath('Recorder Cache/任务/普通记录.md'), 'Recorder Cache/任务/普通记录.md')
  check(localRecordPath('archive/constructor/__proto__.txt'), 'archive/constructor/__proto__.txt')
  // These are platform-specific filename-rule assertions, not Windows I/O.
  const windowsOnly = ['C:/x', 'a:stream', 'a?b', 'a*b', 'a<b', 'a>b', 'a|b', 'a"b', 'trailing.', 'trailing ', 'CON', 'con.txt', 'PRN.md', 'AUX', 'NUL', 'COM1.txt', 'lpt9', 'COM¹.md', 'CON .txt', 'LPT1  .md', 'CONIN$', 'CONOUT$.txt']
  for (const name of windowsOnly) {
    await rejectsCall(() => localRecordPath(name, 'win32'), /Windows filename/)
    check(localRecordPath(name, 'linux'), name)
  }
  if (process.platform === 'linux') {
    for (const name of ['a:stream', 'trailing.', 'trailing ', 'CON']) {
      await records.replace('native/' + name, 'valid native file')
      check(await records.read('native/' + name), 'valid native file')
    }
    check((await records.listDirectory('native')).map(entry => entry.path), ['native/CON', 'native/a:stream', 'native/trailing ', 'native/trailing.'])
  }
  check('importIfAbsent' in records, false)

  await fs.mkdir(physical('directory.txt'))
  await rejects(() => records.read('directory.txt'), /Not an ordinary Local record file/)
  await rejects(() => records.replace('directory.txt', 'no'), /Not an ordinary Local record file/)
  await rejects(() => records.append('directory.txt', 'no'), /Not an ordinary Local record file/)
  await rejects(() => records.delete('directory.txt'), /Not an ordinary Local record file/)
  await records.replace('parent-file', 'still a file')
  await rejects(() => records.replace('parent-file/child', 'no'), /Not an ordinary Local records directory/)
  check(await records.read('parent-file'), 'still a file')
  await rejects(() => records.list('parent-file'), /Not an ordinary Local records directory/)

  // Existing links are rejected by exact operations and never followed by lists.
  // Windows link/junction behavior still requires an actual Windows execution.
  if (process.platform !== 'win32') {
    const outside = path.join(sandbox, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'untouched')
    await fs.symlink(path.join(outside, 'secret.txt'), physical('linked-file'))
    await fs.symlink(outside, physical('linked-directory'))
    await fs.symlink(outside, path.join(sandbox, 'linked-root'))
    await rejects(() => records.read('linked-file'), /Not an ordinary Local record file/)
    await rejects(() => records.replace('linked-file', 'no'), /Not an ordinary Local record file/)
    await rejects(() => records.append('linked-file', 'no'), /Not an ordinary Local record file/)
    await rejects(() => records.delete('linked-file'), /Not an ordinary Local record file/)
    await rejects(() => records.read('linked-directory/secret.txt'), /Not an ordinary Local records directory/)
    await rejects(() => records.replace('linked-directory/new.txt', 'no'), /Not an ordinary Local records directory/)
    await rejects(() => records.list('linked-directory'), /Not an ordinary Local records directory/)
    await rejects(() => new LocalRecordFiles(path.join(sandbox, 'linked-root')).read('secret.txt'), /Not an ordinary Local records directory/)
    check((await records.list()).some(entry => entry.path.startsWith('linked-')), false)
    check(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'untouched')
    check(await fs.readdir(outside), ['secret.txt'])
  }
  check(await records.delete(empty), true)
  check(await records.delete(empty), false)
  check(await records.read(empty), undefined)
  await records.append('new-empty', '')
  check((await records.listDirectory()).find(entry => entry.path === 'new-empty'), { path: 'new-empty', bytes: 0, empty: true })
  check(await records.read(file), 'published before stop')
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  console.log(JSON.stringify({ result: 'PASS', assertions, runtime: process.version, platform: process.platform,
    sourceSha256: sha256(source), validationSha256: sha256(await fs.readFile(new URL(import.meta.url))),
    scope: 'Fresh scratch files, actual LocalRecordFiles operations, controlled failure/process interruption; not full typecheck or Windows user-device/end-to-end.' }, null, 2))
} finally {
  await fs.rm(sandbox, { recursive: true, force: true })
}
