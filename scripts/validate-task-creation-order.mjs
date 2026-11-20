import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceRoot, hooks } from './test-support/dsh-sdk-runtime.mjs'
import { Repository, put, head } from './test-support/controlled-git/repository.mjs'

const source = name => import(new URL('framework/' + name + '.ts', sourceRoot))
const { PhysicalLocalFiles } = await source('physical-local-files')
const { dispatchPhysicalChild } = await source('physical-task-dispatch')
const { preparePhysicalTask, initializeTask, dispatchPlannerObjective, paths, readJson, encodeJson } = await source('task-files')
const { readTaskReferenceIdentity, taskHistoryChange } = await source('task-history')
const { GitFiles, withSnapshot } = await source('transactions')
const { SessionGitOperations } = await source('git-authority')
const directory = await mkdtemp(join(tmpdir(), 'dss-created-order-'))
const originalNow = Date.now
const id = '10000000-0000-4000-8000-000000000001'
const localPath = 'tasks/local_O.md', gitPath = 'tasks/git_O.md'
const read = (files, taskId) => withSnapshot(files, s => readJson(files, s, paths.task(taskId)))
try {
  const files = new PhysicalLocalFiles(directory)
  await files.replace(localPath, 'Original Local plan')
  const prepare = store => withSnapshot(store, s => preparePhysicalTask(store, s, localPath, { taskId: id, owner: 'owner', members: ['owner'] }))
  Date.now = () => 101
  assert.equal((await prepare(files)).createdAt, 101)
  Date.now = () => 102
  const reopened = new PhysicalLocalFiles(directory)
  assert.equal((await prepare(reopened)).createdAt, 101, 'reopening and preparing again keeps admission time')
  const input = { taskId: id, commandId: 'dispatch-1', owner: 'owner', objectiveId: 'objective', member: 'owner', route: 'P', plan: 'Work', decision: 'Decision' }
  await dispatchPhysicalChild(reopened, input, () => {})
  const { taskId: child } = (await read(reopened, id)).children[0]
  assert.equal((await read(reopened, child)).createdAt, 102)
  Date.now = () => 103
  await dispatchPhysicalChild(reopened, input, () => {})
  const childTask = await read(reopened, child)
  assert.equal(childTask.createdAt, 102, 'physical child dispatch replay keeps its admission time')
  const history = taskHistoryChange({ ...childTask, status: 'complete' })
  await reopened.replace(history.path, history.content)
  await reopened.delete(paths.task(child))
  const historyStore = new PhysicalLocalFiles(directory)
  const historical = await withSnapshot(historyStore, s => readTaskReferenceIdentity(historyStore, s, child))
  assert.equal(historical.createdAt, 102, 'completed archived historical identity retains timestamp')
  assert.equal(historical.status, 'complete')

  const repo = new Repository(); put(repo, gitPath, 'Original Git plan'); head(repo)
  const git = new GitFiles(repo, new SessionGitOperations())
  const init = store => withSnapshot(store, async s => {
    const result = await initializeTask(store, s, gitPath, 'owner', ['owner'], id)
    if (result.changes.length) await store.commit(s, result.changes, 'Admit')
    return result.value
  })
  Date.now = () => 201
  const parent = await init(git)
  assert.equal(parent.createdAt, 201)
  Date.now = () => 202
  const freshGit = new GitFiles(repo, new SessionGitOperations())
  const commits = repo.calls.length
  assert.equal((await init(freshGit)).createdAt, 201)
  assert.equal(repo.calls.length, commits, 'Git reload does not add a write')
  const dispatch = (store, parent, text) => withSnapshot(store, async s =>
    store.commit(s, await dispatchPlannerObjective(store, s, parent, 'objective', 'owner', text), 'Dispatch'))
  await dispatch(freshGit, parent, 'Git child')
  const nextParent = await read(freshGit, id), gitChild = nextParent.children[0].taskId
  assert.equal(nextParent.createdAt, 201)
  assert.equal((await read(freshGit, gitChild)).createdAt, 202)
  Date.now = () => 203
  await dispatch(freshGit, nextParent, 'Git child supplement')
  const completed = { ...await read(freshGit, gitChild), status: 'complete' }
  assert.equal(completed.createdAt, 202)
  await withSnapshot(freshGit, s => freshGit.commit(s, [{ path: paths.task(gitChild), content: encodeJson(completed) }], 'Complete'))
  assert.equal((await read(new GitFiles(repo, new SessionGitOperations()), gitChild)).createdAt, 202)
  put(repo, 'tasks/import_O.md', 'Preserved earlier Task'); head(repo)
  const preserved = await withSnapshot(freshGit, s => initializeTask(freshGit, s, 'tasks/import_O.md', 'owner', ['owner'], undefined, undefined, 'preserved'))
  assert.equal(preserved.value.createdAt, undefined, 'imported continuation does not fabricate original creation time')
  console.log('PASS: physical Local and transactional Git parent/child admission; replay/reopen, historical projection and legacy no-fabrication. Git repository port is controlled.')
} finally {
  Date.now = originalNow
  hooks.deregister()
  await rm(directory, { recursive: true, force: true })
}
