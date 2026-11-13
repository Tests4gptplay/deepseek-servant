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
const { taskCompletionSignals: oldTaskCompletionSignals } = await import(new URL('framework/task-files.ts', oldRoot))
const { withSnapshot: oldSnapshot } = await import(new URL('framework/transactions.ts', oldRoot))
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { scopedLocalForegroundSourceNotification } = await import('../src/framework/conversation.ts')
const { restoreLegacyConversationScope, restoreLegacyConversationSignals } = await import('../src/framework/local-upgrade-conversation.ts')
const { materializeLegacyLocalFiles } = await import('../src/framework/local-startup-upgrade.ts')
const { inspectLocalUpgradeMapping, localUpgradeMappingKey } = await import('../src/framework/local-upgrade-mapping.ts')
const { withLegacySqliteSnapshot } = await import('../src/framework/legacy-sqlite-reader.ts')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-v44-single-foreground-'))
process.env.DSS_PO_NATIVE_ROOT = root
let assertions = 0
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++ }
class OldRecords {
  constructor(directory) { this.files = new LocalRecordFiles(path.join(directory, 'old-receipts')) }
  async get(key) { const raw = await this.files.read(hash(key) + '.json'); return raw === undefined ? undefined : JSON.parse(raw) }
  async set(key, value) { await this.files.replace(hash(key) + '.json', JSON.stringify(value)) }
}
const makeOld = async (business, scopes) => {
  const files = await OldFiles.open(business), records = new OldRecords(path.dirname(business))
  try {
    for (const [scope, id, date, recipient = 'ai', username, claimAfter = false, timezoneOffsetMinutes = 0] of scopes) {
      const tx = new OldTransactions(files, records, 'frozen-v44')
      const conversation = new OldConversation(files, tx, { mode: 'local', collaborationId: scope })
      await conversation.send(id, { id, participantId: 'old-user', ...(username ? { username } : {}), createdAt: date,
        timezoneOffsetMinutes, role: 'user', recipient, text: 'Old input for ' + scope })
      if (claimAfter) {
        const paths = await oldSnapshot(files, snapshot => conversation.notificationPaths(snapshot))
        await conversation.claimForegroundSignals('claim-' + id, paths)
      }
    }
  } finally { await files.close() }
}
const signalsAt = business => withLegacySqliteSnapshot(path.join(business, 'dss-files.sqlite'), async source => {
  const signals = []
  for await (const row of source.entries('state/')) if (row.kind === 'file' && row.path.startsWith('state/Foreground_')) signals.push(row)
  return signals
})
const readSignal = async (business, signal) => { const files = new PhysicalLocalFiles(business); try { return (await files.fileInfo(signal))?.version } finally { await files.close() } }
const mappedTarget = async (storage, business, source) => (await storage.get(localUpgradeMappingKey(business, source.path)))?.targets?.[0]
try {
  const business = path.join(root, 'single'), scope = 'po-native'
  await fs.mkdir(business)
  await makeOld(business, [[scope, 'old-input', '2026-11-07T00:00:00.000Z']])
  const original = await fs.readFile(path.join(business, 'dss-files.sqlite'))
  const [source] = await signalsAt(business)
  const target = scopedLocalForegroundSourceNotification(source.path, scope)
  check(source.bytes.byteLength, 0, 'real old producer writes an empty signal')
  const sdk = await openDshStorageFixture(path.join(root, 'storage'), path.join(root, 'locator'))
  try {
    check((await restoreLegacyConversationScope(business, scope, sdk.adapter)).status, 'complete', 'old body and index restored first')
    const recovered = await restoreLegacyConversationSignals(business, scope, sdk.adapter, () => scope)
    check(recovered.pending, [], 'single scoped signal has no ambiguity')
    check(recovered.published, 1, 'old pending notification published once')
    check(await mappedTarget(sdk.adapter, business, source), target, 'original source maps to common scoped physical target')
    const version = await readSignal(business, target)
    check(typeof version, 'string', 'Host-visible physical notification now exists')
    check(await inspectLocalUpgradeMapping(sdk.adapter, business, source), 'mapped', 'exact SQL source has durable disposition')
    const materialized = await materializeLegacyLocalFiles(business, sdk.adapter, { deferActivation: true })
    check(materialized.issues.some(item => item.path === source.path), false, 'generic pass no longer holds mapped signal')
    check(await readSignal(business, target), version, 'generic pass did not republish')
    const again = await restoreLegacyConversationSignals(business, scope, sdk.adapter, () => scope)
    check(again.published, 0, 'repeat specialist did not publish')
    check(await readSignal(business, target), version, 'repeat specialist kept same file')
    const files = new PhysicalLocalFiles(business)
    try {
      check(await files.deleteObserved(target, version), true, 'real physical claim consumes the observed signal')
      check(await readSignal(business, target), undefined, 'claimed signal is absent')
    } finally { await files.close() }
    const cold = await restoreLegacyConversationSignals(business, scope, sdk.adapter, () => scope)
    check(cold.published, 0, 'cold-like retry did not recreate a consumed signal')
    check(await readSignal(business, target), undefined, 'consumed signal stays absent')
    check(await fs.readFile(path.join(business, 'dss-files.sqlite')), original, 'old SQL remains byte-identical')
  } finally { await sdk.close() }
  const reopened = await openDshStorageFixture(path.join(root, 'storage'), path.join(root, 'locator'))
  try {
    check((await restoreLegacyConversationSignals(business, scope, reopened.adapter, () => scope)).published, 0, 'new native storage instance does not republish consumed signal')
    check(await readSignal(business, target), undefined, 'cold reopened notice remains consumed')
    check(await inspectLocalUpgradeMapping(reopened.adapter, business, source), 'mapped', 'source mapping survived native storage restart')
  } finally { await reopened.close() }
  const other = path.join(root, 'multi'); await fs.mkdir(other)
  await makeOld(other, [[scope, 'first', '2026-11-07T00:00:00.000Z'], ['other-chat', 'second', '2026-11-07T00:01:00.000Z'],
    ['human-chat', 'human-only', '2026-11-07T00:00:00.000Z', 'human']])
  const otherOriginal = await fs.readFile(path.join(other, 'dss-files.sqlite'))
  const otherSignals = await signalsAt(other)
  const sdk2 = await openDshStorageFixture(path.join(root, 'storage2'), path.join(root, 'locator2'))
  try {
    check((await restoreLegacyConversationScope(other, scope, sdk2.adapter)).status, 'complete', 'first scope restored independently')
    const wrongBound = await restoreLegacyConversationSignals(other, scope, sdk2.adapter, () => 'other-chat')
    check(wrongBound.published, 0, 'selected old scope cannot publish into a differently bound Foreground')
    for (const row of otherSignals) check(await readSignal(other, row.path), undefined, 'wrong-bound probe left signals unissued')
    const unique = await restoreLegacyConversationSignals(other, scope, sdk2.adapter, () => scope)
    check(unique.published, 1, 'multi-scope signal with unique indexed owner routes to bound scope')
    check(unique.pending.length, 0, 'unique signal owned by another scope is not a pending obligation of this scope')
    check(typeof await readSignal(other, await mappedTarget(sdk2.adapter, other, otherSignals[0])), 'string', 'bound scope signal published')
    check(await readSignal(other, otherSignals[1].path), undefined, 'other scope signal not published')
    check(await fs.readFile(path.join(other, 'dss-files.sqlite')), otherOriginal, 'multi-scope original SQL remains')
  } finally { await sdk2.close() }
  const differentNames = path.join(root, 'same-time-different-names'); await fs.mkdir(differentNames)
  await makeOld(differentNames, [[scope, 'alice-input', '2026-11-07T00:05:00.000Z', 'ai', 'Alice'],
    ['other-chat', 'bob-input', '2026-11-07T00:05:00.000Z', 'ai', 'Bob']])
  const namedSignals = await signalsAt(differentNames)
  check(namedSignals.length, 2, 'real old producer creates distinct username signals at the same timestamp')
  const sdkNamed = await openDshStorageFixture(path.join(root, 'storage-names'), path.join(root, 'locator-names'))
  try {
    check((await restoreLegacyConversationScope(differentNames, scope, sdkNamed.adapter)).status, 'complete', 'actual first named scope restored')
    const result = await restoreLegacyConversationSignals(differentNames, scope, sdkNamed.adapter, () => scope)
    check(result.published, 0, 'historical username was not persisted with entry; no guessed attribution')
    check(result.pending.length, 2, 'both same-time signals retain individual pending disposition')
    for (const row of namedSignals) check(await readSignal(differentNames, row.path), undefined, 'unknown owner signal not sent to active Host')
  } finally { await sdkNamed.close() }
  const covered = path.join(root, 'covered'); await fs.mkdir(covered)
  await makeOld(covered, [[scope, 'covered-input', '2026-11-07T00:02:00.000Z']])
  const [coveredSource] = await signalsAt(covered)
  const sdk3 = await openDshStorageFixture(path.join(root, 'storage3'), path.join(root, 'locator3'))
  try {
    check((await restoreLegacyConversationScope(covered, scope, sdk3.adapter)).status, 'complete', 'covered message restored before notice evaluation')
    const files = new PhysicalLocalFiles(covered)
    let version
    const coveredTarget = scopedLocalForegroundSourceNotification(coveredSource.path, scope)
    try {
      check(await files.createIfAbsent(coveredTarget, ''), true, 'an already Host-visible equivalent empty notice exists')
      version = (await files.fileInfo(coveredTarget)).version
    } finally { await files.close() }
    const result = await restoreLegacyConversationSignals(covered, scope, sdk3.adapter, () => scope)
    check(result.pending, [], 'equivalent notice is already Host-visible')
    check(result.published, 0, 'no duplicate notice publication')
    check(result.alreadyPresent, 1, 'existing equivalent notice covered')
    check(await readSignal(covered, coveredTarget), version, 'notice inode/version stayed untouched')
    check(await inspectLocalUpgradeMapping(sdk3.adapter, covered, coveredSource), 'mapped', 'existing notification coverage recorded')
  } finally { await sdk3.close() }
  const reused = path.join(root, 'reused'); await fs.mkdir(reused)
  await makeOld(reused, [[scope, 'claimed-first', '2026-11-07T00:03:00.000Z', 'ai', undefined, true],
    ['other-chat', 'reused-second', '2026-11-07T00:03:00.000Z']])
  const [reusedSource] = await signalsAt(reused)
  const sdk4 = await openDshStorageFixture(path.join(root, 'storage4'), path.join(root, 'locator4'))
  try {
    check((await restoreLegacyConversationScope(reused, scope, sdk4.adapter)).status, 'complete', 'claimed first scope restored')
    const result = await restoreLegacyConversationSignals(reused, scope, sdk4.adapter, () => scope)
    check(result.published, 0, 'same base name reused after real old claim does not infer a scope')
    check(result.pending.some(row => row.path === reusedSource.path), true, 'ambiguous original signal retained')
    check(await readSignal(reused, reusedSource.path), undefined, 'ambiguous reused signal not reissued')
  } finally { await sdk4.close() }
  const collision = path.join(root, 'real-same-name-collision'); await fs.mkdir(collision)
  await makeOld(collision, [[scope, 'base-first', '2026-11-07T00:06:00.000Z'],
    ['other-chat', 'hashed-second', '2026-11-07T00:06:00.000Z']])
  const collisionSignals = await signalsAt(collision)
  check(collisionSignals.length, 2, 'real old writer keeps base and suffix for same-name collision')
  const hashed = collisionSignals.find(row => /-[a-f0-9]{64}$/.test(row.path))
  assert(hashed, 'real old writer uses 64-hex suffix for second signal')
  const collisionSdk = await openDshStorageFixture(path.join(root, 'storage-collision'), path.join(root, 'locator-collision'))
  try {
    check((await restoreLegacyConversationScope(collision, 'other-chat', collisionSdk.adapter)).status, 'complete', 'second colliding scope restored')
    const result = await restoreLegacyConversationSignals(collision, 'other-chat', collisionSdk.adapter, () => 'other-chat')
    check(result.published, 1, 'real suffix identifies exact second scope without guessing base owner')
    check(result.pending.some(row => row.path !== hashed.path), true, 'ambiguous base remains pending independently')
    check(await mappedTarget(collisionSdk.adapter, collision, hashed), scopedLocalForegroundSourceNotification(hashed.path, 'other-chat'),
      'source suffix maps to shared scoped alias')
    check(typeof await readSignal(collision, scopedLocalForegroundSourceNotification(hashed.path, 'other-chat')), 'string',
      'exactly owned colliding suffix is physically visible')
  } finally { await collisionSdk.close() }
  const offset = path.join(root, 'real-ui-timezone'); await fs.mkdir(offset)
  await makeOld(offset, [[scope, 'east-offset', '2026-11-07T00:07:00.000Z', 'ai', undefined, false, 330],
    [scope, 'west-offset', '2026-11-07T00:08:00.000Z', 'ai', undefined, false, -480]])
  const offsetSignals = await signalsAt(offset)
  check(offsetSignals.some(row => row.path.includes('-GMT5m30-')), true, 'actual UI-positive minute timezone path is represented')
  check(offsetSignals.some(row => row.path.includes('-GMT-8-')), true, 'actual UI-negative hour timezone path is represented')
  const offsetSdk = await openDshStorageFixture(path.join(root, 'storage-offset'), path.join(root, 'locator-offset'))
  try {
    check((await restoreLegacyConversationScope(offset, scope, offsetSdk.adapter)).status, 'complete', 'nonzero-zone original scope restored')
    const result = await restoreLegacyConversationSignals(offset, scope, offsetSdk.adapter, () => scope)
    check(result.published, 2, 'old UI-reachable east and west minute offsets publish scoped aliases')
    check(result.pending, [], 'valid nonzero-zone signals remain unambiguous')
  } finally { await offsetSdk.close() }
  const longName = path.join(root, 'long-ui-name'); await fs.mkdir(longName)
  await makeOld(longName, [[scope, 'long-name-input', '2026-11-07T00:09:00.000Z', 'ai', '长'.repeat(60)]])
  const [longSource] = await signalsAt(longName)
  assert(longSource, 'actual old writer produced a long user-name signal')
  check(Buffer.byteLength(longSource.path.split('/').at(-1)) + 64 > 255, true,
    'appending a hash to the original long name would exceed the physical leaf budget')
  const longSdk = await openDshStorageFixture(path.join(root, 'storage-long'), path.join(root, 'locator-long'))
  try {
    check((await restoreLegacyConversationScope(longName, scope, longSdk.adapter)).status, 'complete', 'long-name original scope restored')
    const result = await restoreLegacyConversationSignals(longName, scope, longSdk.adapter, () => scope)
    check(result.published, 1, 'old UI-reachable long username publishes the fixed-length scoped alias')
    const target = await mappedTarget(longSdk.adapter, longName, longSource)
    check(target, scopedLocalForegroundSourceNotification(longSource.path, scope), 'long original path maps to common source alias')
    check(Buffer.byteLength(target.split('/').at(-1)) < 255, true, 'alias remains within physical leaf budget')
  } finally { await longSdk.close() }
  const taskName = path.join(root, 'task-name'); await fs.mkdir(taskName)
  await makeOld(taskName, [[scope, 'prefixed-user', '2026-11-07T00:04:00.000Z', 'ai', 'Task_real-user']])
  const actualOldTaskId = '123e4567-e89b-42d3-a456-426614174000'
  const actualOldTaskPath = 'state/Foreground_Task_' + actualOldTaskId
  const oldTaskFiles = await OldFiles.open(taskName)
  try {
    const tx = new OldTransactions(oldTaskFiles, new OldRecords(root), 'frozen-v44-task')
    await tx.run('old-task-complete', { taskId: actualOldTaskId }, {}, async () => oldTaskCompletionSignals({ taskId: actualOldTaskId, owner: 'old-user' }))
  } finally { await oldTaskFiles.close() }
  const taskNamedSource = (await signalsAt(taskName)).find(row => row.path.startsWith('state/Foreground_Task_real-user-GMT0-'))
  assert(taskNamedSource, 'actual v44 chat signal with Task_ username exists')
  const sdk5 = await openDshStorageFixture(path.join(root, 'storage5'), path.join(root, 'locator5'))
  try {
    check((await restoreLegacyConversationScope(taskName, scope, sdk5.adapter)).status, 'complete', 'valid Task_ username source restored')
    const result = await restoreLegacyConversationSignals(taskName, scope, sdk5.adapter, () => scope)
    check(result.pending, [], 'valid old Task_ username is not a UUID Task notification')
    check(result.published, 1, 'valid old Task_ username notice publishes')
    check(typeof await readSignal(taskName, await mappedTarget(sdk5.adapter, taskName, taskNamedSource)), 'string', 'Task_ username notice is physically visible')
    check(await readSignal(taskName, actualOldTaskPath), undefined, 'actual v44 UUID Task signal is not mis-published as chat')
  } finally { await sdk5.close() }
  console.log(JSON.stringify({ status: 'passed', assertions, single: source.path, multi: otherSignals.map(row => row.path), root }, null, 2))
} finally {
  oldHooks.deregister(); sdkHooks.deregister()
  await fs.rm(root, { recursive: true, force: true })
}
