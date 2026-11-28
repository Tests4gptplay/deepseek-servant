import {currentSource,emitEvidence} from './support.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash,randomUUID} from 'node:crypto'
import {stripTypeScriptTypes} from 'node:module'
import {PhysicalLocalFiles} from '../../../src/framework/physical-local-files.ts'
import {GitFiles,FilesConflictError,FilesOutcomeUnknownError} from '../../../src/framework/transactions.ts'
import {GitAuthorityStore,SessionGitOperations} from '../../../src/framework/git-authority.ts'
import {FrameworkTransactions,CommandInputsChangedError} from '../../../src/framework/command-transactions.ts'
import {TaskWorkspaces} from '../../../src/framework/task-workspace.ts'
import * as taskFiles from '../../../src/framework/task-files.ts'
import * as archive from '../../../src/framework/task-archive.ts'
import * as history from '../../../src/framework/task-history.ts'
import {Repository,put,head} from '../controlled-git/repository.mjs'
import {GitConflictError} from '../../../src/experimental/private-git/github.ts'
import {serviceFixture} from './service-fixture.mjs'
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise}}
class CheckedRepository extends Repository { attempts=0; hook; async commitPrepared(...args){this.attempts++;await this.hook?.(...args);if(args[3].expectedHead!==this.head)throw new GitConflictError('Controlled actual HEAD conflict');return super.commitPrepared(...args)} }
const base=await fs.mkdtemp(path.join(os.tmpdir(),'dss-metadata-accept-')),owner='A',scope='scope',instanceUUID=randomUUID(),costs=[]
const digest=s=>createHash('sha256').update(s).digest('hex')
function section(s,a,b){const x=s.indexOf(a),y=s.indexOf(b,x+a.length);assert(x>=0&&y>x,a);return s.slice(x,y)}
const deps={...taskFiles,...archive,...history,PhysicalLocalFiles,GitFiles,GitAuthorityStore,randomUUID,digest,CommandInputsChangedError,FilesConflictError,FilesOutcomeUnknownError}
function hostClass(){const s=currentSource('host-loop'),body=section(s,'  private runOperation<','  /** Only fixed discovery')+section(s,'  private async currentTaskEntry(', '  private remotePoll(')+section(s,'  private save():','  /** The Host and runtime share')+section(s,'  private startSource(', '  private startTask(');return new Function(...Object.keys(deps),'return '+stripTypeScriptTypes('class H {\n'+body+'\n}',{mode:'transform'}))(...Object.values(deps))}
async function fixture(mode,existing){const dir=await fs.mkdtemp(path.join(base,mode)),workspace=path.join(dir,'workspace'),repository=new CheckedRepository();let files,records;const values=new Map(),saves=[];const sourcePath='tasks/Example_P.md',taskId=randomUUID(),task={version:1,taskId,route:'P',sourcePath,owner,members:[owner],status:'running'},source=(existing?'Task ID: '+taskId+'\n':'')+'Actual supplied requirement\n';
 if(mode==='local'){files=await PhysicalLocalFiles.open(path.join(dir,'records'));await files.replace(sourcePath,source);if(existing)await files.replace(taskFiles.paths.task(taskId),JSON.stringify(task));records={async get(k){return structuredClone(values.get(k))},async set(k,v){saves.push(structuredClone(v));values.set(k,structuredClone(v))}}}
 else{put(repository,sourcePath,source);if(existing)put(repository,taskFiles.paths.task(taskId),task);head(repository);files=new GitFiles(repository,new SessionGitOperations());records=new GitAuthorityStore(files,scope);const set=records.set.bind(records);records.set=(k,v)=>{saves.push(structuredClone(v));return set(k,v)}}
 const workspaces=new TaskWorkspaces(files,workspace,owner,instanceUUID,archive.taskArchiveHostKey(records instanceof GitAuthorityStore?records.root:undefined,scope,instanceUUID)),Host=hostClass(),loop=new Host(),runtime={workspaces,loop,config:{workspace}},actions={workspaceRoot:()=>runtime.config.workspace,initializeWorkspace:async t=>{await workspaces.ensure(t.taskId)}};
 Object.assign(loop,{files,storage:records,transactions:new FrameworkTransactions(files,records,scope),key:'framework-host/test',record:{initial:{},completed:{}},saving:Promise.resolve(),identity:{member:owner,scope,instanceUUID,primary:true},members:()=>[owner],actions:{...actions,error(){}},archiveHostKey:archive.taskArchiveHostKey(records instanceof GitAuthorityStore?records.root:undefined,scope,instanceUUID),stopping:false,sourceOperations:new Map(),seenSources:new Map(),sourceInitializations:new Map()});
 const snapshot=await files.snapshot(),revision=snapshot.revision;await snapshot.release();const entry=mode==='local'?await files.fileMetadata(sourcePath):{path:sourcePath,version:digest(source)};return{loop,files,records,repository,saves,sourcePath,entry,revision,workspaces,workspace,runtime,values,close:()=>files.close?.()}}

