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
const {paths,readMemberStatus}=await import('../src/framework/task-files.ts')
const {memberRecoveryEligible,scanMemberRecovery}=await import('../src/framework/recovery.ts')
const source=readFileSync(new URL('framework/role-runtime.ts',root),'utf8');loaded.set('framework/role-runtime.ts',createHash('sha256').update(source).digest('hex'))
const start=source.indexOf('  private async scanMembers('),end=source.indexOf('\n  private async arrangeNativeContinuation(',start)
assert(start>=0&&end>start)
const Scope=new Function('PhysicalLocalFiles','paths','readMemberStatus','memberRecoveryEligible',stripTypeScriptTypes('class Scope {\n'+source.slice(start,end)+'\n}',{mode:'transform'})+'\nreturn Scope')(PhysicalLocalFiles,paths,readMemberStatus,memberRecoveryEligible)
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-recovery-member-')),files=new PhysicalLocalFiles(temp)
const task={version:1,taskId:'30000000-0000-4000-8000-000000000001',route:'P',sourcePath:'tasks/actual_P.md',owner:'A',members:['A'],status:'running'}
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
try{
 await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(paths.inbox(task.taskId,'A'),'Actual accepted work')
 const runtime=new Scope();runtime.files=files;runtime.config={member:'A'};runtime.roleRecords=new Map();runtime.roleKey=(role,id,worker)=>[role,id,worker??''].join(':');runtime.manuallyCleared=async()=>false;runtime.error=e=>{throw e};runtime.active=record=>record.nativeState==='running'||record.nativeState==='waiting'
 const note=id=>paths.member(task.taskId,'A')+'/workers/'+id+'/notes.md'
 function role(id,props={}){const record={identity:{taskId:task.taskId,role:'Worker',workerId:id,executionId:'execution-'+id},...props};runtime.roleRecords.set(runtime.roleKey('Worker',task.taskId,id),record);return record}
 await files.replace(note('active'),'Current live work');await files.replace(note('interrupted'),'Exact saved continuation')
 role('active',{nativeState:'running'});const interrupted=role('interrupted',{stopped:true})
 const scan=async()=>{const s=await files.snapshot();try{return await runtime.scanMembers(s,[task])}finally{await s.release()}}
 let members=await scan();check(members.length,1);check(scanMemberRecovery(members).map(x=>x.workerId),['interrupted'])
 runtime.roleRecords.get(runtime.roleKey('Worker',task.taskId,'active')).nativeState='waiting';check(scanMemberRecovery(await scan()).map(x=>x.workerId),['interrupted'])
 for(const ended of [{businessTransferred:true},{released:true},{completedRound:true},{gitSettledWakeId:'old',lastWake:{id:'old'}}]){
 Object.assign(interrupted,{businessTransferred:false,released:false,completedRound:false,gitSettledWakeId:undefined,lastWake:undefined},ended)
 check(scanMemberRecovery(await scan()),[])
 }
 Object.assign(interrupted,{gitSettledWakeId:undefined,lastWake:undefined,completedRound:false,businessTransferred:false,released:false})
 await files.replace(note('interrupted'),'');check(scanMemberRecovery(await scan()),[])
 // No currently executing Worker remains: preserve the original Planner fallback.
 runtime.roleRecords.get(runtime.roleKey('Worker',task.taskId,'active')).nativeState='idle';await files.replace(note('active'),'')
 check(scanMemberRecovery(await scan()).map(x=>x.role),['Planner'])
 runtime.roleRecords.set(runtime.roleKey('Planner',task.taskId),{identity:{executionId:'planner'},nativeState:'running'})
 check(scanMemberRecovery(await scan()),[])
 await files.replace(note('interrupted'),'Continue original work')
 const targets=scanMemberRecovery(await scan());check(targets.map(x=>x.workerId),['interrupted']);check(scanMemberRecovery(await scan(),targets),[])
 await files.replace(paths.memberStatus(task.taskId,'A'),JSON.stringify({state:'complete'}));check(await scan(),[])
 await files.replace(paths.memberStatus(task.taskId,'A'),JSON.stringify({state:'running'}));await files.replace(paths.inbox(task.taskId,'A'),'');check(await scan(),[])
 check(source.includes('const targets = scanMemberRecovery(members)'),true);check(source.includes('for (const target of scanMemberRecovery(members))'),true)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual scanMembers body plus real physical notes and recovery selector; native running/waiting observations explicitly controlled. Existing startup/resume control and native-continuation admission unchanged.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await files.close();await fs.rm(temp,{recursive:true,force:true});hooks.deregister()}
