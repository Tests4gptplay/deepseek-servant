import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkConversation, foregroundNotification, type ConversationSend } from '../src/framework/conversation.js'
import { FilesConflictError, FilesOutcomeUnknownError, withSnapshot } from '../src/framework/transactions.js'
import type { StoragePort } from '../src/contracts/ports.js'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dss-conversation-')), files = await LocalFiles.open(root)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }) })
  const data = new Map<string, unknown>()
  const records: StoragePort = { async get<T>(key: string) { return data.get(key) as T | undefined }, async set(key, value) { data.set(key, value) }, async list<T>(prefix: string) { return [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: value as T })) } }
  const transactions = new FrameworkTransactions(files, records, 'isolated-test')
  const service = new FrameworkConversation(files, transactions, { mode: 'git', collaborationId: 'team' })
  return { files, transactions, service }
}
const message = (id: string, extra: Partial<ConversationSend> = {}): ConversationSend => ({ id, participantId: 'account-A', createdAt: '2026-10-31T00:00:00.000Z', role: 'user', text: 'Original 😀\ntext', device: 'phone', recipient: 'ai', ...extra })

test('page borrows the caller snapshot without releasing it; standalone history observes later commits', async t => {
  const f = await fixture(t)
  await f.service.send('old', message('old'))
  const old = await f.files.snapshot(), release = old.release.bind(old)
  let releases = 0
  old.release = async () => { releases++; await release() }
  try {
    await f.service.send('new', message('new'))
    const page = await f.service.page(20, undefined, {}, old)
    assert.equal(page.revision, old.revision); assert.deepEqual(page.messages.map(row => row.id), ['old'])
    assert.equal(releases, 0)
    assert.ok(await f.files.read(old, f.service.indexPath), 'caller still owns a live snapshot')
    assert.deepEqual((await f.service.page(20)).messages.map(row => row.id), ['old', 'new'])
  } finally { await old.release() }
  assert.equal(releases, 1)
})

test('a page cannot borrow a snapshot from another store or a released snapshot', async t => {
  const first = await fixture(t), second = await fixture(t), snapshot = await first.files.snapshot()
  await assert.rejects(second.service.page(20, undefined, {}, snapshot), /Snapshot was released or belongs to another store/)
  await snapshot.release()
  await assert.rejects(first.service.page(20, undefined, {}, snapshot), /Snapshot was released or belongs to another store/)
})

