import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hooks } from './test-support/dsh-sdk-runtime.mjs'
const { openDshStorageFixture }=await import('./test-support/dsh-sdk-storage.mjs')
const { FrameworkRecordMove,recordMoveKey }=await import('../src/framework/record-move.ts')
const { PhysicalLocalFiles }=await import('../src/framework/physical-local-files.ts')
const clientErrors=await import('../src/framework/client-error.ts')
const {isLocalAttachmentError}=await import('../src/framework/conversation-attachment-reference.ts')
const {FilesConflictError,FilesOutcomeUnknownError}=await import('../src/framework/transactions.ts')
import { pathToFileURL, fileURLToPath } from 'node:url'
import os from 'node:os'
import { createHash } from 'node:crypto'
const source = fileURLToPath(new URL('../', import.meta.url))
const component = path.join(source, 'src/framework/record-move-panel.tsx')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-move-panel-'))
const require = createRequire(path.join(source, 'package.json'))
const { build, stop } = await import(pathToFileURL(require.resolve('esbuild')).href)
const { JSDOM } = await import(pathToFileURL(require.resolve('jsdom')).href)
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://test.invalid/' })
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
const outfile = path.join(scratch, 'panel-test-bundle.mjs')
await build({ stdin: { contents: `export { RecordMovePanel } from ${JSON.stringify(component)}; export { default as React, act } from 'react'; export { createRoot } from 'react-dom/client';`, resolveDir: source },
  bundle: true, format: 'esm', platform: 'node', target: 'node22', jsx: 'automatic', outfile,
  plugins: [{ name: 'explicit-panel-test-ports', setup(api) {
    api.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, args => ({ path: require.resolve(args.path), namespace: 'file' }))
    api.onResolve({ filter: /^\// }, args => ({ path: args.path, namespace: 'file' }))
    api.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'test-port' }))
    api.onLoad({ filter: /.*/, namespace: 'test-port' }, () => ({ contents: `import React from ${JSON.stringify(require.resolve('react'))}; export const Button=props=>React.createElement('button',props); export const Input=({onChange,...props})=>React.createElement('input',{...props,onInput:onChange});`, loader: 'js' }))
    api.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'css', namespace: 'test-css' }))
    api.onLoad({ filter: /.*/, namespace: 'test-css' }, () => ({ contents: 'export default {}', loader: 'js' }))
    api.onResolve({ filter: /^\.\/client-error\.js$/ }, () => ({ path: path.join(source, 'src/framework/client-error.ts') }))
  } }], logLevel: 'silent' })
const { React, act, createRoot, RecordMovePanel } = await import(pathToFileURL(outfile).href)
const container = document.getElementById('root'), root = createRoot(container)
let assertions = 0
const check = (value, expected) => { assert.deepEqual(value, expected); assertions++ }

