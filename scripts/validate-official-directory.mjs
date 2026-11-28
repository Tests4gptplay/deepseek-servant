import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {JSDOM} from 'jsdom'
import esbuild from 'esbuild'
const require=createRequire(import.meta.url)
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:cb=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout})
globalThis.ResizeObserver=class{observe(){}disconnect(){}}
const React=require('react'),{createRoot}=require('react-dom/client')
const result=await esbuild.build({entryPoints:[process.env.DSS_PICKER_SOURCE ?? new URL('../src/client/directory-picker.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,outfile:'/tmp/dss-picker-test.cjs',external:['react','react-dom','react-dom/*'],loader:{'.css':'empty','.svg':'text'}})
const mod={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,mod,mod.exports)
const {useDirectoryPicker}=mod.exports
const listing=path=>({path,home:'/home/user',parent:'/',crumbs:[{name:'/',path:'/',hidden:false},{name:'work',path,hidden:false}],entries:[],truncated:false})
let native=0,calls=[],picker,saved=[]
globalThis.__DSH_DIRECTORY_PICKER__={pick:async()=>{native++;return '/native'}}
const workspace={listDirectory:async path=>{calls.push(path);return listing(path??'/home/user')},createDirectory:async()=>{throw Error('not exercised')},pickDirectory:async()=>{native++;return '/fallback'}}
let available=true, dedicated=true
const adapter={listDirectory:workspace.listDirectory,createDirectory:workspace.createDirectory}
workspace.listDirectory=async()=>{throw Object.assign(Error('composed picker serves native'),{rpcError:{code:'directory-picker/unavailable'}})}
const localeBundle=await esbuild.build({stdin:{contents:"export {LocaleRuntime} from '@deepseek-ai/dsh-client-locale/src/client/index.ts'; export {DIRECTORY_NS,zh,en} from './src/client/directory-locales.ts'",resolveDir:process.cwd()},outfile:'/tmp/dss-locale-test.cjs',bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react-dom','react-dom/*'],loader:{'.css':'empty','.svg':'text'}})
const lm={exports:{}};new Function('require','module','exports',localeBundle.outputFiles[0].text)(require,lm,lm.exports)
const {LocaleRuntime,DIRECTORY_NS,zh,en}=lm.exports
const officialSource=readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-directory-picker-browse/src/client/index.ts'),'utf8')
for(const [lang,dict] of [['zh',zh],['en',en]]) {const body=officialSource.split("['"+lang+"', {")[1].split('}],')[0];const expected=new Function('return ({'+body+'})')(); expected['browser.title']=lang==='zh'?'选择文件夹':'Select folder'; assert.deepEqual(dict,expected,'official '+lang+' dictionary with only generic folder title override')}

const {Context}=require('@deepseek-ai/cordis');const lc=new Context();const locale=new LocaleRuntime(lc)
locale.register(DIRECTORY_NS,{zh,en});locale.register('directory-browser',{en:{'browser.open':'Unrelated official owner'}})
for(const lang of ['zh','en']) {locale.setLocale(lang);const t=locale.bind(DIRECTORY_NS);for(const [key,value] of Object.entries(lang==='zh'?zh:en)) assert.equal(t(key,{name:'Test'}),value.replace('{name}','Test'))}
const ctx={get:()=>available?workspace:undefined,locale}
function App(){picker=useDirectoryPicker(ctx,dedicated?adapter:undefined);return picker.dialog}
const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
try{
 await React.act(async()=>root.render(React.createElement(App)))
 let choice;await React.act(async()=>{choice=picker.pick('/chosen/work').then(v=>{if(v!==null)saved.push(v);return v})})
 assert.equal(native,0);assert.equal(calls[0],'/chosen/work');assert.ok(document.querySelector('[role="dialog"]'),'official modal structure rendered')
 const button=key=>[...document.querySelectorAll('button')].find(b=>b.textContent===key)
 assert.ok(button('Open'));assert.ok(button('Cancel'));assert.ok(document.body.textContent.includes('Select folder'));assert.ok(document.body.textContent.includes('New folder'));assert.ok(document.body.textContent.includes('Show hidden files'));assert.ok(!document.body.textContent.includes('browser.'))
 await React.act(async()=>button('Open').click());assert.equal(await choice,'/chosen/work');assert.deepEqual(saved,['/chosen/work'])
 locale.setLocale('zh'); await React.act(async()=>{choice=picker.pick('/second').then(v=>{if(v!==null)saved.push(v);return v})});assert.ok(document.body.textContent.includes('选择文件夹'));assert.ok(document.body.textContent.includes('新建文件夹'));assert.ok(document.body.textContent.includes('显示隐藏文件'));assert.ok(button('打开'));assert.ok(!document.body.textContent.includes('browser.'));await React.act(async()=>button('取消').click());assert.equal(await choice,null);assert.deepEqual(saved,['/chosen/work'])
 await React.act(async()=>{assert.equal(await picker.pick('  '),'/native')});assert.equal(native,1)
 available=false;dedicated=false;await React.act(async()=>root.render(React.createElement(App)));await React.act(async()=>assert.equal(await picker.pick('/desired'),'/native'));assert.equal(native,2)
 console.log('PASS actual LocaleRuntime + complete official zh/en dictionaries, distinct namespace coexistence and translated Chinese/English rendered labels; official DirectoryBrowser+official primitives in React/JSDOM: requested starting path, modal/buttons, confirm/cancel and save continuation, no-path native, no-workspace native. No native visual/Windows test.')
}finally{await React.act(async()=>root.unmount());container.remove();dom.window.close()}
