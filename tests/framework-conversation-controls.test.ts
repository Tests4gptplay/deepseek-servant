import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameworkClientController, type FrameworkClientApi, type FrameworkClientView } from '../src/framework/client-contracts.js'
const view = (mode: 'local' | 'git' = 'local'): FrameworkClientView => ({ revision:'r1',activeMode:mode,collaborationId:'team',storageScope:mode+'-scope',settings:{name:'Servant',userName:'User',localDirectory:'/records',ownerRepo:'owner/repo',repositoryDirectory:'',collaborationId:'team',workerSeats:2,workspace:'/work'},connection:{participating:true,status:'connected'},messages:[],tasks:[],legacyTasks:[],archives:[],resources:[] })
const message = (id:string) => ({id,participantId:'U',createdAt:'2026-11-01',role:'user' as const,text:id})
const api = (extra:Partial<FrameworkClientApi> = {}) => ({view:async(input:any)=>view(input.mode??'local'),subscribeChanged:()=>()=>{},selectMode:async({mode}:any)=>view(mode),...extra}) as FrameworkClientApi

test('foreground-only model save preserves selected history, drafts and scope while using the authoritative returned model',async()=>{
 const calls:any[]=[], current=view(), c=new FrameworkClientController(api({foregroundModel:async input=>{calls.push(input);return {...current,revision:'r2',settings:{...current.settings,foreground:input.model},messages:[message('latest')] }},history:async()=>({revision:'h',messages:[message('old')],moreBefore:'older'})}))
 await c.refresh(); await c.navigateHistory({date:'2026-10-01',limit:50})
 c.retain({mode:'local',storageScope:'local-scope',collaborationId:'team',id:'draft',createdAt:'2026',text:'retained',recipient:'ai',device:'test',timezoneOffsetMinutes:0})
 await c.foregroundModel({mode:'local',storageScope:'local-scope',commandId:'model-1',expectedRevision:'r1',model:{provider:'p',model:'second'}})
 assert.equal(c.snapshot().value?.settings.foreground?.model,'second'); assert.equal(c.snapshot().value?.revision,'r2')
 assert.deepEqual(c.snapshot().value?.messages.map(m=>m.id),['old']);assert.equal(c.snapshot().value?.historyDate,'2026-10-01');assert.equal(c.snapshot().value?.pageBefore,'older')
 assert.equal(c.snapshot().drafts[0].input.text,'retained');assert.equal(calls.length,1)
})
test('settings-only model projection cannot erase conversation, execution, roster or scope facts',async()=>{
 const current={...view('git'),messages:[message('retained')],tasks:[{taskId:'task'}] as any,archives:[{path:'archive'}] as any,resources:[{instanceUUID:'peer'}] as any,hasOtherInstanceRecords:true,foregroundProcessing:{executionId:'running'} as any}
 const c=new FrameworkClientController(api({view:async()=>current,foregroundModel:async input=>({...view('git'),storageScope:undefined,revision:'r2',settings:{...current.settings,foreground:input.model},connection:{participating:false,status:'starting'}})}))
 await c.refresh()
 await c.foregroundModel({mode:'git',storageScope:'git-scope',commandId:'model',expectedRevision:'r1',model:{provider:'p',model:'second'}})
 assert.deepEqual(c.snapshot().value,{...current,revision:'r2',settings:{...current.settings,foreground:{provider:'p',model:'second'}}})
})
test('stopping participation adopts disconnected projection without erasing readable state; enabling still accepts full view',async()=>{
 const current={...view('git'),messages:[message('kept')],tasks:[{taskId:'task'}] as any,archives:[{path:'archive'}] as any,resources:[{instanceUUID:'peer'}] as any,historyWindow:true,historyDate:'2026-10-01',pageBefore:'older',foregroundProcessing:{executionId:'stopped'} as any}
 let enabled=false
 const c=new FrameworkClientController(api({view:async input=>input.headerOnly?view('git'):current,participation:async input=>{enabled=input.enabled;return{...view('git'),storageScope:undefined,revision:'r2',connection:{participating:input.enabled,status:input.enabled?'connected':'disconnected'},messages:input.enabled?[message('fresh')]:[]}}}))
 await c.refresh();const shown=c.snapshot().value;await c.participation(false)
 assert.deepEqual(c.snapshot().value,{...shown,revision:'r2',settings:view('git').settings,connection:{participating:false,status:'disconnected'},foregroundProcessing:undefined})
 assert.equal(enabled,false)
 await c.participation(true);assert.equal(enabled,true);assert.deepEqual(c.snapshot().value?.messages.map(m=>m.id),['fresh'])
})
test('a late stopped projection cannot overwrite navigation to another storage scope',async()=>{
 let finish!:(v:FrameworkClientView)=>void;let current=view('git')
 const c=new FrameworkClientController(api({view:async()=>current,participation:async()=>new Promise(r=>{finish=r})}))
 await c.refresh();const stop=c.participation(false)
 current={...view('git'),storageScope:'another-root',messages:[message('other')]};await c.refresh()
 finish({...view('git'),storageScope:undefined,connection:{participating:false,status:'disconnected'}});await stop
 assert.equal(c.snapshot().value?.storageScope,'another-root');assert.equal(c.snapshot().value?.connection.participating,true);assert.equal(c.snapshot().value?.messages[0].id,'other')
})
test('failed model save keeps prior selected route and a late result cannot replace a newer mode',async()=>{
 let resolve!:(v:FrameworkClientView)=>void; let fail=true
 const c=new FrameworkClientController(api({foregroundModel:async()=>{if(fail)throw Error('actual save failed');return new Promise(r=>{resolve=r})}}))
 await c.refresh();const input={mode:'local' as const,storageScope:'local-scope',commandId:'model-1',expectedRevision:'r1',model:{provider:'p',model:'second'}}
 await assert.rejects(c.foregroundModel(input),/actual save failed/);assert.equal(c.snapshot().value?.settings.foreground,undefined)
 fail=false;const pending=c.foregroundModel(input);await c.selectMode('git');resolve({...view(),settings:{...view().settings,foreground:input.model}});await pending
 assert.equal(c.snapshot().value?.activeMode,'git')
})