test('shared collaboration merges participants, preserves raw provenance and separates human discussion', async t => {
  const { service, files } = await fixture(t)
  await service.send('send-a', message('a'))
  await service.send('send-b', message('b', { participantId: 'account-B', recipient: 'human', replyTo: 'a', text: '  Human discussion\n' }))
  const page = await service.page(10)
  assert.deepEqual(page.messages.map(item => item.participantId), ['account-A', 'account-B'])
  assert.equal(page.messages[1].text, '  Human discussion\n')
  assert.equal(page.messages[1].replyTo, 'a')
  assert.deepEqual((await service.pendingForeground()).messages.map(item => item.id), ['a'])
  await withSnapshot(files, async snapshot => assert.equal((await files.listDirectory(snapshot, 'state/')).length, 1))
})
test('same-millisecond collisions preserve both notifications and exact CAS consumption', async t => {
  const { service, files } = await fixture(t)
  await service.send('a', message('a')); await service.send('b', message('b'))
  const pending = await service.pendingForeground()
  await withSnapshot(files, async snapshot => { const entries = await files.listDirectory(snapshot, 'state/'); assert.equal(entries.length, 2); assert.ok(entries.every(entry => entry.path.startsWith('state/Foreground_account-A-GMT0-20261031-000000000'))) })
  await service.claimForeground('claim-a', ['a'], { list: 'a accepted', cache: 'a context' }, { expectedRevision: pending.revision })
  assert.deepEqual((await service.pendingForeground()).messages.map(item => item.id), ['b'])
  assert.equal((await service.readForeground()).list, 'a accepted')
  await withSnapshot(files, async snapshot => assert.equal((await files.listDirectory(snapshot, 'state/')).length, 1))
})
test('confirmed send replay does not duplicate and altered same identity is rejected', async t => {
  const { service } = await fixture(t)
  await service.send('send', message('a'))
  assert.equal((await service.send('send', message('a'))).replay, true)
  await service.send('new-reviewed-command', message('a'))
  assert.equal((await service.page(10)).messages.length, 1)
  await assert.rejects(service.send('changed', message('a', { text: 'different' })), /identity already/)
})
test('six complete exchanges exclude six unanswered user inputs and human-only chat', async t => {
  const { service } = await fixture(t)
  for (let i = 0; i < 8; i++) {
    await service.send('u' + i, message('u' + i))
    await service.send('a' + i, message('a' + i, { role: 'assistant', recipient: undefined, replyTo: 'u' + i, text: 'answer ' + i }))
  }
  for (let i = 0; i < 6; i++) await service.send('pending' + i, message('pending' + i))
  await service.send('discussion', message('discussion', { recipient: 'human' }))
  assert.deepEqual((await service.recentExchanges()).map(pair => pair.human.id), ['u2', 'u3', 'u4', 'u5', 'u6', 'u7'])
  assert.equal((await service.read('u0'))?.text, 'Original 😀\ntext')
})
test('timeline uses commit order rather than unsynchronized device time; paging is exact', async t => {
  const { service } = await fixture(t)
  await service.send('a', message('a', { createdAt: '2030-01-01T00:00:00.000Z' }))
  await service.send('b', message('b', { createdAt: '2020-01-01T00:00:00.000Z' }))
  const latest = await service.page(1)
  assert.deepEqual(latest.messages.map(item => item.id), ['b'])
  assert.deepEqual((await service.page(1, latest.moreBefore)).messages.map(item => item.id), ['a'])
})
test('mode and collaboration isolate persistent Foreground memories and message indexes', async t => {
  const { service, files, transactions } = await fixture(t)
  const local = new FrameworkConversation(files, transactions, { mode: 'local', collaborationId: 'team' })
  const other = new FrameworkConversation(files, transactions, { mode: 'git', collaborationId: 'other' })
  await service.send('send', message('a')); await local.send('send', message('a', { text: 'Local' }))
  await service.writeForeground('memory', { list: 'shared work', cache: 'shared context' })
  assert.equal((await local.read('a'))?.text, 'Local')
  assert.deepEqual(await local.readForeground(), { list: '', cache: '' })
  assert.equal(await other.read('a'), undefined)
  assert.deepEqual(await other.readForeground(), { list: '', cache: '' })
})
test('claim against stale reviewed head leaves newer notification and memory untouched', async t => {
  const { service } = await fixture(t)
  await service.send('a', message('a'))
  const reviewed = await service.pendingForeground()
  await service.send('b', message('b'))
  await assert.rejects(service.claimForeground('stale', ['a'], { list: 'stale', cache: '' }, { expectedRevision: reviewed.revision }), FilesConflictError)
  assert.equal((await service.pendingForeground()).messages.length, 2)
  assert.equal((await service.readForeground()).list, '')
})
test('UTF-8 hash and established manifest round-trip surrogate boundary without truncation', async t => {
  const { service, files } = await fixture(t)
  const text = 'x'.repeat(65_535) + '😀中文\n'
  await service.send('unicode', message('unicode', { text }))
  assert.equal((await service.read('unicode'))?.text, text)
  await withSnapshot(files, async snapshot => {
    const entries = await files.list(snapshot, 'conversations/')
    const path = entries.find(entry => entry.path.endsWith('/manifest.json'))!.path
    const manifest = JSON.parse((await files.read(snapshot, path))!)
    assert.equal(manifest.sha256, createHash('sha256').update(text).digest('hex'))
    assert.equal(manifest.chunks.length, 2)
    assert.equal((await files.read(snapshot, manifest.chunks[0].replace(/^dss-coop\//, '')))?.length, 65_535)
  })
})
test('legacy entry with external assistant reply text reference is indexed without rewriting it', async t => {
  const { service, files } = await fixture(t)
  const text = 'Existing reply 😀', hash = createHash('sha256').update(text).digest('hex')
  const path = 'conversations/legacy/2026-10-30/2026-10-30T00:00:00.000Z-old/entry.json'
  const textPath = 'assistants/legacy/foreground/turn-1/reply'
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path, content: JSON.stringify({ id: 'old', createdAt: '2026-10-30T00:00:00.000Z', role: 'assistant', textPath: 'dss-coop/' + textPath, writer: { participantId: 'legacy' }, replyTo: 'older' }) },
    { path: textPath + '/manifest.json', content: JSON.stringify({ version: 1, sha256: hash, characters: text.length, chunks: ['dss-coop/' + textPath + '/parts/000000.txt'] }) },
    { path: textPath + '/parts/000000.txt', content: text },
  ], 'legacy-format fixture'))
  await service.indexLegacy('migrate', [path])
  assert.equal((await service.read('old'))?.text, text)
  assert.equal((await service.read('old'))?.replyTo, 'older')
  assert.equal((await service.read('old'))?.participantId, 'legacy')
})
test('integrity errors remain structured read failures, not invented assistant messages', async t => {
  const { service, files } = await fixture(t)
  await service.send('a', message('a'))
  await withSnapshot(files, async snapshot => {
    const path = (await files.list(snapshot, 'conversations/')).find(entry => entry.path.endsWith('/000000.txt'))!.path
    await files.commit(snapshot, [{ path, content: 'corrupted' }], 'corrupt controlled fixture')
  })
  await assert.rejects(service.read('a'), (error: any) => error.name === 'ConversationRecordError' && error.reason === 'integrity' && typeof error.path === 'string')
})
test('timezone encoding preserves fractional offsets and real milliseconds', () => {
  assert.equal(foregroundNotification('User', new Date('2026-10-30T19:08:56.123Z'), 540), 'Foreground_User-GMT9-20261031-040856123')
  assert.equal(foregroundNotification('User', new Date('2026-10-30T19:08:56.123Z'), 330), 'Foreground_User-GMT5m30-20261031-003856123')
})

