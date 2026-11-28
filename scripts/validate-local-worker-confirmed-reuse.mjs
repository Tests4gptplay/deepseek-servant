import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual dss_snapshot/dss_record installation and physical files. Schema parsing
// and unrelated Markdown/skill dependencies are explicit stubs. No native DSH,
// Windows, full typecheck or production cutover is asserted by this script.
const sourceRoot=new URL('../src/',import.meta.url),loaded=new Map()
const data=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64')
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='zod')return{url:data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`),shortCircuit:true}
 if(specifier==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(){throw new Error('Markdown outside this test')}`),shortCircuit:true}
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot.href)&&specifier.endsWith('.js')){
 const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
 if(url.href===new URL('framework/skills.ts',sourceRoot).href)return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`),shortCircuit:true}
 if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
 return next(specifier,context)},load(url,context,next){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { transferPhysicalWorker, resumePhysicalWorkerTransfer } = await import('../src/framework/physical-worker-transfer.ts')
const { workerTransferPath } = await import('../src/framework/worker-business.ts')
const { GitAuthorityStore } = await import('../src/framework/git-authority.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { readJson } = await import('../src/framework/task-files.ts')
const source=stripTypeScriptTypes(readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8'),{mode:'transform'})
const a=source.indexOf('committed: async (binding, published, localPublished)=>{');assert(a>=0)
const b=source.indexOf('\n                }\n            },\n            files:',a);assert(b>a)
const arrow=source.slice(a+'committed: '.length,b+'\n                }'.length)
const committed=Function('PhysicalLocalFiles','GitAuthorityStore','workerTransferPath','withSnapshot','readJson','return '+arrow.replace('async (binding, published, localPublished)=>','async function(binding, published, localPublished)'))(PhysicalLocalFiles,GitAuthorityStore,workerTransferPath,withSnapshot,readJson)
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'local-confirmed-reuse-'));const files=new PhysicalLocalFiles(temp)
const binding={role:'Worker',workId:'work',executionId:'old',generation:1}
const record={identity:binding,sessionId:'session',generation:1}
const marker=workerTransferPath('scope','old')
const input={commandId:'command',markerPath:marker,directory:'work/stage',replyPath:'work/reply',reply:'result',notePath:'work/note',records:[],signalPath:'state/Planner_w'}
const calls=[];const checks=[];let markerReads=0;const read=files.read.bind(files);files.read=async(s,p)=>{if(p===marker)markerReads++;return read(s,p)}
const host={files,records:{},roleRecords:new Map([['work',structuredClone(record)]]),workerBusinessScope:()=> 'scope',retireWorkerBusiness:r=>calls.push(r)}
const transfer=()=>({version:1,record:structuredClone(record),successorId:'Planner',successorRole:'Planner'})
try {
 const fresh=await transferPhysicalWorker(files,input,async()=>transfer(),async()=>{},async()=>[])
 assert(fresh?.physical.published);const before=markerReads;await committed.call(host,binding,undefined,fresh);assert.equal(markerReads,before);assert.equal(calls.length,1);checks.push('fresh durable publication reused without marker read')
 const replay=await transferPhysicalWorker(files,input,async()=>{throw Error('must not prepare replay')},async()=>{},async()=>[]);assert.equal(replay,undefined);const rb=markerReads;await committed.call(host,binding,undefined,replay);assert.equal(markerReads,rb+1);checks.push('replay retains marker read')
 await files.delete(marker)
 for(const variant of [{...record,businessTransferred:true},{...record,stopped:true},{...record,identity:{...binding,executionId:'new'}},{...record,generation:2},{...record,sessionId:'changed'},undefined]){
 host.roleRecords.clear();if(variant)host.roleRecords.set('work',variant);const n=calls.length,m=markerReads;await committed.call(host,binding,undefined,fresh);assert.equal(markerReads,m+1);assert.equal(calls.length,n);}
 checks.push('cleanup missing marker plus transferred/stopped/replaced/generation/session/absent owner cannot reuse')
 host.roleRecords.set('work',record);const replace=files.replace.bind(files);files.replace=async(p,text)=>{if(p===marker&&JSON.parse(text).physical?.published)throw Error('final confirmation failed');return replace(p,text)}
 await assert.rejects(transferPhysicalWorker(files,input,async()=>transfer(),async()=>{},async()=>[]),/final confirmation failed/);files.replace=replace
 checks.push('failed final marker confirmation returns no fresh success')
 const resumed=await resumePhysicalWorkerTransfer(files,marker,async()=>{},async()=>[]);assert.equal(resumed,undefined);const after=await transferPhysicalWorker(files,input,async()=>{throw Error('no reprepare')},async()=>{},async()=>[]);assert.equal(after,undefined);checks.push('resume and post-resume replay remain old path')
 console.log(JSON.stringify({status:'passed',checks,scope:'Actual physical publication and source-extracted committed callback; controlled retirement sink, no native shutdown/GUI'},null,2))
}finally{await files.close();await fs.rm(temp,{recursive:true,force:true})}
