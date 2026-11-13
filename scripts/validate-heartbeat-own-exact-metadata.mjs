import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sourceRoot, hooks, evidence, hash } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts', sourceRoot))
const { InstanceRegistration, HEARTBEAT_INTERVAL_MS } = await import(new URL('framework/instances.ts', sourceRoot))
const { withSnapshot } = await import(new URL('framework/transactions.ts', sourceRoot))
const baseline=process.env.DSS_HEARTBEAT_METADATA_BASELINE==='1'
const checks=[],outcomes=[],check=(name,a,b)=>{assert.deepEqual(a,b,name);checks.push({name,value:a})}
const gate=()=>{let release;const promise=new Promise(r=>release=r);return{promise,release}}
const limit=async(p,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Unexpected wait '+label)),5000))])}finally{clearTimeout(timer)}}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-heartbeat-known-'))
try {
 for(const count of [2,8]){
  const sdk=await openDshStorageFixture(path.join(root,''+count,'records'),path.join(root,''+count,'locator')),files=new PhysicalLocalFiles(path.join(root,''+count,'files'));let now=1_000_000
  const configs=Array.from({length:count},(_,i)=>({repositoryId:'local:known-'+count,repositoryOwner:'A',login:'A',instanceUUID:'90000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),workerSeats:2})),owners=configs.map(c=>new InstanceRegistration(files,sdk.adapter,{...c},()=>now))
  let names=[],metadata=[],exact=[],bodies=[]
  const listing=files.records.listMetadata.bind(files.records),naming=files.records.listDirectoryNames.bind(files.records),reading=files.read.bind(files),fileMetadata=files.fileMetadata.bind(files)
  files.records.listMetadata=async(...a)=>{const result=await listing(...a);if(a[0]==='instances/')metadata.push({prefix:a[0],recursive:a[1],rows:result.length});return result}
  files.records.listDirectoryNames=async(...a)=>{const result=await naming(...a);if(a[0]==='instances/')names.push(result.length);return result}
  files.read=async(s,p)=>{if(p.startsWith('instances/'))bodies.push(p);return reading(s,p)}
  files.fileMetadata=async p=>{if(p.startsWith('instances/'))exact.push(p);return fileMetadata(p)}
  const reset=()=>{names=[];metadata=[];exact=[];bodies=[]},cost=()=>({names:[...names],metadata:[...metadata],exact:[...exact],bodies:[...bodies]})
  try{
   const registrations=[];for(const owner of owners)registrations.push(await owner.register())
   check(count+' actual registrations allocate unique aliases',new Set(registrations.map(r=>r.member)).size,count)
   reset();await owners[0].tick();check(count+' not due tick has no physical discovery',cost(),{names:[],metadata:[],exact:[],bodies:[]})
   now+=HEARTBEAT_INTERVAL_MS;reset();await owners[0].tick();const due=cost()
   check(count+' own metadata route',due.exact,baseline?[]:[registrations[0].path])
   check(count+' due tick discovers names once',due.names,[count]);check(count+' own selected metadata enumeration count',due.metadata.map(x=>x.rows),baseline?[count]:[]);check(count+' due tick only reads own body',due.bodies,[registrations[0].path])
   const read=p=>withSnapshot(files,s=>reading(s,p));check(count+' due sequence advanced',JSON.parse(await read(registrations[0].path)).sequence,2)
   await files.replace(registrations[1].path,'Damaged unrelated heartbeat body')
   now+=HEARTBEAT_INTERVAL_MS;reset();await owners[0].tick();check(count+' foreign damaged body does not block own publication',JSON.parse(await read(registrations[0].path)).sequence,3)
   reset();const seats=await owners[0].updateWorkerSeats(4);const seatCost=cost();check(count+' seat update own old path removed',await read(registrations[0].path),undefined);check(count+' seat update new path published',seats.workerSeats,4)
   let current=owners[0],currentPath=seats.path
   if(count===2){
    // Real observer cache is primed, then a controlled write lands between
    // dynamic name discovery and the exact metadata observation.
    await current.observe();const savedNaming=files.records.listDirectoryNames;let changed=false
    files.records.listDirectoryNames=async(...args)=>{const result=await savedNaming(...args);if(!changed&&args[0]==='instances/'){changed=true;await files.replace(currentPath,JSON.stringify({sequence:50,updatedAt:new Date(now).toISOString(),status:'running'}))}return result}
    now+=HEARTBEAT_INTERVAL_MS;await current.tick();files.records.listDirectoryNames=savedNaming
    check('Changed own metadata after names does not reuse stale cached heartbeat',JSON.parse(await read(currentPath)).sequence,51)
    changed=false;files.records.listDirectoryNames=async(...args)=>{const result=await savedNaming(...args);if(!changed&&args[0]==='instances/'){changed=true;await files.delete(currentPath)}return result}
    now+=HEARTBEAT_INTERVAL_MS;await current.tick();files.records.listDirectoryNames=savedNaming
    check('Missing own file after names is recreated from saved own sequence',JSON.parse(await read(currentPath)).sequence,52)
    const savedList=files.records.listMetadata,savedExact=files.fileMetadata;let fail=true
    if(baseline)files.records.listMetadata=async(...args)=>{if(fail&&args[0]==='instances/'){fail=false;throw Error('Controlled known metadata read failure')}return savedList(...args)}
    else files.fileMetadata=async p=>{if(fail&&p===currentPath){fail=false;throw Error('Controlled known metadata read failure')}return savedExact(p)}
    now+=HEARTBEAT_INTERVAL_MS;await assert.rejects(current.tick(),/Controlled known metadata read failure/);checks.push({name:'Known own metadata errors remain visible',value:true})
    files.records.listMetadata=savedList;files.fileMetadata=savedExact
    check('Failed preparation does not overwrite actual own heartbeat',JSON.parse(await read(currentPath)).sequence,52)
    const ownKey='framework-instance/'+hash(configs[0].repositoryId+':'+configs[0].instanceUUID)
    check('Failed metadata preparation reserves no extra pending publication',(await sdk.adapter.get(ownKey)).pending,undefined)
    await current.tick();check('Next due attempt uses original stored sequence',JSON.parse(await read(currentPath)).sequence,53)
    const oldPath=currentPath,deleteFile=files.delete.bind(files);let first=true
    files.delete=async p=>{if(first&&p===oldPath){first=false;throw Error('Controlled old own path deletion failure')}return deleteFile(p)}
    await assert.rejects(current.updateWorkerSeats(5),/old own path deletion/);checks.push({name:'Seat change keeps failed original deletion visible',value:true})
    const pending=(await sdk.adapter.get(ownKey)).pending
    check('Failed seat cleanup retains exact pending old path',pending.previousPaths,[oldPath])
    currentPath=pending.registration.path;check('New seat path was already durably published',JSON.parse(await read(currentPath)).sequence,54)
    files.delete=deleteFile;current=new InstanceRegistration(files,sdk.adapter,{...configs[0],workerSeats:5},()=>now)
    reset();await current.register();const resumePendingCost=cost()
    check('Cold pending seat publication avoids new discovery',resumePendingCost,{names:[],metadata:[],exact:[],bodies:[]})
    check('Cold retry completes the same reserved heartbeat sequence',JSON.parse(await read(currentPath)).sequence,54)
    check('Cold retry only deletes original old own path',await read(oldPath),undefined)
    check('Cold retry clears accepted own pending responsibility',(await sdk.adapter.get(ownKey)).pending,undefined)
    // The physical heartbeat was published, then the exact binding write fails.
    const savedSet=sdk.adapter.set.bind(sdk.adapter);first=true
    sdk.adapter.set=async(k,v)=>{if(first&&k===ownKey&&!v.pending){first=false;throw Error('Controlled original binding write failure')}return savedSet(k,v)}
    now+=HEARTBEAT_INTERVAL_MS;await assert.rejects(current.tick(),/binding write failure/);checks.push({name:'Original binding error remains reported after physical publication',value:true})
    check('Accepted physical heartbeat remains after binding failure',JSON.parse(await read(currentPath)).sequence,55)
    sdk.adapter.set=savedSet;current=new InstanceRegistration(files,sdk.adapter,{...configs[0],workerSeats:5},()=>now);reset();await current.register()
    check('Pending binding retry keeps original publication sequence',JSON.parse(await read(currentPath)).sequence,55)
    check('Pending binding retry does not rediscover own metadata',cost(),{names:[],metadata:[],exact:[],bodies:[]})
    // Disconnect cancels and drains the original accepted tick before publishing
    // its stopped hint; the test holds only the original metadata boundary.
    const entered=gate(),hold=gate();first=true
    if(baseline)files.records.listMetadata=async(...args)=>{if(first&&args[0]==='instances/'){first=false;entered.release();await hold.promise}return savedList(...args)}
    else files.fileMetadata=async p=>{if(first&&p===currentPath){first=false;entered.release();await hold.promise}return savedExact(p)}
    now+=HEARTBEAT_INTERVAL_MS;const ticking=current.tick().then(()=>({ok:true}),error=>({ok:false,name:error.name}));await limit(entered.promise,'own pending metadata')
    let disconnected=false;const closing=current.disconnect().then(()=>{disconnected=true});await new Promise(setImmediate)
    check('Disconnect waits for its original accepted tick',disconnected,false)
    hold.release();check('Cancelled tick preserves AbortError',(await limit(ticking,'cancelled tick')).name,'AbortError');await limit(closing,'disconnect original tick')
    files.records.listMetadata=savedList;files.fileMetadata=savedExact
    check('Disconnect does not publish the cancelled running reservation',JSON.parse(await read(currentPath)).sequence,56)
    check('Disconnect publishes stopped after original tick settles',JSON.parse(await read(currentPath)).status,'stopped')
    outcomes.push({case:'pending-and-close',resumePendingCost})
   }
   reset();if(count!==2)await current.disconnect();const stopCost=cost();check(count+' disconnect publishes stopped',JSON.parse(await read(currentPath)).status,'stopped')
   check(count+' foreign registration survives',await read(registrations[1].path),'Damaged unrelated heartbeat body')
   outcomes.push({instances:count,due,seatCost,stopCost})
  }finally{await files.close();await sdk.close()}
 }
 console.log(JSON.stringify({status:'passed',baseline,assertions:checks.length,checks,outcomes,...evidence(),limits:'Isolated candidate / baseline same test. Actual InstanceRegistration register/tick/updateWorkerSeats/disconnect, SDK technical store and PhysicalLocalFiles. Instance counts are controlled fixtures, clock explicitly advanced; no claim of user current instance count, OS total I/O, Windows or device latency. Real cached observation, name-to-metadata replacement/removal, exact read failure, pending seat deletion/binding interruption and disconnect-cancel-drain are tested. Host runtime/service/connection wiring is source-traced, not full native Host execution in this script. Git unchanged by the candidate and not executed by this test.'},null,2))
}finally{hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
