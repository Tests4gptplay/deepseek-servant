import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
const root = new URL('../src/', import.meta.url), loaded = new Map()
const hooks = registerHooks({ resolve(s,c,n) { if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')) {const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return {url:u.href,shortCircuit:true}}return n(s,c)},load(u,c,n) {if(u.startsWith(root.href)&&u.endsWith('.ts')) {const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return {format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { samePhysicalPublication, publishPreparedPhysicalFile } = await import('../src/framework/physical-publication-evidence.ts')
const dir = await fs.mkdtemp(path.join(os.tmpdir(),'dss-publication-evidence-')), files=new LocalRecordFiles(dir)
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
try {
 await files.replace('run/signal.stage','');const before=await files.fileInfo('run/signal.stage')
 let evidenceReads=0,infoReads=0;const info=files.fileInfo.bind(files);files.fileInfo=async(...args)=>{infoReads++;return info(...args)}
 await publishPreparedPhysicalFile(files,'run/signal.stage','state/Worker_A',before.version,async()=>{evidenceReads++;return []})
 check(infoReads,0);check(evidenceReads,0)
 const observed=await info('state/Worker_A');check(samePhysicalPublication(before.version,observed.version),true)
 await publishPreparedPhysicalFile(files,'run/signal.stage','state/Worker_A',before.version,async()=>{evidenceReads++;return []});check(evidenceReads,0)
 await files.deleteObserved('state/Worker_A',observed.version)
 await publishPreparedPhysicalFile(files,'run/signal.stage','state/Worker_A',before.version,async()=>[{path:'state/Worker_A',version:observed.version}]);check(await files.read('state/Worker_A'),undefined)
 await files.replace('state/Worker_A','');const newer=await info('state/Worker_A');check(samePhysicalPublication(before.version,newer.version),false)
 await assert.rejects(publishPreparedPhysicalFile(files,'run/signal.stage','state/Worker_A',before.version,async()=>[{path:'state/Worker_A',version:newer.version}]),/not confirmed/);assertions++
 check((await info('state/Worker_A')).version,newer.version)
 await assert.rejects(publishPreparedPhysicalFile(files,'run/never-created','state/never-created',before.version,async()=>[]),/not confirmed/);assertions++
 await files.replace('run/body.stage','original');const body=await info('run/body.stage');await files.rename('run/body.stage','run/body');await files.append('run/body',' user edit')
 await assert.rejects(publishPreparedPhysicalFile(files,'run/body.stage','run/body',body.version),/not confirmed/);assertions++;check(await files.read('run/body'),'original user edit')
 check(samePhysicalPublication('garbage','garbage'),false)
 console.log(JSON.stringify({status:'passed',assertions,sourceHashes:Object.fromEntries(loaded),limits:'Actual Linux rename, exact file observations and existing source evidence. No Windows, cross-process exclusion or native consumer integration claimed.'},null,2))
} finally {await fs.rm(dir,{recursive:true,force:true});hooks.deregister()}