const originalLocal=path.join(scratch,'original-local'),occupied=path.join(scratch,'records'),destination=path.join(scratch,'new-target')
await fs.mkdir(originalLocal);await fs.mkdir(occupied)
const sdk=await openDshStorageFixture(path.join(scratch,'records'),path.join(scratch,'locator')),store=sdk.adapter
let current={revision:'original-revision',settings:{localDirectory:originalLocal}},quiesced=0
await store.set('framework-settings/local',current)
const scope=JSON.stringify(['local',originalLocal]),owner={quiesce:async()=>{quiesced++},applySettings:async r=>{current=r.settingsAfter;await store.set('framework-settings/local',current)},reopen:async()=>{}}
const mover=new FrameworkRecordMove(store,store,owner),serviceFile=path.join(source,'src/framework/service.ts'),js=stripTypeScriptTypes(readFileSync(serviceFile,'utf8'),{mode:'transform'}),begin=js.indexOf('    moveRecords(input)'),end=js.indexOf('    async maintenanceView(',begin)
assert(begin>=0&&end>begin)
const Service=new Function('PhysicalLocalFiles','randomUUID','return class {\n'+js.slice(begin,end)+'\n}')(PhysicalLocalFiles,randomUUID)
const service=Object.assign(new Service(),{storage:store,serialMode:(_m,op)=>op(),assertOpen(){},mover:()=>mover,config:()=>current,access:async()=>({connection:{scope,files:new PhysicalLocalFiles(current.settings.localDirectory)}}),checkScope(a,s){assert.equal(a.connection.scope,s)},changed(){},clearResolvedErrors(){},report(){},view:async()=>({})})
const transportJS=stripTypeScriptTypes(readFileSync(path.join(source,'src/framework/transport.ts'),'utf8'),{mode:'transform'}),failureStart=transportJS.indexOf('function frameworkFailure('),failureEnd=transportJS.indexOf('export function installFrameworkTransport',failureStart)
assert(failureStart>=0&&failureEnd>failureStart)
const frameworkFailure=new Function('isLocalAttachmentError','HistorySelectionChangedError','requiresUserAction','RecordMoveNotStartedError','FilesConflictError','FilesOutcomeUnknownError',transportJS.slice(failureStart,failureEnd)+';return frameworkFailure')(isLocalAttachmentError,clientErrors.HistorySelectionChangedError,clientErrors.requiresUserAction,clientErrors.RecordMoveNotStartedError,FilesConflictError,FilesOutcomeUnknownError)
const calls=[],requests=[],failures=[],api={moveRecords:input=>{calls.push(structuredClone(input));const work=service.moveRecords(input).catch(error=>{const response=frameworkFailure({errorPresentation(){}},'moveRecords',error);failures.push(response);throw clientErrors.frameworkRpcError('moveRecords',response.error)});requests.push(work);return work}}
async function button(text){const b=[...container.querySelectorAll('button')].find(x=>x.textContent===text);assert(b,text);await act(async()=>{b.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));await Promise.allSettled(requests)})}
async function input(value){const i=container.querySelector('input');assert(i);await act(async()=>{i.value=value;i.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})}
try{
 await act(async()=>root.render(React.createElement(RecordMovePanel,{api,storageScope:scope,settingsRevision:current.revision,tr:cn=>cn,changed:async()=>{}})))
 await input(occupied);await button('搬家并应用');await button('确认搬家并应用')
 check(await store.get(recordMoveKey),undefined);check(quiesced,0);check(store.storageView().directory,occupied)
 check(!!container.querySelector('input'),true)
 check(container.textContent.includes('explicit record move'),true);await input(destination);await button('搬家并应用');await button('确认搬家并应用');check(store.storageView().directory,destination);check(quiesced,1);check(container.textContent.includes('记录已搬家并应用'),true);check(container.textContent.includes('本次搬迁确认的旧 DSS 副本已删除'),true);check(await fs.lstat(path.join(occupied,'deepseek_servant')).then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false}),false)
 // Real permission failure on a second, separately confirmed move; new address still applies.
 const second=path.join(scratch,'second-target'),locked=path.join(current.settings.localDirectory,'locked')
 await fs.mkdir(locked);await fs.writeFile(path.join(locked,'original.txt'),'preserved original');await fs.chmod(locked,0o500)
 try {
  await act(async()=>root.render(React.createElement(RecordMovePanel,{api,storageScope:scope,settingsRevision:current.revision,tr:cn=>cn,changed:async()=>{}})))
  await input(second);await button('搬家并应用');await button('确认搬家并应用')
  check(store.storageView().directory,second)
  check(container.textContent.includes('新地址已生效，以下旧副本未清完'),true)
  check(container.textContent.includes(locked.slice(0,-'/locked'.length)),true)
  check(container.textContent.includes('EACCES'),true)
  check(await fs.readFile(path.join(locked,'original.txt'),'utf8'),'preserved original')
  check(await fs.readFile(path.join(current.settings.localDirectory,'locked/original.txt'),'utf8'),'preserved original')
  await store.set('framework-git-enabled',true);check(await store.get('framework-git-enabled'),true)
 } finally { await fs.chmod(locked,0o700) }
 console.log(JSON.stringify({status:'recovered',assertions,calls,failures,serviceSHA256:createHash('sha256').update(readFileSync(serviceFile)).digest('hex'),limits:'Real React/ReactDOM/JSDOM panel, actual FrameworkService.moveRecords, frameworkFailure and frameworkRpcError methods, FrameworkRecordMove and installed DSH storage on temp directories. Selected destination is the currently active records directory, a normal user input; no injected errors. Button/Input HTML ports with onInput forwarded to product onChange; lifecycle/model/UI view/acquisition unrelated ports controlled. Not actual native UI/Windows.'},null,2))
}finally{await act(async()=>root.unmount());dom.window.close();await sdk.close();await fs.rm(scratch,{recursive:true,force:true});stop();hooks.deregister()}
process.exit(0)
