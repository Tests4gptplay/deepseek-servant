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
import {GitFiles,FilesConflictError,FilesOutcomeUnknownError,withSnapshot} from '../../../src/framework/transactions.ts'
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
const deps={...taskFiles,...archive,...history,PhysicalLocalFiles,GitFiles,GitAuthorityStore,withSnapshot,randomUUID,digest,CommandInputsChangedError,FilesConflictError,FilesOutcomeUnknownError}
function hostClass(){const s=currentSource('host-loop'),body=section(s,'  async start():','  private schedule():')+section(s,'  private continuePhysicalCleanup(', '\n}').trimEnd()+section(s,'  private runOperation<','  /** Only fixed discovery')+section(s,'  private async currentTaskEntry(', '  private remotePoll(')+section(s,'  private save():','  private async wake(')+section(s,'  private startSource(', '  private startTask(');return new Function(...Object.keys(deps),'return '+stripTypeScriptTypes('class H {\n'+body+'\n}',{mode:'transform'}))(...Object.values(deps))}
async function fixture(mode,existing){const dir=await fs.mkdtemp(path.join(base,mode)),workspace=path.join(dir,'workspace'),repository=new CheckedRepository();let files,records;const values=new Map(),saves=[];const sourcePath='tasks/Example_P.md',taskId=randomUUID(),task={version:1,taskId,route:'P',sourcePath,owner,members:[owner],status:'running'},source=(existing?'Task ID: '+taskId+'\n':'')+'Actual supplied requirement\n';
 if(mode==='local'){files=await PhysicalLocalFiles.open(path.join(dir,'records'));await files.replace(sourcePath,source);if(existing)await files.replace(taskFiles.paths.task(taskId),JSON.stringify(task));records={async get(k){return structuredClone(values.get(k))},async list(prefix){return [...values].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)}))},async set(k,v){saves.push(structuredClone(v));values.set(k,structuredClone(v))}}}
 else{put(repository,sourcePath,source);if(existing)put(repository,taskFiles.paths.task(taskId),task);head(repository);files=new GitFiles(repository,new SessionGitOperations());records=new GitAuthorityStore(files,scope);const set=records.set.bind(records);records.set=(k,v)=>{saves.push(structuredClone(v));return set(k,v)}}
 const workspaces=new TaskWorkspaces(files,workspace,owner,instanceUUID,archive.taskArchiveHostKey(records instanceof GitAuthorityStore?records.root:undefined,scope,instanceUUID)),Host=hostClass(),loop=new Host(),runtime={workspaces,loop,config:{workspace}},actions={workspaceRoot:()=>runtime.config.workspace,initializeWorkspace:async t=>{await workspaces.ensure(t.taskId)}};
 Object.assign(loop,{files,storage:records,transactions:new FrameworkTransactions(files,records,scope),key:'framework-host/test',record:{initial:{},completed:{}},saving:Promise.resolve(),pendingCompletion:new Map(),identity:{member:owner,scope,instanceUUID,primary:true},members:()=>[owner],actions:{...actions,releaseWorkspace:id=>workspaces.release(id),error(){}},archiveHostKey:archive.taskArchiveHostKey(records instanceof GitAuthorityStore?records.root:undefined,scope,instanceUUID),stopping:false,sourceOperations:new Map(),seenSources:new Map(),sourceInitializations:new Map()});
 const snapshot=await files.snapshot(),revision=snapshot.revision;await snapshot.release();const entry=mode==='local'?await files.fileMetadata(sourcePath):{path:sourcePath,version:digest(source)};return{loop,files,records,repository,saves,sourcePath,entry,revision,workspaces,workspace,runtime,values,close:()=>files.close?.()}}

async function read(f,p){const v=await f.files.snapshot();try{return await f.files.read(v,p)}finally{await v.release()}}
async function createSource(f,p,text='Later requirement'){if(f.files instanceof PhysicalLocalFiles)await f.files.replace(p,text);else{put(f.repository,p,text);head(f.repository)}const v=await f.files.snapshot(),revision=v.revision;await v.release();return {entry:f.files instanceof PhysicalLocalFiles?await f.files.fileMetadata(p):{path:p,version:digest(text)},revision}}
async function settings(f,mode){const s=await serviceFixture({mode,workspace:f.workspace});s.runtime.workspaces=f.workspaces;
f.loop.actions.workspaceRoot=()=>s.runtime.config.workspace;return s}

export {fixture,settings,read,createSource,section,base,instanceUUID,owner,scope,defer,digest,deps,hostClass}
