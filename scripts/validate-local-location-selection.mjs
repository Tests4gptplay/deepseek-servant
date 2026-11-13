import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {createHash} from 'node:crypto'
const url=new URL('../src/framework/local-location.ts',import.meta.url),source=readFileSync(url,'utf8')
const hooks=registerHooks({load(id,context,next){if(id===url.href)return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform'}),shortCircuit:true};return next(id,context)}})
const {LocalLocationRegistry,localLocationRecordKey}=await import(url.href)
let saved,reads=0,writes=0,assertions=0
const storage={async get(key){assert.equal(key,localLocationRecordKey);reads++;return saved},async set(){writes++;throw new Error('Read-only selection must not rewrite old records')}}
const registry=new LocalLocationRegistry(storage),target='/tmp/dss-location-current',sourcePath='/tmp/dss-location-source',other='/tmp/dss-location-independent'
const check=async(input,expected)=>{assert.deepEqual(await registry.resolve(input),expected);assertions++}
const rejects=async(input,match)=>{await assert.rejects(registry.resolve(input),match);assertions++}
try{
 await check(other,JSON.stringify(['local',other]))
 const receipt={commandId:'actual-move',source:sourcePath,target,scope:'retained-original-scope',fingerprint:'copy-fact',phase:'applied'}
 saved={version:1,moves:[receipt],bindings:{[target]:{scope:receipt.scope,state:'current',commandId:receipt.commandId},[sourcePath]:{scope:receipt.scope,state:'departed',commandId:receipt.commandId,destination:target}}}
 await check(target,receipt.scope);await rejects(sourcePath,/moved/)
 saved.moves.push(null,{commandId:'unrelated-bad',target:'/tmp/other',phase:'invalid'})
 saved.bindings['/tmp/unrelated-malformed']={state:'broken'}
 const before=structuredClone(saved)
 await check(other,JSON.stringify(['local',other]));await check(target,receipt.scope)
 assert.deepEqual(saved,before);assertions++;assert.equal(writes,0);assertions++
 saved.moves.push({commandId:'pending',phase:'prepared',target:'/tmp/unrelated-pending'})
 await check(other,JSON.stringify(['local',other]));await rejects('/tmp/unrelated-pending',/selected location.*pending/)
 saved.bindings['/tmp/selected-malformed']=null
 await rejects('/tmp/selected-malformed',/selected local location/)
 saved.moves.push({...receipt})
 await rejects(target,/selected local location/);await check(other,JSON.stringify(['local',other]))
 saved={version:999,moves:'unreadable unrelated history',bindings:{'/tmp/unrelated-malformed':false}}
 await check(other,JSON.stringify(['local',other]))
 assert.equal(writes,0);assertions++
 console.log(JSON.stringify({status:'passed',assertions,reads,limits:'Actual location resolver with controlled technical record; no record-move publication or filesystem migration claimed.',sourceHash:createHash('sha256').update(source).digest('hex')},null,2))
}finally{hooks.deregister()}
