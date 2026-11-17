import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {defineStore} from '@deepseek-ai/dsh-client-store'
const tmp=await mkdtemp(join(process.cwd(),'scripts/.native-store-'))
try{
 await build({entryPoints:['/workspace/scratch/dfd5b1050ee3/outputs/dss-linux-actual-20261114/host-rc3/node_modules/@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'],outfile:join(tmp,'registry.mjs'),bundle:true,format:'esm',platform:'node',packages:'external'})
 const {SlotRegistry}=await import(pathToFileURL(join(tmp,'registry.mjs')));const ctx=new Context();new SlotRegistry(ctx);const slots=ctx.slots;const Empty=()=>null,checks=[]
 slots.register({name:'root',children:{native:{kind:'single',scope:'session'},dss:{kind:'single',scope:'session'}}},Empty)
 let creations=0;const original=defineStore({init:()=>({text:''}),persist:'test-native-draft',actions:{set:(s,v)=>{s.text=v}}});const handle={...original,create(...args){creations++;return original.create(...args)}}
 const disposeNative=slots.register({name:'native',store:handle},Empty)
 const entry=slots.entriesOfSlot('native')[0];assert.equal(entry.store,handle);checks.push('public StoredEntry exposes exact registered shared handle')
 const disposeDss=slots.register({name:'dss',store:entry.store},Empty)
 let host;slots.install({renderRoot(h){host=h;return null}});slots.renderSlot('root',{})
 const binding={key:'actual-test-session',ctx,hooks:{},props:{}}
 const first=host.storeOf(entry,binding),second=host.storeOf(slots.entriesOfSlot('dss')[0],binding)
 assert.equal(first,second);assert.equal(creations,1);checks.push('actual official SlotRegistry creates one instance for shared handle and session')
 first.actions.set('unsent answer');assert.equal(second.getSnapshot().text,'unsent answer');checks.push('both seats share current unsent answer without duplicate storage writes')
 disposeDss();assert.equal(host.storeOf(entry,binding),first);checks.push('DSS unmount registration preserves native instance and draft')
 disposeNative();console.log(JSON.stringify({status:'passed',checks,limits:'Actual official rc3 SlotRegistry and store implementation, controlled session binding, no browser or live user permission changes.'},null,2))
}finally{await rm(tmp,{recursive:true,force:true})}