test('lost commit acknowledgement keeps the stable message and resolves by atomic receipt on replay', async t => {
  const { service, files } = await fixture(t)
  const original = files.commit.bind(files)
  let loseAcknowledgement = true
  files.commit = async (...args) => {
    const receipt = await original(...args)
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new FilesOutcomeUnknownError('controlled-ack-loss', undefined, receipt) }
    return receipt
  }
  const draft = message('stable-draft')
  await assert.rejects(service.send('send-once', draft), (error: any) => error instanceof FilesOutcomeUnknownError && error.operationId === 'controlled-ack-loss')
  assert.equal((await service.send('send-once', draft)).replay, true)
  assert.deepEqual((await service.page(10)).messages.map(item => item.id), ['stable-draft'])
  assert.equal((await service.pendingForeground()).messages.length, 1)
})

test('notificationPaths reads only index metadata and excludes consumed chat notifications', async t => {
  const { service, files } = await fixture(t)
  await service.send('a', message('a')); await service.send('b', message('b'))
  const pending = await service.pendingForeground()
  await service.claimForeground('consume-a', ['a'], { list: 'taken', cache: '' }, { expectedRevision: pending.revision })
  const original = files.read.bind(files), paths: string[] = []
  files.read = async (snapshot, path) => { paths.push(path); return original(snapshot, path) }
  await withSnapshot(files, async snapshot => {
    const notifications = await service.notificationPaths(snapshot)
    assert.equal(notifications.length, 1)
    assert.ok(notifications[0].startsWith('state/Foreground_'))
  })
  assert.deepEqual(paths, [service.indexPath])
})

