import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createForegroundModelPublication, selectedForegroundModel } from '../src/client/foreground-model-publication.js'

test('real Cordis query is synchronous, one response per active producer, nullable Auto, and owned release', () => {
 const ctx=new Context(), changes:number[]=[]
 ctx.on('ui/foreground-model/changed',()=>{changes.push(1)})
 const p=createForegroundModelPublication(ctx), query=()=>{const answers:unknown[]=[];ctx.emit('ui/foreground-model/query',v=>answers.push(v));return answers}
 assert.deepEqual(query(),[]); assert.equal(changes.length,1)
 p.update(true,{provider:'p',model:'m',reasoningEffort:'high'});assert.deepEqual(query(),[{provider:'p',model:'m',reasoningEffort:'high'}])
 const count=changes.length;p.update(true,{provider:'p',model:'m',reasoningEffort:'high'});assert.equal(changes.length,count)
 p.update(true,null);assert.deepEqual(query(),[null])
 p.update(false,null);assert.deepEqual(query(),[])
 p.dispose();const disposed=changes.length;p.dispose();p.update(true,{provider:'x',model:'y'});assert.equal(changes.length,disposed);assert.deepEqual(query(),[])
})
test('saved explicit route resolves only its catalog effort; Auto never borrows another native main-view model',()=>{
 const models:any={current:{provider:'other',model:'wrong'},groups:[{id:'p',models:[{id:'m',reasoning:{defaultEffort:'medium'}}]}]}
 assert.equal(selectedForegroundModel(undefined,models),null)
 assert.equal(selectedForegroundModel({},models),null)
 assert.deepEqual(selectedForegroundModel({provider:'p',model:'m'},models),{provider:'p',model:'m',reasoningEffort:'medium'})
 assert.deepEqual(selectedForegroundModel({provider:'p',model:'m',reasoningEffort:'high'},models),{provider:'p',model:'m',reasoningEffort:'high'})
 assert.deepEqual(selectedForegroundModel({provider:'p',model:'unknown'},models),{provider:'p',model:'unknown'})
})
test('actual registered main page only publishes visible Conversation selection; settings, tabs, panel switch and unmount withdraw',async()=>{
 const {build}=await import('esbuild'),{JSDOM}=await import('jsdom' as string),{pathToFileURL}=await import('node:url'),{resolve}=await import('node:path')
 await build({entryPoints:['src/client.tsx'],outfile:'.validation/publication-client.mjs',bundle:true,platform:'node',format:'esm',external:['react','react/*','react-dom','react-dom/*'],loader:{'.css':'empty'},define:Object.fromEntries(['ICON','STATUS_ICON','WELCOME_CHARACTER','TASK_EMPTY_CHARACTER','CLIENT_CSS'].map(k=>['__SERVANT_'+k+(k==='CLIENT_CSS'?'':'_DATA_URI__'), '""']).map(([k,v])=>[k==='__SERVANT_CLIENT_CSS'?'__SERVANT_CLIENT_CSS__':k,v]))})
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 const put=(k:string,v:unknown)=>{saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true})}
 for(const k of ['window','document','Element','HTMLElement','HTMLTextAreaElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','MutationObserver'])put(k,k==='window'?dom.window:(dom.window as any)[k])
 put('getComputedStyle',dom.window.getComputedStyle.bind(dom.window));put('requestAnimationFrame',dom.window.requestAnimationFrame.bind(dom.window));put('cancelAnimationFrame',dom.window.cancelAnimationFrame.bind(dom.window));put('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});put('IS_REACT_ACT_ENVIRONMENT',true)
 dom.window.matchMedia=(()=>({matches:false,addEventListener(){},removeEventListener(){}})) as any
 const React=await import('react'),{createRoot}=await import('react-dom/client')
 const {apply}=await import(pathToFileURL(resolve('.validation/publication-client.mjs')).href)
 const bus=new Context(),slots:any[]=[],cleanup:Array<()=>void>=[]
 const observable=(initial:any)=>{let value=initial;const listeners=new Set<()=>void>();return{getSnapshot:()=>value,subscribe:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)},set:(v:any)=>{value=v;for(const f of listeners)f()}}}
 const panel=observable({activePanelId:'deepseek-servant'}),locale=observable({active:'en'}),sessionList=observable({byId:{}})
 let current:any={revision:'r1',activeMode:'local',storageScope:'local-root',collaborationId:'team',settings:{name:'Servant',userName:'You',localDirectory:'',ownerRepo:'',repositoryDirectory:'',collaborationId:'team',workerSeats:1,workspace:'',foreground:{provider:'p',model:'m',reasoningEffort:'high'}},connection:{participating:true,status:'connected'},messages:[],tasks:[],legacyTasks:[],archives:[],resources:[]}
 const catalogRequests:unknown[]=[];let catalogFailure=false, holdGit=false;const obsoleteSignals:AbortSignal[]=[]
 const services:any={layout:{panelInfo:panel},connection:{rpc:{call:async(_a:string,method:string,payload:any,signal?:AbortSignal)=>{
  if(method==='session/modelCatalog'){
   catalogRequests.push(payload)
   if(catalogFailure)return{ok:false,error:{code:'gateway/internal',message:'catalog unavailable'}}
   return{ok:true,value:{default:{provider:'other',model:'wrong'},groups:[{id:'other',name:'Other',models:[{id:'wrong',name:'Catalog model'}]}],failures:[]}}
  }
  if(method.endsWith('/selectMode'))current={...current,activeMode:payload.mode,storageScope:payload.mode+'-root'}
  if(holdGit&&method.endsWith('/view')&&!payload.headerOnly&&payload.mode==='git'){assert.ok(signal);obsoleteSignals.push(signal);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}
  return{ok:true,value:method.endsWith('/maintenanceView')?{localDirectory:'',usage:{totalBytes:0,groups:[]}}:current}
 }}},sessions:{list:sessionList,binding:()=>undefined,retainInfo:()=>observable({retainedBy:{}})},modelDirectories:{},remote:{agentPresets:{list:async()=>({ok:true,value:{presets:[]}})}}}

 const ctx:any={get:(name:string)=>services[name],on:bus.on.bind(bus),emit:bus.emit.bind(bus),effect:(f:()=>any)=>{const off=f();if(typeof off==='function')cleanup.push(off)},locale:{register:()=>()=>{},bind:()=>((s:string)=>s),subscribe:locale.subscribe,getSnapshot:locale.getSnapshot},slots:{inject:(_n:string,f:()=>void)=>f(),register:(meta:any,component:any)=>{slots.push({meta,component})}}}
 const query=()=>{const answers:unknown[]=[];bus.emit('ui/foreground-model/query',v=>answers.push(v));return answers}
 // A non-network EventTarget holds the stream boundary; model publication must not require online status.
 const streams:any[]=[];put('EventSource',class extends dom.window.EventTarget { constructor(){super();streams.push(this)} close(){} })
 apply(ctx)
 const root=createRoot(document.getElementById('root')!),Main=slots.find(s=>s.meta.name==='main').component,Settings=slots.find(s=>s.meta.name==='settings.section').component
 const click=async(text:string)=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.trim()===text||x.getAttribute('aria-label')===text);assert.ok(b,text);await React.act(async()=>b.click())}
 try{
  await React.act(async()=>root.render(React.createElement(Main)));assert.deepEqual(query(),[{provider:'p',model:'m',reasoningEffort:'high'}])
  assert.deepEqual(catalogRequests,[{args:{}}],'actual apply catalog fallback uses the official Remote args envelope exactly once')
  current={...current,activeMode:'git',storageScope:'git-root',settings:{...current.settings,foreground:{provider:'q',model:'next'}}}
  await React.act(async()=>streams[0].dispatchEvent(new dom.window.Event('changed')))
  assert.deepEqual(query(),[{provider:'q',model:'next'}],'scope changes publish only the new saved selection')
  current={...current,settings:{...current.settings,foreground:undefined}}
  await React.act(async()=>streams[0].dispatchEvent(new dom.window.Event('changed')))
  assert.deepEqual(query(),[null],'Auto is unresolved even when the native catalog offers another default')
  assert.match(document.querySelector('button[aria-label="Foreground model"]')!.textContent!,/Catalog model/,'actual catalog result reaches ModelPicker')

  Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true})
  await React.act(()=>document.dispatchEvent(new dom.window.Event('visibilitychange')));assert.deepEqual(query(),[])
  Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true})
  await React.act(()=>document.dispatchEvent(new dom.window.Event('visibilitychange')));assert.deepEqual(query(),[null])
  await click('Tasks');assert.deepEqual(query(),[]);await click('Conversation');assert.equal(query().length,1)
  await click('Settings');assert.deepEqual(query(),[]);await click('Close');assert.equal(query().length,1)
  await React.act(()=>panel.set({activePanelId:null}));assert.deepEqual(query(),[])
  await React.act(()=>panel.set({activePanelId:'deepseek-servant'}));assert.equal(query().length,1)
  await React.act(()=>root.render(React.createElement(Settings)));assert.deepEqual(query(),[],'settings-section registration never publishes')
  await React.act(()=>root.render(React.createElement(Main)));assert.equal(query().length,1)
  await React.act(()=>root.render(null));assert.deepEqual(query(),[])
  catalogFailure=true;const beforeFailure=catalogRequests.length
  await React.act(async()=>root.render(React.createElement(Main)))
  assert.equal(catalogRequests.length,beforeFailure+1,'one new mount does not add automatic catalog retries')
  assert.deepEqual(catalogRequests.at(-1),{args:{}})
  await click('Foreground model');assert.match(document.body.textContent!,/catalog unavailable/,'real gateway error remains visible, not a fake empty catalog')
  assert.equal(catalogRequests.length,beforeFailure+1)
  current={...current,activeMode:'local',storageScope:'local-root'}
  await React.act(async()=>streams.at(-1).dispatchEvent(new dom.window.Event('changed')))
  holdGit=true
  for(let i=0;i<2;i++){
   await click('DSS-cah');assert.equal(obsoleteSignals.length,i+1);assert.equal(obsoleteSignals[i].aborted,false)
   await click('Local');assert.equal(obsoleteSignals[i].aborted,true,'actual apply forwards stale view cancellation into official RPC signal')
   assert.equal(current.activeMode,'local','saved mode command completes independently of read cancellation')
  }
  await React.act(()=>root.unmount());assert.deepEqual(query(),[])
 }finally{for(const off of cleanup.reverse())off();dom.window.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete(globalThis as any)[k]}}
})
