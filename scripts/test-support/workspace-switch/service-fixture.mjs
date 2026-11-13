import {currentSource,emitEvidence} from './support.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {stripTypeScriptTypes,createRequire} from 'node:module'
import '../dsh-sdk-runtime.mjs'
import {NativeExecutions} from '../../../src/framework/native-executions.ts'
import {omitAbsentFields} from '../../../src/adapters/dsh/json-record.ts'
import {TaskWorkspaces} from '../../../src/framework/task-workspace.ts'
import {PhysicalLocalFiles} from '../../../src/framework/physical-local-files.ts'
import {DshWorkspaceAdapter} from '../../../src/adapters/dsh/workspace.ts'
import {paths} from '../../../src/framework/task-files.ts'
const source=currentSource('service')
const runtimeSource=currentSource('role-runtime')
const section=(src,start,end)=>{const a=src.indexOf(start),b=src.indexOf(end,a+start.length);assert(a>0&&b>a);return src.slice(a,b)}
const methods=section(source,'    private serialMode<','    private closed =')+section(source,'    foregroundModel(input:','    async gitMembers(')+section(source,'    send(input:', '    private async sendStored')+section(source,'    private async stopManualCleanup(', '    dispose():')
const {z}=await import('zod')
const schemaText=source.slice(source.indexOf('const model ='),source.indexOf('interface Saved'))
const {model,settingsSchema}=new Function('z',schemaText+'return {model,settingsSchema};')(z)
const deps={DshWorkspaceAdapter,isAbsolute:path.isAbsolute,resolve:path.resolve,createHash,randomUUID,isDeepStrictEqual,omitAbsentFields,z,model,settingsSchema,abortedBy:(s,e)=>s.aborted&&e===s.reason}
const Service=new Function(...Object.keys(deps),'return '+stripTypeScriptTypes('class Service {\n'+methods+'\n}',{mode:'transform'}))(...Object.values(deps))
const disposal=runtimeSource.slice(runtimeSource.indexOf('  dispose(): Promise<void> {'),runtimeSource.lastIndexOf('\n}'))
const setters=section(runtimeSource,'  setForegroundModel(', '  /** A successful local write')
const Runtime=new Function('return '+stripTypeScriptTypes('class Runtime {\n'+setters+disposal+'\n}',{mode:'transform'}))()
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const roles=['Foreground','Planner','Worker','Organizer','Recorder','Helper']
const modelSelection=new Function('request','return '+runtimeSource.match(/model: (\(request\.role === 'Foreground'[^\n]+),\n/)[1])
async function fixture({mode='local',workspace='/work'}={}){
 const events=[],runtime=new Runtime(),service=new Service(),storageRows=new Map(),saved=new Map(),agents=new Map();let connectGate,persistGate,connectError
 const ctx={on:()=>()=>{},workspaceRegistry:{async create(directory){events.push(['resolve-workspace',directory]);return{id:'workspace',path:directory}}}};const observations={async bind(){},async unbind(work,id){events.push(['unbind',work,id])},async dispose(){events.push(['observations-close'])}}
 const gateway={async create(req){const agent={cwd:req.cwd,model:req.model,actualAgent:{id:req.sessionId,session:{id:req.sessionId,snapshotEvents:()=>[]}},observe:()=>({jobs:[]}),async dispose(){events.push(['native-dispose',req.role]);agent.disposed=true}};agents.set(req.role,agent);return agent}}
 const native=new NativeExecutions(ctx,gateway,observations)
 const config={name:'Assistant',userName:'owner',localDirectory:'/local',ownerRepo:'owner/repo',repositoryDirectory:'',collaborationId:'chat',workerSeats:2,workspace,presetId:'preset-old',foreground:{provider:'p',model:'front-old'},background:{provider:'p',model:'back-old'}}
 Object.assign(runtime,{pendingControlStops:[],localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),updateWorkerSeats(n){this.config.workerSeats=n},config:{...config},native,roleRecords:new Map(),cleaner:{close(){}},cleanupResidues:new Set(),workspaces:{root:workspace,select(root){this.root=root},rememberRoot(){},locations:()=>[],knownTasks:()=>[],async bind(){}},loop:{async rememberWorkspaces(){},async stop(){events.push(['loop-stop'])}},environment:{cancelPending(){events.push(['cancel-runtime'])}},targetedPumps:new Map(),organizerWakeWrites:new Map(),observations,serialWork:async(_key,fn)=>fn(),async finishForegroundRound(){},async finishGitAuxiliaryRound(){},roleKey:r=>r,async saveRole(record){runtime.roleRecords.set(record.identity.workId,record)},stopOwnedRecord:record=>native.stop(record.identity.workId,record.identity.executionId),async settleOperations(values){await Promise.all(values)},cancelledByShutdown:()=>false})
 for(const role of roles){const identity={workId:role,executionId:'execution-'+role,role};runtime.roleRecords.set(role,{identity,sessionId:'session-'+role,generation:1});await native.open(identity,{sessionId:'session-'+role,cwd:config.workspace,model:modelSelection.call(runtime,{role})})}
 const connection={scope:'scope',registration:{workerSeats:2},async updateWorkerSeats(n){this.registration={workerSeats:n};return this.registration},async members(){return[]},cancelPending(){},async close(){events.push(['connection-close'])}}
 const running={runtime,connection,resources:[],workspaceSelection:workspace};saved.set(mode,{revision:'r1',settings:config})
 Object.assign(service,{ctx,closed:false,configurationOwners:new Set(),settingsCommands:new Map(),modeConfiguration:new Map(),modeSending:new Map(),conversationBarriers:new Map(),configurationErrors:new Map(),reportedErrors:new Map(),accessTransitions:new Map(),accesses:new Map(),archiveViews:new Map(),accessOpening:new Map(),backgroundOpening:new Map(),opening:new Map(),running:new Map([[mode,running]]),stopping:new WeakMap(),gitUpgrades:new Map(),saved,storage:{async get(k){return storageRows.get(k)},async set(k,v){storageRows.set(k,v)}},assertOpen(){},moveError:()=>undefined,config:m=>saved.get(m),async persistSettings(m,next){events.push(['persist']);if(persistGate)await persistGate;storageRows.set('framework-settings/'+m,next);saved.set(m,next)},settingsView:()=>({settings:saved.get(mode).settings,revision:saved.get(mode).revision}),changed(){},clearResolvedErrors(){},prepareGit(){},refreshErrors(){},report(){return'error'},diagnosticScope:()=> 'scope',async connect(){events.push(['connect']);if(connectGate)await connectGate;if(connectError)throw connectError},async closeAccess(){throw Error('Unrelated Access must not close')},async sendStored(input){events.push(['send',input.id]);return input.id}})
 const request=changes=>({mode,commandId:randomUUID(),settings:{...saved.get(mode).settings,...changes},changedFields:Object.keys(changes)})
 return {service,runtime,running,events,agents,config,request,fore:model=>service.foregroundModel({mode,commandId:randomUUID(),storageScope:'scope',model}),setConnectGate:g=>connectGate=g,setPersistGate:g=>persistGate=g,setConnectError:e=>connectError=e,current:()=>saved.get(mode)}
}

export {fixture as serviceFixture}
