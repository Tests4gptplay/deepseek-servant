import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {createHash} from 'node:crypto'
const root=new URL('../src/',import.meta.url),loaded=new Map(),data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64')
const hooks=registerHooks({resolve(s,c,n){if(s==='zod')return{url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true};if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}return n(s,c)},load(u,c,n){if(u.startsWith(root.href)&&u.endsWith('.ts')){const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})


const {FrameworkClientController}=await import('../src/framework/client-contracts.ts')
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const turn=()=>new Promise(resolve=>setImmediate(resolve))
const message=(id,text=id)=>({id,role:'user',text,createdAt:'2026-11-08T00:00:00Z'})
const view=(mode='local',messages=[])=>({revision:'settings',activeMode:mode,collaborationId:'c',storageScope:'scope',settings:{},connection:{status:'connected',participating:true},messages,tasks:[],legacyTasks:[],archives:[],resources:[],executions:[]})
const page=(messages,order=messages.map(x=>x.id))=>({messages,order,storageScope:'scope'})
try{
 for(const mode of ['local','git']){
  let sent=deferred();const api={send:()=>sent.promise,history:async()=>page([])}
  const c=new FrameworkClientController(api);c.publish({value:view(mode)})
  const input={id:'receipt-'+mode,mode,collaborationId:'c',storageScope:'scope',text:'original'}
  const send=c.send(input);sent.resolve();await send;await turn()
  check(c.snapshot().drafts.length,1);check(c.snapshot().drafts[0].state,'sent')
  c.publish({value:{...view(mode),storageScope:'other',messages:[message(input.id,'original')]}});check(c.snapshot().drafts.length,1)
  c.publish({value:view(mode,[message(input.id,'original')])});check(c.snapshot().drafts,[]);check(c.draftOwners.size,0);check(c.sends.size,0)
  const early={...input,id:'early-'+mode};sent=deferred();const earlySend=c.send(early)
  c.publish({value:view(mode,[message(early.id,'original')])});check(c.snapshot().drafts[0].state,'sending')
  sent.resolve();await earlySend;await turn();check(c.snapshot().drafts,[])
  const unknown={...input,id:'unknown-'+mode};sent=deferred();const failure=c.send(unknown)
  c.publish({value:view(mode,[message(unknown.id,'original')])});sent.reject(new Error('UNKNOWN outcome'));await assert.rejects(failure);assertions++
  check(c.snapshot().drafts[0].state,'failed');check(c.snapshot().drafts[0].input,unknown)
 }
 let pendingOld,latestPage=page([message('edited','new original')],['edited','latest'])
 const api={history:async input=>input.date==='held-history'?pendingOld.promise:input.date? page([message(input.date)],[input.date,'edited','latest']):latestPage}
 const c=new FrameworkClientController(api);c.publish({value:view()})
 pendingOld=deferred();const old=c.navigateHistory({date:'held-history',limit:20});await turn()
 await c.refreshMessages();check(c.localMessageAuthority.originals.get('edited').text,'new original')
 pendingOld.resolve(page([message('edited','stale original')],['edited','latest']));await old
 check(c.snapshot().value.messages[0].text,'new original');check(c.localMessageReads.size,0)
 // Repeated real history navigation replaces the visible window, not a growing
 // body cache. Current latest originals remain for the actual late-page rule.
 for(let i=0;i<32;i++)await c.navigateHistory({date:'historical-'+i,limit:20})
 check(c.snapshot().value.messages.map(x=>x.id),['historical-31'])
 check([...c.localMessageAuthority.originals.keys()].sort(),['edited','historical-31'])
 latestPage=page([message('latest')],['edited','latest']);await c.latest()
 check(c.snapshot().value.messages.map(x=>x.id),['latest']);check([...c.localMessageAuthority.originals.keys()],['latest'])
 // A cancelled navigation cannot reintroduce an abandoned historical body.
 pendingOld=deferred();const abandoned=c.navigateHistory({date:'held-history',limit:20});await turn()
 await c.latest();pendingOld.resolve(page([message('edited','obsolete')],['edited','latest']));await abandoned
 check(c.snapshot().value.messages.map(x=>x.id),['latest']);check([...c.localMessageAuthority.originals.keys()],['latest'])
 c.publish({value:view('git')});check(c.localMessageAuthority,undefined)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual controller send, publication, history and latest methods with explicit RPC fixtures; no native UI render or permanent conversation deletion.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{hooks.deregister()}
