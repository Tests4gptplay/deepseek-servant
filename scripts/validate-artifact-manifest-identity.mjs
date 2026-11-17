import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual production methods and Linux files. Controlled ports are the native
// capability backed by a real source file, named I/O failures, and unused Git
// schema declarations imported through the shared store interface.
const sourceRoot = process.env.DSS_ARTIFACT_SOURCE_ROOT
  ? pathToFileURL(path.resolve(process.env.DSS_ARTIFACT_SOURCE_ROOT) + path.sep)
  : new URL('../src/', import.meta.url)
const loaded = new Map(), hash = value => createHash('sha256').update(value).digest('hex')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: 'data:text/javascript;base64,' + Buffer.from(
      'const z=new Proxy(function(){},{get(){return z},apply(){return z}});export {z}'
    ).toString('base64'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), hash(source))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts', sourceRoot))
const { FrameworkArtifacts } = await import(new URL('framework/artifacts.ts', sourceRoot))
const { retirePhysicalArtifact } = await import(new URL('framework/physical-artifact-publication.ts', sourceRoot))
const { paths, encodeJson } = await import(new URL('framework/task-files.ts', sourceRoot))
const { withSnapshot } = await import(new URL('framework/transactions.ts', sourceRoot))
const checks = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const rejects = async (name, action, expected) => { await assert.rejects(action, expected); checks.push(name) }
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-artifact-manifest-'))
const read = (files, name) => withSnapshot(files, snapshot => files.read(snapshot, name))
const manifestPath = destination => 'technical/artifacts/manifests/' + hash(destination) + '.json'
const work = (f, command) => paths.run(f.task.taskId) + '/.artifacts/' + hash(command)
const fact = async (f, command) => JSON.parse(await read(f.files, work(f, command) + '/publication.json'))

async function fixture(name, body = Buffer.from('accepted native original\0')) {
  const root = path.join(directory, name)
  await fs.mkdir(root, { recursive: true })
  const source = path.join(root, 'source.bin')
  await fs.writeFile(source, body)
  const files = new PhysicalLocalFiles(path.join(root, 'local'))
  // Production must not acquire a store-wide list for this exact-file command.
  files.list = files.listDirectory = files.listDirectoryNames = async () => { throw Error('Unexpected directory enumeration') }
  const task = { version: 1, taskId: '00000000-0000-4000-8000-' + hash(name).slice(0, 12),
    route: 'P', owner: 'A', members: ['A'], lifecycleId: 'first', status: 'running', sourcePath: 'tasks/' + name + '_P.md' }
  await files.replace(paths.task(task.taskId), encodeJson(task))
  const target = Object.freeze({ key: 'opaque-native-capability', toString() { throw Error('Capability converted to native path') } })
  const calls = { resolve: 0, stat: 0, read: 0 }
  const ctx = { fs: {
    async resolve(_source, options) { options.signal?.throwIfAborted(); calls.resolve++; return target },
    async stat(key) {
      assert.equal(key, target); calls.stat++
      const info = await fs.stat(source, { bigint: true })
      return { type: 'file', version: [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), size: Number(info.size) }
    },
    async readByteRange(key, { offset, length }, signal) {
      assert.equal(key, target); signal?.throwIfAborted(); calls.read++
      const handle = await fs.open(source, 'r')
      try { const bytes = Buffer.alloc(length), result = await handle.read(bytes, 0, length, offset); return bytes.subarray(0, result.bytesRead) }
      finally { await handle.close() }
    },
  } }
  const artifacts = new FrameworkArtifacts(ctx, files, { run() { throw Error('Unexpected generic transaction') } }, 'native cwd')
  const input = { taskId: task.taskId, sourcePath: 'source.bin', destinationPath: paths.archive(task) + '/original.bin' }
  const options = { taskOwner: { taskId: task.taskId, lifecycleId: task.lifecycleId, hostKey: 'host' } }
  return { files, task, source, body, calls, artifacts, input, options,
    run(command = 'exec:save', extra = {}) { return artifacts.preserve(command, input, { ...options, ...extra }) } }
}

