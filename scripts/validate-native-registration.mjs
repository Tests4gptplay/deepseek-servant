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
 registerNativeInteractions(ctx)
 slots.register({name:'main',children:{'deepseek-servant.interaction':{kind:'single',scope:'session'}}},Empty)
 assert.equal(slots.entriesOfSlot('deepseek-servant.interaction').length,1);checks.push('production DSS register succeeds beside existing native factory with real registry')
 assert.equal(slots.entriesOfSlot('deepseek-servant.question').length,0);checks.push('absent question plugin creates no substitute or wait')
 const handle=defineStore({init:()=>({text:''}),actions:{set:(s,v)=>{s.text=v}}});const inject=()=>({keyedHooks:{questionCard:()=>undefined}})
 const registerQuestion=()=>slots.register({name:'conversation.composer',locale:'question',store:handle,inject,select:()=>null,children:{'conversation.plan-review.actions':{kind:'list',scope:'session'}}},Empty)
 let dispose=registerQuestion();await flush();const adapted=slots.entriesOfSlot('deepseek-servant.question')[0];assert.equal(adapted.store,handle);assert.equal(adapted.inject,inject);checks.push('actual native handle and card injection reused exactly')
 slots.register({name:'conversation.plan-review.actions',id:'native-preview',locale:'plan',inject:()=>({openReview(){}})},Empty);await flush();assert.equal(slots.entriesOfSlot('deepseek-servant.plan-actions').length,1);checks.push('preview registered only into DSS own declared slot')
 dispose();await flush();assert.equal(slots.entriesOfSlot('deepseek-servant.question').length,0);assert.equal(slots.entriesOfSlot('deepseek-servant.plan-actions').length,0);checks.push('native plugin unload removes dependent seats without polling')
 dispose=registerQuestion();await flush();assert.equal(slots.entriesOfSlot('deepseek-servant.question').length,1);checks.push('native reload produces exactly one DSS question registration');dispose()
 console.log(JSON.stringify({status:'passed',checks,limits:'Production registration against actual official rc3 SlotRegistry with controlled native entry descriptors; not actual native card UI.'},null,2))
}finally{await rm(tmp,{recursive:true,force:true})}
