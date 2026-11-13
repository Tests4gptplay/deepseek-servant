// Production drafts -> byte-upload client -> registered HTTP handler -> actual
// Service/connection/attachment/transaction/RemoteGitRepository implementations.
// SDK dependencies are real. Authenticated route delivery and native Git I/O are
// controlled ports backed by temporary real Git objects and update-ref exact CAS.
// This is not real GitHub, Dulwich wire transport, desktop UI or model acceptance.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, devNull } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
const { FrameworkService } = await import(new URL('framework/service.ts', sourceRoot))
const { FrameworkConversation } = await import(new URL('framework/conversation.ts', sourceRoot))
const { installFrameworkTransport } = await import(new URL('framework/transport.ts', sourceRoot))
const { ConversationAttachmentDrafts, uploadConversationAttachment } = await import(new URL('framework/client-attachments.ts', sourceRoot))
const { attachmentManifestPath } = await import(new URL('framework/conversation-attachments.ts', sourceRoot))
const { openFrameworkStorage } = await import(new URL('framework/connection.ts', sourceRoot))
const { RemoteGitRepository } = await import(new URL('experimental/private-git/remote-git-repository.ts', sourceRoot))
const { GitBackendError } = await import(new URL('experimental/private-git/git-object-backend.ts', sourceRoot))
const { GitFiles } = await import(new URL('framework/transactions.ts', sourceRoot))
const { SessionGitOperations } = await import(new URL('framework/git-authority.ts', sourceRoot))
const { createRequestLifecycle } = await import(new URL('client/request-lifecycle.ts', sourceRoot))
const { Context } = await import('@deepseek-ai/cordis')
const ts = await import('typescript')
const scratchRoot = mkdtempSync(join(tmpdir(), 'dss-git-attachment-parallel-'))
const results = [], fixtures = []
function gate() { let release; const promise=new Promise(r=>{release=r}); return {promise,release} }
const tick=()=>new Promise(setImmediate)
// Test deadline only, never a product timeout or concurrency limit.
async function waitFor(predicate) { const until=Date.now()+5000; while(!predicate()){ if(Date.now()>until)throw Error('Fixture condition did not settle'); await tick() } }
const stored=()=>{ const values=new Map();return {get:async key=>structuredClone(values.get(key)),set:async(key,value)=>{values.set(key,structuredClone(value))},delete:async key=>{values.delete(key)},list:async(prefix='')=>[...values].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)}))} }
const defaults={name:'Fixture',userName:'fixture',localDirectory:'/unused',ownerRepo:'fixture/project',repositoryDirectory:'dss-coop',collaborationId:'upload-parallel',workerSeats:1,workspace:'/fixture'}
const settings={mode:'git',ownerRepo:defaults.ownerRepo,repositoryDirectory:defaults.repositoryDirectory,workerSeats:1}
const credentials={resolve:async()=>({value:'unused-fixture',source:'fixture'})}
const clientSource=readFileSync(new URL('client.tsx',sourceRoot),'utf8'),ast=ts.createSourceFile('client.tsx',clientSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),resetStatements=[]
function inspect(node){if(ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(ast)==='ctx.effect'&&node.getText(ast).includes("ctx.on('connection/reset', requests.reset)"))resetStatements.push(node.getText(ast));ts.forEachChild(node,inspect)}
inspect(ast);assert.equal(resetStatements.length,1)
const wireReset=new Function('ctx','requests',ts.transpileModule(resetStatements[0],{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)
function gitFixture(growth=1_000_000) {
  const root=mkdtempSync(join(scratchRoot,'git-case-')), path=join(root,'objects.git')
  execFileSync('git',['init','--bare','--quiet',path])
  const git=(args,input)=>execFileSync('git',['--git-dir='+path,...args],{input,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:devNull,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},stdio:['pipe','pipe','pipe']})
  const blob=text=>git(['hash-object','-t','blob','-w','--stdin'],Buffer.from(text)).toString().trim()
  const blobs=['a','b','c'].map(letter=>blob(letter.repeat(8200)))
  const inner=git(['mktree'],Buffer.from(blobs.map((id,i)=>`100644 blob ${id}\t${String.fromCharCode(97+i)}.txt\n`).join(''))).toString().trim()
  const tree=git(['mktree'],Buffer.from(`040000 tree ${inner}\tdss-coop\n`)).toString().trim()
  const initial=git(['commit-tree',tree],Buffer.from('Initial fixture\n')).toString().trim();git(['update-ref','refs/heads/main',initial])
  const head=()=>git(['rev-parse','refs/heads/main']).toString().trim()
  const events=[], backends=[];const trace={root,events};results.push(trace);let hook,afterPush,loseAck=false,failResolution=false
  class Backend {
    closed=false;ids=new Set();lifetime={}; constructor(channel,lifetime){this.channel=channel;if(lifetime)this.lifetime=lifetime;backends.push(this);this.number=backends.length}
    async ready(){}
    async release(){if(!this.closed){this.closed=true;events.push({kind:'release',channel:this.channel,backend:this.number})}}
    async storageBytes(){return [...this.ids].reduce((n,id)=>n+Number(git(['cat-file','-s',id])),0)}
    metadata(id){this.ids.add(id); const commit=git(['cat-file','commit',id]).toString(), root=commit.match(/^tree (\w+)/)[1]; const visit=tree=>{this.ids.add(tree); for(const row of git(['ls-tree','-z',tree]).toString().split('\0').filter(Boolean)){const m=row.match(/^\d+ (\w+) (\w+)\t/);if(m[1]==='tree')visit(m[2])}};visit(root);return root}
    async replacement(roots,signal,selected){signal.throwIfAborted();const next=new Backend(this.channel,this.lifetime);const copied=roots.map(row=>({head:row.head,tree:next.metadata(row.head)}));for(const id of selected??[])if(this.ids.has(id))next.ids.add(id);events.push({kind:'replacement',channel:this.channel,from:this.number,to:next.number,selected:[...selected??[]]});return{transport:next,objects:next.ids.size,packBytes:0,rawBytes:await next.storageBytes(),roots:copied}}
    async execute(command,{signal,input}){
      signal.throwIfAborted();if(this.closed)throw new GitBackendError('fatal','Closed tracked fixture')
      const event={kind:'operation',channel:this.channel,backend:this.number,op:command.op,id:command.id};events.push(event)
      if(hook)await hook(command,signal,this)
      signal.throwIfAborted()
      if(command.op==='fetchHead'){if(failResolution)throw new GitBackendError('transport','Controlled read outage');const h=head();this.metadata(h);return Buffer.from(h)}
      if(command.op==='fetchMetadata'){this.metadata(command.revision);return Buffer.alloc(0)}
      if(command.op==='ensureObjects'){for(const id of command.ids)this.ids.add(id);return command.kind==='commit'?git(['rev-list','--max-count='+String(command.commitDepth??1),...command.ids]):Buffer.alloc(0)}
      if(command.op==='readObject')return git(['cat-file',command.kind,command.id])
      if(command.op==='readTree')return git(['ls-tree','-z',command.id])
      if(command.op==='writeBlob'){const id=blob(input);this.ids.add(id);return Buffer.from(id)}
      if(command.op==='writeTree'){const id=git(['mktree','-z'],input).toString().trim();this.ids.add(id);return Buffer.from(id)}
      if(command.op==='writeCommit'){
        const message=String(input).replace(/\n?$/,'\n');const id=git(['commit-tree',command.tree,...command.parent?['-p',command.parent]:[]],Buffer.from(message)).toString().trim();this.ids.add(id)
        return Buffer.from(JSON.stringify({id,tree:command.tree,parents:command.parent?[command.parent]:[],message,timestamp:command.timestamp}))
      }
      if(command.op==='push'){try{git(['update-ref',command.ref,command.commit,command.expected||'0'.repeat(40)])}catch{event.rejected=true;throw new GitBackendError('stale','Real CAS conflict',{advertisedHead:head()})}if(afterPush)await afterPush(command,signal,this);if(loseAck){loseAck=false;failResolution=true;throw new GitBackendError('transport','Real CAS accepted, controlled reply loss')}return Buffer.alloc(0)}
      throw Error('Unhandled fixture command')
    }
  }
  const binding={ownerRepo:'fixture/project',branch:'main',repositoryDirectory:'dss-coop'}
  const makeRepository=(bound=()=>binding,tokens=async()=>({value:'unused-fixture',source:'fixture'}),options={})=>{
    const repo=new RemoteGitRepository(bound,tokens,{...options,cacheGrowthBytes:growth,remoteUrl:()=> 'http://127.0.0.1:1/unused.git',inspectAuthority:async()=>({identity:{id:1,login:'fixture'},repository:{id:1,fullName:'fixture/project',branch:'main',private:true,permissions:{pull:true,push:true,admin:false}}})})
    const original=repo.newCache.bind(repo);repo.newCache=(channel,transport)=>original(channel,transport??new Backend(channel))
    return repo
  }
  const repo=makeRepository()
  const files=new GitFiles(repo,new SessionGitOperations())
  return {root,repo,files,events,backends,blobs,makeRepository,git,head,setHook(value){hook=value},setAfterPush(value){afterPush=value},loseAck(){loseAck=true},allowReads(){failResolution=false},save(name){trace.name=name;trace.assertionsCompleted=true}}
}

async function fixture(){
  const f=gitFixture(),storage=stored()
  const connection=await openFrameworkStorage(settings,{storage,credentials,repositoryFactory:(binding,tokens,options)=>f.makeRepository(binding,tokens,options)})
  const owner={mode:'git',collaborationId:defaults.collaborationId,storageScope:connection.scope}
  const service=new FrameworkService({logger:()=>({warn(){},error(){}})},storage,defaults)
  service.saved.set('git',{revision:'fixture',settings:{...defaults}})
  const conversation=new FrameworkConversation(connection.files,connection.transactions,owner)
  service.accesses.set('git',Promise.resolve({connection,conversation}))
  const routes=new Map(),effects=[]
  // Controlled Host registration carrier; invoke the production registered handler.
  const ctx={inject(_names,run){run({connection:{fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}}},effect(fn){effects.push(fn())}});return{dispose:async()=>{for(const stop of effects)await stop?.()}}}}
  const disposeTransport=installFrameworkTransport(ctx,service)
  const route=routes.get('/api/deepseek-servant-framework/upload-attachment')
  assert.deepEqual([route.methods,route.requestBody],[['POST'],'streaming'])
  const calls=[],holds=new Map(),responses=new Map(),pending=new Set(),requests=createRequestLifecycle(),resetContext=new Context()
  wireReset(resetContext,requests)
  const fetch=async(url,options)=>{
    const metadata=JSON.parse(new URL(url,'https://controlled.test/').searchParams.get('metadata'))
    const call={metadata,body:options.body,signal:options.signal};calls.push(call)
    const bytes=options.body.stream(),reader=bytes.getReader(),hold=holds.get(metadata.name)
    const stream=new ReadableStream({async pull(controller){
      if(hold)await hold.promise
      try{options.signal.throwIfAborted();const next=await reader.read();if(next.done)controller.close();else controller.enqueue(next.value)}catch(error){controller.error(error)}
    },cancel(reason){return reader.cancel(reason)}})
    const request=new Request(new URL(url,'https://controlled.test/'),{...options,body:stream,duplex:'half'})
    const work=route.fetch(request).then(async response=>{call.status=response.status;if(responses.has(metadata.name))await responses.get(metadata.name).promise;return response})
    pending.add(work);void work.finally(()=>pending.delete(work)).catch(()=>{})
    return work
  }
  const api={uploadAttachment:(metadata,file,signal)=>requests.request(signal,owned=>uploadConversationAttachment(fetch,metadata,file,owned))}
  const drafts=new ConversationAttachmentDrafts(api)
  Object.assign(f,{storage,connection,owner,service,conversation,api,drafts,calls,holds,responses,requests,resetContext,pending})
  f.present=async row=>{
    assert.equal(row.state,'ready');const ref=row.reference
    assert.deepEqual(f.git(['show','refs/heads/main:dss-coop/'+ref.path]),Buffer.from(await row.file.arrayBuffer()))
    assert.deepEqual(JSON.parse(f.git(['show','refs/heads/main:dss-coop/'+attachmentManifestPath(ref)])),ref)
  }
  f.names=()=>f.git(['ls-tree','-r','--name-only','refs/heads/main']).toString().trim().split('\n')
  f.noReceipts=()=>assert.equal(f.names().some(name=>name.includes('command-receipts/')),false)
  f.close=async()=>{for(const h of [...holds.values(),...responses.values()])h.release();requests.dispose();await Promise.allSettled([...pending]);f.setHook(undefined);f.setAfterPush(undefined);f.allowReads();await disposeTransport();await connection.close();await f.repo.releaseCache()}
  fixtures.push(f);return f
}
const file=(name,body=name)=>new File([body],name,{type:'text/plain'})
const ready=(f,scope='conversation')=>waitFor(()=>f.drafts.selections(scope).every(row=>row.state==='ready'))

