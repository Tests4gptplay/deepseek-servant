import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const temp = mkdtempSync(new URL('./.permission-order-', import.meta.url).pathname)
await build({ entryPoints: [new URL('../src/framework/service.ts', import.meta.url).pathname], outfile: join(temp, 'service.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/*', 'koffi'], banner: {js: "import { createRequire as __testCreateRequire } from 'node:module'; const require = __testCreateRequire(import.meta.url);"} })
const { hooks, evidence } = await import('./test-support/dsh-sdk-runtime.mjs')
import assert from 'node:assert/strict'
const {FrameworkService}=await import(pathToFileURL(join(temp, 'service.mjs')).href)
const checks=[];const check=(n,a,b)=>{assert.deepEqual(a,b,n);checks.push(n)}
// Production Service methods with isolated setting/runtime doubles, not a running Host.
let saved={revision:'initial',settings:{name:'retained',permissionPreset:undefined}},writes=0,applied=[]
const runtime={config:{scope:'scope-A'},async setPermissionPreset(p){applied.push(p)}}
const service=Object.assign(Object.create(FrameworkService.prototype),{
 closed:false,modeConfiguration:new Map(),settingsCommands:new Map(),modeSending:new Map(),conversationBarriers:new Map(),running:new Map([['local',{runtime,connection:{scope:'scope-A'}}]]),accesses:new Map([['local',Promise.resolve({connection:{scope:'scope-A'}})]]),accessOpening:new Map(),
 ctx:{get(){return{resolve(p){if(!['read-only','workspace-write','danger-full-access'].includes(p))throw Error('invalid preset')}}}},storage:{async get(){return saved}},
 config(){return saved},async persistSettings(mode,next){saved=next;writes++},changed(){},settingsView(){return{settings:saved.settings}}
})
try {
 const a=service.permissionSelect({mode:'local',storageScope:'scope-A',preset:'read-only'})
 const b=service.permissionSelect({mode:'local',storageScope:'scope-A',preset:'workspace-write'})
 await Promise.all([a,b]);check('real existing settings lane orders rapid selections',applied,['read-only','workspace-write']);check('newest user selection remains persisted',saved.settings.permissionPreset,'workspace-write');check('unrelated settings retained',saved.settings.name,'retained');check('one write per changed selection',writes,2)
 await service.permissionSelect({mode:'local',storageScope:'scope-A',preset:'workspace-write'});check('same selection no repeated settings write',writes,2)
 await assert.rejects(service.permissionSelect({mode:'local',storageScope:'scope-old',preset:'read-only'}),/scope changed/);check('stale view cannot change new scope preference',saved.settings.permissionPreset,'workspace-write')
 service.running.clear();await service.permissionSelect({mode:'local',storageScope:'scope-A',preset:'read-only'});check('inactive mode reuses already-open matching storage scope',saved.settings.permissionPreset,'read-only')
 check('permission setting never engages conversation barrier',service.conversationBarriers.size,0)
 console.log(JSON.stringify({status:'passed',checks,...evidence(),limits:'Production permissionSelect and serialMode with isolated setting/runtime doubles; no native user grant, model, real persistent disk or HTTP/UI validation claimed.'},null,2))
}finally{hooks.deregister();rmSync(temp,{recursive:true,force:true})}
