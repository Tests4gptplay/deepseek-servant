import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FrameworkManualCleanup, type ManualAllCleanupPreview, type ManualCleanupResult } from '../src/framework/manual-cleanup.js'
import { PhysicalLocalFiles } from '../src/framework/physical-local-files.js'

const completed = (revision = 'test'): ManualCleanupResult => ({
  cleared: true,
  receipt: { revision, replay: false },
  deletedPaths: [],
  preservedPaths: [],
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dss-manual-cleanup-test-'))
  const files = await PhysicalLocalFiles.open(root)
  const scope = { mode: 'local' as const, collaborationId: 'cleanup-regression' }
  const conversation = { scope }
  const cleanup = new FrameworkManualCleanup(files, {} as never, conversation as never, {} as never)
  return { root, files, cleanup, scope, close: async () => {
    await files.close()
    await rm(root, { recursive: true, force: true })
  } }
}

test('an interrupted archive intent never removes a recreated directory on resume', async () => {
  const { root, files, cleanup, close } = await fixture()
  const originalDelete = files.delete.bind(files)
  try {
    await mkdir(join(root, 'archives'))
    await writeFile(join(root, 'archives', 'old.txt'), 'old archive')
    const preview = await cleanup.previewFiles('archives')

    let interruptRetirement = true
    files.delete = async path => {
      if (interruptRetirement && path.startsWith('technical/manual-cleanup/intents/')) {
        interruptRetirement = false
        throw new Error('simulated interruption after directory removal')
      }
      return originalDelete(path)
    }
    await assert.rejects(
      cleanup.clearArchives('archive-replay', preview, 'clear-task-archives'),
      /simulated interruption/,
    )

    await mkdir(join(root, 'archives'))
    await writeFile(join(root, 'archives', 'new.txt'), 'new archive after the first removal')
    files.delete = originalDelete
    const resumed = await cleanup.resumePending()

    assert.equal(await readFile(join(root, 'archives', 'new.txt'), 'utf8'), 'new archive after the first removal')
    assert.equal(resumed.length, 1)
    assert.deepEqual(resumed[0]?.deletedPaths, [])
    assert.deepEqual(resumed[0]?.preservedPaths, ['archives/'])
  } finally {
    files.delete = originalDelete
    await close()
  }
})

test('clearAll runs conversation reset only after every preceding category succeeds', async () => {
  const { cleanup, scope, close } = await fixture()
  try {
    const calls: string[] = []
    let failHeartbeats = true
    ;(cleanup as any).clearTasks = async () => { calls.push('tasks'); return completed('tasks') }
    ;(cleanup as any).clearPlanning = async () => { calls.push('planning'); return completed('planning') }
    ;(cleanup as any).clearDebug = async () => { calls.push('debug'); return completed('debug') }
    ;(cleanup as any).clearArchives = async () => { calls.push('archives'); return completed('archives') }
    ;(cleanup as any).clearHeartbeats = async () => {
      calls.push('heartbeats')
      if (failHeartbeats) throw new Error('simulated heartbeat cleanup failure')
      return completed('heartbeats')
    }
    ;(cleanup as any).clearConversation = async () => { calls.push('conversation'); return completed('conversation') }

    const preview = {
      kind: 'all', scope: JSON.stringify(scope), tasks: {}, conversation: {}, planning: {}, debug: {},
      archives: { roots: [] }, heartbeats: { roots: [] },
    } as unknown as ManualAllCleanupPreview
    await assert.rejects(
      cleanup.clearAll('all-retry', preview, 'clear-all-records'),
      /simulated heartbeat cleanup failure/,
    )
    assert.deepEqual(calls, ['tasks', 'planning', 'debug', 'archives', 'heartbeats'])

    failHeartbeats = false
    await cleanup.clearAll('all-retry', preview, 'clear-all-records')
    assert.deepEqual(calls.slice(5), ['tasks', 'planning', 'debug', 'archives', 'heartbeats', 'conversation'])
    assert.equal(calls.filter(call => call === 'conversation').length, 1)
    assert.equal(calls.at(-1), 'conversation')
  } finally {
    await close()
  }
})
