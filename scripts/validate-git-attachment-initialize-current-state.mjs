// Real service connection acquisition -> attachment initialize -> Transactions ->
// GitFiles -> RemoteGitRepository -> real Git objects and update-ref CAS.
// Authentication, object transport and post-initialization role startup are test
// ports. No HTTP/GitHub/Dulwich or model execution, and no injected failures.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
process.env.DSS_AUDIT_SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const { gitFixture } = await import('./test-support/helper-consume-git-fixture.mjs')
const connectionURL = new URL('framework/connection.ts', sourceRoot).href
const bridgeKey = '__dssMarkerInitializationPorts'
const wrappedConnection = `export * from ${JSON.stringify(connectionURL)};
import {openFrameworkConnection as actual,openFrameworkStorage as storage} from ${JSON.stringify(connectionURL)};
export const openFrameworkConnection=(settings,dependencies)=>globalThis[${JSON.stringify(bridgeKey)}].open(actual,settings,dependencies);
export const openFrameworkStorage=(settings,dependencies)=>globalThis[${JSON.stringify(bridgeKey)}].open(storage,settings,dependencies);`
const runtimeProbe = `export class FrameworkRoleRuntime {
  constructor(){globalThis[${JSON.stringify(bridgeKey)}].runtimeConstructed++;}
  setForegroundModel(){} async start(){globalThis[${JSON.stringify(bridgeKey)}].runtimeStarted++;}
  async dispose(){} refreshSkills(){} executionViews(){return []}
}`
const bridge = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === new URL('framework/service.ts', sourceRoot).href) {
    if (specifier === './connection.js') return { url:'data:text/javascript,'+encodeURIComponent(wrappedConnection),shortCircuit:true }
    if (specifier === './role-runtime.js') return { url:'data:text/javascript,'+encodeURIComponent(runtimeProbe),shortCircuit:true }
  }
  return next(specifier,context)
} })
const { FrameworkService } = await import(new URL('framework/service.ts',sourceRoot))
const { ConversationAttachments, attachmentManifestPath } = await import(new URL('framework/conversation-attachments.ts',sourceRoot))
const { FrameworkTransactions } = await import(new URL('framework/command-transactions.ts',sourceRoot))
const { withOperationChannel, withSnapshot } = await import(new URL('framework/transactions.ts',sourceRoot))
const root = await mkdtemp(join(tmpdir(),'dss-marker-current-'))
const fixtures=[],checks=[], traces=[]
const legacy = process.env.DSS_INIT_LEGACY === '1'
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name)}
const storage=()=>{const rows=new Map();return{get:async k=>structuredClone(rows.get(k)),set:async(k,v)=>{rows.set(k,structuredClone(v))},delete:async k=>{rows.delete(k)},list:async(p='')=>[...rows].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value)}))}}
const scope={mode:'git',collaborationId:'marker-current'}
const marker='conversations/git/marker-current/attachments/.dss-attachments.json'
const markerBody='{"version":1,"purpose":"conversation-attachment-originals"}\n'
const receipt=path=>path.includes('/command-receipts/')||path.includes('/.command-receipts/')
function fixture(name,reopen=false,directory=join(root,name+'.git')){
  const f=gitFixture(directory,'sha1',async()=>{},reopen)
  f.directory=directory;f.records=storage();f.tx=new FrameworkTransactions(f.files,f.records,'marker-current');f.connections=[]
  f.attachments=new ConversationAttachments(f.files,f.tx,scope);f.calls=[];f.reads=[]
  const commit=f.repo.commitPrepared.bind(f.repo)
  f.repo.commitPrepared=async(...args)=>{f.calls.push({paths:args[1].map(c=>c.path),operationId:args[3].id});return commit(...args)}
  for(const key of ['read','readBytes']){const read=f.repo[key].bind(f.repo);f.repo[key]=async(s,p)=>{f.reads.push(p);return read(s,p)}}
  f.names=()=>f.git(['ls-tree','-r','--name-only','refs/heads/main']).toString().trim().split('\n').filter(Boolean)
  f.read=path=>f.git(['show','refs/heads/main:dss-coop/'+path]).toString()
  f.publish=changes=>withOperationChannel(f.files,'write',()=>withSnapshot(f.files,s=>f.files.commit(s,changes,'Fixture explicit file edit')))
  f.initialize=()=>withOperationChannel(f.files,'write',()=>f.attachments.initialize())
  f.markerCalls=()=>f.calls.filter(c=>c.paths.includes('dss-coop/'+marker))
  f.newMarkerOnly=label=>{
    check(label+': marker-only publication',f.markerCalls().at(-1).paths.filter(p=>!receipt(p)),['dss-coop/'+marker])
    check(label+': durable initialization receipt',f.markerCalls().at(-1).paths.some(receipt),legacy)
  }
  fixtures.push(f);return f
}
async function close(f){for(const c of f.connections.splice(0))await c.close();await f.tx.closeGitSession(new Error('Fixture closes'));f.files.operations.close();await f.repo.releaseCache()}
try{
  const first=fixture('new')
  await first.initialize();check('missing marker initialized',first.read(marker),markerBody);first.newMarkerOnly('missing')
  check('no marker read after successful publication',first.reads.filter(p=>p==='dss-coop/'+marker).length,2)
  check('no residual transport attempts after confirmed initialization',await first.files.operations.list(),[])
  const count=first.calls.length,reads=first.reads.length
  await first.initialize();check('existing marker no write',first.calls.length,count)
  check('existing marker one exact read',first.reads.slice(reads),['dss-coop/'+marker])
  traces.push({case:'missing-and-existing',calls:first.calls,reads:first.reads,names:first.names()})
  const directory=first.directory;await close(first)
  const reopened=fixture('reopened',true,directory);await reopened.initialize()
  check('reconnect observes marker without a new command',reopened.calls.length,0)
  for(const content of ['custom marker bytes\n','']){
    await reopened.publish([{path:marker,content}]);const before=reopened.calls.length
    await reopened.initialize();check('preserve existing '+JSON.stringify(content),reopened.read(marker),content)
    check('preserve does not publish '+JSON.stringify(content),reopened.calls.length,before)
  }
  await reopened.publish([{path:marker,content:null}]);await reopened.initialize()
  check('explicitly deleted default marker repaired',reopened.read(marker),markerBody);reopened.newMarkerOnly('repair')
  const prior=fixture('prior-receipt')
  // Use the prior initializer's actual default transaction contract, not a
  // guessed receipt format. This fixture owns no user's historical data.
  await prior.tx.run('conversation-attachments/initialize/'+randomUUID(),{scope},
    {reevaluate:true,gitEmptyResult:'observation-only',readPlan:{files:[marker]}},s=>prior.attachments.markerChanges(s))
  const oldPath=prior.names().find(receipt),oldBytes=prior.git(['show','refs/heads/main:'+oldPath])
  await prior.publish([{path:marker,content:null}]);const oldCount=prior.names().filter(receipt).length
  await prior.initialize();check('prior receipt cannot suppress missing-marker repair',prior.read(marker),markerBody)
  check('prior receipt bytes retained without blanket deletion',prior.git(['show','refs/heads/main:'+oldPath]),oldBytes)
  check('repair creates no further receipt in candidate',prior.names().filter(receipt).length,oldCount+(legacy?1:0))
  const attach=fixture('upload')
  const bytes=Buffer.from('Original remains independent of the directory marker.\n')
  const ref=await attach.attachments.writeBytes({...scope,uploadId:'new-original',name:'original.txt',mimeType:'text/plain',bytes:bytes.length},bytes)
  check('upload independently initializes marker',attach.read(marker),markerBody)
  check('upload stores exact manifest',JSON.parse(attach.read(attachmentManifestPath(ref))),ref)
  await attach.publish([{path:marker,content:null}]);const start=attach.calls.length
  check('attachment read requires original and manifest, not marker',Buffer.from((await attach.attachments.read(ref)).data),bytes)
  check('attachment read does not reinitialize marker',attach.calls.length,start)
  await attach.initialize();check('explicit initialization after marker deletion preserves original',Buffer.from((await attach.attachments.read(ref)).data),bytes)
  attach.newMarkerOnly('upload-directory-repair')
  // Two ordinary connections may acquire the same shared space together. Starting
  // both calls concurrently uses real CAS; no force-conflict/error override.
  const concurrent=fixture('concurrent'),peer=fixture('peer',true,concurrent.directory)
  await Promise.all([concurrent.initialize(),peer.initialize()])
  check('concurrent callers converge on current marker',concurrent.read(marker),markerBody)
  check('concurrent initialization persists only one marker',concurrent.names().filter(p=>p==='dss-coop/'+marker).length,1)
  check('concurrent calls never create a replacement receipt',concurrent.names().some(receipt),legacy)
  traces.push({case:'concurrent',calls:[...concurrent.calls,...peer.calls],events:[...concurrent.events,...peer.events]})
  const serviceFixture=fixture('service')
  const defaults={name:'Fixture',userName:'A',localDirectory:'/unused',ownerRepo:'fixture/recovery',repositoryDirectory:'dss-coop',collaborationId:scope.collaborationId,workerSeats:0,workspace:root}
  const ports={runtimeConstructed:0,runtimeStarted:0,open:async(actual,settings,dependencies)=>{
    const connection=await actual(settings,{...dependencies,storage:serviceFixture.records,credentials:{resolve:async()=>({value:'unused-fixture',source:'fixture'})},repositoryFactory:()=>serviceFixture.repo})
    serviceFixture.connections.push(connection);return connection
  }}
  globalThis[bridgeKey]=ports
  const service=new FrameworkService({workspaceRegistry:{create:async path=>({id:'fixture-workspace',path})},logger:()=>({warn(){},error(){}})},serviceFixture.records,defaults)
  service.saved.set('git',{revision:'fixture-settings',settings:defaults})
  await service.access('git')
  check('real Service.access read-only acquisition does not publish marker',serviceFixture.markerCalls().length,0)
  check('read-only acquisition has no marker directory file',serviceFixture.names().includes('dss-coop/'+marker),false)
  check('read-only acquisition does not start runtime',ports.runtimeConstructed,0)
  const active=await service.open('git')
  check('real Service.open publishes its acquired connection',service.running.get('git'),active)
  check('post-initialization runtime boundary reached once',[ports.runtimeConstructed,ports.runtimeStarted],[1,1])
  check('Service.open marker exists before returned running owner',serviceFixture.read(marker),markerBody)
  serviceFixture.newMarkerOnly('Service.open')
  check('real connection member observation retained',active.resources.some(r=>r.instanceUUID===active.connection.registration.instanceUUID),true)
  await service.gitUpgrades.get(active)?.work
  service.running.delete('git');await close(serviceFixture)
  let localCalls=0
  const local=new ConversationAttachments(new Proxy({},{get(){localCalls++;throw Error('Local initializer should not access Git files')}}),new Proxy({},{get(){localCalls++;throw Error('Local initializer should not access transactions')}}),{mode:'local',collaborationId:scope.collaborationId})
  await local.initialize();check('Local initialization remains no-I/O',localCalls,0)
  console.log(JSON.stringify({status:'passed',legacy,assertions:checks.length,checks,traces,...evidence(),limits:[
    'Real Service.open and openFrameworkConnection registration/member observation/close; role runtime lifecycle is an explicit post-initialization probe, not full successful native Host execution.',
    'Real RemoteGitRepository, GitFiles, FrameworkTransactions, Git CLI objects and exact update-ref CAS; credentials and object transport are explicit fixtures, no GitHub network or Dulwich wire.',
    'No forced UNKNOWN, fake transport failure, modified resolver or rollback. Concurrent calls exercise supported shared-space entry; no claim of a field incident.',
    'Legacy mode records unchanged baseline behavior; strict mode on unchanged baseline must reject durable marker receipts.'
  ]},null,2))
}finally{
  for(const f of fixtures)await close(f)
  delete globalThis[bridgeKey];bridge.deregister();hooks.deregister();await rm(root,{recursive:true,force:true})
}
