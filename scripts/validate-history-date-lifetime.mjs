import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../package.json', import.meta.url))
const React = require('react'), { createRoot } = require('react-dom/client'), { Simulate } = require('react-dom/test-utils')
const { JSDOM } = require('jsdom'), esbuild = require('esbuild')
const source = process.env.DSS_HISTORY_SOURCE || fileURLToPath(new URL('../src/', import.meta.url))
const entry = `export { FrameworkPage } from ${JSON.stringify(path.join(source, 'framework/client-page.tsx'))};
export { getFrameworkClientController, frameworkScopeKey } from ${JSON.stringify(path.join(source, 'framework/client-contracts.ts'))};
export { getConversationAttachmentDrafts } from ${JSON.stringify(path.join(source, 'framework/client-attachments.ts'))};
export { LocalAttachmentFiles } from ${JSON.stringify(path.join(source, 'framework/local-attachment-files.ts'))};
export { attachmentMimeType } from ${JSON.stringify(path.join(source, 'framework/conversation-attachments.ts'))};
export { prepareNativeLocalAttachment } from ${JSON.stringify(path.join(source, 'adapters/dsh/attachments.ts'))};`
const built = await esbuild.build({ alias: Object.fromEntries(['FileCard', 'AttachmentRail'].map(name => { const spec = `@deepseek-ai/dsh-client-ui-attachment/src/${name}.tsx`; return [spec, require.resolve(spec)] })), stdin: { contents: entry, resolveDir: source, loader: 'ts' }, bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', logLevel: 'silent', plugins: [{ name: 'controlled-css-port', setup(api) {
    api.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'css', namespace: 'css' }))
    api.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: 'export default {}', loader: 'js' }))
  } }] })
const primitives = new Proxy({}, { get(_target, key) {
  if (key === 'fileExtension') return name => name.split('.').at(-1)
  if (key === 'fileSizeText') return n => `${n} B`
  if (key === 'Button') return React.forwardRef(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children))
  if (key === 'MenuSurface') return React.forwardRef(({ children, ...props }, ref) => React.createElement('div', { ...props, ref }, children))
  if (key === 'Input') return React.forwardRef((props, ref) => React.createElement('input', { ...props, ref }))
  if (key === 'SegmentedControl') return ({ options, onChange }) => React.createElement('div', {}, options.map(option => React.createElement('button', { key: option.value, onClick: () => onChange(option.value) }, option.label)))
  if (key === 'Tooltip') return ({ children }) => children
  if (key === 'Menu') return ({ anchor, open, items, onSelect }) => React.createElement(React.Fragment, {}, anchor, open && React.createElement('div', {role:'menu'}, items.map(item => React.createElement('button', {key:item.id, onClick:()=>onSelect(item.id)}, item.label))))
  return () => null
} })
const module = { exports: {} }
new Function('require', 'module', 'exports', '__SERVANT_ICON_DATA_URI__', '__SERVANT_WELCOME_CHARACTER_DATA_URI__', '__SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__', built.outputFiles[0].text)(
  specifier => specifier === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(specifier), module, module.exports, '', '', '')
const { FrameworkPage, getFrameworkClientController, frameworkScopeKey, getConversationAttachmentDrafts, LocalAttachmentFiles, attachmentMimeType, prepareNativeLocalAttachment } = module.exports

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })

const calls=[], checks=[]
const check=(name, value)=>{checks.push({name,pass:!!value})}
const settings={name:'DSS', userName:'Test',localDirectory:'/tmp/test',ownerRepo:'',repositoryDirectory:'',collaborationId:'history-a',workerSeats:0,workspace:''}
let currentView={revision:'r1',activeMode:'local',collaborationId:'history-a',storageScope:'scope-a',settings,connection:{status:'connected',participating:true},messages:[],tasks:[],legacyTasks:[],archives:[],resources:[],executions:[]}
const api={view:async input=>{calls.push({kind:'view',...input});return currentView},history:async input=>{calls.push({kind:'history',...input});return {messages:[],order:[],revision:'r1',storageScope:currentView.storageScope}},subscribeChanged:()=>()=>{}}
const controller=getFrameworkClientController(api), root=createRoot(document.getElementById('root'))
const flush=async()=>React.act(async()=>{await new Promise(r=>setImmediate(r))})
const dateButton=()=>document.querySelector('button[aria-label="Date"]')
const render=async()=>{await React.act(async()=>root.render(React.createElement(FrameworkPage,{api,language:'en'})));await flush()}
try {
  await render()
  const before=calls.length
  await React.act(async()=>dateButton().click())
  await React.act(async()=>[...document.querySelectorAll('[role=gridcell]')].find(n=>n.textContent==='20').click())
  await flush()
  const selected=controller.snapshot().value.historyDate
  check('Normal date selection uses one existing history request', calls.slice(before).filter(x=>x.kind==='history'&&x.date===selected).length===1)
  check('Date label reflects the actual controller selection', dateButton().textContent===selected.replaceAll('-','/'))
  await React.act(async()=>root.render(null));await render()
  check('Page remount preserves selected history label', dateButton().textContent===selected.replaceAll('-','/'))
  check('Empty selected day stays a history empty state, not welcome', document.body.textContent.includes('No conversation on this date')&&!document.body.textContent.includes('Start with a goal'))
  const beforeLatest=calls.length
  await React.act(async()=>[...document.querySelectorAll('button')].find(n=>n.textContent==='Back to latest').click());await flush()
  check('Back to latest uses one existing latest request', calls.slice(beforeLatest).filter(x=>x.kind==='history'&&!x.date).length===1)
  check('Latest clears controller selection and label together', controller.snapshot().value.historyDate===undefined&&dateButton().textContent==='Date')
  const beforeRerender=calls.length
  await render()
  check('Rendering the same authoritative state adds no request', calls.length===beforeRerender)
  console.log(JSON.stringify({source,checks,passed:checks.filter(x=>x.pass).length,total:checks.length,calls,limits:'Real FrameworkPage and Controller in React/jsdom with controlled Host API; not actual browser acceptance.'},null,2))
  if(!process.env.DSS_EXPECT_BASELINE_FAILURE) assert.ok(checks.every(x=>x.pass))
} finally {await React.act(async()=>root.unmount());dom.window.close()}
