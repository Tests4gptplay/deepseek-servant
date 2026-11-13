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
  f = await fixture('switch', false, async dir => {
    const business = path.join(dir, 'business')
    await fs.mkdir(business, { recursive: true })
    const files = await OldFiles.open(business)
    try {
      const receipts = new LocalRecordFiles(path.join(dir, 'old-receipts'))
      const records = { get: async key => { const body = await receipts.read(hash(key) + '.json'); return body && JSON.parse(body) },
        set: (key, value) => receipts.replace(hash(key) + '.json', JSON.stringify(value)) }
      for (const [scope, id, time] of [['po-native', 'a-input', '00:00'], ['other-chat', 'b-input', '00:01']]) {
        const conversation = new OldConversation(files, new OldTransactions(files, records, 'actual-v44'), { mode: 'local', collaborationId: scope })
        await conversation.send(id, { id, participantId: 'old-user', createdAt: '2026-11-07T' + time + ':00.000Z',
          role: 'user', recipient: 'ai', text: 'Old ' + scope + ' user text' })
      }
    } finally { await files.close() }
    await fs.mkdir(path.join(business, 'personal'), { recursive: true })
    await fs.writeFile(path.join(business, 'personal', 'keep.txt'), 'Unrelated current user file\n')
  })
  const agentId = await until('real one-time Agent model waiting', () => [...f.model.waiting.keys()].find(id => id.startsWith('dss-local-upgrade-')))
  async function call(scope, callId) {
    f.model.command(agentId, { name: 'dss_upgrade_local_files', input: { action: 'restore_conversation', collaborationId: scope }, callId })
    const row = await until(callId + ' tool result', () => trace.find(row => row.event === 'tool' && row.type === 'tool/result' && row.data?.message?.toolCallId === callId))
    assert.equal(row.data.message.isError, false)
    return JSON.parse(row.data.message.content.find(c => c.type === 'text').text)
  }
  const a = await call('po-native', 'restore-a')
  assert.equal(a.signals.published, 1)
  const oldAPath = 'state/Foreground_old-user-GMT0-20261107-000000000'
  const directory = f.active.connection.files.directory
  const mapping = await f.sdk.adapter.get(localUpgradeMappingKey(directory, oldAPath))
  assert.equal(mapping?.sourcePath, oldAPath)
  assert.equal(mapping?.targets?.length, 1)
  const aPath = mapping.targets[0]
  assert.notEqual(aPath, oldAPath, 'scoped physical target differs from retained SQL source')
  assert(await f.active.connection.files.fileInfo(aPath), 'scoped A notification has not been claimed before switch')
  const oldSql = await fs.readFile(path.join(directory, 'dss-files.sqlite'))
  const userFile = await fs.readFile(path.join(directory, 'personal', 'keep.txt'))
  const aState = await f.sdk.adapter.get(localConversationUpgradeKey(directory, 'po-native'))
  assert.deepEqual(aState.signalsAssessed, { version: 1, pending: [] })
  const current = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'switch-to-b', changedFields: ['collaborationId'],
    settings: { ...current.settings, collaborationId: 'other-chat' } })
  const activeB = f.service.running.get('local')
  assert.equal(activeB.runtime.config.collaborationId, 'other-chat')
  const after = await activeB.connection.files.fileInfo(aPath)
  assert(after, 'scoped A notification remains stored after switch to B')
  await Promise.all(await activeB.runtime.loop.runSignalPoll())
  await activeB.runtime.runQueue()
  assert(await activeB.connection.files.fileInfo(aPath), 'B Host must not consume scoped A signal')
  assert.equal(trace.some(row => row.event === 'tool' && row.type === 'tool/result' && row.data?.message?.content?.some(c => c.type === 'text'
    && c.text.includes(aPath) && c.text.includes('"other-chat"'))), false, 'B native claim must not mention A target')
  const access = await f.service.access('local')
  assert.equal(await access.conversation.read('a-input'), undefined, 'B conversation cannot read A original by ID')
  assert.equal((await access.conversation.read('b-input'))?.text, 'Old other-chat user text')
  const bSettings = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'switch-back-a', changedFields: ['collaborationId'],
    settings: { ...bSettings.settings, collaborationId: 'po-native' } })
  const activeA = f.service.running.get('local')
  assert.equal(activeA.runtime.config.collaborationId, 'po-native')
  await Promise.all(await activeA.runtime.loop.runSignalPoll())
  await activeA.runtime.runQueue()
  await until('actual A Host claims its retained scoped notice', async () => !(await activeA.connection.files.fileInfo(aPath)))
  const original = await f.service.access('local')
  assert.equal((await original.conversation.read('a-input'))?.text, 'Old po-native user text')
  assert.deepEqual(await fs.readFile(path.join(directory, 'dss-files.sqlite')), oldSql)
  assert.deepEqual(await fs.readFile(path.join(directory, 'personal', 'keep.txt')), userFile)
  console.log('A_RESULT', JSON.stringify(a.signals))
  console.log('A_SCOPED_TARGET', aPath)
  console.log('B_DID_NOT_CLAIM_A', true)
  console.log('A_CLAIMED_AFTER_RETURN', true)
  const owner = f.service.localUpgrades.get(directory)
  await until('A complete signal assessment cached after return', () => owner.assessedSignals.has('po-native'))
  const actualGet = f.sdk.adapter.get.bind(f.sdk.adapter)
  let aReceiptReads = 0
  f.sdk.adapter.get = async (key, ...args) => {
    if (key === localConversationUpgradeKey(directory, 'po-native')) aReceiptReads++
    return actualGet(key, ...args)
  }
  const againA = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'cache-switch-b', changedFields: ['collaborationId'],
    settings: { ...againA.settings, collaborationId: 'other-chat' } })
  const againB = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'cache-switch-a', changedFields: ['collaborationId'],
    settings: { ...againB.settings, collaborationId: 'po-native' } })
  assert.equal(aReceiptReads, 0, 'complete A scope does not reread the migration receipt on subsequent same-instance activation')
  console.log('A_COMPLETE_REPEAT_RECEIPT_READS', aReceiptReads)
  await f.close(); f = await fixture('switch', true)
  assert.equal(f.service.running.get('local').runtime.config.collaborationId, 'po-native')
  assert.equal(await f.active.connection.files.fileInfo(aPath), undefined, 'cold restart did not republish consumed scoped signal')
  console.log('A_COLD_RESTART_NO_REPUBLISH', true)
} finally {
  await f?.close()
  oldHooks.deregister(); sdkHooks.deregister()
  await fs.rm(root, { recursive: true, force: true })
}
