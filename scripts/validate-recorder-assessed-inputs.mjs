import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
// Actual installed Zod, Markdown, YAML and SDK modules; only the native Agent
// registration surface and remote Git transport are controlled. No publication
// leaves this process. Initialization, completion, save, reads and Cleaner use
// production implementations. Local files are disposable Linux fixtures.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
    const source = readFileSync(process.env.DSS_SEAL_BASE && /\/(role-tools|file-read-observation|recorder-retention|task-relations)\.ts$/.test(url) ? path.join(process.env.DSS_SEAL_BASE,path.basename(new URL(url).pathname)) : new URL(url), 'utf8'); loaded.set(url.slice(sourceRoot.href.length), hash(source))
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
} })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles, FilesConflictError, withSnapshot } = await import('../src/framework/transactions.ts')
const { GitCommitOutcomeUnknownError } = await import('../src/experimental/private-git/contracts.ts')
const { SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { FrameworkCleaner, observeCleanup } = await import('../src/framework/cleaner.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { initializeTask, dispatchPlannerObjective, paths, encodeJson, readJson } = await import('../src/framework/task-files.ts')
const { taskFamily } = await import('../src/framework/task-relations.ts')
const { readTaskReferenceIdentity } = await import('../src/framework/task-history.ts')
const { readArchivedReference } = await import('../src/framework/recorder-retention.ts')
const { taskReference } = await import('../src/framework/published-references.ts')
const { Repository, put, head } = await import('./test-support/controlled-git/repository.mjs')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-independent-retention-'))
const checks = [], cases = [], opened = [], transactions = [], familyReadObservations = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
let sequence = 0
const actualBefore=JSON.parse(await fs.readFile(new URL('../../evidence/actual-before.json',import.meta.url),'utf8')),actualAfter=JSON.parse(await fs.readFile(new URL('../../evidence/actual-after.json',import.meta.url),'utf8'))
const ownHost=Object.keys(actualBefore.runtimeState.lifecycles[''].hosts)[0],peerHost=Object.keys(actualAfter.runtimeState.lifecycles[''].hosts).find(x=>x!==ownHost)
function toolsFor(f, task, role = 'Recorder') {
  const tools = new Map(), agent = { id: role + '-' + ++sequence, session: {} }
  const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
  installFrameworkRoleTools(ctx, agent, { role, owner: task?.owner ?? 'A', ...(task ? { taskId: task.taskId, lifecycleId: task.lifecycleId, ...(role === 'Planner' ? { member: task.owner } : {}) } : {}), workId: 'work-' + sequence, executionId: 'execution-' + sequence },
    { files: f.files, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => { throw error },
      taskCommandOwner: f.sealOwner ? ((identity) => ({...identity,hostKey:ownHost})) : undefined, transact: (...args) => f.tx.run(...args) })
  return { call: (name, input, callId = 'call-' + ++sequence, signal = new AbortController().signal) => tools.get(name).execute(input, { agent, callId, signal, concludeTurn() {} }) }
}
async function fixture(mode, name, child = false) {
  const repo = mode === 'git' ? new Repository() : undefined
  if (repo) {
    // The controlled remote implements the production deleteTree contract.
    const commit = repo.commitPrepared.bind(repo)
    repo.commitPrepared = async (snapshot, changes, message, operation) => {
      const result = await commit(snapshot, changes, message, operation)
      if (!result.replay) {
        for (const change of changes) if (change.deleteTree) for (const target of repo.bodies.keys())
          if (target.startsWith(change.path + '/')) repo.bodies.delete(target)
        repo.history.set(repo.head, new Map(repo.bodies))
      }
      return result
    }
  }
  const files = repo ? new GitFiles(repo, new SessionGitOperations()) : new PhysicalLocalFiles(path.join(scratch, mode + '-' + name))
  if (!repo) opened.push(files)
  const rows = new Map(), records = { get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)), delete: async key => rows.delete(key), list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }
  const tx = new FrameworkTransactions(files, records, mode + '-' + name); if (repo) transactions.push(tx)
  const set = async (target, value) => { if (repo) { put(repo, target, value); head(repo) } else if (value === undefined) await files.delete(target); else await files.replace(target, value) }
  const apply = async changes => { for (const change of changes) await set(change.path, change.content === null ? undefined : change.bytes ?? change.content) }
  const f = { mode, name, repo, files, tx, records, set, apply }
  const id = '10000000-0000-4000-8000-' + hash(mode + name).slice(0, 12), source = 'tasks/' + name + (child ? '_O.md' : '_P.md')
  await set(source, 'Original requirement for ' + name + '\n')
  await apply((await withSnapshot(files, s => initializeTask(files, s, source, 'A', child ? ['A', 'B'] : ['A'], id))).changes)
  f.task = await withSnapshot(files, s => readJson(files, s, paths.task(id)))
  if (child) {
    await apply(await withSnapshot(files, s => dispatchPlannerObjective(files, s, f.task, 'child-result', 'B', 'Child independent requirement', [], 'P')))
    f.family = await withSnapshot(files, s => taskFamily(files, s, id)); f.task = f.family[0]; f.child = f.family[1]
    f.childResult = paths.run(f.child.taskId) + '/child-result.txt'; await set(f.childResult, 'Child deliverable independently selected at completion')
    await complete(f, f.child, [f.childResult])
  } else f.family = [f.task]
  f.original = await withSnapshot(files, s => files.read(s, source))
  f.material = paths.run(id) + '/evidence.txt'; f.unselected = paths.run(id) + '/unselected.txt'
  await set(f.material, 'Selected evidence\r\n'); await set(f.unselected, 'Do not keep this unselected temporary text')
  return f
}
async function complete(f, task, resultPaths) {
  const role = toolsFor(f, task, task.route === 'O' ? 'Organizer' : 'Planner'), view = await role.call('dss_snapshot', {})
  await role.call('dss_complete', { snapshotId: view.snapshotId, acceptance: 'Controlled fixture completed actual acceptance entry.', resultPaths })
  check(f.mode + ' actual completion ' + task.taskId, (await withSnapshot(f.files, s => readJson(f.files, s, paths.task(task.taskId)))).status, 'complete')
}
const read = (f, target) => withSnapshot(f.files, s => f.files.read(s, target))
async function save(f, input, forbidUnselectedSource = false) {
  await complete(f, await withSnapshot(f.files, s => readJson(f.files, s, paths.task(f.task.taskId))), [])
  f.task = await withSnapshot(f.files, s => readJson(f.files, s, paths.task(f.task.taskId)))
  const role = toolsFor(f, f.task), view = await role.call('dss_snapshot', {})
  const reads = [], familyReads = [], familyPaths = new Set(f.family.map(task => paths.task(task.taskId))), oldRead = f.files.read.bind(f.files), oldBytes = f.files.readBytes.bind(f.files), oldPrefix = f.files.readPrefix?.bind(f.files)
  const observe = (target, fn) => { if (target === f.task.sourcePath) { reads.push(target); if (forbidUnselectedSource) throw new Error('Unselected original must not be read') }; return fn() }
  // Count actual Task metadata text reads once. Physical read calls readBytes
  // internally, so recording both would double-count one body operation.
  f.files.read = (s, p) => {
    if (familyPaths.has(p)) {
      const stack = new Error().stack ?? ''
      familyReads.push({ path: p, revision: s.revision, taskFamily: /at (?:async )?taskFamily /.test(stack),
        outputReferenceFamily: /at (?:async )?prepareRecorderOutputReferences /.test(stack),
        prepareArchive: /at (?:async )?prepareArchive /.test(stack), validate: /at (?:async )?validate /.test(stack) })
    }
    return observe(p, () => oldRead(s, p))
  }; f.files.readBytes = (s, p) => observe(p, () => oldBytes(s, p))
  if (oldPrefix) f.files.readPrefix = (p, n) => observe(p, () => oldPrefix(p, n))
  let result
  try { result = await role.call('dss_recorder_save', { snapshotId: view.snapshotId, ...input }) }
  finally { f.files.read = oldRead; f.files.readBytes = oldBytes; if (oldPrefix) f.files.readPrefix = oldPrefix }
  familyReadObservations.push({ mode: f.mode, name: f.name, familyPaths: [...familyPaths], reads: familyReads })
  f.retention = JSON.parse(await read(f, paths.archive(f.task) + '/retention.json'))
  check(f.mode + ' ' + f.name + ' save publishes original command', typeof f.retention.recorderCommand, 'string')
  check(f.mode + ' ' + f.name + ' save successful tool result', result === null && f.mode === 'git' || result?.saved === true, true)
  return { result, sourceReads: reads.length }
}
async function clean(f) {
  const cleaner = new FrameworkCleaner(f.files, f.tx)
  if (f.mode === 'local') {
    const errors = []
    const host = new FrameworkHostLoop(f.files, f.tx, f.records, { scope: f.name, member: 'A', primary: true, instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, () => ['A'], {
      async wake() {}, executing() { return false }, async releaseTask() {}, error(error) { errors.push(error) }, async observe() {},
      async clean(task, snapshot, observation) { return (await cleaner.clean(task, observation)).status === 'released' },
    })
    host.record = { initial: {}, completed: {} }
    await withSnapshot(f.files, snapshot => host.scanTask(f.task, snapshot, performance.now()))
    // Test waits for the Host-owned native-release/cleanup continuation after
    // scanTask, rather than assuming a scheduled responsibility has finished.
    for (;;) {
      const owned = [...host.physicalCleanupOperations.values(), ...host.physicalReleaseOperations.values()]
      if (!owned.length) break
      await Promise.allSettled(owned)
    }
    if (errors.length) throw new AggregateError(errors)
    check(f.mode + ' actual Host/Cleaner retires metadata ' + f.name, await read(f, paths.task(f.task.taskId)), undefined)
  } else await withSnapshot(f.files, async snapshot => { const observed = await observeCleanup(f.files, snapshot, f.task, performance.now()); if (observed.error) throw observed.error; const result = await cleaner.clean(f.task, observed); check(f.mode + ' actual Cleaner ' + f.name, result.status, 'deleted') })
  check(f.mode + ' Cleaner removes unselected working bytes ' + f.name, await read(f, f.unselected), undefined)
}
async function readRequirement(f, task = f.task) {
  const foreground = toolsFor(f, undefined, 'Foreground'), view = await foreground.call('dss_snapshot', {})
  return foreground.call('dss_read', { snapshotId: view.snapshotId, path: taskReference(task.taskId, task.sourcePath) })
}
const provenance=JSON.parse(await fs.readFile(new URL('../../evidence/observed-mutations.json',import.meta.url),'utf8'))
const report=[]
try {
 const baseline=!!process.env.DSS_SEAL_BASE
 for(const scenario of ['root-workspace','root-seal','child-seal','peer-release-real-phase','peer-release-field-only','selected-reference-body','result-list','selected-retention-mapping','unselected-retention-mapping','unrelated-sibling-body','own-release','new-lifecycle','cancel-in-flight','root-child-relocation','lost-reply']){
  const f=await fixture('git','broader-'+scenario,true), rootPath=paths.task(f.task.taskId), childPath=paths.task(f.child.taskId)
  await complete(f,f.task,scenario==='root-child-relocation'?[f.material]:[])
  f.task=await withSnapshot(f.files,s=>readJson(f.files,s,rootPath))
  const child=await withSnapshot(f.files,s=>readJson(f.files,s,childPath))
  const pre={...f.task,runtimeState:actualBefore.runtimeState}
  if(scenario==='root-workspace')pre.hostWorkspaces=provenance.workspace.before.hostWorkspaces
  const selectedRetention=paths.archive(child)+'/retention.json'
  const fileA=paths.archive(child)+'/known-a.txt', fileB=paths.archive(child)+'/known-b.txt'
  if(scenario.includes('retention-mapping')){
   await f.set(fileA,'known output A'); await f.set(fileB,'known output B')
   await f.set(selectedRetention,{outputs:[],retainedPaths:[],relocatedReferences:{[f.childResult]:fileA}})
  }
  await f.set(rootPath,pre)
  f.sealOwner=true
  const role=toolsFor(f,f.task),view=await role.call('dss_snapshot',{})
  const original=f.repo.head, attempts=[], deps=[], observedBuilds=[], aborter=new AbortController()
  const capture=f.files.captureReads.bind(f.files); f.files.captureReads=v=>{const d=capture(v);observedBuilds.push({head:v.revision, files:[...d.files].sort(),lists:d.lists});return d}
  const rawCommit=f.repo.commitPrepared.bind(f.repo), nativeReads=[]
  for(const method of ['read','readBytes']){
    const original=f.repo[method].bind(f.repo)
    f.repo[method]=(v,path)=>{nativeReads.push({head:v.head,path,method});return original(v,path)}
  }
  f.repo.commitPrepared=async(v,c,m,o)=>{
    attempts.push({head:v.head,paths:c.map(x=>x.path),rawReadsBefore:[...nativeReads]})
    const receipt=await rawCommit(v,c,m,o)
    if(scenario==='lost-reply'&&attempts.length===1) throw new GitCommitOutcomeUnknownError(o)
    return receipt
  }
  const equal=f.repo.dependenciesEqual.bind(f.repo)
  f.repo.dependenciesEqual=async(a,b,d)=>{const out=await equal(a,b,d);deps.push({before:a.head,after:b.head,equal:out,pathFiles:[...d.files]});return out}
  if(scenario!=='lost-reply')f.repo.outcomes.push({before:async()=>{
   if(scenario==='root-workspace')await f.set(rootPath,{...pre,hostWorkspaces:provenance.workspace.after.hostWorkspaces})
   else if(scenario==='root-child-relocation'){await f.set(rootPath,{...pre,runtimeState:actualAfter.runtimeState});await f.set(childPath,{...child,runtimeState:provenance['child-seal'].after.runtimeState})}
   else if(scenario==='root-seal')await f.set(rootPath,{...pre,runtimeState:actualAfter.runtimeState})
   else if(scenario==='child-seal')await f.set(childPath,{...child,runtimeState:provenance['child-seal'].after.runtimeState})
   else if(scenario==='peer-release-real-phase')await f.set(rootPath,{...pre,runtimeState:provenance['peer-release'].after.runtimeState})
   else if(scenario==='peer-release-field-only'){
    const next=structuredClone(pre)
    next.runtimeState.lifecycles[''].hosts[peerHost]=provenance['peer-release'].after.runtimeState.lifecycles[''].hosts[peerHost]
    await f.set(rootPath,next)
   }else if(scenario==='own-release'){
    const next=structuredClone(pre);next.runtimeState.lifecycles[''].hosts[ownHost].runtimeReleased=true;await f.set(rootPath,next)
   }else if(scenario==='new-lifecycle')await f.set(rootPath,{...pre,lifecycleId:'restored'})
   else if(scenario==='cancel-in-flight'){aborter.abort(new Error('original cancelled operation'));await f.set(rootPath,{...pre,runtimeState:actualAfter.runtimeState})}
   else if(scenario==='selected-reference-body')await f.set(f.childResult,'actual retained material changed')
   else if(scenario==='result-list')await f.set(childPath,{...child,resultPaths:[]})
   else if(scenario==='selected-retention-mapping'||scenario==='unselected-retention-mapping'){
    const market=scenario.startsWith('selected')?{[f.childResult]:fileB}:{[f.childResult]:fileA,[paths.run(child.taskId)+'/unselected.txt']:fileB}
    await f.set(selectedRetention,{outputs:[],retainedPaths:[],relocatedReferences:market})
   }else await f.set(f.unselected,'unrelated sibling body changed')
  },error:new FilesConflictError(original)})
  let err
  const input={snapshotId:view.snapshotId,outputs:[{path:paths.archive(f.task)+'/records.md',text:'Exact archive content'}],retainedPaths:[f.childResult]}
  try{await role.call('dss_recorder_save',input,'save',aborter.signal)}catch(error){err=String(error)}
  const published=await read(f,paths.state(f.task.owner,f.task.taskId)+'/Cleaner')===''
  const harmless=['root-workspace','root-seal','child-seal','peer-release-field-only','unselected-retention-mapping','root-child-relocation']
  if(scenario==='lost-reply'){
   assert(published&&!err,err);assert.equal(attempts.length,1)
   assert((await role.call('dss_recorder_save',input,'save'))?.replay)
   assert.equal(attempts.length,1)
  }else if(scenario==='unrelated-sibling-body'||!baseline&&harmless.includes(scenario)){
   assert(published&&!err,err);assert.equal(attempts.length,2)
   assert.equal(deps[0].equal,scenario==='unrelated-sibling-body')
   assert.deepEqual(attempts[0].paths,attempts[1].paths)
   if(!deps[0].equal){
    assert.equal(observedBuilds.length,2)
    assert.deepEqual(observedBuilds[0].files,observedBuilds[1].files)
    assert.deepEqual(observedBuilds[0].lists,observedBuilds[1].lists)
   }
   if(scenario==='root-child-relocation'){
    const freshRoot=await withSnapshot(f.files,s=>readJson(f.files,s,rootPath)), freshChild=await withSnapshot(f.files,s=>readJson(f.files,s,childPath))
    assert(freshRoot.resultPaths[0].startsWith('archives/') && freshChild.resultPaths[0].startsWith('archives/'))
    assert.deepEqual(freshRoot.runtimeState,actualAfter.runtimeState)
    assert.deepEqual(freshChild.runtimeState,provenance['child-seal'].after.runtimeState)
   }
   const replay=await role.call('dss_recorder_save',input,'save')
   assert.equal(replay?.replay,true);assert.equal(attempts.length,2)
  }else{
   assert(!published)
   assert.equal(attempts.length,1)
   assert.equal(deps[0].equal,false)
   assert.match(err,['peer-release-real-phase','own-release','new-lifecycle'].includes(scenario)?/command namespace/:!baseline&&scenario==='cancel-in-flight'?/original cancelled operation/:/Business material or write targets changed/)
  }
  report.push({scenario,attempts,published,err,dependenciesEqual:deps[0]?.equal,materialDependencies:deps[0]?.pathFiles, observedBuilds})
 }
 console.log(JSON.stringify({report,sourceHashes:Object.fromEntries(loaded)},null,2))
} finally { await Promise.allSettled(opened.map(files => files.close())); await Promise.allSettled(transactions.map(tx => tx.closeGitSession(new Error('Controlled test end')))); hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