test('legacy plan composes index without sending notifications and preserves historical system entries', async t => {
  const { service, files } = await fixture(t)
  const path = 'conversations/legacy/2026-10-30/system/entry.json', textPath = 'conversations/legacy/2026-10-30/system/text'
  const text = 'Preserved legacy status', digest = createHash('sha256').update(text).digest('hex')
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path, content: JSON.stringify({ id: 'old-status', participantId: 'legacy', role: 'system', source: 'deepseek-servant-status', createdAt: '2026-10-30T00:00:00Z', textPath, textHash: digest }) },
    { path: textPath + '/manifest.json', content: JSON.stringify({ version: 1, sha256: digest, characters: text.length, chunks: [textPath + '/parts/000000.txt'] }) },
    { path: textPath + '/parts/000000.txt', content: text },
  ], 'actual legacy-compatible system record'))
  await withSnapshot(files, async snapshot => {
    const changes = await service.planLegacyIndex(snapshot, [path])
    assert.equal(await files.read(snapshot, service.indexPath), undefined)
    assert.ok(changes.every(change => !change.path.startsWith('state/')))
    await files.commit(snapshot, changes, 'combined migration index')
  })
  const restored = await service.read('old-status')
  assert.equal(restored?.role, 'system'); assert.equal(restored?.source, 'deepseek-servant-status'); assert.equal(restored?.text, text)
  assert.deepEqual(await service.recentExchanges(), [])
  assert.deepEqual((await service.pendingForeground()).messages, [])
})


