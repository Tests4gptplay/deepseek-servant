import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { hooks as sdkHooks } from './test-support/dsh-sdk-runtime.mjs'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-multi-configure-'))
process.env.DSS_PO_NATIVE_ROOT = root
const hash = value => createHash('sha256').update(value).digest('hex')
const oldRoot = new URL('./test-support/historical-v44/conversation-producer/src/', import.meta.url)
const oldHashes = JSON.parse(readFileSync(new URL('./test-support/historical-v44/conversation-producer/SOURCE.json', import.meta.url))).files
const oldHooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(oldRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(oldRoot.href) && url.endsWith('.ts')) {
      const bytes = readFileSync(new URL(url)), name = 'src/' + url.slice(oldRoot.href.length)
      assert.equal(hash(bytes), oldHashes[name])
      return { format: 'module', source: stripTypeScriptTypes(bytes.toString(), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { LocalFiles: OldFiles } = await import(new URL('framework/local-files.ts', oldRoot))
const { FrameworkTransactions: OldTransactions } = await import(new URL('framework/command-transactions.ts', oldRoot))
const { FrameworkConversation: OldConversation } = await import(new URL('framework/conversation.ts', oldRoot))
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { localConversationUpgradeKey } = await import('../src/framework/local-upgrade-conversation.ts')
const { localUpgradeMappingKey } = await import('../src/framework/local-upgrade-mapping.ts')
const { fixture, trace, until } = await import('./helper-service-sdk.mjs')
let f
try {
  f = await fixture('finished', false, async dir => {
    const business = path.join(dir, 'business')
    await fs.mkdir(business, { recursive: true })
    const files = await OldFiles.open(business)
    try {
      const receipts = new LocalRecordFiles(path.join(dir, 'old-receipts'))
      const records = { get: async key => { const body = await receipts.read(hash(key) + '.json'); return body && JSON.parse(body) },
        set: (key, value) => receipts.replace(hash(key) + '.json', JSON.stringify(value)) }
      const conversation = new OldConversation(files, new OldTransactions(files, records, 'actual-v44'), { mode: 'local', collaborationId: 'po-native' })
      await conversation.send('old-input', { id: 'old-input', participantId: 'old-user', createdAt: '2026-11-07T00:00:00.000Z',
        role: 'user', recipient: 'ai', text: 'Old user text' })
    } finally { await files.close() }
  })
  const business = f.active.connection.files.directory
  const oldSql = await fs.readFile(path.join(business, 'dss-files.sqlite'))
  let agentId = await until('actual one-time Agent waiting', () => [...f.model.waiting.keys()].find(id => id.startsWith('dss-local-upgrade-')))
  let commandNumber = 0
  async function command(action, fields = {}) {
    await until('Agent waiting ' + action, () => f.model.waiting.has(agentId))
    const callId = 'complete-' + action + '-' + ++commandNumber
    f.model.command(agentId, { name: 'dss_upgrade_local_files', input: { action, ...fields }, callId })
    const row = await until('native result ' + action, () => trace.find(row => row.event === 'tool' && row.type === 'tool/result' && row.data?.message?.toolCallId === callId))
    assert.equal(row.data.message.isError, false)
    return JSON.parse(row.data.message.content.find(c => c.type === 'text').text)
  }
  const restored = await command('restore_conversation', { collaborationId: 'po-native' })
  assert.equal(restored.signals.published, 1)
  assert.deepEqual(restored.signals.pending, [])
  const materialized = await command('materialize')
  assert.equal(materialized.report.status, 'complete')
  const finished = await command('finish')
  assert.equal(finished.completed, true)
  await until('Agent ready to stop', () => f.model.waiting.has(agentId))
  f.model.command(agentId, 'idle')
  const owner = f.service.localUpgrades.get(business)
  await until('completed owner result', () => owner.result?.status === 'complete')
  assert.equal(owner.oldSourceFound, undefined, 'verified finish retires same-Service signal assessment duty')
  const originalGet = f.sdk.adapter.get.bind(f.sdk.adapter)
  let receipts = 0
  f.sdk.adapter.get = async (key, ...args) => {
    if (key === localConversationUpgradeKey(business, 'po-native')) receipts++
    return originalGet(key, ...args)
  }
  const settingsA = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'complete-switch-b', changedFields: ['collaborationId'],
    settings: { ...settingsA.settings, collaborationId: 'other-chat' } })
  const settingsB = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'complete-switch-a', changedFields: ['collaborationId'],
    settings: { ...settingsB.settings, collaborationId: 'po-native' } })
  assert.equal(receipts, 0, 'verified same-Service user does not read retired migration receipt on later activations')
  console.log('COMPLETE_SAME_SERVICE_RECEIPT_READS', receipts)
  await f.close(); f = await fixture('finished', true)
  assert.equal(f.service.localUpgrades.get(business).result?.status, 'complete')
  assert.equal(f.service.localUpgrades.get(business).oldSourceFound, undefined)
  const reopenedGet = f.sdk.adapter.get.bind(f.sdk.adapter)
  let coldReads = 0
  f.sdk.adapter.get = async (key, ...args) => {
    if (key === localConversationUpgradeKey(business, 'po-native')) coldReads++
    return reopenedGet(key, ...args)
  }
  const coldA = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'cold-complete-switch-b', changedFields: ['collaborationId'],
    settings: { ...coldA.settings, collaborationId: 'other-chat' } })
  const coldB = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'cold-complete-switch-a', changedFields: ['collaborationId'],
    settings: { ...coldB.settings, collaborationId: 'po-native' } })
  assert.equal(coldReads, 0, 'verified cold Service does not read retired migration receipt on later activations')
  assert.deepEqual(await fs.readFile(path.join(business, 'dss-files.sqlite')), oldSql)
  console.log('COMPLETE_COLD_RECEIPT_READS', coldReads)
} finally { await f?.close(); oldHooks.deregister(); sdkHooks.deregister(); await fs.rm(root, { recursive: true, force: true }) }
