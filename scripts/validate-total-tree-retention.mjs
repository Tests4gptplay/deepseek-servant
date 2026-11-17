import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Controlled tree retention/cleanup coverage with plain text and byte originals.
// Markdown link parsing is deliberately not exercised; real parser absent.
// Current requirement: child P/O success/cancellation only hands status/results
// to its parent. Only a root starts Foreground + Recorder and eventual Cleaner.
// Exercises current retention and Cleaner helpers with in-memory FilesStore.
// Does not invoke dss_complete, dss_recorder_save, cancelTask, or the Host's
// terminal scan. Native DSH, schema validation, physical storage, Git transport
// and full typechecking are outside this controlled check.
const sourceRoot = new URL('../src/', import.meta.url)
const loaded = new Map()
const schemaStub = `
const schema = new Proxy(function () {}, {
  get(_target, key) { if (key === 'parse') return value => value; if (key === 'toJSONSchema') return () => ({}); return schema },
  apply() { return schema }
}); export const z = schema;
`
const skillsStub = `
export function isFrameworkSkillDefinitionPath(){throw new Error("Skill definition classification is outside this focused test")} export const frameworkSkillIndexPath = 'skills/index.md';
export async function prepareFrameworkSkillIndex() { throw new Error('Skill publication is outside this focused validation'); }
`
const dataModule = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: dataModule(schemaStub), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: dataModule("export function fromMarkdown(text) { if (text.includes('](')) throw new Error('Linked Markdown is outside this focused validation'); return {type:'root',children:[]}; }"), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', sourceRoot).href) return { url: dataModule(skillsStub), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  }
})
const {paths,encodeJson,taskWorkingRoots}=await import('../src/framework/task-files.ts')
const {prepareRecorderRetention,readArchivedReference}=await import('../src/framework/recorder-retention.ts')
const {observeCleanup,FrameworkCleaner}=await import('../src/framework/cleaner.ts')
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
let assertions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,p)=>{await assert.rejects(fn,p);assertions++}
class Files {
 data=new Map(); revision=0; reads=[]
 put(path,value){this.data.set(path,typeof value==='string'?Buffer.from(value):Buffer.from(value));this.revision++}
 async snapshot(){return{revision:String(this.revision),data:new Map(this.data),release:async()=>{}}}
 async readBytes(s,p){this.reads.push(p);return s.data.get(p)}
 async read(s,p){const b=await this.readBytes(s,p);return b===undefined?undefined:new TextDecoder('utf8',{fatal:true}).decode(b)}
 async list(s,p){const prefix=p.replace(/\/$/,'')+'/';return[...s.data].filter(([x])=>x.startsWith(prefix)).map(([path,b])=>({path,version:createHash('sha256').update(b).digest('hex'),bytes:b.length,empty:b.length===0}))}
 async listDirectory(s,p){const prefix=p.replace(/\/$/,'')+'/';return(await this.list(s,p)).filter(e=>!e.path.slice(prefix.length).includes('/'))}
 async commit(_s,changes){for(const c of changes){if(c.deleteTree){for(const path of this.data.keys())if(path.startsWith(c.path+'/'))this.data.delete(path)}else c.content===null?this.data.delete(c.path):this.put(c.path,c.bytes??c.content)}return{revision:String(this.revision),replay:false}}
}
const ids=[1,2,3,4].map(n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'))
const mk=(n,route,owner,parent)=>({version:1,taskId:ids[n],route,owner,status:'complete',sourcePath:`tasks/${ids[n]}_${route}.md`,archiveFolder:parent?`${ids[0]}/${ids[n]}`:ids[n],members:[owner],...(parent?{parent}: {})})
function fixture(){
 const root=mk(0,'O','A'),child=mk(1,'O','B',{taskId:ids[0],owner:'A',objectiveId:'one'}),leaf=mk(2,'P','C',{taskId:ids[1],owner:'B',objectiveId:'two'}),other=mk(3,'P','D')
 root.children=[{objectiveId:'one',taskId:child.taskId,member:'B'}];child.children=[{objectiveId:'two',taskId:leaf.taskId,member:'C'}]
 const f=new Files();for(const t of [root,child,leaf,other]){f.put(paths.task(t.taskId),encodeJson(t));f.put(t.sourcePath,'Task ID: '+t.taskId+'\noriginal');for(const r of taskWorkingRoots(t))f.put(r+'/ordinary.md','runtime '+t.taskId);f.put(paths.run(t.taskId)+'/.command-receipts/lifecycle/host/call.json','not a user record')}
 f.put('skills/user/SKILL.md','skill stays');f.put('debug/2026-11-08.md','debug stays');f.put('state/Foreground_Task_'+root.taskId,'');f.put('conversations/shared.md','chat stays')
 return{f,root,child,leaf,other}
}
try {
 const {f,root,child,leaf,other}=fixture();const original=Uint8Array.from([0,255,1,128]),target=paths.run(leaf.taskId)+'/result.bin',zero=paths.run(child.taskId)+'/empty.bin'
 f.put(target,original);f.put(zero,new Uint8Array());f.put(paths.state('C',leaf.taskId)+'/Worker_1','')
 child.workspaceResults=[{path:'/user/child-result',owner:'B',instanceUUID:ids[3]}];f.put(paths.task(child.taskId),encodeJson(child))
 root.resultPaths=[target];f.put(paths.task(root.taskId),encodeJson(root));const s=await f.snapshot()
 const outputs=[{path:paths.archive(root)+'/records.md',content:'root record'},{path:paths.archive(child)+'/records.md',content:'selected child record'}]
 const p=await prepareRecorderRetention(f,s,root,{outputs:outputs.map(x=>x.path),retainedPaths:[target,zero,paths.state('C',leaf.taskId)]},outputs)
 const moved=p.retention.relocatedReferences[target];check(moved.startsWith(paths.archive(leaf)+'/retained/'),true)
 check(Buffer.from(p.changes.find(c=>c.path===moved).bytes),Buffer.from(original))
 check(p.changes.find(c=>c.path===p.retention.relocatedReferences[zero]).bytes.byteLength,0)
 check(p.retention.workspaceResults,child.workspaceResults)
 check(p.changes.some(c=>c.path===paths.archive(child)+'/records.md'),true)
 check(p.changes.some(c=>c.path.endsWith('/Worker_1')),false)
 check(p.retention.relocatedReferences[paths.run(child.taskId)+'/ordinary.md'],undefined)
 check(p.retention.relocatedReferences[paths.run(leaf.taskId)+'/ordinary.md'],undefined)
 check(p.changes.some(c=>c.path.includes(other.taskId)),false)
 check(f.reads.some(path=>path.includes(other.taskId)),false)
 check(p.task.resultPaths,[moved])
 await rejects(()=>prepareRecorderRetention(f,s,root,{outputs:[],retainedPaths:[paths.run(leaf.taskId)+'/.command-receipts/lifecycle/host/call.json']},[]),/command receipts/)
 await rejects(()=>prepareRecorderRetention(f,s,root,{outputs:[],retainedPaths:[paths.archive(child)+'/state.json']},[]),/Program state/)
 await rejects(()=>prepareRecorderRetention(f,s,root,{outputs:[],retainedPaths:[]},[{path:paths.archive(other)+'/records.md',content:'outside'}]),/outside this total Task tree/)
 await f.commit(s,[...p.changes,{path:paths.archive(root)+'/retention.json',content:encodeJson(p.retention)}]);let current=await f.snapshot()
 check(Buffer.from(await readArchivedReference(f,current,leaf.taskId,target)),Buffer.from(original))
 // No child Recorder or child Cleaner is required, and a stale child signal cannot start cleanup.
 f.put(paths.state(child.owner,child.taskId)+'/Cleaner','');current=await f.snapshot()
 check((await observeCleanup(f,current,child,performance.now())).status,'not-requested')
 check((await observeCleanup(f,current,root,performance.now())).status,'not-requested')
 f.put(paths.state(root.owner,root.taskId)+'/Cleaner','');current=await f.snapshot()
 const plan=await observeCleanup(f,current,root,performance.now());check(plan.error,undefined);check(plan.family.map(t=>t.taskId),[root.taskId,child.taskId,leaf.taskId]);check(plan.status,'delete')
 for(const t of [root,child,leaf])for(const r of taskWorkingRoots(t))check(plan.publication.changes.some(c=>c.path===r&&c.content===null&&c.deleteTree===true),true)
 check(plan.publication.changes.some(c=>c.path.startsWith('archives/')&&c.content===null),false)
 for(const path of ['skills/user/SKILL.md','debug/2026-11-08.md','conversations/shared.md','state/Foreground_Task_'+root.taskId,paths.run(other.taskId)+'/ordinary.md'])check(plan.publication.changes.some(c=>c.path===path),false)
 const transactions={runObservedFinalization:async(_id,_req,s,build)=>f.commit(s,await build(s))}
 const cleaner=new FrameworkCleaner(f,transactions)
 check((await cleaner.clean(root,plan)).status,'deleted')
 current=await f.snapshot();const confirmed=await observeCleanup(f,current,root,performance.now()+10);check(confirmed.error,undefined);check(confirmed.status,'files-cleaned')
 check((await cleaner.clean(root,confirmed)).status,'deleted')
 current=await f.snapshot();for(const t of [root,child,leaf]){check((await readTaskCleanupRecord(f,current,t)).phase,'files-cleaned');for(const r of taskWorkingRoots(t))check((await f.list(current,r)).length,0)}
 check(Buffer.from(await readArchivedReference(f,current,leaf.taskId,target)),Buffer.from(original))
 for(const path of [moved,paths.archive(root)+'/records.md',paths.archive(child)+'/records.md','skills/user/SKILL.md','debug/2026-11-08.md','conversations/shared.md','state/Foreground_Task_'+root.taskId,paths.run(other.taskId)+'/ordinary.md'])check(f.data.has(path),true)
 const unfinished=fixture();unfinished.child.status='running';unfinished.f.put(paths.task(unfinished.child.taskId),encodeJson(unfinished.child));unfinished.f.put(paths.state('A',unfinished.root.taskId)+'/Cleaner','');
 const unfinishedView=await unfinished.f.snapshot();const blocked=await observeCleanup(unfinished.f,unfinishedView,unfinished.root,performance.now());
 check(blocked.error,undefined);check(blocked.status,'delete');check(blocked.publication.changes.some(c=>c.path===paths.run(unfinished.child.taskId)&&c.content===null&&c.deleteTree===true),true)
 console.log(JSON.stringify({status:'passed',assertions,scope:'Current retention and Cleaner code; controlled memory FilesStore; plain text only, Markdown parser/schema stubbed; no native Host/Windows/physical backend integration',sourceHashes:Object.fromEntries(loaded)},null,2))
} finally {hooks.deregister()}
