import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {createHash} from 'node:crypto'
const root=new URL('../src/',import.meta.url),loaded=new Map(),data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64')
const hooks=registerHooks({resolve(s,c,n){if(s==='zod')return{url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true};if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}return n(s,c)},load(u,c,n){if(u.startsWith(root.href)&&u.endsWith('.ts')){const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})

const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {InstanceRegistration}=await import('../src/framework/instances.ts')
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-physical-instance-'))
const files=new PhysicalLocalFiles(temp),statePath=path.join(temp,'test-technical-state.json')
const records={async get(k){try{return JSON.parse(await fs.readFile(statePath,'utf8'))[k]}catch(e){if(e.code==='ENOENT')return;throw e}},async set(k,v){let state={};try{state=JSON.parse(await fs.readFile(statePath,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e};state[k]=v;await fs.writeFile(statePath,JSON.stringify(state))}}
const config={repositoryId:'local:test',repositoryOwner:'A',login:'A',instanceUUID:'11111111-1111-4111-8111-111111111111',workerSeats:2}
let now=1_000_000,assertions=0,commitCalls=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
files.commit=async()=>{commitCalls++;throw Error('Generic physical commit must not be used')}
const read=async p=>{const v=await files.snapshot();try{return await files.read(v,p)}finally{await v.release()}}
try {
 const registration=new InstanceRegistration(files,records,{...config},()=>now)
 const first=await registration.register();check(first.member,'A');check(first.workerSeats,2);check(JSON.parse(await read(first.path)).sequence,1);check(commitCalls,0)
 const deleteFile=files.delete.bind(files);let cut=true
 files.delete=async p=>{if(cut&&p===first.path){cut=false;throw Error('actual old-name deletion interruption')}return deleteFile(p)}
 await assert.rejects(registration.updateWorkerSeats(3),/interruption/);assertions++
 check(await read(first.path)!==undefined,true)
 const newPath=first.path.replace('Workers2','Workers3');check(JSON.parse(await read(newPath)).sequence,2)
 await files.replace('task-runs/unrelated/A/Plan.md','Independent Task continues')
 await files.replace('instances/B_Workers1_22222222-2222-4222-8222-222222222222.json',JSON.stringify({sequence:1,updatedAt:new Date(now).toISOString(),status:'running'}))
 files.delete=deleteFile
 // New registration object reads persisted exact pending publication; unrelated
 // instance names are not a whole-directory dependency or a retry rejection.
 const restored=new InstanceRegistration(files,records,{...config,workerSeats:3},()=>now)
 const resumed=await restored.register();check(resumed.path,newPath);check(await read(first.path),undefined);check(JSON.parse(await read(newPath)).sequence,2);check(await read('task-runs/unrelated/A/Plan.md'),'Independent Task continues')
 let state=JSON.parse(await fs.readFile(statePath,'utf8'));check(Object.values(state)[0].pending,undefined)
 const set=records.set.bind(records);let failBinding=true
 records.set=async(k,v)=>{if(failBinding&&!v.pending){failBinding=false;throw Error('actual technical binding save interruption')}return set(k,v)}
 now+=31_000;await assert.rejects(restored.tick(),/binding save/);assertions++
 const beat=JSON.parse(await read(newPath));check(beat.sequence,3)
 records.set=set
 const resumedAgain=new InstanceRegistration(files,records,{...config,workerSeats:3},()=>now)
 await resumedAgain.register();check(JSON.parse(await read(newPath)).sequence,3)
 state=JSON.parse(await fs.readFile(statePath,'utf8'));check(Object.values(state)[0].pending,undefined)
 const before=await read(newPath);await resumedAgain.tick();check(await read(newPath),before)
 await resumedAgain.disconnect();check(JSON.parse(await read(newPath)).status,'stopped');check(commitCalls,0)
 check((await fs.readdir(path.join(temp,'instances'))).filter(p=>p.includes(config.instanceUUID)).length,1)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual InstanceRegistration and physical files with file-backed technical state, exact failed writes and cold object reconstruction. No generic transaction used; no atomic multi-file or cross-process guarantee, no native DSH/Windows acceptance.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await files.close();await fs.rm(temp,{recursive:true,force:true});hooks.deregister()}
