import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual runtime signal-consumption methods and physical filesystem. Native DSH
// execution and unrelated parser/skill imports are explicit stubs; this does not
// claim native integration, Windows, full typecheck or production cutover.
if (!process.env.DSS_RECOVERY_DEBUG_SOURCE) throw new Error('Provide the exact source directory for the actual producer.')
const sourceRoot = pathToFileURL(path.resolve(process.env.DSS_RECOVERY_DEBUG_SOURCE) + path.sep), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const unexpected = `const no = () => { throw new Error('Native DSH is outside this controlled check') };`
const native = {
  '@deepseek-ai/dsh-session': `${unexpected} export const SessionId=x=>x, SessionLogOffset=x=>x, deriveEventMessage=no, isAppendSurfaceEvent=no;`,
  '@deepseek-ai/dsh-session-persistence': `export class SessionAlreadyOwnedError extends Error{}; export class SessionPersistenceNotFoundError extends Error{};`,
  '@deepseek-ai/dsh-agent': `${unexpected} export const installModelSelection=no;`,
  '@deepseek-ai/dsh-llm': `${unexpected} export const MessageId=x=>x, freezeMessage=no, errorChain=no;`,
  '@deepseek-ai/dsh-llm/assistant-stream': `${unexpected} export const expandAssistantStream=no;`,
}
// v56 imports the real storage adapter class. Resolve its SDK domain from the
// supplied actual Host installation; these tests still use controlled KV ports.
const sdkRequire = process.env.DSS_SDK_HOST_ROOT ? createRequire(path.join(process.env.DSS_SDK_HOST_ROOT, 'package.json')) : undefined
const storageSdkUrls = sdkRequire ? Object.fromEntries(['@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-storage-json'].map(name => [name, pathToFileURL(sdkRequire.resolve(name)).href])) : {}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (storageSdkUrls[specifier]) return { url: storageSdkUrls[specifier], shortCircuit: true }
    if (native[specifier]) return { url: data(native[specifier]), shortCircuit: true }
    if (specifier === 'zod') return { url: data(`const schema=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return schema},apply(){return schema}});export const z=schema;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`${unexpected} export const fromMarkdown=no;`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/skills.ts',sourceRoot).href) return { url:data(`${unexpected} export function isFrameworkSkillDefinitionPath(){throw new Error("Skill definition classification is outside this focused test")} export const frameworkSkillIndexPath='skills/index.md', prepareFrameworkSkillIndex=no, installFrameworkSkillProvider=no, initializeFrameworkSkillIndex=no, readFrameworkSkillCatalog=no;`),shortCircuit:true }
      if (existsSync(fileURLToPath(url))) return { url:url.href,shortCircuit:true }
    }
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')) {
      const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'))
      return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
    }
    return next(url,context)
  },
})
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts',sourceRoot))
const { FrameworkRoleRuntime } = await import(new URL('framework/role-runtime.ts',sourceRoot))
const { paths } = await import(new URL('framework/task-files.ts',sourceRoot))
const { installFrameworkRoleTools } = await import(new URL('framework/role-tools.ts',sourceRoot))
const { publishPhysicalRecovery } = await import(new URL('framework/physical-recovery.ts',sourceRoot))
const directory=path.resolve(process.argv[2]),family=process.argv[3],phase=process.argv[4]
const files=new PhysicalLocalFiles(path.join(directory,'files')),id='10000000-0000-4000-8000-000000000081',day='debug/2026-11-08.md',hash=x=>createHash('sha256').update(x).digest('hex')
const t={version:1,taskId:id,route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/legacy_P.md'},command='old-'+family
const marker=paths.state('A',id)+'/recovery',signal=paths.state('A',id)+'/Planner_Recovery_2026-11-08_legacy'
const row={key:'restores/'+command,value:{commandId:command,createdAt:'2026-11-08T10:00:00Z',complete:false,input:{facts:'original '+family+' facts',hypotheses:'unconfirmed original hypothesis',actionsTaken:'original preserved actions',continuation:'original continuation'},managerPublications:[{taskId:id,member:'A',role:'Planner'}]}}
const values=new Map(),records={get:async k=>structuredClone(values.get(k)),set:async(k,v)=>values.set(k,structuredClone(v)),list:async prefix=>[...values].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)}))}
const runtime=Object.create(FrameworkRoleRuntime.prototype);Object.assign(runtime,{files,records,closed:false,prefix:'old-fixture/',config:{member:'A',primary:true},roleRecords:new Map(),wakeConsumptions:new Map(),manuallyCleared:async()=>false})
await files.replace(paths.task(id),JSON.stringify(t));await files.replace(paths.inbox(id,'A'),'original old Inbox\n');await files.replace(day,'Original old log\r\n旧原文\r\n');await fs.writeFile(path.join(directory,'input.json'),JSON.stringify({family,phase,t,command,day,marker,signal,row},null,2))
const expectedCommand=family==='member'?command:family==='restore-debug'?'restore-debug:'+command:'host-restore-debug:'+command
const expectedFact=(family==='member'?paths.run(id):'debug')+'/.recovery/'+hash(expectedCommand)+'.json'
const evidence={source:'actual supplied runtime and physical publication',sourceRoot:fileURLToPath(sourceRoot),family,phase,expectedFact}
let actualDebug=day,actualSignal=family==='host'?paths.state('A',id)+'/Planner_Helper':signal
async function stop(){await fs.writeFile(path.join(directory,'producer-evidence.json'),JSON.stringify({...evidence,sourceHashes:Object.fromEntries(loaded)},null,2));process.exit(78)}
const replace=files.replace.bind(files),rename=files.rename.bind(files),nativeRename=fs.rename.bind(fs)
files.replace=async(p,text)=>{await replace(p,text);if(p===expectedFact){const fact=JSON.parse(text);actualDebug=fact.targets?.debugPath??day;actualSignal=fact.targets?.signalPath??actualSignal;if(phase==='accepted'&&!fact.debugPrepared&&!fact.debugPublished)await stop();if(phase==='prepared'&&fact.debugPrepared&&!fact.debugPublished)await stop()}}
fs.rename=async(a,b)=>{await nativeRename(a,b);if(phase==='log-renamed'&&String(b)===path.join(files.directory,actualDebug))await stop()}
files.rename=async(a,b)=>{const value=await rename(a,b);if(value&&(phase==='marker-renamed'&&b===marker||phase==='signal-renamed'&&b===actualSignal))await stop();return value}
if(family==='member')await runtime.publishPhysicalMemberRecovery(command,{taskId:id,member:'A'},{path:day,text:'Original member diagnostic\n'},signal)
else if(family==='restore-debug')await runtime.recordRestoreDebug(row)
else if(family==='host')await runtime.publishPhysicalHostRestoration(row)
else throw Error('Invalid fixture family')
if(phase!=='complete')throw Error('Old production phase not reached')
await fs.writeFile(path.join(directory,'producer-evidence.json'),JSON.stringify({...evidence,sourceHashes:Object.fromEntries(loaded)},null,2));await files.close();hooks.deregister();console.log(JSON.stringify(evidence))
