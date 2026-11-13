import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Source-level integration: actual v44 SQLite writer -> actual current runtime
// conversation constructor/services -> installed role tools -> physical files.
// Native model/DSH ownership, Zod and Markdown parser are controlled ports.
const root = new URL('../src/', import.meta.url)
const baseline = new URL('./test-support/historical-v44/conversation-producer/src/', import.meta.url)
const beforeRoot = new URL('./test-support/conversation-before-merge/src/', import.meta.url)
const baselineHashes = JSON.parse(readFileSync(new URL('./test-support/historical-v44/conversation-producer/SOURCE.json', import.meta.url))).files
const hash = value => createHash('sha256').update(value).digest('hex'), loaded = new Map(), oldLoaded = new Map()
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const hooks = registerHooks({
 resolve(specifier, context, next) {
  if (specifier === 'koffi') return { url: new URL('./helpers/fixture-no-replace-koffi.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier === 'zod') return { url: data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`), shortCircuit: true }
  if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(){return {type:'root',children:[]}}`), shortCircuit: true }
  if (specifier.startsWith('.') && context.parentURL?.startsWith(beforeRoot.href) && specifier.endsWith('.js')) return { url: new URL('framework/' + specifier.slice(2, -3) + '.ts', root).href, shortCircuit: true }
  if (specifier.startsWith('.') && [root, baseline].some(base => context.parentURL?.startsWith(base.href)) && specifier.endsWith('.js')) {
   const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
   if (url.href === new URL('framework/skills.ts', root).href) return { url: data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw Error('Not a skill test')}export function prepareFrameworkSkillIndex(){throw Error('Not a skill test')}`), shortCircuit: true }
   if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
 },
 load(url, context, next) {
  const base = [root, baseline, beforeRoot].find(base => url.startsWith(base.href))
  if (base && url.endsWith('.ts')) {
   const source = readFileSync(new URL(url), 'utf8'), relative = url.slice(base.href.length), sum = hash(source)
   if (base === baseline) { assert.equal(sum, baselineHashes['src/' + relative], 'Exact v44 source: ' + relative); oldLoaded.set(relative, sum) }
   else loaded.set(base === beforeRoot ? 'pre-fix/' + relative : relative, sum)
   return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
 }
})
const { restoreLegacyConversationScope: previousRestore } = await import(new URL('framework/local-upgrade-conversation.ts', beforeRoot))
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { LegacyLocalConversationView } = await import('../src/framework/legacy-local-conversation-view.ts')
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { prepareLocalConversation, restoreLegacyConversationScope, localConversationUpgradeKey } = await import('../src/framework/local-upgrade-conversation.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { GitAuthorityStore } = await import('../src/framework/git-authority.ts')
const { withOperationChannel, withSnapshot } = await import('../src/framework/transactions.ts')
const { FrameworkConversation: OldConversation } = await import(new URL('framework/conversation.ts', baseline))
const { FrameworkTransactions: OldTransactions } = await import(new URL('framework/command-transactions.ts', baseline))
const { LocalFiles: OldFiles } = await import(new URL('framework/local-files.ts', baseline))
class Records {
 constructor(directory) { this.files = new LocalRecordFiles(directory); this.onSet = undefined }
 async get(key) { const raw = await this.files.read(hash(key) + '.json'); return raw === undefined ? undefined : JSON.parse(raw) }
 async set(key, value) { await this.files.replace(hash(key) + '.json', JSON.stringify(value)); await this.onSet?.(key, value) }
 async delete(key) { return this.files.delete(hash(key) + '.json') }
 async list() { throw Error('The addressed conversation must not scan all Host records') }
}
const names = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const read = (files, pathname) => withSnapshot(files, snapshot => files.read(snapshot, pathname))
const firstId = process.argv.includes('--escaped-old-id') ? '字/!.' : 'first'
const scope = { mode: 'local', collaborationId: 'old-chat' }, ids = [firstId, 'second', 'third']
const originalTexts = ['\uFEFF原文😀\r\n\0keep', '', '后来的输入'], memoryRoot = 'assistants/collaborations/local/old-chat'
const disk = directory => new Records(directory + '-records')
async function seed(directory) {
 const files = await OldFiles.open(directory), records = disk(directory), transactions = new OldTransactions(files, records, 'v44-source')
 const old = new OldConversation(files, transactions, scope)
 for (let i = 0; i < ids.length; i++) await old.send('v44-' + ids[i], { id: ids[i], participantId: 'old-user', createdAt: `2026-11-07T00:00:0${i}.000Z`, role: 'user', recipient: 'ai', text: originalTexts[i] })
 await old.writeForeground('v44-memory', { list: '原待办\r\n保留', cache: '原随记😀\n' })
 await old.saveProcessGroups('v44-process', [{ id: 'old-process', turnId: 'old-turn', startedAt: '2026-11-07T00:00:00.000Z', closed: true }], 'old-user')
 await files.close()
 return records
}
const runtimeSource = readFileSync(new URL('framework/role-runtime.ts', root), 'utf8'), runtimeJs = stripTypeScriptTypes(runtimeSource, { mode: 'transform' })
loaded.set('framework/role-runtime.ts', hash(runtimeSource))
function method(js, name) {
 const match = new RegExp('\\n    (?:async )?' + name + '\\(').exec(js); assert(match, name)
 const start = match.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start + match[0].length)); assert(next, name)
 return js.slice(start, start + match[0].length + next.index)
}
const dependencies = { PhysicalLocalFiles, GitAuthorityStore, withOperationChannel }
const Runtime = new Function(...Object.keys(dependencies), 'return class {\n' + ['services', 'saveForegroundProcessGroups', 'flushForegroundProcessWrites'].map(name => method(runtimeJs, name)).join('\n') + '\n}')(...Object.values(dependencies))
const constructorStatement = /this\.conversation = new FrameworkConversation\([\s\S]*?;/.exec(runtimeJs)[0]
const constructConversation = new Function('files', 'config', 'records', 'FrameworkConversation', 'prepareLocalConversation', constructorStatement)
const serviceSource = readFileSync(new URL('framework/service.ts', root), 'utf8'), serviceJs = stripTypeScriptTypes(serviceSource, { mode: 'transform' })
loaded.set('framework/service.ts', hash(serviceSource))
const Service = new Function('withOperationChannel', 'return class {\n' + ['prepareConversationWrite', 'conversationReader', 'history', 'checkScope'].map(name => method(serviceJs, name)).join('\n') + '\n}')(withOperationChannel)
function runtime(directory, records = disk(directory), collaborationId = scope.collaborationId) {
 const files = new PhysicalLocalFiles(directory), transactions = { run() { throw Error('Physical conversation used a generic SQL/Git transaction') } }
 const binding = { role: 'Foreground', workId: 'foreground', executionId: 'native-foreground', owner: 'host', collaborationId }
 const owner = { identity: binding, sessionId: 'native-session', generation: 1 }
 const actualAgent = { id: 'agent', session: { id: 'native-session', requestContext: () => ({ model: 'actual-source-model' }), snapshotEvents: () => [], inputs: new Map() } }
 const rt = Object.assign(new Runtime(), { files, records, transactions, config: { ...scope, collaborationId, member: 'host', primary: true }, native: { get: () => ({ actualAgent }) }, controls: { recordPath: 'no-control' }, environment: {}, roleRecords: new Map([[binding.workId, owner]]), conversationSendSources: new Map(), closed: false,
  physicalSignalSources: async () => [], conversationError(error) { throw error }, saveRole: async () => {}, notifications: async () => [], consumeWakeSignals: async () => ({ signals: [] }) })
 // Execute the exact constructor statement, not a test-authored substitute hook.
 constructConversation.call(rt, files, rt.config, records, FrameworkConversation, prepareLocalConversation)
 return { files, records, rt, binding, owner, actualAgent, conversation: rt.conversation, service: rt.services(), close: () => files.close() }
}
function toolsFor(f) {
 const registered = new Map(), effects = [], ctx = { on: () => () => {}, effect: callback => effects.push(callback()), systemPrompt: { section() {} }, tools: { register: tool => registered.set(tool.name, tool) } }
 installFrameworkRoleTools(ctx, f.actualAgent, f.binding, f.service)
 let calls = 0
 return { call: (name, input) => registered.get(name).execute(input, { agent: f.actualAgent, callId: 'call-' + ++calls, signal: new AbortController().signal, concludeTurn() {} }), close: () => Promise.all(effects.map(callback => callback?.())) }
}
const reply = (id = 'new-reply') => ({ id, text: 'New visible user-facing reply😀', responsePhase: 'final', intent: 'human' })
const scratch = process.argv[2] === '--interrupt' ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), 'dss-conversation-boundary-'))
if (process.argv[2] === '--interrupt') {
 const directory = process.argv[3], phase = process.argv[4], records = disk(directory)
 if (phase === 'index-save') records.onSet = (_key, value) => { if (value.kind === 'dss-once-conversation-full-text' && value.indexRestored && value.status !== 'complete') process.exit(86) }
 await restoreLegacyConversationScope(directory, scope.collaborationId, records, { onProgress: p => {
  if (phase === 'body' && p.path.endsWith('/text.txt') && p.step === 'published' || phase === 'context' && p.path.startsWith('conversation-context/') && p.step === 'published') process.exit(86)
 } })
 throw Error('Interruption was not reached')
}
try {
 const converterJs = stripTypeScriptTypes(readFileSync(new URL('framework/local-upgrade-conversation.ts', root), 'utf8'), { mode: 'transform' })
 const mergeCode = converterJs.slice(converterJs.indexOf('function mergeOriginalIndex('), converterJs.indexOf('async function restoreConversationOriginals('))
 const merge = new Function('logical', mergeCode + '; return mergeOriginalIndex')(value => value.replace(/^dss-coop\//, ''))
 const row = id => ({ id, path: 'conversations/local/' + id + '/entry.json' }), timeline = messages => ({ version: 1, messages: messages.map(row) })
 check('Actual merge keeps current interleaving while filling original gaps', merge(timeline(['a', 'b', 'c', 'd']), timeline(['a', 'new', 'c', 'tail']), true).messages.map(value => value.id), ['a', 'new', 'b', 'c', 'd', 'tail'])
 const longIds = Array.from({ length: 20000 }, (_, i) => 'old-' + i)
 const large = merge(timeline(longIds), timeline(['new']), true)
 check('Actual source merge retains long original order without a history limit', large.messages.map(value => value.id), [...longIds, 'new'])
 check('Published source index deletion is not treated as a blank migration target', merge(timeline(['a']), undefined, false).messages, [])
 const fresh = runtime(path.join(scratch, 'blank'))
 await fresh.service.conversation.send(reply(), fresh.binding, 'blank-reply')
 check('Blank actual runtime send needs no SQL/model/Host upgrade', (await fresh.service.conversation.read({ mode: 'page', limit: 10 }, fresh.binding)).messages.map(row => row.id), ['new-reply'])
 check('Blank scope creates no SQL source', existsSync(path.join(fresh.files.directory, 'dss-files.sqlite')), false)
 await fresh.close()
 const oldDir = path.join(scratch, 'old'), records = await seed(oldDir), sqlHash = hash(await fs.readFile(path.join(oldDir, 'dss-files.sqlite'))), old = runtime(oldDir, records), installed = toolsFor(old)
 if (process.argv.includes('--escaped-old-id')) {
  const oldFiles = await OldFiles.open(oldDir)
  const producedIndex = JSON.parse(await read(oldFiles, 'conversation-index/local/old-chat/index.json'))
  check('Frozen v44 writer actually used escaped old ID path', producedIndex.messages[0].path.includes('/escaped/'), true)
  await oldFiles.close()
 }
 check('Actual installed read sees all v44 originals', (await installed.call('dss_conversation_read', { mode: 'page', limit: 10 })).messages.map(row => row.id), ids)
 for (let i = 0; i < ids.length; i++) check('Actual original text is unchanged ' + ids[i], (await old.service.conversation.read({ mode: 'message', reference: ids[i] }, old.binding)).text, originalTexts[i])
 check('Foreground old memory is initialized before read', await installed.call('dss_conversation_read', { mode: 'memory' }), { list: '原待办\r\n保留', cache: '原随记😀\n' })
 await installed.call('dss_conversation_send', reply())
 check('Actual installed send follows restored original order', (await old.conversation.page(10)).order, [...ids, 'new-reply'])
 check('Original SQL remains byte-identical', hash(await fs.readFile(path.join(oldDir, 'dss-files.sqlite'))), sqlHash)
 check('Old context + new final retain correct round', (await old.conversation.foregroundContext()).rounds[0].messageIds, [...ids, 'new-reply'])
 await installed.close(); await old.close()

 const sendDir = path.join(scratch, 'send-first'), sendRecords = await seed(sendDir), sendFirst = runtime(sendDir, sendRecords)
 await sendFirst.service.conversation.send(reply(), sendFirst.binding, 'first-native-send')
 check('First actual runtime send restores originals before accepting new message', (await sendFirst.conversation.page(10)).order, [...ids, 'new-reply'])
 await sendFirst.close()

 // Reproduce the audited pre-fix early-send history, then enter current runtime.
 const mixedDir = path.join(scratch, 'mixed'), mixedRecords = await seed(mixedDir), raw = new PhysicalLocalFiles(mixedDir), unhooked = new FrameworkConversation(raw, {}, scope)
 await unhooked.send('early-send', { ...reply(), recipient: 'human', participantId: 'host', createdAt: '2026-11-08T00:00:00.000Z', role: 'assistant' })
 const priorIndex = JSON.parse(await read(raw, unhooked.indexPath)), newPath = priorIndex.messages[0].path
 const newEntry = JSON.parse(await read(raw, newPath)); await raw.replace(newEntry.textPath, '用户已编辑的新正文\r\n')
 await raw.replace(memoryRoot + '/Foreground_Cache.md', '用户的新随记')
 check('Actual pre-fix converter reproduced its false completion', (await previousRestore(mixedDir, scope.collaborationId, mixedRecords)).status, 'complete')
 check('Actual pre-fix physical view still omits SQL originals', (await unhooked.page(10)).order, ['new-reply'])
 await raw.close()
 const mixed = runtime(mixedDir, mixedRecords)
 check('Mixed early-send runtime read restores known old IDs before new', (await mixed.service.conversation.read({ mode: 'page', limit: 10 }, mixed.binding)).order, [...ids, 'new-reply'])
 check('Mixed early-send user-edited body survives', (await mixed.conversation.read('new-reply')).text, '用户已编辑的新正文\r\n')
 check('Mixed new metadata bytes survive', JSON.parse(await read(mixed.files, newPath)), newEntry)
 check('Mixed physical memory edit survives', (await mixed.conversation.readForeground()).cache, '用户的新随记')
 check('Mixed context rejoins old inputs to explicit new final', (await mixed.conversation.foregroundContext()).rounds[0].messageIds, [...ids, 'new-reply'])
 const groupsBefore = (await mixed.conversation.page(10)).processGroups
 mixed.rt.saveForegroundProcessGroups(mixed.owner, { durableSnapshot: () => [{ id: 'new-process', turnId: 'new-turn', startedAt: '2026-11-08T00:00:00.000Z', closed: true }] })
 await mixed.rt.flushForegroundProcessWrites(mixed.owner.sessionId)
 check('Actual runtime process metadata preserves old groups', (await mixed.conversation.page(10)).processGroups.map(g => g.id), [...groupsBefore.map(g => g.id), 'new-process'])
 await mixed.close()

 // Before index exposure, a physical handoff resumes through its existing
 // publication owner and then joins old source chronology, without a new journal.
 const pendingDir = path.join(scratch, 'pending-send'), pendingRecords = await seed(pendingDir), pf = new PhysicalLocalFiles(pendingDir), pc = new FrameworkConversation(pf, {}, scope)
 const replace = pf.replace.bind(pf); let broken = false
 pf.replace = async (p, bytes) => { if (p === pc.contextPath && !broken) { broken = true; throw Error('Controlled interrupted accepted send') } return replace(p, bytes) }
 await assert.rejects(() => pc.send('pending', { ...reply(), participantId: 'host', createdAt: '2026-11-08T00:00:00.000Z', role: 'assistant', recipient: 'human' }), /Controlled interrupted/)
 check('Interrupted early physical send retains its actual handoff', !!JSON.parse(await read(pf, pc.indexPath)).publication, true)
 await pf.close(); const pending = runtime(pendingDir, pendingRecords)
 check('Runtime resumes accepted send and restores original order', (await pending.service.conversation.read({ mode: 'page', limit: 10 }, pending.binding)).order, [...ids, 'new-reply'])
 check('Existing physical handoff retires after merge', JSON.parse(await read(pending.files, pending.conversation.indexPath)).publication, undefined)
 await pending.close()

 const processDir = path.join(scratch, 'process-first'), processRecords = await seed(processDir), processFirst = runtime(processDir, processRecords)
 processFirst.rt.saveForegroundProcessGroups(processFirst.owner, { durableSnapshot: () => [{ id: 'first-runtime-process', turnId: 'new', startedAt: '2026-11-08T00:00:00.000Z', closed: true }] })
 await processFirst.rt.flushForegroundProcessWrites(processFirst.owner.sessionId)
 check('Process-group first caller cannot create an empty replacement index', (await processFirst.conversation.page(10)).order, ids)
 check('Process-group first caller keeps original process groups', (await processFirst.conversation.page(10)).processGroups.map(row => row.id), ['old-process', 'first-runtime-process'])
 await processFirst.close()

 const clearDir = path.join(scratch, 'clear-first'), clearRecords = await seed(clearDir), clear = runtime(clearDir, clearRecords)
 let resetDone = false
 const cleanup = new FrameworkManualCleanup(clear.files, {}, clear.conversation, { isForegroundResetComplete: async () => resetDone, withForegroundReset: async (_id, action) => { const result = await action([], []); resetDone = true; return result } })
 check('Planning preview restores exact original memory file selection', (await cleanup.previewFiles('planning')).files.map(row => row.path).sort(), [memoryRoot + '/Foreground_Cache.md', memoryRoot + '/Foreground_List.md'])
 const cleared = await cleanup.clearConversation('clear-old-originals', 'clear-foreground-conversation')
 check('Actual reset plan selects restored original message bodies', cleared.deletedPaths.filter(p => p.endsWith('/entry.json')).length, 3)
 check('Actual reset clears selected restored originals', (await clear.conversation.page(10)).order, [])
 await clear.close(); const reopened = runtime(clearDir, clearRecords)
 check('Cold scope never replays cleared original SQL after completed conversion', (await reopened.conversation.page(10)).order, [])
 check('Explicit physical cleanup leaves source SQL unchanged', existsSync(path.join(clearDir, 'dss-files.sqlite')), true)
 await reopened.close()

 // Exact file tools must restore the memory even if conversation tool not used.
 const memoryDir = path.join(scratch, 'direct-memory'), memoryRecords = await seed(memoryDir), memory = runtime(memoryDir, memoryRecords), mt = toolsFor(memory)
 const view = await mt.call('dss_snapshot', {})
 const readMemory = await mt.call('dss_read', { snapshotId: view.snapshotId, path: memoryRoot + '/Foreground_List.md' })
 check('Actual dss_read restores old memory before first file read', readMemory.text, '原待办\r\n保留')
 await mt.close(); await memory.close()
 const appendDir = path.join(scratch, 'direct-append'), appendRecords = await seed(appendDir), append = runtime(appendDir, appendRecords), at = toolsFor(append)
 const av = await at.call('dss_snapshot', {})
 await at.call('dss_record', { snapshotId: av.snapshotId, path: memoryRoot + '/Foreground_Cache.md', text: '新条目', append: true })
 check('Actual dss_record append preserves old memory on first use', await read(append.files, memoryRoot + '/Foreground_Cache.md'), '原随记😀\n新条目')
 await at.close(); await append.close()

 // A confirmed planning cleanup survives restart while normal Foreground
 // tools use the runtime's actual constructor-installed preparation callback.
 // Preparation is shared for this conversation; independent Task writes do not
 // join it, and a later real dss_record append remains outside the old preview.
 {
  const directory = path.join(scratch, 'planning-startup-overlap'), records = await seed(directory), original = runtime(directory, records)
  const cleanup = new FrameworkManualCleanup(original.files, { run() { throw Error('Unexpected cleanup transaction') } }, original.conversation, {})
  const preview = await cleanup.previewFiles('planning'), first = preview.files[0].path
  check('Reviewed planning first file is the actual Foreground Cache', first, memoryRoot + '/Foreground_Cache.md')
  const originalUpdate = original.files.updateAsync.bind(original.files), interrupted = new Error('Confirmed planning action interrupted')
  original.files.updateAsync = async (target, ...args) => { if (target === first) throw interrupted; return originalUpdate(target, ...args) }
  await assert.rejects(cleanup.clearPlanning('planning-overlap', 'clear-work-planning-notes', preview), error => error === interrupted)
  await original.close()
  const current = runtime(directory, records), tools = toolsFor(current)
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
  const prepared = deferred(), allowPrepare = deferred(), selected = deferred(), allowCleanup = deferred()
  const originalGet = records.get.bind(records); let preparationReads = 0
  records.get = async key => {
   if (key === localConversationUpgradeKey(directory, scope.collaborationId)) { preparationReads++; prepared.resolve(); await allowPrepare.promise }
   return originalGet(key)
  }
  const update = current.files.updateAsync.bind(current.files)
  current.files.updateAsync = async (target, ...args) => { if (target === first) { selected.resolve(); await allowCleanup.promise } return update(target, ...args) }
  const resumed = new FrameworkManualCleanup(current.files, { run() { throw Error('Unexpected cleanup transaction') } }, current.conversation, {})
  let fileWork
  await resumed.resumePending(undefined, resume => { fileWork = resume(new AbortController().signal) })
  await prepared.promise
  const snapshot = await tools.call('dss_snapshot', {})
  let wrote = false
  const append = tools.call('dss_record', { snapshotId: snapshot.snapshotId, path: first, text: '并发新随记', append: true }).then(result => { wrote = true; return result })
  await current.files.replace('task-runs/independent/notes.md', 'independent Task progresses')
  await new Promise(resolve => setImmediate(resolve))
  check('Foreground file tool waits only for its same-conversation preparation', wrote, false)
  check('Cleanup and installed Foreground tool share original preparation', preparationReads, 1)
  check('Unrelated Task write does not await conversation preparation', await read(current.files, 'task-runs/independent/notes.md'), 'independent Task progresses')
  allowPrepare.resolve(); await selected.promise; await append
  check('Actual dss_record append completes while old planning deletion is pending', await read(current.files, first), '原随记😀\n并发新随记')
  allowCleanup.resolve(); await fileWork
  check('Resumed planning preserves later actual Foreground tool write', await read(current.files, first), '原随记😀\n并发新随记')
  check('Resumed planning clears only unchanged reviewed List', await read(current.files, memoryRoot + '/Foreground_List.md'), '')
  check('Planning overlap retires the existing intent', (await withSnapshot(current.files, s => current.files.listDirectory(s, 'technical/manual-cleanup/intents/'))).length, 0)
  await tools.close(); await current.close()
  records.get = originalGet
  const cold = runtime(directory, records)
  check('Cold preparation does not resurrect the cleared original List', (await cold.conversation.readForeground()).list, '')
  check('Cold preparation preserves the newer Foreground Cache', (await cold.conversation.readForeground()).cache, '原随记😀\n并发新随记')
  await cold.close()
 }

 // The actual UI history port changes readers after a runtime-only restore.
 // A real destination conflict still leaves the old SQL history readable.
 const uiDir = path.join(scratch, 'ui-history'), uiRecords = await seed(uiDir), ui = runtime(uiDir, uiRecords)
 const originalIndex = await new LegacyLocalConversationView(uiDir, scope.collaborationId).page(10)
 const { withLegacySqliteSnapshot } = await import('../src/framework/legacy-sqlite-reader.ts')
 const conflictPath = await withLegacySqliteSnapshot(path.join(uiDir, 'dss-files.sqlite'), async source => JSON.parse(Buffer.from((await source.read(ui.conversation.indexPath)).bytes).toString()).messages[0].path.replace('entry.json', 'text.txt'))
 await ui.files.replace(conflictPath, 'Physical unrelated current content')
 const access = { conversation: ui.conversation, legacyConversation: new LegacyLocalConversationView(uiDir, scope.collaborationId), connection: { files: ui.files, scope: 'ui-scope' } }
 const reported = [], uiService = Object.assign(new Service(), { access: async () => access, config: () => ({ settings: scope }), report: (_mode, error) => reported.push(error.message) })
 const historyInput = { mode: 'local', collaborationId: scope.collaborationId, storageScope: 'ui-scope', limit: 10 }
 check('Actual UI history retains read-only originals during destination conflict', (await uiService.history(historyInput)).messages.map(row => row.id), ids)
 check('UI restoration error is reported instead of hidden', reported.some(message => message.includes('incomplete')), true)
 const input = reply('not-sent'); await assert.rejects(() => ui.service.conversation.send(input, ui.binding, 'not-sent'), /incomplete/)
 check('Rejected send leaves exact user input intact', input, reply('not-sent'))
 check('Original physical conflict is retained', await read(ui.files, conflictPath), 'Physical unrelated current content')
 await ui.files.delete(conflictPath)
 await ui.service.conversation.send(reply(), ui.binding, 'ui-runtime-send')
 check('Actual UI history switches after runtime-only restore', (await uiService.history(historyInput)).order, [...ids, 'new-reply'])
 check('Successful UI cutover retires its legacy-only reader', access.legacyConversation, undefined)
 await ui.close()

 // Same-scope callers join; a held scope never holds another scope or ordinary file.
 const heldDir = path.join(scratch, 'held'), heldRecords = await seed(heldDir), held = runtime(heldDir, heldRecords)
 let release, reached; const pause = new Promise(r => release = r), arrived = new Promise(r => reached = r)
 heldRecords.onSet = async (_key, value) => { if (value.kind === 'dss-once-conversation-full-text' && value.converted.length === 0) { reached(); await pause } }
 const reading = held.service.conversation.read({ mode: 'page', limit: 10 }, held.binding); await arrived
 let sent = false; const sending = held.service.conversation.send(reply(), held.binding, 'held-send').then(() => sent = true)
 const independent = runtime(heldDir, heldRecords, 'independent')
 await independent.service.conversation.send(reply('independent-message'), independent.binding, 'independent-send')
 await held.files.replace('task-runs/independent/ordinary.md', 'Independent task progress')
 check('Different conversation and Task proceed while one source is held', [sent, await read(held.files, 'task-runs/independent/ordinary.md')], [false, 'Independent task progress'])
 heldRecords.onSet = undefined; release(); await Promise.all([reading, sending])
 check('Same-scope concurrent send follows originals exactly once', (await held.conversation.page(10)).order, [...ids, 'new-reply'])
 await independent.close(); await held.close()

 for (const phase of ['body', 'context', 'index-save']) {
  const directory = path.join(scratch, 'interrupt-' + phase); await seed(directory)
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), '--interrupt', directory, phase,
   ...(process.argv.includes('--escaped-old-id') ? ['--escaped-old-id'] : [])], { encoding: 'utf8', timeout: 30000 })
  check('Real process interruption at ' + phase, child.status, 86)
  const f = runtime(directory)
  let editedPath
  if (phase === 'context') {
   editedPath = await withLegacySqliteSnapshot(path.join(directory, 'dss-files.sqlite'), async source => JSON.parse(Buffer.from((await source.read(f.conversation.indexPath)).bytes).toString()).messages[0].path)
   const entry = JSON.parse(await read(f.files, editedPath)); await f.files.replace(entry.textPath, 'User edit during interrupted restoration')
   await f.files.replace(editedPath, JSON.stringify({ ...entry, userNote: 'Preserve my metadata' }))
  }
  check('Cold actual runtime resumes source after ' + phase, (await f.service.conversation.read({ mode: 'page', limit: 10 }, f.binding)).order, ids)
  if (editedPath) {
   check('Cold restoration preserves edited original body', (await f.conversation.read(firstId)).text, 'User edit during interrupted restoration')
   check('Cold restoration preserves original metadata edit', JSON.parse(await read(f.files, editedPath)).userNote, 'Preserve my metadata')
  }
  await f.service.conversation.send(reply(), f.binding, phase + '-send')
  check('Cold resumed send has no duplicate originals ' + phase, (await f.conversation.page(10)).order, [...ids, 'new-reply'])
  await f.close()
 }
 // Current completion is final: user removals and metadata edits stay ordinary.
 const completed = runtime(oldDir), index = JSON.parse(await read(completed.files, completed.conversation.indexPath))
 index.messages = index.messages.filter(row => row.id !== firstId); await completed.files.replace(completed.conversation.indexPath, JSON.stringify(index))
 await new Service().prepareConversationWrite({ conversation: completed.conversation, legacyConversation: {} })
 check('Service preparation never resurrects post-conversion user deletion', (await completed.conversation.page(10)).order, ['second', 'third', 'new-reply'])
 await completed.close()
 console.log(JSON.stringify({ status: 'passed', assertions: names.length, names, runtime: process.version, platform: process.platform,
  sourceHashes: Object.fromEntries([...loaded].sort()), exactV44ProducerHashes: Object.fromEntries([...oldLoaded].sort()), scriptHash: hash(readFileSync(fileURLToPath(import.meta.url))),
  limits: 'Actual v44 producer/current conversion/runtime constructor/services/installed tools on controlled Linux. Native DSH/model, Windows, UI, full dependency typecheck and power-loss durability are not tested.' }, null, 2))
} finally { hooks.deregister(); if (scratch) await fs.rm(scratch, { recursive: true, force: true }) }
