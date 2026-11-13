// Actual Service/Host/official SDK; ordinary accepted commands followed by
// user participation withdrawal. Deterministic model decisions, no injected fault.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
const {fixture,trace,checks,mark,check,until,hash,results,missing,root,evidence}=await import('./helper-service-sdk.mjs')
const {sessionDirectory}=await import('../src/native-cleaner/jsonl-adapter.mjs')
let f
const text='Actual isolated report before normal participation withdrawal.\n'
const reportPath='debug/helper-reports/h1-normal-retirement.md'
async function command(r,name,input){
 const begin=trace.length
 f.model.command(r.sessionId,{name,input})
 const value=await until(name+' result',()=>trace.slice(begin).find(e=>e.event==='tool'&&e.id===r.sessionId&&e.type==='tool/result'))
 check(name+' succeeds',value.data.message.isError,false)
 await until('model continues after '+name,()=>f.model.waiting.has(r.sessionId))
 return trace.slice(begin).find(e=>e.event==='tool'&&e.id===r.sessionId&&e.type==='tool/call').data.callId
}
try{
 f=await fixture()
 f.model.nextForeground={name:'dss_help',input:{facts:'Inspect the actual isolated Host and record the observation.'}}
 await f.service.send({mode:'local',collaborationId:'po-native',id:'original-help',createdAt:new Date().toISOString(),text:'Ask Helper for an isolated normal inspection.',recipient:'ai',device:'isolated'})
 const old=await until('accepted original Helper',()=>{const r=[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Helper');return r?.delivery?.confirmed&&f.model.waiting.has(r.sessionId)?structuredClone(r):undefined})
 const snapshot=results.get(old.sessionId)
 const reportCall=await command(old,'dss_record',{snapshotId:snapshot.snapshotId,path:reportPath,text,append:false,notifyForeground:true})
 const restoreCall=await command(old,'dss_restore_host',{facts:'Observed the actual isolated Host running.',hypotheses:'No business Task fault is claimed.',actionsTaken:'Saved the actual inspection report.',continuation:'Arrange the existing normal Host restoration and retain its current result.'})
 const commandId=old.sessionId+':'+restoreCall
 const row=(await f.active.connection.records.list(f.prefix+'host-restores/')).find(r=>r.value.commandId===commandId)
 check('actual HostRestore accepted before withdrawal',!!row,true)
 mark('before-withdrawal',{restore:row,reportCall,old})
 const agent=f.rt.native.get(old.identity.workId).actualAgent
 await f.sdk.ctx.sessions.flush(agent.session)
 const file=path.join(sessionDirectory(path.join(f.dir,'sessions'),agent.session.header),'session.v'+agent.session.header.version+'.jsonl')
 await f.service.participation({mode:'local',enabled:false})
 const stopped=(await f.active.connection.records.get(f.prefix+'roles/'+hash(old.identity.workId)))
 check('actual stop confirmed',stopped.stopped,true)
 check('accepted old log retained before replacement',await missing(file),false)
 await fs.copyFile(file,path.join(root,'old-stopped.jsonl'))
 mark('after-withdrawal',{restore:await f.active.connection.records.get(row.key),stopped})
 await f.service.participation({mode:'local',enabled:true})
 f.active=f.service.running.get('local');f.rt=f.active.runtime
 const replacement=await until('actual cold Helper continuation replaces original',()=>{const r=f.rt.roleRecords.get(old.identity.workId);return r?.identity.executionId!==old.identity.executionId&&f.model.waiting.has(r?.sessionId)?structuredClone(r):undefined})
 check('cold continuation has distinct Session',replacement.sessionId!==old.sessionId,true)
 await until('original accepted HostRestore finishes and retires',async()=>!await f.active.connection.records.get(row.key))
 await until('original native log finally retired',()=>missing(file))
 check('long-term Helper report preserved',await fs.readFile(path.join(f.dir,'business',reportPath),'utf8'),text)
 check('new Helper is not retired',trace.some(e=>e.event==='retire'&&e.id===replacement.sessionId),false)
 const originalRetire=trace.findIndex(e=>e.event==='retire'&&e.id===old.sessionId)
 check('old Helper retirement really occurred',originalRetire>=0,true)
 const lateRead=trace.slice(originalRetire+1).filter(e=>e.event==='native-open'&&e.id===old.sessionId&&e.caller.includes('/framework/role-runtime.ts:'))
 check('no Host reader reopens retired old native log',lateRead.length,0)
 f.model.command(replacement.sessionId,'idle')
 await until('new Helper ordinary idle',()=>f.rt.native.get(replacement.identity.workId)?.observe().state==='idle')
 mark('final',{original:old,replacement,reportPath,commandId,file,missing:await missing(file)})
}catch(error){process.exitCode=1;mark('failure',{error:String(error),stack:error.stack})}
finally{if(f)try{await f.close()}catch(error){process.exitCode=1;mark('close-failure',{error:String(error),stack:error.stack})};await fs.writeFile(path.join(root,'result.json'),JSON.stringify({checks,trace,sdk:evidence()},null,2));await fs.copyFile(new URL(import.meta.url),path.join(root,'executed.mjs'))}
