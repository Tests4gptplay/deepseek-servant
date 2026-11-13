import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {existsSync,readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
const root=new URL('../src/',import.meta.url)
const hooks=registerHooks({resolve(s,c,n){
 if(s==='zod')return{url:'data:text/javascript,export const z=new Proxy(function(){},{get(_t,k){if(k==="parse")return v=>v;return z},apply(){return z}})',shortCircuit:true}
 if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')){
  const u=new URL(s.slice(0,-3)+'.ts',c.parentURL)
  if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}
 }
 return n(s,c)
},load(u,c,n){
 if(u.startsWith(root.href)&&u.endsWith('.ts'))return{format:'module',source:stripTypeScriptTypes(readFileSync(new URL(u),'utf8'),{mode:'transform'}),shortCircuit:true}
 return n(u,c)
}})
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {initializeRoleGuides}=await import('../src/framework/role-guides.ts')
const {upgradeForegroundGuide}=await import('../src/framework/foreground-guide-upgrade.ts')
const {foregroundGuidePath}=await import('../src/framework/foreground-prompt.ts')
const {foregroundFullGuide,frameworkRolePrompt}=await import('../src/framework/role-prompts.ts')
const oldSentence='After the user explicitly chooses restoration, call dss_task_restore with the original taskId, actual retained recordPaths, the evidence-based route and owner, and continuation explaining their decision, known progress and missing information.'
const newSentences='After the user explicitly chooses restoration, check retained Task status: a known completed Task stays complete, and a later correction or new requirement uses a new Task ID referencing its results. Otherwise call dss_task_restore with the original taskId, actual retained recordPaths, the evidence-based route and owner, and continuation explaining their decision, known progress and missing information.'
const oldIntro='Task-completion feedback has a required response order: first use the received taskId and supplied taskMetadataPath or context.taskPath to look up the existing task title in its sourcePath filename and read its actual status; then send the task-specific short response; only afterwards inspect results and acceptance details and report them.'
const newIntro='Task-completion feedback has a required response order: first use the received taskId and supplied taskMetadataPath or context.taskPath (otherwise tasks/<taskId>.json) to read the existing task title in its sourcePath filename and its actual status. If current metadata is absent, read the existing archived Task identity at context.taskHistoryPath when supplied, otherwise archives/task-identities/<taskId>.json, for its sourcePath, status and resultPaths. Use that identity only for historical feedback, never to restart the Task. Then send the task-specific short response; only afterwards inspect results and acceptance details and report them.'
const oldResults="Use current tasks/<taskId>.json resultPaths and the selected Task's archiveRecordsPath and archiveDirectory returned by dss_snapshot or dss_claim."
const olderResults='Use current tasks/<taskId>.json resultPaths, archives/<taskId>/records.md, and the exact outputs, retainedPaths and relocatedReferences in archives/<taskId>/retention.json to find and read preserved material.'
const newResults="Use the selected Task's current metadata resultPaths and returned archiveRecordsPath and archiveDirectory; if current metadata was removed, use the existing archived Task identity's resultPaths and select that taskId in dss_snapshot for its exact historical archiveDirectory and archiveRecordsPath."
const current=foregroundFullGuide()
assert.ok(current.includes(newSentences))
assert.ok(current.includes(newIntro) && current.includes(newResults))
const prior=current.replace(newSentences,oldSentence)
assert.ok(prior.includes(oldSentence))
const beforeD005=prior.replace(newIntro,oldIntro).replace(newResults,oldResults)
const beforeD005Older=beforeD005.replace(oldResults,olderResults)
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dss-completed-guide-'))
const files=new PhysicalLocalFiles(directory)
const read=async()=>{const snapshot=await files.snapshot();try{return Buffer.from(await files.readBytes(snapshot,foregroundGuidePath)).toString('utf8')}finally{await snapshot.release()}}
let assertions=0
const check=(actual,expected)=>{assert.deepEqual(actual,expected);assertions++}
try{
 const customized='\uFEFF'+beforeD005.replaceAll('\n','\r\n')+'\r\nUser-maintained note stays untouched.\r\n'
 const expected='\uFEFF'+current.replaceAll('\n','\r\n')+'\r\nUser-maintained note stays untouched.\r\n'
 check(upgradeForegroundGuide(prior).text,current)
 check(upgradeForegroundGuide(prior).changedRules,1)
 check(upgradeForegroundGuide(beforeD005).text,current)
 check(upgradeForegroundGuide(beforeD005).changedRules,3)
 check(upgradeForegroundGuide(beforeD005Older).text,current)
 check(upgradeForegroundGuide(beforeD005Older).changedRules,3)
 check(upgradeForegroundGuide(current).changedRules,0)
 check(upgradeForegroundGuide('Wholly custom: '+oldSentence).text,'Wholly custom: '+oldSentence)
 const fenced=current+'\n```text\n'+oldSentence+'\n```\n'
 check(upgradeForegroundGuide(fenced).text,fenced)
 const inline=prior.replace(oldSentence,'My inline note stays. '+oldSentence)
 check(upgradeForegroundGuide(inline).text,current.replace(newSentences,'My inline note stays. '+newSentences))
 await files.replace(foregroundGuidePath,customized)
 const first=await initializeRoleGuides(files,undefined)
 check([first.status,first.changedRules],['migrated',3])
 const actual=await read()
 check(actual,expected)
 const before=(await files.fileInfo(foregroundGuidePath)).version
 const second=await initializeRoleGuides(files,undefined)
 check([second.status,second.changedRules],['unchanged',0])
 check((await files.fileInfo(foregroundGuidePath)).version,before)
 check(await read(),expected)
 check(frameworkRolePrompt('Helper').includes('A completed Task cannot reopen for a later correction or new requirement'),true)
 console.log(JSON.stringify({status:'passed',assertions,scope:'Combined D005 and D013 exact old Foreground sentences, physical persisted single upgrade, idempotence, BOM/CRLF/user bytes; Helper is runtime prompt text, not a persisted guide.'}))
}finally{await files.close();await fs.rm(directory,{recursive:true,force:true});hooks.deregister()}