test('actual Conversation renders conditional People and official model picker with Auto; saves next-turn route without configure or losing draft',async()=>{
 const {build}=await import('esbuild'),{JSDOM}=await import('jsdom' as string),{pathToFileURL}=await import('node:url'),{resolve}=await import('node:path')
 await build({stdin:{contents:"export {FrameworkPage} from './src/framework/client-page.tsx'; export {ModelPicker} from './src/client/model-picker.tsx'; export {getFrameworkClientController} from './src/framework/client-contracts.ts';",resolveDir:process.cwd()},outfile:'.validation/conversation-controls-view.mjs',bundle:true,platform:'node',format:'esm',external:['react','react/*','react-dom','react-dom/*'],loader:{'.css':'empty'},define:Object.fromEntries(['ICON','WELCOME_CHARACTER','TASK_EMPTY_CHARACTER'].map(k=>['__SERVANT_'+k+'_DATA_URI__','""']))})
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 const put=(k:string,v:unknown)=>{saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true})}
 for(const k of ['window','document','Element','HTMLElement','HTMLTextAreaElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','MutationObserver'])put(k,k==='window'?dom.window:(dom.window as any)[k])
 put('getComputedStyle',dom.window.getComputedStyle.bind(dom.window));put('requestAnimationFrame',dom.window.requestAnimationFrame.bind(dom.window));put('cancelAnimationFrame',dom.window.cancelAnimationFrame.bind(dom.window));put('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});put('IS_REACT_ACT_ENVIRONMENT',true)
 dom.window.matchMedia=(()=>({matches:false,addEventListener(){},removeEventListener(){}})) as any
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{FrameworkPage,ModelPicker,getFrameworkClientController}=await import(pathToFileURL(resolve('.validation/conversation-controls-view.mjs')).href)
 const root=createRoot(document.getElementById('root')!),calls:any[]=[],sends:any[]=[];let current=view(),configure=0,fail=false
 const port=api({view:async()=>structuredClone(current),foregroundModel:async input=>{calls.push(input);if(fail)throw Error('model save unknown');current={...current,revision:'r'+(calls.length+1),settings:{...current.settings,foreground:input.model}};return structuredClone(current)},configure:async()=>{configure++;return current},send:async input=>{sends.push(input);return{revision:'message'}},history:async()=>({revision:'h',messages:[]})})
 const controller=getFrameworkClientController(port)
 const click=async(text:string)=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text||b.getAttribute('aria-label')===text);assert.ok(button,'button '+text);await React.act(async()=>{button.click();await new Promise(resolve=>setImmediate(resolve))})}
 const refresh=async()=>{await React.act(()=>controller.refresh())}
 const models={current:{provider:'p',model:'first'},groups:[{id:'p',name:'Provider',models:[{id:'first',name:'First'},{id:'second',name:'Second'}]}],failures:[],status:'ready',error:null}
 try {
  const render = async (language: string) => React.act(async()=>{root.render(React.createElement(FrameworkPage,{api:port,language,modelControl:(value:any,onChange:any,label:string,options:any)=>React.createElement(ModelPicker,{...options,value:value??{},models,onRefresh:async()=>{},label,t:(k:string)=>k,onChange:(route:any)=>onChange(route.provider&&route.model?route:undefined)})}));await new Promise(resolve=>setImmediate(resolve))})
  await render('zh');assert.match(document.body.textContent!,/围绕您的目标，持续做事与积累经验。/);assert.doesNotMatch(document.body.textContent!,/对话、协作与持续执行|围绕你的目标/)
  await render('en');assert.match(document.body.textContent!,/Work toward your goals and build reusable experience/)

  assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent==='People'),false,'Local does not expose People')
  current={...view('git'),hasOtherInstanceRecords:false};await refresh();assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent==='People'),false,'self-only/unknown has no People')
  current={...current,hasOtherInstanceRecords:true,resources:[]};await refresh();assert.ok([...document.querySelectorAll('button')].some(b=>b.textContent==='People'),'another record suffices even when the filtered resources array is empty')
  const textarea=document.querySelector('textarea[aria-label="Message"]')! as HTMLTextAreaElement
  await React.act(()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Keep my draft');textarea.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
  await click('Foreground model');assert.match(document.body.textContent!,/Auto/);await click('Second')
  assert.equal(calls[0].model.model,'second');assert.equal(calls[0].storageScope,'git-scope');assert.equal(configure,0);assert.equal(textarea.value,'Keep my draft');assert.match(document.body.textContent!,/Used for the next conversation turn/)
  await click('Foreground model');const auto=[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('Auto')&&b.getAttribute('role')?.startsWith('menuitem'));assert.ok(auto,'Auto menu choice');await React.act(async()=>{auto.click()});assert.equal(calls[1].model,undefined)
  fail=true;await click('Foreground model');await click('Second');assert.match(document.body.textContent!,/model save unknown/);assert.equal(current.settings.foreground,undefined)
  const failedId=calls.at(-1).commandId;fail=false;await click('Resolve and retry model setting');assert.equal(calls.at(-1).commandId,failedId);assert.equal((current.settings as FrameworkClientView['settings']).foreground?.model,'second')
  await click('People');current={...current,hasOtherInstanceRecords:false};await refresh();assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent==='People'),false)
  await React.act(async()=>{textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}))});assert.equal(sends[0].recipient,'ai');assert.equal(sends[0].text,'Keep my draft');assert.equal(configure,0)
  assert.doesNotMatch(document.body.textContent!,/消息已提交|Message submitted/)
  await click('Settings'); assert.equal(document.querySelectorAll('button[aria-label=\"Foreground model\"]').length,1,'Settings does not duplicate the conversation Foreground picker'); const background=document.querySelector('button[aria-label=\"Background model\"]'); assert.ok(background); assert.match(background.textContent!,/Follow Foreground/); assert.match(background.textContent!,/Second/); await click('Background model'); assert.match(document.body.textContent!,/model and reasoning effort/); await click('Close')
 } finally {await React.act(()=>root.unmount());dom.window.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete(globalThis as any)[k]}}
})
