import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),React=require('react'),{renderToString}=require('react-dom/server')
const {JSDOM}=require('jsdom'); const dom=new JSDOM('<div></div>'); globalThis.document=dom.window.document
const bytes=await fs.readFile(process.env.DSS_BUNDLE_PATH ?? new URL('../lib/client.js',import.meta.url)),source=bytes.toString()
const injected=source.replace('return module.exports; } });','module.exports.__testNative = { FileCard, ComposerAttachments, AttachmentRail, NativeAttachmentOwner }; return module.exports; } });')
assert.notEqual(injected,source)
let result
const primitive=new Proxy({fileExtension:n=>n.split('.').at(-1),fileSizeText:n=>`${n} B`},{get:(t,k)=>t[k]??(()=>null)})
dom.window.__ModuleLoader__={load:({factory})=>{result=factory(spec=>spec==='@deepseek-ai/dsh-client-ui-primitives'?primitive:spec.startsWith('@deepseek-ai/')?{}:require(spec))}}
new Function('window',injected)(dom.window)
const {FileCard,ComposerAttachments,AttachmentRail}=result.__testNative
const card=renderToString(React.createElement(FileCard,{name:'bundle.txt',bytes:61,state:'ready',labels:{label:'bundle.txt',remove:'Remove',uploading:'Uploading',failed:'Failed',retry:'Retry'},onRemove(){},onRetry(){}}))
assert.match(card,/bundle.txt/);assert.match(card,/61 B/)
assert.equal(renderToString(React.createElement(ComposerAttachments,{attachments:[],canAcceptDrop:true,onAddFiles(){},onRemoveAttachment(){},uploads:{},onRetryFile(){},uploadFailureText:s=>s,t:s=>s,readFileDrag(){}})), '')
assert.ok(renderToString(React.createElement(AttachmentRail,{items:[{id:'one'}],labels:{group:'Files',scrollLeft:'Left',scrollRight:'Right'},renderItem:()=>React.createElement('span',null,'one')})).includes('one'))
const {createRoot}=require('react-dom/client')
for (const [key,value] of Object.entries({window:dom.window,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})) Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})
const root=createRoot(document.body.appendChild(document.createElement('div'))), added=[]
const file=new File(['drop source'],'drop.txt',{type:'text/plain'})
const owner={rows:[],canAcceptDrop:true,onAddFiles:files=>added.push(...files),onRemove(){},onRetry(){},zh:false}
const renderImages=props=>React.createElement(ComposerAttachments,{...props,t:s=>s,readFileDrag(){}})
await React.act(async()=>root.render(React.createElement(result.__testNative.NativeAttachmentOwner,{...owner,renderImages})))
const drop=()=>{const e=new dom.window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(e,'dataTransfer',{value:{types:['Files'],files:[file],items:[{kind:'file',getAsFile:()=>file}]}});document.body.dispatchEvent(e);return e}
let dropped
await React.act(async()=>{dropped=drop()})
assert.deepEqual(added,[file]);assert.equal(dropped.defaultPrevented,true)
await React.act(async()=>root.render(React.createElement(result.__testNative.NativeAttachmentOwner,owner)))
const away=drop();assert.deepEqual(added,[file]);assert.equal(away.defaultPrevented,false)
await React.act(async()=>root.unmount());dom.window.close()
console.log(JSON.stringify({status:'passed',bundleSHA256:createHash('sha256').update(bytes).digest('hex'),checks:['Actual production bundle native FileCard renders type/size','Actual production bundle ComposerAttachments empty render works','Actual production bundle AttachmentRail renders item','Visible native drop prevents browser open and adds exactly one File','Removing native renderer detaches document drop and no longer intercepts native page'],limits:'Production bytes executed in controlled React SSR plus jsdom with shared Host primitives stubbed. Not a real browser CSS/drop/lightbox test. Temporary exposure exists only in test evaluation, never saved to bundle.'},null,2))
