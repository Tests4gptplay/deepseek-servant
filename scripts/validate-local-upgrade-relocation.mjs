import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import {sourceRoot,loaded,hash,hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
// Markdown parsing was outside this test before the SDK refresh. Its missing
// optional parser must now fail if a scenario starts using it, never report an
// invented empty syntax tree. DSH/Zod/Koffi packages are all real imports.
const markdownBoundary=registerHooks({resolve(specifier,context,next){
 if(specifier==='mdast-util-from-markdown')return{url:'data:text/javascript,'+encodeURIComponent('export function fromMarkdown(){throw new Error("Markdown parsing is outside this relocation fixture; provide the actual parser before extending its coverage.")}'),shortCircuit:true}
 return next(specifier,context)
}})
const {copyRecordTree}=await import(new URL('framework/record-tree-copy.ts',sourceRoot))
const {FrameworkRecordMove,recordMoveKey}=await import(new URL('framework/record-move.ts',sourceRoot))
async function json(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;return fallback}}
async function saveJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(value));await fs.rename(file+'.tmp',file)}
const nativeFixtures=[]
async function adapter(base,initial){
 const fixture=await openDshStorageFixture(initial,path.join(base,'native-locator'))
 nativeFixtures.push(fixture)
 // Every main/restarted phase must address the known keys directly.
 fixture.adapter.list=async()=>{throw new Error('Global technical-record scans are forbidden in this test')}
 return fixture.adapter
}

