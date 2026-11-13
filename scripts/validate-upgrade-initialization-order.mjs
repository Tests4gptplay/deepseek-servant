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
const {pendingLocalInitializationOriginal}=await import(new URL('framework/local-upgrade-initialization.ts',root))
const {initializeRoleGuides}=await import(new URL('framework/role-guides.ts',root))
const {withLegacySqliteSnapshot}=await import(new URL('framework/legacy-sqlite-reader.ts',root))
const guide='technical/role-guides/Foreground.md',catalog='technical/skills/catalog.json'
try {
 const directory=path.join(scratch,'old'),storage=memory(),original='用户自定义前台，保留原文。\r\n',index=JSON.stringify({version:1,entries:[]})
 await seed(directory,[[guide,original],[catalog,index]])
 const pending=p=>pendingLocalInitializationOriginal(directory,storage,p)
 check(await pending(guide),true);check(await pending(catalog),true);check(await pending('tasks/unrelated.json'),false)
 let opened=0, refreshes=0
 const connection=await openFrameworkConnection({mode:'local',directory,login:'audit',workerSeats:0},{storage,onStorageOpened:access=>{opened++;check(access.files instanceof PhysicalLocalFiles,true)},pendingInitializationOriginal:pending})
 check(opened,1);check(connection.roleGuideInitialization,undefined)
 check(await connection.files.fileInfo(guide),undefined);check(await connection.files.fileInfo(catalog),undefined)
 await connection.initialization.resume(error=>{throw error},()=>refreshes++)
 check(connection.initialization.hasPending(),false)
 check(refreshes,0);check(await connection.files.fileInfo(guide),undefined);check(await connection.files.fileInfo(catalog),undefined)
 // An unrelated exact operation does not wait for the one-time Agent to finish.
 await connection.files.createIfAbsent('tasks/new_P.md','新任务原文');check(await fs.readFile(path.join(directory,'tasks/new_P.md'),'utf8'),'新任务原文')
 const report=await materializeLegacyLocalFiles(directory,storage,{deferActivation:true});check(report.status,'complete')
 check(await fs.readFile(path.join(directory,guide),'utf8'),original);check(await fs.readFile(path.join(directory,catalog),'utf8'),index)
 check(await pending(guide),false);check(await pending(catalog),false)
 connection.initialization.originalsChanged();await connection.initialization.resume(error=>{throw error},()=>refreshes++)
 const initialized=await initializeRoleGuides(connection.files,connection.transactions);check(initialized.status,'unchanged');check(await fs.readFile(path.join(directory,guide),'utf8'),original)
 await withLegacySqliteSnapshot(path.join(directory,'dss-files.sqlite'),async sql=>{check(Buffer.from((await sql.read(guide)).bytes).toString(),original);check(Buffer.from((await sql.read(catalog)).bytes).toString(),index)})
 await connection.close()
 const fresh=path.join(scratch,'fresh'),records=memory();let openedFresh=0
 const blank=await openFrameworkConnection({mode:'local',directory:fresh,login:'fresh',workerSeats:0},{storage:records,onStorageOpened:()=>openedFresh++,pendingInitializationOriginal:p=>pendingLocalInitializationOriginal(fresh,records,p)})
 check(openedFresh,1);check(blank.roleGuideInitialization.status,'created');check(await pendingLocalInitializationOriginal(fresh,records,guide),false)
 await blank.initialization.resume(error=>{throw error},()=>refreshes++)
 check(refreshes,2);check((await blank.files.fileInfo(catalog)).bytes>0,true);await blank.close()
 console.log(JSON.stringify({status:'passed',assertions,sourceHashes:Object.fromEntries(loaded),limits:'Actual connection acquisition, source query, owned first initialization and one-time mechanical exporter on controlled Linux SQL/physical roots. Explicit memory StoragePort/schema/FFI ports; no actual native AI/DSH, Windows, full typecheck/build, real user data or deployment.'},null,2))
} finally {await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
