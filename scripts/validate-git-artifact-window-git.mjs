// Actual production FrameworkArtifacts.preserve -> FrameworkTransactions ->
// GitFiles -> RemoteGitRepository, backed by local Git objects/update-ref CAS.
// The transport and credential lookup are controlled; no remote Git server.
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
process.env.DSS_AUDIT_SOURCE_ROOT = root
const sourceRoot = pathToFileURL(path.join(root, 'src') + path.sep).href
const testRoot = pathToFileURL(path.join(root, 'scripts') + path.sep).href
const sdkParent = pathToFileURL(path.join(sdk, '__artifact_git_probe__.mjs')).href
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
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-artifact-window-git-'))
let g, transactions
try {
  const [{ FrameworkArtifacts }, { FrameworkTransactions }, { GitAuthorityStore }, { withSnapshot }, { initializeTask, paths }, { Context }, { LocalFileSystem }, { gitFixture }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'src/framework/artifacts.ts')).href),
    import(pathToFileURL(path.join(root, 'src/framework/command-transactions.ts')).href),
    import(pathToFileURL(path.join(root, 'src/framework/git-authority.ts')).href),
    import(pathToFileURL(path.join(root, 'src/framework/transactions.ts')).href),
    import(pathToFileURL(path.join(root, 'src/framework/task-files.ts')).href),
    import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-fs-local'),
    import(pathToFileURL(path.join(root, 'scripts/test-support/helper-consume-git-fixture.mjs')).href),
  ])
  let injectOnPush = false, injected = false
  g = gitFixture(path.join(tmp, 'repo.git'), 'sha1', async command => {
    if (command.op !== 'push' || !injectOnPush || injected) return
    injected = true
    // A real Git ref advances just before the artifact's first exact-CAS push.
    // It leaves all business file dependencies unchanged, so the same command
    // may retry without recapturing its native source.
    const parent = g.git(['rev-parse', 'refs/heads/main']).toString().trim()
    const tree = g.git(['rev-parse', parent + '^{tree}']).toString().trim()
    const peer = g.git(['commit-tree', tree, '-p', parent], Buffer.from('Concurrent unrelated ref advance\n')).toString().trim()
    g.git(['update-ref', 'refs/heads/main', peer, parent])
  })
  const native = new LocalFileSystem(new Context(), { cwd: tmp, diffBasisMaxBytes: WINDOW })
  const source = path.join(tmp, 'original.bin'), body = Buffer.alloc(WINDOW, 0x58)
  await fs.writeFile(source, body)
  const taskId = '10000000-0000-4000-8000-000000000311'
  const taskSource = 'tasks/artifact-window_P.md'
  await withSnapshot(g.files, snapshot => g.files.commit(snapshot, [{ path: taskSource, content: 'Preserve the original binary artifact.' }], 'Create Task source'))
  const initialized = await withSnapshot(g.files, snapshot => initializeTask(g.files, snapshot, taskSource, 'A', ['A'], taskId))
  await withSnapshot(g.files, snapshot => g.files.commit(snapshot, initialized.changes, 'Initialize Task'))
  const task = initialized.value
  transactions = new FrameworkTransactions(g.files, new GitAuthorityStore(g.files, 'artifact-window-git'), 'artifact-window-git')
  const reads = [], stats = []
  const capability = {
    resolve: (...args) => native.resolve(...args),
    stat: async (...args) => { stats.push(1); return native.stat(...args) },
    readByteRange: async (target, range, signal) => { reads.push(range); return native.readByteRange(target, range, signal) },
  }
  const artifacts = new FrameworkArtifacts({ fs: capability }, g.files, transactions, tmp)
  const commandId = 'artifact-window-command', input = { taskId, sourcePath: source, destinationPath: paths.archive(task) + '/original.bin' }
  const pushesBeforeArtifact = g.events.filter(row => row.op === 'push').length
  injectOnPush = true
  const result = await artifacts.preserve(commandId, input, { cwd: tmp })
  injectOnPush = false
  assert.equal(injected, true, 'first artifact push faced a real Git CAS ref advance')
  const artifactPushAttempts = g.events.filter(row => row.op === 'push').length - pushesBeforeArtifact
  assert.equal(artifactPushAttempts, 2, 'same artifact command retried after one real CAS rejection')
  assert.equal(result.bytes, body.length)
  assert.equal(result.sha256, sha256(body))
  const actual = g.git(['show', 'refs/heads/main:dss-coop/' + result.path])
  assert.deepEqual(actual, body, 'real Git blob equals original bytes')
  const manifest = JSON.parse(g.git(['show', 'refs/heads/main:dss-coop/' + result.manifestPath]))
  assert.equal(manifest.taskId, taskId)
  for (const key of ['path', 'manifestPath', 'name', 'sha256', 'bytes']) assert.deepEqual(manifest[key], result[key], 'manifest ' + key)
  const receiptPath = 'technical/artifacts/commands/' + sha256(commandId) + '.json'
  const receipt = JSON.parse(g.git(['show', 'refs/heads/main:dss-coop/' + receiptPath]))
  assert.deepEqual(receipt.artifact, result)
  const transactionReceiptPath = 'technical/command-receipts/' + sha256(commandId) + '.json'
  const transactionReceipt = JSON.parse(g.git(['show', 'refs/heads/main:dss-coop/' + transactionReceiptPath]))
  assert.equal(transactionReceipt.id, commandId)
  const commit = g.git(['rev-parse', 'refs/heads/main']).toString().trim()
  const published = g.git(['diff-tree', '--no-commit-id', '-r', '--name-only', commit]).toString().trim().split('\n')
  for (const item of [result.path, result.manifestPath, receiptPath, transactionReceiptPath]) assert(published.includes('dss-coop/' + item), 'atomic artifact commit contains ' + item)
  assert.equal(reads.length, optimized ? 1 : 2, 'exact-window native read count through Git import')
  assert.equal(stats.length, 2, 'first and final source stat on original capture')
  const pushesBeforeReplay = g.events.filter(row => row.op === 'push').length
  const replay = await artifacts.preserve(commandId, input, { cwd: tmp })
  assert.deepEqual(replay, result)
  assert.equal(reads.length, optimized ? 1 : 2, 'same command replay never rereads source')
  assert.equal(g.events.filter(row => row.op === 'push').length, pushesBeforeReplay, 'same command replay does not republish')
  console.log(JSON.stringify({ scope: 'real local Git object/CAS with controlled transport/credentials; production GitFiles, transaction and artifact import',
    root, optimized, taskId, commandId, sourceBytes: body.length, sourceSha256: sha256(body), capturedReadOffsets: reads.map(row => row.offset),
    capturedReadLengths: reads.map(row => row.length), sourceStats: stats.length, artifactPushAttempts,
    committedHead: commit, artifact: result, receiptPath, transactionReceiptPath, sameCommitPaths: published, replayNoRead: true, replayNoPush: true }, null, 2))
} finally {
  if (transactions) await transactions.closeGitSession(new Error('Fixture complete'))
  if (g) await g.repo.releaseCache()
  hooks.deregister()
  await fs.rm(tmp, { recursive: true, force: true })
}
