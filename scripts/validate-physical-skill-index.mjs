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
    if (specifier === '@deepseek-ai/dsh-scope') return {url:data('export const scopeOf=scope=>scope.agent'),shortCircuit:true}
    if (specifier === '@deepseek-ai/dsh-skill') return {url:data('export const isSkillName=name=>typeof name==="string" && /^[a-z0-9][a-z0-9-]*$/.test(name)'),shortCircuit:true}
    if (specifier === 'yaml') return {url:data('export const parse=JSON.parse'),shortCircuit:true}
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

const {initializeFrameworkSkillIndex,frameworkSkillIndexPath}=await import('../src/framework/skills.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-physical-skill-index-')),files=new PhysicalLocalFiles(scratch)
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const read=p=>withSnapshot(files,s=>files.read(s,p)),transactions={run(){throw Error('Physical catalog initializer reached a generic transaction')}}
try{
 const body='---\n'+JSON.stringify({name:'original-skill',description:'Original actual instruction'})+'\n---\nKeep this original body byte-for-byte.\n'
 await files.replace('skills/original/SKILL.md',body)
 await files.replace('technical/skills/controls.json','{"version":1,"entries":{"skills/original/SKILL.md":{"status":"disabled"}}}')
 let result=await initializeFrameworkSkillIndex(files,transactions);check(result.status,'created');check(result.issues,[])
 const index=JSON.parse(await read(frameworkSkillIndexPath));check(index.entries.map(x=>x.path),['skills/original/SKILL.md'])
 check(await read('skills/original/SKILL.md'),body);check(JSON.parse(await read('technical/skills/controls.json')).entries['skills/original/SKILL.md'].status,'disabled')
 const original=files.list.bind(files);files.list=async()=>{throw Error('Valid catalog must not rescan skill bodies')}
 const version=(await files.fileInfo(frameworkSkillIndexPath)).version
 check((await initializeFrameworkSkillIndex(files,transactions)).status,'unchanged');check((await files.fileInfo(frameworkSkillIndexPath)).version,version);files.list=original
 await files.replace(frameworkSkillIndexPath,'broken original derived catalog')
 result=await initializeFrameworkSkillIndex(files,transactions);check(result.status,'rebuilt');check(JSON.parse(await read(frameworkSkillIndexPath)),index)
 await files.delete(frameworkSkillIndexPath)
 const concurrent=await Promise.all(Array.from({length:6},()=>initializeFrameworkSkillIndex(files,transactions)))
 check(concurrent.filter(x=>x.status==='created').length,1);check(concurrent.filter(x=>x.status==='unchanged').length,5)
 await files.delete(frameworkSkillIndexPath);const controller=new AbortController();controller.abort(new Error('cancelled'))
 await assert.rejects(initializeFrameworkSkillIndex(files,transactions,controller.signal),/cancelled/);assertions++;check(await read(frameworkSkillIndexPath),undefined)
 const legacyPath='skills/old/record.json',legacyBytes=JSON.stringify({schemaVersion:1,kind:'skill',versions:[{status:'active',body:'Actual preserved original'}]})
 await files.replace(legacyPath,legacyBytes)
 await files.replace(frameworkSkillIndexPath,JSON.stringify({version:1,entries:[{path:legacyPath,kind:'legacy',name:'old',description:'Old obsolete catalog row',invocation:{modelInvocable:true,userInvocable:true},scope:{assistantId:'a',workspaceId:'w'}}]}))
 check((await initializeFrameworkSkillIndex(files,transactions)).status,'rebuilt')
 check(JSON.parse(await read(frameworkSkillIndexPath)).entries.map(entry=>entry.path),['skills/original/SKILL.md'])
 check(await read(legacyPath),legacyBytes)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual skill initializer/catalog parser, physical files and per-file update path. YAML and native skill-name/scope imports are explicit controlled ports with JSON-compatible YAML fixture. No native DSH/Windows/full typecheck acceptance.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await files.close();await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
