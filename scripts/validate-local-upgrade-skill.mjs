import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Real production conversation methods and Linux physical files. Markdown's
// parser, native DSH imports and unrelated role tools are explicit controlled
// ports. These checks do not claim native UI/Windows/typecheck acceptance.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const actualSdk = process.env.DSS_SKILL_ACTUAL_SDK === '1'
const sdk = actualSdk ? await import('./test-support/dsh-sdk-runtime.mjs') : undefined
const hooks = actualSdk ? undefined : registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'koffi') return {url:new URL('./helpers/fixture-no-replace-koffi.mjs',import.meta.url).href,shortCircuit:true}
    if (specifier === '@deepseek-ai/dsh-scope') return {url:data('export const scopeOf=scope=>scope.agent'),shortCircuit:true}
    if (specifier === '@deepseek-ai/dsh-skill') return {url:data('export const isSkillName=name=>typeof name==="string" && /^[a-z0-9][a-z0-9-]*$/.test(name)'),shortCircuit:true}
    if (specifier === 'yaml') return {url:data('export const parse=JSON.parse'),shortCircuit:true}
    if (specifier === 'zod') return {url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true}
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){const children=[];for(const m of text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g))children.push({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}});return {type:'root',children}}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/role-tools.ts',root).href) return {url:data(`export function workerPaths(){throw new Error('Worker paths are outside this controlled conversation check')}`),shortCircuit:true}
      if (existsSync(fileURLToPath(url))) return {url:url.href,shortCircuit:true}
    }
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url.startsWith(root.href)&&url.endsWith('.ts')) {
      const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(root.href.length),createHash('sha256').update(source).digest('hex'))
      return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
    }
    return next(url,context)
  },
})
const { readLegacySkillSource } = await import('../src/framework/legacy-skill-source.ts')
const { publishLegacyNativeSkill } = await import('../src/framework/local-upgrade-skill.ts')
const { materializeLegacyLocalFiles } = await import('../src/framework/local-startup-upgrade.ts')
const assessLocalUpgradeCompletion = actualSdk ? undefined : (await import('../src/framework/local-upgrade-completion.ts')).assessLocalUpgradeCompletion
const { readFrameworkSkillCatalog } = await import('../src/framework/skills.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-upgrade-skill-')),names=[]
const check=(n,a,b)=>{assert.deepEqual(a,b,n);names.push(n)},hash=s=>createHash('sha256').update(s).digest('hex'),json=v=>JSON.stringify(v,null,2)+'\n'
class Records {data=new Map();async get(k){return structuredClone(this.data.get(k))}async set(k,v){this.data.set(k,structuredClone(v))}async list(){throw Error('No global host scan')}}
const definition='---\n'+JSON.stringify({name:'custom-old',description:'Original custom skill','user-invocable':true})+'\n---\nPreserve original custom instructions.\n'
async function fixture(name,restriction,active=true){
 const directory=path.join(scratch,name);await fs.mkdir(directory,{recursive:true});const database=path.join(directory,'dss-files.sqlite'),db=new DatabaseSync(database)
 db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT')
 const put=(p,v)=>{const b=Buffer.isBuffer(v)?v:Buffer.from(typeof v==='string'?v:json(v));db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,'','fixture',b.length,b)}
 const original={schemaVersion:1,kind:'skill',skillId:'old',scope:{assistantId:'actual',workspaceId:'actual'},activeVersion:2,versions:[{version:1,status:'archived',body:'Original older version'},{version:2,status:active?'active':'retired',title:'Original',description:'Original custom skill',applicability:'Original scope',body:'Preserve original custom instructions.'}]}
 put('skills/custom/record.json',original);put('skills/custom/resources/original.bin',Buffer.from([0,255,0]));put('skills/custom/resources/empty.bin',Buffer.alloc(0))
 if(restriction)put('technical/skills/controls.json',{version:1,entries:{'skills/custom/record.json':{status:restriction,reason:'user choice'}}})
 db.close();return {directory,database,original,records:records()}
}
const nativeStorage = actualSdk ? await (await import('./test-support/dsh-sdk-storage.mjs')).openDshStorageFixture(path.join(scratch,'storage'),path.join(scratch,'locator')) : undefined
const records = () => nativeStorage?.adapter ?? new Records()
try{
 // Current v848 conversion shares native definitions within this Files root.
 // Old identities remain exact historical data, and inactive states stay inactive.
 for (const status of ['active','disabled','retired','candidate']) {
   const f=await fixture('scope-'+status), record=structuredClone(f.original)
   record.versions=[{...record.versions[1],status}]
   if(status!=='active')delete record.activeVersion
   const db=new DatabaseSync(f.database), bytes=Buffer.from(json(record));db.prepare('UPDATE files SET binary=?,bytes=? WHERE path=?').run(bytes,bytes.length,'skills/custom/record.json');db.close()
   const before=hash(await fs.readFile(f.database)), parsed=readLegacySkillSource('skills/custom/record.json',json(record))
   check(status+' source active only with actual active pointer',parsed.active,status==='active')
   check(status+' source status is not rewritten by recognizer',parsed.value,record)
   check(status+' source inactive restriction retained',parsed.restriction?.status,status==='active'?undefined:status==='retired'?'retired':'disabled')
   const result=await publishLegacyNativeSkill(f.directory,'skills/custom/record.json',definition,f.records)
   check(status+' recognized source converts in place',result.status,'complete')
   check(status+' completed source has no invented owner gate',result.issues,[])
   check(status+' native body is exact supplied proposal',await fs.readFile(path.join(f.directory,'skills/custom/SKILL.md'),'utf8'),definition)
   check(status+' complete raw history retained byte exact',await fs.readFile(path.join(f.directory,'skills/custom/resources/original-record.json')),bytes)
   const states=JSON.parse(await fs.readFile(path.join(f.directory,'technical/skills/controls.json'),'utf8').catch(()=>'{"entries":{}}'))
   check(status+' native control preserves unavailable state',states.entries['skills/custom/SKILL.md']?.status,status==='active'?undefined:status==='retired'?'retired':'disabled')
   check(status+' original SQL exact bytes remain',hash(await fs.readFile(f.database)),before)
   check(status+' retry completes same exact publication',(await publishLegacyNativeSkill(f.directory,'skills/custom/record.json',definition,f.records)).status,'complete')

 }
 const sameNative=await fixture('same-native-not-ownership-proof','disabled')
 await fs.mkdir(path.join(sameNative.directory,'skills/custom'),{recursive:true});await fs.writeFile(path.join(sameNative.directory,'skills/custom/SKILL.md'),definition)
 await fs.mkdir(path.join(sameNative.directory,'technical/skills'),{recursive:true})
 const actualControls=json({version:1,entries:{'skills/custom/SKILL.md':{status:'retired',reason:'Actual target choice'}}})
 await fs.writeFile(path.join(sameNative.directory,'technical/skills/controls.json'),actualControls)
 check('Existing native text can complete with old history preserved',(await publishLegacyNativeSkill(sameNative.directory,'skills/custom/record.json',definition,sameNative.records)).status,'complete')
 check('Pre-existing native text unchanged',await fs.readFile(path.join(sameNative.directory,'skills/custom/SKILL.md'),'utf8'),definition)
 check('Pre-existing native control unchanged',JSON.parse(await fs.readFile(path.join(sameNative.directory,'technical/skills/controls.json'),'utf8')).entries['skills/custom/SKILL.md'],JSON.parse(actualControls).entries['skills/custom/SKILL.md'])
 // Execute the actual frozen shipped producer and old edit/status methods.
 // No test-owned replacement maps old skill input into the emitted layout.
 const bundled=readFileSync(new URL('./test-support/historical-55fe/installed-host.js',import.meta.url),'utf8')
 check('Historical 55fe shipped producer identity',hash(bundled),'5a84b25b7619486ea98e7e11b140d02c0a3848e48008ac3cc2dc71a2a5a5d47a')
 const producerSource=bundled.slice(bundled.indexOf('async function prepareLegacyMigration('),bundled.indexOf('async function applyLegacyMigration('))
 const outside=()=>{throw Error('Task mapping is outside this exact skill fixture')}
 const producer=new Function('identity','hash12','legacyDeclaredArtifacts','legacyMigratedTaskId','encodeJson','utf8','decode','paths','workerPaths','prepareFrameworkSkillIndex','frameworkSkillIndexPath',producerSource+'\nreturn prepareLegacyMigration')(
   value=>value,hash,outside,outside,json,value=>Buffer.from(value),value=>Buffer.from(value).toString(),{},outside,async()=>({changes:[],issues:[]}), 'technical/skills/catalog.json')
 const knowledgeSource=bundled.slice(bundled.indexOf('var candidateIndex = "technical/skills/candidates.json";'),bundled.indexOf('// src/framework/task-index.ts'))
 const OldKnowledge=new Function('createHash20','filePath','withSnapshot','frameworkSkillControlsPath','frameworkSkillIndexPath','prepareFrameworkSkillIndex',knowledgeSource+'\nreturn FrameworkKnowledge')(
   createHash,value=>value,(files,work)=>work({revision:'historical'}),'technical/skills/controls.json','technical/skills/catalog.json',async()=>({changes:[],issues:[]}))
 const actualScope={assistantId:'historical-assistant',workspaceId:'historical-workspace'}, date='2026-11-09T00:00:00Z'
 const actualVersion={skillId:'actual-method',version:1,title:'Actual original title',description:'Actual method description',applicability:'Actual applicability',body:'Original validated instructions.\r\nKeep these bytes.',contentHash:'original-hash',scope:actualScope,status:'active',createdAt:date,sourceResultIds:['actual-result'],validations:[{validationId:'v',resultId:'actual-result',contentHash:'original-hash',explanation:'Recorded original validation',artifactRefs:['actual-artifact'],validatedAt:date}],uses:[],feedback:[]}
 const actualRecord={schemaVersion:1,kind:'skill',skillId:'actual-method',scope:actualScope,revision:1,activeVersion:1,versions:[actualVersion],receipts:{}}
 const oldMap=new Map(), oldFiles={read:async(_s,p)=>oldMap.get(p)?.toString(),readBytes:async(_s,p)=>oldMap.get(p),list:async()=>[],listDirectory:async()=>[]}
 const produced=await producer({mode:'local',revision:'actual-fixture',baseline:'actual-shipped-producer',records:[{key:'knowledge/skills/original-method',bytes:Buffer.from(json(actualRecord))}],texts:[],tasks:[],issues:[]},oldFiles,{revision:'fixture'},{id:'actual-import',owner:'A',members:{}})
 for(const row of produced.changes)oldMap.set(row.path,Buffer.from(row.bytes??row.content))
 const actualPath=produced.changes.find(row=>row.path.endsWith('/record.json')).path, actualTarget=actualPath.replace(/record.json$/,'SKILL.md'), actualFolder=actualPath.slice(0,-'record.json'.length)
 check('Shipped producer creates body-only same-folder target',oldMap.get(actualTarget).toString().startsWith('# Actual original title'),true)
 const oldTransactions={run:async(_id,_request,_options,build)=>{const changes=await build({revision:'historical'});for(const row of changes)oldMap.set(row.path,Buffer.from(row.bytes??row.content));return{revision:'historical',replay:false}}}
 const oldKnowledge=new OldKnowledge(oldFiles,oldTransactions)
 await oldKnowledge.setStatus('actual-disable',{path:actualPath,expectedRevision:'historical',status:'disabled',reason:'Actual original user choice',updatedAt:date})
 check('Shipped old status deletes active pointer',JSON.parse(oldMap.get(actualPath)).activeVersion,undefined)
 await oldKnowledge.edit('actual-candidate-after-disable',{path:actualPath,expectedRevision:'historical',body:'A real later candidate, not active.',title:'Later draft title',description:'Later draft description',applicability:'Later draft scope',createdAt:date})
 check('Shipped old editor retains disabled body plus later candidate',JSON.parse(oldMap.get(actualPath)).versions.map(version=>version.status),['disabled','candidate'])
 async function fromRows(name,rows){const directory=path.join(scratch,name);await fs.mkdir(directory,{recursive:true});const database=path.join(directory,'dss-files.sqlite'),db=new DatabaseSync(database);db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT');for(const[p,b]of rows)db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,'','actual-old-producer',b.length,b);db.close();return{directory,database,records:records()}}

 const actual=await fromRows('actual-shipped-source',oldMap),actualNative='---\n'+JSON.stringify({name:'actual-method',description:'Actual method description'})+'\n---\nActual original title\nActual applicability\nOriginal validated instructions.\r\nKeep these bytes.\n'
 await fs.mkdir(path.join(actual.directory,actualFolder),{recursive:true});await fs.writeFile(path.join(actual.directory,actualTarget),oldMap.get(actualTarget));await fs.writeFile(path.join(actual.directory,actualPath),oldMap.get(actualPath))
 const actualSqlBefore=hash(await fs.readFile(actual.database)),actualBytes=oldMap.get(actualPath)
 const recognized=readLegacySkillSource(actualPath,actualBytes.toString())
 check('Actual shipped lifecycle retains disabled method despite absent pointer',recognized.restriction.status,'disabled')
 check('Actual shipped lifecycle does not select final candidate as active',recognized.active,false)
 check('Actual shipped old render is recognized as source not new conflict',recognized.renderings.includes(oldMap.get(actualTarget).toString()),true)
 check('Actual shipped lifecycle keeps full original candidate/history',recognized.value,JSON.parse(actualBytes))
 check('Actual shipped input converts with current sharing target',(await publishLegacyNativeSkill(actual.directory,actualPath,actualNative,actual.records)).status,'complete')
 check('Original current JSON moves only after complete source preservation',existsSync(path.join(actual.directory,actualPath)),false)
 check('Original full history retained byte exact',await fs.readFile(path.join(actual.directory,actualFolder+'resources/original-record.json')),actualBytes)
 check('Actual old rendering replaced by complete same-directory native text',await fs.readFile(path.join(actual.directory,actualTarget),'utf8'),actualNative)
 check('Actual disabled reason and time mapped to native controls',JSON.parse(await fs.readFile(path.join(actual.directory,'technical/skills/controls.json'),'utf8')).entries[actualTarget],JSON.parse(oldMap.get('technical/skills/controls.json')).entries[actualPath])
 check('Actual shipped original SQL remains byte exact',hash(await fs.readFile(actual.database)),actualSqlBefore)
 const paired=await fromRows('actual-companion-selected',oldMap)
 check('Selecting companion carries the same inactive original state',(await publishLegacyNativeSkill(paired.directory,actualTarget,actualNative,paired.records)).status,'complete')
 check('Companion selection keeps old disabled state',JSON.parse(await fs.readFile(path.join(paired.directory,'technical/skills/controls.json'),'utf8')).entries[actualTarget].status,'disabled')
 // A genuinely newer physical record is a separate input to the same once tool.
 const newer=await fromRows('actual-current-newer',oldMap)
 await oldKnowledge.edit('actual-later-physical-candidate',{path:actualPath,expectedRevision:'historical',body:'Later physical candidate absent from migration backup.',createdAt:'2026-11-09T01:00:00Z'})
 const latestBytes=oldMap.get(actualPath);await fs.mkdir(path.join(newer.directory,actualFolder),{recursive:true});await fs.writeFile(path.join(newer.directory,actualPath),latestBytes)
 check('Newer actual physical source must first be read',(await publishLegacyNativeSkill(newer.directory,actualPath,actualNative,newer.records)).issues.some(i=>i.message.includes('Read this exact current source')),true)
 check('Unread newer source is not copied into history',existsSync(path.join(newer.directory,actualFolder+'resources/original-record.json')),false)
 check('Read actual current source permits its same-root conversion',(await publishLegacyNativeSkill(newer.directory,actualPath,actualNative,newer.records,{readSources:new Map([[actualPath,latestBytes]])})).status,'complete')
 check('Actual later physical candidate is retained exact',await fs.readFile(path.join(newer.directory,actualFolder+'resources/original-record.json')),latestBytes)
 check('Distinct older SQL history is retained exact',await fs.readFile(path.join(newer.directory,actualFolder+'resources/original-sql-record.json')),actualBytes)
 check('Newer source live JSON retired after preservation',existsSync(path.join(newer.directory,actualPath)),false)
 const gitMap=new Map(),gitFiles={...oldFiles,read:async(_s,p)=>gitMap.get(p)?.toString(),readBytes:async(_s,p)=>gitMap.get(p)}
 const gitProvenance={originalTitle:'Actual participant source',privateScope:'kept-as-source'}
 const gitProduced=await producer({mode:'git',revision:'actual-git-fixture',baseline:'actual-shipped-producer',records:[{key:'knowledge/participant-A/skill/item/source.json',bytes:Buffer.from(json(gitProvenance))}],texts:[{ref:'dss-coop/knowledge/participant-A/skill/item',text:'Actual Git skill body\nPreserve original participant.'}],tasks:[],issues:[]},gitFiles,{revision:'fixture'},{id:'actual-git-import',owner:'A',members:{}})
 for(const row of gitProduced.changes)gitMap.set(row.path,Buffer.from(row.bytes??row.content))
 const gp=[...gitMap.keys()].find(p=>p.endsWith('/legacy-git.json')),gv=JSON.parse(gitMap.get(gp)),gitInput=await fromRows('actual-git-original-in-local-sql',gitMap)
 const gn='---\n'+JSON.stringify({name:gv.name,description:gv.description})+'\n---\n'+gv.body

 const gitReport=await publishLegacyNativeSkill(gitInput.directory,gp,gn,gitInput.records)
 check('Actual Git producer data converts through Local adapter',gitReport.status,'complete')
 check('Actual Git parser retains participant',readLegacySkillSource(gp,gitMap.get(gp).toString()).value.participantId,'participant-A')
 check('Actual Git parser retains full source metadata',readLegacySkillSource(gp,gitMap.get(gp).toString()).value.source,{path:'dss-coop/knowledge/participant-A/skill/item',metadata:gitProvenance})
 check('Actual Git source becomes same-directory native',await fs.readFile(path.join(gitInput.directory,gp.replace('legacy-git.json','SKILL.md')),'utf8'),gn)
 check('Actual Git source history remains byte exact',await fs.readFile(path.join(gitInput.directory,gp.replace('legacy-git.json','resources/original-legacy-git.json'))),gitMap.get(gp))
 const noBody=await fixture('no-complete-body'),noBodyDb=new DatabaseSync(noBody.database),noBodyRecord={...noBody.original,versions:[{version:1,status:'candidate',body:'Incomplete candidate'}]};delete noBodyRecord.activeVersion
 const noBodyBytes=Buffer.from(json(noBodyRecord));noBodyDb.prepare('UPDATE files SET binary=?,bytes=? WHERE path=?').run(noBodyBytes,noBodyBytes.length,'skills/custom/record.json');noBodyDb.close()
 check('No complete retained body reports that exact unresolved item',(await publishLegacyNativeSkill(noBody.directory,'skills/custom/record.json',definition,noBody.records)).issues.some(i=>i.message.includes('no retained complete method or candidate body')),true)
 // Independent native definitions have no old JSON recipient restriction.
 // Exercise the actual publication/recovery path without inventing approval.
 async function nativeFixture(name,original=definition,restriction){
   const f=await fixture(name),db=new DatabaseSync(f.database);db.prepare('DELETE FROM files WHERE path=?').run('skills/custom/record.json');db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run('skills/custom/SKILL.md','','native-original',Buffer.byteLength(original),Buffer.from(original));
   if(restriction){const text=json({version:1,entries:{'skills/custom/SKILL.md':{status:restriction,reason:'Native original choice'}}});db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run('technical/skills/controls.json','','native-controls',Buffer.byteLength(text),Buffer.from(text))}db.close();return f
 }
 const f=await nativeFixture('independent-native'),before=hash(await fs.readFile(f.database)),order=[]
 check('Independent native definition publishes',(await publishLegacyNativeSkill(f.directory,'skills/custom/SKILL.md',definition,f.records,{onProgress:p=>{if(p.step==='published')order.push(p.path)}})).status,'complete')
 check('Native full definition is an ordinary file',await fs.readFile(path.join(f.directory,'skills/custom/SKILL.md'),'utf8'),definition)
 check('Binary resources preserve every byte',[...await fs.readFile(path.join(f.directory,'skills/custom/resources/original.bin'))],[0,255,0])
 check('Empty original resource remains empty',(await fs.readFile(path.join(f.directory,'skills/custom/resources/empty.bin'))).length,0)
 check('Resources precede native definition',order.indexOf('skills/custom/resources/original.bin')<order.indexOf('skills/custom/SKILL.md'),true)
 const files=new PhysicalLocalFiles(f.directory);check('Actual catalog publishes only markdown entry',(await readFrameworkSkillCatalog(files)).find(e=>e.path==='skills/custom/SKILL.md').kind,'markdown');await files.close()
 check('Original native SQL remains byte exact',hash(await fs.readFile(f.database)),before)
 check('General export follows native conversion mapping',(await materializeLegacyLocalFiles(f.directory,f.records)).status,'complete')
 if(!actualSdk)check('Full finish recognizes actual native/resource conversion',(await assessLocalUpgradeCompletion(f.directory,f.records)).pending,[])
 await fs.writeFile(path.join(f.directory,'skills/custom/SKILL.md'),'later user edit')
 check('Completed one-time request does not replay over later edits',(await publishLegacyNativeSkill(f.directory,'skills/custom/SKILL.md',definition,f.records)).status,'complete')
 check('Later physical user edit remains',await fs.readFile(path.join(f.directory,'skills/custom/SKILL.md'),'utf8'),'later user edit')
 const disabled=await nativeFixture('native-disabled',definition,'disabled')
 await fs.mkdir(path.join(disabled.directory,'technical/skills'),{recursive:true});await fs.writeFile(path.join(disabled.directory,'technical/skills/controls.json'),json({version:1,entries:{'skills/other/SKILL.md':{status:'retired',reason:'Unrelated physical choice'}}}))
 check('Independent disabled native can convert',(await publishLegacyNativeSkill(disabled.directory,'skills/custom/SKILL.md',definition,disabled.records)).status,'complete')
 const controls=JSON.parse(await fs.readFile(path.join(disabled.directory,'technical/skills/controls.json'),'utf8'))
 check('SQL-only native restriction is not masked by other physical control',controls.entries['skills/custom/SKILL.md'].status,'disabled')
 check('Unrelated physical native restriction preserved',controls.entries['skills/other/SKILL.md'].reason,'Unrelated physical choice')
 const disabledFiles=new PhysicalLocalFiles(disabled.directory);check('Converted disabled native is not offered',(await readFrameworkSkillCatalog(disabledFiles)).length,0);await disabledFiles.close()
 const invalid=await nativeFixture('invalid-native')
 check('Invalid proposal cannot be marked complete',(await publishLegacyNativeSkill(invalid.directory,'skills/custom/SKILL.md','# no native frontmatter',invalid.records)).status,'incomplete')
 check('Invalid proposal publishes no native file',existsSync(path.join(invalid.directory,'skills/custom/SKILL.md')),false)
 check('Same once AI can correct invalid unpublished proposal',(await publishLegacyNativeSkill(invalid.directory,'skills/custom/SKILL.md',definition,invalid.records)).status,'complete')
 const custom=await nativeFixture('custom-native-target')
 await fs.mkdir(path.join(custom.directory,'skills/custom'),{recursive:true});await fs.writeFile(path.join(custom.directory,'skills/custom/SKILL.md'),'actual current user contribution')
 check('Current differing native target is retained pending',(await publishLegacyNativeSkill(custom.directory,'skills/custom/SKILL.md',definition,custom.records)).status,'incomplete')
 const observed=await fs.readFile(path.join(custom.directory,'skills/custom/SKILL.md')),merged=definition+'\nActual current user contribution included.\n'
 check('Exact current read permits merged native contribution',(await publishLegacyNativeSkill(custom.directory,'skills/custom/SKILL.md',merged,custom.records,{readSources:new Map([['skills/custom/SKILL.md',observed]])})).status,'complete')
 check('Actual current original retained resource exact',await fs.readFile(path.join(custom.directory,'skills/custom/resources/original-current-SKILL.md')),observed)
 check('Distinct original SQL native retained exact',await fs.readFile(path.join(custom.directory,'skills/custom/resources/original-SKILL.md'),'utf8'),definition)
 check('Complete merged native content used',await fs.readFile(path.join(custom.directory,'skills/custom/SKILL.md'),'utf8'),merged)
 const collision=await nativeFixture('history-resource-collision','# actual old custom instructions'),userResource=Buffer.from('A user-owned resource, not this source.')
 await fs.mkdir(path.join(collision.directory,'skills/custom/resources'),{recursive:true});await fs.writeFile(path.join(collision.directory,'skills/custom/resources/original-SKILL.md'),userResource)
 check('Different existing resource never overwritten',(await publishLegacyNativeSkill(collision.directory,'skills/custom/SKILL.md',definition,collision.records)).status,'complete')
 check('User resource bytes unchanged',await fs.readFile(path.join(collision.directory,'skills/custom/resources/original-SKILL.md')),userResource)
 check('Distinct actual original retained under ordinary content filename',await fs.readFile(path.join(collision.directory,'skills/custom/resources/original-SKILL-'+hash('# actual old custom instructions')+'.md'),'utf8'),'# actual old custom instructions')
 const nativeCandidates=await nativeFixture('native-candidate-originals'),candidateDb=new DatabaseSync(nativeCandidates.database)
 const originalCandidateIndex=json({version:1,entries:[{sourcePath:'skills/custom/SKILL.md',path:'skills/custom/candidates/user.md',hash:'original-candidate-hash',createdAt:'2026-11-08T00:00:00Z'}]}),originalCandidate='Actual original candidate body.\n'
 for(const[p,text]of[['technical/skills/candidates.json',originalCandidateIndex],['skills/custom/candidates/user.md',originalCandidate]])candidateDb.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,'','native-candidate',Buffer.byteLength(text),Buffer.from(text));candidateDb.close()
 check('Native candidate files do not become old JSON conversion work',(await publishLegacyNativeSkill(nativeCandidates.directory,'skills/custom/SKILL.md',definition,nativeCandidates.records)).status,'complete')
 check('Actual native candidate body stays exact',await fs.readFile(path.join(nativeCandidates.directory,'skills/custom/candidates/user.md'),'utf8'),originalCandidate)
 check('Ordinary export finishes native candidate metadata',(await materializeLegacyLocalFiles(nativeCandidates.directory,nativeCandidates.records)).status,'complete')
 check('Native candidate index original bytes not hidden behind a false converted mapping',await fs.readFile(path.join(nativeCandidates.directory,'technical/skills/candidates.json'),'utf8'),originalCandidateIndex)
 const cold=await nativeFixture('cold-native-publication');let stop=true
 await assert.rejects(publishLegacyNativeSkill(cold.directory,'skills/custom/SKILL.md',definition,cold.records,{onProgress:p=>{if(p.path==='skills/custom/SKILL.md'&&p.step==='published'&&stop){stop=false;throw Error('native published interruption')}}}),/native published interruption/);names.push('Actual native publication interruption retains same responsibility')
 const coldRecords=actualSdk?cold.records:new Records();if(!actualSdk)coldRecords.data=structuredClone(cold.records.data)
 check('Cold native retry completes original publication',(await publishLegacyNativeSkill(cold.directory,'skills/custom/SKILL.md',definition,coldRecords)).status,'complete')
 const nested=await nativeFixture('native-parent-restricted-child'),nestedDb=new DatabaseSync(nested.database),childRecord=json({...nested.original,skillId:'child'})
 for(const[p,text]of[['skills/custom/child/record.json',childRecord],['skills/custom/child/SKILL.md','# actual child old rendering']])nestedDb.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,'','actual-child',Buffer.byteLength(text),Buffer.from(text));nestedDb.close()
 check('Independent native parent converts without waiting for restricted child',(await publishLegacyNativeSkill(nested.directory,'skills/custom/SKILL.md',definition,nested.records)).status,'complete')
 check('Native parent never copies restricted child JSON',existsSync(path.join(nested.directory,'skills/custom/child/record.json')),false)
 check('Native parent never publishes old child rendering as native',existsSync(path.join(nested.directory,'skills/custom/child/SKILL.md')),false)
 const companion=await nativeFixture('physical-only-legacy-companion')
 await fs.mkdir(path.join(companion.directory,'skills/custom'),{recursive:true});await fs.writeFile(path.join(companion.directory,'skills/custom/record.json'),json(companion.original))
 check('Actual physical-only old companion requires its exact current read',(await publishLegacyNativeSkill(companion.directory,'skills/custom/SKILL.md',definition,companion.records)).status,'incomplete')
 check('Physical-only old companion exact bytes preserved',JSON.parse(await fs.readFile(path.join(companion.directory,'skills/custom/record.json'),'utf8')),companion.original)

 // Existing candidate files/metadata and controls are actual global source inputs.
 const extra=await fromRows('actual-candidate-controls',new Map([[actualPath,actualBytes]])), extraDb=new DatabaseSync(extra.database)
 const sourceControl={status:'disabled',reason:'Original user decision',updatedAt:date},otherControl={status:'retired',reason:'Other SQL-only decision',updatedAt:date}
 const otherPath='skills/other/SKILL.md',candidatePath=actualFolder+'candidates/real-original.md'
 const extraControls=json({version:1,entries:{[actualPath]:sourceControl,[otherPath]:otherControl}})
 const extraCandidates=json({version:1,entries:[{sourcePath:actualPath,path:candidatePath,hash:'old-real-hash',createdAt:date},{sourcePath:otherPath,path:'skills/other/candidates/original.md',hash:'other-real-hash',createdAt:date}]})
 for(const[p,b]of[[candidatePath,'Exact standalone candidate\r\n'],['technical/skills/controls.json',extraControls],['technical/skills/candidates.json',extraCandidates]])extraDb.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,'','actual-index-fixture',Buffer.byteLength(b),Buffer.from(b));extraDb.close()
 await fs.mkdir(path.join(extra.directory,'technical/skills'),{recursive:true});await fs.writeFile(path.join(extra.directory,'technical/skills/controls.json'),json({version:1,entries:{'skills/current/SKILL.md':{status:'disabled',reason:'Current independent decision'}}}))
 let controlObserved=false
 const extraResult=await publishLegacyNativeSkill(extra.directory,actualPath,actualNative,extra.records,{onProgress:async p=>{if(p.path===actualTarget&&p.step==='prepared'){
   const value=JSON.parse(await fs.readFile(path.join(extra.directory,'technical/skills/controls.json'),'utf8'))
   check('Old disabled choice is saved before native definition begins publication',value.entries[actualTarget],sourceControl);controlObserved=true
 }}})
 check('Candidate and control conversion completes',extraResult.status,'complete');check('Publication-order observation executed',controlObserved,true)
 check('Unrelated SQL-only control is not lost when whole index is mapped',JSON.parse(await fs.readFile(path.join(extra.directory,'technical/skills/controls.json'),'utf8')).entries[otherPath],otherControl)
 check('Original standalone candidate bytes retained',await fs.readFile(path.join(extra.directory,candidatePath),'utf8'),'Exact standalone candidate\r\n')
 const extraIndex=JSON.parse(await fs.readFile(path.join(extra.directory,'technical/skills/candidates.json'),'utf8'))
 check('Original candidate reference now points to native definition',extraIndex.entries.find(row=>row.path===candidatePath),{sourcePath:actualTarget,path:candidatePath,hash:'old-real-hash',createdAt:date})
 check('Unrelated candidate metadata remains',extraIndex.entries.find(row=>row.sourcePath===otherPath),JSON.parse(extraCandidates).entries[1])
 check('Original candidate control metadata resource is byte exact',await fs.readFile(path.join(extra.directory,actualFolder+'resources/original-controls.json'),'utf8'),extraControls)
 check('Original candidate index metadata resource is byte exact',await fs.readFile(path.join(extra.directory,actualFolder+'resources/original-candidates.json'),'utf8'),extraCandidates)

 // A present disabled target cannot silently weaken an independently retired source.
 // Produce the retired source with the shipped status method, not a made-up schema.
 await oldKnowledge.setStatus('actual-retire-before-conversion',{path:actualPath,expectedRevision:'historical',status:'retired',reason:'Actual retired source decision',updatedAt:'2026-11-09T02:00:00Z'})
 const retiredBytes=oldMap.get(actualPath),retiredControls=oldMap.get('technical/skills/controls.json')
 const retiredControl=JSON.parse(retiredControls).entries[actualPath]
 check('Actual shipped retire operation supplies source restriction',retiredControl.status,'retired')
 const conflicting=await fromRows('actual-retired-source-disabled-target',new Map([[actualPath,retiredBytes],['technical/skills/controls.json',retiredControls]]))
 const targetControl={status:'disabled',reason:'Distinct existing native target choice',updatedAt:'2026-11-09T01:00:00Z'}
 const targetControls=json({version:1,entries:{[actualTarget]:targetControl}})
 await fs.mkdir(path.join(conflicting.directory,actualFolder),{recursive:true});await fs.writeFile(path.join(conflicting.directory,actualPath),retiredBytes);await fs.writeFile(path.join(conflicting.directory,actualTarget),actualNative)
 await fs.mkdir(path.join(conflicting.directory,'technical/skills'),{recursive:true});await fs.writeFile(path.join(conflicting.directory,'technical/skills/controls.json'),targetControls)
 const conflictSqlHash=hash(await fs.readFile(conflicting.database))
 const conflictingResult=await publishLegacyNativeSkill(conflicting.directory,actualPath,actualNative,conflicting.records)
 check('Retired source versus disabled target stays this item pending',conflictingResult.status,'incomplete')
 check('State conflict reports the exact target',conflictingResult.issues.some(row=>row.code==='target-conflict'&&row.path===actualTarget&&row.message.includes('retired source')),true)
 check('State conflict keeps current target controls byte exact',await fs.readFile(path.join(conflicting.directory,'technical/skills/controls.json'),'utf8'),targetControls)
 check('State conflict keeps current source byte exact',await fs.readFile(path.join(conflicting.directory,actualPath)),retiredBytes)
 check('State conflict keeps target definition byte exact',await fs.readFile(path.join(conflicting.directory,actualTarget),'utf8'),actualNative)
 check('State conflict leaves original SQL byte exact',hash(await fs.readFile(conflicting.database)),conflictSqlHash)
 check('State conflict never marks source mapping complete',await conflicting.records.get((await import('../src/framework/local-upgrade-mapping.ts')).localSkillUpgradeKey(conflicting.directory,actualPath)).then(row=>row.status),'converting')

 // Recheck current controls at the locked update as well as initial inspection.
 const raced=await fromRows('retired-source-controls-race',new Map([[actualPath,retiredBytes],['technical/skills/controls.json',retiredControls]]))
 await fs.mkdir(path.join(raced.directory,actualFolder),{recursive:true});await fs.writeFile(path.join(raced.directory,actualPath),retiredBytes)
 let controlsRaceInjected=false
 const racedResult=await publishLegacyNativeSkill(raced.directory,actualPath,actualNative,raced.records,{onProgress:async progress=>{if(progress.path===actualFolder+'resources/original-record.json'&&progress.step==='published'&&!controlsRaceInjected){controlsRaceInjected=true;await fs.mkdir(path.join(raced.directory,'technical/skills'),{recursive:true});await fs.writeFile(path.join(raced.directory,'technical/skills/controls.json'),targetControls)}}})
 check('Controls race injection occurred',controlsRaceInjected,true)
 check('Current retired/disabled conflict also stays pending after history write',racedResult.status,'incomplete')
 check('Controls race preserves the new actual target choice',await fs.readFile(path.join(raced.directory,'technical/skills/controls.json'),'utf8'),targetControls)
 check('Controls race does not publish a new target',existsSync(path.join(raced.directory,actualTarget)),false)
 check('Controls race does not delete the old source',await fs.readFile(path.join(raced.directory,actualPath)),retiredBytes)
 check('Controls race retains exact historical source',await fs.readFile(path.join(raced.directory,actualFolder+'resources/original-record.json')),retiredBytes)

 // Optional historical metadata is not a new prerequisite for conversion.
 const sparsePath=actualFolder+'candidates/sparse.md',sparseBody='Actual candidate without redundant metadata.\r\n'
 for(const [label,metadata] of [['hash', {createdAt:date}],['createdAt',{hash:'actual-source-hash'}],['both',{}]]){
   const index=json({version:1,entries:[{sourcePath:actualPath,path:sparsePath,...metadata}]})
   const sparse=await fromRows('candidate-missing-'+label,new Map([[actualPath,actualBytes],[sparsePath,Buffer.from(sparseBody)],['technical/skills/candidates.json',Buffer.from(index)]]))
   check('Missing '+label+' metadata does not add an admission gate',(await publishLegacyNativeSkill(sparse.directory,actualPath,actualNative,sparse.records)).status,'complete')
   check('Missing '+label+' candidate body is byte exact',await fs.readFile(path.join(sparse.directory,sparsePath),'utf8'),sparseBody)
   check('Missing '+label+' candidate reference maps without invented metadata',JSON.parse(await fs.readFile(path.join(sparse.directory,'technical/skills/candidates.json'),'utf8')).entries,[{sourcePath:actualTarget,path:sparsePath,...metadata}])
   check('Missing '+label+' full original index remains exact resource',await fs.readFile(path.join(sparse.directory,actualFolder+'resources/original-candidates.json'),'utf8'),index)
 }

 // Interrupt after native publication; history and restrictions are already safe.
 const interrupted=await fromRows('actual-interrupted-after-native',new Map([[actualPath,actualBytes]]))
 await fs.mkdir(path.join(interrupted.directory,actualFolder),{recursive:true});await fs.writeFile(path.join(interrupted.directory,actualPath),latestBytes)
 let armed=true
 await assert.rejects(publishLegacyNativeSkill(interrupted.directory,actualPath,actualNative,interrupted.records,{readSources:new Map([[actualPath,latestBytes]]),onProgress:p=>{if(p.path===actualTarget&&p.step==='published'&&armed){armed=false;throw Error('injected after native')}}}),/injected after native/);names.push('Injected native publication interruption is visible')
 check('Interruption before source retirement leaves original live bytes',await fs.readFile(path.join(interrupted.directory,actualPath)),latestBytes)
 check('Retry continues same actual bytes',(await publishLegacyNativeSkill(interrupted.directory,actualPath,actualNative,interrupted.records,{readSources:new Map([[actualPath,latestBytes]])})).status,'complete')

 // Simulate process loss after removing the live JSON but before source mapping.
 const retired=await fromRows('actual-interrupted-after-retirement',new Map([[actualPath,actualBytes]]))
 await fs.mkdir(path.join(retired.directory,actualFolder),{recursive:true});await fs.writeFile(path.join(retired.directory,actualPath),latestBytes)
 let failMapping=true
 const interruptedStorage={get:k=>retired.records.get(k),set:async(k,v)=>{if(failMapping&&v.kind==='dss-once-source-mapping'){failMapping=false;throw Error('injected after JSON retirement')}return retired.records.set(k,v)}}
 await assert.rejects(publishLegacyNativeSkill(retired.directory,actualPath,actualNative,interruptedStorage,{readSources:new Map([[actualPath,latestBytes]])}),/injected after JSON retirement/);names.push('Injected post-retirement interruption is visible')
 check('Retired original is absent only after exact preserved source exists',existsSync(path.join(retired.directory,actualPath)),false)
 check('Exact current history survives post-retirement interruption',await fs.readFile(path.join(retired.directory,actualFolder+'resources/original-record.json')),latestBytes)
 check('Cold source selection resumes exact retained current bytes',(await publishLegacyNativeSkill(retired.directory,actualPath,actualNative,retired.records)).status,'complete')
 check('Cold retry does not replace newer candidate with older SQL',await fs.readFile(path.join(retired.directory,actualFolder+'resources/original-record.json')),latestBytes)

 const changed=await fromRows('actual-source-change-in-flight',new Map([[actualPath,actualBytes]]))
 await fs.mkdir(path.join(changed.directory,actualFolder),{recursive:true});await fs.writeFile(path.join(changed.directory,actualPath),actualBytes)
 const changeResult=await publishLegacyNativeSkill(changed.directory,actualPath,actualNative,changed.records,{onProgress:async p=>{if(p.path===actualTarget&&p.step==='published')await fs.writeFile(path.join(changed.directory,actualPath),latestBytes)}})
 check('Newer source arrival leaves exact item pending',changeResult.status,'incomplete')
 check('Concurrent new source is never deleted',await fs.readFile(path.join(changed.directory,actualPath)),latestBytes)
 check('Fresh read resolves the real new contribution',(await publishLegacyNativeSkill(changed.directory,actualPath,actualNative,changed.records,{readSources:new Map([[actualPath,latestBytes]])})).status,'complete')
 check('Both distinct actual histories survive source race',await fs.readFile(path.join(changed.directory,actualFolder+'resources/original-record-'+hash(latestBytes)+'.json')),latestBytes)

 const unknown=await fromRows('unknown-old-source',new Map([[actualPath,Buffer.from('{"not":"a skill"}')]]))
 const unknownResult=await publishLegacyNativeSkill(unknown.directory,actualPath,actualNative,unknown.records)
 check('Unknown old shape remains specific pending',unknownResult.status,'incomplete')
 check('Unknown old shape does not publish native',existsSync(path.join(unknown.directory,actualTarget)),false)
 const duplicate=await fromRows('duplicate-native-name',new Map([[actualPath,actualBytes]]))
 await fs.mkdir(path.join(duplicate.directory,'skills/existing'),{recursive:true});await fs.writeFile(path.join(duplicate.directory,'skills/existing/SKILL.md'),actualNative)
 check('Disabled old same-name method converts without an active-name conflict',(await publishLegacyNativeSkill(duplicate.directory,actualPath,actualNative,duplicate.records)).status,'complete')
 check('Disabled old same-name definition is preserved as native',existsSync(path.join(duplicate.directory,actualTarget)),true)
 const malformed=await fromRows('malformed-candidate-index',new Map([[actualPath,actualBytes],['technical/skills/candidates.json',Buffer.from('{bad')]]))
 const malformedResult=await publishLegacyNativeSkill(malformed.directory,actualPath,actualNative,malformed.records)
 check('Malformed candidate metadata is actionable pending',malformedResult.status,'incomplete')
 check('Malformed candidate metadata does not publish native',existsSync(path.join(malformed.directory,actualTarget)),false)

 const lost=await fromRows('retained-current-changed',new Map([[actualPath,actualBytes]]))
 await fs.mkdir(path.join(lost.directory,actualFolder),{recursive:true});await fs.writeFile(path.join(lost.directory,actualPath),latestBytes)
 const lostStorage={get:k=>lost.records.get(k),set:async(k,v)=>{if(v.kind==='dss-once-source-mapping')throw Error('injected before mapping');return lost.records.set(k,v)}}
 await assert.rejects(publishLegacyNativeSkill(lost.directory,actualPath,actualNative,lostStorage,{readSources:new Map([[actualPath,latestBytes]])}),/injected before mapping/);names.push('Interrupted source retirement retains a recoverable current selection')
 await fs.writeFile(path.join(lost.directory,actualFolder+'resources/original-record.json'),'User edited historical resource')
 check('Changed retained current source stays pending without SQL downgrade',(await publishLegacyNativeSkill(lost.directory,actualPath,actualNative,lost.records)).issues.some(row=>row.message.includes('exact retained current source')),true)
 check('Changed user history resource is not overwritten',await fs.readFile(path.join(lost.directory,actualFolder+'resources/original-record.json'),'utf8'),'User edited historical resource')
 check('Old SQL is not republished at deleted live source',existsSync(path.join(lost.directory,actualPath)),false)

 const unavailable=structuredClone(actualRecord);unavailable.versions[0].bodyRetiredAt=date
 const unavailableBytes=Buffer.from(json(unavailable)),unavailableFixture=await fromRows('actual-retired-body',new Map([[actualPath,unavailableBytes]]))
 check('An unavailable pointed body is not invented from its retired data',(await publishLegacyNativeSkill(unavailableFixture.directory,actualPath,actualNative,unavailableFixture.records)).issues.some(row=>row.message.includes('no retained complete method or candidate body')),true)
 check('Unavailable pointed body is not published',existsSync(path.join(unavailableFixture.directory,actualTarget)),false)

 // Actual registry scope semantics: two DSS providers share the same root;
 // a Host scope without the DSS provider does not receive these definitions.
 if(actualSdk){
   const {Context}=await import('@deepseek-ai/cordis'),{SkillRegistry}=await import('@deepseek-ai/dsh-skill'),{createScope}=await import('@deepseek-ai/dsh-scope')
   const {installFrameworkSkillProvider}=await import('../src/framework/skills.ts')
   const sharedRows=new Map(),sharedOldFiles={...oldFiles,read:async(_s,p)=>sharedRows.get(p)?.toString(),readBytes:async(_s,p)=>sharedRows.get(p)}
   const ownerRecord=structuredClone(actualRecord);ownerRecord.scope={assistantId:'second-owner',workspaceId:'another-workspace'};ownerRecord.versions[0].scope=ownerRecord.scope
   const producedShared=await producer({mode:'local',revision:'actual-two-owners',baseline:'actual-shipped-producer',records:[{key:'knowledge/skills/owner-A',bytes:Buffer.from(json(actualRecord))},{key:'knowledge/skills/owner-B',bytes:Buffer.from(json(ownerRecord))}],texts:[],tasks:[],issues:[]},sharedOldFiles,{revision:'fixture'},{id:'shared-import',owner:'A',members:{}})
   for(const row of producedShared.changes)sharedRows.set(row.path,Buffer.from(row.bytes??row.content))
   const shared=await fromRows('actual-sdk-shared-owners',sharedRows),originalPaths=[...sharedRows.keys()].filter(p=>p.endsWith('/record.json')).sort()
   check('Actual 55fe producer emitted distinct historical owner directories',originalPaths.length,2)
   for(const[p,i]of originalPaths.map((p,i)=>[p,i])){const text='---\n'+JSON.stringify({name:'shared-method-'+i,description:'Actual owner '+i})+'\n---\n'+actualVersion.body
     check('Owner '+i+' converts without new runtime identity gates',(await publishLegacyNativeSkill(shared.directory,p,text,shared.records)).status,'complete')
     check('Owner '+i+' original identity/versions preserved',await fs.readFile(path.join(shared.directory,p.replace('record.json','resources/original-record.json'))),sharedRows.get(p))}
   const ctx=new Context();new SkillRegistry(ctx);const keys=[{}, {}, {}],scopes=keys.map(key=>createScope(ctx,key)),sharedFiles=new PhysicalLocalFiles(shared.directory),providers=[],reads=[]
   const readBytes=sharedFiles.readBytes.bind(sharedFiles),read=sharedFiles.read.bind(sharedFiles)
   sharedFiles.readBytes=async(s,p)=>{reads.push(p);return readBytes(s,p)};sharedFiles.read=async(s,p)=>{reads.push(p);return read(s,p)}
   try{
     providers.push(...keys.slice(0,2).map((key,i)=>installFrameworkSkillProvider(scopes[i].ctx,key,sharedFiles)))
     for(let i=0;i<20&&providers.some(p=>!p.available());i++)await new Promise(r=>setImmediate(r))
     for(const[i,key]of keys.slice(0,2).entries()){
       check('Actual DSS scope '+i+' receives both shared methods',(await ctx.skills.list({scope:key})).map(v=>v.name).sort(),['shared-method-0','shared-method-1'])
       for(let j=0;j<2;j++)check('Actual DSS scope '+i+' loads shared method '+j,(await ctx.skills.get('shared-method-'+j,{scope:key})).content,actualVersion.body)
     }
     check('Unrelated actual native scope has no DSS skills',await ctx.skills.list({scope:keys[2]}),[])
     check('Host root has no accidental global DSS registration',await ctx.skills.list(),[])
     check('Ordinary list/get never read old JSON or historical identity',reads.some(p=>/record\.json|legacy-git\.json|resources\//.test(p)),false)
   }finally{for(const p of providers)await p.dispose();for(const scope of scopes)await scope.dispose();await sharedFiles.close()}
 }

 console.log(JSON.stringify({status:'passed',assertions:names.length,names,platform:process.platform,runtime:process.version,limits:actualSdk?'Actual pinned SDK registry/scopes/storage/YAML/Zod/Koffi and Linux physical files/SQLite. Historical 55fe producer and edit/status functions executed. Explicit proposals and failure injection, not model authored. No live DSH Agent/UI/Windows/remote Git.':'Production once conversion, historical 55fe producer/edit/status, physical Linux files/SQLite; controlled name/scope/YAML/Koffi ports. No native SDK/model/UI/Windows/remote Git.',...(sdk?sdk.evidence():{sourceHashes:Object.fromEntries([...loaded].sort())}),scriptHash:hash(readFileSync(fileURLToPath(import.meta.url)))},null,2))
}finally{hooks?.deregister();await nativeStorage?.close();await fs.rm(scratch,{recursive:true,force:true})}