test('six complete exchanges retain every associated assistant original in timeline order', async t => {
  const { service } = await fixture(t)
  for (let n = 0; n < 7; n++) {
    await service.send('user-' + n, message('u' + n, { text: '  question ' + n + '\n原文😀' }))
    for (let part = 0; part < 2; part++) await service.send('answer-' + n + '-' + part,
      message('a' + n + '-' + part, { role: 'assistant', text: 'part ' + part + '\n  exact ' + n,
        replyTo: 'u' + n, recipient: 'human' }))
  }
  const exchanges = await service.recentExchanges()
  assert.deepEqual(exchanges.map(exchange => exchange.human.id), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'])
  for (let i = 0; i < exchanges.length; i++) {
    const n = i + 1, exchange = exchanges[i]!
    assert.equal(exchange.human.text, '  question ' + n + '\n原文😀')
    assert.deepEqual(exchange.assistants.map(reply => reply.id), ['a' + n + '-0', 'a' + n + '-1'])
    assert.deepEqual(exchange.assistants.map(reply => reply.text), ['part 0\n  exact ' + n, 'part 1\n  exact ' + n])
    assert.equal(exchange.assistant.id, 'a' + n + '-1', 'Existing latest-answer projection remains compatible')
  }
})

test('complete-round selection uses indexed provenance instead of rereading unrelated historical headers', async t => {
  const { service, files } = await fixture(t)
  for (let n = 0; n < 12; n++) {
    await service.send('u-' + n, message('u-' + n, {text:'question ' + n}))
    await service.send('a-' + n, message('a-' + n, {role:'assistant',replyTo:'u-' + n,text:'answer ' + n,recipient:'human'}))
  }
  const read = files.read.bind(files), headers: string[] = []
  files.read = async (snapshot, path) => { if (path.endsWith('/entry.json')) headers.push(path); return read(snapshot,path) }
  const selected = await service.recentExchanges()
  assert.deepEqual(selected.map(round=>round.human.id), ['u-6','u-7','u-8','u-9','u-10','u-11'])
  for (let n = 0; n < 6; n++) assert.ok(!headers.some(path=>path.endsWith('-u-' + n + '/entry.json') || path.endsWith('-a-' + n + '/entry.json')))
})

test('full-text search finds originals beyond context/chunk boundaries and character pages reconstruct them without loss', async t => {
  const { service, files, transactions } = await fixture(t)
  const original = '前'.repeat(70_000) + 'Needle Exact 🚀' + '\n尾'.repeat(170_000)
  await service.send('long-original', message('long-original', { text: original }))
  await service.send('second-match', message('second-match', { text: 'Another NEEDLE original' }))
  const other = new FrameworkConversation(files, transactions, { mode: 'git', collaborationId: 'other-scope' })
  await other.send('other', message('foreign-message', { text: 'NEEDLE private scope' }))
  const found = await service.search('needle', 0, 1)
  assert.equal(found.matches.length, 1); assert.equal(found.matches[0]!.message.ref, 'long-original')
  assert.ok(found.matches[0]!.excerpt.includes('Needle Exact 🚀')); assert.equal(found.matches[0]!.excerpt, original.slice(69_900, 70_000 + 6 + 160))
  const next = await service.search('needle', found.nextCursor, 1)
  assert.equal(next.matches[0]!.message.ref, 'second-match'); assert.equal(next.nextCursor, undefined)
  let reconstructed = '', cursor = 0
  for (;;) {
    const page = await service.readText('long-original', cursor)
    assert.equal(page.characters, original.length); assert.equal(page.cursor, cursor); assert.ok(page.text.length <= 32768)
    reconstructed += page.text
    if (page.nextCursor === undefined) break
    cursor = page.nextCursor
  }
  assert.equal(reconstructed, original)
  assert.equal((await service.readText('long-original', original.length)).text, '')
  await assert.rejects(service.readText('foreign-message'), /absent/)
  await assert.rejects(service.readText('long-original', original.length + 1), /cursor/)
  await assert.rejects(service.readText('long-original', 0, 262145), /page/)
  await assert.rejects(service.search('needle', 0, 51), /page/)
  await assert.rejects(service.search(' ', 0, 10), /search/)
})

test('restored search excerpts and explicit character pages match the fixed baseline production implementation', async t => {
  const { loadBaselineModule } = await import('./legacy-baseline.js')
  const { MemoryStorage } = await import('./support.js')
  type Original = { append(a: string, s: string, value: { id: string; role: 'user'; text: string }): Promise<{ ref: string }>;
    search(a: string, query: string, cursor?: number, limit?: number): Promise<{ matches: Array<{ excerpt: string }> }>;
    read(a: string, ref: string, cursor: number, limit: number): Promise<{ text: string; nextCursor?: number }> }
  const module = await loadBaselineModule<{ ConversationStore: new (storage: InstanceType<typeof MemoryStorage>, zone: string) => Original }>('src/application/conversation-store.ts')
  const old = new module.ConversationStore(new MemoryStorage(), 'UTC'), { service } = await fixture(t)
  const original = '历史'.repeat(40_000) + 'ExactMatch' + '🚀结尾'.repeat(20_000)
  const prior = await old.append('assistant', 'session', { id: 'same-original', role: 'user', text: original })
  await service.send('same-original', message('same-original', { text: original }))
  assert.deepEqual((await service.search('exactmatch')).matches.map(item => item.excerpt), (await old.search('assistant', 'exactmatch')).matches.map(item => item.excerpt))
  for (const cursor of [0, 65_530, 80_008, original.length]) {
    const before = await old.read('assistant', prior.ref, cursor, 32768), now = await service.readText('same-original', cursor, 32768)
    assert.equal(now.text, before.text); assert.equal(now.nextCursor, before.nextCursor)
  }
})

for (const mode of ['local', 'git'] as const) test(mode + ' ordinary history remains bidirectional across three days without date filtering', async t => {
  const f = await fixture(t), service = new FrameworkConversation(f.files, f.transactions, { mode, collaborationId: 'date-navigation-' + mode })
  for (const day of [1, 2, 3]) for (const part of [1, 2, 3]) await service.send(`date-${day}-${part}`, message(`${day}-${part}`, { createdAt: `2026-10-0${day}T0${part}:00:00.000Z` }))
  const latest = await service.page(2)
  assert.deepEqual(latest.messages.map(m => m.id), ['3-2', '3-3'])
  const older = await service.page(2, latest.moreBefore)
  assert.deepEqual(older.messages.map(m => m.id), ['2-3', '3-1'])
  const newer = await service.page(2, undefined, { afterId: older.moreAfter })
  assert.deepEqual(newer.messages.map(m => m.id), ['3-2', '3-3'])
})

test('Local calendar starts at the selected day tail and older/newer stay within that day', async t => {
  const f = await fixture(t), service = new FrameworkConversation(f.files, f.transactions, { mode: 'local', collaborationId: 'local-calendar' })
  for (const day of [1, 2, 3]) for (const part of [1, 2, 3]) await service.send(`date-${day}-${part}`, message(`${day}-${part}`, { createdAt: `2026-10-0${day}T0${part}:00:00.000Z` }))
  const selected = await service.page(2, undefined, { date: '2026-10-02' })
  assert.deepEqual(selected.messages.map(m => m.id), ['2-2', '2-3'])
  assert.equal(selected.moreAfter, undefined)
  const older = await service.page(2, selected.moreBefore, { date: '2026-10-02' })
  assert.deepEqual(older.messages.map(m => m.id), ['2-1'])
  assert.equal(older.moreBefore, undefined)
  const newer = await service.page(2, undefined, { date: '2026-10-02', afterId: older.moreAfter })
  assert.deepEqual(newer.messages.map(m => m.id), ['2-2', '2-3'])
  assert.deepEqual((await service.page(2, undefined, { date: '2026-10-04' })).messages, [])
})

test('Git calendar is an inclusive selected-day starting cursor, not a permanent day filter', async t => {
  const f = await fixture(t), service = new FrameworkConversation(f.files, f.transactions, { mode: 'git', collaborationId: 'git-calendar' })
  for (const day of [1, 2, 3]) for (const part of [1, 2, 3]) await service.send(`date-${day}-${part}`, message(`${day}-${part}`, { createdAt: `2026-10-0${day}T0${part}:00:00.000Z` }))
  const selected = await service.page(2, undefined, { date: '2026-10-02' })
  assert.deepEqual(selected.messages.map(m => m.id), ['2-2', '2-3'])
  const older = await service.page(2, selected.moreBefore, { date: '2026-10-02' })
  assert.deepEqual(older.messages.map(m => m.id), ['1-3', '2-1'])
  const oldest = await service.page(2, older.moreBefore, { date: '2026-10-02' })
  assert.deepEqual(oldest.messages.map(m => m.id), ['1-1', '1-2']); assert.equal(oldest.moreBefore, undefined)
  const newer = await service.page(2, undefined, { date: '2026-10-02', afterId: selected.moreAfter })
  assert.deepEqual(newer.messages.map(m => m.id), ['3-1', '3-2'])
  const latest = await service.page(2, undefined, { date: '2026-10-02', afterId: newer.moreAfter })
  assert.deepEqual(latest.messages.map(m => m.id), ['3-3']); assert.equal(latest.moreAfter, undefined)
  assert.deepEqual((await service.page(2, undefined, { date: '2026-10-04' })).messages.map(m => m.id), ['3-2', '3-3'])
  assert.deepEqual((await service.page(2, undefined, { date: '2026-09-30' })).messages, [])
})

test('recent exchanges reuse already checked human headers within their fixed snapshot', async t => {
  const { service, files } = await fixture(t)
  await service.send('input', message('human'))
  await service.send('reply', message('reply', { role: 'assistant', recipient: 'human', replyTo: 'human', text: 'Exact reply' }))
  const read = files.read.bind(files), headers: string[] = []
  files.read = async (snapshot, path) => { if (path.endsWith('/entry.json')) headers.push(path); return read(snapshot, path) }
  const exchanges = await service.recentExchanges()
  assert.equal(exchanges[0].human.text, 'Original 😀\ntext')
  assert.equal(exchanges[0].assistant.text, 'Exact reply')
  assert.equal(headers.length, new Set(headers).size, 'same immutable header is not read twice')
})
