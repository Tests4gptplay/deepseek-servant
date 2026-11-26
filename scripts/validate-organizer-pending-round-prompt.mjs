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
 const approvedRecovery = '你的职责是解除阻塞，让原任务从已有进度继续执行。遇到阻塞，先用针对当前卡点的恢复办法。一种办法无效，就换一种。常规办法无法解除阻塞时，再判断是否需要重置 Host 状态。重置是解除相关阻塞的兜底策略，不是例行动作，也不重投任务。\n\n不论用了哪种办法，只有确认原任务越过卡点、取得实质新进展，才算恢复。工具返回成功、Host 状态重置成功、角色被唤起，都不能代替这个判断。\n\n能在内部解决的问题，不报前台。只有适用于当前阻塞的内部恢复办法都试过，兜底也未能让任务继续，才向前台说明实际卡点、已经试过什么、还缺什么才能继续。上报后，确认前台响应后可退出。'
 assert.ok(helper.includes(approvedRecovery))
 assert.match(helper,/Foreground’s response is not a Host receipt and does not mark the original Task or recovery complete/)
 assert.doesNotMatch(helper,/If progress is impossible without a missing permission, input, or user decision, route/)
 assert.ok((await fs.readFile(new URL('../lib/host.js', import.meta.url), 'utf8')).includes(approvedRecovery))
 assert.match(helper,/An assignment or start by itself does not prove that the blocked work progressed/)
 assert.match(helper,/use dss_restore_host once for that distinct Host fault/)
 assert.match(helper,/do not wait for an extra Host receipt or invent a producer settlement/)
 assert.doesNotMatch(helper,/confirms it stopped before replacement/)
 assert.ok(tools.includes('dss_snapshot')&&tools.includes('dss_claim')&&tools.includes('dss_complete'))
 console.log(JSON.stringify({status:'passed',checks:22,scope:'Installed Organizer prompt, Planner continuation priority, Helper guidance and registered existing DSS tools; no model compliance or business outcome asserted.',sdk:evidence()},null,2))
}finally{await files.close();await fs.rm(root,{recursive:true,force:true})}
