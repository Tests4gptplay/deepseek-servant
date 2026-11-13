import assert from 'node:assert/strict'
import { hooks } from './test-support/dsh-sdk-runtime.mjs'
const { DshStorageAdapter } = await import('../src/adapters/dsh/storage.ts')
const originalGet = DshStorageAdapter.prototype.get
let conversationReceiptReads = 0
DshStorageAdapter.prototype.get = function (key) {
  if (key.startsWith('framework-upgrade-conversation/')) conversationReceiptReads++
  return originalGet.call(this, key)
}
const { fixture } = await import('./helper-service-sdk.mjs')
let f
try {
  f = await fixture('fresh-no-original')
  const owner = f.service.localUpgrades.get(f.active.connection.files.directory)
  assert.equal((await owner.work).status, 'not-needed')
  assert.equal(conversationReceiptReads, 0, 'fresh Host activation adds no conversation receipt lookup')
  const current = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'fresh-switch', changedFields: ['collaborationId'],
    settings: { ...current.settings, collaborationId: 'other-chat' } })
  assert.equal(conversationReceiptReads, 0, 'fresh scope switch adds no conversation receipt lookup')
  await f.close(); f = await fixture('fresh-no-original', true)
  const reopened = f.service.localUpgrades.get(f.active.connection.files.directory)
  assert.equal((await reopened.work).status, 'not-needed')
  assert.equal(conversationReceiptReads, 0, 'fresh cold restart adds no conversation receipt lookup')
  console.log('FRESH_NO_OLD_LOOKUPS', conversationReceiptReads)
} finally {
  await f?.close()
  DshStorageAdapter.prototype.get = originalGet
  hooks.deregister()
}
