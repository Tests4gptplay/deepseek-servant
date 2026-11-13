import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import './test-support/dsh-sdk-runtime.mjs'
import {RecordFilesBackend,ensureRecordTree,recordFolder} from './test-support/d19-record-files.mjs'
import {LocalLocationRegistry as OldLocalLocationRegistry} from './test-support/d19-local-location.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {LocalLocationRegistry}=await import('../src/framework/local-location.ts')
const sha=value=>createHash('sha256').update(value).digest('hex')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-w011-local-identity-'))
const records=path.join(root,'records'),locator=path.join(root,'locator'),oldTree=path.join(records,'deepseek_servant')
const sourceA=path.join(root,'departed-a'),targetA=path.join(root,'selected-a'),localB=path.join(root,'selected-b')
const scopeA=JSON.stringify(['local',sourceA]),scopeB=JSON.stringify(['local',localB])
const uuid='91000000-0000-4000-8000-000000000011'
const connectionKey=scope=>'framework-connection-settings/'+sha(scope)
const instanceKey=scope=>'framework-instance/'+sha(scope+':'+uuid)
const keys=['framework/local-locations',connectionKey(scopeA),instanceKey(scopeA),connectionKey(scopeB),instanceKey(scopeB)]
const checks=[];const check=(label,got,want)=>{assert.deepEqual(got,want,label);checks.push(label)}
let old,sdk
try {
  await Promise.all([sourceA,targetA,localB].map(directory=>fs.mkdir(directory,{recursive:true})))
  await ensureRecordTree(oldTree)
  old=new RecordFilesBackend(oldTree)
  const unit=await old.kv.open({name:'deepseek_servant',version:1,tables:['records'],hasGlobal:false})
  const oldPort={get:async key=>(await unit.loadAll()).tables.records[key]?.value,
    set:async(key,value)=>unit.putRecord('records',key,{key,value})}
  const oldLocations=new OldLocalLocationRegistry(oldPort)
  // Only the location-record writer is exercised here. The full d19 physical
  // mover and verified SQLite fingerprint are separately covered by W011/W022.
  const identity={source:sourceA,target:targetA,scope:scopeA,fingerprint:'addressed-record-regression'}
  await oldLocations.prepare('old-location-a',identity)
  await oldLocations.publish('old-location-a',identity)
  await oldLocations.applied('old-location-a')
  await oldPort.set('framework-instance-uuid',uuid)
  for(const [scope,directory,seats] of [[scopeA,targetA,1],[scopeB,localB,2]]) {
    await oldPort.set(connectionKey(scope),{mode:'local',directory,login:'A',workerSeats:seats})
    await oldPort.set(instanceKey(scope),{member:'A',sequence:seats,lastPublishedAt:1})
  }
  const oldValues=Object.fromEntries(await Promise.all(keys.map(async key=>[key,await oldPort.get(key)])))
  check('actual d19 Registry wrote selected A alias',await oldLocations.resolve(targetA),scopeA)
  check('actual d19 Registry retained independent B scope',await oldLocations.resolve(localB),scopeB)
  await old.close();old=undefined
  const nativeFiles=Object.fromEntries(await Promise.all(keys.map(async key=>{
    const filename=path.join(oldTree,recordFolder(key),'record.json')
    const body=await fs.readFile(filename)
    const envelope=JSON.parse(body)
    check('d19 native envelope contains exact identity: '+key,envelope.tables.records[key]?.key,key)
    return [key,{path:filename,sha256:sha(body)}]
  })))
  sdk=await openDshStorageFixture(records,locator)
  const store=sdk.adapter,locations=new LocalLocationRegistry(store)
  check('current exact old location preserves moved scope A',await locations.resolve(targetA),scopeA)
  await assert.rejects(()=>locations.resolve(sourceA),/moved/);checks.push('current rejects departed A source')
  check('current old location does not mix B scope',await locations.resolve(localB),scopeB)
  for(const [scope,directory,seats] of [[scopeA,targetA,1],[scopeB,localB,2]]) {
    check('old connection visible only at requested key: '+scope,(await store.get(connectionKey(scope)))?.directory,directory)
    check('old instance visible only at requested key: '+scope,(await store.get(instanceKey(scope)))?.sequence,seats)
  }
  check('distinct old scopes retain distinct connection keys',connectionKey(scopeA)!==connectionKey(scopeB),true)
  check('distinct old scopes retain distinct instance keys',instanceKey(scopeA)!==instanceKey(scopeB),true)
  for(const key of keys)check('old native bytes unchanged after read: '+key,sha(await fs.readFile(nativeFiles[key].path)),nativeFiles[key].sha256)
  // Disposable current writes test current-first precedence, not a user deletion
  // or a claim that a normal UI intentionally clears move bindings.
  await store.set(connectionKey(scopeA),{...oldValues[connectionKey(scopeA)],workerSeats:9})
  await store.set(instanceKey(scopeA),{...oldValues[instanceKey(scopeA)],sequence:44})
  await store.set('framework/local-locations',{version:1,moves:[],bindings:{}})
  await sdk.close();sdk=undefined
  sdk=await openDshStorageFixture(records,locator)
  const cold=sdk.adapter
  check('current connection wins across cold SDK reopen',(await cold.get(connectionKey(scopeA))).workerSeats,9)
  check('current instance wins across cold SDK reopen',(await cold.get(instanceKey(scopeA))).sequence,44)
  check('current location wins across cold SDK reopen',(await cold.get('framework/local-locations')).moves.length,0)
  check('unmodified old B connection remains available',(await cold.get(connectionKey(scopeB))).directory,localB)
  check('unmodified old B instance remains available',(await cold.get(instanceKey(scopeB))).sequence,2)
  for(const key of keys)check('old native bytes retained after current writes: '+key,sha(await fs.readFile(nativeFiles[key].path)),nativeFiles[key].sha256)
  console.log(JSON.stringify({status:'w011-addressed-old-envelope-current-priority-passed',checks,oldNativeHashes:Object.fromEntries(keys.map(key=>[key,nativeFiles[key].sha256])),limits:'Actual d19 RecordFilesBackend/LocalLocationRegistry generated old native envelopes, actual current SDK adapter; full Service/Local acquisition is covered separately. Location receipt is an addressed controlled fixture, not a full physical move; full real d19 mover is in separate W011/W022 chain. No model, UI or Windows.'},null,2))
} finally {await sdk?.close();await old?.close();await fs.rm(root,{recursive:true,force:true})}
