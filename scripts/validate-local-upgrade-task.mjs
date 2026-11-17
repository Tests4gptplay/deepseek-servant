import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Real production conversation methods and Linux physical files. Markdown's
// parser, native DSH imports and unrelated role tools are explicit controlled
// ports. These checks do not claim native UI/Windows/typecheck acceptance.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'koffi') return {url:new URL('./helpers/fixture-no-replace-koffi.mjs',import.meta.url).href,shortCircuit:true}
    if (specifier === 'zod') return {url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true}
    if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){const children=[];for(const m of text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g))children.push({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}});return {type:'root',children}}`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/role-tools.ts',root).href) return {url:data(`export function workerPaths(){throw new Error('Worker paths are outside this controlled conversation check')}`),shortCircuit:true}
      if (existsSync(fileURLToPath(url))) return {url:url.href,shortCircuit:true}
    }
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url.startsWith(root.href)&&url.endsWith('.ts')) {
      const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(root.href.length),createHash('sha256').update(source).digest('hex'))
      return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
    }
    return next(url,context)
  },
})
const { restoreLegacyTask } = await import('../src/framework/local-upgrade-task.ts')
const { materializeLegacyLocalFiles } = await import('../src/framework/local-startup-upgrade.ts')
const { assessLocalUpgradeCompletion } = await import('../src/framework/local-upgrade-completion.ts')
const { taskHistoryPath } = await import('../src/framework/task-history.ts')
const { withLegacySqliteSnapshot } = await import('../src/framework/legacy-sqlite-reader.ts')
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-upgrade-task-')),names=[]
const check=(n,a,b)=>{assert.deepEqual(a,b);names.push(n)},hash=s=>createHash('sha256').update(s).digest('hex'),json=v=>JSON.stringify(v,null,2)+'\n'
class Records { data=new Map();async get(k){return structuredClone(this.data.get(k))} async set(k,v){this.data.set(k,structuredClone(v))}async list(){throw Error('No unrelated record scan')}}
const host=JSON.stringify(['local','actual-scope','actual-instance'])
async function fixture(name,status,released=false,peer=false){
 const directory=path.join(scratch,name);await fs.mkdir(directory,{recursive:true});const db=new DatabaseSync(path.join(directory,'dss-files.sqlite'))
 db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT')
 const entries=new Map(),put=(p,v)=>{const bytes=Buffer.from(typeof v==='string'?v:json(v));entries.set(p,bytes);db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,'','fixture',bytes.length,bytes)}
 const task={version:1,taskId:'old-task',route:'P',sourcePath:'actual-source_old-task.md',owner:'actual-owner',status,lifecycleId:'original-life',members:['actual-owner'],resultPaths:['archives/old-task/report.md'],custom:'keep'}
 put('tasks/old-task.json',task);put(task.sourcePath,'Original requirement');put('task-runs/old-task/actual-owner/Worker/notes.md','original work');put('Recorder Cache/old-task/links.json','[]')
 put('state/actual-owner/old-task/Planner','');put('state/Foreground_Task_old-task','');put('archives/old-task/report.md','independent result')
 put('archives/old-task/state.json',{version:1,taskId:'old-task',lifecycles:{'original-life':{hosts:{[host]:{...(released?{released:true}:{sealed:true})},...(peer?{other:{runtimeReleased:true}}:{})},...(released?{cleanup:{phase:'released'}}:{})}}})
 put('task-runs/unrelated/keep.txt','unrelated original');db.close();return {directory,entries,task,records:new Records()}
}
try{
 const active=await fixture('active','running'),order=[]
 check('Known running Task restores independently',(await restoreLegacyTask(active.directory,'old-task',host,active.records,{onProgress:p=>{if(p.step==='published')order.push(p.path)}})).disposition,'current')
 const meta=JSON.parse(await fs.readFile(path.join(active.directory,'tasks/old-task.json'),'utf8'))
 check('Current identity/source/status/custom values remain unchanged',meta,{...active.task,archiveFolder:'old-task'})
 check('Task material precedes metadata',order.indexOf('task-runs/old-task/actual-owner/Worker/notes.md')<order.indexOf('tasks/old-task.json'),true)
 check('Original source follows metadata',order.indexOf(active.task.sourcePath)>order.indexOf('tasks/old-task.json'),true)
 check('Original signals follow source',order.indexOf('state/actual-owner/old-task/Planner')>order.indexOf(active.task.sourcePath),true)
 check('No unrelated Task is scanned/materialized',existsSync(path.join(active.directory,'task-runs/unrelated')),false)
 check('An empty original signal remains a real empty file',(await fs.readFile(path.join(active.directory,'state/actual-owner/old-task/Planner'))).length,0)
 check('A terminal Task with no release remains terminal current',(await restoreLegacyTask((await fixture('terminal','complete')).directory,'old-task',host,new Records())).disposition,'current')
 const history=await fixture('released','complete',true);const restored=await restoreLegacyTask(history.directory,'old-task',host,history.records)
 check('Actual Host and cleanup release produce history',restored,{status:'complete',taskId:'old-task',disposition:'history',issues:[]})
 const identity=JSON.parse(await fs.readFile(path.join(history.directory,taskHistoryPath('old-task')),'utf8'))
 check('Existing legacy archive folder is pinned, not renamed',identity.archiveFolder,'old-task')
 check('History does not retain runtime members',Object.hasOwn(identity,'members'),false)
 check('Released Task metadata is not active',existsSync(path.join(history.directory,'tasks/old-task.json')),false)
 check('Released Task signal is not revived',existsSync(path.join(history.directory,'state/actual-owner/old-task/Planner')),false)
 check('Released Task notes stay in original SQL, not runtime',existsSync(path.join(history.directory,'task-runs/old-task')),false)
 check('Original result remains independent',await fs.readFile(path.join(history.directory,'archives/old-task/report.md'),'utf8'),'independent result')
 check('Later all export recognizes retired paths',(await materializeLegacyLocalFiles(history.directory,history.records)).status,'complete')
 check('Later all export cannot resurrect released Task',existsSync(path.join(history.directory,'tasks/old-task.json')),false)
 check('Later all export cannot resurrect stale signal',existsSync(path.join(history.directory,'state/actual-owner/old-task/Planner')),false)
 check('Full finish recognizes actual Task mapping',(await assessLocalUpgradeCompletion(history.directory,history.records)).pending,[])
 const peer=await fixture('peer','cancelled',true,true)
 check('Another actual Host not released is not guessed into history',(await restoreLegacyTask(peer.directory,'old-task',host,peer.records)).disposition,'current')
 const contradiction=await fixture('contradictory','running',true)
 check('Contradictory release never becomes running',(await restoreLegacyTask(contradiction.directory,'old-task',host,contradiction.records)).status,'incomplete')
 check('Contradictory Task remains unadmitted',existsSync(path.join(contradiction.directory,'tasks/old-task.json')),false)
 const exported=await fixture('raw-exported','complete',true);await materializeLegacyLocalFiles(exported.directory,exported.records)
 check('Previously raw-exported release is safely mapped',(await restoreLegacyTask(exported.directory,'old-task',host,exported.records)).status,'complete')
 check('Exact obsolete exported runtime file is retired',existsSync(path.join(exported.directory,'task-runs/old-task/actual-owner/Worker/notes.md')),false)
 const custom=await fixture('custom-current','complete',true);await materializeLegacyLocalFiles(custom.directory,custom.records)
 await fs.writeFile(path.join(custom.directory,'task-runs/old-task/actual-owner/Worker/notes.md'),'user edited current notes')
 check('User-edited old runtime material is retained as unresolved',(await restoreLegacyTask(custom.directory,'old-task',host,custom.records)).status,'incomplete')
 check('User-edited notes survive',await fs.readFile(path.join(custom.directory,'task-runs/old-task/actual-owner/Worker/notes.md'),'utf8'),'user edited current notes')
 await withLegacySqliteSnapshot(path.join(active.directory,'dss-files.sqlite'),async view=>{const selected=[];for await(const e of view.entries('task-runs/old-task/'))selected.push(e.path);check('SQL prefix read selects only actual Task subtree',selected,['task-runs/old-task/actual-owner/Worker/notes.md'])})
 console.log(JSON.stringify({status:'passed',assertions:names.length,names,platform:process.platform,runtime:process.version,limits:'Controlled Linux fixtures, no production startup, native model, Windows/Koffi addon or full dependency-backed typecheck.',sourceHashes:Object.fromEntries([...loaded].sort()),scriptHash:hash(readFileSync(fileURLToPath(import.meta.url)))},null,2))
}finally{hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
