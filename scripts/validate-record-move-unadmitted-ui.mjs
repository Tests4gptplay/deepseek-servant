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

const occupied=path.join(scratch,'records'),destination=path.join(scratch,'new-target')
const scope=JSON.stringify(['local',path.join(scratch,'logical-scope')])
const originalLocal=path.join(occupied,'framework-local-'+createHash('sha256').update(scope).digest('hex'))
await fs.mkdir(originalLocal,{recursive:true})
await fs.writeFile(path.join(originalLocal,'first.txt'),'first from A')
await fs.writeFile(path.join(occupied,'unrelated.txt'),'do not move or overwrite')
const sdk=await openDshStorageFixture(occupied,path.join(scratch,'locator')),store=sdk.adapter
let current={revision:'original-revision',settings:{localDirectory:originalLocal}},quiesced=0
await store.set('framework-settings/local',current)
const { LocalLocationRegistry } = await import('../src/framework/local-location.ts')
const registry = new LocalLocationRegistry(store)
// The actual device previously moved this scope from another physical root.
const logicalOld=path.join(scratch,'logical-scope')
const seeded={source:logicalOld,target:originalLocal,scope,fingerprint:'previously verified'}
await registry.prepare('source-before-A',seeded)
await registry.publish('source-before-A',seeded)
await registry.applied('source-before-A')
const owner={quiesce:async()=>{quiesced++},applySettings:async r=>{current=r.settingsAfter;await store.set('framework-settings/local',current)},reopen:async()=>{}}
const mover=new FrameworkRecordMove(store,store,owner),serviceFile=path.join(source,'src/framework/service.ts'),js=stripTypeScriptTypes(readFileSync(serviceFile,'utf8'),{mode:'transform'}),begin=js.indexOf('    moveRecords(input)'),end=js.indexOf('    async maintenanceView(',begin)
assert(begin>=0&&end>begin)
const Service=new Function('PhysicalLocalFiles','randomUUID','return class {\n'+js.slice(begin,end)+'\n}')(PhysicalLocalFiles,randomUUID)
const service=Object.assign(new Service(),{storage:store,serialMode:(_m,op)=>op(),assertOpen(){},mover:()=>mover,config:()=>current,access:async()=>({connection:{scope,files:new PhysicalLocalFiles(current.settings.localDirectory)}}),checkScope(a,s){assert.equal(a.connection.scope,s)},changed(){},clearResolvedErrors(){},report(){},view:async()=>({})})
const transportJS=stripTypeScriptTypes(readFileSync(path.join(source,'src/framework/transport.ts'),'utf8'),{mode:'transform'}),failureStart=transportJS.indexOf('function frameworkFailure('),failureEnd=transportJS.indexOf('export function installFrameworkTransport',failureStart)
assert(failureStart>=0&&failureEnd>failureStart)
const frameworkFailure=new Function('isLocalAttachmentError','HistorySelectionChangedError','requiresUserAction','RecordMoveNotStartedError','FilesConflictError','FilesOutcomeUnknownError',transportJS.slice(failureStart,failureEnd)+';return frameworkFailure')(isLocalAttachmentError,clientErrors.HistorySelectionChangedError,clientErrors.requiresUserAction,clientErrors.RecordMoveNotStartedError,FilesConflictError,FilesOutcomeUnknownError)
const calls=[],requests=[],failures=[],outcomes=[],api={moveRecords:input=>{calls.push(structuredClone(input));const work=service.moveRecords(input).then(result=>{outcomes.push(result.recordMoveOutcome);return result}).catch(error=>{const response=frameworkFailure({errorPresentation(){}},'moveRecords',error);failures.push(response);throw clientErrors.frameworkRpcError('moveRecords',response.error)});requests.push(work);return work}}
async function button(text){const b=[...container.querySelectorAll('button')].find(x=>x.textContent===text);assert(b,text);await act(async()=>{b.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));await Promise.allSettled(requests)})}
let selected=occupied
const onPickDirectory=async()=>selected
try{
 await act(async()=>root.render(React.createElement(RecordMovePanel,{api,storageScope:scope,settingsRevision:current.revision,currentDirectory:occupied,onPickDirectory,tr:cn=>cn,changed:async()=>{}})))
 await button('选择文件夹')
 check(calls.length,0);check(quiesced,0);check(store.storageView().directory,occupied)
 selected=destination;await button('选择文件夹');await act(async()=>{await Promise.all(requests)})
 check(calls.length,1);check(store.storageView().directory,destination);check(quiesced,1)
 check(container.textContent.includes('记录已搬家并应用'),true)
 check(container.textContent.includes('原记录目录已保留'),true)
 check((await fs.stat(path.join(occupied,'deepseek_servant'))).isDirectory(),true)
 const localAtB=current.settings.localDirectory
 await fs.writeFile(path.join(localAtB,'latest.txt'),'new in B')
 await store.set('framework-instance-uuid','updated in B')
 // Prove that old DSS contents as well as unrelated destination files survive.
 await fs.writeFile(path.join(originalLocal,'old-A-edit.txt'),'changed after A was retained')
 selected=occupied
 await act(async()=>root.render(React.createElement(RecordMovePanel,{api,storageScope:scope,settingsRevision:current.revision,currentDirectory:destination,onPickDirectory,tr:cn=>cn,changed:async()=>{}})))
 check(container.querySelector('input').value,destination)
 await button('选择文件夹');await act(async()=>{await Promise.all(requests)})
 check(calls.length,2);check(quiesced,2)
 check(store.storageView().directory,occupied)
 check(current.settings.localDirectory,originalLocal)
 check(await fs.readFile(path.join(originalLocal,'latest.txt'),'utf8'),'new in B')
 check(await fs.readFile(path.join(localAtB,'latest.txt'),'utf8'),'new in B')
 check(await fs.readFile(path.join(occupied,'unrelated.txt'),'utf8'),'do not move or overwrite')
 check(await store.get('framework-instance-uuid'),'updated in B')
 check(outcomes.at(-1).retainedTargets.length,2)
 const [oldTechnical,oldLocal]=outcomes.at(-1).retainedTargets
 check((await fs.stat(oldTechnical)).isDirectory(),true)
 check(await fs.readFile(path.join(oldLocal,'old-A-edit.txt'),'utf8'),'changed after A was retained')
 check(container.textContent.includes('目标目录原有记录保留在'),true)
 console.log(JSON.stringify({status:'recovered',assertions,calls,failures,serviceSHA256:createHash('sha256').update(readFileSync(serviceFile)).digest('hex'),limits:'Real React/ReactDOM/JSDOM panel, actual FrameworkService.moveRecords, frameworkFailure and frameworkRpcError methods, FrameworkRecordMove and installed DSH storage on temp directories. The existing picker skips the active directory and starts a move from one successful selection with no confirmation button. Button/Input HTML ports with onInput forwarded to product onChange; lifecycle/model/UI view/acquisition unrelated ports controlled. Not actual native UI/Windows.'},null,2))
}finally{await act(async()=>root.unmount());dom.window.close();await sdk.close();await fs.rm(scratch,{recursive:true,force:true});stop();hooks.deregister()}
process.exit(0)
