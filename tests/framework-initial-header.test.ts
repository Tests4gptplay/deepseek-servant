import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameworkClientController, type FrameworkClientApi, type FrameworkClientView } from '../src/framework/client-contracts.js'
const view=(mode:'local'|'git'='git'):FrameworkClientView=>({revision:'r1',activeMode:mode,collaborationId:'team',storageScope:mode+'-scope',settings:{name:'Known name',userName:'User',localDirectory:'/records',ownerRepo:'owner/repo',repositoryDirectory:'',collaborationId:'team',workerSeats:2,workspace:'/work'},connection:{participating:false,status:'disconnected'},messages:[],tasks:[],legacyTasks:[],archives:[],resources:[]})
const defer=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const api=(extra:Partial<FrameworkClientApi>)=>({subscribeChanged:()=>()=>{},selectMode:async({mode}:any)=>view(mode),...extra}) as FrameworkClientApi
test('ordinary changed bursts share one owned read and sequential dirty follow-ups',async()=>{
 let bodies=0;const first=defer<FrameworkClientView>(),second=defer<FrameworkClientView>(),entered=defer<void>(),following=defer<void>()
 const c=new FrameworkClientController(api({view:async input=>{if(input.headerOnly)return view();bodies++;if(bodies===2){entered.resolve();return first.promise}if(bodies===3){following.resolve();return second.promise}return view()}}))
 await c.refresh();const reading=c.refresh();await entered.promise
 const burst=Array.from({length:20},()=>c.refresh());assert.equal(bodies,2,'first changed burst shares the held ordinary read')
 first.resolve(view());await following.promise
 const next=Array.from({length:20},()=>c.refresh());assert.equal(bodies,3,'second burst shares the one follow-up, never concurrent reads')
 second.resolve(view());await Promise.all([reading,...burst,...next]);assert.equal(bodies,4,'one dirty follow-up per completed invalidated read, not one per event')
})
test('navigation aborts only obsolete read transport, never the saved mode action',async()=>{
 const entered=defer<void>();let readSignal:AbortSignal|undefined,saves=0
 const c=new FrameworkClientController(api({view:async(input,signal)=>{if(input.mode==='git'&&!input.headerOnly){readSignal=signal;entered.resolve();return new Promise((resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}))}return view('local')},selectMode:async({mode})=>{saves++;return view(mode)}}))
 await c.refresh();await c.selectMode('git');await entered.promise
 await c.selectMode('local');assert.equal(readSignal?.aborted,true);assert.equal(saves,2);assert.equal(c.snapshot().value?.activeMode,'local');assert.equal(c.snapshot().error,undefined)
})
test('last release aborts held body and history reads without cancelling commands or showing stale errors',async()=>{
 const entered=defer<void>(),historyEntered=defer<void>();let hold=false,bodySignal:AbortSignal|undefined,historySignal:AbortSignal|undefined
 const c=new FrameworkClientController(api({view:async(input,signal)=>{if(!input.headerOnly&&hold){bodySignal=signal;entered.resolve();return new Promise((_r,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}))}return view()},history:async(_input,signal)=>{historySignal=signal;historyEntered.resolve();return new Promise((_r,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}))}}))
 const release=c.retainConnection();await c.refresh();hold=true
 const reading=c.refresh(),history=c.navigateHistory({date:'2026-01-01',limit:20});const outcomes=Promise.allSettled([reading,history])
 await Promise.all([entered.promise,historyEntered.promise]);release();await outcomes
 assert.equal(bodySignal?.aborted,true);assert.equal(historySignal?.aborted,true);assert.equal(c.snapshot().error,undefined)
})
test('initial header publishes real settings while content waits; existing view refresh never fetches another header',async()=>{
 const body=defer<FrameworkClientView>(),entered=defer<void>(),calls:any[]=[]
 const c=new FrameworkClientController(api({view:async input=>{calls.push(input);if(input.headerOnly)return{...view(),storageScope:undefined};entered.resolve();return body.promise}}))
 const pending=c.refresh();await entered.promise
 assert.equal(c.snapshot().loading,true);assert.equal(c.snapshot().value?.activeMode,'git');assert.equal(c.snapshot().value?.settings.ownerRepo,'owner/repo');assert.equal(c.snapshot().value?.storageScope,undefined)
 body.resolve({...view(),messages:[{id:'m',participantId:'U',role:'user',text:'saved',createdAt:'2026'}]});await pending
 await c.refresh();assert.equal(calls.filter(x=>x.headerOnly).length,1);assert.equal(c.snapshot().value?.messages[0].text,'saved')
})
test('concurrent initial changes share only in-flight header, stale header does not start another full read',async()=>{
 const header=defer<FrameworkClientView>(),calls:any[]=[]
 const c=new FrameworkClientController(api({view:async input=>{calls.push(input);return input.headerOnly?header.promise:view()}}))
 const a=c.refresh(),b=c.refresh(),d=c.refresh();assert.equal(calls.length,1)
 header.resolve({...view(),storageScope:undefined});await Promise.all([a,b,d])
 assert.equal(calls.length,2);assert.equal(calls.filter(x=>!x.headerOnly).length,1)
})
test('changed bursts during initial held body share it and coalesce one fresh read; navigation does not share old hydration',async()=>{
 const first=defer<FrameworkClientView>(),entered=defer<void>();let bodies=0,headers=0
 const c=new FrameworkClientController(api({view:async input=>{if(input.headerOnly){headers++;return{...view(),storageScope:undefined}}bodies++;if(bodies===1){entered.resolve();return first.promise}return{...view(),archives:input.includeArchives?[{path:'archive',title:'Artifact'}]:[],messages:[{id:'new',text:'after changed',participantId:'U',role:'user',createdAt:'2026'}]}}}))
 const a=c.refresh();await entered.promise;const b=c.refresh(true),d=c.refresh();assert.equal(headers,1);assert.equal(bodies,1)
 first.resolve(view());await Promise.all([a,b,d]);assert.equal(bodies,2);assert.equal(c.snapshot().value?.messages[0].id,'new');assert.equal(c.snapshot().value?.archives[0].path,'archive')
})
test('accepted newer body revision retains dirty hydration responsibility, including synchronous publication changes',async()=>{
 for(const synchronous of [false,true]) {
  const first=defer<FrameworkClientView>(),entered=defer<void>();let bodies=0,joined:Promise<void>|undefined
  const message=(text:string)=>({id:text,text,participantId:'U',role:'user' as const,createdAt:'2026'})
  const c=new FrameworkClientController(api({view:async input=>{if(input.headerOnly)return{...view(),storageScope:undefined};if(++bodies===1){entered.resolve();return first.promise}return{...view(),revision:'r2',collaborationId:'next-team',messages:[message('after-change')]}}}))
  const off=c.subscribe(()=>{if(synchronous&&!joined&&c.snapshot().value?.messages[0]?.id==='before-change') {
   // Mark before calling refresh: its loading publication is synchronous too.
   joined=Promise.resolve();joined=c.refresh()
  }})
  const initial=c.refresh();await entered.promise
  if(!synchronous)joined=c.refresh()
  first.resolve({...view(),revision:'r2',collaborationId:'next-team',messages:[message('before-change')]})
  await initial;await joined;off()
  assert.equal(bodies,2,'accepted real revision must retain and drain changed invalidation')
  assert.equal(c.snapshot().value?.revision,'r2');assert.equal(c.snapshot().value?.messages[0]?.id,'after-change')
 }
})
test('a new saved revision does not join the old initial hydration',async()=>{
 const old=defer<FrameworkClientView>(),entered=defer<void>();let bodies=0
 const c=new FrameworkClientController(api({view:async input=>{if(input.headerOnly)return{...view(),storageScope:undefined};if(++bodies===1){entered.resolve();return old.promise}return{...view(),revision:'r2',settings:{...view().settings,foreground:{provider:'p',model:'new'}}}},foregroundModel:async()=>({...view(),revision:'r2',settings:{...view().settings,foreground:{provider:'p',model:'new'}}})}))
 const first=c.refresh();await entered.promise
 await c.foregroundModel({mode:'git',commandId:'new-model',expectedRevision:'r1',model:{provider:'p',model:'new'}})
 const changed=c.refresh();await Promise.resolve();assert.equal(bodies,2,'new settings revision must own a new read, not join stale body')
 old.resolve(view());await Promise.all([first,changed]);assert.equal(c.snapshot().value?.revision,'r2')
})
test('changed notifications during the initial follow-up read still share that owned flight',async()=>{
 const first=defer<FrameworkClientView>(),second=defer<FrameworkClientView>(),entered=defer<void>(),following=defer<void>();let bodies=0
 const c=new FrameworkClientController(api({view:async input=>{if(input.headerOnly)return{...view(),storageScope:undefined};bodies++;if(bodies===1){entered.resolve();return first.promise}if(bodies===2){following.resolve();return second.promise}return view()}}))
 const a=c.refresh();await entered.promise;const b=c.refresh();first.resolve(view());await following.promise
 const d=c.refresh();assert.equal(bodies,2,'follow-up remains owned rather than spawning a concurrent third read');assert.equal(c.snapshot().value?.storageScope,'git-scope','completed first body is already visible while follow-up waits')
 second.resolve(view());await Promise.all([a,b,d])
})
test('initial hydration read errors remain original and final subscription release stops queued reads',async()=>{
 const failed=defer<FrameworkClientView>(),entered=defer<void>();const original=Error('real content read error');let calls=0
 const c=new FrameworkClientController(api({view:async input=>{if(input.headerOnly)return{...view(),storageScope:undefined};calls++;entered.resolve();return failed.promise}}))
 const first=c.refresh();await entered.promise;const another=c.refresh();failed.reject(original)
 await assert.rejects(first,error=>error===original);await assert.rejects(another,error=>error===original)
 assert.equal(calls,1);assert.equal(c.snapshot().error,original.message)
 const held=defer<FrameworkClientView>(),started=defer<void>();let reads=0
 const d=new FrameworkClientController(api({view:async input=>{if(input.headerOnly)return{...view(),storageScope:undefined};reads++;started.resolve();return held.promise}}))
 const release=d.retainConnection();await started.promise;const joined=d.refresh();release();held.resolve(view());await joined
 assert.equal(reads,1,'released page does not execute a queued refresh')
})
test('last release withdraws a held header; remount obtains a new header and old one cannot launch content',async()=>{
 const old=defer<FrameworkClientView>(),next=defer<FrameworkClientView>(),entered=defer<void>();let headers=0,bodies=0
 const c=new FrameworkClientController(api({view:async input=>{if(input.headerOnly){headers++;return headers===1?old.promise:next.promise}bodies++;entered.resolve();return view('local')}}))
 const firstRelease=c.retainConnection();assert.equal(headers,1);firstRelease()
 const secondRelease=c.retainConnection();assert.equal(headers,2)
 old.resolve(view('git'));next.resolve(view('local'));await entered.promise
 assert.equal(bodies,1);assert.equal(c.snapshot().value?.activeMode,'local');secondRelease()
})
test('last UI release withdraws navigation publication while the real mode-save acknowledgement still settles',async()=>{
 const saved=defer<FrameworkClientView>(),ready=defer<void>();let bodies=0,saves=0
 const c=new FrameworkClientController(api({view:async input=>{if(!input.headerOnly){bodies++;ready.resolve()}return view('local')},selectMode:async()=>{saves++;return saved.promise}}))
 const release=c.retainConnection();await ready.promise
 const selecting=c.selectMode('git');release();saved.resolve({...view('git'),storageScope:undefined});await selecting
 assert.equal(saves,1,'real saved mode action was not cancelled')
 assert.equal(bodies,1,'released UI must not start a new content read after a late mode acknowledgement')
 assert.equal(c.snapshot().value?.activeMode,'local','late header cannot publish into a released navigation')
})
test('saved mode action settles before held reading; later read failure remains visible without unhandled rejection',async()=>{
 const held=defer<FrameworkClientView>(),entered=defer<void>(),reported=defer<void>();const original=Error('Git content unavailable')
 const c=new FrameworkClientController(api({view:async input=>{if(input.mode==='git'&&!input.headerOnly){entered.resolve();return held.promise}return view('local')},selectMode:async({mode,headerOnly})=>{assert.equal(headerOnly,true);return{...view(mode),storageScope:undefined}}}))
 await c.refresh();await c.selectMode('git');await entered.promise
 assert.equal(c.snapshot().value?.activeMode,'git');assert.equal(c.snapshot().loading,true)
 const off=c.subscribe(()=>{if(c.snapshot().error===original.message)reported.resolve()});held.reject(original);await reported.promise;off()
 assert.equal(c.snapshot().value?.settings.ownerRepo,'owner/repo');assert.equal(c.snapshot().loading,false)
})
test('header failure stays visible without fake settings, retry reads header again; navigation rejects late header and body',async()=>{
 const error=Error('local configuration unavailable');let fail=true,calls=0
 const c=new FrameworkClientController(api({view:async input=>{if(input.headerOnly){calls++;if(fail)throw error}return view()}}))
 await assert.rejects(c.refresh(),error);assert.equal(c.snapshot().value,undefined);assert.match(c.snapshot().error!,/unavailable/)
 fail=false;await c.refresh();assert.equal(calls,2)
 for(const phase of ['header','body']){
  const blocked=defer<FrameworkClientView>(),entered=defer<void>();let bodyCalls=0
  const other=new FrameworkClientController(api({view:async input=>{if(input.mode==='local')return view('local');if((phase==='header')===!!input.headerOnly){entered.resolve();return blocked.promise}bodyCalls++;return view()}}))
  const pending=other.refresh();await entered.promise;await other.selectMode('local');blocked.resolve(view());await pending
  assert.equal(other.snapshot().value?.activeMode,'local');if(phase==='header')assert.equal(bodyCalls,0)
 }
})

