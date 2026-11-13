import assert from 'node:assert/strict'
import {hooks} from './test-support/dsh-sdk-runtime.mjs'
const {fixture,trace,until}=await import('./helper-service-sdk.mjs')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const f=await fixture('separator-scope')
try {
 const name='U\u2028V\u2029W', A='po-native', B='other-chat'
 f.model.stream=async function*(){yield {type:'finish',reason:'stop'}}
 await f.service.configure({mode:'local',settings:{...f.service.config('local').settings,userName:name},changedFields:['userName'],commandId:'set-separator-user'})
 const a=f.service.running.get('local')
 await f.service.send({mode:'local',collaborationId:A,storageScope:a.connection.scope,id:'separator-a',createdAt:'2026-11-12T12:00:00.123Z',text:'A separator input',recipient:'ai',device:'controlled-client',timezoneOffsetMinutes:0})
 const index=JSON.parse(await withSnapshot(a.connection.files,s=>a.connection.files.read(s,a.runtime.conversation.indexPath)))
 const signal=index.messages.find(row=>row.id==='separator-a').notification
 assert(signal.includes(name))
 await f.service.configure({mode:'local',settings:{...f.service.config('local').settings,collaborationId:B},changedFields:['collaborationId'],commandId:'sep-to-b'})
 const b=f.service.running.get('local')
 await Promise.all(await b.runtime.loop.runSignalPoll());await b.runtime.runQueue()
 assert.equal(trace.filter(r=>r.event==='tool'&&r.type==='tool/result').length,0)
 assert(await b.connection.files.fileInfo(signal))
 assert.deepEqual(await withSnapshot(b.connection.files,s=>b.runtime.notifications(s,{role:'Foreground'})),[])
 await f.service.configure({mode:'local',settings:{...f.service.config('local').settings,collaborationId:A},changedFields:['collaborationId'],commandId:'sep-to-a'})
 const back=f.service.running.get('local')
 assert.deepEqual(await withSnapshot(back.connection.files,s=>back.runtime.notifications(s,{role:'Foreground'})),[signal])
 console.log('SEPARATOR_SCOPE_PASS',JSON.stringify({name,signal}))
}finally{await f.close();hooks.deregister()}
