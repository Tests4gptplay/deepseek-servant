import './dsh-sdk-runtime.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {sdkHostRoot} from './dsh-sdk-runtime.mjs'
const requireHost=createRequire(path.join(sdkHostRoot,'package.json'))
const React=requireHost('react'),{JSDOM}=requireHost('jsdom'),esbuild=requireHost('esbuild')
const cordis=await import('@deepseek-ai/cordis'),store=await import('@deepseek-ai/dsh-client-store'),slots=await import('@deepseek-ai/dsh-client-ui-slots')
export async function openQuestionUi(host,agent,service,mark){
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'})
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.Event=dom.window.Event;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const {createRoot}=requireHost('react-dom/client'),{Simulate}=requireHost('react-dom/test-utils')
 const modules={'@deepseek-ai/cordis':cordis,'@deepseek-ai/dsh-client-store':store,'@deepseek-ai/dsh-client-ui-slots':slots,'@deepseek-ai/dsh-client-ui-primitives':{}}
 async function load(name,expose=''){
  let value;window.__ModuleLoader__={load({factory}){value=factory(n=>modules[n]??requireHost(n))}}
  const original=await fs.readFile(path.join(sdkHostRoot,'node_modules',name,'lib/client.js'),'utf8')
  new Function('window',expose?original.replace('exports.apply = apply;',expose+'; exports.apply = apply;'):original)(window)
  return value
 }
 const {UiSession}=await load('@deepseek-ai/dsh-client-ui-session')
 const {__audit:{QuestionCards,publishContinuedQuestions,answerQuestion}}=await load('@deepseek-ai/dsh-client-ui-user-questions','exports.__audit={QuestionCards,publishContinuedQuestions,answerQuestion}')
 // In-process transport boundary: actual Host snapshot/event values and exact native answer.
 // No manual PendingQuestion construction, continued state, or RPC attachment.
 const clientCtx=new cordis.Context(),listeners=new Set(),faces=new Map(),id=agent.session.header.id
 const snapshot=host.sessionProjections.snapshot(agent.session).values
 for(const key of ['userQuestions','inbox']){let value=snapshot[key];const subscribers=new Set();faces.set(key,{getSnapshot:()=>value,subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},change:v=>{value=v;for(const f of subscribers)f()}})}
 const stop=host.sessionProjections.onChanged((session,key,value)=>{if(session===agent.session)faces.get(key)?.change(value)})
 const binding={sessionId:id,ctx:clientCtx,session:{projections:{faceOf:key=>faces.get(key)}}}
 let rows={phase:'ready',ids:[id],byId:{[id]:{id,running:agent.status==='running',retainedBy:{}}}}
 const sessions={scopeOf:owner=>owner===agent?id:undefined,list:{getSnapshot:()=>rows,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},binding:key=>key===id?binding:undefined}
 clientCtx.provide('remote',{$on:()=>()=>{},userQuestions:{answer:async(sessionId,callId,answer)=>{
  mark('ui-native-answer',{sessionId,callId,answer});try{return{ok:true,value:host.userQuestions.answer(host.agents.get(sessionId),callId,answer)}}catch(e){return{ok:false,error:{message:e.message,code:e.code}}}
 }}})
 const uiSession=new UiSession(clientCtx,sessions)
 const cards=new QuestionCards(uiSession.registerPendingInteraction(()=>1))
 const stopPublish=publishContinuedQuestions({sessions,remote:clientCtx.remote},cards)
 const built=await esbuild.build({entryPoints:[new URL('../../src/client/native-questions.tsx',import.meta.url).pathname.replace('/scripts/src/','/src/')],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,packages:'external',plugins:[{name:'markdown-rendering',setup(build){build.onResolve({filter:/client-markdown/},args=>({path:args.path,namespace:'simple-markdown'}));build.onLoad({filter:/.*/,namespace:'simple-markdown'},()=>({contents:'exports.FrameworkMarkdown = ({text}) => text',loader:'js'}))}}]})
 const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(requireHost,module,module.exports)
 const Component=module.exports.NativeQuestionRegion,container=document.createElement('div');document.body.append(container);const root=createRoot(container)
 let executions=(await service.view({mode:'local',headerOnly:true})).executions
 const client={getSnapshot:()=>uiSnapshot,subscribe:()=>()=>{}},uiSnapshot={uiSession,generation:0}
 function App(){const [tab,setTab]=React.useState('conversation');return React.createElement(React.Fragment,null,React.createElement('button',{id:'tab',onClick:()=>setTab(t=>t==='conversation'?'tasks':'conversation')},tab),tab==='conversation'&&React.createElement(Component,{client,executions,zh:false}))}
 await React.act(async()=>root.render(React.createElement(App)))
 return{container,cards,uiSession,
  answerRequest: (request,next)=>answerQuestion({...clientCtx,sessions,remote:clientCtx.remote,effect:clientCtx.effect.bind(clientCtx)},agent,request,next,cards),
  async choose(label){await React.act(async()=>{const row=[...container.querySelectorAll('label')].find(e=>e.textContent.includes(label));if(!row)throw Error('No actual question option '+label);Simulate.change(row.querySelector('input'),{target:{checked:true}})})},
  async tab(){await React.act(async()=>container.querySelector('#tab').click())},
  async submit(){await React.act(async()=>{const b=[...container.querySelectorAll('button')].find(e=>e.textContent==='Submit answers');if(!b)throw Error('No actual question submit button');b.click()})},
  async refresh(){executions=(await service.view({mode:'local',headerOnly:true})).executions;await React.act(async()=>root.render(React.createElement(App)))},
  async close(){await React.act(async()=>root.unmount());stopPublish();cards.dispose();stop();await clientCtx.fiber.dispose();dom.window.close()}
 }
}
