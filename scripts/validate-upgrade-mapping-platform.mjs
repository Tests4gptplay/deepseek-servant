// Actual mapping callback and actual platform name validation, with an in-memory
// StoragePort. Only process.platform is selected for filename semantics; this
// is not a Windows filesystem or complete migration/installation test.
import assert from 'node:assert/strict'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = new URL('../src/', import.meta.url), loaded = {}, hash = value => createHash('sha256').update(value).digest('hex')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url:url.href, shortCircuit:true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8'); loaded[url.slice(root.href.length)] = hash(source)
      return { format:'module', source:stripTypeScriptTypes(source, {mode:'transform',sourceUrl:url}), shortCircuit:true }
    }
    return next(url, context)
  }
})
const { rememberLocalUpgradeMapping, localUpgradeMappingKey } = await import('../src/framework/local-upgrade-mapping.ts')
const { localRecordPath } = await import('../src/framework/local-record-files.ts')
const native = Object.getOwnPropertyDescriptor(process, 'platform')
let checks = 0
const equal = (a,b) => { assert.deepEqual(a,b); checks++ }
const source = {path:'skills/original/record.json', bytes:new TextEncoder().encode('original')}
const invalidWindows = ['skills/CON','skills/name.','skills/name ','skills/a:b','skills/a?b']
try {
 for (const platform of ['linux','darwin','win32']) {
  Object.defineProperty(process, 'platform', {...native, value:platform})
  const values = new Map(), storage = { get:async key=>values.get(key), set:async(key,value)=>values.set(key,value) }
  await rememberLocalUpgradeMapping(storage,'/controlled/records',source,'original-operation',['skills/valid/SKILL.md','archives/任务.md'])
  equal(values.get(localUpgradeMappingKey('/controlled/records',source.path)).targets,['skills/valid/SKILL.md','archives/任务.md'])
  for (const name of invalidWindows) {
   const before = JSON.stringify([...values])
   if (platform === 'win32') {
    await assert.rejects(()=>rememberLocalUpgradeMapping(storage,'/controlled/records',source,'original-operation',[name]),/Windows filename/); checks++
    equal(JSON.stringify([...values]), before)
   } else {
    await rememberLocalUpgradeMapping(storage,'/controlled/records',source,'original-operation',[name]); equal(values.get(localUpgradeMappingKey('/controlled/records',source.path)).targets,[name])
   }
  }
  await assert.rejects(()=>rememberLocalUpgradeMapping(storage,'/controlled/records',source,'original-operation',['../escape']),/relative file path/);checks++
 }
 // The original map callback forwards the index as platform and demonstrably
 // bypasses the Windows-only branch. This is contrast, not a retained product path.
 Object.defineProperty(process, 'platform', {...native,value:'win32'})
 equal(['skills/CON'].map(localRecordPath),['skills/CON'])
 equal(['skills/valid'].map(path=>localRecordPath(path)),['skills/valid'])
 console.log(JSON.stringify({passed:checks,sourceHashes:loaded,scope:'actual mapping and filename semantics; no Windows filesystem'},null,2))
} finally {Object.defineProperty(process,'platform',native);hooks.deregister()}
