import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {stripTypeScriptTypes} from 'node:module'
import {createHash} from 'node:crypto'
import {sourceRoot as root,loaded,hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
// Use actual installed YAML, skill merge/index and SDK dependencies. The old
// candidate-writer stub is no longer the business path under test.
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {FrameworkKnowledge}=await import('../src/framework/knowledge.ts')
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-knowledge-'))
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const files=new PhysicalLocalFiles(scratch);let changed=0
const knowledge=new FrameworkKnowledge(files,{run(){throw Error('Generic transaction reached')}},()=>changed++)
const read=async p=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const controls='technical/skills/controls.json',candidates='technical/skills/candidates.json',target='skills/example/SKILL.md'
try{
 const originalBody='---\nname: example\ndescription: Original\n---\nalpha original\nkeep\nbeta original\n'
 await files.replace(target,originalBody)
 const before=await knowledge.read(target)
 await files.replace(target,originalBody.replace('beta original','beta peer'))
 const edit={path:target,expectedRevision:before.revision,baseBody:before.text,body:originalBody.replace('alpha original','alpha user'),createdAt:'2026-11-08T12:00:00Z'}
 const merged=edit.body.replace('beta original','beta peer')
 check((await knowledge.edit('edit-one',edit)).saved,true);check(await read(target),merged)
 const candidatesFor=async (service=knowledge)=>(await service.list()).items.find(item=>item.path===target).candidates
 check((await candidatesFor()).length,0);check(await read(candidates),undefined)
 // Pre-existing originals remain visible, without creating any new candidates.
 const candidate='skills/example/candidates/retained.md'
 await files.replace(candidate,'user revised candidate')
 check((await candidatesFor()).length,1);await knowledge.edit('same-body',{...edit});check((await candidatesFor()).length,1)
 const conflict={...edit,body:originalBody.replace('alpha original','alpha conflicting draft')}
 const rejected=await knowledge.edit('conflicting-edit',conflict)
 check(rejected.saved,false);check(rejected.conflicts[0].current,merged);check(await read(candidate),'user revised candidate')
 const cold=new PhysicalLocalFiles(scratch),reopened=new FrameworkKnowledge(cold,{run(){throw Error('generic transaction')}},()=>changed++)
 check((await candidatesFor(reopened)).length,1);check((await reopened.edit('edit-one',edit)).saved,true);check(await read(target),merged);await cold.close()
 await knowledge.setStatus('disable',{path:target,expectedRevision:'old UI selection',status:'disabled',reason:'user choice'})
 check(JSON.parse(await read(controls)).entries[target],{status:'disabled',reason:'user choice'});check(await read(target),merged)
 const statusBytes=await read(controls);await knowledge.setStatus('disable',{path:target,expectedRevision:'old UI selection',status:'disabled',reason:'user choice'});check(await read(controls),statusBytes)
 const legacyPath='skills/old/record.json',scope={assistantId:'assistant',workspaceId:'workspace'}
 const original={schemaVersion:1,kind:'skill',skillId:'old',scope,revision:1,activeVersion:1,versions:[{skillId:'old',version:1,title:'title',description:'desc',applicability:'scope',body:'old original',scope,contentHash:'old hash',status:'active',createdAt:edit.createdAt,sourceResultIds:[],validations:[],uses:[],feedback:[]}],receipts:{}}
 await files.replace(legacyPath,JSON.stringify(original))
 const oldEdit={...edit,path:legacyPath,body:'new legacy candidate'}
 const beforeLegacy=await read(legacyPath)
 check((await knowledge.read(legacyPath)).text,beforeLegacy);check((await knowledge.read(legacyPath)).readOnly,true);check((await knowledge.read(legacyPath)).edit,undefined)
 check((await knowledge.edit('legacy-one',oldEdit)).saved,false)
 check((await knowledge.setStatus('old-status',{path:legacyPath,expectedRevision:'old',status:'retired'})).saved,false)
 check(await read(legacyPath),beforeLegacy);check(JSON.parse(await read(controls)).entries[legacyPath],undefined)
 check((await knowledge.list()).items.find(item=>item.path===legacyPath).status,'read-only')
 const converted='skills/old/SKILL.md',resource='skills/old/resources/original-record.json'
 await files.replace(converted,'---\nname: old\ndescription: Converted\n---\nnative original')
 await files.replace(resource,beforeLegacy)
 await files.delete(legacyPath)
 let resolutions=0
 const convertedKnowledge=new FrameworkKnowledge(files,{run(){throw Error('generic transaction')}},()=>changed++,{async resolve(p){resolutions++;check(p,legacyPath);return{convertedPath:converted}},pendingPaths:()=>[legacyPath]})
 const convertedRead=await convertedKnowledge.read(legacyPath)
 check(convertedRead.path,converted);check(convertedRead.sourcePath,legacyPath);check(convertedRead.convertedPath,converted);check(convertedRead.edit.body,await read(converted));check(convertedRead.resources,[resource])
 const retained={...oldEdit,title:'retained title',description:'retained description',applicability:'retained applicability'}
 check((await convertedKnowledge.edit('stale-old',retained)).convertedPath,converted)
 check((await convertedKnowledge.setStatus('stale-status',{path:legacyPath,expectedRevision:'old',status:'disabled'})).convertedPath,converted)
 check(await read(legacyPath),undefined);check(JSON.parse(await read(controls)).entries[converted],undefined)
 await files.replace(legacyPath,'Later user-created original, not the converted source')
 const recreated=await convertedKnowledge.read(legacyPath);check(recreated.path,legacyPath);check(recreated.readOnly,true);check(recreated.text,'Later user-created original, not the converted source');check(recreated.convertedPath,undefined)
 await files.delete(legacyPath)
 const count=resolutions;const convertedBase=await convertedKnowledge.read(converted);await convertedKnowledge.edit('native-edit',{...edit,path:converted,baseBody:convertedBase.text,expectedRevision:convertedBase.revision,body:convertedBase.text+'\nExplicit native edit\n'});await convertedKnowledge.setStatus('native-status',{path:converted,expectedRevision:'old',status:'disabled'});check(resolutions,count)
 // Pending SQL-only rendered SKILL.md remains raw until physical publication.
 const pendingPath='skills/sql-only/SKILL.md',pendingText='# Original rendered title\n\nUnfrontmattered original body'
 let pendingResolutions=0
 const pendingKnowledge=new FrameworkKnowledge(files,{run(){throw Error('generic transaction')}},()=>{}, {pendingPaths:()=>[pendingPath],async resolve(p){check(p,pendingPath);pendingResolutions++;return{text:pendingText}}})
 const pendingRow=(await pendingKnowledge.list()).items.find(item=>item.path===pendingPath)
 check(pendingRow.readOnly,true);check(pendingRow.text,pendingText);check(pendingRow.error,undefined);check(pendingRow.indexed,false)
 const pendingRead=await pendingKnowledge.read(pendingPath)
 check(pendingRead.text,pendingText);check(pendingRead.readOnly,true);check(pendingRead.edit,undefined);check(pendingResolutions,2)
 await pendingKnowledge.read('skills/not-in-inventory/SKILL.md');check(pendingResolutions,2)
 const published='---\nname: sql-only\ndescription: Physical native wins\n---\nnew native body'
 await files.replace(pendingPath,published)
 check((await pendingKnowledge.read(pendingPath)).edit.body,published)
 const publishedRow=(await pendingKnowledge.list()).items.find(item=>item.path===pendingPath)
 check(publishedRow.name,'sql-only');check(publishedRow.readOnly,undefined);check(pendingResolutions,2)
 // Actual nested native definitions delimit ownership; no extra discovery.
 const child='skills/old/nested/SKILL.md',childResource='skills/old/nested/resources/source.txt',ownResource='skills/old/scripts/helper.txt'
 await files.replace(child,'---\nname: child\ndescription: Child\n---\nchild body');await files.replace(childResource,'child source');await files.replace(ownResource,'own helper')
 const nestedList=await knowledge.list(),parentRow=nestedList.items.find(item=>item.path===converted),childRow=nestedList.items.find(item=>item.path===child)
 check(parentRow.resources.sort(),[resource,ownResource].sort());check(childRow.resources,[childResource])
 check((await knowledge.read(converted)).resources.sort(),[resource,ownResource].sort());check((await knowledge.read(child)).resources,[childResource])
 // An old command must reach the original transaction run before conversion.
 let transactionMode='unknown',runs=0,bridgeCalls=0
 const transactional=new FrameworkKnowledge({}, {async run(id,input,options,build){runs++;check(id,'knowledge-edit:original');check(input,retained);if(transactionMode==='unknown')throw Error('original outcome unknown');if(transactionMode==='receipt')return{revision:'confirmed-original',replay:true};return build({})}},()=>{}, {async resolve(){bridgeCalls++;return{convertedPath:converted}}})
 await assert.rejects(transactional.edit('original',retained),/original outcome unknown/);assertions++;check(bridgeCalls,0)
 transactionMode='receipt';check((await transactional.edit('original',retained)).revision,'confirmed-original');check(bridgeCalls,0)
 transactionMode='new';check((await transactional.edit('original',retained)).convertedPath,converted);check(bridgeCalls,1);check(runs,3)
 check(changed>0,true)
 const serviceSource=readFileSync(new URL('framework/service.ts',root),'utf8')
 function section(start,end){return serviceSource.slice(serviceSource.indexOf(start),serviceSource.indexOf(end,serviceSource.indexOf(start)+start.length))}
 const Service=new Function(stripTypeScriptTypes('class Service {\n'+section('    knowledgeEdit(', '    private controls(')+'\n}',{mode:'transform'})+'\nreturn Service')()
 const service=new Service();service.withAccessOperation=(_input,fn)=>fn({});service.foreground=(_access,fn)=>fn();service.knowledge=()=>knowledge
 const serviceBase=await knowledge.read(target),serviceBody=serviceBase.text+'\nActual service edit\n'
 await service.knowledgeEdit({mode:'local',storageScope:'scope',commandId:'service-edit',...edit,baseBody:serviceBase.text,expectedRevision:serviceBase.revision,body:serviceBody})
 await service.knowledgeStatus({mode:'local',storageScope:'scope',commandId:'service-status',path:target,expectedRevision:'old',status:'retired'})
 check(await read(target),serviceBody);check((await candidatesFor()).length,1)
 check(JSON.parse(await read(controls)).entries[target].status,'retired')
 const clientSource=readFileSync(new URL('framework/client-page.tsx',root),'utf8'),submitStart=clientSource.indexOf('  const submit = async (operation: KnowledgePending) =>')
 const submitBody=clientSource.slice(submitStart,clientSource.indexOf('  const save =',submitStart))
 const uiOperations=new Map(),uiNotices=[],uiErrors=[]
 const uiDeps={selected:undefined,edit:undefined,reading:{current:0},editAttempt:{},statusAttempt:{},setSelected(){},setEdit(){},operations:uiOperations,redraw:()=>{},api:{knowledgeEdit:input=>service.knowledgeEdit(input),knowledgeStatus:input=>service.knowledgeStatus(input)},active:{current:true},setNotice:n=>uiNotices.push(n),tr:(cn,en)=>en,refresh:async()=>{},setError:e=>uiErrors.push(e),frameworkErrorText:e=>String(e)}
 const uiSubmit=new Function(...Object.keys(uiDeps),stripTypeScriptTypes(submitBody,{mode:'transform'})+'return submit')(...Object.values(uiDeps))
 const pendingEdit={kind:'edit',input:{commandId:'conflicting-ui',mode:'local',...conflict}}
 check(await uiSubmit(pendingEdit),false);check(uiOperations.get('conflicting-ui').input.body,conflict.body)
 check(uiNotices.at(-1),'This change was not applied. The current skill and your draft are retained. Review the conflict, reload the skill, then save your resolved edit.');check(uiNotices.some(text=>text.includes('Candidate saved')),false)
 const unconvertedStatus={kind:'status',input:{mode:'local',commandId:'unconverted-status-ui',path:legacyPath,expectedRevision:'old',status:'retired'}}
 check(await uiSubmit(unconvertedStatus),false);check(uiOperations.get('unconverted-status-ui').input,unconvertedStatus.input)
 check(uiNotices.at(-1),'This change was not applied. The current skill and your draft are retained. Review the conflict, reload the skill, then save your resolved edit.')
 const oldUi={kind:'edit',input:{commandId:'stale-ui',mode:'local',storageScope:'scope',...retained}}
 service.knowledge=()=>convertedKnowledge
 check(await uiSubmit(oldUi),false);check(uiOperations.get('stale-ui').input,oldUi.input);check(uiOperations.get('stale-ui').convertedPath,converted)
 check(uiNotices.at(-1).includes('The original skill was converted.'),true)
 check(oldUi.input.path,legacyPath);check(oldUi.input.title,'retained title');check(oldUi.input.description,'retained description');check(oldUi.input.applicability,'retained applicability')
 const staleStatus={kind:'status',input:{commandId:'status-ui',mode:'local',storageScope:'scope',path:legacyPath,expectedRevision:'old',status:'retired',reason:'original reason',updatedAt:edit.createdAt}}
 check(await uiSubmit(staleStatus),false);check(uiOperations.get('status-ui').input,staleStatus.input);check(uiOperations.get('status-ui').convertedPath,converted)
 check(JSON.parse(await read(controls)).entries[converted].status,'disabled')
 // Reconstructing a submit handler after a scope remount retains the same
 // original command/input map, rather than manufacturing a new target edit.
 const remountedSubmit=new Function(...Object.keys(uiDeps),stripTypeScriptTypes(submitBody,{mode:'transform'})+'return submit')(...Object.values(uiDeps))
 check(await remountedSubmit(uiOperations.get('stale-ui')),false);check(uiOperations.get('stale-ui').input,oldUi.input)
 check(clientSource.includes('operation.input.mode === scope.mode && operation.input.storageScope === scope.storageScope'),true)
 service.knowledge=()=>knowledge
 check(clientSource.includes('View retained draft'),true);check(clientSource.includes('open(operation.convertedPath!)'),true);check(clientSource.includes('open(candidate.path)'),true)
 check(uiErrors,[]);check(await read(candidate),'user revised candidate')
 const finalRead=await knowledge.read(target)
 check(await uiSubmit({kind:'edit',input:{...pendingEdit.input,commandId:'confirmed-ui',baseBody:finalRead.text,expectedRevision:finalRead.revision,body:finalRead.text+'\nA newly authored direct edit\n'}}),true)
 check(uiOperations.has('confirmed-ui'),false);check(uiOperations.has('conflicting-ui'),true)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual Knowledge/Service edit/status, real physical files, cold handle, merge/catalog and installed SDK/YAML. UI submit is exact extracted code with display/state ports. Original unknown/receipt conversion ordering retains its explicit controlled transaction stub, not a real transport-failure claim; no new failure injection. Full mounted UI/native runtime refresh is not claimed.',...evidence(),sourceHashes:{...Object.fromEntries(loaded),'framework/client-page.tsx':createHash('sha256').update(clientSource).digest('hex')}},null,2))
}finally{await files.close();await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
