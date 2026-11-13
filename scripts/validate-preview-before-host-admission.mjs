// Local cleanup through actual Service/Host/tool methods; native agents and
// Session persistence are controlled ports, not a Git or live-model check.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { evidence, hash } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { FrameworkService } = await import('../src/framework/service.ts')
const { FrameworkClientController } = await import('../src/framework/client-contracts.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { Context } = await import('@deepseek-ai/cordis')
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'foreground-wake-retirement-'))
const opened = []
const tick = () => new Promise(setImmediate)
let sequence = 0
async function fixture(name) {
  const mode = 'local'
  const dir = path.join(scratch, mode + '-' + name), sdk = await openDshStorageFixture(path.join(dir, 'technical'), path.join(dir, 'locator'))
  const files = new PhysicalLocalFiles(path.join(dir, 'files'))
  const records = sdk.adapter, tx = new FrameworkTransactions(files, records, name)
  const conversation = new FrameworkConversation(files, tx, { mode, collaborationId: name })
  const rt = Object.create(FrameworkRoleRuntime.prototype), errors = [], retirements = [], sessions = new Map(), handles = new Map()
  const projection = new Context(); new SessionProjectionRegistry(projection)
  projection.provide('agents', { setFactory: () => () => {} }); projection.provide('systemPrompt', { variable() {} })
  new AgentLoop(projection, { agents: [], maxParallelToolCalls: 1 })
  const add = (owned, type, data, extra = {}) => { const event = { type, data, seq: owned.events.length, time: Date.now(), ...extra }; owned.events.push(event); return event }
  const native = {
    get(workId) { return handles.get(workId) },
    async open(identity, options) {
      let owned = handles.get(identity.workId)
      if (owned?.sessionId === options.sessionId) return owned
      const events = [], session = { id: options.sessionId, header: {}, inheritedEventCount: 0, snapshotEvents: () => structuredClone(events), requestContext: () => ({}) }
      const actual = { id: options.sessionId, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
      owned = { identity, events, sessionId: options.sessionId, actualAgent: actual, observe: () => ({ state: actual.status }),
        hasMessage: id => events.some(event => event.type === 'user/message' && event.data.id === id),
        async send(text, id, delivery) {
          if (!owned.hasMessage(id)) {
            if (delivery !== 'inject') { add(owned, 'turn/start', { turn: 1 }); actual.status = 'running' }
            add(owned, 'user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'deepseek-servant' } }, { surfaceOp: 'append' })
          }
        } }
      sessions.set(options.sessionId, session); handles.set(identity.workId, owned); return owned
    },
    async stop(workId) { const owned = handles.get(workId); if (owned) owned.actualAgent.status = 'idle'; handles.delete(workId); return { status: 'stopped' } },
  }
  const config = { scope: name, mode, member: 'A', primary: true, instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', collaborationId: name, workerSeats: 1, workspace: dir }
  const ctx = { agents: { get: () => undefined }, sessions: { get: id => sessions.get(id), flush: async () => {} }, jobs: { list: () => [] },
    get: key => key === 'sessionProjections' ? projection.sessionProjections : key === 'sessionPersistence' ? { stat: async id => sessions.has(id) ? { sizeBytes: 1 } : undefined }
      : key === 'nativeSessionCleaner' ? { async retire(id) { retirements.push(id) } } : key === 'jobs' ? { list: () => [] } : undefined }
  Object.assign(rt, { files, records, transactions: tx, conversation, config, ctx, native, prefix: 'framework-runtime/' + hash(name) + '/',
    gateway: { exists: async id => sessions.has(id) }, workspaces: { hasBinding: () => false },
    environment: { members: () => ['A'], resources: () => [], changed() {} }, error: error => errors.push(error), ownedAsyncContext: AsyncLocalStorage.snapshot(),
    roleRecords: new Map(), roleBases: new Map(), roleWrites: new Map(), roleWriteOwners: new Map(), wakeWrites: new Map(), wakeWriteOwners: new Map(), wakeConsumptions: new Map(),
    safetyEpisodes: new Map(), safetyReplayed: new Set(), safetySettlements: new Map(), resolvedSafetyFaultIds: new Set(), gitPriorExecutions: new Set(),
    admissions: new Map(), admissionCancellations: new Map(), localWakeAdmissions: new Map(), admissionObservationVersion: 0, admissionNow: () => Date.now(), workOperations: new Map(), observationRecordWrites: new Map(), stopOperations: new Map(),
    restoreWriteOwners: new Map(), safetyRestoreWrites: new Map(), publishedHelperSignals: new Set(), conversationSendSources: new Map(),
    foregroundProcesses: new Map(), taskNotices: new WeakMap(), taskNoticeObservations: new WeakMap(), taskNoticeClock: 0,
    controls: { execution: async () => undefined }, observations: { unbind: async () => {} }, pendingControlStops: [], closed: false,
  })
  const service = Object.assign(Object.create(FrameworkService.prototype), { modeSending: new Map(), modeConfiguration: new Map(), conversationBarriers: new Map(), archiveViews: new Map(), saved: new Map(), initializing: Promise.resolve(), running: new Map([['local', { runtime: rt }]]),
    assertOpen() {}, checkScope() {}, config: () => ({ settings: { collaborationId: name, userName: 'A' } }),
    access: async () => ({ conversation, connection: { files, records, transactions: tx, scope: name, prepareWrite: async () => {}, identity: { login: 'A', instanceUUID: config.instanceUUID } } }),
    prepareConversationWrite: async () => {}, changed() {} })
  const client = new FrameworkClientController({ send: input => service.send(input) })
  const host = new FrameworkHostLoop(files, tx, records, config, () => ['A'], { startup: async () => {}, observe: async () => {}, executing: role => rt.executing(role),
    wake: request => rt.wake(request), notifyForeground: sources => rt.notifyForeground(sources), error: error => errors.push(error) })
  const own = () => rt.roleRecords.get(rt.roleKey('Foreground'))
  const drain = async () => { for (;;) { const work = [...rt.nativeRetirementOperations?.values() ?? [], ...rt.roleWrites.values(), ...rt.wakeWrites.values(), ...rt.stopOperations.values()].map(value => value?.promise ?? value); if (!work.length) break; await Promise.allSettled(work); for (const [key, value] of rt.stopOperations) if (value.settled) rt.stopOperations.delete(key); await tick() } }
  const call = async (name, args) => {
    const owner = own(), owned = native.get(owner.identity.workId), tools = new Map(), toolContext = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
    installFrameworkRoleTools(toolContext, owned.actualAgent, rt.binding(owner, owner.delivery.request), rt.services())
    const callId = 'call-' + ++sequence
    add(owned, 'tool/call', { callId, name, arguments: JSON.stringify(args), turn: 1, step: 0 })
    const result = await tools.get(name).execute(args, { agent: owned.actualAgent, callId, signal: new AbortController().signal, concludeTurn() {} })
    add(owned, 'tool/result', { message: { id: 'result-' + callId, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }] }, turn: 1, step: 0 }, { surfaceOp: 'append' })
    return result
  }
  const f = { client, rt, records, files, tx, sdk, native, host, call, own, drain, errors, retirements, sessions, handles,
    wakeKey: () => rt.prefix + 'wakes/' + hash(own().delivery.request.id), read: p => withSnapshot(files, s => files.read(s, p)),
    async close() { await drain(); await host.stop(); await files.close?.(); await sdk.close() } }
  opened.push(f); return f
}
try {
  const f = await fixture('preview-before-foreground-host-claim')
  const cleanup = new FrameworkManualCleanup(f.files, f.tx, f.rt.conversation, f.rt)
  const id = 'preview-edge-A'
  await f.client.send({ mode: 'local', collaborationId: f.rt.config.collaborationId, id,
    createdAt: '2026-11-11T00:00:00.000Z', text: 'A: please answer', recipient: 'ai',
    device: 'controlled-client', timezoneOffsetMinutes: 0 })
  const before = await f.rt.conversation.page(10)
  const preview = await cleanup.previewConversation()
  assert.equal(preview.foreground, undefined, 'no FG before actual Host signal poll')
  assert(before.messages.some(m => m.id === id))
  await Promise.all(await f.host.runSignalPoll())
  await f.rt.runQueue()
  const ownerBefore = f.own()
  assert(ownerBefore, 'Host and Runtime admitted actual FG')
  const claim = await f.call('dss_claim', {})
  const read = await f.call('dss_conversation_read', { mode: 'context' })
  assert(JSON.stringify(read).includes('A: please answer'))
  const actualAgent = f.native.get(ownerBefore.identity.workId).actualAgent
  const registered = new Map(), toolContext = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => registered.set(tool.name, tool) } }
  installFrameworkRoleTools(toolContext, actualAgent, f.rt.binding(ownerBefore, ownerBefore.delivery.request), f.rt.services())
  const oldSend = registered.get('dss_conversation_send')
  const cleared = await cleanup.clearConversation('preview-edge-clear','clear-foreground-conversation',preview)
  const ownerAfter = f.own()
  const afterClear = await f.rt.conversation.page(10)
  let published
  try { published = await oldSend.execute({id:'preview-edge-A-answer',text:'A answer after user cleared A', intent:'human',responsePhase:'final',replyTo:id},
    {agent:actualAgent,callId:'late-send',signal:new AbortController().signal,concludeTurn(){}}) }
  catch (error) { published = {error:error?.message} }
  const afterPublish = await f.rt.conversation.page(10)
  assert.equal(ownerAfter, undefined, 'accepted selected A owner is stopped and released')
  assert.deepEqual(afterClear.messages.map(m=>m.id),[])
  assert.deepEqual(afterPublish.messages.map(m=>m.id),[])
  assert(published?.error, 'the previously registered tool binding cannot publish after the clear')
  assert.deepEqual((await f.records.list(f.rt.prefix+'wakes/')).map(row=>row.key),[], 'confirmed selected A wake is retired')
  console.log(JSON.stringify({preview,ownerBefore:{executionId:ownerBefore.identity.executionId,sessionId:ownerBefore.sessionId,delivery:ownerBefore.delivery?.request, lastWake:ownerBefore.lastWake, notificationClaims:ownerBefore.notificationClaims},
    claim,clear:cleared.cleared,ownerAfter:ownerAfter&&{executionId:ownerAfter.identity.executionId,sessionId:ownerAfter.sessionId,stopped:ownerAfter.stopped},
    afterClear:afterClear.messages.map(m=>({id:m.id,role:m.role})),published,
    afterPublish:afterPublish.messages.map(m=>({id:m.id,role:m.role,replyTo:m.replyTo})),
    remainingWakes:(await f.records.list(f.rt.prefix+'wakes/')).map(row=>({key:row.key,delivered:row.value.delivered})),errors:f.errors.map(e=>e.message),evidence:{sdk:evidence().actualPackages['@deepseek-ai/dsh-storage']},
    boundary:'Actual Service send, Conversation physical files, Host signal poll, Runtime runQueue/role record, registered dss_claim/read/send; controlled native agent port, no model or Windows.'},null,2))
  const later = await fixture('unselected-after-preview')
  const laterCleanup = new FrameworkManualCleanup(later.files, later.tx, later.rt.conversation, later.rt)
  const send = (id, recipient) => later.client.send({ mode:'local', collaborationId:later.rt.config.collaborationId,
    id,createdAt:'2026-11-11T00:00:00.000Z',text:id,recipient,device:'controlled-client',timezoneOffsetMinutes:0 })
  await send('historical-human-addressed-A','human')
  const laterPreview = await laterCleanup.previewConversation()
  assert.equal(laterPreview.foreground,undefined)
  await send('later-ai-addressed-B','ai')
  await Promise.all(await later.host.runSignalPoll())
  await later.rt.runQueue()
  const laterOwner = later.own()
  assert(laterOwner)
  const laterClaim = await later.call('dss_claim',{})
  await later.call('dss_conversation_read',{mode:'context'})
  await laterCleanup.clearConversation('clear-old-human-A','clear-foreground-conversation',laterPreview)
  assert.equal(later.own()?.identity.executionId,laterOwner.identity.executionId,'unselected later B remains live')
  assert.deepEqual((await later.rt.conversation.page(10)).messages.map(m=>m.id),['later-ai-addressed-B'])
  const laterAnswer = await later.call('dss_conversation_send',{id:'later-B-answer',text:'B answer retained',intent:'human',responsePhase:'final',replyTo:'later-ai-addressed-B'})
  assert.equal(laterAnswer.sent,true)
  assert.deepEqual((await later.rt.conversation.page(10)).messages.map(m=>m.id),['later-ai-addressed-B','later-B-answer'])
  console.log(JSON.stringify({case:'later-unselected-B',preview:laterPreview,claimed:laterClaim.signals,
    liveExecution:later.own().identity.executionId,answerSent:laterAnswer.sent,
    messages:(await later.rt.conversation.page(10)).messages.map(m=>m.id)},null,2))
  const mixed = await fixture('selected-A-claimed-B')
  const mixedCleanup = new FrameworkManualCleanup(mixed.files,mixed.tx,mixed.rt.conversation,mixed.rt)
  const mixedSend = (id) => mixed.client.send({mode:'local',collaborationId:mixed.rt.config.collaborationId,
    id,createdAt:'2026-11-11T00:00:00.000Z',text:id,recipient:'ai',device:'controlled-client',timezoneOffsetMinutes:0})
  await mixedSend('mixed-A')
  const mixedPreview = await mixedCleanup.previewConversation()
  await Promise.all(await mixed.host.runSignalPoll())
  await mixed.rt.runQueue()
  const mixedOldOwner = mixed.own()
  const originalWake = mixed.rt.prefix+'wakes/'+hash(mixedOldOwner.delivery.request.id)
  assert((await mixed.call('dss_claim',{})).signals.length)
  await mixed.call('dss_conversation_read',{mode:'context'})
  await mixedSend('mixed-B')
  await Promise.all(await mixed.host.runSignalPoll())
  const mixedBClaim = await mixed.call('dss_claim',{})
  assert(mixedBClaim.signals.some(path=>path.startsWith('state/Foreground_')))
  await mixedCleanup.clearConversation('mixed-clear','clear-foreground-conversation',mixedPreview)
  assert.equal(mixed.own(),undefined)
  assert.equal(await mixed.records.get(originalWake),undefined,'selected original A wake is retired')
  assert.deepEqual((await mixed.rt.conversation.page(10)).messages.map(m=>m.id),['mixed-B'])
  const mixedIndex = JSON.parse(await withSnapshot(mixed.files,snapshot=>mixed.files.read(snapshot,mixed.rt.conversation.indexPath)))
  const mixedBSignal = mixedIndex.messages.find(row=>row.id==='mixed-B').notification
  assert(await mixed.files.fileInfo(mixedBSignal),'claimed unanswered B exact signal was republished')
  await Promise.all(await mixed.host.runSignalPoll())
  await mixed.rt.runQueue()
  const mixedNewOwner = mixed.own()
  assert.notEqual(mixedNewOwner.identity.executionId,mixedOldOwner.identity.executionId)
  const mixedReclaim = await mixed.call('dss_claim',{})
  assert(mixedReclaim.signals.includes(mixedBSignal))
  assert(JSON.stringify(await mixed.call('dss_conversation_read',{mode:'context'})).includes('mixed-B'))
  const bExecutionBeforeRetry = mixed.own().identity.executionId
  await mixedCleanup.clearConversation('mixed-clear','clear-foreground-conversation',mixedPreview)
  assert.equal(mixed.own().identity.executionId,bExecutionBeforeRetry,'same old command retry leaves new B owner live')
  assert.deepEqual((await mixed.rt.conversation.page(10)).messages.map(m=>m.id),['mixed-B'])
  assert.equal(await mixed.records.get(originalWake),undefined)
  console.log(JSON.stringify({case:'selected-A-claimed-B',originalWakeRetired:true,BSignalRepublished:true,
    newForegroundClaimedB:true,oldCommandRetryPreservesB:true,retained:(await mixed.rt.conversation.page(10)).messages.map(m=>m.id)},null,2))
} finally { await Promise.allSettled(opened.map(f=>f.close())); await fs.rm(scratch,{recursive:true,force:true}) }