async function existingFixture(name) {
  const f = await fixture(name), original = await f.run('exec:original')
  await retirePhysicalArtifact(f.files, f.task.taskId, 'exec:original')
  return { ...f, original, manifest: JSON.parse(await read(f.files, original.manifestPath)) }
}

try {
  if (process.argv.includes('--baseline-probe')) {
    const cases = []
    for (const [field, replacement] of [['bytes', -1], ['sha256', 'not-a-hash'], ['sha256', 'a'.repeat(64)]]) {
      const f = await existingFixture('baseline-' + cases.length)
      const manifest = { ...f.manifest, [field]: replacement }
      await f.files.replace(f.original.manifestPath, encodeJson(manifest))
      let preserveError, readError, result
      try { result = await f.run('exec:new') } catch (error) { preserveError = error.message }
      try { await f.artifacts.read(f.original.path) } catch (error) { readError = error.message }
      cases.push({ field, replacement, returnedSuccess: !!result, markedPublished: (await fact(f, 'exec:new')).published === true,
        preserveError, readError, originalPreserved: (await f.files.fingerprint(f.original.path)).sha256 === hash(f.body),
        conflictingManifestPreserved: await read(f.files, f.original.manifestPath) === encodeJson(manifest) })
    }
    console.log(JSON.stringify({ mode: 'baseline-probe', cases, sourceHashes: Object.fromEntries(loaded) }, null, 2))
  } else {
    for (const [field, replacement] of [['bytes', -1], ['bytes', 999], ['sha256', 'not-a-hash'], ['sha256', 'a'.repeat(64)]]) {
      const label = field + '-' + replacement, f = await existingFixture(label)
      const conflicting = encodeJson({ ...f.manifest, [field]: replacement })
      await f.files.replace(f.original.manifestPath, conflicting)
      await rejects('Existing target rejects conflicting accepted ' + label, () => f.run('exec:new'), /another or unknown artifact identity/)
      check('No published success recorded for ' + label, (await fact(f, 'exec:new')).published, undefined)
      check('No bytesPublished progress falsely recorded for ' + label, (await fact(f, 'exec:new')).bytesPublished, undefined)
      check('Existing artifact body preserved for ' + label, await f.files.fingerprint(f.original.path), { bytes: f.body.length, sha256: hash(f.body) })
      check('Existing manifest preserved for ' + label, await read(f.files, f.original.manifestPath), conflicting)
      check('Accepted staged original preserved for ' + label, await f.files.fingerprint(work(f, 'exec:new') + '/original.raw'), { bytes: f.body.length, sha256: hash(f.body) })
      await fs.rm(f.source)
      const calls = { ...f.calls }
      await f.files.replace(f.original.manifestPath, encodeJson(f.manifest))
      check('Exact retry completes after manifest restored for ' + label, await f.run('exec:new'), f.original)
      check('Exact retry does not reopen native source for ' + label, f.calls, calls)
    }

    for (const point of ['before-bytesPublished', 'after-bytesPublished']) {
      const f = await fixture(point), publicationPath = work(f, 'exec:save') + '/publication.json'
      const replace = f.files.replace.bind(f.files), create = f.files.createIfAbsent.bind(f.files)
      let interrupted = false
      if (point === 'before-bytesPublished') f.files.replace = async (name, content) => {
        if (!interrupted && name === publicationPath && JSON.parse(content).bytesPublished) { interrupted = true; throw Error('controlled progress write failure') }
        return replace(name, content)
      }
      else f.files.createIfAbsent = async (name, content) => {
        if (!interrupted && name === manifestPath(f.input.destinationPath)) { interrupted = true; throw Error('controlled manifest write failure') }
        return create(name, content)
      }
      await rejects('Actual publication interruption ' + point, () => f.run(), /controlled .* write failure/)
      const pending = await fact(f, 'exec:save'), original = pending.artifact
      check('Actual accepted phase ' + point, [pending.attempting, pending.bytesPublished, pending.published], [true, point === 'after-bytesPublished' ? true : undefined, undefined])
      const conflicting = encodeJson({ version: 1, taskId: f.task.taskId, ...original, sha256: 'f'.repeat(64) })
      await f.files.replace(original.manifestPath, conflicting)
      await fs.rm(f.source)
      const calls = { ...f.calls }
      await rejects('Retry rejects existing manifest ' + point, () => f.run(), /manifest belongs to another identity/)
      check('Retry remains unpublished ' + point, (await fact(f, 'exec:save')).published, undefined)
      check('Retry preserves manifest ' + point, await read(f.files, original.manifestPath), conflicting)
      check('Retry preserves already renamed body ' + point, await f.files.fingerprint(original.path), { bytes: original.bytes, sha256: original.sha256 })
      await f.files.replace(original.manifestPath, encodeJson({ version: 1, taskId: f.task.taskId, ...original }))
      check('Repaired exact retry returns original ' + point, await f.run(), original)
      check('Both retries never reopen deleted source ' + point, f.calls, calls)
    }

    const matching = await existingFixture('matching'), metadata = await read(matching.files, matching.original.manifestPath)
    check('Matching existing manifest succeeds for distinct command', await matching.run('exec:new'), matching.original)
    check('Matching existing manifest is not rewritten', await read(matching.files, matching.original.manifestPath), metadata)
    const zero = await fixture('zero-byte', Buffer.alloc(0)), zeroResult = await zero.run()
    check('New zero-byte publication succeeds', [zeroResult.bytes, zeroResult.sha256], [0, hash(Buffer.alloc(0))])
    check('Existing zero-byte manifest is accepted', await zero.run('exec:second'), zeroResult)

    const editable = await fixture('editable'), published = await editable.run(), calls = { ...editable.calls }
    await fs.rm(editable.source)
    await editable.files.replace(published.path, 'later user revision\0')
    check('Completed exact replay returns original result', await editable.run(), published)
    check('Completed replay does not reopen source', editable.calls, calls)
    const current = await editable.artifacts.read(published.path)
    check('Later user revision remains readable', Buffer.from(current.data).toString(), 'later user revision\0')
    check('Local download describes current revision', current.artifact.sha256, hash('later user revision\0'))
    check('Later revision does not rewrite original publication metadata', JSON.parse(await read(editable.files, published.manifestPath)).sha256, published.sha256)

    const pendingEdit = await fixture('pending-user-edit'), create = pendingEdit.files.createIfAbsent.bind(pendingEdit.files)
    let failed = false
    pendingEdit.files.createIfAbsent = async (name, content) => {
      if (!failed && name === manifestPath(pendingEdit.input.destinationPath)) { failed = true; throw Error('controlled manifest write failure') }
      return create(name, content)
    }
    await rejects('Interrupt before original manifest creation', () => pendingEdit.run(), /controlled manifest write failure/)
    await pendingEdit.files.replace(pendingEdit.input.destinationPath, 'user edit after byte publication')
    await fs.rm(pendingEdit.source)
    const resumed = await pendingEdit.run()
    check('Manifest completion does not hash-lock later file revision', Buffer.from((await pendingEdit.artifacts.read(resumed.path)).data).toString(), 'user edit after byte publication')
    console.log(JSON.stringify({ passed: checks.length, checks, sourceHashes: Object.fromEntries(loaded), limits: [
      'Actual production FrameworkArtifacts and PhysicalLocalFiles on Node/Linux; native ctx.fs is a controlled capability backed by a real source file.',
      'No installed DSH/Windows runtime acceptance, full TypeScript typecheck or esbuild bundle is claimed.',
    ] }, null, 2))
  }
} finally {
  await fs.rm(directory, { recursive: true, force: true })
  hooks.deregister()
}
