import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { hooks as sdkHooks } from './test-support/dsh-sdk-runtime.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-early-old-foreground-'))
process.env.DSS_PO_NATIVE_ROOT = root
process.env.DSS_EARLY_UPGRADE_TOOL = '1'
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
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { scopedLocalForegroundSourceNotification } = await import('../src/framework/conversation.ts')
const { fixture, trace, until } = await import('./helper-service-sdk.mjs')

const entered = Promise.withResolvers(), release = Promise.withResolvers()
const start = FrameworkRoleRuntime.prototype.start
FrameworkRoleRuntime.prototype.start = async function (...args) { entered.resolve(); await release.promise; return start.apply(this, args) }
let f
try {
  const pendingStart = fixture('early', false, async dir => {
    const business = path.join(dir, 'business')
    await fs.mkdir(business, { recursive: true })
    const files = await OldFiles.open(business)
    try {
      const receipts = new LocalRecordFiles(path.join(dir, 'old-receipts'))
      const records = { get: async key => { const body = await receipts.read(hash(key) + '.json'); return body && JSON.parse(body) },
        set: (key, value) => receipts.replace(hash(key) + '.json', JSON.stringify(value)) }
      const tx = new OldTransactions(files, records, 'actual-v44')
      const conversation = new OldConversation(files, tx, { mode: 'local', collaborationId: 'po-native' })
      await conversation.send('old-input', { id: 'old-input', participantId: 'old-user', createdAt: '2026-11-07T00:00:00.000Z',
        role: 'user', recipient: 'ai', text: 'Old user text' })
      await tx.run('old-guide', { path: 'technical/role-guides/Foreground.md' }, {}, async () => [
        { path: 'technical/role-guides/Foreground.md', content: 'Original v44 guide record for startup dependency probe.' },
        { path: 'technical/skills/catalog.json', content: '{"version":1,"skills":[]}' },
      ])
    } finally { await files.close() }
  })
  await entered.promise
  await until('early actual restore_conversation tool call', () => trace.find(row => row.event === 'tool' && row.type === 'tool/call' && row.data?.callId === 'early-restore'))
  await until('original index restored while Host still held', async () => fs.access(path.join(root, 'early', 'business', 'conversation-index', 'local', 'po-native', 'index.json')).then(() => true, () => false))
  assert.equal(trace.some(row => row.event === 'tool' && row.type === 'tool/result' && row.data?.message?.toolCallId === 'early-restore'), false)
  console.log('EARLY_TOOL_WAITING_FOR_ACTIVE_HOST', true)
  release.resolve()
  f = await pendingStart
  const result = await until('early actual restore_conversation tool result', () => {
    const row = trace.find(row => row.event === 'tool' && row.type === 'tool/result' && row.data?.message?.content?.some(c => c.type === 'text' && c.text.includes('signals')))
    if (!row) return
    const text = row.data.message.content.find(c => c.type === 'text').text
    return JSON.parse(text)
  })
  console.log('EARLY_RESULT', JSON.stringify(result))
  assert.equal(result.status, 'complete')
  assert.equal(result.signals.published, 1)
  assert.deepEqual(result.signals.pending, [])
  assert.equal(f.service.localUpgrades.get(f.active.connection.files.directory).agent.config.currentCollaborationId(), 'po-native')
  console.log('ACTIVE_AFTER_START', f.active.runtime.config.collaborationId)
  const tools = trace.filter(row => row.event === 'tool' && row.type === 'tool/call' && JSON.stringify(row.data).includes('restore_conversation'))
  console.log('RESTORE_CALLS_AFTER_ACTIVE', tools.length)
  const oldSignal = 'state/Foreground_old-user-GMT0-20261107-000000000'
  const scopedSignal = scopedLocalForegroundSourceNotification(oldSignal, 'po-native')
  assert(await f.active.connection.files.fileInfo(scopedSignal), 'early Agent tool published the shared scoped alias after Host activated')
  assert.equal(await f.active.connection.files.fileInfo(oldSignal), undefined, 'original unscoped SQL source was not published to B-readable STATE')
  console.log('SCOPED_SIGNAL_AFTER_ACTIVE', scopedSignal)
} finally {
  release.resolve()
  FrameworkRoleRuntime.prototype.start = start
  await f?.close()
  oldHooks.deregister(); sdkHooks.deregister()
  await fs.rm(root, { recursive: true, force: true })
}