const {prepareLocalUpgradeRelocation,projectLocalUpgradeRelocation,applyLocalUpgradeRelocation}=await import(new URL('framework/local-upgrade-relocation.ts',sourceRoot))
const {materializeLegacyLocalFiles,localStartupUpgradeKey}=await import(new URL('framework/local-startup-upgrade.ts',sourceRoot))
const {withLegacySqliteSnapshot}=await import(new URL('framework/legacy-sqlite-reader.ts',sourceRoot))
const {restoreLegacyTask,localTaskUpgradeKey,legacyTaskNeedsRestoration}=await import(new URL('framework/local-upgrade-task.ts',sourceRoot))
const {restoreLegacyConversationScope,localConversationUpgradeKey,legacyConversationNeedsRestoration}=await import(new URL('framework/local-upgrade-conversation.ts',sourceRoot))
const {localUpgradeMappingKey,localUpgradeResultKey,localSkillUpgradeKey}=await import(new URL('framework/local-upgrade-mapping.ts',sourceRoot))
const {readLocalUpgradeCompleted}=await import(new URL('framework/local-upgrade-completion.ts',sourceRoot))
const wakeKey=dir=>'framework-startup-upgrade-agent/'+hash(dir),signal=()=>new AbortController().signal
const put=async(root,file,body)=>{await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),body)}
const statIdentity=async file=>{const s=await fs.lstat(file,{bigint:true});return{dev:String(s.dev),ino:String(s.ino)}}
const host=JSON.stringify(['local','fixture-scope','fixture-instance'])
const task={version:1,taskId:'existing-task',route:'P',sourcePath:'existing-task_P.md',owner:'local-owner',status:'running',lifecycleId:'original-life',members:['local-owner']}
async function seedSql(directory,rows){await fs.mkdir(directory,{recursive:true});const db=new DatabaseSync(path.join(directory,'dss-files.sqlite'));db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT');for(const [p,v]of rows){const b=Buffer.isBuffer(v)?v:Buffer.from(typeof v==='string'?v:JSON.stringify(v));db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,'','fixture',b.length,b)}db.close()}
async function fixture(base,layout,scenario='pending'){
 const sourceRecords=path.join(base,'records'),targetRecords=path.join(base,'target'),sourceLocal=layout==='owned'?path.join(sourceRecords,'deepseek_servant','framework'):path.join(base,'custom-local'),store=await adapter(base,sourceRecords)
 if(scenario==='complete'){
  await seedSql(sourceLocal,[['archives/original.txt','original archive'],['archives/deleted.txt','original deletion']]);const report=await materializeLegacyLocalFiles(sourceLocal,store),operation=await store.get(localStartupUpgradeKey(sourceLocal))
  await put(sourceLocal,'archives/original.txt','later user edit');await fs.unlink(path.join(sourceLocal,'archives/deleted.txt'))
  await store.set(localUpgradeResultKey(sourceLocal),{kind:'dss-local-upgrade-result',directory:sourceLocal,operationId:'completed-owner',completedAt:'2026-11-09T00:00:00Z',report,cleanup:[{key:localStartupUpgradeKey(sourceLocal),kind:operation.kind,operationId:operation.operationId}],sourceDisposition:'retained-pending-retirement-review',sourceAudit:{sourcePath:path.join(sourceLocal,'dss-files.sqlite'),sourceDisposition:'retained-pending-retirement-review',onlyOriginalBytesInSql:[]}})
 }else if(scenario==='pending'){
  const paths=[['tasks/existing-task.json',task],[task.sourcePath,'original request'],['task-runs/existing-task/local-owner/notes.md','original note'],['state/local-owner/existing-task/Planner',''],['conversation-index/local/existing-chat/index.json',{version:1,messages:[],processGroups:[]}],['skills/pending/SKILL.md','# Existing native skill\n'],['archives/unconverted.txt','future source']]
  await seedSql(sourceLocal,paths);await restoreLegacyTask(sourceLocal,task.taskId,host,store);await restoreLegacyConversationScope(sourceLocal,'existing-chat',store)
  await put(sourceLocal,'task-runs/existing-task/local-owner/notes.md','later task user edit');await put(sourceLocal,'conversation-index/local/existing-chat/index.json','{"version":1,"messages":[],"processGroups":[],"user":"later edit"}')
  await materializeLegacyLocalFiles(sourceLocal,store,{deferActivation:true})
  await store.set(localSkillUpgradeKey(sourceLocal,'skills/pending/SKILL.md'),{kind:'dss-once-native-skill',directory:sourceLocal,operationId:'skill-owner',sourcePath:'skills/pending/SKILL.md',targetPath:'skills/pending/SKILL.md',sourceHash:hash('# Existing native skill\n'),proposalHash:hash('selected proposal'),status:'converting',files:[],issues:[]})
  await store.set(wakeKey(sourceLocal),{kind:'dss-once-local-upgrade',directory:sourceLocal,operationId:'agent-owner',sessionId:'existing-native-session',inputId:'existing-input',status:'pending'})
 }else{
  await seedSql(sourceLocal,[['archives/partial.txt',Buffer.alloc(180000,65)]])
  let stopped=false
  try{await materializeLegacyLocalFiles(sourceLocal,store,{onProgress:p=>{if(p.step===(scenario==='unknown'?'created':scenario==='partial'?'written':scenario==='ready'?'ready':'owned')){stopped=true;throw new Error('controlled upgrade stop')}}})}catch(e){if(!stopped)throw e}
  if(!stopped)throw new Error('Upgrade interruption did not occur')
 }
 const scope=JSON.stringify(['local',sourceLocal]),before={revision:'before',settings:{localDirectory:sourceLocal}};await store.set('framework-settings/local',before);await store.set('framework-connection-settings/'+hash(scope),{mode:'local',directory:sourceLocal,workerSeats:1,localBackend:'physical'})
 const request={sourceRecords,targetRecords,sourceLocal,scope,localBackend:'physical',settingsBefore:before,nextSettingsRevision:'after'};await saveJson(path.join(base,'request.json'),request)
 return{store,request,sourceLocal,sourceRecords,targetRecords}
}
const lifecycle=store=>({quiesce:async()=>{},applySettings:async r=>{await store.set('framework-settings/local',r.settingsAfter)},reopen:async()=>{}})
if(process.argv[2]==='--crash'){
 const base=process.argv[3],phase=process.argv[4],request=await json(path.join(base,'request.json')),store=await adapter(base,request.sourceRecords),set=store.set.bind(store)
 store.set=async(k,v)=>{await set(k,v);const r=k===recordMoveKey?v.receipts.find(x=>x.commandId==='upgrade-move'):undefined;if(phase==='projection'&&r?.upgradeRelocation?.projected)process.exit(91);if(phase==='row'&&k.startsWith('framework-physical-upgrade/')&&v.directory!==request.sourceLocal)process.exit(92);if(phase==='relocated'&&r?.upgradeRelocated&&r.phase==='published')process.exit(93)}
 await new FrameworkRecordMove(store,store,lifecycle(store)).run('upgrade-move',request,signal());throw new Error('Expected relocation interruption')
}
let assertions=0,processInterruptions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++},rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const base=await fs.mkdtemp(path.join(os.tmpdir(),'dss-upgrade-relocate-')),opened=[]
try{
 // Metadata-only paths use one consistent WAL snapshot and original validation.
 const metadata=path.join(base,'metadata');await seedSql(metadata,[['a.txt','before'],['large.bin',Buffer.alloc(3*1024*1024,9)]])
 const database=path.join(metadata,'dss-files.sqlite'),writer=new DatabaseSync(database);writer.exec('PRAGMA journal_mode=WAL')
 const originalPrepare=DatabaseSync.prototype.prepare,queries=[];DatabaseSync.prototype.prepare=function(sql){queries.push(sql);if(/AS text_bytes|AS content_type|\bbinary\s*,|typeof\(binary\)/i.test(sql))throw new Error('Body read forbidden in path inventory');return originalPrepare.call(this,sql)}
 let retained
 try{await withLegacySqliteSnapshot(database,async snapshot=>{retained=snapshot;writer.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run('later.txt','','later',5,Buffer.from('later'));const rows=[];for await(const entry of snapshot.paths())rows.push(entry.path);check(rows,['a.txt','large.bin'])});await rejects(async()=>retained.paths().next(),/callback has ended/)}finally{DatabaseSync.prototype.prepare=originalPrepare;writer.close()}
 check(queries.some(q=>q.includes('CAST(path AS BLOB)')&&q.includes('FROM files')),true)
 const invalid=new DatabaseSync(database);invalid.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run('../unsafe','','bad',0,Buffer.alloc(0));invalid.close();await withLegacySqliteSnapshot(database,async s=>{const paths=[];for await(const p of s.paths())paths.push(p);check(paths.find(p=>p.kind==='issue').issue.code,'invalid-path')})
 for(const layout of ['owned','custom']){
  const f=await fixture(path.join(base,'pending-'+layout),layout);opened.push(f.store)
  const beforeTask=await f.store.get(localTaskUpgradeKey(f.sourceLocal,task.taskId)),beforeConversation=await f.store.get(localConversationUpgradeKey(f.sourceLocal,'existing-chat')),beforeMechanical=await f.store.get(localStartupUpgradeKey(f.sourceLocal))
  check(beforeTask.status,'complete');check(beforeConversation.status,'complete');check(beforeMechanical.status,'publishing')
  const metadataPrepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){if(/AS text_bytes|AS content_type|\bbinary\s*,|typeof\(binary\)/i.test(sql))throw new Error('Pending relocation read a SQL body');return metadataPrepare.call(this,sql)}
  let prepared;try{prepared=await prepareLocalUpgradeRelocation(f.store,f.sourceLocal,path.join(base,'unselected-check'),signal())}finally{DatabaseSync.prototype.prepare=metadataPrepare}
  check(prepared.kind,'pending');check(prepared.rows.some(r=>r.sourceKey===localSkillUpgradeKey(f.sourceLocal,'skills/pending/SKILL.md')),true)
  const receipt=await new FrameworkRecordMove(f.store,f.store,lifecycle(f.store)).run('upgrade-move',f.request,signal()),target=receipt.targetLocal
  check(receipt.upgradeRelocated,true);check(receipt.upgradeRelocation,undefined);check((await f.store.get(localStartupUpgradeKey(target))).source,await statIdentity(path.join(target,'dss-files.sqlite')))
  check((await f.store.get(localTaskUpgradeKey(target,task.taskId))).operationId,beforeTask.operationId);check((await f.store.get(localConversationUpgradeKey(target,'existing-chat'))).operationId,beforeConversation.operationId)
  check((await f.store.get(wakeKey(target))).sessionId,'existing-native-session');check((await f.store.get(localSkillUpgradeKey(target,'skills/pending/SKILL.md'))).status,'converting')
  check((await f.store.get('framework-connection-settings/'+hash(f.request.scope))).localBackend,'physical')
  check(await legacyTaskNeedsRestoration(target,task.taskId,f.store),false);check(await legacyConversationNeedsRestoration(target,'existing-chat',f.store),false)
  await restoreLegacyTask(target,task.taskId,host,f.store);await restoreLegacyConversationScope(target,'existing-chat',f.store)
  check(await fs.readFile(path.join(target,'task-runs/existing-task/local-owner/notes.md'),'utf8'),'later task user edit');check(JSON.parse(await fs.readFile(path.join(target,'conversation-index/local/existing-chat/index.json'),'utf8')).user,'later edit')
  check((await f.store.get(localUpgradeMappingKey(target,'tasks/existing-task.json'))).directory,target);check((await f.store.get(localStartupUpgradeKey(f.sourceLocal))).source,beforeMechanical.source)
  check(existsSync(path.join(f.sourceLocal,'dss-files.sqlite')),false)
 }
 for(const layout of ['owned','custom']){
  const f=await fixture(path.join(base,'complete-'+layout),layout,'complete');opened.push(f.store)
  const savedPrepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(){throw new Error('Completed relocation must not open/query SQL')}
  try{const receipt=await new FrameworkRecordMove(f.store,f.store,lifecycle(f.store)).run('upgrade-move',f.request,signal()),target=receipt.targetLocal,result=await readLocalUpgradeCompleted(target,f.store)
   check(result.directory,target);check(result.report.sourcePath,path.join(target,'dss-files.sqlite'));check(result.cleanup[0].key,localStartupUpgradeKey(target));check((await materializeLegacyLocalFiles(target,f.store)).status,'complete')
   check(await legacyTaskNeedsRestoration(target,'nonexistent',f.store),false);check(await legacyConversationNeedsRestoration(target,'nonexistent',f.store),false)
   check(await fs.readFile(path.join(target,'archives/original.txt'),'utf8'),'later user edit');check(existsSync(path.join(target,'archives/deleted.txt')),false);check((await f.store.get(localUpgradeResultKey(f.sourceLocal))).directory,f.sourceLocal)
  }finally{DatabaseSync.prototype.prepare=savedPrepare}
 }
 // Mechanical complete alone is still pending, and keeps specialized ownership.
 const mechanical=await fixture(path.join(base,'mechanical-only'),'custom','complete');opened.push(mechanical.store);await mechanical.store.delete(localUpgradeResultKey(mechanical.sourceLocal));const only=await prepareLocalUpgradeRelocation(mechanical.store,mechanical.sourceLocal,path.join(base,'not-selected'));check(only.kind,'pending')
 // Confirmed stage ownership moves by real copy evidence; an unconfirmed stage
 // remains unowned and is preserved by the existing publisher on continuation.
 for(const scenario of ['stage','partial','ready','unknown']){
  const f=await fixture(path.join(base,scenario),'custom',scenario);opened.push(f.store);const old=await f.store.get(localStartupUpgradeKey(f.sourceLocal)),oldStage=old.files[0].stagePath
  const receipt=await new FrameworkRecordMove(f.store,f.store,lifecycle(f.store)).run('upgrade-move',f.request,signal()),target=receipt.targetLocal,moved=await f.store.get(localStartupUpgradeKey(target))
  if(scenario!=='unknown')check(moved.files[0].owned,await statIdentity(path.join(target,oldStage)));else check(moved.files[0].owned,undefined)
  check(moved.status,'publishing');check((await materializeLegacyLocalFiles(target,f.store)).status,'complete');check((await fs.stat(path.join(target,'archives/partial.txt'))).size,180000)
  check(existsSync(path.join(f.sourceLocal,oldStage)),false);if(scenario==='unknown')check(existsSync(path.join(target,oldStage)),true)
 }
 // Replaced old stage identity is not granted to its copied replacement.
 const replaced=await fixture(path.join(base,'replaced-stage'),'owned','stage');opened.push(replaced.store);const priorStage=await replaced.store.get(localStartupUpgradeKey(replaced.sourceLocal)),stagePath=priorStage.files[0].stagePath
 await fs.rename(path.join(replaced.sourceLocal,stagePath),path.join(replaced.sourceLocal,stagePath+'.retained'));await put(replaced.sourceLocal,stagePath,'user replacement stage')
 const movedStage=await new FrameworkRecordMove(replaced.store,replaced.store,lifecycle(replaced.store)).run('upgrade-move',replaced.request,signal()),stageState=await replaced.store.get(localStartupUpgradeKey(movedStage.targetLocal));check(stageState.files[0].owned,undefined);check(stageState.files[0].status,'prepared')
 check((await materializeLegacyLocalFiles(movedStage.targetLocal,replaced.store)).status,'complete');check(await fs.readFile(path.join(movedStage.targetLocal,stagePath),'utf8'),'user replacement stage')
 // A ready publication whose stage and final both disappeared cannot be
 // resurrected merely because this move created a new inode namespace.
 const lost=await fixture(path.join(base,'lost-ready'),'custom','ready');opened.push(lost.store);const lostState=await lost.store.get(localStartupUpgradeKey(lost.sourceLocal));check(lostState.files[0].ready,true);await fs.rename(path.join(lost.sourceLocal,lostState.files[0].stagePath),path.join(lost.sourceLocal,'retained-ready.bin'))
 const movedLost=await new FrameworkRecordMove(lost.store,lost.store,lifecycle(lost.store)).run('upgrade-move',lost.request,signal());check((await materializeLegacyLocalFiles(movedLost.targetLocal,lost.store)).status,'incomplete');check(existsSync(path.join(movedLost.targetLocal,'archives/partial.txt')),false)
 // Inode mismatch and unavailable pending source preserve the exact old duty.
 const mismatch=await fixture(path.join(base,'source-mismatch'),'custom','stage');opened.push(mismatch.store);const sourceBefore=await mismatch.store.get(localStartupUpgradeKey(mismatch.sourceLocal)),sqlPath=path.join(mismatch.sourceLocal,'dss-files.sqlite');await fs.rename(sqlPath,sqlPath+'.retained');await fs.copyFile(sqlPath+'.retained',sqlPath)
 await rejects(()=>prepareLocalUpgradeRelocation(mismatch.store,mismatch.sourceLocal,path.join(base,'mismatch-target')),/no longer matches/);check(await mismatch.store.get(localStartupUpgradeKey(mismatch.sourceLocal)),sourceBefore);check(existsSync(sqlPath+'.retained'),true)
 await fs.rename(sqlPath,sqlPath+'.replacement');await rejects(()=>prepareLocalUpgradeRelocation(mismatch.store,mismatch.sourceLocal,path.join(base,'missing-target')),/source is missing/);check(existsSync(path.join(base,'missing-target')),false)
 // A verified wake keeps its actual session and complete assessment, with
 // referenced keys relocated. This is cleanup continuation, not another Agent.
 const verified=await fixture(path.join(base,'verified-wake'),'owned','complete');opened.push(verified.store);const completed=await verified.store.get(localUpgradeResultKey(verified.sourceLocal));await verified.store.delete(localUpgradeResultKey(verified.sourceLocal));await verified.store.set(wakeKey(verified.sourceLocal),{kind:'dss-once-local-upgrade',directory:verified.sourceLocal,operationId:'verified-owner',sessionId:'verified-existing-session',status:'verified',result:completed.report,assessment:{report:completed.report,pending:[],cleanup:completed.cleanup},sourceAudit:completed.sourceAudit})
 const movedVerified=await new FrameworkRecordMove(verified.store,verified.store,lifecycle(verified.store)).run('upgrade-move',verified.request,signal()),verifiedWake=await verified.store.get(wakeKey(movedVerified.targetLocal));check(verifiedWake.status,'verified');check(verifiedWake.sessionId,'verified-existing-session');check(verifiedWake.result.directory,movedVerified.targetLocal);check(verifiedWake.assessment.cleanup[0].key,localStartupUpgradeKey(movedVerified.targetLocal))
 // Actual processes stop after frozen projection, a row write, and confirmation.
 for(const [phase,code]of [['projection',91],['row',92],['relocated',93]]){
  const b=path.join(base,'crash-'+phase),f=await fixture(b,phase==='row'?'owned':'custom','stage');await f.store.close()
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--crash',b,phase],{encoding:'utf8'});if(child.status!==code)throw new Error('Child '+phase+': '+child.stderr);check(child.status,code);processInterruptions++
  const store=await adapter(b,f.sourceRecords);opened.push(store);const receipt=await new FrameworkRecordMove(store,store,lifecycle(store)).resumePending(signal());check(receipt.phase,'applied');check(receipt.upgradeRelocated,true);check((await store.get(localStartupUpgradeKey(receipt.targetLocal))).source,await statIdentity(path.join(receipt.targetLocal,'dss-files.sqlite')))
  check((await materializeLegacyLocalFiles(receipt.targetLocal,store)).status,'complete')
 }
 // Conflict preflight never overwrites an unrelated target key or starts the AI.
 const conflict=await fixture(path.join(base,'conflict'),'custom','stage');opened.push(conflict.store);const plan=await prepareLocalUpgradeRelocation(conflict.store,conflict.sourceLocal,path.join(base,'conflict-copy'));let copy
 await copyRecordTree(plan.source,plan.destination,undefined,async s=>{copy=s});plan.projected=await projectLocalUpgradeRelocation(plan,copy)
 await conflict.store.set(plan.projected[0].key,{kind:'user-owned',body:'preserve'});await rejects(()=>applyLocalUpgradeRelocation(conflict.store,plan),/different state/);check(await conflict.store.get(plan.projected[0].key),{kind:'user-owned',body:'preserve'})
 const unowned=structuredClone(copy);delete unowned.owned['dss-files.sqlite'];await rejects(()=>projectLocalUpgradeRelocation(plan,unowned),/not the confirmed copied original/)
 console.log(JSON.stringify({status:'passed',assertions,processInterruptions,...evidence(),testBoundaries:['Non-SDK Markdown import throws if invoked; no successful fake parsing.', 'Exact-key store.list prohibition applies to main and restarted adapters.', 'Controlled SQLite query guards and three deliberate process exits.'],limits:'Real recovered SDK services, native JSON, Linux Koffi renameat2, SQLite and production relocation/coordinator/adapter/upgrade code. The non-SDK Markdown parser is an explicit fail-if-used import boundary and is not invoked. Windows/native DSH UI/model not run; no production/user data changed.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await Promise.allSettled(opened.map(s=>s.close()));await Promise.allSettled(nativeFixtures.map(f=>f.close()));markdownBoundary.deregister();hooks.deregister();await fs.rm(base,{recursive:true,force:true})}
