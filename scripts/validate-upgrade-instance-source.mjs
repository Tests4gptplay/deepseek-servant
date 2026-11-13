import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
const root = new URL('../src/', import.meta.url), loaded = new Map()
const data = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64')
const hooks = registerHooks({
 resolve(s,c,n) {
  if(s === '@deepseek-ai/dsh-scope')return {url:data('export const scopeOf=()=>{throw Error("Native scope is outside initialization test")}'),shortCircuit:true}
  if(s === '@deepseek-ai/dsh-skill')return {url:data('export const isSkillName=()=>{throw Error("Skill content is outside empty catalog initialization test")}'),shortCircuit:true}
  if(s === 'yaml')return {url:data('export const parse=()=>{throw Error("Skill parsing is outside empty catalog initialization test")}'),shortCircuit:true}
  if(s === 'zod') return {url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true}
  if(s === '@deepseek-ai/dsh-storage-json') return {url:data('export class JsonStorageBackend { constructor(){throw Error("Native JSON backend intentionally not provided in this boundary test")} }'),shortCircuit:true}
  if(s === 'koffi') return {url:new URL('./helpers/fixture-no-replace-koffi.mjs',import.meta.url).href,shortCircuit:true}
  if(s.startsWith('.') && c.parentURL?.startsWith(root.href) && s.endsWith('.js')) {const u = new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}
  return n(s,c)
 },
 load(u,c,n) {if(u.startsWith(root.href) && u.endsWith('.ts')) {let s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}
})
const {PhysicalLocalFiles,PhysicalLocalPublicationRequiredError}=await import(new URL('framework/physical-local-files.ts',root))
const {FrameworkTransactions}=await import(new URL('framework/command-transactions.ts',root))
const {openFrameworkConnection}=await import(new URL('framework/connection.ts',root))
const {materializeLegacyLocalFiles}=await import(new URL('framework/local-startup-upgrade.ts',root))
const {RecordFilesBackend,recordFolder}=await import(new URL('adapters/dsh/record-files.ts',root))
const {foregroundTaskSignal,paths}=await import(new URL('framework/task-files.ts',root))
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-physical-activation-audit-'))
let assertions=0; const check=(actual,expected)=>{assert.deepEqual(actual,expected); assertions++}; const results=[]
const record= (name,details)=>results.push({name,...details})
const memory=()=>{const m=new Map();return{async get(k){return structuredClone(m.get(k))},async set(k,v){m.set(k,structuredClone(v))},async list(p){return[...m].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value)}))},async delete(k){m.delete(k)}}}
const seed=async(dir,entries)=>{await fs.mkdir(dir,{recursive:true});const db=new DatabaseSync(path.join(dir,'dss-files.sqlite'));db.exec('CREATE TABLE files(path TEXT PRIMARY KEY, content TEXT NOT NULL, version TEXT NOT NULL, bytes INTEGER NOT NULL, binary BLOB) STRICT');for(const [p,s]of entries) db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,s,'fixture',Buffer.byteLength(s),null);db.close()}
const {readOriginalLocalInstances}=await import(new URL('framework/local-upgrade-instance.ts',root))
const {localUpgradeMappingKey}=await import(new URL('framework/local-upgrade-mapping.ts',root))
try {
 const directory=path.join(scratch,'source'),records=memory(),own='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
 const oldPath='instances/original-alias_Workers2_'+own+'.json',otherPath='instances/occupied_Workers3_'+other+'.json'
 const oldBody=JSON.stringify({sequence:8,updatedAt:'2026-11-07T00:00:00Z',status:'stopped'})+'\n',otherBody=JSON.stringify({sequence:90,updatedAt:'2026-11-07T00:00:00Z',status:'running'})+'\n'
 await seed(directory,[[oldPath,oldBody],[otherPath,otherBody]]);await records.set('framework-instance-uuid',own)
 const before=await fs.readFile(path.join(directory,'dss-files.sqlite'))
 let proof={instanceUUID:own},opened=0
 const pending=await materializeLegacyLocalFiles(directory,records,{deferActivation:true,currentInstance:proof})
 check(pending.status,'incomplete');check(pending.issues.some(x=>x.path===oldPath),true);check(existsSync(path.join(directory,oldPath)),false)
 const connection=await openFrameworkConnection({mode:'local',directory,login:'occupied',workerSeats:5},{storage:records,onStorageOpened:()=>opened++,onInstanceRegistered:(access,registration)=>{check(access.identity.instanceUUID,own);proof={instanceUUID:own,registered:registration}}})
 check(opened,1);check(connection.identity.instanceUUID,own);check(connection.registration.member,'original-alias');check(connection.registration.workerSeats,5)
 const current=JSON.parse(await fs.readFile(path.join(directory,connection.registration.path),'utf8'));check(current.sequence,9);check(current.status,'running')
 const report=await materializeLegacyLocalFiles(directory,records,{deferActivation:true,currentInstance:proof});check(report.status,'complete')
 check(existsSync(path.join(directory,oldPath)),false);check(await fs.readFile(path.join(directory,otherPath),'utf8'),otherBody)
 const mapped=await records.get(localUpgradeMappingKey(directory,oldPath));check(mapped.targets,[connection.registration.path]);check(mapped.sourceBytes,Buffer.byteLength(oldBody))
 check(await records.get(localUpgradeMappingKey(directory,otherPath)),undefined)
 check(await fs.readFile(path.join(directory,'dss-files.sqlite')),before)
 await connection.close()
 // New current UUID must respect old unrelated names but never map their rows
 // as its own successful registration.
 const second=path.join(scratch,'new-host'),secondRecords=memory(),newId='33333333-3333-4333-8333-333333333333';await seed(second,[[otherPath,otherBody]]);await secondRecords.set('framework-instance-uuid',newId)
 let registration;const newcomer=await openFrameworkConnection({mode:'local',directory:second,login:'occupied',workerSeats:0},{storage:secondRecords,onInstanceRegistered:(_access,row)=>registration=row})
 check(newcomer.registration.member,'occupied1');check(registration.instanceUUID,newId)
 const secondReport=await materializeLegacyLocalFiles(second,secondRecords,{deferActivation:true,currentInstance:{instanceUUID:newId,registered:registration}});check(secondReport.status,'complete')
 check(await fs.readFile(path.join(second,otherPath),'utf8'),otherBody);check(await secondRecords.get(localUpgradeMappingKey(second,otherPath)),undefined)
 await newcomer.close()
 // A live physical alias of an existing UUID wins over its retained SQL alias.
 const third=path.join(scratch,'current'),thirdRecords=memory();await seed(third,[[oldPath,oldBody],[otherPath,otherBody]]);await thirdRecords.set('framework-instance-uuid',own)
 const files=new PhysicalLocalFiles(third),currentPath='instances/current-alias_Workers1_'+own+'.json';await files.replace(currentPath,JSON.stringify({sequence:20,updatedAt:'2026-11-08T00:00:00Z',status:'running'}));await files.close()
 const active=await openFrameworkConnection({mode:'local',directory:third,login:'unused',workerSeats:4},{storage:thirdRecords,})
 check(active.registration.member,'current-alias');check(JSON.parse(await fs.readFile(path.join(third,active.registration.path),'utf8')).sequence,21)
 await active.close()
 for(const [label,body] of [['invalid-json','{bad heartbeat'],['invalid-fields',JSON.stringify({sequence:-1,updatedAt:'not-a-date',status:'running'})]]) {
  const directory=path.join(scratch,label),storage=memory(),issues=[];await seed(directory,[[oldPath,body],[otherPath,otherBody]]);await storage.set('framework-instance-uuid',own)
  const scope=JSON.stringify(['local',directory]);await storage.set('framework-instance/'+createHash('sha256').update(scope+':'+own).digest('hex'),{sequence:3})
  const original=await fs.readFile(path.join(directory,'dss-files.sqlite'))
  const connection=await openFrameworkConnection({mode:'local',directory,login:'changed-label',workerSeats:0},{storage,onOriginalInstanceIssue:error=>issues.push(error)})
  check(connection.registration.member,'original-alias');check(issues.length,1);check(issues[0].message.includes(oldPath),true)
  check(JSON.parse(await fs.readFile(path.join(directory,connection.registration.path),'utf8')).sequence,4)
  await connection.files.createIfAbsent('tasks/unrelated_P.md','继续');check(await fs.readFile(path.join(directory,'tasks/unrelated_P.md'),'utf8'),'继续')
  check(await fs.readFile(path.join(directory,'dss-files.sqlite')),original);await connection.close()
 }
 console.log(JSON.stringify({status:'passed',assertions,sourceHashes:Object.fromEntries(loaded),limits:'Actual Linux Physical registration+one-time SQL exporter; old/current aliases, new UUID collision, unchanged original SQL and exact current UUID source mapping. StoragePort/schema/FFI explicitly controlled. No native AI/DSH, Windows, multi-process same-root guarantee, default cutover or full build.'},null,2))
} finally {await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
