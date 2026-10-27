import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { CoopCredentials } from '../src/experimental/private-git/credentials.js'
import { GitHubClient, inspectPrivateRepo } from '../src/experimental/private-git/github.js'

test('explicit GitHub CLI selection connects when the saved credential cannot see the repository', async () => {
  let source: 'auto' | 'github-cli' = 'auto', nativeReads = 0, cliReads = 0
  const saved = 'saved-fixture', cli = 'cli-fixture'
  const credentials = new CoopCredentials({ get: () => ({ resolve: async () => { nativeReads++; return { value: saved, source: 'file' } } }) } as unknown as Context,
    () => 'GITHUB_TOKEN', async () => { cliReads++; return cli }, () => source)
  const client = new GitHubClient(() => credentials.resolve(), async (url, options) => {
    if (url.endsWith('/user')) return Response.json({ id: 1, login: 'owner' })
    if ((options?.headers as Record<string, string>).Authorization === 'Bearer ' + saved) return Response.json({ message: 'Not Found' }, { status: 404 })
    return Response.json({ id: 77, full_name: 'example/private', default_branch: 'main', private: true, permissions: { pull: true, push: true } })
  })
  const connect = () => client.session(session => inspectPrivateRepo(session, { ownerRepo: 'example/private' }))
  await assert.rejects(connect(), error => String(error).includes('GET /repos/example/private; authorization: file') && !String(error).includes(saved))
  assert.equal(cliReads, 0)
  source = 'github-cli'
  assert.equal((await connect()).repository.permissions.push, true)
  assert.equal(nativeReads, 1)
  assert.equal(cliReads, 1)
  assert.equal((await credentials.describe()).source, 'GitHub CLI')
  assert.equal(cliReads, 1, 'rendering credential information does not spawn a CLI process')
})

test('explicit CLI selection reports missing CLI login without replacing stored credentials', async () => {
  const credentials = new CoopCredentials({ get: () => { throw new Error('Stored credentials must stay untouched') } } as unknown as Context,
    () => 'GITHUB_TOKEN', async () => undefined, () => 'github-cli')
  assert.equal(await credentials.resolve(), undefined)
})