test('multi-select: a held first body does not delay the next selected original',async()=>{
  const f=await fixture(),held=gate();f.holds.set('first.txt',held)
  f.drafts.add('conversation',f.owner,[file('first.txt'),file('second.txt')])
  try{
    await waitFor(()=>f.calls.length>0)
    if(process.env.DSS_EXPECT_SERIAL==='1'){
      for(let i=0;i<30;i++)await tick()
      assert.equal(f.calls.length,1);assert.equal(f.drafts.selections('conversation')[1].state,'queued')
      results.push({baseline:'second request has not started while first body is held'})
    }else{
      await waitFor(()=>f.drafts.selections('conversation')[1].state==='ready')
      assert.equal(f.calls.length,2);assert.equal(f.drafts.selections('conversation')[0].state,'uploading')
      await f.present(f.drafts.selections('conversation')[1])
    }
  }finally{held.release()}
  await ready(f);for(const row of f.drafts.selections('conversation'))await f.present(row)
  assert.deepEqual(f.drafts.selections('conversation').map(r=>r.file.name),['first.txt','second.txt']);f.noReceipts()
})

test('multi-select: simultaneous real Git CAS publications retry and retain both originals',async()=>{
  const f=await fixture(),both=gate();let pushes=0
  f.setHook(async command=>{if(command.op==='push'&&++pushes<=2){if(pushes===2)both.release();await both.promise}})
  try{
    f.drafts.add('conversation',f.owner,[file('a.txt'),file('b.txt')]);await ready(f)
    assert.ok(f.events.some(e=>e.op==='push'&&e.rejected),'real update-ref rejects one expected old head')
    for(const row of f.drafts.selections('conversation'))await f.present(row)
    assert.equal(f.drafts.requests.size,0);f.noReceipts()
  }finally{both.release()}
})

