import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Current explicit manual cleanup contract: original confirmed selections only,
// no general transaction, no completed-file receipt and no global archive scan.
// Production methods use real Linux files. Native/SDK/parser dependencies below
// are controlled ports, not native DSH UI or Windows acceptance.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const data = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
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
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { FrameworkConversation } = await import('../src/framework/conversation.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { taskHistoryChange } = await import('../src/framework/task-history.ts')
const { frameworkStorageUsage } = await import('../src/framework/maintenance.ts')
const { withSnapshot, withOperationChannel } = await import('../src/framework/transactions.ts')
// Execute the current runtime's actual reset lifecycle and same-role queue.
// Only its technical KV storage is a physical fixture; no native Agent exists
// in these retired/no-active-Foreground scenarios, so no fake stop is asserted.
const hash=value=>createHash('sha256').update(value).digest('hex')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',root),'utf8')
loaded.set('framework/role-runtime.ts',hash(runtimeSource))
const runtimeJs=stripTypeScriptTypes(runtimeSource,{mode:'transform'})
function method(name){
 const match=new RegExp('\\n    (?:async )?'+name+'\\(').exec(runtimeJs);assert.ok(match,'actual runtime method '+name)
 const start=match.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(runtimeJs.slice(start+match[0].length));assert.ok(next)
 return runtimeJs.slice(start,start+match[0].length+next.index)
}
const Runtime=new Function('hash','withOperationChannel','return class {\n'+['roleKey','serialWork','isForegroundResetComplete','withForegroundReset'].map(method).join('\n')+'\n}')(hash,withOperationChannel)
const runtimeFor=(files,conversation)=>{
 const directory=path.join(files.directory,'.fixture-native-runtime'),filename=key=>path.join(directory,Buffer.from(key).toString('base64url')+'.json')
 const records={
  async get(key){try{return JSON.parse(await fs.readFile(filename(key),'utf8')).value}catch(error){if(error.code==='ENOENT')return;throw error}},
  async set(key,value){await fs.mkdir(directory,{recursive:true});await fs.writeFile(filename(key),JSON.stringify({key,value}))},
  async list(prefix){let names;try{names=await fs.readdir(directory)}catch(error){if(error.code==='ENOENT')return [];throw error}return (await Promise.all(names.map(name=>fs.readFile(path.join(directory,name),'utf8').then(JSON.parse)))).filter(row=>row.key.startsWith(prefix))},
 }
 return Object.assign(new Runtime(),{files,conversation,records,config:{mode:'local'},prefix:'runtime/',roleRecords:new Map()})
}
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-missing-last-'))
try {
 const files=new PhysicalLocalFiles(path.join(scratch,'records'))
 const transactions={run(){throw new Error('Physical conversation must not use generic transactions')}}
 const conversation=new FrameworkConversation(files,transactions,{mode:'local',collaborationId:'manual'})
 const runtime=runtimeFor(files,conversation),cleanup=new FrameworkManualCleanup(files,transactions,conversation,runtime)
 const read=p=>withSnapshot(files,s=>files.read(s,p))
 const send=id=>conversation.send(id,{id,participantId:'u',createdAt:'2026-11-11T12:00:00.000Z',role:'user',recipient:'ai',text:'Body '+id})
 try {
  await send('first');await send('last')
  await conversation.saveProcessGroups('closed-groups',[
   {id:'g-first',turnId:'["session-a",1]',startedAt:'2026-11-11T12:00:00.000Z',closed:true},
   {id:'g-second',turnId:'["session-b",2]',startedAt:'2026-11-11T12:01:00.000Z',closed:true}
  ],'u')
  const expectedGroups=(await conversation.page(1)).processGroups
  assert.deepEqual(await conversation.processGroupsForForegroundReset(),expectedGroups)
  const index=JSON.parse(await read(conversation.indexPath)),last=index.messages.find(row=>row.id==='last'),first=index.messages.find(row=>row.id==='first')
  const lastEntry=JSON.parse(await read(last.path))
  await fs.unlink(path.join(files.directory,last.path))
  assert.deepEqual(await conversation.processGroupsForForegroundReset(),expectedGroups)
  const result=await cleanup.clearConversation('clear-last','clear-foreground-conversation')
  assert.equal(result.cleared,true)
  assert.deepEqual(result.missingEntries,[last.path])
  assert.deepEqual(JSON.parse(await read(conversation.indexPath)).messages,[])
  assert.equal(await read(first.path),undefined)
  assert.equal(await read(lastEntry.textPath),'Body last')
  console.log(JSON.stringify({status:'passed',missingEntry:last.path,unknownBodyRetained:true,resetMethod:'current FrameworkRoleRuntime.withForegroundReset method extracted with controlled no-active-Agent ports',capturedProcessGroups:[]},null,2))
 }finally{await files.close()}
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
