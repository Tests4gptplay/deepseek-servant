// Full current ManualCleanupPanel in React + actual FrameworkClientController.
// Cleanup RPC succeeds; ordinary history read remains pending then succeeds.
import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {createRequire,registerHooks,stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
const sourceRoot=new URL('../src/',import.meta.url),loaded=new Map()
const hooks=registerHooks({resolve(s,c,n){if(s.startsWith('.')&&c.parentURL?.startsWith(sourceRoot.href)&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}return n(s,c)},load(u,c,n){if(u.startsWith(sourceRoot.href)&&u.endsWith('.ts')){const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(sourceRoot.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})
const {FrameworkClientController}=await import('../src/framework/client-contracts.ts'),errors=await import('../src/framework/client-error.ts')
const require=createRequire(new URL('../package.json',import.meta.url)),React=require('react'),{createRoot}=require('react-dom/client'),{JSDOM}=require('jsdom'),esbuild=require('esbuild')
const source=readFileSync(new URL('../src/framework/manual-cleanup-panel.tsx',import.meta.url),'utf8');loaded.set('framework/manual-cleanup-panel.tsx',createHash('sha256').update(source).digest('hex'))
const built=await esbuild.transform(source,{loader:'tsx',format:'cjs',jsx:'automatic'})
const module={exports:{}};new Function('require','module','exports',built.code)(s=>s==='@deepseek-ai/dsh-client-ui-primitives'?{Button:({children,...p})=>React.createElement('button',p,children)}:s.endsWith('.module.css')?{}:s==='./client-error.js'?errors:require(s),module,module.exports)
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})
let release;const wait=new Promise(resolve=>release=resolve),calls=[],previewCalls=[],refresh=[]
const view={activeMode:'local',collaborationId:'c',storageScope:'scope',revision:'r',settings:{name:'A',userName:'',localDirectory:'',ownerRepo:'',repositoryDirectory:'',collaborationId:'c',workerSeats:0,workspace:''},connection:{status:'connected',participating:true},messages:[],tasks:[],archives:[],resources:[],executions:[]}
const api={cleanupPreview:async input=>{previewCalls.push(input);return{id:'preview-'+previewCalls.length,kind:'debug',files:[],bytes:0}},cleanupRecords:async input=>{calls.push(input);return{cleared:true,receipt:{revision:'r2'},deletedPaths:[],preservedPaths:[]}},history:async()=>{refresh.push('history-start');await wait;refresh.push('history-done');return{messages:[],order:[],storageScope:'scope'}},view:async()=>{refresh.push('panels');return view}}
const controller=new FrameworkClientController(api);controller.publish({value:view})
const root=createRoot(document.querySelector('#root')),button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent===label)
let assertions=0;const check=(a,b,label)=>{assert.deepEqual(a,b,label);assertions++}
try{
 await React.act(async()=>root.render(React.createElement(module.exports.ManualCleanupPanel,{api,storageScope:'scope',tr:(_cn,en)=>en,changed:async()=>{await controller.latest();await controller.refresh(true)}})))
 await React.act(async()=>button('Clear debug records').click());check(previewCalls.length,1,'Original preview read once')
 await React.act(async()=>button('Confirm cleanup').click());check(calls.length,1,'Cleanup was submitted once');check(calls[0].preview.id,'preview-1','Exact original preview is submitted')
 check(document.querySelector('[role="status"]').textContent.includes('Cleanup finished'),true,'Actual fulfilled cleanup remains success')
 check(refresh,['history-start'],'Existing independent read is pending')
 check(button('Inspect record usage and directories').disabled,false,'Unrelated panel buttons are available after successful cleanup')
 await React.act(async()=>button('Clear debug records').click());check(previewCalls.length,2,'Next explicit preview proceeds before older refresh');check(calls.length,1,'Second preview is not auto-confirmed')
 await React.act(async()=>release());check(refresh,['history-start','history-done','panels','history-start','history-done'],'Existing latest then forced refresh finishes on its ordinary path')
 check(!!button('Confirm cleanup'),true,'New unsubmitted choice remains after older refresh')
 console.log(JSON.stringify({status:'passed',assertions,limits:'Whole actual React panel and real Controller, controlled normal RPC responses; no Service deletion, native Host, or forced failure claimed.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await React.act(async()=>root.unmount());dom.window.close();hooks.deregister()}
