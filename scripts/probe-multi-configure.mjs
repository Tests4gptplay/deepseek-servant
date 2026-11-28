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
const { scopedLocalForegroundSourceNotification } = await import('../src/framework/conversation.ts')
const { fixture, trace, until } = await import('./helper-service-sdk.mjs')
const restartBeforeSwitch = process.argv.includes('--restart-before-switch')
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
  await until('Agent ready for B', () => f.model.waiting.has(agentId))
  const b = await call('other-chat', 'restore-b')
  assert.equal(b.signals.published, 0)
  assert.equal(b.signals.pending.length, 1)
  assert.equal(f.service.localUpgrades.get(f.active.connection.files.directory).assessedSignals.has('other-chat'), false,
    'wrong-bound B is not cached as complete')
  const oldBPath = 'state/Foreground_old-user-GMT0-20261107-000100000'
  const bPath = scopedLocalForegroundSourceNotification(oldBPath, 'other-chat')
  assert.equal(await f.active.connection.files.fileInfo(bPath), undefined)
  const directory = f.active.connection.files.directory
  const oldSql = await fs.readFile(path.join(directory, 'dss-files.sqlite'))
  const aState = await f.sdk.adapter.get(localConversationUpgradeKey(directory, 'po-native'))
  assert.deepEqual(aState.signalsAssessed, { version: 1, pending: [] }, 'A scope completed signal assessment despite unrelated B source')
  if (restartBeforeSwitch) {
    await f.close(); f = await fixture('switch', true)
    assert.equal(f.service.running.get('local').runtime.config.collaborationId, 'po-native')
    const persistedB = await f.sdk.adapter.get(localConversationUpgradeKey(directory, 'other-chat'))
    assert.equal(persistedB?.status, 'complete', 'B conversation restored before restart')
    assert.equal(persistedB?.signalsAssessed, undefined, 'B binding-deferred responsibility survived restart without an assessment flag')
    console.log('B_PENDING_SURVIVED_RESTART', true)
  }
  const current = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'switch-to-b', changedFields: ['collaborationId'],
    settings: { ...current.settings, collaborationId: 'other-chat' } })
  const activeB = f.service.running.get('local')
  assert.equal(activeB.runtime.config.collaborationId, 'other-chat')
  const bState = await until('B signal assessed after actual activation', async () => {
    const state = await f.sdk.adapter.get(localConversationUpgradeKey(directory, 'other-chat'))
    return state?.signalsAssessed && state
  })
  assert.deepEqual(bState.signalsAssessed, { version: 1, pending: [] })
  const after = await activeB.connection.files.fileInfo(bPath)
  assert(after, 'original B signal is now Host-visible')
  await Promise.all(await activeB.runtime.loop.runSignalPoll())
  await activeB.runtime.runQueue()
  await until('real B Foreground claim', async () => !(await activeB.connection.files.fileInfo(bPath)))
  const access = await f.service.access('local')
  assert.equal((await access.conversation.read('b-input'))?.text, 'Old other-chat user text')
  assert.deepEqual(await fs.readFile(path.join(directory, 'dss-files.sqlite')), oldSql)
  console.log('A_RESULT', JSON.stringify(a.signals))
  console.log('B_RESULT', JSON.stringify(b.signals))
  console.log('B_AFTER_CONFIGURE', JSON.stringify(after))
  console.log('RESTORE_B_TOOL_CALLS', trace.filter(row => row.event === 'tool' && row.type === 'tool/call' && row.data?.name === 'dss_upgrade_local_files' && row.data.arguments?.includes('other-chat')).length)
  await f.close(); f = await fixture('switch', true)
  assert.equal(f.service.running.get('local').runtime.config.collaborationId, 'other-chat')
  assert.equal(await f.service.running.get('local').connection.files.fileInfo(bPath), undefined, 'cold restart did not republish consumed B signal')
  const coldState = await f.sdk.adapter.get(localConversationUpgradeKey(directory, 'other-chat'))
  assert.deepEqual(coldState.signalsAssessed, { version: 1, pending: [] })
  console.log('B_COLD_RESTART', 'no republish')
} finally {
  await f?.close()
  oldHooks.deregister(); sdkHooks.deregister()
  await fs.rm(root, { recursive: true, force: true })
}
