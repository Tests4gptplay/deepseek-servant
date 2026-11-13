import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import {sourceRoot,loaded as sources,hash,hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'

// Extract the actual key expressions without activating their model owners,
// then persist/reopen/delete through unchanged native SDK JSON implementations.
const root=sourceRoot
const {RecordFilesBackend,recordFolder,recordCategory,ensureRecordTree}=await import(new URL('adapters/dsh/record-files.ts',sourceRoot))
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'dss-upgrade-categories-')),nativeFixtures=[]
let assertions=0,reopened
const check=(actual,expected)=>{assert.deepEqual(actual,expected);assertions++}
const bad='framework-user-controls/'+hash('scope')+'/tasks/'+hash('bad')
const good='framework-user-controls/'+hash('scope')+'/tasks/'+hash('good')
async function writeRecord(tree,key,value){
 const folder=path.join(tree,recordFolder(key));await fs.mkdir(folder,{recursive:true})
 await fs.writeFile(path.join(folder,'record.json'),JSON.stringify({unit:{name:'record',version:1},tables:{records:{[key]:{key,value}}},global:null}))
}
async function fixture(name){
 const directory=path.join(temporary,name),tree=path.join(directory,'deepseek_servant')
 await ensureRecordTree(tree);await writeRecord(tree,bad,'original-bad');await writeRecord(tree,good,'healthy')
 const native=await openDshStorageFixture(directory,path.join(directory,'locator'));nativeFixtures.push(native)
 return {tree,adapter:native.adapter}
}
try {
  const f = await fixture('actual-upgrade-keys')
  const producers = [
    ['framework/local-startup-upgrade-agent.ts','localUpgradeAgentKey',['/actual/Local']],
    ['framework/local-startup-upgrade.ts','localStartupUpgradeKey',['/actual/Local']],
    ['framework/local-upgrade-task.ts','localTaskUpgradeKey',['/actual/Local','TaskID']],
    ['framework/local-upgrade-conversation.ts','localConversationUpgradeKey',['/actual/Local','conversation']],
    ['framework/local-upgrade-mapping.ts','localSkillUpgradeKey',['/actual/Local','skills/source.json']],
    ['framework/local-upgrade-mapping.ts','localUpgradeMappingKey',['/actual/Local','tasks/original.md']],
    ['framework/local-upgrade-mapping.ts','localUpgradeResultKey',['/actual/Local']],
  ]
  const keys=[]
  for (const [file,name,args] of producers) {
    const source=readFileSync(new URL(file,root),'utf8'); sources.set(file,hash(source))
    const js=stripTypeScriptTypes(source,{mode:'transform'}), match=new RegExp('(?:export )?const '+name+' = ([\\s\\S]*?);').exec(js)
    assert.ok(match,'actual producer '+name)
    const key=new Function('createHash','hash','return '+match[1])(createHash,hash)(...args)
    keys.push(key); check(recordCategory(key),'state/startup-upgrade')
    const value={source:args[0],status:'pending',retainedOriginal:'原文'}
    await f.adapter.set(key,value); check(await f.adapter.get(key),value)
    check(JSON.parse(await fs.readFile(path.join(f.tree,recordFolder(key),'record.json'),'utf8')).tables.records[key].value,value)
  }
  check(new Set(keys.map(recordFolder)).size,7)
  check(await f.adapter.get(good),'healthy')
  await f.adapter.close()
  reopened=new RecordFilesBackend(f.tree); const unit=await reopened.kv.open({name:'deepseek_servant',version:1,tables:['records'],hasGlobal:false})
  const snapshot=await unit.loadAll()
  for(const key of keys)check(snapshot.tables.records[key].value.retainedOriginal,'原文')
  for(const key of keys){await unit.deleteRecord('records',key);check(existsSync(path.join(f.tree,recordFolder(key))),false)}
  check((await unit.loadAll()).tables.records[good].value,'healthy')
  await reopened.close()
  console.log(JSON.stringify({status:'passed',assertions,...evidence(),sourceHashes:Object.fromEntries(sources),limits:'Actual key producer expressions, integrated adapter/backend and real recovered SDK Context/Storage/locator Domain/Json backend, Linux file reopen/delete. No user data, complete native DSH activation, Windows, full typecheck or build.'},null,2))
} finally {
  await reopened?.close()
  await Promise.allSettled(nativeFixtures.map(fixture=>fixture.close()))
  hooks.deregister()
  await fs.rm(temporary,{recursive:true,force:true})
}
