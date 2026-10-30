import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { GitHubClient } from '../src/experimental/private-git/github.js'
import { GitHubRepository } from '../src/experimental/private-git/git-repository.js'
import { runGit } from '../src/experimental/private-git/vendor/git-runner.js'

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}}
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'dss-cache-ref-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const remote=join(root,'remote.git'),seed=join(root,'seed'),caches=join(root,'cache')
 await mkdir(remote);await mkdir(seed)
 const git=async(cwd:string,args:string[])=>(await runGit('git',args,{cwd})).stdout.trim()
 await git(remote,['init','--bare','--initial-branch=main','.']);await git(seed,['init','--initial-branch=main','.'])
 await writeFile(join(seed,'README.md'),'Synthetic cache-ref concurrency fixture\n');await git(seed,['add','.'])
 await git(seed,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Initial fixture']);await git(seed,['push',remote,'HEAD:main'])
 const tokens=async()=>({value:'synthetic-local-fixture',source:'fixture'})
 const client=new GitHubClient(tokens,async url=>{const path=new URL(url).pathname;if(path==='/user')return Response.json({id:1,login:'fixture'});if(path==='/repos/example/private')return Response.json({id:77,full_name:'example/private',private:true,default_branch:'main',permissions:{pull:true,push:true,admin:true}});throw new Error('No external route permitted: '+path)})
 const initialized=new Set<string>()
 const make=async(instanceId:string)=>{
  const cwd=join(caches,createHash('sha256').update('example/private/Coop/'+instanceId).digest('hex').slice(0,24))
  if(!initialized.has(cwd)){await mkdir(cwd,{recursive:true});await git(cwd,['init','--bare','.']);await git(cwd,['remote','add','origin',remote]);initialized.add(cwd)}
  return new GitHubRepository(client,()=>({ownerRepo:'example/private',repositoryDirectory:'Coop',instanceId}),tokens,caches)
 }
 return {make}
}
function track(repositories:GitHubRepository[]){
 const active=new Map<string,number>(),maximum=new Map<string,number>(),calls:Array<{cwd:string;command:string}>=[]
 let hook:((e:any,args:string[])=>Promise<void>)|undefined
 for(const repository of repositories){const raw=(repository as any).git.bind(repository);(repository as any).git=async(e:any,args:string[],env:any)=>{
  const ref=args[0]==='fetch'||args[0]==='push'||args[0]==='rev-parse'&&args[1]?.startsWith('refs/remotes/')
  if(ref){active.set(e.cwd,(active.get(e.cwd)??0)+1);maximum.set(e.cwd,Math.max(maximum.get(e.cwd)??0,active.get(e.cwd)!));calls.push({cwd:e.cwd,command:args[0]})}
  try{await hook?.(e,args);return await raw(e,args,env)}finally{if(ref)active.set(e.cwd,active.get(e.cwd)!-1)}
 }}
 return {maximum,calls,hold(command:string){const entered=deferred(),release=deferred();let held=false;hook=async(_e,args)=>{if(!held&&args[0]===command){held=true;entered.resolve();await release.promise}};return {entered:entered.promise,release:()=>{hook=undefined;release.resolve()}}}}
}

test('cache refs: concurrent adapters serialize actual fetch/readback and push in one cache, not unrelated directories',async t=>{
 const {make}=await fixture(t),a=await make('same'),b=await make('same'),other=await make('other')
 await a.snapshot();await b.snapshot();await other.snapshot()
 const env=await (b as any).environment(),observed=track([a,b,other])
 const heldFetch=observed.hold('fetch'),first=a.snapshot();await heldFetch.entered
 const second=(b as any).fetch(env);await setImmediate()
 // An unrelated cache has its own refs and must finish while this one is held.
 const independent=await other.snapshot();assert.ok(independent.head)
 heldFetch.release();await Promise.all([first,second])
 const base=await a.snapshot(),heldPush=observed.hold('push')
 const writing=a.commit(base,[{path:'dss-coop/result.txt',content:'Actual committed result'}],'Write fixture');await heldPush.entered
 const reading=(b as any).fetch(env);await setImmediate();heldPush.release();await Promise.all([writing,reading])
 assert.ok([...observed.maximum.values()].every(count=>count===1),'same-cache fetch/push/readback commands never overlap')
 assert.equal(await b.read(await b.snapshot(),'dss-coop/result.txt'),'Actual committed result')
 assert.ok(observed.calls.some(call=>call.command==='push'))
})

test('cache refs: an aborted waiter does not execute or unlock its predecessor, and following work still progresses',async t=>{
 const {make}=await fixture(t),a=await make('same'),b=await make('same'),next=await make('same')
 await a.snapshot();await b.snapshot();await next.snapshot()
 const envB=await (b as any).environment(),envNext=await (next as any).environment(),observed=track([a,b,next])
 const hold=observed.hold('fetch'),running=a.snapshot();await hold.entered
 const cancelled=(b as any).fetch(envB),rejected=assert.rejects(cancelled,error=>(error as Error).name==='AbortError')
 b.cancel();await rejected
 const pending=(next as any).fetch(envNext);await setImmediate()
 assert.equal(observed.calls.filter(call=>call.command==='fetch').length,1,'abort does not release another adapter\'s held ref operation')
 hold.release();await Promise.all([running,pending]);await b.snapshot()
 assert.ok([...observed.maximum.values()].every(count=>count===1))
 assert.equal(observed.calls.filter(call=>call.command==='fetch').length,3,'cancelled waiter never runs; a fresh nonaborted operation succeeds')
})

test('cache refs: a real failed Git operation releases the queue without masking its error',async t=>{
 const {make}=await fixture(t),a=await make('same'),b=await make('same')
 await a.snapshot();await b.snapshot()
 const e=await (a as any).environment(),raw=(a as any).git.bind(a)
 let once=true;(a as any).git=async(env:any,args:string[],extra:any)=>{if(once&&args[0]==='fetch'){once=false;return raw(env,['fetch','nonexistent-fixture-remote'],extra)}return raw(env,args,extra)}
 await assert.rejects(a.snapshot(),/nonexistent-fixture-remote/)
 assert.ok((await b.snapshot()).head);assert.ok((await a.snapshot()).head)
})
