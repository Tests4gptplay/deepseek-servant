// Run the same capture checks against the unchanged baseline or isolated candidate.
// This exercises production FrameworkArtifacts.capture and the pinned real fs-local
// backend. The controlled capability cases supply FsInfo with/without optional size.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const root = path.resolve(process.env.DSS_CAPTURE_SOURCE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)))
const sdk = path.resolve(process.env.DSS_SDK_HOST_ROOT ?? '')
if (!path.isAbsolute(sdk) || !existsSync(path.join(sdk, 'node_modules')))
  throw new Error('DSS_SDK_HOST_ROOT must name the pinned SDK Host directory.')
const sourceRoot = pathToFileURL(path.join(root, 'src') + path.sep).href
const testRoot = pathToFileURL(path.join(root, 'scripts') + path.sep).href
const sdkParent = pathToFileURL(path.join(sdk, '__artifact_probe__.mjs')).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('.') && !path.isAbsolute(specifier) && !specifier.includes(':')) {
      const fromSource = context.parentURL?.startsWith(sourceRoot) || context.parentURL?.startsWith(testRoot)
      return next(specifier, fromSource ? { ...context, parentURL: sdkParent } : context)
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts'))
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    return next(url, context)
  },
})

const optimized = process.env.DSS_CAPTURE_EXPECT_OPTIMIZED !== '0'
const WINDOW = 1024 * 1024
const rows = []
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-artifact-size-window-'))
try {
  const [{ FrameworkArtifacts }, { Context }, { LocalFileSystem }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'src/framework/artifacts.ts')).href),
    import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-fs-local'),
  ])
  const native = new LocalFileSystem(new Context(), { cwd: tmp, diffBasisMaxBytes: WINDOW })
  const capture = (source, capability, signal) => new FrameworkArtifacts({ fs: capability }, {}, {}, tmp).capture(source, tmp, signal)
  const record = (name, calls, data) => rows.push({ name, reads: calls.read.length, offsets: calls.read.map(x => x.offset), lengths: calls.read.map(x => x.length), stats: calls.stat, bytes: data?.byteLength })

  for (const [name, size] of [['empty', 0], ['one-byte', 1], ['exact-window', WINDOW], ['cross-window', 2 * WINDOW + 7]]) {
    const filename = path.join(tmp, name + '.bin'), body = Buffer.alloc(size, 0x53)
    await fs.writeFile(filename, body)
    const calls = { stat: 0, read: [] }
    const capability = {
      resolve: (...args) => native.resolve(...args),
      stat: async (...args) => { calls.stat++; return native.stat(...args) },
      readByteRange: async (target, range, signal) => { calls.read.push(range); return native.readByteRange(target, range, signal) },
    }
    const data = await capture(filename, capability)
    assert.equal(hash(data), hash(body), name + ' bytes')
    assert.equal(calls.stat, 2, name + ' before/after stat')
    assert.equal(calls.read.length, optimized ? Math.max(1, Math.ceil(size / WINDOW)) : Math.ceil(size / WINDOW) + 1, name + ' read count')
    assert(calls.read.every(x => x.length === WINDOW), name + ' fixed transfer window')
    record('actual-fs-local/' + name, calls, data)
  }

  // Real permission boundary: stat(2) can identify an empty regular file while
  // opening its bytes is forbidden. This must not publish a fabricated readable
  // empty artifact merely because the metadata size was zero.
  if (process.platform === 'linux' && process.getuid?.() !== 0) {
    const filename = path.join(tmp, 'empty-unreadable.bin')
    await fs.writeFile(filename, Buffer.alloc(0))
    await fs.chmod(filename, 0o000)
    try {
      const target = await native.resolve(filename), info = await native.stat(target)
      assert.equal(info?.type, 'file')
      assert.equal(info.size, 0)
      await assert.rejects(native.readByteRange(target, { offset: 0, length: WINDOW }), { code: 'EACCES' })
      const calls = { stat: 0, read: [] }
      const capability = {
        resolve: (...args) => native.resolve(...args),
        stat: async (...args) => { calls.stat++; return native.stat(...args) },
        readByteRange: async (t, range, signal) => { calls.read.push(range); return native.readByteRange(t, range, signal) },
      }
      await assert.rejects(capture(filename, capability), { code: 'EACCES' })
      record('actual-fs-local/empty-unreadable-rejected', calls)
    } finally { await fs.chmod(filename, 0o600) }
  }

  // FsInfo.size is optional for a conforming backend. The old EOF loop stays.
  for (const size of [0, WINDOW, WINDOW + 7]) {
    const body = Buffer.alloc(size, 0x71), calls = { stat: 0, read: [] }
    const capability = {
      resolve: async () => ({ targetKey: 'opaque:optional', displayPath: 'optional' }),
      stat: async () => { calls.stat++; return { type: 'file', version: 'fixed' } },
      readByteRange: async (_target, range) => { calls.read.push(range); return body.subarray(range.offset, range.offset + range.length) },
    }
    const data = await capture('optional', capability)
    assert.equal(hash(data), hash(body))
    assert.equal(calls.read.length, Math.ceil(size / WINDOW) + 1, 'optional size retains EOF read')
    assert.equal(calls.stat, 2)
    record('optional-size/' + size, calls, data)
  }

  console.log(JSON.stringify({ scope: 'production capture; actual pinned fs-local and controlled FsInfo cases; no Git transaction or timing claim', root, optimized, rows }, null, 2))
} finally {
  hooks.deregister()
  await fs.rm(tmp, { recursive: true, force: true })
}
