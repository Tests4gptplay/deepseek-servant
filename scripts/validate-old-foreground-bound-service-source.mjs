import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { hooks as sdkHooks } from './test-support/dsh-sdk-runtime.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-bound-old-foreground-'))
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
const { restoreLegacyConversationScope, restoreLegacyConversationSignals } = await import('../src/framework/local-upgrade-conversation.ts')
const { localUpgradeMappingKey } = await import('../src/framework/local-upgrade-mapping.ts')
const { withLegacySqliteSnapshot } = await import('../src/framework/legacy-sqlite-reader.ts')
const { fixture, until, trace } = await import('./helper-service-sdk.mjs')
const positive = process.argv.includes('--positive')
const taskUsername = process.argv.includes('--task-username')
let assertions = 0
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++ }
let f
try {
  const name = positive ? 'actual-old-positive' : 'actual-old-source', business = path.join(root, name, 'business')
  await fs.mkdir(business, { recursive: true })
  const files = await OldFiles.open(business)
  try {
    const receipts = new LocalRecordFiles(path.join(root, name, 'old-receipts'))
    const records = { get: async key => { const body = await receipts.read(hash(key) + '.json'); return body && JSON.parse(body) },
      set: async (key, value) => receipts.replace(hash(key) + '.json', JSON.stringify(value)) }
    const conversation = new OldConversation(files, new OldTransactions(files, records, 'actual-v44'), { mode: 'local', collaborationId: 'po-native' })
    await conversation.send('old-input', { id: 'old-input', participantId: 'old-user', ...(taskUsername ? { username: 'Task_foo' } : {}), createdAt: '2026-11-07T00:00:00.000Z',
      role: 'user', recipient: 'ai', text: 'Saved original user input' })
  } finally { await files.close() }
  const original = await fs.readFile(path.join(business, 'dss-files.sqlite'))
  const source = await withLegacySqliteSnapshot(path.join(business, 'dss-files.sqlite'), async snapshot => {
    for await (const row of snapshot.entries('state/')) if (row.kind === 'file' && row.path.startsWith('state/Foreground_')) return row
  })
  assert(source, 'frozen producer created the original signal')
  if (taskUsername) assert(source.path.startsWith('state/Foreground_Task_foo-GMT0-'), 'actual v44 producer used the user-entered Task_ name')
  f = await fixture(name)
  check((await restoreLegacyConversationScope(business, 'po-native', f.sdk.adapter)).status, 'complete', 'real Service source body restored')
  const owner = f.service.localUpgrades.get(business)
  assert(owner?.agent, 'real Service has one-time Local owner')
  const binding = owner.agent.config.currentCollaborationId
  check(binding(), 'po-native', 'actual Host initially bound to old message scope')
  if (positive) {
    const result = await restoreLegacyConversationSignals(business, 'po-native', f.sdk.adapter, binding)
    check(result.pending, [], 'current bound scope has precise old notification restoration')
    check(result.published, 1, 'one physical signal published')
    const mapping = await f.sdk.adapter.get(localUpgradeMappingKey(business, source.path))
    check(mapping?.sourcePath, source.path, 'original source is retained in once mapping')
    const targetPath = mapping.targets[0]
    check(targetPath.startsWith('state/Foreground_Conversation-g'), true, 'published target uses the common scoped source format')
    check(typeof (await f.active.connection.files.fileInfo(targetPath))?.version, 'string', 'real Host can observe the scoped notification')
    await Promise.all(await f.rt.loop.runSignalPoll())
    await f.rt.runQueue()
    await until('real Foreground claim of old recovered notification', async () => !(await f.active.connection.files.fileInfo(targetPath)))
    check(await f.active.connection.files.fileInfo(targetPath), undefined, 'real native Foreground claim consumed the signal')
    if (taskUsername) {
      const delivered = await until('Task_ username Foreground wake persisted', () => {
        const rows = trace.filter(row => row.event === 'role-persisted' && row.record?.lastWake?.sources?.some(item => item.path === targetPath))
        return rows.length ? rows : undefined
      })
      check(delivered.length > 0, true, 'Task_ username reached real Foreground wake')
      check(delivered.every(row => row.record.lastWake.taskId === undefined), true, 'Task_ username did not invent a Task ID')
    }
    const access = await f.service.access('local')
    check((await access.conversation.read('old-input'))?.text, 'Saved original user input', 'real bound conversation retains old input')
    check((await access.conversation.page(20, undefined, {})).messages.some(row => row.role === 'assistant'), false,
      'controlled model did not send an automatic reply during signal recovery test')
    await f.close(); f = await fixture(name, true)
    check(await f.active.connection.files.fileInfo(targetPath), undefined, 'cold Service/SDK restart did not republish consumed old signal')
  } else {
    const current = f.service.config('local')
    await f.service.configure({ mode: 'local', commandId: 'switch-away', changedFields: ['collaborationId'],
      settings: { ...current.settings, collaborationId: 'other-chat' } })
    check(binding(), 'other-chat', 'actual replacement Host bound to a different conversation')
    const wrong = await restoreLegacyConversationSignals(business, 'po-native', f.sdk.adapter, binding)
    check(wrong.published, 0, 'original signal not emitted into the wrong active conversation')
    check(wrong.pending.length, 1, 'original signal remains actionable pending')
    check(await fs.stat(path.join(business, ...source.path.split('/'))).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)),
      false, 'original signal has no wrong-scope physical target')
  }
  check(await fs.readFile(path.join(business, 'dss-files.sqlite')), original, 'real old SQL remains byte-identical')
  console.log(JSON.stringify({ status: 'passed', variant: positive ? 'positive' : 'wrong-bound', taskUsername, assertions, signal: source.path, limits: 'Frozen v44 old Local producer, real current Service/SDK/Host, controlled model. Not a user installation or Windows.' }, null, 2))
} finally {
  await f?.close()
  oldHooks.deregister(); sdkHooks.deregister()
  await fs.rm(root, { recursive: true, force: true })
}
