import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

const root=new URL('../src/',import.meta.url),hash=value=>createHash('sha256').update(value).digest('hex'),loaded=new Map()
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(root.href)&&specifier.endsWith('.js')){
  const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}
 }
 return next(specifier,context)
},load(url,context,next){
 if(url.startsWith(root.href)&&url.endsWith('.ts')){
  const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(root.href.length),hash(source))
  return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
 }
 return next(url,context)
}})
const {FrameworkService}=await import('../src/framework/service.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {LocalRecordFiles}=await import('../src/framework/local-record-files.ts')
const {FrameworkClientController}=await import('../src/framework/client-contracts.ts')
class Records{
 constructor(directory){this.files=new LocalRecordFiles(directory)}
 async get(key){const raw=await this.files.read(hash(key)+'.json');return raw===undefined?undefined:JSON.parse(raw)}
 async set(key,value){await this.files.replace(hash(key)+'.json',JSON.stringify(value))}
 async delete(key){return this.files.delete(hash(key)+'.json')}
 async list(){throw Error('This addressed UI page must not scan unrelated Host records')}
}
const names=[],check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);names.push(name)}
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dss-missing-body-page-'))
const settings={name:'DSS',userName:'User',localDirectory:directory,ownerRepo:'',repositoryDirectory:'',collaborationId:'chat',workerSeats:0,workspace:''}
const service=new FrameworkService({},new Records(directory+'-records'),settings)
service.saved.set('local',{revision:'settings',settings})
try{
 const access=await service.access('local'),files=access.connection.files,conversation=access.conversation,storageScope=access.connection.scope
 check('Actual Service opens physical Local connection',files instanceof PhysicalLocalFiles,true)
 for(const [id,date] of [['a','2026-11-11T00:00:00Z'],['b','2026-11-11T00:00:01Z'],['c','2026-11-11T00:00:02Z'],['d','2026-11-12T00:00:00Z']])
  await service.send({mode:'local',collaborationId:'chat',storageScope,id,createdAt:date,text:'body-'+id,recipient:'ai',device:'dsh-web'})
 const view={revision:'settings',activeMode:'local',collaborationId:'chat',storageScope,settings,connection:{status:'connected',participating:true},messages:[],tasks:[],legacyTasks:[],archives:[],resources:[],executions:[]}
 const controller=new FrameworkClientController({history:input=>service.history(input)})
 controller.publish({value:view});await controller.latest()
 check('Initial actual UI controller shows all originals',controller.snapshot().value.messages.map(row=>row.id),['a','b','c','d'])
 const snapshot=await files.snapshot();let missingPath
 try{const index=JSON.parse(await files.read(snapshot,conversation.indexPath));missingPath=JSON.parse(await files.read(snapshot,index.messages[1].path)).textPath}
 finally{await snapshot.release()}
 await fs.unlink(path.join(directory,missingPath))
 await assert.rejects(()=>conversation.page(4),/Original message text is missing/)
 const page=await service.history({mode:'local',collaborationId:'chat',storageScope,limit:3})
 check('Actual Service latest preserves the two other bodies',page.messages.map(row=>[row.id,row.text]),[['c','body-c'],['d','body-d']])
 check('Actual Service reports exact missing ID and path',page.missingBodies,[{id:'b',path:missingPath}])
 check('Selected index identities remain exact',page.selectedIds,['b','c','d'])
 check('Missing first row still owns older cursor',page.moreBefore,'b')
 check('Older cursor reaches its preceding message',(await service.history({mode:'local',collaborationId:'chat',storageScope,beforeId:'b',limit:2})).messages.map(row=>row.id),['a'])
 check('Old date preserves neighbors',(await service.history({mode:'local',collaborationId:'chat',storageScope,date:'2026-11-11',limit:4})).messages.map(row=>row.id),['a','c'])
 check('New date remains independent',(await service.history({mode:'local',collaborationId:'chat',storageScope,date:'2026-11-12',limit:4})).messages.map(row=>row.id),['d'])
 const paged=new FrameworkClientController({history:input=>service.history({...input,limit:input.beforeId?input.limit:3})})
 paged.publish({value:view});await paged.latest()
 check('UI latest cursor can name missing first row',paged.snapshot().value.pageBefore,'b')
 await paged.older(2)
 check('UI older action retains other physical messages',paged.snapshot().value.messages.map(row=>row.id),['a','c','d'])
 check('UI older action keeps the missing-body notice',paged.snapshot().value.missingBodies,[{id:'b',path:missingPath}])
 await controller.latest()
 check('UI controller retires previously cached deleted body',controller.snapshot().value.messages.map(row=>row.id),['a','c','d'])
 check('UI controller retains explicit missing notice',controller.snapshot().value.missingBodies,[{id:'b',path:missingPath}])
 await controller.navigateHistory({date:'2026-11-12',limit:20})
 check('Date selection removes unrelated missing notice',controller.snapshot().value.missingBodies,[])
 await controller.latest()
 check('Latest restores exact missing notice',controller.snapshot().value.missingBodies,[{id:'b',path:missingPath}])
 await assert.rejects(()=>conversation.read('b'),/Original message text is missing/)
 await fs.writeFile(path.join(directory,missingPath),'user-provided replacement')
 await controller.latest()
 check('Physical user replacement is read as its own content',controller.snapshot().value.messages.find(row=>row.id==='b').text,'user-provided replacement')
 check('Refresh removes the resolved missing notice',controller.snapshot().value.missingBodies,[])
 await fs.unlink(path.join(directory,missingPath))
 await controller.latest()
 check('Later user deletion again removes the old visible body',controller.snapshot().value.messages.some(row=>row.id==='b'),false)
 check('Later user deletion again reports the exact missing body',controller.snapshot().value.missingBodies,[{id:'b',path:missingPath}])
 await service.send({mode:'local',collaborationId:'chat',storageScope,id:'e',createdAt:'2026-11-12T00:00:01Z',text:'body-e',recipient:'ai',device:'dsh-web'})
 await controller.latest()
 check('A new ordinary send remains visible',controller.snapshot().value.messages.map(row=>row.id),['a','c','d','e'])
 check('New send does not erase missing notice',controller.snapshot().value.missingBodies,[{id:'b',path:missingPath}])
 hooks.deregister()
 const pageSource=readFileSync(new URL('../src/framework/client-page.tsx',import.meta.url),'utf8');loaded.set('framework/client-page.tsx',hash(pageSource))
 const require=createRequire(new URL('../package.json',import.meta.url)),React=require('react'),{createRoot}=require('react-dom/client'),{JSDOM}=require('jsdom'),esbuild=require('esbuild')
 const built=await esbuild.build({entryPoints:[fileURLToPath(new URL('../src/framework/client-page.tsx',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',packages:'external',plugins:[{name:'controlled-css-port',setup(api){
  api.onResolve({filter:/\.module\.css$/},()=>({path:'css',namespace:'css'}))
  api.onLoad({filter:/.*/,namespace:'css'},()=>({contents:'export default {}',loader:'js'}))
 }}],logLevel:'silent'})
 const primitives=new Proxy({}, {get(_target,key){
  if(key==='Button')return React.forwardRef(({children,...props},ref)=>React.createElement('button',{...props,ref},children))
  if(key==='Input')return React.forwardRef((props,ref)=>React.createElement('input',{...props,ref}))
  if(key==='SegmentedControl')return({options,value,onChange})=>React.createElement('div',{},options.map(option=>React.createElement('button',{key:option.value,onClick:()=>onChange(option.value)},option.label)))
  if(key==='Menu')return({anchor})=>anchor
  return()=>null
 }})
 const module={exports:{}}
 new Function('require','module','exports','__SERVANT_ICON_DATA_URI__','__SERVANT_WELCOME_CHARACTER_DATA_URI__','__SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__',built.outputFiles[0].text)(
  specifier=>specifier==='@deepseek-ai/dsh-client-ui-primitives'?primitives:require(specifier),module,module.exports,'','','')
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'})
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true}))
  Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})
 const root=createRoot(document.querySelector('#root'))
 try{
  const uiView=view
  let historyWork
  const api={view:async()=>uiView,history:input=>historyWork=service.history(input),subscribeChanged:()=>()=>{}}
  await React.act(async()=>root.render(React.createElement(module.exports.FrameworkPage,{api,language:'en'})))
  if(historyWork)await React.act(async()=>historyWork)
  await React.act(async()=>new Promise(resolve=>setImmediate(resolve)))
  const notice=document.querySelector('[data-missing-conversation-bodies]')
  check('Full FrameworkPage has an explicit alert',notice.getAttribute('role'),'alert')
  check('Full FrameworkPage names exact missing identity',notice.textContent.includes('b · '+missingPath),true)
  check('Full FrameworkPage retains other actual messages',[...document.querySelectorAll('[data-message-id]')].map(row=>row.getAttribute('data-message-id')),['a','c','d','e'])
  check('Full FrameworkPage does not invent deleted content',document.body.textContent.includes('body-b'),false)
 }finally{await React.act(async()=>root.unmount());dom.window.close()}
 const finalSnapshot=await files.snapshot()
 let finalEntry
 try{finalEntry=JSON.parse(await files.read(finalSnapshot,conversation.indexPath)).messages.at(-1).path}finally{await finalSnapshot.release()}
 await fs.unlink(path.join(directory,finalEntry))
 await assert.rejects(()=>service.history({mode:'local',collaborationId:'chat',storageScope,limit:5}),/Message entry is missing/)
 names.push('Missing entry remains an exact error, not a swallowed missing body')
 console.log(JSON.stringify({status:'passed',assertions:names.length,names,sourceHashes:Object.fromEntries(loaded),limits:'Actual FrameworkService access/send/history with Local PhysicalFiles, actual ClientController and full FrameworkPage React tree. Native DSH Host/browser and UI primitives/CSS are controlled ports. Service settings and DSH storage are supplied. Missing body is ordinary unlink of a previously successful physical send, not a fabricated on-disk format.'},null,2))
}finally{await service.dispose();await fs.rm(directory,{recursive:true,force:true});await fs.rm(directory+'-records',{recursive:true,force:true});hooks.deregister()}
