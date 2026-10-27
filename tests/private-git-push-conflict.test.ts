import test from 'node:test'
import assert from 'node:assert/strict'
import { isPushConflict } from '../src/experimental/private-git/git-repository.js'
import { GitError } from '../src/experimental/private-git/vendor/git-runner.js'

test('Git push recognizes both stale-branch rejection forms without hiding access failures', () => {
  const conflict = (stderr: string) => isPushConflict(new GitError(stderr, 1, stderr))
  assert.ok(conflict(' ! [rejected] abc -> main (fetch first)'))
  assert.ok(conflict(' ! [rejected] abc -> main (non-fast-forward)'))
  assert.ok(conflict(" ! [remote rejected] abc -> main (cannot lock ref 'refs/heads/main': is at 35801cea but expected 898ea11f)"))
  assert.equal(conflict(' ! [remote rejected] abc -> main (protected branch hook declined)'), false)
  assert.equal(conflict('fatal: Authentication failed'), false)
  assert.equal(conflict("cannot lock ref 'refs/heads/main': Permission denied"), false)
})
