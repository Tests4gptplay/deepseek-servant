import assert from 'node:assert/strict'
import {hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const checks=[]
function verify(role,extra={}) {
 const sections=new Map(),tools=new Map()
 const ctx={on:()=>()=>{},effect(){},systemPrompt:{section:s=>sections.set(s.name,s.text)},tools:{register:t=>tools.set(t.name,t)}}
 const binding={role,taskId:'10000000-0000-4000-8000-000000000001',member:'A',owner:'A',...extra}
 installFrameworkRoleTools(ctx,{id:role,session:{}},binding,{files:{},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:()=>{},transact:async()=>{}})
 const prefix='Current role and source locations: ',text=sections.get('deepseek-servant:framework-binding')
 assert(text?.startsWith(prefix));return JSON.parse(text.slice(prefix.length)).sourceLocations
}
try{
 const worker=verify('Worker',{workerId:'worker-one'}),planner=verify('Planner')
 assert(!Object.hasOwn(worker,'memberInboxPath'));checks.push('Worker does not receive Planner inbox location')
 for(const key of ['contractPath','notePath','replyPath','handoffPath']){assert(worker[key]);checks.push('Worker retains '+key)}
 assert(planner.memberInboxPath);checks.push('Planner retains its own inbox location')
 console.log(JSON.stringify({status:'passed',checks,evidence:evidence(),limits:'Actual registered role binding section, controlled context; no model compliance or full DSH claim.'},null,2))
}finally{hooks.deregister()}
