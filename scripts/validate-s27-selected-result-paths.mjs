import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const sourceRoot = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true,
    }
    return next(url, context)
  },
})
try {
  const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
  const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
  const { SessionGitOperations } = await import('../src/framework/git-authority.ts')
  const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
  const { initializeTask, dispatchPlannerObjective, paths, readJson, encodeJson } = await import('../src/framework/task-files.ts')
  const { resolveChildResultReferences } = await import('../src/framework/recorder-retention.ts')
  const { taskReference } = await import('../src/framework/published-references.ts')
  const results = []
  for (const mode of ['local', 'git']) {
    const repo = mode === 'git' ? new Repository() : undefined
    const files = repo ? new GitFiles(repo, new SessionGitOperations()) : new PhysicalLocalFiles(await fs.mkdtemp(path.join(os.tmpdir(), 's27-dispatch-')))
    const write = async (p, value) => { if (repo) { put(repo, p, value); head(repo) } else await files.replace(p, value) }
    const apply = async changes => { for (const item of changes) await write(item.path, item.content === null ? undefined : item.bytes ?? item.content) }
    const read = id => withSnapshot(files, s => readJson(files, s, paths.task(id)))
    const resolve = (root, refs, narrow) => withSnapshot(files, s => resolveChildResultReferences(files, s, root, refs, false, narrow))
    try {
      const rootId = '10000000-0000-4000-8000-000000000001'
      await write('tasks/real_O.md', 'Task ID: ' + rootId + '\nActual O source')
      await apply((await withSnapshot(files, s => initializeTask(files, s, 'tasks/real_O.md', 'A', ['A', 'B'], rootId))).changes)
      await apply(await withSnapshot(files, async s => dispatchPlannerObjective(files, s, await read(rootId), 'branch', 'B', 'Actual O child', [], 'O')))
      let root = await read(rootId), branch = await read(root.children[0].taskId)
      await apply(await withSnapshot(files, async s => dispatchPlannerObjective(files, s, branch, 'leaf', 'B', 'Actual P leaf')))
      root = await read(rootId); branch = await read(branch.taskId)
      const leaf = await read(branch.children[0].taskId)
      await apply(await withSnapshot(files, async s => dispatchPlannerObjective(files, s, root, 'sibling', 'A', 'Actual P sibling')))
      root = await read(rootId)
      const sibling = await read(root.children[1].taskId)
      const leafFile = paths.run(leaf.taskId) + '/evidence.md'
      const leafDirectory = paths.run(leaf.taskId) + '/reports'
      const siblingFile = paths.run(sibling.taskId) + '/evidence.md'
      const leafMapped = paths.archive(leaf) + '/retained/evidence.md'
      const dirMapped = paths.archive(leaf) + '/retained/reports.md'
      const siblingMapped = paths.archive(sibling) + '/retained/evidence.md'
      await write(leafFile, 'source'); await write(leafDirectory + '/nested.md', 'directory source'); await write(siblingFile, 'sibling source')
      await write(leafMapped, 'retained'); await write(dirMapped, 'directory retained'); await write(siblingMapped, 'sibling retained')
      await write(paths.archive(leaf) + '/retention.json', encodeJson({ version: 1, relocatedReferences: { [leafFile]: leafMapped, [leafDirectory]: dirMapped } }))
      await write(paths.archive(sibling) + '/retention.json', encodeJson({ version: 1, relocatedReferences: { [siblingFile]: siblingMapped } }))
      const refs = [leafFile, leafDirectory, siblingFile, leafFile]
      const normal = await resolve(root, refs, false), narrow = await resolve(root, refs, true)
      assert.deepEqual(narrow, normal)
      assert.deepEqual(narrow, [leafMapped, dirMapped, siblingMapped, leafMapped])
      const mixed = [leaf.sourcePath, siblingFile]
      assert.deepEqual(await resolve(root, mixed, true), await resolve(root, mixed, false))
      const stableOriginal = [taskReference(leaf.taskId, leaf.sourcePath), siblingFile]
      await assert.rejects(resolve(root, stableOriginal, false), /outside this Task requirement chain/)
      await assert.rejects(resolve(root, stableOriginal, true), /outside this Task requirement chain/)
      const exactRoot = [paths.run(leaf.taskId)]
      assert.deepEqual(await resolve(root, exactRoot, true), await resolve(root, exactRoot, false))
      const foreignId = '90000000-0000-4000-8000-000000000001'
      const foreignPath = paths.run(foreignId) + '/foreign.md'
      await write(paths.task(foreignId), encodeJson({ version: 1, taskId: foreignId, route: 'P', owner: 'foreign', status: 'running', sourcePath: 'tasks/foreign_P.md' }))
      await write(foreignPath, 'foreign original')
      assert.deepEqual(await resolve(root, [foreignPath], true), await resolve(root, [foreignPath], false))
      assert.deepEqual(await resolve(root, [foreignPath], true), [foreignPath])
      // Controlled identity edges, not normal dispatch outputs: the existing
      // family deduplicates repeated child IDs and rejects self-parent identity.
      root.children.push({ ...root.children[0] })
      await write(paths.task(root.taskId), encodeJson(root))
      assert.deepEqual(await resolve(root, [leafFile], true), await resolve(root, [leafFile], false))
      root.children.pop()
      await write(paths.task(root.taskId), encodeJson(root))
      leaf.parent = { taskId: leaf.taskId, owner: leaf.owner, objectiveId: 'self' }
      await write(paths.task(leaf.taskId), encodeJson(leaf))
      await assert.rejects(resolve(root, [leafFile], false), /Task child association is missing or inconsistent/)
      await assert.rejects(resolve(root, [leafFile], true), /Task child association is missing or inconsistent/)
      results.push({ mode, builder: 'initializeTask + dispatchPlannerObjective', memberCount: 4,
        samePaths: narrow, mixedSourceFallback: true, stableOriginalRejectionPreserved: true,
        exactRootFallback: true, foreignTreeUnmapped: true, controlledIdentityEdges: true })
    } finally { if (!repo) await files.close() }
  }
  console.log(JSON.stringify({ passedModes: results.length, results,
    limits: 'Actual Git dispatch builder and Local FilesStore with the same builder-produced metadata shape; Local physical publication/Host is separately covered by terminal regression. Controlled Git repository, Linux local files, no live native or network.' }, null, 2))
} finally { hooks.deregister() }
