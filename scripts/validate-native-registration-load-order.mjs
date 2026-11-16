import assert from 'node:assert/strict'
import {build}from'esbuild'
import {mkdtemp,rm}from'node:fs/promises'
import{join}from'node:path'
import{pathToFileURL}from'node:url'
import{Context}from'@deepseek-ai/cordis'
import{defineStore}from'@deepseek-ai/dsh-client-store'
const tmp=await mkdtemp(join(process.cwd(),'scripts/.native-register-'));const checks=[];const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()}
try{
 for(const[name,entry]of[['registry','/workspace/scratch/dfd5b1050ee3/outputs/dss-linux-actual-20261114/host-rc3/node_modules/@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'],['dss','src/client/native-interactions.tsx']])await build({entryPoints:[entry],outfile:join(tmp,name+'.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic'})
 const{SlotRegistry}=await import(pathToFileURL(join(tmp,'registry.mjs')));const{registerNativeInteractions}=await import(pathToFileURL(join(tmp,'dss.mjs')));const ctx=new Context();new SlotRegistry(ctx);const slots=ctx.slots;const Empty=()=>null
 slots.register({name:'root',children:{main:{kind:'single',scope:'root'}}},Empty)
 slots.registerFactory({name:'conversation.content',scope:'session-maybe',children:{'conversation.composer':{kind:'chain',scope:'session'}}},Empty)
 const preHandle=defineStore({init:()=>({text:''})}); slots.register({name:'conversation.composer',locale:'question',store:preHandle,inject:()=>({keyedHooks:{questionCard:()=>undefined}}),select:()=>null,children:{'conversation.plan-review.actions':{kind:'list',scope:'session'}}},Empty); slots.register({name:'conversation.plan-review.actions',id:'preview',locale:'plan'},Empty);
 registerNativeInteractions(ctx)
 slots.register({name:'main',children:{'deepseek-servant.interaction':{kind:'single',scope:'session'}}},Empty)
 assert.equal(slots.entriesOfSlot('deepseek-servant.interaction').length,1);checks.push('production DSS register succeeds beside existing native factory with real registry')
 assert.equal(slots.entriesOfSlot('deepseek-servant.question').length,1);assert.equal(slots.entriesOfSlot('deepseek-servant.plan-actions').length,1); checks.push('already present native question and preview register before DSS main without collision');
 console.log(JSON.stringify({status:'passed',checks,limits:'Production registration against actual official rc3 SlotRegistry with controlled native entry descriptors; not actual native card UI.'},null,2))
}finally{await rm(tmp,{recursive:true,force:true})}