test('multi-select: selecting the same content twice shares current original without duplicate or receipt',async()=>{
  const f=await fixture(),both=gate();let pushes=0
  f.setHook(async command=>{if(command.op==='push'&&++pushes<=2){if(pushes===2)both.release();await both.promise}})
  try{
    f.drafts.add('conversation',f.owner,[file('same.txt','same'),file('same.txt','same')]);await ready(f)
    const [a,b]=f.drafts.selections('conversation');assert.notEqual(a.id,b.id);assert.deepEqual(a.reference,b.reference)
    await f.present(a);assert.equal(f.names().filter(p=>p.includes('/manifests/')).length,1);f.noReceipts()
  }finally{both.release()}
})

test('remove and retry: canceled body cannot block another upload; failed row retains its original identity',async()=>{
  const f=await fixture(),held=gate();f.holds.set('remove.txt',held)
  f.drafts.add('conversation',f.owner,[file('remove.txt'),file('keep.txt')]);await waitFor(()=>f.calls.length===2)
  const removed=f.drafts.selections('conversation')[0];f.drafts.remove('conversation',removed.id);held.release()
  await ready(f);assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.drafts.selections('conversation').length,1)
  await f.present(f.drafts.selections('conversation')[0]);assert.equal(f.names().some(p=>p.endsWith('/remove.txt')),false)
  let failed=false;f.setHook(command=>{if(command.op==='writeBlob'&&!failed){failed=true;throw new GitBackendError('transport','Controlled pre-publication failure')}})
  const original=file('retry.txt');f.drafts.add('conversation',f.owner,[original]);await waitFor(()=>f.drafts.selections('conversation')[1].state==='error')
  const row=f.drafts.selections('conversation')[1],id=row.id
  f.setHook(undefined);f.drafts.retry('conversation',id);await ready(f)
  const retryCalls=f.calls.filter(c=>c.metadata.name==='retry.txt');assert.equal(retryCalls.length,2)
  assert.ok(retryCalls.every(c=>c.metadata.uploadId===id&&c.body===original));await f.present(row);f.noReceipts()
})

