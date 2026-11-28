import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
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
const { pendingLocalTaskViews, pendingLocalTaskResult } = await import('../src/framework/legacy-local-task-view.ts')
const { localTaskUpgradeKey }= await import('../src/framework/local-upgrade-task.ts')
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
try {
 const f=await fixture('legacy-task','running'),id=f.task.taskId,errors=[]
 const before=hash(await fs.readFile(path.join(f.directory,'dss-files.sqlite')))
 const report=await pendingLocalTaskViews(f.directory,f.records,new Set(),e=>errors.push(e),undefined,[id])
 check('Exact original Task metadata survives',report[0].task,f.task);check('No source errors',errors,[])
 check('Original result bytes available',Buffer.from(await pendingLocalTaskResult(f.directory,f.records,id,f.task.resultPaths[0])).toString(),'independent result')
 await assert.rejects(()=>pendingLocalTaskResult(f.directory,f.records,id,'task-runs/unrelated/keep.txt'),/not a recorded result/)
 check('Current Task wins over original lookup',await pendingLocalTaskViews(f.directory,f.records,new Set([id]),e=>errors.push(e),undefined,[id]),[])
 check('Read-only access did not mutate SQL',hash(await fs.readFile(path.join(f.directory,'dss-files.sqlite'))),before)
 check('Read-only access did not publish physical metadata',existsSync(path.join(f.directory,'tasks/old-task.json')),false)
 await f.records.set(localTaskUpgradeKey(f.directory,id),{kind:'dss-once-task-layout',directory:f.directory,taskId:id,status:'complete'})
 check('Historically restored Task does not resurface',await pendingLocalTaskViews(f.directory,f.records,new Set(),e=>errors.push(e),undefined,[id]),[])
 console.log(JSON.stringify({status:'passed',assertions:names.length+1,names,scope:'read-only historical task and original result'},null,2))
}finally{hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
