// Exact current composer state/handler/fieldset with real React and client Controller.
// RPC promises are held pending, then succeed normally. No failure injection.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hooks = registerHooks({ resolve(s,c,n) {
  if(s.startsWith('.') && c.parentURL?.startsWith(sourceRoot.href) && s.endsWith('.js')) {const url=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
  return n(s,c)
},load(url,c,n){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform'}),shortCircuit:true}}return n(url,c)}})
const {FrameworkClientController,frameworkScopeKey}=await import('../src/framework/client-contracts.ts')
const require=createRequire(new URL('../package.json',import.meta.url)),React=require('react'),{JSDOM}=require('jsdom'),{createRoot}=require('react-dom/client'),esbuild=require('esbuild')
const page=await fs.readFile(new URL('../src/framework/client-page.tsx',import.meta.url),'utf8')
loaded.set('framework/client-page.tsx',createHash('sha256').update(page).digest('hex'))
const states=page.split('\n').filter(line=>/^  const \[model/.test(line)).join('\n')
const scope=page.split('\n').find(line=>line.startsWith('  const scope = ')),derived=page.split('\n').filter(line=>line.startsWith('  const modelOperation = ')).join('\n')
const begin=page.indexOf('  const saveForegroundModel = ('),end=page.indexOf('  const unknownPhysicalSource',begin)
const field=page.indexOf('<fieldset disabled={!!modelSaving || changingMode}'),fieldEnd=page.indexOf('</fieldset>',field)+11
assert.ok(states&&scope&&begin>=0&&end>begin&&field>=0&&fieldEnd>field)
const code=`import {useState,useSyncExternalStore} from 'react'; export function Composer({controller,props,frameworkScopeKey}) {const view=useSyncExternalStore(controller.subscribe,controller.snapshot).value,tr=(_cn,en)=>en,changingMode=false; const [error,setError]=useState(''); ${states}\n${scope}\n${derived}\nconst frameworkErrorText=String; ${page.slice(begin,end)} return (${page.slice(field,fieldEnd)});}`
const built=await esbuild.build({stdin:{contents:code,loader:'tsx',resolveDir:new URL('../',import.meta.url).pathname},bundle:true,packages:'external',platform:'node',format:'cjs',jsx:'automatic',write:false})
const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(require,module,module.exports)
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})
const view=mode=>({activeMode:mode,collaborationId:'c',storageScope:mode+'-scope',revision:'r',settings:{name:'A',userName:'',localDirectory:'',ownerRepo:'',repositoryDirectory:'',collaborationId:'c',workerSeats:0,workspace:''},connection:{status:'connected',participating:true},messages:[],tasks:[],archives:[],resources:[],executions:[]})
const pending=new Map(),requests=[];let active=view('local')
const api={view:async()=>active,history:async()=>({messages:[],order:[],storageScope:active.storageScope}),selectMode:async({mode})=>active=view(mode),foregroundModel:input=>{requests.push(input);return new Promise(resolve=>pending.set(input.mode,()=>resolve({...view(input.mode),settings:{...view(input.mode).settings,foreground:input.model}})))}}
const controller=new FrameworkClientController(api);controller.publish({value:active})
const root=createRoot(document.querySelector('#root'));let assertions=0
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);assertions++},button=()=>document.querySelector('button')
try {
 await React.act(async()=>root.render(React.createElement(module.exports.Composer,{controller,frameworkScopeKey,props:{modelControl:(_v,onChange,_label,options)=>React.createElement('button',{disabled:options.disabled,onClick:()=>onChange({provider:'fixture',model:'choice'})},'Choose')}})))
 check(button().disabled,false,'Local starts enabled')
 await React.act(async()=>button().click());check(button().disabled,true,'Same scope still owns its pending save')
 await React.act(async()=>controller.selectMode('git'))
 check(controller.snapshot().value.activeMode,'git','Actual controller mode navigation completes during pending Local save')
 check(button().disabled,false,'Git selection does not wait for Local save')
 await React.act(async()=>button().click());check(requests.map(r=>r.mode),['local','git'],'Both distinct mode saves were submitted')
 await React.act(async()=>controller.selectMode('local'));check(button().disabled,true,'Original Local remains pending')
 await React.act(async()=>pending.get('git')());check(button().disabled,true,'Git success cannot release Local pending')
 await React.act(async()=>pending.get('local')());check(button().disabled,false,'Local success retires its pending state')
 await React.act(async()=>controller.selectMode('git'));check(button().disabled,false,'Git remains enabled after its prior success')
 await React.act(async()=>button().click());check(button().disabled,true,'Git owns its pending save')
 await React.act(async()=>controller.selectMode('local'));check(button().disabled,false,'Local does not wait for pending Git save')
 await React.act(async()=>button().click());check(requests.map(r=>r.mode),['local','git','git','local'],'Both reverse-direction selections were submitted')
 await React.act(async()=>controller.selectMode('git'));check(button().disabled,true,'Original Git remains pending')
 await React.act(async()=>pending.get('local')());check(button().disabled,true,'Local success cannot release Git pending')
 await React.act(async()=>pending.get('git')());check(button().disabled,false,'Git success retires its pending state')
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual React composer fragments and FrameworkClientController; normal controlled RPC ordering. No Service persistence, complete DSH UI or native model execution claimed.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await React.act(async()=>root.unmount());dom.window.close();hooks.deregister()}
