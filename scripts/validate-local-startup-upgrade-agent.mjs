import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

// The real upgrade owner, scoped tools, execution guard, SQLite reader and
// physical IO run here. DSH native Agent creation/model turns are a controlled
// injected gateway, not a claim of real-host/model startup acceptance.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hash = data => createHash('sha256').update(data).digest('hex')
const schema = `const schema = new Proxy(function () {}, { get(_t,k){if(k==='parse')return v=>v;return schema},apply(){return schema} }); export const z=schema;`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-scope') return { url: 'data:text/javascript;base64,' + Buffer.from('export const scopeOf=scope=>scope.agent').toString('base64'), shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-skill') return { url: 'data:text/javascript;base64,' + Buffer.from('export const isSkillName=name=>typeof name==="string" && /^[a-z0-9][a-z0-9-]*$/.test(name)').toString('base64'), shortCircuit: true }
    if (specifier === 'yaml') return { url: 'data:text/javascript;base64,' + Buffer.from('export const parse=JSON.parse').toString('base64'), shortCircuit: true }
    if (specifier === 'koffi') return { url: new URL('./helpers/fixture-no-replace-koffi.mjs', import.meta.url).href, shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: 'data:text/javascript;base64,' + Buffer.from('export function fromMarkdown(){return {type:"root",children:[]}}').toString('base64'), shortCircuit: true }
    if (specifier === 'zod') return { url: 'data:text/javascript;base64,' + Buffer.from(schema).toString('base64'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      let source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), hash(source))
      if (url.endsWith('/adapters/dsh/agents.ts')) {
        // Execute the real existing scoped guard, without importing unavailable
        // native host SDKs. The default gateway must never be used in fixtures.
        source = 'export class DshAgentGateway { constructor(){throw new Error("Native gateway needs actual DSH")}}\n' + source.slice(source.indexOf('export function installExecutionGuard'))
      }
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { LocalStartupUpgradeAgent, localUpgradeAgentKey } = await import('../src/framework/local-startup-upgrade-agent.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { localUpgradeView } = await import('../src/framework/local-upgrade-view.ts')
const { inspectLocalStartupUpgrade, readLegacyLocalOriginal, materializeLegacyLocalFiles } = await import('../src/framework/local-startup-upgrade.ts')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-upgrade-agent-'))
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (work, expected) => { await assert.rejects(work, expected); assertions++ }
class DiskRecords {
  constructor(root) { this.files = new LocalRecordFiles(path.join(root, 'host-records')); this.writes = 0; this.afterSave = undefined }
  async get(key) { const body = await this.files.read(hash(key) + '.json'); return body === undefined ? undefined : JSON.parse(body) }
  async set(key, value) { this.writes++; await this.files.replace(hash(key) + '.json', JSON.stringify(value)); await this.afterSave?.(value) }
  async list() { throw new Error('No unrelated Host-record scan') }
  async delete(key) { await this.files.delete(hash(key) + '.json') }
}
async function fixture(name, content = '\uFEFFold original\r\n') {
  const root = path.join(sandbox, name), directory = path.join(root, 'files')
  await fs.mkdir(directory, { recursive: true })
  const db = new DatabaseSync(path.join(directory, 'dss-files.sqlite'))
  db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT')
  db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run('roles/custom.md', content, 'fixture', Buffer.byteLength(content), null)
  db.close()
  return { root, directory, records: new DiskRecords(root), content }
}
class Gateway {
  creates = []; sessions = new Set(); live = new Set(); disposed = 0; cancelled = 0; effectsRemoved = 0
  constructor(actions) { this.actions = actions }
  async exists(id) { return this.sessions.has(id) }
  hasLiveOwner(id) { return this.live.has(id) }
  async create(request) {
    this.creates.push(request); this.sessions.add(request.sessionId); this.live.add(request.sessionId)
    const registrations = [], effects = [], hooks = [], prompts = []
    const agent = { id: request.sessionId, session: { id: request.sessionId } }
    const scope = { systemPrompt: { section: data => prompts.push(data) },
      tools: { register: tool => registrations.push(tool) },
      effect: callback => effects.push(callback()),
      on: (name, callback) => { const hook = { name, callback }; hooks.push(hook); return () => { hooks.splice(hooks.indexOf(hook), 1); this.effectsRemoved++ } },
    }
    await request.setup(scope, agent)
    check(registrations.map(tool => tool.name), ['dss_upgrade_local_files'])
    check(prompts.length, 1)
    const tool = registrations[0], controller = new AbortController()
    let sent = false
    this.last = { request, agent, scope, tool, hooks, prompts,
      call: (action, fields = {}, actual = agent) => tool.execute({ action, ...fields }, { agent: actual, signal: controller.signal, callId: 'fixture' }),
      guard: name => hooks.find(hook => hook.name === 'tools/pre-execute').callback({ agent, name, signal: controller.signal }, () => ({ kind: 'next' })),
    }
    return {
      sessionId: request.sessionId, actualAgent: agent,
      send: async (text, id, mode, source) => { check(typeof text, 'string'); check(id.startsWith('dss-local-upgrade:'), true); check(mode, 'followup'); check(source, 'deepseek-servant'); sent = true },
      whenIdle: async () => { check(sent, true); await this.actions(this.last) },
      cancel: async () => { this.cancelled++; controller.abort(Error('native fixture cancellation')) },
      dispose: async () => { if (this.failDispose) { this.failDispose = false; throw Error('fixture native dispose failed') }; this.disposed++; this.live.delete(request.sessionId); for (const effect of effects) await effect?.() },
      observe: () => ({ state: 'idle', jobs: [] }),
    }
  }
}
try {
  const fresh = path.join(sandbox, 'fresh'), freshRecords = new DiskRecords(fresh), unused = new Gateway(async () => { throw Error('Fresh root must not start model') })
  let agent = new LocalStartupUpgradeAgent({}, freshRecords, { directory: path.join(fresh, 'files'), cwd: sandbox }, unused)
  let outcome = await agent.start(); check(outcome.status, 'not-needed'); check(unused.creates.length, 0); check(freshRecords.writes, 0)

  // Real interrupted conversion may already have published physical contents.
  // Losing the still-required SQL source is pending, never a fresh empty root
  // or completed conversion, and starting a model cannot reconstruct it.
  const missingSource = await fixture('source-missing')
  await materializeLegacyLocalFiles(missingSource.directory, missingSource.records)
  const retainedPath = path.join(missingSource.directory, 'roles/custom.md')
  const originalSql = path.join(missingSource.directory, 'dss-files.sqlite')
  const sqlBytes = await fs.readFile(originalSql)
  await fs.rename(originalSql, path.join(missingSource.root, 'retained-source.sqlite'))
  const missingReport = await inspectLocalStartupUpgrade(missingSource.directory, missingSource.records)
  check(missingReport.status, 'incomplete'); check(missingReport.issues[0].code, 'source-missing')
  const writesBeforeMissing = missingSource.records.writes
  const missingGateway = new Gateway(async () => { throw Error('Missing SQL source must not launch pointless upgrade AI') })
  const missingAgent = new LocalStartupUpgradeAgent({}, missingSource.records, { directory: missingSource.directory, cwd: sandbox }, missingGateway)
  const pendingSource = await missingAgent.start()
  check(pendingSource.status, 'pending'); check(missingGateway.creates.length, 0)
  check(missingSource.records.writes, writesBeforeMissing)
  check(await fs.readFile(retainedPath, 'utf8'), missingSource.content)
  check(await fs.readFile(path.join(missingSource.root, 'retained-source.sqlite')), sqlBytes)
  const visibleMissing = await localUpgradeView(missingSource.directory, missingSource.records, { result: pendingSource })
  check(visibleMissing.status, 'pending'); check(visibleMissing.sourcePath, originalSql)
  check(visibleMissing.pending[0].reason, missingReport.issues[0].message)
  check(visibleMissing.detail.includes('Published physical records remain usable'), true)

  const good = await fixture('happy')
  const gateway = new Gateway(async ({ call, guard }) => {
    check((await guard('dss_upgrade_local_files')).kind, 'next')
    check((await guard('run_code')).kind, 'deny')
    await rejects(() => call('materialize', {}, { id: 'other-agent' }), /does not belong/)
    check((await call('inspect')).files[0].path, 'roles/custom.md')
    const original = await call('read', { path: 'roles/custom.md' })
    check(original.text, good.content); check(original.base64, Buffer.from(good.content).toString('base64'))
    check((await call('finish')).completed, false)
    const exported = await call('materialize'); check(exported.report.status, 'complete'); check(exported.semanticUpgrade, 'not-performed-by-this-tool')
    check((await call('finish')).completed, true)
  })
  const route = { provider: 'configured-provider', model: 'configured-model' }
  agent = new LocalStartupUpgradeAgent({}, good.records, { directory: good.directory, cwd: sandbox, model: route, presetId: 'existing' }, gateway)
  const [first, simultaneous] = await Promise.all([agent.start(), agent.start()])
  check(first, simultaneous); check(first.status, 'complete'); check(first.scope, 'local-sql-physical-upgrade')
  check(gateway.creates.length, 1); check(gateway.creates[0].model, route); check(gateway.creates[0].presetId, 'existing'); check(gateway.creates[0].role, 'helper')
  check(gateway.disposed, 1); check(gateway.effectsRemoved, 1)
  const completed = await good.records.get(localUpgradeAgentKey(good.directory))
  check(completed, undefined); check((await inspectLocalStartupUpgrade(good.directory,good.records)).status,'complete')
  await rejects(() => gateway.last.call('materialize'), /active one-time Agent/)
  const writes = good.records.writes
  check((await agent.start()).status, 'complete'); check(gateway.creates.length, 1); check(good.records.writes, writes)

  const oral = await fixture('oral-only')
  const incomplete = new Gateway(async ({ call }) => { check((await call('materialize')).report.status, 'complete') })
  agent = new LocalStartupUpgradeAgent({}, oral.records, { directory: oral.directory, cwd: sandbox }, incomplete)
  outcome = await agent.start(); check(outcome.status, 'pending'); check(incomplete.disposed, 1)
  const pending = await oral.records.get(localUpgradeAgentKey(oral.directory)); check(pending.status, 'pending')
  incomplete.actions = async ({ call }) => { check((await call('finish')).completed, true) }
  check((await agent.start()).status, 'complete'); check(incomplete.creates[1].resume, true)
  check(incomplete.creates[1].sessionId, incomplete.creates[0].sessionId)
  check(incomplete.creates[1].model, undefined)

  const conflict = await fixture('conflict')
  await fs.mkdir(path.join(conflict.directory, 'roles'), { recursive: true })
  await fs.writeFile(path.join(conflict.directory, 'roles/custom.md'), 'custom physical file')
  const conflicting = new Gateway(async ({ call }) => {
    check((await call('materialize')).report.status, 'incomplete')
    check((await call('finish')).completed, false)
    check((await call('read', { path: 'roles/custom.md' })).text, conflict.content)
  })
  outcome = await new LocalStartupUpgradeAgent({}, conflict.records, { directory: conflict.directory, cwd: sandbox }, conflicting).start()
  check(outcome.status, 'pending'); check(String(await fs.readFile(path.join(conflict.directory, 'roles/custom.md'))), 'custom physical file')
  check(Buffer.from((await readLegacyLocalOriginal(conflict.directory, 'roles/custom.md')).bytes).toString(), conflict.content)

  const retire = await fixture('retirement-failure')
  const retirement = new Gateway(async ({ call }) => { await call('materialize'); await call('finish') }); retirement.failDispose = true
  agent = new LocalStartupUpgradeAgent({}, retire.records, { directory: retire.directory, cwd: sandbox }, retirement)
  await rejects(() => agent.start(), /dispose failed/)
  check((await retire.records.get(localUpgradeAgentKey(retire.directory))).status, 'verified')
  await rejects(() => agent.start(), /still has a live native owner/)
  retirement.live.clear() // The fixture now reports that exact native owner closed.
  check((await agent.start()).status, 'complete'); check(retirement.creates.length, 1)

  const stopping = await fixture('cancelled-during-write', 'x'.repeat(200_000)), abort = new AbortController()
  stopping.records.afterSave = value => { if (value.kind === 'dss-local-sqlite-to-physical' && value.files.some(file => file.status === 'owned')) abort.abort(Error('Host disposed')) }
  const cancelling = new Gateway(async ({ call }) => { await call('materialize') })
  agent = new LocalStartupUpgradeAgent({}, stopping.records, { directory: stopping.directory, cwd: sandbox }, cancelling)
  await rejects(() => agent.start(abort.signal), /Host disposed|cancellation/)
  check(cancelling.cancelled, 1); check(cancelling.disposed, 1)
  check((await inspectLocalStartupUpgrade(stopping.directory, stopping.records)).status, 'incomplete')
  check((await stopping.records.get(localUpgradeAgentKey(stopping.directory))).status, 'pending')

  const unfinished = await fixture('semantic-pending')
  const skillDb = new DatabaseSync(path.join(unfinished.directory,'dss-files.sqlite'))
  skillDb.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run('skills/original/SKILL.md','# custom source','fixture',15,null);skillDb.close()
  const waiting = new Gateway(async ({call})=>{await call('materialize');const result=await call('finish');check(result.completed,false);check(result.pending[0].path,'skills/original/SKILL.md')})
  check((await new LocalStartupUpgradeAgent({},unfinished.records,{directory:unfinished.directory,cwd:sandbox},waiting).start()).status,'pending')
  check((await unfinished.records.get(localUpgradeAgentKey(unfinished.directory))).status,'pending')
  const staged = await fixture('actual-unowned-stage')
  await rejects(()=>materializeLegacyLocalFiles(staged.directory,staged.records,{onProgress:p=>{if(p.step==='created')throw Error('interrupted-before-stage-ownership')}}),/interrupted-before-stage-ownership/)
  const stagedReport=await materializeLegacyLocalFiles(staged.directory,staged.records)
  check(stagedReport.status,'complete');check(stagedReport.retainedStages.length,1)
  const actualStage=stagedReport.retainedStages[0].path
  const stagedGateway=new Gateway(async({call})=>{
    const pending=await call('finish');check(pending.completed,false);check(pending.pending.some(row=>row.path===actualStage),true)
    check((await staged.records.get(localUpgradeAgentKey(staged.directory))).status,'pending')
    // Controlled fixture explicitly resolves its known injected orphan. The
    // production finish tool never guesses ownership or performs this deletion.
    await fs.unlink(path.join(staged.directory,actualStage))
    check((await call('finish')).completed,true)
  })
  check((await new LocalStartupUpgradeAgent({},staged.records,{directory:staged.directory,cwd:sandbox},stagedGateway).start()).status,'complete')

  const noDelete = await fixture('optional-delete-unavailable'); noDelete.records.delete = undefined
  const noDeleteGateway = new Gateway(async({call})=>{await call('materialize');await call('finish')})
  const noDeleteResult=await new LocalStartupUpgradeAgent({},noDelete.records,{directory:noDelete.directory,cwd:sandbox},noDeleteGateway).start()
  check(noDeleteResult.status,'pending');check(noDeleteGateway.disposed,1);check((await noDelete.records.get(localUpgradeAgentKey(noDelete.directory))).status,'verified')

  const skillFixture = await fixture('actual-skill-owner')
  const oldPath = 'skills/owner/record.json', nativePath = 'skills/owner/SKILL.md'
  const oldRecord = {schemaVersion:1,kind:'skill',skillId:'owner',scope:{assistantId:'actual',workspaceId:'actual'},revision:1,activeVersion:1,
    versions:[{version:1,status:'active',title:'Original method',description:'Original method',applicability:'Actual scope',body:'Actual original instructions.'}]}
  const oldRendered = '# Original method\n\nOriginal method\n\n## 适用范围\n\nActual scope\n\nActual original instructions.\n'
  const skillDb2 = new DatabaseSync(path.join(skillFixture.directory,'dss-files.sqlite'))
  for (const [p,v] of [[oldPath,JSON.stringify(oldRecord)],[nativePath,oldRendered]]) skillDb2.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,v,'old-owner',Buffer.byteLength(v),null)
  skillDb2.close()
  const newerRecord=structuredClone(oldRecord);delete newerRecord.activeVersion;newerRecord.revision++;newerRecord.versions[0].status='disabled';newerRecord.versions.push({...newerRecord.versions[0],version:2,status:'candidate',body:'Unvalidated newer current candidate.'})
  await fs.mkdir(path.join(skillFixture.directory,'skills/owner'),{recursive:true})
  await fs.writeFile(path.join(skillFixture.directory,oldPath),JSON.stringify(newerRecord));await fs.writeFile(path.join(skillFixture.directory,nativePath),oldRendered)
  const native = '---\n'+JSON.stringify({name:'owner-method',description:'Original method'})+'\n---\nActual original instructions.\n'
  const independentPath='skills/independent/SKILL.md',independentNative='---\n'+JSON.stringify({name:'independent-native',description:'Independent native method'})+'\n---\nIndependent instructions.\n'
  const independentDb=new DatabaseSync(path.join(skillFixture.directory,'dss-files.sqlite'))
  independentDb.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(independentPath,independentNative,'native-original',Buffer.byteLength(independentNative),null);independentDb.close()
  let skillOwner,skillNotifications=0
  const skillGateway=new Gateway(async({call})=>{
    check(skillOwner.pendingSkillPaths().sort(),[independentPath,nativePath,oldPath].sort())
    const waiting=await call('publish_skill',{path:oldPath,content:native})
    check(waiting.status,'incomplete');check(waiting.issues.some(issue=>issue.message.includes('Read this exact current source')),true)
    const current=await call('read',{path:oldPath});check(JSON.parse(current.text),oldRecord);check(JSON.parse(current.currentPhysical.text),newerRecord)
    check((await call('read',{path:nativePath})).currentPhysical.text,oldRendered)
    check(skillNotifications,1);check(skillOwner.pendingSkillPaths().sort(),[independentPath,nativePath,oldPath].sort())
    check(JSON.parse((await skillOwner.skillSelection(oldPath)).text),oldRecord)
    check((await call('publish_skill',{path:independentPath,content:independentNative})).status,'complete')
    check(skillNotifications,2);check(skillOwner.pendingSkillPaths().sort(),[nativePath,oldPath].sort())
    check((await call('materialize')).report.status,'incomplete')
    const finished=await call('finish');check(finished.completed,false);check(finished.pending.length>0,true)
  })
  skillOwner=new LocalStartupUpgradeAgent({},skillFixture.records,{directory:skillFixture.directory,cwd:sandbox,onSkillRestoration:()=>skillNotifications++},skillGateway)
  check((await skillOwner.start()).status,'pending');check(skillGateway.disposed,1)
  check((await skillFixture.records.get(localUpgradeAgentKey(skillFixture.directory))).status,'pending')
  check(JSON.parse(await fs.readFile(path.join(skillFixture.directory,oldPath),'utf8')),newerRecord)
  check(await fs.readFile(path.join(skillFixture.directory,nativePath),'utf8'),oldRendered)
  check(await fs.readFile(path.join(skillFixture.directory,independentPath),'utf8'),independentNative)
  check(existsSync(path.join(skillFixture.directory,'skills/owner/resources/original-record.json')),false)
  let coldSkillOwner
  const coldSkillGateway=new Gateway(async({call})=>{
    check(coldSkillOwner.pendingSkillPaths().sort(),[nativePath,oldPath].sort())
    check(JSON.parse((await call('read',{path:oldPath})).currentPhysical.text),newerRecord)
    check((await call('publish_skill',{path:oldPath,content:native})).status,'complete')
    check(coldSkillOwner.pendingSkillPaths(),[])
    check((await coldSkillOwner.skillSelection(oldPath)).convertedPath,nativePath)
    check((await call('materialize')).report.status,'complete')
    check((await call('finish')).completed,true)
  })
  coldSkillOwner=new LocalStartupUpgradeAgent({},skillFixture.records,{directory:skillFixture.directory,cwd:sandbox},coldSkillGateway)
  check((await coldSkillOwner.start()).status,'complete');check(coldSkillGateway.creates.length,1)
  check(coldSkillGateway.creates[0].sessionId,skillGateway.creates[0].sessionId)
  check(existsSync(path.join(skillFixture.directory,oldPath)),false)
  check(await fs.readFile(path.join(skillFixture.directory,'skills/owner/resources/original-record.json'),'utf8'),JSON.stringify(newerRecord))
  check(await fs.readFile(path.join(skillFixture.directory,'skills/owner/resources/original-sql-record.json'),'utf8'),JSON.stringify(oldRecord))
  check(JSON.parse(await fs.readFile(path.join(skillFixture.directory,'technical/skills/controls.json'),'utf8')).entries[nativePath].status,'disabled')
  check(await skillFixture.records.get(localUpgradeAgentKey(skillFixture.directory)),undefined)
  // Completed old/native skills retire the existing one-time wake; no new
  // provider gate, owner root or permanent conversion queue was introduced.
  const pure=await fixture('pure-native-owner'),pureDb=new DatabaseSync(path.join(pure.directory,'dss-files.sqlite'))
  pureDb.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(independentPath,independentNative,'native-only',Buffer.byteLength(independentNative),null);pureDb.close()
  const pureGateway=new Gateway(async({call})=>{check((await call('publish_skill',{path:independentPath,content:independentNative})).status,'complete');check((await call('materialize')).report.status,'complete');check((await call('finish')).completed,true)})
  const pureOwner=new LocalStartupUpgradeAgent({},pure.records,{directory:pure.directory,cwd:sandbox},pureGateway)
  check((await pureOwner.start()).status,'complete');check(pureGateway.disposed,1);check(await pure.records.get(localUpgradeAgentKey(pure.directory)),undefined)
  const actualPrompt=pureGateway.last.prompts[0].text
  check(actualPrompt.includes('same opened Files root\'s DSS role provider'),true)
  check(actualPrompt.includes('Preserve original scope/participant/source as historical facts'),true)
  check(actualPrompt.includes('never choose the last candidate as active'),true)
  check(actualPrompt.includes('actual name/content/resource conflicts or changed current sources stay specifically pending'),true)
  const coldPureGateway=new Gateway(async()=>{throw Error('Completed native conversion must not restart a model')})
  const coldPureOwner=new LocalStartupUpgradeAgent({},pure.records,{directory:pure.directory,cwd:sandbox},coldPureGateway)
  check((await coldPureOwner.start()).status,'complete');check(coldPureGateway.creates.length,0);check(coldPureOwner.pendingSkillPaths(),[])

  console.log(JSON.stringify({ status: 'passed', assertions, platform: process.platform, runtime: process.version,
    coverage: ['native-gateway-request-shape-controlled', 'actual-scoped-execution-guard', 'explicit-mechanical-tool-call-not-open-side-effect', 'same-wake-one-native-session', 'existing-model-route-no-new-configuration', 'exact-original-remains-readable-during-conflict', 'oral-completion-not-finish', 'resume-pending-native-history', 'completion-deletes-exact-wake-after-native-disposal', 'failed-native-retirement-stays-visible', 'Host-cancellation-retains-owned-partial'],
    limits: 'Native Agent/model engine is injected; this proves the real source lifecycle and tools against cloud fixtures, not real DSH activation, model behavior, production cutover, model-authored semantic skill judgments/old Task mapping, Windows, power loss or full dependency-backed typecheck.',
    sourceHashes: Object.fromEntries([...loaded].sort()), scriptHash: hash(readFileSync(fileURLToPath(import.meta.url))) }, null, 2))
} finally { hooks.deregister(); await fs.rm(sandbox, { recursive: true, force: true }) }