test('initial held Git view preserves a usable Local escape and does not masquerade blank Local settings',async()=>{
 const {build}=await import('esbuild'),{JSDOM}=await import('jsdom' as string),{pathToFileURL}=await import('node:url'),{resolve}=await import('node:path')
 await build({stdin:{contents:"export {FrameworkPage} from './src/framework/client-page.tsx'; export {ModelPicker} from './src/client/model-picker.tsx'; export {getFrameworkClientController} from './src/framework/client-contracts.ts';",resolveDir:process.cwd()},outfile:'.validation/conversation-controls-view.mjs',bundle:true,platform:'node',format:'esm',external:['react','react/*','react-dom','react-dom/*'],loader:{'.css':'empty'},define:Object.fromEntries(['ICON','WELCOME_CHARACTER','TASK_EMPTY_CHARACTER'].map(k=>['__SERVANT_'+k+'_DATA_URI__','""']))})
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 const put=(k:string,v:unknown)=>{saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true})}
 for(const k of ['window','document','Element','HTMLElement','HTMLTextAreaElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','MutationObserver'])put(k,k==='window'?dom.window:(dom.window as any)[k])
 put('getComputedStyle',dom.window.getComputedStyle.bind(dom.window));put('requestAnimationFrame',dom.window.requestAnimationFrame.bind(dom.window));put('cancelAnimationFrame',dom.window.cancelAnimationFrame.bind(dom.window));put('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});put('IS_REACT_ACT_ENVIRONMENT',true)
 dom.window.matchMedia=(()=>({matches:false,addEventListener(){},removeEventListener(){}})) as any
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{FrameworkPage,ModelPicker,getFrameworkClientController}=await import(pathToFileURL(resolve('.validation/conversation-controls-view.mjs')).href)
 const root=createRoot(document.getElementById('root')!),calls:any[]=[],sends:any[]=[];let current=view('git'),configure=0,fail=false; const header=defer<FrameworkClientView>(),body=defer<FrameworkClientView>(),bodyEntered=defer<void>();const selections:string[]=[];let hydrated=false
 const port=api({view:async(input:any)=>{if(input.mode==='local')return view('local');if(input.headerOnly)return header.promise;if(hydrated)return current;bodyEntered.resolve();return body.promise},selectMode:async({mode}:any)=>{selections.push(mode);return view(mode)},foregroundModel:async input=>{calls.push(input);if(fail)throw Error('model save unknown');current={...current,revision:'r'+(calls.length+1),settings:{...current.settings,foreground:input.model}};return structuredClone(current)},configure:async()=>{configure++;return current},send:async input=>{sends.push(input);return{revision:'message'}},history:async()=>({revision:'h',messages:[]})})
 const controller=getFrameworkClientController(port)
 const click=async(text:string)=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text||b.getAttribute('aria-label')===text);assert.ok(button,'button '+text);await React.act(async()=>{button.click();await new Promise(resolve=>setImmediate(resolve))})}
 const refresh=async()=>{await React.act(()=>controller.refresh())}
 const models={current:{provider:'p',model:'first'},groups:[{id:'p',name:'Provider',models:[{id:'first',name:'First'},{id:'second',name:'Second'}]}],failures:[],status:'ready',error:null}
 try {
  await React.act(async()=>{root.render(React.createElement(FrameworkPage,{api:port,language:'en'}));await new Promise(resolve=>setImmediate(resolve))})
  assert.equal(document.querySelector('button[aria-selected="true"]')?.textContent==='Local',false)
  await click('Settings');assert.match(document.body.textContent!,/Loading settings/);assert.equal(document.querySelector('form'),null)
  await React.act(async()=>{header.resolve({...current,storageScope:undefined});await bodyEntered.promise})
  assert.match(document.body.textContent!,/Git owner\/repository/);assert.doesNotMatch(document.body.textContent!,/Local data directory/)
  assert.ok([...document.querySelectorAll('input')].some(input=>input.value==='owner/repo'))
  await click('Close')
  const textarea=document.querySelector('textarea[aria-label="Message"]')! as HTMLTextAreaElement
  await React.act(()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Header draft');textarea.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
  await React.act(async()=>{hydrated=true;body.resolve(current)})
  assert.equal(textarea.value,'Header draft','same saved header completing its storage scope preserves typed draft')
  current={...current,revision:'different-settings',collaborationId:'other-team',storageScope:'other-root'}
  await React.act(()=>controller.refresh());assert.equal(textarea.value,'','a real changed configuration does not carry the old scope draft')
  await click('Local');assert.deepEqual(selections,['local']);assert.equal(controller.snapshot().value?.activeMode,'local')
 } finally {await React.act(()=>root.unmount());dom.window.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete(globalThis as any)[k]}}
})

