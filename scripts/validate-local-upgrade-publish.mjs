import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import fixtureKoffi from './helpers/fixture-no-replace-koffi.mjs'
const url = new URL('../src/framework/local-upgrade-publish.ts', import.meta.url)
const hooks = registerHooks({ load(target, context, next) {
  if (target === url.href) return { format: 'module', source: stripTypeScriptTypes(readFileSync(url, 'utf8'), { mode: 'transform' }), shortCircuit: true }
  return next(target, context)
} })
const { bindUpgradePublish } = await import(url.href)
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (work, expected) => { await assert.rejects(work, expected); assertions++ }
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-publish-native-'))
try {
  const names = [], calls = []; let moved = 1, errno = 0
  const win = bindUpgradePublish({ load(name) {
    check(name, 'kernel32.dll')
    return { func(...spec) { names.push(spec); return spec[1] === 'GetLastError' ? () => errno : (...args) => { calls.push(args); return moved } } }
  }, errno: () => { throw Error('Windows must use immediate GetLastError') } }, 'win32')
  check(names, [['__stdcall','MoveFileExW','int',['str16','str16','uint32_t']],['__stdcall','GetLastError','uint32_t',[]]])
  check(await win('E:\\records\\.stage', 'E:\\records\\record.md'), 'published')
  check(calls[0], ['\\\\?\\E:\\records\\.stage','\\\\?\\E:\\records\\record.md',8])
  moved = 0
  for (const code of [80, 183]) { errno = code; check(await win('E:\\records\\.stage', 'E:\\records\\record.md'), 'exists') }
  errno = 5; await rejects(() => win('E:\\records\\.stage', 'E:\\records\\record.md'), { code: 'EACCES', win32Code: 5 })
  errno = 17; await rejects(() => win('E:\\records\\.stage', 'F:\\records\\record.md'), { code: 'EXDEV', win32Code: 17 })
  check(calls.every(call => call[2] === 8), true)
  await rejects(() => win('relative', 'E:\\target'), /absolute/)
  await rejects(() => win('E:\\bad\0file', 'E:\\target'), /absolute/)
  // macOS signature/errno contract is executable on any test host. This is not
  // a native macOS test; the real filesystem suite below selects native Koffi
  // only when this same script is actually run on Darwin.
  const darwinLoads = [], darwinSpecs = [], darwinCalls = []
  let darwinResult = 0, darwinErrno = 0, darwinErrorReads = 0
  const darwin = bindUpgradePublish({ load(name) {
    darwinLoads.push(name)
    return { func(...spec) { darwinSpecs.push(spec); return (...args) => { darwinCalls.push(args); return darwinResult } } }
  }, errno() { darwinErrorReads++; return darwinErrno } }, 'darwin')
  check(darwinLoads, ['/usr/lib/libSystem.B.dylib'])
  check(darwinSpecs, [['renamex_np', 'int', ['str', 'str', 'uint']]])
  check(await darwin('/same-volume/.stage', '/same-volume/result.md'), 'published')
  check(darwinCalls[0], ['/same-volume/.stage', '/same-volume/result.md', 4])
  check(darwinErrorReads, 0)
  darwinResult = -1; darwinErrno = 17
  check(await darwin('/same-volume/.stage', '/same-volume/result.md'), 'exists')
  check(darwinErrorReads, 1)
  for (const value of [13, 18, 45]) {
    darwinErrno = value
    // Node translates errno using its native OS table, so foreign-host contract
    // fixtures assert the raw Darwin errno, not a Linux-rendered error name.
    await rejects(() => darwin('/same-volume/.stage', '/same-volume/result.md'), error => error.errno === value && error.message.startsWith('renamex_np'))
  }
  const beforeInvalid = darwinCalls.length
  await rejects(() => darwin('relative', '/target'), /absolute/)
  await rejects(() => darwin('/bad\0path', '/target'), /absolute/)
  check(darwinCalls.length, beforeInvalid)
  check(darwinCalls.every(call => call[2] === 4), true)
  check(darwinErrorReads, 4)
  check(darwinLoads.length, 1)
  const nativeKoffi = process.platform === 'darwin' ? await import('koffi') : undefined
  const publication = bindUpgradePublish(nativeKoffi ? (nativeKoffi.default ?? nativeKoffi) : fixtureKoffi,
    nativeKoffi ? 'darwin' : 'linux')
  const source = path.join(root, 'source'), target = path.join(root, 'target')
  await fs.writeFile(source, Buffer.from([0,255,10])); await fs.writeFile(target, 'user-owned')
  check(await publication(source, target), 'exists'); check(String(await fs.readFile(target)), 'user-owned'); check([...await fs.readFile(source)], [0,255,10])
  await fs.rename(target, path.join(root, 'user-preserved'))
  check(await publication(source, target), 'published'); check([...await fs.readFile(target)], [0,255,10]); await rejects(() => fs.stat(source), { code: 'ENOENT' })
  await fs.writeFile(source, ''); const empty = path.join(root, 'empty')
  check(await publication(source, empty), 'published'); check((await fs.stat(empty)).size, 0)
  const link = path.join(root, 'link'); await fs.symlink(target, link); await fs.writeFile(source, 'new')
  check(await publication(source, link), 'exists'); check((await fs.lstat(link)).isSymbolicLink(), true); check([...await fs.readFile(target)], [0,255,10])
  await rejects(() => publication(path.join(root, 'missing'), path.join(root, 'new')), { code: 'ENOENT' })
  await rejects(() => publication(source, path.join(root, 'missing-parent', 'target')), { code: 'ENOENT' })
  check(await fs.readFile(source, 'utf8'), 'new')
  console.log(JSON.stringify({ status: 'passed', assertions, platform: process.platform,
    coverage: [nativeKoffi ? 'actual-macos-koffi-renamex_np-no-replace' : 'actual-linux-renameat2-no-replace', 'existing-file-and-symlink-never-overwritten', 'source-preserved-on-conflict', 'binary-and-empty-complete-move', 'Windows-binding-and-flags-contract', 'Win32-immediate-error-and-no-copy-fallback', 'Darwin-binding-and-immediate-errno-contract', 'Darwin-EEXIST-EXDEV-ENOTSUP-no-fallback', 'missing-target-parent-preserves-source'],
    limits: nativeKoffi ? 'Actual macOS Koffi/syscall and disposable filesystem only, not native DSH, power-loss durability or every filesystem. Windows calls remain contract fixtures.' : 'Windows and Darwin calls are binding-contract fixtures. Actual Linux syscall uses Python ctypes test bridge. Native Koffi/macOS/Windows and DSH were not run.' }, null, 2))
} finally { hooks.deregister(); await fs.rm(root, { recursive: true, force: true }) }
