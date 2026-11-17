// Frozen v44 Conversation.send producer, old SQLite STATE, actual Local restoration.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { hooks as sdkHooks } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
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
      assert.equal(hash(bytes), oldHashes[name], 'frozen v44 source ' + name)
      return { format: 'module', source: stripTypeScriptTypes(bytes.toString(), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { LocalFiles: OldFiles } = await import(new URL('framework/local-files.ts', oldRoot))
const { FrameworkTransactions: OldTransactions } = await import(new URL('framework/command-transactions.ts', oldRoot))
const { FrameworkConversation: OldConversation } = await import(new URL('framework/conversation.ts', oldRoot))
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { restoreLegacyConversationScope, restoreLegacyConversationSignals } = await import('../src/framework/local-upgrade-conversation.ts')
const { withLegacySqliteSnapshot } = await import('../src/framework/legacy-sqlite-reader.ts')
const { scopedLocalForegroundSourceNotification } = await import('../src/framework/conversation.ts')
class OldRecords {
  constructor(directory) { this.files = new LocalRecordFiles(path.join(directory, 'old-receipts')) }
  async get(key) { const raw = await this.files.read(hash(key) + '.json'); return raw === undefined ? undefined : JSON.parse(raw) }
  async set(key, value) { await this.files.replace(hash(key) + '.json', JSON.stringify(value)) }
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-v44-separator-sql-'))
try {
  for (const [label, username] of [['u2028', 'Evi\u2028dence'], ['u2029', 'Evi\u2029dence']]) {
    const directory = path.join(root, label), scope = 'po-native', id = 'old-' + label
    await fs.mkdir(directory)
    const old = await OldFiles.open(directory)
    try {
      const tx = new OldTransactions(old, new OldRecords(directory), 'frozen-v44')
      const conversation = new OldConversation(old, tx, { mode: 'local', collaborationId: scope })
      await conversation.send(id, { id, participantId: 'old-user', username, createdAt: '2026-11-07T00:00:00.000Z',
        timezoneOffsetMinutes: 0, role: 'user', recipient: 'ai', text: 'Actual old input' })
    } finally { await old.close() }
    const before = await fs.readFile(path.join(directory, 'dss-files.sqlite'))
    const signals = await withLegacySqliteSnapshot(path.join(directory, 'dss-files.sqlite'), async source => {
      const result = []
      for await (const row of source.entries('state/')) if (row.kind === 'file' && row.path.startsWith('state/Foreground_')) result.push(row)
      return result
    })
    assert.equal(signals.length, 1, 'frozen v44 send emitted exactly one SQL STATE signal')
    const source = signals[0]
    assert(source.path.includes(username), 'the old signal retains the user-entered separator')
    assert.equal(source.bytes.byteLength, 0)
    const sdk = await openDshStorageFixture(path.join(root, label + '-storage'), path.join(root, label + '-locator'))
    try {
      assert.equal((await restoreLegacyConversationScope(directory, scope, sdk.adapter)).status, 'complete')
      const result = await restoreLegacyConversationSignals(directory, scope, sdk.adapter, () => scope)
      const alias = scopedLocalForegroundSourceNotification(source.path, scope)
      const published = await fs.stat(path.join(directory, alias)).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))
      console.log('OLD_SEPARATOR_SQL', JSON.stringify({ label, oldPath: source.path, published: result.published,
        pending: result.pending, scopedAlias: alias, aliasPresent: published }))
      assert.equal(result.published, 1, 'real v44 SQL signal must be scoped and published')
      assert.deepEqual(result.pending, [])
      assert(published)
      assert.deepEqual(await fs.readFile(path.join(directory, 'dss-files.sqlite')), before, 'original SQL retained exactly')
    } finally { await sdk.close() }
  }
  console.log('OLD_SEPARATOR_SQL_PASS')
} finally { oldHooks.deregister(); sdkHooks.deregister() }
