import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Real Host.start/poll/source lane, accepted task initialization, physical
// adapter, filesystem and fresh-process interruption/reopen. The Host record
// uses a controlled on-disk StoragePort harness, not native DSH. Unrelated Zod,
// Markdown and skill publication imports are stubbed because dependencies are
// absent. Current Task metadata parsing runs unchanged in FrameworkTaskIndex.
// This is Linux process-stop coverage, not Windows, power-loss durability,
// arbitrary cross-process writer exclusion, full typecheck or production cutover.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: data(`const schema = new Proxy(function () {}, { get(_t,k) { if(k==='parse') return v=>v; if(k==='toJSONSchema') return ()=>({}); return schema }, apply(){ return schema } }); export const z=schema;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(){throw new Error('Markdown is outside this focused test')}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', sourceRoot).href) return { url: data(`export const frameworkSkillIndexPath='skills/index.md'; export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skill publication is outside this focused test')}`), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(process.env.DSS_HANDOFF_BASELINE && url.endsWith('/host-loop.ts') ? process.env.DSS_HANDOFF_BASELINE : new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { paths, taskIdentity, taskInitializationFiles, preparePhysicalTask } = await import('../src/framework/task-files.ts')
const body = '# Preserve my task\r\n\r\n原文 requirement with spaces.\r\n'
const scope = 'physical-init-focused', key = 'framework-host/' + createHash('sha256').update(scope).digest('hex')
const id = '10000000-0000-4000-8000-000000000001'
let assertions = 0
const healthyPollChecks = [], interruptedInitializations = []
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (work, expected) => { await assert.rejects(work, expected); assertions++ }
const read = async (root, logical) => fs.readFile(path.join(root, 'files', ...logical.split('/')), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
const record = async root => JSON.parse(await fs.readFile(path.join(root, 'host', 'record.json'), 'utf8'))
const checkpoint = phase => { if (process.argv[2] === '--child' && process.argv[4] === phase) process.exit(72) }
class DiskHostRecords {
  constructor(root) { this.records = new LocalRecordFiles(path.join(root, 'host')) }
  async get(selected) { assert.equal(selected, key); const text = await this.records.read('record.json'); return text === undefined ? undefined : JSON.parse(text) }
  async set(selected, value) {
    assert.equal(selected, key, 'Initialization must not create a command journal')
    await this.records.replace('record.json', JSON.stringify(value))
    const assignment = Object.values(value.initial)[0]
    if (assignment?.initialSignal?.prepared) checkpoint('after-prepared-save')
    else if (assignment?.initialSignal) checkpoint('after-reservation')
    else if (assignment) checkpoint('after-retirement')
  }
  async list() { throw new Error('Host initialization must not scan its record store') }
}
async function harness(root, fault = false) {
  const files = new PhysicalLocalFiles(path.join(root, 'files')), storage = new DiskHostRecords(root)
  const events = [], errors = [], observed = []
  const actions = { startup: async () => {}, observe: async () => {}, executing: () => false,
    wake: async wake => { events.push(wake); return true }, sealBusiness: async () => {},
    clean: async () => false, releaseTask: async () => {}, error: error => errors.push(error),
    taskStateObserved: async task => observed.push(task), initializeWorkspace: async () => {} }
  const loop = new FrameworkHostLoop(files, new FrameworkTransactions(files, storage, scope), storage,
    { member: 'owner', primary: true, scope, instanceUUID: '20000000-0000-4000-8000-000000000002' }, () => ['owner', 'other'], actions)
  files.list = async () => { throw new Error('No recursive business-file scan belongs to initialization') }
  if (fault) {
    const update = files.update.bind(files), create = files.createIfAbsent.bind(files), rename = files.rename.bind(files)
    files.update = async (logical, decide) => { const result = await update(logical, decide); if (logical.startsWith('tasks/') && logical.endsWith('.md')) checkpoint('after-source'); return result }
    files.createIfAbsent = async (logical, content) => {
      const result = await create(logical, content)
      if (logical.endsWith('_Inbox/' + 'owner_' + taskIdentity(await read(root, 'tasks/example_P.md') ?? '') + '.md')) checkpoint('after-inbox')
      if (logical.startsWith('tasks/') && logical.endsWith('.json')) checkpoint('after-metadata')
      if (logical.includes('/.initial-signal-')) checkpoint('after-temporary')
      return result
    }
    files.rename = async (from, to) => {
      const result = await rename(from, to)
      if (process.argv[4] === 'after-consumption') { await files.delete(to); checkpoint('after-consumption') }
      checkpoint('after-publication'); return result
    }
  }
  return { files, storage, loop, events, errors, observed,
    async start() { await loop.start(); await loop.firstPoll },
    async close() { await loop.stop(); await files.close() } }
}

const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'dss-initial-handoff-'))
const results=[]
const seeded=async name=>{
 const root=path.join(sandbox,name),h=await harness(root)
 await h.files.replace('tasks/example_P.md',body)
 h.loop.actions.wake=async wake=>{h.events.push(wake);for(const src of wake.sources)await h.files.delete(src.path);return true}
 const snapshot=await h.files.snapshot(),entry=await h.files.fileMetadata('tasks/example_P.md')
 await snapshot.release()
 return {root,h,entry,revision:snapshot.revision}
}
const drain=async h=>{await Promise.all([...h.loop.taskOperations])}
try{
 {
  const {h,entry,revision}=await seeded('immediate')
  try{
   const first=h.loop.startSource(entry,revision),duplicate=h.loop.startSource(entry,revision)
   check(first===duplicate,true)
   await first;await drain(h)
   check(h.events.map(e=>e.role),process.env.DSS_EXPECT_BASELINE?[]:['Planner'])
   if(!process.env.DSS_EXPECT_BASELINE){
    await h.loop.startSource(entry,revision);await drain(h)
    check(h.events.length,1)
   }
   results.push({case:'direct handoff before another poll; duplicate source same promise',wakes:h.events.length})
  }finally{await h.close()}
 }
 if(!process.env.DSS_EXPECT_BASELINE){
  for(const phase of ['cancelled','stopping','workspace-failure','metadata-failure']){
   const {h,entry,revision}=await seeded(phase)
   try{
    if(phase==='cancelled')h.loop.actions.initializeWorkspace=async task=>{await h.files.replace(paths.task(task.taskId),JSON.stringify({...task,status:'cancelled'}))}
    if(phase==='stopping')h.loop.actions.initializeWorkspace=async()=>{h.loop.stopping=true}
    if(phase==='workspace-failure')h.loop.actions.initializeWorkspace=async()=>{throw Error('controlled workspace failure')}
    if(phase==='metadata-failure'){
     const metadata=h.files.fileMetadata.bind(h.files);let once=true
     h.files.fileMetadata=async target=>{if(target.endsWith('.json')&&once){once=false;throw Error('controlled metadata failure')}return metadata(target)}
    }
    const outcome=await h.loop.startSource(entry,revision).then(()=>({}),error=>({error:error.message}))
    await drain(h)
    check(h.events.some(e=>e.role==='Planner'),false)
    if(phase.endsWith('failure')){
     check(outcome.error,'controlled '+(phase==='workspace-failure'?'workspace':'metadata')+' failure')
     h.loop.actions.initializeWorkspace=async()=>{}
     await h.loop.poll()
     check(h.events.filter(e=>e.role==='Planner').length,1)
     await h.loop.poll()
     check(h.events.filter(e=>e.role==='Planner').length,1)
    }
    results.push({case:phase,...outcome,roles:h.events.map(e=>e.role)})
   }finally{await h.close()}
  }
 }
 console.log(JSON.stringify({status:'passed',assertions,results,loaded:Object.fromEntries(loaded),scope:'Real physical files and Host source/task lanes; controlled StoragePort and admission callbacks. No DSH host process or model bridge.'},null,2))
}finally{hooks.deregister();await fs.rm(sandbox,{recursive:true,force:true})}
