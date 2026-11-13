// Actual FrameworkService upload, client drafts/reset and transaction methods.
// Access/config, HTTP delivery and exact-H Git transport are controlled ports.
// This is not a real GitHub/desktop/model or remote-history-resolver acceptance test.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { Repository, put, head } from './test-support/controlled-git/repository.mjs'
const { FrameworkService } = await import(new URL('framework/service.ts', sourceRoot))
const { ConversationAttachments, attachmentManifestPath } = await import(new URL('framework/conversation-attachments.ts', sourceRoot))
const { attachmentOriginalPath } = await import(new URL('framework/conversation-attachment-reference.ts', sourceRoot))
const { ConversationAttachmentDrafts, uploadConversationAttachment } = await import(new URL('framework/client-attachments.ts', sourceRoot))
const { createRequestLifecycle } = await import(new URL('client/request-lifecycle.ts', sourceRoot))
const { FrameworkTransactions } = await import(new URL('framework/command-transactions.ts', sourceRoot))
const { GitFiles, FilesOutcomeUnknownError } = await import(new URL('framework/transactions.ts', sourceRoot))
const { SessionGitOperations } = await import(new URL('framework/git-authority.ts', sourceRoot))
const { GitConflictError } = await import(new URL('experimental/private-git/github.ts', sourceRoot))
const { GitCommitOutcomeUnknownError } = await import(new URL('experimental/private-git/contracts.ts', sourceRoot))
const { Context } = await import('@deepseek-ai/cordis')
const ts = await import('typescript')
const tick = () => new Promise(setImmediate)
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve } }
const sha = data => createHash('sha256').update(data).digest('hex')
const owner = { mode: 'git', collaborationId: 'attachment-current-target', storageScope: 'original-repository' }
const receiptPath = path => path.includes('/command-receipts/') || path.includes('/.command-receipts/')
const fixtures = [], scenarios = []
const clientSource = readFileSync(new URL('client.tsx', sourceRoot), 'utf8')
const clientAst = ts.createSourceFile('client.tsx', clientSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const resetStatements = []
function inspect(node) {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(clientAst) === 'ctx.effect'
    && node.getText(clientAst).includes("ctx.on('connection/reset', requests.reset)")) resetStatements.push(node.getText(clientAst))
  ts.forEachChild(node, inspect)
}
inspect(clientAst)
assert.equal(resetStatements.length, 1, 'use the actual client connection/reset registration, not a recreated wire')
const wireReset = new Function('ctx', 'requests', ts.transpileModule(resetStatements[0], { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
function input(id, body = 'original', name = 'original.txt') {
  const bytes = Buffer.from(body)
  return { metadata: { ...owner, uploadId: id, name, mimeType: 'text/plain', bytes: bytes.length }, bytes }
}
async function* body(bytes, signal) { signal?.throwIfAborted(); yield bytes }
function reference(value) { return { version: 1, source: 'conversation-attachment', mode: 'git', collaborationId: owner.collaborationId,
  name: value.metadata.name, mimeType: value.metadata.mimeType, bytes: value.bytes.length, sha256: sha(value.bytes),
  path: attachmentOriginalPath({ ...owner, name: value.metadata.name, sha256: sha(value.bytes) }) } }
function fixture() {
  const repo = new Repository(), commit = repo.commitPrepared.bind(repo), resolve = repo.resolveCommit.bind(repo), read = repo.read.bind(repo), readBytes = repo.readBytes.bind(repo)
  const trace = { commits: [], reads: [], resolutions: [], channels: [], conflicts: 0, preparations: 0 }
  const controls = { loss: undefined, unknown: new Set() }, sessions = []
  repo.withChannel = (channel, fn) => { trace.channels.push(channel); return fn() }
  repo.read = async (snapshot, path) => { trace.reads.push({ head: snapshot.head, path }); return read(snapshot, path) }
  repo.readBytes = async (snapshot, path) => { trace.reads.push({ head: snapshot.head, path }); return readBytes(snapshot, path) }
  repo.commitPrepared = async (snapshot, changes, message, operation) => {
    trace.commits.push({ operation, changes }); await tick()
    // The reusable controlled repository alone does not reject a stale parent.
    if (repo.head !== operation.expectedHead && !repo.accepted.has(operation.id)) { trace.conflicts++; throw new GitConflictError() }
    const loss = controls.loss; controls.loss = undefined
    if (loss === 'before') { controls.unknown.add(operation.id); throw new GitCommitOutcomeUnknownError(operation) }
    const result = await commit(snapshot, changes, message, operation)
    if (loss === 'after') { controls.unknown.add(operation.id); throw new GitCommitOutcomeUnknownError(operation) }
    return result
  }
  repo.resolveCommit = async operation => { trace.resolutions.push(operation.id); return controls.unknown.has(operation.id) ? { status: 'unknown' } : resolve(operation) }
  const f = { repo, trace, controls, sessions }
  f.open = () => {
    const operations = new SessionGitOperations(), files = new GitFiles(repo, operations), records = new Map()
    const storage = { get: async k => structuredClone(records.get(k)), set: async (k,v) => records.set(k,structuredClone(v)),
      delete: async k => records.delete(k), list: async p => [...records].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value)})) }
    const tx = new FrameworkTransactions(files, storage, owner.storageScope)
    const attachments = new ConversationAttachments(files, tx, owner)
    const connection = { scope: owner.storageScope, files, prepareWrite: async () => { trace.preparations++ } }
    const session = { operations, files, tx, attachments, records, active: { connection, conversation: { scope: owner, attachments } } }
    sessions.push(session); f.session = session; return session
  }
  f.open()
  // Use the actual class and its actual scope/schema checks. Only acquiring an
  // already-owned connection and reading configured selection are fixture ports.
  f.service = Object.create(FrameworkService.prototype)
  f.service.access = async mode => { assert.equal(mode, 'git'); return f.session.active }
  f.service.config = mode => { assert.equal(mode, 'git'); return { settings: { collaborationId: owner.collaborationId } } }
  f.upload = (value, signal) => f.service.uploadAttachment(value.metadata, body(value.bytes, signal), signal)
  f.noNewReceipts = () => {
    assert.equal(trace.commits.some(row => row.changes.some(change => receiptPath(change.path))), false)
    assert.equal(trace.reads.some(row => receiptPath(row.path)), false)
    assert.equal(sessions.some(session => session.records.size), false, 'no substitute persistent command journal')
  }
  f.present = value => {
    const ref = reference(value)
    assert.deepEqual(Buffer.from(repo.bodies.get('dss-coop/' + ref.path)), value.bytes)
    assert.deepEqual(JSON.parse(repo.bodies.get('dss-coop/' + attachmentManifestPath(ref))), ref)
    return ref
  }
  fixtures.push(f); return f
}
test('service: ordinary upload publishes only the current original and manifest, without a command receipt', async () => {
  const f = fixture(), value = input('ordinary'), result = await f.upload(value)
  assert.deepEqual(result, { attachment: f.present(value), storageScope: owner.storageScope })
  assert.equal(f.trace.commits.length, 1)
  assert.equal(f.repo.bodies.size, 3, 'marker, original and manifest only')
  assert.ok(f.trace.channels.includes('foreground-write'))
  f.noNewReceipts()
})
test('service: exact repeated target uses each existing builder read once and makes no commit', async () => {
  const f = fixture(), value = input('repeat'); await f.upload(value)
  f.trace.reads.length = 0
  const result = await f.upload(value), ref = reference(value)
  assert.deepEqual(result.attachment, ref); assert.equal(f.trace.commits.length, 1)
  const expected = [f.session.attachments.markerPath, attachmentManifestPath(ref), ref.path].map(p=>'dss-coop/'+p).sort()
  assert.deepEqual(f.trace.reads.map(r=>r.path).sort(), expected, 'one builder, no receipt/completionProof extra reads')
  await f.upload({ ...value, metadata: { ...value.metadata, uploadId: 'new-selection-same-file' } })
  assert.equal(f.trace.commits.length, 1); f.noNewReceipts()
})
test('service: after completion an explicitly reused ID with another body is judged by that body, not an old permanent receipt', async () => {
  const f = fixture(), a = input('same-id','first'), b = input('same-id','second')
  await f.upload(a); await f.upload(b)
  f.present(a); f.present(b); assert.equal(f.trace.commits.length, 2); f.noNewReceipts()
  scenarios.push('Same-ID changed-body call is an explicit service/API comparison, not a path generated by ordinary UI row retry.')
})
for (const damaged of ['manifest missing', 'original missing', 'manifest differs', 'original differs']) {
  test('service: actual target check rejects ' + damaged, async () => {
    const f = fixture(), value = input('damage'), first = await f.upload(value), ref = first.attachment
    const manifest = attachmentManifestPath(ref)
    if (damaged === 'manifest missing') put(f.repo, manifest, undefined)
    if (damaged === 'original missing') put(f.repo, ref.path, undefined)
    if (damaged === 'manifest differs') put(f.repo, manifest, { ...ref, mimeType:'application/octet-stream' })
    if (damaged === 'original differs') put(f.repo, ref.path, Buffer.from('modified'))
    head(f.repo)
    await assert.rejects(f.upload(value), /different or incomplete content/)
    assert.equal(f.trace.commits.length, 1); f.noNewReceipts()
  })
}
test('service: changed scope, wrong conversation and canceled body keep their existing boundaries', async () => {
  const f = fixture(), value = input('scope'), cancel = new AbortController()
  await assert.rejects(f.upload({...value,metadata:{...value.metadata,storageScope:'other'}}),/Storage destination changed/)
  await assert.rejects(f.upload({...value,metadata:{...value.metadata,collaborationId:'other'}}),/Conversation selection changed/)
  cancel.abort(new Error('Canceled selected original'))
  await assert.rejects(f.upload(value,cancel.signal),/Canceled selected original/)
  assert.equal(f.trace.commits.length,0); f.noNewReceipts()
})
test('service: concurrent independent uploads retain both originals through real exact-H rejection in the controlled main transport', async () => {
  const f = fixture(), a = input('a','first','a.txt'), b = input('b','second','b.txt')
  const [ra, rb] = await Promise.all([f.upload(a),f.upload(b)])
  assert.deepEqual(ra.attachment,f.present(a)); assert.deepEqual(rb.attachment,f.present(b))
  assert.ok(f.trace.conflicts>=1); f.noNewReceipts()
})
test('service: a present target cannot replace an active original UNKNOWN; positive resolution uses that same attempt', async () => {
  const f = fixture(), value = input('uncertain'); f.controls.loss='after'
  await assert.rejects(f.upload(value),FilesOutcomeUnknownError)
  f.present(value)
  const operation=f.trace.commits[0].operation.id, readCount=f.trace.reads.length
  await assert.rejects(f.upload(value),FilesOutcomeUnknownError)
  assert.equal(f.trace.resolutions.at(-1),operation)
  assert.equal(f.trace.reads.length,readCount,'original UNKNOWN is resolved before any current-target builder')
  assert.equal(f.trace.commits.length,1)
  const otherSelection={...value,metadata:{...value.metadata,uploadId:'independent-existing-target'}}
  await f.upload(otherSelection); assert.equal(f.trace.commits.length,1)
  await assert.rejects(f.upload(value),FilesOutcomeUnknownError)
  f.controls.unknown.delete(operation)
  const before=f.trace.reads.length, confirmed=await f.upload(value)
  assert.deepEqual(confirmed.attachment,reference(value))
  assert.equal(f.trace.resolutions.at(-1),operation); assert.equal(f.trace.commits.length,1)
  assert.equal(f.trace.reads.length,before,'positive original resolution does not add target readback')
  assert.deepEqual(await f.session.operations.list(),[])
  f.noNewReceipts()
})
test('service: active original identity still rejects changed parameters before resolving UNKNOWN', async () => {
  const f=fixture(),value=input('pending-id');f.controls.loss='before'
  await assert.rejects(f.upload(value),FilesOutcomeUnknownError)
  await assert.rejects(f.upload(input('pending-id','different')),/cannot be reused with different arguments/)
  assert.equal(f.trace.commits.length,1);assert.equal(f.trace.resolutions.length,0);f.noNewReceipts()
})
test('client: actual connection/reset registration and same-row retry inspect current files in a fresh backend session', async () => {
  const f=fixture(),requests=createRequestLifecycle(),ctx=new Context(),delivered=gate(),allowResponse=gate(),calls=[]
  wireReset(ctx,requests)
  let hold=true
  const fetch=async(url,options)=>{
    const metadata=JSON.parse(new URL(url,'http://controlled.test').searchParams.get('metadata'))
    calls.push({metadata,file:options.body,signal:options.signal})
    const response=await f.service.uploadAttachment(metadata,options.body.stream(),options.signal)
    if(hold){hold=false;delivered.resolve();await allowResponse.promise}
    return Response.json(response)
  }
  const api={uploadAttachment:(metadata,file,signal)=>requests.request(signal,owned=>uploadConversationAttachment(fetch,metadata,file,owned))}
  const drafts=new ConversationAttachmentDrafts(api), original=new File(['reset original'],'reset.txt',{type:'text/plain'})
  try{
    drafts.add('scope',owner,[original]);await delivered.promise
    const selected=drafts.selections('scope')[0],id=selected.id,oldSession=f.session
    ctx.emit('connection/reset');await tick();await tick()
    assert.equal(drafts.selections('scope')[0].state,'error')
    await oldSession.tx.closeGitSession(new Error('Controlled original backend connection ended'));oldSession.operations.close();f.open()
    allowResponse.resolve();await tick()
    drafts.retry('scope',id);await tick();await tick()
    assert.equal(drafts.selections('scope')[0].state,'ready')
    assert.equal(calls.length,2);assert.equal(calls[0].metadata.uploadId,calls[1].metadata.uploadId)
    assert.equal(calls[0].file,original);assert.equal(calls[1].file,original)
    assert.deepEqual(calls[0].metadata,calls[1].metadata)
    assert.equal(f.trace.commits.length,1,'fresh session observes exact target; no replacement command receipt or upload commit')
    assert.equal(f.trace.resolutions.length,0,'current target observation does not claim historical operation resolution')
    f.noNewReceipts()
  }finally{allowResponse.resolve();requests.dispose()}
})
test('service: a fresh session may establish current content after prior UNKNOWN without relabeling its old transport', async () => {
  const f=fixture(),value=input('old-unknown');f.controls.loss='after'
  await assert.rejects(f.upload(value),FilesOutcomeUnknownError)
  const old=f.session,operation=f.trace.commits[0].operation.id
  await old.tx.closeGitSession(new Error('Controlled original session ended'));old.operations.close();f.open()
  const result=await f.upload(value)
  assert.deepEqual(result.attachment,f.present(value));assert.equal(f.trace.commits.length,1)
  assert.equal(f.trace.resolutions.length,0);assert.ok(f.controls.unknown.has(operation),'fixture still has not declared old transport confirmed')
  f.noNewReceipts()
})
test('service: old global receipt is neither read nor deleted; current target still decides this request', async () => {
  const f=fixture(),value=input('legacy-receipt'),ref=reference(value)
  const command='conversation-attachments/upload/git/'+owner.collaborationId+'/'+value.metadata.uploadId
  const path='technical/command-receipts/'+sha(command)+'.json',manifest=attachmentManifestPath(ref)
  // Produce the original receipt through the real default transaction engine,
  // using the old upload's exact command, request and first-upload business files.
  // This empty repository has neither original nor manifest before publication.
  await f.session.tx.run(command,{ref},{reevaluate:true,readPlan:{files:[f.session.attachments.markerPath,manifest,ref.path]}},async snapshot=>[
    ...await f.session.attachments.markerChanges(snapshot),{path:ref.path,bytes:value.bytes},{path:manifest,content:JSON.stringify(ref)+'\n'}])
  const old=f.repo.bodies.get('dss-coop/'+path)
  assert.equal(typeof old,'string')
  assert.deepEqual(JSON.parse(old),{version:1,id:command,requestHash:sha(JSON.stringify({ref}))})
  f.present(value)
  const previous=f.session
  await previous.tx.closeGitSession(new Error('Confirmed legacy upload session ended'));previous.operations.close();f.open()
  f.trace.commits.length=0;f.trace.reads.length=0;f.trace.resolutions.length=0
  const result=await f.upload(value)
  assert.deepEqual(result.attachment,ref);f.present(value)
  assert.equal(f.repo.bodies.get('dss-coop/'+path),old)
  assert.equal(f.trace.commits.length,0)
  assert.deepEqual(f.trace.reads.map(row=>row.path).sort(),[f.session.attachments.markerPath,manifest,ref.path].map(p=>'dss-coop/'+p).sort())
  f.noNewReceipts()
  scenarios.push('Old receipt is produced by actual default FrameworkTransactions with the old upload command, request and initial business changes; its exact bytes remain untouched during the new-session current-target call.')
})

after(async()=>{
  for(const f of fixtures)for(const session of f.sessions){await session.tx.closeGitSession(new Error('Controlled attachment test ended'));session.operations.close()}
  console.log(JSON.stringify({scope:'Actual service/upload and transaction implementations; controlled access/config/HTTP delivery/exact-H repository. Actual SDK Context executes the extracted production client reset registration. Native remote Git history resolver is not this fixture.',
    scenarios,resetRegistrationSHA256:sha(resetStatements[0]),explicitSourceHashes:{'client.tsx':sha(clientSource)},...evidence()}))
  hooks.deregister()
})
