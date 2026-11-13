import assert from 'node:assert/strict'
import { hooks } from './test-support/dsh-sdk-runtime.mjs'
const { fixture, trace, until } = await import('./helper-service-sdk.mjs')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { scopedLocalForegroundNotification } = await import('../src/framework/conversation.ts')
const checks = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const f = await fixture('scope-a-b')
let reopened
try {
  let allow = false
  const steps = new Map()
  f.model.stream = async function* (o) {
    this.calls.push(o)
    if (!o.tools.some(tool => tool.name === 'dss_conversation_read') || !allow) { yield { type: 'finish', reason: 'stop' }; return }
    const step = steps.get(o.sessionId) ?? 0; steps.set(o.sessionId, step + 1)
    if (step <= 1) {
      yield { type: 'tool-call-delta', index: 0, name: step === 0 ? 'dss_claim' : 'dss_conversation_read',
        id: 'scope-' + o.sessionId + '-' + step, argumentsDelta: step === 0 ? '{}' : '{"mode":"context"}' }
      yield { type: 'finish', reason: 'tool-calls' }; return
    }
    yield { type: 'finish', reason: 'stop' }
  }
  const A = 'po-native', B = 'other-chat', id = 'same-message-id'
  const original = f.service.running.get('local')
  const scope = original.connection.scope
  await f.service.send({ mode: 'local', collaborationId: A, storageScope: scope, id, createdAt: '2026-11-12T12:00:00.123Z',
    text: 'A original input', recipient: 'ai', device: 'controlled-client', timezoneOffsetMinutes: 0 })
  const indexed = async active => JSON.parse(await withSnapshot(active.connection.files, s => active.connection.files.read(s,active.runtime.conversation.indexPath)))
  const aPath = (await indexed(original)).messages.find(m=>m.id===id).notification
  check('scoped source format', aPath, scopedLocalForegroundNotification('Evidence',new Date('2026-11-12T12:00:00.123Z'),0,A,id))
  check('source pending',!!await original.connection.files.fileInfo(aPath),true)
  await f.service.configure({mode:'local',settings:{...f.service.config('local').settings,collaborationId:B},changedFields:['collaborationId'],commandId:'scope-to-b'})
  const b = f.service.running.get('local')
  check('B selected',b.runtime.config.collaborationId,B)
  await Promise.all(await b.runtime.loop.runSignalPoll())
  await b.runtime.runQueue()
  check('B does not claim or wake A',trace.filter(r=>r.event==='tool'&&r.type==='tool/result').length,0)
  check('A notice survives switch',!!await b.connection.files.fileInfo(aPath),true)
  check('B snapshot has no A',await withSnapshot(b.connection.files,s=>b.runtime.notifications(s,{role:'Foreground'})),[])
  allow = true
  await f.service.send({mode:'local',collaborationId:B,storageScope:b.connection.scope,id,createdAt:'2026-11-12T12:00:00.123Z',
    text:'B original input',recipient:'ai',device:'controlled-client',timezoneOffsetMinutes:0})
  const bPath = (await indexed(b)).messages.find(m=>m.id===id).notification
  assert.notEqual(aPath,bPath)
  await Promise.all(await b.runtime.loop.runSignalPoll()); await b.runtime.runQueue()
  const bClaim = await until('B SDK claim',()=>trace.find(r=>r.event==='tool'&&r.type==='tool/result'&&r.data?.message?.toolCallId?.startsWith('scope-')))
  check('B SDK claim success',bClaim.data.message.isError,false)
  assert(bClaim.data.message.content.some(c=>c.type==='text'&&c.text.includes(bPath)&&!c.text.includes(aPath)))
  const bRead = await until('B SDK read',()=>trace.find(r=>r.event==='tool'&&r.type==='tool/result'&&r.data?.message?.toolCallId?.endsWith('-1')))
  check('B SDK read success',bRead.data.message.isError,false)
  assert(bRead.data.message.content.some(c=>c.type==='text'&&c.text.includes('B original input')&&!c.text.includes('A original input')))
  check('A persists after B claim',!!await b.connection.files.fileInfo(aPath),true)
  check('B consumed',await b.connection.files.fileInfo(bPath),undefined)
  await f.close()
  reopened = await fixture('scope-a-b',true)
  check('saved B selection survives restart',reopened.service.running.get('local').runtime.config.collaborationId,B)
  await reopened.service.configure({mode:'local',settings:{...reopened.service.config('local').settings,collaborationId:A},changedFields:['collaborationId'],commandId:'cold-return-to-a'})
  const ar = reopened.service.running.get('local')
  check('A cold startup',ar.runtime.config.collaborationId,A)
  await Promise.all(await ar.runtime.loop.runSignalPoll()); await ar.runtime.runQueue()
  const aClaim = await until('A cold SDK claim',()=>trace.find(r=>r.event==='tool'&&r.type==='tool/result'&&r.data?.message?.toolCallId?.startsWith('foreground-claim-')&&r.id!==bClaim.id))
  check('A cold SDK claim success',aClaim.data.message.isError,false)
  assert(aClaim.data.message.content.some(c=>c.type==='text'&&c.text.includes(aPath)&&!c.text.includes(bPath)))
  check('A consumed at original scope',await ar.connection.files.fileInfo(aPath),undefined)
  console.log('SCOPE_PASS',JSON.stringify({checks,aPath,bPath,sourceScope:scope,root:reopened.dir}))
} finally { if(reopened) await reopened.close(); else await f.close(); hooks.deregister() }