async function read(f,p){const v=await f.files.snapshot();try{return await f.files.read(v,p)}finally{await v.release()}}
async function createSource(f,p,text='Later requirement'){if(f.files instanceof PhysicalLocalFiles)await f.files.replace(p,text);else{put(f.repository,p,text);head(f.repository)}const v=await f.files.snapshot(),revision=v.revision;await v.release();return {entry:f.files instanceof PhysicalLocalFiles?await f.files.fileMetadata(p):{path:p,version:digest(text)},revision}}
async function settings(f,mode){const s=await serviceFixture({mode,workspace:f.workspace});s.runtime.workspaces=f.workspaces;
f.loop.actions.workspaceRoot=()=>s.runtime.config.workspace;return s}
for (const mode of ['local', 'git']) test(`${mode}: full new-source creation binds in original metadata publication with no added commit/set`, async () => {
 const f = await fixture(mode, false)
 try {
  const created = [], metadataUpdates = []
  if (mode === 'local') {
   const create = f.files.createIfAbsent.bind(f.files), update = f.files.update.bind(f.files)
   f.files.createIfAbsent = async (p, content, ...rest) => { created.push({path:p, content}); return create(p, content, ...rest) }
   f.files.update = async (p, ...args) => { metadataUpdates.push(p); return update(p, ...args) }
  }
  await f.loop.startSource(f.entry, f.revision)
  const id = taskFiles.taskIdentity(await read(f, f.sourcePath)), metadataPath = taskFiles.paths.task(id)
  const task = JSON.parse(await read(f, metadataPath))
  assert.equal(task.hostWorkspaces[instanceUUID], f.workspace)
  assert.equal(f.saves.length, mode === 'local' ? 3 : 0, 'Current original Host initialization saves; no separate locator save')
  assert.equal(f.repository.calls.length, mode === 'git' ? 1 : 0, 'Current atomic source initialization commit; no extra binding commit')
  if (mode === 'local') {
   const metadata = created.filter(row => row.path === metadataPath)
   assert.equal(metadata.length, 1, 'One original Task metadata create')
   assert.equal(JSON.parse(metadata[0].content).hostWorkspaces[instanceUUID], f.workspace, 'The original create already owns the root')
   assert.equal(metadataUpdates.filter(p => p === metadataPath).length, 0, 'Ensure adds no Task metadata update')
  } else {
   const commit = f.repository.calls[0], metadata = commit.changes.find(row => row.path === 'dss-coop/' + metadataPath)
   assert.equal(JSON.parse(metadata.content).hostWorkspaces[instanceUUID], f.workspace, 'The original atomic commit already owns the root')
   assert(commit.changes.some(row => row.path === 'dss-coop/' + f.sourcePath && taskFiles.taskIdentity(row.content) === id), 'Source identity and root binding share the original commit')
  }
  costs.push({mode, hostSets:f.saves.length, commits:f.repository.calls.length, bindingInOriginalPublication:true})
 } finally { await f.close() }
})
test('Local: A metadata publication held, real configure accepts new root, unrelated B completes with new root; cold A stays original with no RoleRecord',async()=>{const f=await fixture('local',false);try{const s=await settings(f,'local'),gate=defer(),entered=defer(),create=f.files.createIfAbsent.bind(f.files);let first=true;f.files.createIfAbsent=async(p,...args)=>{if(first&&/^tasks\/[^/]+\.json$/.test(p)){first=false;entered.resolve();await gate.promise}return create(p,...args)};const a=f.loop.startSource(f.entry,f.revision);await entered.promise;const next=path.join(f.workspace,'..','new');await s.service.configure(s.request({workspace:next}));assert.equal(s.current().settings.workspace,next);const bSource=await createSource(f,'tasks/Later_P.md');await f.loop.startSource(bSource.entry,bSource.revision);const bid=taskFiles.taskIdentity(await read(f,bSource.entry.path)),bt=JSON.parse(await read(f,taskFiles.paths.task(bid)));assert.equal(bt.hostWorkspaces[instanceUUID],next);assert.equal(s.runtime.roleRecords.size,6,'controlled non-Task roles only; no Task RoleRecord exists');gate.resolve();await a;const aid=taskFiles.taskIdentity(await read(f,f.sourcePath)),at=JSON.parse(await read(f,taskFiles.paths.task(aid)));assert.equal(at.hostWorkspaces[instanceUUID],f.workspace);const cold=new TaskWorkspaces(f.files,next,owner,instanceUUID);assert.equal(path.dirname((await cold.ensure(aid)).directory),f.workspace);assert.equal(path.dirname((await cold.ensure(bid)).directory),next);assert.equal(f.saves.length,6,'3 original Host saves per source, none added');costs.push({case:'local-A-metadata-held',settingsAccepted:true,BFinishedBeforeA:true,hostSets:6})}finally{await f.close()}})
test('Git: A atomic publication held, real configure and B commit finish; original A conflict reevaluates preserving B and A old-root allocation',async()=>{const f=await fixture('git',false);try{const s=await settings(f,'git'),gate=defer(),entered=defer();let first=true;f.repository.hook=async(_v,changes)=>{if(first&&changes.some(c=>c.path==='dss-coop/'+f.sourcePath)){first=false;entered.resolve();await gate.promise}};const a=f.loop.startSource(f.entry,f.revision);await entered.promise;const next=path.join(f.workspace,'..','new');await s.service.configure(s.request({workspace:next}));const bs=await createSource(f,'tasks/Later_P.md');await f.loop.startSource(bs.entry,bs.revision);const bid=taskFiles.taskIdentity(await read(f,bs.entry.path));assert.equal(JSON.parse(await read(f,taskFiles.paths.task(bid))).hostWorkspaces[instanceUUID],next);gate.resolve();await a;const aid=taskFiles.taskIdentity(await read(f,f.sourcePath)),at=JSON.parse(await read(f,taskFiles.paths.task(aid)));assert.equal(at.hostWorkspaces[instanceUUID],f.workspace);assert.equal(JSON.parse(await read(f,taskFiles.paths.task(bid))).hostWorkspaces[instanceUUID],next);const cold=new TaskWorkspaces(f.files,next,owner,instanceUUID);assert.equal(path.dirname((await cold.ensure(aid)).directory),f.workspace);assert.equal(path.dirname((await cold.ensure(bid)).directory),next);assert.equal(f.repository.calls.length,2);assert.equal(f.repository.attempts,3);costs.push({case:'git-A-atomic-held',commits:2,attempts:3,HostSupplementSets:f.saves.length,BFinishedBeforeA:true})}finally{await f.close()}})
for(const mode of ['local','git'])test(`${mode}: first ensure metadata read pending across real configure consumes durable own-Host root, no new binding write`,async()=>{const f=await fixture(mode,false);try{await f.loop.startSource(f.entry,f.revision);const id=taskFiles.taskIdentity(await read(f,f.sourcePath)),s=await settings(f,mode),beforeSets=f.saves.length,beforeCommits=f.repository.calls.length,gate=defer(),entered=defer(),reader=f.files.read.bind(f.files);let first=true;f.files.read=async(v,p)=>{if(first&&p===taskFiles.paths.task(id)){first=false;entered.resolve();await gate.promise}return reader(v,p)};const a=f.workspaces.ensure(id);await entered.promise;const next=path.join(f.workspace,'..','new');await s.service.configure(s.request({workspace:next}));gate.resolve();assert.equal(path.dirname((await a).directory),f.workspace);assert.equal(f.saves.length,beforeSets);assert.equal(f.repository.calls.length,beforeCommits)}finally{await f.close()}})
test('own-Host identity: peer uses its own selection, never another Host absolute root',async()=>{const f=await fixture('git',false);try{await f.loop.startSource(f.entry,f.revision);const id=taskFiles.taskIdentity(await read(f,f.sourcePath)),peerRoot=path.join(f.workspace,'..','peer'),peer=new TaskWorkspaces(f.files,peerRoot,owner,randomUUID());assert.equal(path.dirname((await peer.locate(id)).directory),peerRoot);assert.equal(path.dirname((await f.workspaces.locate(id)).directory),f.workspace)}finally{await f.close()}})
test('existing metadata: original initialization binds only this Host before ensure, without Host.save',async()=>{const f=await fixture('git',true);try{const before=await read(f,taskFiles.paths.task(taskFiles.taskIdentity(await read(f,f.sourcePath))));await f.loop.startSource(f.entry,f.revision);const after=JSON.parse(await read(f,taskFiles.paths.task(taskFiles.taskIdentity(await read(f,f.sourcePath)))));assert.deepEqual({...after,hostWorkspaces:undefined},{...JSON.parse(before),hostWorkspaces:undefined});assert.equal(after.hostWorkspaces[instanceUUID],f.workspace);assert.equal(f.repository.calls.length,1);assert.equal(f.saves.length,0)}finally{await f.close()}})
test.after(async()=>{emitEvidence('creation-binding-costs',costs);await fs.rm(base,{recursive:true,force:true})})
console.log('Narrow creation-acceptance probe, not full runtime integration. Exact source initializer/transaction/metadata/TaskWorkspaces bodies; actual candidate configure body with controlled native/service ports and actual per-Task selection preparation. Actual Local files, actual GitAuthority/FrameworkTransactions and project controlled Git plus expected-HEAD conflict check. No real remote/Windows/model.')
