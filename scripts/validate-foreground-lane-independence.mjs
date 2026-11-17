import assert from 'node:assert/strict'
import {hooks} from './test-support/dsh-sdk-runtime.mjs'
const {fixture}=await import('./helper-service-sdk.mjs')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const pending=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const f=await fixture('old-physical',true)
let originalRead
try {
 const b=f.service.running.get('local'),rt=b.runtime,files=b.connection.files
 assert.equal(rt.config.collaborationId,'other-chat')
 const old=(await withSnapshot(files,s=>files.listDirectory(s,'state/'))).filter(x=>x.path.startsWith('state/Foreground_'))
 assert.equal(old.length,5,'real former Service input notices still pending')
 // The service's normal loop is paused only in this controlled scheduling
 // check, leaving the production runtime's actual Helper signal publisher.
 rt.loop.stopping=true
 await rt.wake({id:'controlled-helper-lane',role:'Helper',sources:[],reason:'helper'})
 await Promise.allSettled([...rt.maintenance?.values()??[]])
 const helpers=(await withSnapshot(files,s=>files.listDirectory(s,'state/'))).filter(x=>x.path.startsWith('state/Helper_'))
 assert(helpers.length)
 rt.conversation.oldSignals=undefined // exercise this runtime's first old-index read
 const entered=pending(),release=pending();let held=false,reads=0
 originalRead=files.read.bind(files)
 files.read=async(s,p,...args)=>{
  if(p===rt.conversation.indexPath && !held){held=true;reads++;entered.resolve();await release.promise}
  return originalRead(s,p,...args)
 }
 const wakes=[],errors=[]
 const host=new FrameworkHostLoop(files,rt.transactions,b.connection.records,rt.config,()=>['Evidence'],{
  executing:()=>false,routeForegroundSignals:sources=>rt.conversation.routeForegroundSignals(sources),
  wake:async request=>{wakes.push(request);return true},admitDiscovered:async()=>{},error:error=>errors.push(error)
 })
 const owned=await host.runSignalPoll()
 await Promise.race([entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('old index read did not start')),3000))])
 // The actual Helper signal's lane must dispatch before Foreground's held
 // Local index read is released. This tests Host scheduling, not Helper work.
 for(let i=0;i<100&&!wakes.some(x=>x.role==='Helper');i++)await new Promise(r=>setTimeout(r,5))
 assert(wakes.some(x=>x.role==='Helper'),'Helper lane was blocked by Foreground index')
 assert(!wakes.some(x=>x.role==='Foreground'),'unrouted A input must not wake B')
 release.resolve();await Promise.all(owned)
 assert(!wakes.some(x=>x.role==='Foreground'))
 assert.deepEqual(errors,[])
 console.log('LANE_PASS',JSON.stringify({oldSignals:old.length,helperSignals:helpers.length,indexReadHeld:reads,helperWakeBeforeRelease:true,foregroundWake:false}))
}finally{if(originalRead)f.service.running.get('local').connection.files.read=originalRead;await f.close();hooks.deregister()}
