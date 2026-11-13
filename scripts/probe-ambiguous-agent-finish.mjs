import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
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
const { withSnapshot: oldSnapshot } = await import(new URL('framework/transactions.ts', oldRoot))
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { localConversationUpgradeKey } = await import('../src/framework/local-upgrade-conversation.ts')
const { localUpgradeMappingKey } = await import('../src/framework/local-upgrade-mapping.ts')
const { fixture, trace, until } = await import('./helper-service-sdk.mjs')
const { withLegacySqliteSnapshot } = await import('../src/framework/legacy-sqlite-reader.ts')
const { LocalUpgradeStatus } = await import('../src/framework/client-upgrade-status.ts')
let f
try {
  f = await fixture('ambiguous', false, async dir => {
    const business = path.join(dir, 'business')
    await fs.mkdir(business, { recursive: true })
    const files = await OldFiles.open(business)
    try {
      const receipts = new LocalRecordFiles(path.join(dir, 'old-receipts'))
      const records = { get: async key => { const body = await receipts.read(hash(key) + '.json'); return body && JSON.parse(body) },
        set: (key, value) => receipts.replace(hash(key) + '.json', JSON.stringify(value)) }
      for (const [scope, id, username] of [['po-native', 'alice', 'Alice'], ['other-chat', 'bob', 'Alice']]) {
        const conversation = new OldConversation(files, new OldTransactions(files, records, 'actual-v44'), { mode: 'local', collaborationId: scope })
        await conversation.send(id, { id, participantId: 'old-user', username, createdAt: '2026-11-07T00:00:00.000Z',
          role: 'user', recipient: 'ai', text: 'Old ' + scope })
        if (scope === 'po-native') {
          const paths = await oldSnapshot(files, snapshot => conversation.notificationPaths(snapshot))
          await conversation.claimForegroundSignals('claim-first', paths)
        }
      }
    } finally { await files.close() }
  })
  const business = f.active.connection.files.directory
  const oldSql = await fs.readFile(path.join(business, 'dss-files.sqlite'))
  const originalSignals = await withLegacySqliteSnapshot(path.join(business, 'dss-files.sqlite'), async snapshot => {
    const paths = []
    for await (const row of snapshot.entries('state/')) if (row.kind === 'file' && row.path.startsWith('state/Foreground_')) paths.push(row.path)
    return paths
  })
  assert.equal(originalSignals.length, 1, 'old writer claim followed by same-name reuse leaves exactly one source signal')
  let agentId = await until('real Agent waiting', () => [...f.model.waiting.keys()].find(id => id.startsWith('dss-local-upgrade-')))
  let commandNumber = 0
  async function command(action, fields = {}) {
    await until('model waiting for ' + action, () => f.model.waiting.has(agentId))
    const callId = 'ambiguous-' + action + '-' + ++commandNumber
    f.model.command(agentId, { name: 'dss_upgrade_local_files', input: { action, ...fields }, callId })
    const row = await until('native result for ' + action, () => trace.find(row => row.event === 'tool' && row.type === 'tool/result' && row.data?.message?.toolCallId === callId))
    assert.equal(row.data.message.isError, false)
    return JSON.parse(row.data.message.content.find(c => c.type === 'text').text)
  }
  const restored = await command('restore_conversation', { collaborationId: 'po-native' })
  assert.equal(restored.status, 'complete')
  assert.equal(restored.signals.published, 0)
  assert.deepEqual(restored.signals.pending.map(row => row.path).sort(), [...originalSignals].sort())
  console.log('RESTORE_AMBIGUOUS_PENDING', JSON.stringify(restored.signals))
  const current = f.service.config('local')
  await f.service.configure({ mode: 'local', commandId: 'select-ambiguous-b', changedFields: ['collaborationId'],
    settings: { ...current.settings, collaborationId: 'other-chat' } })
  const second = await command('restore_conversation', { collaborationId: 'other-chat' })
  assert.equal(second.status, 'complete')
  assert.deepEqual(second.signals.pending.map(row => row.path), originalSignals)
  const materialized = await command('materialize')
  console.log('MATERIALIZE_STATUS', JSON.stringify(materialized.report))
  const finish = await command('finish')
  assert.equal(finish.completed, false)
  assert.deepEqual(finish.pending.filter(row => row.path.startsWith('state/Foreground_')).map(row => row.path), originalSignals)
  assert(finish.pending.some(row => row.path === originalSignals[0] && row.reason.includes('More than one original Local conversation')),
    'finish uses exact prior conversation assessment instead of only generic source-row wording')
  console.log('FINISH_RESULT', JSON.stringify(finish))
  const state = await f.sdk.adapter.get(localConversationUpgradeKey(business, 'po-native'))
  console.log('SIGNAL_RECEIPT', JSON.stringify(state?.signalsAssessed))
  assert.deepEqual(await fs.readFile(path.join(business, 'dss-files.sqlite')), oldSql)
  await until('model waiting to conclude Agent', () => f.model.waiting.has(agentId))
  f.model.command(agentId, 'idle')
  const owner = f.service.localUpgrades.get(business)
  await until('Agent result settled', () => owner.result)
  const view = await f.service.view({ mode: 'local' })
  assert.equal(owner.result.status, 'pending')
  assert.equal(view.localUpgrade.status, 'pending')
  assert.deepEqual(view.localUpgrade.pending.filter(row => row.path.startsWith('state/Foreground_')).map(row => row.path), originalSignals)
  const rendered = renderToStaticMarkup(LocalUpgradeStatus({ value: view.localUpgrade, tr: (_cn, en) => en }))
  assert(rendered.includes(originalSignals[0]), 'actual UI component renders the exact pending signal path')
  assert(rendered.includes('More than one original Local conversation'), 'actual UI explains why original chat domain cannot be chosen')
  console.log('OWNER_RESULT', JSON.stringify(owner.result))
  console.log('UI_LOCAL_UPGRADE', JSON.stringify(view.localUpgrade))
  console.log('UI_RENDERED_PENDING_PATH', originalSignals[0])
  console.log('ORIGINAL_PATHS', JSON.stringify(originalSignals))
  await f.close(); f = await fixture('ambiguous', true)
  agentId = await until('cold Agent waiting without a new restore call', () => [...f.model.waiting.keys()].find(id => id.startsWith('dss-local-upgrade-')))
  const cold = await command('finish')
  assert.equal(cold.completed, false)
  assert(cold.pending.some(row => row.path === originalSignals[0] && row.reason.includes('More than one original Local conversation')),
    'cold Agent finish recovers exact reason from existing conversation receipt')
  console.log('COLD_FINISH_EXACT_PENDING', cold.pending.find(row => row.path === originalSignals[0]))
  await f.close(); f = await fixture('unrestored', false, async dir => {
    const target = path.join(dir, 'business')
    await fs.mkdir(target, { recursive: true })
    const files = await OldFiles.open(target)
    try {
      const receipts = new LocalRecordFiles(path.join(dir, 'old-receipts'))
      const records = { get: async key => { const body = await receipts.read(hash(key) + '.json'); return body && JSON.parse(body) },
        set: (key, value) => receipts.replace(hash(key) + '.json', JSON.stringify(value)) }
      const conversation = new OldConversation(files, new OldTransactions(files, records, 'actual-v44'),
        { mode: 'local', collaborationId: 'po-native' })
      await conversation.send('not-restored', { id: 'not-restored', participantId: 'old-user', createdAt: '2026-11-07T00:02:00.000Z',
        role: 'user', recipient: 'ai', text: 'Original retained for no-restore boundary' })
    } finally { await files.close() }
  })
  agentId = await until('new original Agent waiting without restoration', () => [...f.model.waiting.keys()].find(id => id.startsWith('dss-local-upgrade-')))
  await command('materialize')
  const unaddressed = await command('finish')
  const unaddressedPath = 'state/Foreground_old-user-GMT0-20261107-000200000'
  assert.equal(unaddressed.completed, false)
  const generic = unaddressed.pending.find(row => row.path === unaddressedPath)
  assert(generic?.reason.includes('This original can admit work.'), 'unaddressed original retains the generic source-row reason')
  assert.equal(generic.reason.includes('Exact old-conversation assessment'), false, 'no specialist conclusion was invented')
  console.log('NO_RESTORE_GENERIC_PENDING', generic)
} finally { await f?.close(); oldHooks.deregister(); sdkHooks.deregister(); await fs.rm(root, { recursive: true, force: true }) }
