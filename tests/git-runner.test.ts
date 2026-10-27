import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { runGit, GitError } from '../src/experimental/private-git/vendor/git-runner.js'

test('Git runner supplies a deadline and reports timeout as a failed operation', async t => {
  let options: any
  t.mock.method(childProcess, 'execFile', (...args: any[]) => {
    options = args[2]
    queueMicrotask(() => args[3](Object.assign(new Error('Terminated'), { killed: true, signal: 'SIGTERM' }), '', ''))
    return {} as any
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(runGit('git', ['fetch'], { cwd: process.cwd(), timeoutMs: 20 }),
    error => error instanceof GitError && error.code === 124 && /timed out/.test(error.message))
  assert.equal(options.timeout, 20)
})

test('Git runner still executes ordinary read-only commands', async () => {
  const result = await runGit('git', ['--version'], { cwd: process.cwd() })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /git version/)
})
