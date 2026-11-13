import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('..', import.meta.url))
const { fixture, until, trace, hash, root } = await import(path.join(source, 'scripts/helper-service-sdk.mjs'))
const { withSnapshot } = await import(path.join(source, 'src/framework/transactions.ts'))
const rows=[]
for (const username of ['PlainUser', 'Task_foo']) {
  const f=await fixture('foreground-prefix-'+username)
  try {
    const current=f.service.saved.get('local').settings
    await f.service.configure({mode:'local',commandId:'set-'+username,settings:{...current,userName:username},changedFields:['userName']})
    const active=f.service.running.get('local'), rt=active.runtime
    const stages=new Map()
    f.model.stream=async function* (o) {
      this.calls.push(o)
      const n=stages.get(o.sessionId)??0; stages.set(o.sessionId,n+1)
      const call=(name,input)=>[{type:'tool-call-delta',index:0,name,id:'prefix-'+username+'-'+n,argumentsDelta:JSON.stringify(input)},{type:'finish',reason:'tool-calls'}]
      if(n===0){yield*call('dss_claim',{});return}
      if(n===1){yield*call('dss_conversation_read',{mode:'context'});return}
      yield {type:'finish',reason:'stop'}
    }
    const id='message-'+username
    await f.service.send({mode:'local',collaborationId:'po-native',storageScope:active.connection.scope,id,createdAt:'2026-11-12T12:00:00.123Z',text:'Controlled original '+username,recipient:'ai',device:'isolated-client',timezoneOffsetMinutes:0})
    const index=await withSnapshot(active.connection.files,s=>active.connection.files.read(s,rt.conversation.indexPath))
    const message=JSON.parse(index).messages.find(m=>m.id===id)
    assert(message)
    const notification=message.notification
    const read=await until(username+' native context read',()=>trace.find(x=>x.event==='tool'&&x.type==='tool/result'&&x.data?.message?.toolCallId==='prefix-'+username+'-1'))
    const fg=[...rt.roleRecords.values()].find(r=>r.identity.role==='Foreground')
    const claims=trace.filter(x=>x.event==='tool'&&x.type==='tool/result'&&x.data?.message?.toolCallId==='prefix-'+username+'-0')
    const context=rt.conversation.foregroundContext?await rt.conversation.foregroundContext():undefined
    rows.push({username,id,notification,roleTaskId:fg?.delivery?.request?.taskId,roleSources:fg?.delivery?.request?.sources,claimed:claims.length,readError:read.data.message.isError,readResult:read.data.message.content,contextIds:context?.messages?.map(m=>m.id),signalPresent:await withSnapshot(active.connection.files,s=>active.connection.files.read(s,notification))!==undefined,errors:[...f.service.errors].map(String)})
    assert.equal(fg?.delivery?.request?.taskId,undefined,'user chat must not carry Task identity')
  } finally {await f.close()}
}
await fs.writeFile(new URL('../../local-result.json',import.meta.url),JSON.stringify({rows,root},null,2)+'\n')
console.log('PREFIX_PROBE_RESULT',JSON.stringify(rows))
