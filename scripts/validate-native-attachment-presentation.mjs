import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require=createRequire(new URL('../package.json',import.meta.url)), React=require('react'),{createRoot}=require('react-dom/client'),{JSDOM}=require('jsdom'),esbuild=require('esbuild')
const entry=fileURLToPath(new URL('../src/client/native-attachment-owner.tsx',import.meta.url))
const built=await esbuild.build({ alias: Object.fromEntries(['FileCard', 'AttachmentRail'].map(name => { const spec = `@deepseek-ai/dsh-client-ui-attachment/src/${name}.tsx`; return [spec, require.resolve(spec)] })),entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',plugins:[{name:'css-test-port',setup(b){b.onResolve({filter:/\.module\.css$/},a=>({path:a.path,namespace:'css'}));b.onLoad({filter:/.*/,namespace:'css'},()=>({contents:'export default {}',loader:'js'}))}}]})
const primitives=new Proxy({fileExtension:n=>n.split('.').at(-1),fileSizeText:n=>`${n} B`},{get:(t,k)=>t[k]??(()=>null)})
const mod={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(s=>s==='@deepseek-ai/dsh-client-ui-primitives'?primitives:require(s),mod,mod.exports)
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true})
let created=[],revoked=[],observed,removed=[],retried=[];const create=URL.createObjectURL,revoke=URL.revokeObjectURL
URL.createObjectURL=file=>{const url='blob:test-'+created.length;created.push({file,url});return url};URL.revokeObjectURL=url=>revoked.push(url)
const image=new File(['image original'],'photo.png',{type:'image/png'}),text=new File(['text original'],'notes.txt',{type:'text/plain'})
const imageRow={id:'image',name:image.name,mimeType:image.type,bytes:image.size,file:image,state:'selected'},textRow={id:'text',name:text.name,mimeType:text.type,bytes:text.size,file:text,state:'selected'}
const root=createRoot(document.getElementById('root')),checks=[];let unmounted=false
const props={rows:[imageRow,textRow],canAcceptDrop:true,onAddFiles:()=>{},onRemove:id=>removed.push(id),onRetry:id=>retried.push(id),zh:false,renderImages:owner=>{observed=owner;return null}}
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name)}
try{
 await React.act(async()=>root.render(React.createElement(mod.exports.NativeAttachmentOwner,props)))
 check('One real image File creates one preview and generic file creates none',created.map(x=>x.file),[image])
 check('Native owner gets actual File and preview, not a synthetic receipt',[observed.attachments[0].file===image,observed.attachments[0].previewUrl,observed.uploads],[true,'blob:test-0',{}])
 check('Official file card is used for a selected generic original',[document.body.textContent.includes('notes.txt'),document.body.textContent.includes('TXT'),document.body.textContent.includes('Uploading')],[true,true,false])
 await React.act(async()=>document.querySelector('button[aria-label="Remove notes.txt"]').click());check('Official removal control calls only its own selection',removed,['text'])
 await React.act(async()=>root.render(React.createElement(mod.exports.NativeAttachmentOwner,{...props,rows:[{...imageRow,state:'uploading'},textRow]})))
 check('Re-render reuses image URL and shows only actual ongoing upload',[created.length,observed.uploads.image.status],[1,'uploading'])
 await React.act(async()=>root.render(React.createElement(mod.exports.NativeAttachmentOwner,{...props,rows:[{...imageRow,state:'error',error:'Upload failed'},textRow]})))
 check('Actual upload error reaches native image presentation without receipt',observed.uploads.image,{status:'error',message:'Upload failed'})
 observed.onRetryFile('image');check('Retry remains existing owner action',retried,['image'])
 await React.act(async()=>root.render(React.createElement(mod.exports.NativeAttachmentOwner,{...props,rows:[textRow]})))
 check('Removal revokes original preview URL and removes File from native owner',[revoked,observed.attachments],[['blob:test-0'],[]])
 await React.act(async()=>root.render(React.createElement(mod.exports.NativeAttachmentOwner,props)))
 check('Returning File gets a new owned URL after previous one was released',created.length,2)
 await React.act(async()=>root.unmount());unmounted=true
 check('Unmount releases every remaining preview exactly once',revoked,['blob:test-0','blob:test-1'])
 check('No image or text original bytes were changed',[await image.text(),await text.text()],['image original','text original'])
 console.log(JSON.stringify({status:'passed',assertions:checks.length,checks,limits:'Controlled React/jsdom owner test; actual Host slot and CSS must be tested in real rc3 UI. No Host upload, receipt or network operation is part of this presentation owner.'},null,2))
}finally{if(!unmounted)await React.act(async()=>root.unmount());URL.createObjectURL=create;URL.revokeObjectURL=revoke;dom.window.close()}
