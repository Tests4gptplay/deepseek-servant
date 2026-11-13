import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {createHash} from 'node:crypto'
const root=new URL('../src/',import.meta.url),loaded=new Map()
const hooks=registerHooks({resolve(s,c,n){if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}return n(s,c)},load(u,c,n){if(u.startsWith(root.href)&&u.endsWith('.ts')){const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})
const {foregroundFullGuide,frameworkRolePrompt}=await import('../src/framework/role-prompts.ts')
const {foregroundCorePrompt}=await import('../src/framework/foreground-prompt.ts')
const {upgradeForegroundGuide}=await import('../src/framework/foreground-guide-upgrade.ts')
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
try{
 const full=foregroundFullGuide(),core=foregroundCorePrompt
 for(const guide of [full,core]){
  check(guide.includes('Before a final user-facing reply, use a fresh dss_snapshot to check for later notifications.'),true)
  check(guide.includes('If any are present, consume them with the existing claim/read tools, read and process their actual contents, then recheck'),true)
  check(guide.includes('Interim replies and ongoing work need not be interrupted'),true)
  check(/no required publication-time check|does not require a final notification check|force a final notification check/.test(guide),false)
 }
 check(core.includes('dss-files.sqlite'),false);check(full.includes('dss-files.sqlite'),false)
 check(full.includes('Keep task titles concise and prefer short English names when they still make the task recognizable.'),true)
 const oldNaming=full.replace('Keep task titles concise and prefer short English names when they still make the task recognizable. ','')
 check(upgradeForegroundGuide(oldNaming).text,full)
 check(upgradeForegroundGuide(oldNaming).changedRules,1)
 check(upgradeForegroundGuide('My custom naming policy.').text,'My custom naming policy.')
 check(core.includes('use the supplied exact returned path even when that field is absent'),false)
 check(core.includes('If no Task is selected, the work is Direct, or the selected Task metadata is unavailable, the archive fields may be absent'),true)
 check(core.includes('do not invent a path or treat their absence alone as a missing archive'),true)
 const before='Before final handoff, consume and process pending work, then recheck.'
 const old='Foreground chooses when to consume later notifications; publication does not require a final notification check.'
 const old1='The Host does not force a claim, reread or rewrite at turn-stopping, and pending notifications do not block dss_conversation_send.'
 const old2='There is no required publication-time check, clear-queue condition or completion handshake.'
 const new1='Before a final user-facing reply, use a fresh dss_snapshot to check for later notifications. If any are present, consume them with the existing claim/read tools, read and process their actual contents, then recheck before publishing the final reply.'
 const new2='When none are pending, continue the final reply without another handshake. Interim replies and ongoing work need not be interrupted by a later notification; the Host does not decide the business response or add a publication-time acknowledgement.'
 const prior=full.replace(before,old).replace(new1,old1).replace(new2,old2)
 const upgraded=upgradeForegroundGuide(prior);check(upgraded.text,full);check(upgraded.changedRules,3)
 check(upgradeForegroundGuide(full).changedRules,0)
 const custom='\uFEFF'+prior.replaceAll('\n','\r\n')+'\r\nMy actual user-maintained instruction remains here.\r\n'
 const fixed=upgradeForegroundGuide(custom);check(fixed.text,'\uFEFF'+full.replaceAll('\n','\r\n')+'\r\nMy actual user-maintained instruction remains here.\r\n')
 check(upgradeForegroundGuide('A wholly custom guide. '+old).text,'A wholly custom guide. '+old)
 const quoted=full+'\n```text\n'+old1+'\n```\n';check(upgradeForegroundGuide(quoted).text,quoted)
 const oldMechanical = "records.md is Recorder-authored prose; state.json in the same directory is program-owned mechanical lifecycle/Host/cleanup state, not result prose or another retention catalog."
 const newMechanical = "records.md is Recorder-authored prose; program-owned mechanical lifecycle/Host/cleanup facts are in current Task metadata runtimeState for Git and archive state.json for Local, not result prose or another retention catalog."
 const mechanicalPrior = full.replace(newMechanical, oldMechanical)
 check(upgradeForegroundGuide(mechanicalPrior).text, full)
 check(upgradeForegroundGuide(mechanicalPrior).changedRules, 1)
 const mechanicalCustom = '\uFEFF' + mechanicalPrior.replaceAll('\n', '\r\n') + '\r\nMy actual user instruction.\r\n'
 check(upgradeForegroundGuide(mechanicalCustom).text, '\uFEFF' + full.replaceAll('\n', '\r\n') + '\r\nMy actual user instruction.\r\n')
 check(upgradeForegroundGuide('My custom guide. ' + oldMechanical).text, 'My custom guide. ' + oldMechanical)
 check(upgradeForegroundGuide(full + '\n```text\n' + oldMechanical + '\n```\n').text, full + '\n```text\n' + oldMechanical + '\n```\n')
 const organizer=frameworkRolePrompt('Organizer'),planner=frameworkRolePrompt('Planner'),recorder=frameworkRolePrompt('Recorder')
 check(organizer.includes('A child O completion notifies only its parent Organizer'),true)
 check(organizer.includes('its own Recorder proceeds independently'),false)
 check(planner.includes('A child P completes to its parent only, without Recorder or Cleaner'),true)
 check(recorder.includes('child'),true)
 const helper=frameworkRolePrompt('Helper')
 check(helper.includes('periodic checks of unconsumed Planner/member recovery markers in running P Tasks'),true)
 check(helper.includes('Organizer and Recorder Task-level markers do not use this member-check interval'),true)
 check(helper.includes('a still-running independent P child of an O keeps its own member check'),true)
 check(helper.includes('An already accepted Helper notification or claim remains your original responsibility even after its check clock ends'),true)
 check(helper.includes('Never invent a Planner for an O Task or delay Cleaner for marker consumption'),true)
 check(helper.includes('While a recovery marker remains under observation'),false)
 for (const guide of [full,core,frameworkRolePrompt('Worker'),recorder]) {
  check(guide.includes('Git read views remain fixed'),true)
  check(guide.includes('each read observes the current addressed file'),true)
 }
 const oldViews="Read views remain fixed at their opened revision across successful or failed writes, until explicit release or native turn end. Writes check current target state independently. Open another view only when newer content is needed, and promptly release views you no longer need."
 const newViews="Git read views remain fixed at their opened revision until release or native turn end. A physical Local view controls lifetime only: each read observes the current addressed file, without a cached snapshot or content/version lock. Writes operate on their actual targets independently. In Git, open another view when newer content is needed; promptly release views you no longer need in either mode."
 const oldArchive='The current read view is fixed; open a fresh view only if newer archival metadata is needed.'
 const newArchive='In Git, the current view is fixed; open a fresh view if newer archival metadata is needed. In physical Local, reread the exact archive path to observe its current file.'
 const legacyViews=full.replace(newViews,oldViews).replace(newArchive,oldArchive)
 check(upgradeForegroundGuide(legacyViews).text,full)
 check(upgradeForegroundGuide(legacyViews).changedRules,4)


 // The exact earlier default is migrated without replacing custom text.
 const oldCancellation = "Cancellation remains dss_task_cancel and its existing atomic Task-status/Recorder/Foreground/parent-notification transaction."
 const newCancellation = "Cancellation remains dss_task_cancel, using physical Local publication continuation or the existing Git atomic transaction for Task state and its addressed notifications."
 const oldCleanup = "Related business execution is stopped, Recorder preserves current progress, results and unresolved work as cancelled rather than successful completion, and Cleaner handles cleanup through the existing lifecycle."
 const newCleanup = "Cancellation initiates stopping related business execution. A cancelled total Task proceeds to Recorder and Cleaner; Recorder preserves current progress, results and unresolved work as cancelled rather than successful completion. A cancelled child Task notifies its linked parent only while that parent is still running, without starting its own Recorder or Cleaner; its temporary materials remain until the total Task is cleaned."
 const interimStopping = full.replace('Cancellation initiates stopping related business execution.', 'Related business execution is stopped.')
 check(upgradeForegroundGuide(interimStopping).text, full)
 check(upgradeForegroundGuide(interimStopping).changedRules, 1)
 check(full.includes('Related business execution is stopped.'), false)
 const cancellationPrior = full.replace(newCancellation, oldCancellation).replace(newCleanup, oldCleanup)
 check(upgradeForegroundGuide(cancellationPrior).text, full)
 check(upgradeForegroundGuide(cancellationPrior).changedRules, 2)
 check(upgradeForegroundGuide(full).changedRules, 0)
 check(full.includes('existing atomic Task-status/Recorder/Foreground/parent-notification transaction'), false)
 check(full.includes('A cancelled child Task notifies its linked parent only while that parent is still running, without starting its own Recorder or Cleaner'), true)
 check(full.includes('A cancelled total Task proceeds to Recorder and Cleaner'), true)
 check(readFileSync(new URL('../src/framework/role-tools.ts', import.meta.url),'utf8').includes('A child notifies its linked parent only while that parent is still running, and retains its runtime materials;'), true)
 const toolsSource=readFileSync(new URL('../src/framework/role-tools.ts', import.meta.url),'utf8')
 check(toolsSource.includes('This terminal cancellation initiates stopping related business work.'), true)
 check(toolsSource.includes('This terminal cancellation stops related business work.'), false)
 const customCancellation = cancellationPrior.replace('Cancellation remains', 'My custom cancellation rule remains')
 check(upgradeForegroundGuide(customCancellation).text.includes('My custom cancellation rule remains'), true)
 check(upgradeForegroundGuide('My cancellation policy. ' + oldCleanup).changedRules, 0)
 const cancellationCrLf = '\uFEFF' + cancellationPrior.replaceAll('\n', '\r\n') + '\r\nKeep my custom paragraph.\r\n'
 check(upgradeForegroundGuide(cancellationCrLf).text, '\uFEFF' + full.replaceAll('\n', '\r\n') + '\r\nKeep my custom paragraph.\r\n')

 const oldRestore='After the user explicitly chooses restoration, call dss_task_restore with the original taskId, actual retained recordPaths, the evidence-based route and owner, and continuation explaining their decision, known progress and missing information.'
 const currentRestore='After the user explicitly chooses restoration, check retained Task status: a known completed Task stays complete, and a later correction or new requirement uses a new Task ID referencing its results. Otherwise call dss_task_restore with the original taskId, actual retained recordPaths, the evidence-based route and owner, and continuation explaining their decision, known progress and missing information.'
 check(full.includes(currentRestore),true)
 const oldRestoreGuide=full.replace(currentRestore,oldRestore)
 check(oldRestoreGuide.includes(oldRestore),true)
 const restoredGuide=upgradeForegroundGuide(oldRestoreGuide)
 check(restoredGuide.text,full);check(restoredGuide.changedRules,1)
 check(upgradeForegroundGuide(restoredGuide.text).changedRules,0)
 const customizedRestore='\uFEFF'+oldRestoreGuide.replaceAll('\n','\r\n')+'\r\nKeep my custom restoration policy.\r\n'
 check(upgradeForegroundGuide(customizedRestore).text,'\uFEFF'+full.replaceAll('\n','\r\n')+'\r\nKeep my custom restoration policy.\r\n')
 const inlineRestore=oldRestoreGuide.replace(oldRestore,'My inline note stays. '+oldRestore)
 check(upgradeForegroundGuide(inlineRestore).text,full.replace(currentRestore,'My inline note stays. '+currentRestore))
 check(upgradeForegroundGuide('My own full guide. '+oldRestore).text,'My own full guide. '+oldRestore)
 const fencedRestore=full+'\n```text\n'+oldRestore+'\n```\n'
 check(upgradeForegroundGuide(fencedRestore).text,fencedRestore)

 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual generated core/full role text and exact-template migration; no model behavior simulation or Host send gate added.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{hooks.deregister()}
