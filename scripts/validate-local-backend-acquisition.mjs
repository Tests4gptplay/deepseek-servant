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
const {openFrameworkStorage}=await import(new URL('framework/connection.ts',root))
const {materializeLegacyLocalFiles,localStartupUpgradeKey}=await import(new URL('framework/local-startup-upgrade.ts',root))
const {localUpgradeResultKey}=await import(new URL('framework/local-upgrade-mapping.ts',root))
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-backend-acquire-'))
let assertions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(f,r)=>{await assert.rejects(f,r);assertions++}
const hash=v=>createHash('sha256').update(v).digest('hex')
const key=directory=>'framework-connection-settings/'+hash(JSON.stringify(['local',directory]))
const settings=directory=>({mode:'local',directory,workerSeats:0})
const memory=()=>{const m=new Map();return{async get(k){return structuredClone(m.get(k))},async set(k,v){m.set(k,structuredClone(v))},async list(){throw Error('Backend acquisition must not list records')},async delete(k){m.delete(k)}}}
const seed=async(directory)=>{await fs.mkdir(directory,{recursive:true});const db=new DatabaseSync(path.join(directory,'dss-files.sqlite'));db.exec("CREATE TABLE files(path TEXT PRIMARY KEY, content TEXT NOT NULL, version TEXT NOT NULL, bytes INTEGER NOT NULL, binary BLOB) STRICT");db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run('debug/old.md','original','fixture',8,null);db.close()}
try {
 // An ordinary selected SQL directory with no original database is not an empty
 // physical store. Neither saved settings nor unrelated user material changes.
 const lost=path.join(scratch,'lost'),lostStore=memory();await fs.mkdir(lost);await fs.writeFile(path.join(lost,'mine.txt'),'user text');await lostStore.set(key(lost),settings(lost))
 await rejects(()=>openFrameworkStorage(settings(lost),{storage:lostStore}),/previously selected Local SQL source is missing/)
 check(await fs.readFile(path.join(lost,'mine.txt'),'utf8'),'user text');check(await lostStore.get(key(lost)),settings(lost));check(await fs.readdir(lost),['mine.txt'])
 await fs.writeFile(path.join(lost,'dss-files.sqlite-wal'),'retained WAL')
 await rejects(()=>openFrameworkStorage(settings(lost),{storage:lostStore}),/previously selected Local SQL source is missing/)
 check(await fs.readFile(path.join(lost,'dss-files.sqlite-wal'),'utf8'),'retained WAL')
 // The backend fact follows real acquisition, and the freshly acquired empty
 // directory can be reopened even before the first business write.
 const fresh=path.join(scratch,'fresh'),freshStore=memory();let sawRoot=false
 const save=freshStore.set.bind(freshStore);freshStore.set=async(k,v)=>{if(k===key(fresh)){sawRoot=(await fs.stat(fresh)).isDirectory();check(v.localBackend,'physical')}return save(k,v)}
 const first=await openFrameworkStorage(settings(fresh),{storage:freshStore});check(sawRoot,true);check(await fs.readdir(fresh),[]);await first.close()
 const again=await openFrameworkStorage(settings(fresh),{storage:freshStore});await again.files.replace('debug/user.md','editable');await again.close();await fs.rm(path.join(fresh,'debug'),{recursive:true})
 const edited=await openFrameworkStorage(settings(fresh),{storage:freshStore});check(await fs.readdir(fresh),[]);await edited.close()
 // A known physical root neither reads an old conversion result nor gates user
 // deletions against its retained source.
 const get=freshStore.get.bind(freshStore);freshStore.get=async k=>{if(k.startsWith('framework-physical-upgrade/')||k.startsWith('framework-local-upgrade-result/'))throw Error('Unexpected old-source lookup');return get(k)}
 const independent=await openFrameworkStorage(settings(fresh),{storage:freshStore});await independent.close();check(true,true)
 // A failed actual open must not record a backend or create a replacement root.
 await fs.rm(fresh,{recursive:true});await rejects(()=>openFrameworkStorage(settings(fresh),{storage:freshStore}),/existing Local directory is unavailable/);check(existsSync(fresh),false)
 // A retained SQL source can activate physical access, but no backend fact can
 // mistake acquisition or mechanical export alone for the full one-time work.
 const old=path.join(scratch,'old'),oldStore=memory();await seed(old);await oldStore.set(key(old),settings(old));const original=await fs.readFile(path.join(old,'dss-files.sqlite'))
 const legacy=await openFrameworkStorage(settings(old),{storage:oldStore});check((await oldStore.get(key(old))).localBackend,undefined);await legacy.close();check(await fs.readFile(path.join(old,'dss-files.sqlite')),original)
 await rejects(()=>materializeLegacyLocalFiles(old,oldStore,{onProgress:({step})=>{if(step==='prepared')throw Error('interrupted accepted export')}}),/interrupted accepted export/)
 check((await oldStore.get(localStartupUpgradeKey(old))).status,'publishing')
 await fs.rename(path.join(old,'dss-files.sqlite'),path.join(old,'retained-original.sqlite'))
 const partial=await openFrameworkStorage(settings(old),{storage:oldStore});check((await oldStore.get(key(old))).localBackend,undefined);await partial.close()
 const missing=await materializeLegacyLocalFiles(old,oldStore);check(missing.status,'incomplete');check(missing.issues[0].code,'source-missing');check(await fs.readFile(path.join(old,'retained-original.sqlite')),original)
 await fs.rename(path.join(old,'retained-original.sqlite'),path.join(old,'dss-files.sqlite'))
 const report=await materializeLegacyLocalFiles(old,oldStore);check(report.status,'complete')
 const mechanical=await openFrameworkStorage(settings(old),{storage:oldStore});check((await oldStore.get(key(old))).localBackend,undefined);await mechanical.close()
 // Exact full AI completion evidence is the existing producer contract, not
 // inferred from empty folders or a mechanical report's status.
 await oldStore.set(localUpgradeResultKey(old),{kind:'dss-local-upgrade-result',directory:old,operationId:report.operationId,completedAt:new Date().toISOString(),report})
 await fs.rename(path.join(old,'dss-files.sqlite'),path.join(old,'retained-original.sqlite'))
 const complete=await openFrameworkStorage(settings(old),{storage:oldStore});check((await oldStore.get(key(old))).localBackend,'physical');await complete.close()
 check(await fs.readFile(path.join(old,'retained-original.sqlite')),original)
 // An unsuccessful acquisition at a file path never publishes the backend fact.
 const file=path.join(scratch,'not-directory'),fileStore=memory();await fs.writeFile(file,'mine');await rejects(()=>openFrameworkStorage(settings(file),{storage:fileStore}),/ENOTDIR|not a directory/);check(await fileStore.get(key(file)),undefined);check(await fs.readFile(file,'utf8'),'mine')
 console.log(JSON.stringify({status:'passed',assertions,sourceHashes:Object.fromEntries(loaded),limits:'Actual default connection acquisition and exact one-time exporter on temporary Linux roots/SQLite. Memory StoragePort and schema/FFI adapters explicit. Completed AI fact is seeded from its existing contract, not a native model run. No Windows/native DSH/full build/user data or multi-process claim.'},null,2))
} finally {hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