test('late response and navigation: completed other rows stay with their original conversation',async()=>{
  const f=await fixture(),held=gate();f.responses.set('late.txt',held)
  f.drafts.add('old-scope',f.owner,[file('late.txt'),file('early.txt')])
  try{
    await waitFor(()=>f.calls.find(c=>c.metadata.name==='late.txt')?.status===200)
    await waitFor(()=>f.drafts.selections('old-scope')[1].state==='ready')
    assert.equal(f.drafts.selections('old-scope')[0].state,'uploading')
    assert.deepEqual(f.drafts.selections('new-scope'),[])
    f.drafts.acknowledge('new-scope',[f.drafts.selections('old-scope')[1].reference]);assert.equal(f.drafts.selections('old-scope').length,2)
  }finally{held.release()}
  await ready(f,'old-scope');for(const row of f.drafts.selections('old-scope'))await f.present(row)
  f.drafts.acknowledge('old-scope',f.drafts.selections('old-scope').map(r=>r.reference));assert.deepEqual(f.drafts.selections('old-scope'),[]);f.noReceipts()
})

test('connection/reset: two in-flight rows reject independently and same-row retries inspect current targets',async()=>{
  const f=await fixture(),held=gate();f.responses.set('one.txt',held);f.responses.set('two.txt',held)
  f.drafts.add('conversation',f.owner,[file('one.txt'),file('two.txt')])
  await waitFor(()=>f.calls.length===2&&f.calls.every(c=>c.status===200))
  const ids=f.drafts.selections('conversation').map(r=>r.id),pushCount=f.events.filter(e=>e.op==='push').length
  f.resetContext.emit('connection/reset');await waitFor(()=>f.drafts.selections('conversation').every(r=>r.state==='error'))
  held.release();f.responses.clear();for(const id of ids)f.drafts.retry('conversation',id);await ready(f)
  assert.deepEqual(f.drafts.selections('conversation').map(r=>r.id),ids)
  assert.equal(f.events.filter(e=>e.op==='push').length,pushCount,'retries do not commit duplicate attachment bodies')
  for(const row of f.drafts.selections('conversation'))await f.present(row);f.noReceipts()
})

after(async()=>{
  for(const f of fixtures)await f.close()
  const report={scope:'Actual upload stack and SDK; controlled authenticated route carrier and Git CLI object backend. Real update-ref CAS, no GitHub/Dulwich wire or full desktop acceptance.',...evidence(),results}
  if(process.env.DSS_ATTACHMENT_EVIDENCE)writeFileSync(process.env.DSS_ATTACHMENT_EVIDENCE,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({scope:report.scope,fixtures:fixtures.length,actualPackages:report.actualPackages}))
  hooks.deregister();rmSync(scratchRoot,{recursive:true,force:true})
})
