import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {frameworkRolePrompt}=await import('../src/framework/role-prompts.ts')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-organizer-pending-prompt-'))
const files=new PhysicalLocalFiles(root)
const sections=[]
const tools=[]
const agent={id:'organizer-prompt-audit',session:{}}
const ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section:x=>sections.push(x)},tools:{register:x=>tools.push(x.name)}}
const binding={role:'Organizer',owner:'Evidence',taskId:'00000000-0000-4000-8000-000000000001',workId:'organizer-prompt-audit',executionId:'execution-prompt-audit'}
try{
 installFrameworkRoleTools(ctx,agent,binding,{files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),transact:async()=>{throw Error('No writes in prompt test')},onError:()=>{}})
 const installed=sections.find(x=>x.name==='deepseek-servant:framework-role')?.text
 assert.equal(installed,frameworkRolePrompt('Organizer'))
 assert.ok(installed.includes("record the exact child Task IDs"))
 assert.ok(installed.includes("identify the actual outstanding child Task whose authoritative state still owns the work"))
 assert.ok(installed.includes("a child already terminal without the required result is not a continuation"))
 assert.ok(installed.includes("Consume pending notifications with dss_claim"))
 assert.ok(installed.includes("without waiting for a Host receipt or a child acknowledgement"))
 assert.ok(installed.indexOf('Before ending an unfinished round')<installed.indexOf('When all still-required child results are complete and evaluated'))
 assert.ok(!frameworkRolePrompt('Planner').includes("identify the actual outstanding child Task"))
 const planner=frameworkRolePrompt('Planner')
 assert.match(planner,/highest business priority is to continue the accepted original Task from its saved progress through final completion/)
 assert.match(planner,/without a genuine handoff or a verifiable existing continuation is an invalid action and is strictly prohibited/)
 assert.match(planner,/an old notification, or no fresh assignment never cancels the original unfinished responsibility/)
 assert.match(planner,/legitimate wait must be supported by existing Task state, with the actual next owner and concrete trigger/)
 const helper=frameworkRolePrompt('Helper')
 assert.match(helper,/absence of a new assignment does not resolve a still-open original recovery obligation/)
 assert.match(helper,/Do not exit while the Task you are recovering is still stalled/)
 assert.match(helper,/An assignment or start by itself does not prove that the blocked work progressed/)
 assert.match(helper,/use dss_restore_host once for that distinct Host fault/)
 assert.match(helper,/do not wait for an extra Host receipt or invent a producer settlement/)
 assert.doesNotMatch(helper,/confirms it stopped before replacement/)
 assert.ok(tools.includes('dss_snapshot')&&tools.includes('dss_claim')&&tools.includes('dss_complete'))
 console.log(JSON.stringify({status:'passed',checks:19,scope:'Installed Organizer prompt, Planner continuation priority, Helper guidance and registered existing DSS tools; no model compliance or business outcome asserted.',sdk:evidence()},null,2))
}finally{await files.close();await fs.rm(root,{recursive:true,force:true})}
