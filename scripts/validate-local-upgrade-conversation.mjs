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
const { LegacyLocalConversationView } = await import('../src/framework/legacy-local-conversation-view.ts')
const { assessLocalUpgradeCompletion, retireLocalUpgradeRecords, localUpgradeResultKey } = await import('../src/framework/local-upgrade-completion.ts')
const { restoreLegacyConversationScope } = await import('../src/framework/local-upgrade-conversation.ts')
const { materializeLegacyLocalFiles } = await import('../src/framework/local-startup-upgrade.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { appendConversationContext, emptyConversationContext } = await import('../src/framework/conversation-context.ts')
const { withLegacySqliteSnapshot } = await import('../src/framework/legacy-sqlite-reader.ts')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-upgrade-conversation-'))
const names=[],check=(name,a,b)=>{assert.deepEqual(a,b);names.push(name)}
const hash=value=>createHash('sha256').update(value).digest('hex'),json=value=>JSON.stringify(value,null,2)+'\n'
class Records {
 records=new Map();afterSave
 async get(k){return structuredClone(this.records.get(k))}
 async set(k,v){this.records.set(k,structuredClone(v));await this.afterSave?.(k,v)}
 async list(){throw Error('No host-record scan')}
 async delete(k){this.records.delete(k)}
}
const transactions={run(){throw Error('Physical conversation must not enter SQL transaction')}}
async function fixture(name){
 const directory=path.join(scratch,name);await fs.mkdir(directory,{recursive:true})
 const database=path.join(directory,'dss-files.sqlite'),db=new DatabaseSync(database)
 db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT')
 const put=(p,v)=>{const b=Buffer.isBuffer(v)?v:Buffer.from(typeof v==='string'?v:json(v));db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p,'','fixture',b.length,b)}
 const index={version:1,messages:[],processGroups:[{id:'original-process',turnId:'original-turn',participantId:'old-user',startedAt:'2026-11-07T00:00:00.000Z',closed:true}]}
 let context=emptyConversationContext();const bodies=new Map(),entries=[]
 for(const [id,body] of [['first','\uFEFF原文😀\r\n\0keep'],['second',''],['third','后来的输入']]){
  const folder='conversations/local/old-user/2026-11-07/20261107000000-'+id,entryPath=folder+'/entry.json',textPath=folder+'/text'
  const msg={id,participantId:'old-user',createdAt:'2026-11-07T00:00:00.000Z',role:'user',recipient:'ai',model:'original',custom:'retained'}
  const next=appendConversationContext(context,msg,entryPath);context=next.index
  const entry={...msg,collaborationId:'old-chat',conversationContext:next.provenance,textPath,textHash:hash(body)}
  const chunks=[textPath+'/parts/002.txt',textPath+'/parts/001.txt'],letters=Array.from(body),split=Math.floor(letters.length/2)
  put(chunks[0],Buffer.from(letters.slice(0,split).join('')));put(chunks[1],Buffer.from(letters.slice(split).join('')));put(textPath+'/manifest.json',{version:1,sha256:hash(body),characters:body.length,chunks:chunks.map(p=>'dss-coop/'+p)})
  put(entryPath,entry);index.messages.push({id,path:entryPath,createdAt:msg.createdAt,role:msg.role});bodies.set(id,body);entries.push({entryPath,textPath,entry})
 }
 const indexPath='conversation-index/local/old-chat/index.json',contextPath='conversation-context/local/old-chat/index.json'
 put(indexPath,index);put(contextPath,context);put('future/untouched','unknown original');db.close()
 const records=new Records(),files=new PhysicalLocalFiles(directory),conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'old-chat'})
 return {directory,database,records,files,conversation,index,indexPath,contextPath,entries,bodies}
}
try{
 const f=await fixture('scope-first'),before=hash(await fs.readFile(f.database)),published=[]
 const originalView=new LegacyLocalConversationView(f.directory,'old-chat')
 check('Old history remains readable before conversion',(await originalView.page(10)).messages.map(m=>m.id),['first','second','third'])
 check('Old read preserves BOM and full source',(await originalView.message('first')).text,f.bodies.get('first'))
 check('Old text port reads without a writer',(await originalView.text('first')).text,f.bodies.get('first'))
 check('Old search reads without conversion',(await originalView.search('原文')).matches.map(m=>m.message.id),['first'])
 check('Old context retains original positions',(await originalView.context()).current,['first','second','third'])
 check('Old view creates no physical index',existsSync(path.join(f.directory,f.indexPath)),false)
 check('Old view creates no migration state',f.records.records.size,0)
 const r=await restoreLegacyConversationScope(f.directory,'old-chat',f.records,{onProgress:p=>{if(p.step==='published')published.push(p.path)}})
 check('Scope conversion completes',r.status,'complete');check('All original entries converted',r.converted,3)
 check('Actual legacy participant/day entry paths and index order survive',(await f.conversation.page(9)).messages.map(m=>m.id),['first','second','third'])
 for(const [id,body] of f.bodies) check('Complete original bytes '+id,(await f.conversation.read(id)).text,body)
 check('Context positions and refs survive',(await f.conversation.foregroundContext()).current,['first','second','third'])
 check('Shared index is published last',published.at(-1),f.indexPath)
 check('Shared context precedes index',published.at(-2),f.contextPath)
 check('No legacy chunks are created during scope conversion',existsSync(path.join(f.directory,f.entries[0].textPath)),false)
 check('Original SQL bytes unchanged',hash(await fs.readFile(f.database)),before)
 const first=JSON.parse(await fs.readFile(path.join(f.directory,f.entries[0].entryPath),'utf8'))
 check('Metadata/custom guides unchanged outside textPath',first,{...f.entries[0].entry,textPath:f.entries[0].entryPath.replace('entry.json','text.txt')})
 const edited='用户手动编辑正文😀';await fs.writeFile(path.join(f.directory,first.textPath),edited)
 check('Edited converted text reads by message',(await f.conversation.read('first')).text,edited)
 check('Edited converted text reads by page',(await f.conversation.page(9)).messages[0].text,edited)
 check('Edited converted text reads by text',(await f.conversation.readText('first')).text,edited)
 check('Edited converted text is searchable',(await f.conversation.search('手动编辑')).matches.map(m=>m.message.id),['first'])
 check('Edited converted text reads by context',(await f.conversation.foregroundContext()).messages[0].text,edited)
 await f.conversation.send('new',{id:'new',participantId:'user',createdAt:'2026-11-08T00:00:00.000Z',role:'user',recipient:'ai',text:'new physical'})
 check('New same-scope send follows restored history',(await f.conversation.page(9)).messages.map(m=>m.id),['first','second','third','new'])
 const material=await materializeLegacyLocalFiles(f.directory,f.records)
 check('Later all-file export recognizes actual source conversions',material.status,'complete')
 check('Later export does not recreate mapped chunks',existsSync(path.join(f.directory,f.entries[0].textPath)),false)
 check('Later export cannot overwrite edited physical body',(await f.conversation.read('first')).text,edited)
 check('Later export cannot rewind independently changed index',(await f.conversation.page(9)).messages.map(m=>m.id),['first','second','third','new'])
 check('Unclassified safe original is still exported',await fs.readFile(path.join(f.directory,'future/untouched'),'utf8'),'unknown original')
 await fs.unlink(path.join(f.directory,first.textPath));check('Completed scope is not a permanent hash check',(await restoreLegacyConversationScope(f.directory,'old-chat',f.records)).status,'complete')
 check('Completed restoration never resurrects removed user file',existsSync(path.join(f.directory,first.textPath)),false)
 const completion=await assessLocalUpgradeCompletion(f.directory,f.records)
 check('Finish recognizes every converted scope',completion.pending,[])
 const done={kind:'dss-local-upgrade-result',directory:f.directory,operationId:'fixture-finished-native-owner',completedAt:new Date().toISOString(),report:completion.report,cleanup:completion.cleanup}
 await f.records.set('fixture-wake',{kind:'fixture'});await retireLocalUpgradeRecords(f.records,done,'fixture-wake')
 check('Retirement removes wake/scope/export state but retains source-audit mappings',[...f.records.records.values()].every(v=>v.kind==='dss-local-upgrade-result'||v.kind==='dss-once-source-mapping'),true)
 check('Source-audit mappings are explicitly retained in final result',f.records.records.get(localUpgradeResultKey(f.directory)).retainedSourceMappings.length>0,true)
 check('Retirement does not revive original SQL on next request',(await restoreLegacyConversationScope(f.directory,'old-chat',f.records)).status,'complete')
 check('Completed SQL source remains retained',existsSync(f.database),true)
 await f.files.close()
 const prior=await fixture('export-first');await materializeLegacyLocalFiles(prior.directory,prior.records)
 const customized={...prior.entries[0].entry,custom:'user-modified'};await fs.writeFile(path.join(prior.directory,prior.entries[0].entryPath),json(customized))
 check('Already exported entries can convert',(await restoreLegacyConversationScope(prior.directory,'old-chat',prior.records)).status,'complete')
 check('Current physical metadata is preserved',JSON.parse(await fs.readFile(path.join(prior.directory,prior.entries[0].entryPath),'utf8')).custom,'user-modified')
 await prior.files.close()
 const bad=await fixture('invalid-manifest'),db=new DatabaseSync(bad.database)
 db.prepare('UPDATE files SET binary=? WHERE path=?').run(Buffer.from(json({version:1,sha256:hash('wrong'),characters:3,chunks:[]})),bad.entries[0].textPath+'/manifest.json');db.close()
 const blocked=await restoreLegacyConversationScope(bad.directory,'old-chat',bad.records)
 check('Invalid manifest remains incomplete',blocked.status,'incomplete');check('No partial scope index is exposed',existsSync(path.join(bad.directory,bad.indexPath)),false)
 check('No empty replacement scope is created',(await restoreLegacyConversationScope(bad.directory,'unrelated-new',bad.records)).status,'not-needed')
 await bad.files.close()
 const abort=await fixture('abort'),controller=new AbortController()
 await assert.rejects(()=>restoreLegacyConversationScope(abort.directory,'old-chat',abort.records,{signal:controller.signal,onProgress:p=>{if(p.step==='written')controller.abort(Error('fixture cancelled'))}}),/fixture cancelled/);names.push('Mid-publication cancellation propagates, not a source-row')
 check('Cancellation never marks scope complete',[...abort.records.records.values()].some(v=>v.kind==='dss-once-conversation-full-text'&&v.status==='complete'),false)
 check('Cancelled scope resumes actual work',(await restoreLegacyConversationScope(abort.directory,'old-chat',abort.records)).status,'complete');await abort.files.close()
 await withLegacySqliteSnapshot(abort.database,async s=>{check('Addressed reader returns exact row',(await s.read('future/untouched')).path,'future/untouched');check('Addressed reader returns absent path',await s.read('missing'),undefined)})
 console.log(JSON.stringify({status:'passed',assertions:names.length,names,platform:process.platform,runtime:process.version,limits:'Controlled Linux fixtures and native-rename test bridge; no actual DSH/model/Windows/addon, power-loss or dependency-backed typecheck acceptance.',sourceHashes:Object.fromEntries([...loaded].sort()),scriptHash:hash(readFileSync(fileURLToPath(import.meta.url)))},null,2))
}finally{hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
