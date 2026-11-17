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
 assert.ok(installed.includes("When required child results are still outstanding, record the waiting items and next steps in this O Task's Note."))
 assert.ok(installed.includes("Before ending this unfinished round, use a fresh dss_snapshot to check this O Task's current notifications"))
 assert.ok(installed.includes('if any have already arrived, consume them with dss_claim, read and handle their actual child records, then recheck.'))
 assert.ok(installed.includes('If none are pending, end this round normally; a later arrival resumes through the existing Host wake.'))
 assert.ok(installed.indexOf('Before ending this unfinished round')<installed.indexOf('When all still-required child results are complete and evaluated'))
 assert.ok(!frameworkRolePrompt('Planner').includes('Before ending this unfinished round'))
 assert.ok(tools.includes('dss_snapshot')&&tools.includes('dss_claim')&&tools.includes('dss_complete'))
 console.log(JSON.stringify({status:'passed',checks:8,scope:'Actual installed Organizer role prompt and registered existing DSS tools; no model compliance or business outcome asserted.',sdk:evidence()},null,2))
}finally{await files.close();await fs.rm(root,{recursive:true,force:true})}