test('warm Local to held Git publishes real Git settings and Local remains a working escape',async()=>{
 const {build}=await import('esbuild'),{JSDOM}=await import('jsdom' as string),{pathToFileURL}=await import('node:url'),{resolve}=await import('node:path')
 await build({stdin:{contents:"export {FrameworkPage} from './src/framework/client-page.tsx'; export {ModelPicker} from './src/client/model-picker.tsx'; export {getFrameworkClientController} from './src/framework/client-contracts.ts';",resolveDir:process.cwd()},outfile:'.validation/conversation-controls-view.mjs',bundle:true,platform:'node',format:'esm',external:['react','react/*','react-dom','react-dom/*'],loader:{'.css':'empty'},define:Object.fromEntries(['ICON','WELCOME_CHARACTER','TASK_EMPTY_CHARACTER'].map(k=>['__SERVANT_'+k+'_DATA_URI__','""']))})
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 const put=(k:string,v:unknown)=>{saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true})}
 for(const k of ['window','document','Element','HTMLElement','HTMLTextAreaElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','MutationObserver'])put(k,k==='window'?dom.window:(dom.window as any)[k])
 put('getComputedStyle',dom.window.getComputedStyle.bind(dom.window));put('requestAnimationFrame',dom.window.requestAnimationFrame.bind(dom.window));put('cancelAnimationFrame',dom.window.cancelAnimationFrame.bind(dom.window));put('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});put('IS_REACT_ACT_ENVIRONMENT',true)
 dom.window.matchMedia=(()=>({matches:false,addEventListener(){},removeEventListener(){}})) as any
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{FrameworkPage,ModelPicker,getFrameworkClientController}=await import(pathToFileURL(resolve('.validation/conversation-controls-view.mjs')).href)
 const root=createRoot(document.getElementById('root')!),calls:any[]=[],sends:any[]=[];let current=view('local'),configure=0,fail=false; const header=defer<FrameworkClientView>(),body=defer<FrameworkClientView>(),bodyEntered=defer<void>();const selections:string[]=[];let hydrated=false
 let holdLocal=false, failGit=false, gitError:Error=Error('current Git read failed')
 const port=api({view:async(input:any,signal?:AbortSignal)=>{if(input.headerOnly)return{...view('local'),storageScope:undefined};if(input.mode==='git'){if(failGit)throw gitError;bodyEntered.resolve();return body.promise}if(holdLocal)return new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}));return view('local')},selectMode:async({mode,headerOnly}:any)=>{assert.equal(headerOnly,true);selections.push(mode);return{...view(mode),storageScope:undefined}},foregroundModel:async input=>{calls.push(input);if(fail)throw Error('model save unknown');current={...current,revision:'r'+(calls.length+1),settings:{...current.settings,foreground:input.model}};return structuredClone(current)},configure:async()=>{configure++;return current},send:async input=>{sends.push(input);return{revision:'message'}},history:async()=>({revision:'h',messages:[]})})
 const controller=getFrameworkClientController(port)
 const click=async(text:string)=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text||b.getAttribute('aria-label')===text);assert.ok(button,'button '+text);await React.act(async()=>{button.click();await new Promise(resolve=>setImmediate(resolve))})}
 const refresh=async()=>{await React.act(()=>controller.refresh())}
 const models={current:{provider:'p',model:'first'},groups:[{id:'p',name:'Provider',models:[{id:'first',name:'First'},{id:'second',name:'Second'}]}],failures:[],status:'ready',error:null}
 try {
  await React.act(async()=>{root.render(React.createElement(FrameworkPage,{api:port,language:'en'}));await new Promise(resolve=>setImmediate(resolve))})
  assert.equal(controller.snapshot().value?.activeMode,'local')
  await click('DSS-cah');await bodyEntered.promise
  assert.equal(controller.snapshot().value?.activeMode,'git');assert.equal(controller.snapshot().loading,true)
  await click('Settings');assert.match(document.body.textContent!,/Git owner\/repository/);assert.doesNotMatch(document.body.textContent!,/Local data directory/)
  await click('Close');await click('Local')
  assert.deepEqual(selections,['git','local']);assert.equal(controller.snapshot().value?.activeMode,'local')
  await React.act(async()=>body.resolve(view('git')));assert.equal(controller.snapshot().value?.activeMode,'local')
  holdLocal=true;await click('Refresh');failGit=true;await click('DSS-cah')
  assert.match(document.querySelector('[role=alert]')?.textContent??'',/current Git read failed/,'obsolete Local cancellation cannot mask current Git failure')
  assert.doesNotMatch(document.body.textContent!,/signal is aborted|operation was aborted/i)
  gitError=Object.assign(Error('independent read abort'),{name:'AbortError'});await click('Refresh')
  assert.match(document.querySelector('[role=alert]')?.textContent??'',/independent read abort/)
  gitError=Object.assign(Error('unknown read outcome'),{name:'FilesOutcomeUnknownError'});await click('Refresh')
  assert.match(document.querySelector('[role=alert]')?.textContent??'',/unknown read outcome/)
  holdLocal=false;await click('Local');holdLocal=true;await click('Jump to latest');await click('DSS-cah')
  assert.match(document.querySelector('[role=alert]')?.textContent??'',/unknown read outcome/,'obsolete latest read must not mask current scope error')



 } finally {await React.act(()=>root.unmount());dom.window.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete(globalThis as any)[k]}}
})
