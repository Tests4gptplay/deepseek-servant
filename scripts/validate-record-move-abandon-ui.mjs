import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import os from 'node:os'
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


const request={storageScope:'local-original',expectedRevision:'r1',commandId:'move-1',directory:'/new',canAbandon:true}
const tr=cn=>cn
let props, calls=[], refreshes=0
async function render(extra={}) { props={api,storageScope:'local-original',settingsRevision:'r1',currentDirectory:'/old',pendingRequest:request,tr,changed:async()=>{refreshes++},...extra};await act(async()=>root.render(React.createElement(RecordMovePanel,props))) }
const find=text=>[...container.querySelectorAll('button')].find(x=>x.textContent===text)
async function click(text){const b=find(text);assert(b,text);await act(async()=>b.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})))}
let failAbandon=false, waitAbandon, release
const api={moveRecords:async()=>{throw Error('copy interrupted')},abandonRecordMove:async input=>{calls.push(input);if(waitAbandon)await waitAbandon;if(failAbandon)throw Error('source changed');return {directory:'/old',retainedTarget:'/new'}}}
try {
 await render({pendingRequest:{...request,canAbandon:false}});check(!!find('放弃本次搬迁'),false);check(!!find('重试迁移'),true)
 await render({pendingRequest:{...request,canAbandon:undefined}});check(!!find('放弃本次搬迁'),false)
 await render({pendingRequest:{...request,commandId:'other'}});check(!!find('放弃本次搬迁'),false)
 await render();check(!!find('放弃本次搬迁'),true);check(container.textContent.includes('已复制到新目录的文件会保留'),true)
 failAbandon=true;await click('放弃本次搬迁');check(calls.length,1);check(container.textContent.includes('已放弃本次搬迁'),false);check(container.textContent.includes('未能放弃本次搬迁，请重试'),true);check(container.querySelector('input').disabled,true)
 failAbandon=false;waitAbandon=new Promise(r=>release=r);await click('放弃本次搬迁');check(container.textContent.includes('正在放弃本次搬迁'),true);check(!!find('重试迁移'),false);check(!!find('放弃本次搬迁'),false)
 await act(async()=>{release();await waitAbandon});check(calls.length,2);check(calls[1].commandId,'move-1');check(container.querySelector('input').value,'/old');check(container.querySelector('input').disabled,false);check(container.textContent.includes('已复制的文件保留在：/new'),true);check(!!find('重试迁移'),false)
 // Fresh instance/API: a failed move cannot itself authorize abandonment.
 const api2={...api,abandonRecordMove:async()=>{throw Error('must not be called')}}
 await act(async()=>root.render(null));await render({api:api2,pendingRequest:{...request,canAbandon:false}})
 await click('重试迁移');check(!!find('放弃本次搬迁'),false);check(!!find('重试迁移'),true)
 // Once the service refresh confirms prepared/source-active, offer abandonment.
 await render({api:api2});check(!!find('放弃本次搬迁'),true)
 await render({api:api2,changed:async()=>{throw Error('view unavailable')}});await click('重试迁移');check(!!find('放弃本次搬迁'),false);check(!!find('重试迁移'),true)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual React panel with ReactDOM/JSDOM and HTML primitive ports, controlled API responses. Not native DSH or Windows verification.'},null,2))
} finally {await act(async()=>root.unmount());dom.window.close();await fs.rm(scratch,{recursive:true,force:true});stop()}

process.exit(0)
