import './test-support/dsh-sdk-runtime.mjs'
// Actual production GitFiles + FrameworkTransactions + FrameworkKnowledge.
// Controlled Repository boundary only: no real Git network/DSH acceptance claim.
import test from 'node:test'
import assert from 'node:assert/strict'
const {FrameworkKnowledge}=await import('../src/framework/knowledge.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {GitFiles,FilesOutcomeUnknownError}=await import('../src/framework/transactions.ts')
const {SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {GitCommitOutcomeUnknownError}=await import('../src/experimental/private-git/contracts.ts')
import {Repository,put,head} from './test-support/controlled-git/repository.mjs'
const sourcePath='skills/assistant/workspace/method/record.json'
const target='skills/assistant/workspace/method/SKILL.md'
const controls='technical/skills/controls.json'
const native='---\nname: method\ndescription: Native target\n---\nNative body must not be overwritten\n'
const date='2026-11-09T00:00:00.000Z'
function fixture(kind){
 const repo=new Repository(),files=new GitFiles(repo,new SessionGitOperations()),tx=new FrameworkTransactions(files,{},'g09-unknown-closure')
 const original={schemaVersion:1,kind:'skill',skillId:'method',scope:{assistantId:'assistant',workspaceId:'workspace'},revision:1,activeVersion:1,versions:[{version:1,status:'active',body:'original retained method'}]}
 put(repo,sourcePath,original);put(repo,target,native);head(repo)
 const input=kind==='edit'?{path:sourcePath,expectedRevision:'old-ui-selection',title:'Original draft title',description:'Original draft description',applicability:'Original applicability',body:'Original draft body',createdAt:date}:{path:sourcePath,expectedRevision:'old-ui-selection',status:'disabled',reason:'Original user choice',updatedAt:date}
 const id='original-'+kind,command='knowledge-'+kind+':'+id
 let builds=0,resolutions=0,notices=0
 const knowledge=new FrameworkKnowledge(files,tx,()=>notices++,{async resolve(path){assert.equal(path,sourcePath);resolutions++;return{convertedPath:target}}})
 const call=arguments_=>kind==='edit'?knowledge.edit(id,arguments_??input):knowledge.setStatus(id,arguments_??input)
 const seed=()=>tx.run(command,input,{reevaluate:true},async snapshot=>{
  builds++
  const record=JSON.parse(await files.read(snapshot,sourcePath))
  // Seed the already-submitted historical effects, not a new production writer.
  // The upgrade must resolve these original captured bytes and their receipt.
  if(kind==='edit')record.versions.push({version:2,status:'candidate',body:input.body,title:input.title,description:input.description,applicability:input.applicability})
  else{record.versions[0].status=input.status;delete record.activeVersion}
  record.revision++
  return[{path:sourcePath,content:JSON.stringify(record)+'\n'},...(kind==='status'?[{path:controls,content:JSON.stringify({version:1,entries:{[sourcePath]:{status:input.status,reason:input.reason}}})+'\n'}]:[])]
 })
 const observed=[];const resolve=repo.resolveCommit.bind(repo)
 repo.resolveCommit=async operation=>{observed.push(operation.id);return resolve(operation)}
 const body=path=>repo.bodies.get('dss-coop/'+path)
 return{repo,files,tx,input,call,seed,body,observed,counts:()=>({builds,resolutions,notices})}
}
async function seedUnknown(f){
 f.repo.outcomes.push({error:new GitCommitOutcomeUnknownError('Controlled lost original response')})
 await assert.rejects(f.seed(),FilesOutcomeUnknownError)
 assert.equal(f.repo.calls.length,1);assert.equal(f.counts().builds,1);assert.equal(f.counts().resolutions,0)
 return f.repo.calls[0]
}
function confirmOriginalAtRemote(f,attempt){
 // The server accepted that exact captured operation while its response was
 // lost. Apply its captured atomic payload once, without another client send.
 for(const change of attempt.changes){if(change.content===null)f.repo.bodies.delete(change.path);else f.repo.bodies.set(change.path,change.content??Buffer.from(change.bytes))}
 head(f.repo);f.repo.accepted.set(attempt.operation.id,f.repo.head)
}
for(const kind of ['edit','status']){
 test(kind+': unresolved UNKNOWN stays original and does not resolve conversion',async()=>{
  const f=fixture(kind),original=f.body(sourcePath),attempt=await seedUnknown(f)
  const before=f.observed.length
  await assert.rejects(f.call(),FilesOutcomeUnknownError)
  assert.ok(f.observed.length>before);assert.equal(f.observed.at(-1),attempt.operation.id)
  assert.equal(f.repo.calls.length,1);assert.deepEqual(f.counts(),{builds:1,resolutions:0,notices:0})
  assert.equal(f.body(sourcePath),original);assert.equal(f.body(target),native);assert.equal(f.body(controls),undefined)
  await assert.rejects(f.call({...f.input,expectedRevision:'changed arguments'}),/identity cannot be reused/)
  assert.equal(f.repo.calls.length,1);assert.equal(f.counts().resolutions,0)
 })
 test(kind+': UNKNOWN then committed returns original receipt without new target operation',async()=>{
  const f=fixture(kind),attempt=await seedUnknown(f)
  confirmOriginalAtRemote(f,attempt)
  const committed=new Map(f.repo.bodies),commit=f.repo.head,before=f.observed.length
  const result=await f.call()
  assert.equal(result.replay,true);assert.equal(result.revision,commit);assert.equal(result.operationId,attempt.operation.id)
  assert.equal('convertedPath' in result,false)
  assert.ok(f.observed.length>before);assert.equal(f.observed.at(-1),attempt.operation.id)
  assert.equal(f.repo.calls.length,1);assert.deepEqual(f.counts(),{builds:1,resolutions:0,notices:1})
  assert.deepEqual(f.repo.bodies,committed);assert.equal(f.body(target),native)
  // A later replay with no in-memory UNKNOWN handle uses the same atomic
  // receipt instead of running the new legacy transition builder.
  const again=await f.call();assert.equal(again.replay,true);assert.equal(again.revision,commit)
  assert.equal(f.repo.calls.length,1);assert.equal(f.counts().resolutions,0);assert.deepEqual(f.repo.bodies,committed)
 })
 test(kind+': absent original command transitions only after real transaction builder entry',async()=>{
  const f=fixture(kind),before=new Map(f.repo.bodies)
  let entered=0
  const run=f.tx.run.bind(f.tx)
  f.tx.run=(id,input,options,builder)=>run(id,input,options,async(...args)=>{entered++;return builder(...args)})
  const result=await f.call()
  assert.equal(entered,1);assert.deepEqual(result,{saved:false,convertedPath:target})
  assert.equal(f.counts().resolutions,1);assert.equal(f.repo.calls.length,0);assert.equal(f.observed.length,0)
  assert.deepEqual(f.repo.bodies,before);assert.equal(f.body(target),native)
 })
}
