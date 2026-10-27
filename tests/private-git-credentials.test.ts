import test from 'node:test'
import assert from 'node:assert/strict'
import { CoopCredentials } from '../src/experimental/private-git/credentials.js'
import { CoopSettingsSchema } from '../src/experimental/private-git/contracts.js'
import { GitHubClient, inspectPrivateRepo, GITHUB_CLI_SETUP_REQUIRED, GITHUB_CLI_ACCESS_REQUIRED } from '../src/experimental/private-git/github.js'

test('GitHub CLI is the only connection source and legacy source settings are discarded', async () => {
  const settings = CoopSettingsSchema.parse({ ownerRepo: 'example/private', credentialSource: 'auto', tokenRef: 'GITHUB_TOKEN' })
  assert.equal('credentialSource' in settings, false)
  assert.equal('tokenRef' in settings, false)
  let cliReads = 0
  const credentials = new CoopCredentials(async () => { cliReads++; return 'cli-fixture' })
  const client = new GitHubClient(() => credentials.resolve(), async (url, options) => {
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer cli-fixture')
    if (url.endsWith('/user')) return Response.json({ id: 1, login: 'owner' })
    return Response.json({ id: 77, full_name: 'example/private', default_branch: 'main', private: true, permissions: { pull: true, push: true } })
  })
  const connection = await client.session(session => inspectPrivateRepo(session, { ownerRepo: settings.ownerRepo }))
  assert.equal(connection.repository.permissions.push, true)
  assert.equal(cliReads, 1)
})

test('missing GitHub CLI or login returns setup instructions before sending a request', async () => {
  const credentials = new CoopCredentials(async () => undefined)
  let requests = 0
  const client = new GitHubClient(() => credentials.resolve(), async () => { requests++; return Response.json({}) })
  await assert.rejects(client.session(session => session.request('GET', '/user')), { message: GITHUB_CLI_SETUP_REQUIRED })
  assert.equal(requests, 0)
})

test('GitHub authorization failures include CLI configuration guidance and retain the actual HTTP error', async () => {
  for (const status of [401, 403, 404, 500]) {
    const client = new GitHubClient(async () => ({ value: 'cli-fixture', source: 'GitHub CLI' }), async () => Response.json({ message: 'Request failed' }, { status }))
    await assert.rejects(client.session(session => session.request('GET', '/repos/example/private')), error => {
      const message = String(error)
      return message.includes('GitHub ' + status) && message.includes(GITHUB_CLI_ACCESS_REQUIRED) === (status !== 500) && !message.includes('cli-fixture')
    })
  }
})
