import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {hooks} from './test-support/dsh-sdk-runtime.mjs'
const {FrameworkConversation,scopedLocalForegroundSourceNotification,scopedLocalForegroundNotification} = await import('../src/framework/conversation.ts')
const {PhysicalLocalFiles} = await import('../src/framework/physical-local-files.ts')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'scope-source-'))
const files=new PhysicalLocalFiles(root)
try {
 const old='state/Foreground_'+'长'.repeat(45)+'-GMT0-20261112-120000123'
 const a=scopedLocalForegroundSourceNotification(old,'A'),b=scopedLocalForegroundSourceNotification(old,'B')
 assert.notEqual(a,b); assert.equal(Buffer.byteLength(a.split('/').at(-1))<255,true)
 const tx={run(){throw Error('No writes in route check')}}
 const ca=new FrameworkConversation(files,tx,{mode:'local',collaborationId:'A'})
 const cb=new FrameworkConversation(files,tx,{mode:'local',collaborationId:'B'})
 const task='state/Foreground_Task_11111111-1111-4111-8111-111111111111'
 const helper='state/Foreground_Helper_Report_report.md'
 const normal=scopedLocalForegroundNotification('u',new Date('2026-11-12T12:00:00.123Z'),0,'A','x')
 const entries=[a,b,task,helper,normal].map(p=>({path:p,version:'v'}))
 assert.deepEqual((await ca.routeForegroundSignals(entries)).map(x=>x.path),[a,task,helper,normal])
 assert.deepEqual((await cb.routeForegroundSignals(entries)).map(x=>x.path),[b,task,helper])
 console.log('SOURCE_SCOPE_PASS',JSON.stringify({a,b,task,helper,normal}))
}finally{await files.close();await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
