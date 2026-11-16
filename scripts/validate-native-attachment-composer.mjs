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
const source = fileURLToPath(new URL('../src/', import.meta.url))
const entry = `export { ComposerAttachments } from '@deepseek-ai/dsh-client-ui-attachment/src/client/ComposerAttachments.tsx';
export { FrameworkPage } from ${JSON.stringify(path.join(source, 'framework/client-page.tsx'))};
export { getFrameworkClientController, frameworkScopeKey } from ${JSON.stringify(path.join(source, 'framework/client-contracts.ts'))};
export { getConversationAttachmentDrafts } from ${JSON.stringify(path.join(source, 'framework/client-attachments.ts'))};
export { LocalAttachmentFiles } from ${JSON.stringify(path.join(source, 'framework/local-attachment-files.ts'))};
export { attachmentMimeType } from ${JSON.stringify(path.join(source, 'framework/conversation-attachments.ts'))};
export { prepareNativeLocalAttachment } from ${JSON.stringify(path.join(source, 'adapters/dsh/attachments.ts'))};`
const built = await esbuild.build({ alias: Object.fromEntries(['FileCard', 'AttachmentRail', 'client/ComposerAttachments'].map(name => { const spec = `@deepseek-ai/dsh-client-ui-attachment/src/${name}.tsx`; return [spec, require.resolve(spec)] })), stdin: { contents: entry, resolveDir: source, loader: 'ts' }, bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', logLevel: 'silent', plugins: [{ name: 'controlled-css-port', setup(api) {
    api.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'css', namespace: 'css' }))
    api.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: 'export default {}', loader: 'js' }))
  } }] })
const primitives = new Proxy({}, { get(_target, key) {
  if (key === 'fileExtension') return name => name.split('.').at(-1)
  if (key === 'fileSizeText') return n => `${n} B`
  if (key === 'Button') return React.forwardRef(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children))
  if (key === 'Input') return React.forwardRef((props, ref) => React.createElement('input', { ...props, ref }))
  if (key === 'SegmentedControl') return ({ options, onChange }) => React.createElement('div', {}, options.map(option => React.createElement('button', { key: option.value, onClick: () => onChange(option.value) }, option.label)))
  if (key === 'Tooltip') return ({ children }) => children
  if (key === 'Menu') return ({ anchor, open, items, onSelect }) => React.createElement(React.Fragment, {}, anchor, open && React.createElement('div', {role:'menu'}, items.map(item => React.createElement('button', {key:item.id, onClick:()=>onSelect(item.id)}, item.label))))
  return () => null
} })
const module = { exports: {} }
new Function('require', 'module', 'exports', '__SERVANT_ICON_DATA_URI__', '__SERVANT_WELCOME_CHARACTER_DATA_URI__', '__SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__', built.outputFiles[0].text)(
  specifier => specifier === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(specifier), module, module.exports, '', '', '')
const { FrameworkPage, ComposerAttachments, getFrameworkClientController, frameworkScopeKey, getConversationAttachmentDrafts, LocalAttachmentFiles, attachmentMimeType, prepareNativeLocalAttachment } = module.exports

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true }))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-g13-host-path-'))
const nativePath = path.join(sandbox, 'source.txt'), otherPath = path.join(sandbox, 'other.txt')
const pngPath = path.join(sandbox, 'picture.png'), jpegPath = path.join(sandbox, 'picture.jpg')
await fs.writeFile(nativePath, 'first user content'); await fs.writeFile(otherPath, 'second user content')
await fs.copyFile(new URL('../icon.png', import.meta.url), pngPath)
await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#339966' } }).jpeg().toFile(jpegPath)
const names = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const settings = { name: 'DSS', userName: 'User', localDirectory: sandbox, ownerRepo: '', repositoryDirectory: '', collaborationId: 'chat-a', workerSeats: 0, workspace: '' }
const view = collaborationId => ({ revision: 'settings', activeMode: 'local', collaborationId, storageScope: 'local-scope', settings: { ...settings, collaborationId },
  connection: { status: 'connected', participating: true }, messages: [], tasks: [], legacyTasks: [], archives: [], resources: [], executions: [] })
let currentView = view('chat-a'), pendingReply, calls = [], sent = [], uploads = [], uploadSignals = [], failSend = false, failUpload = false, deferredUpload, deferredSend
const api = { view: async () => currentView, history: async () => ({ messages: [] }), subscribeChanged: () => () => {},
  selectLocalAttachment: async (input, signal) => {
    calls.push(input)
    if (input.path === otherPath && pendingReply) return new Promise(resolve => { pendingReply.resolve = resolve })
    const local = new LocalAttachmentFiles({ collaborationId: input.collaborationId })
    const attachment = await local.select(input, attachmentMimeType, signal)
    return { attachment, storageScope: input.storageScope }
  }, uploadAttachment: async (input, file, signal) => {
    uploads.push({ input, file }); uploadSignals.push(signal); if (deferredUpload) return deferredUpload.promise; if (failUpload) throw new Error('Controlled upload failure'); signal?.throwIfAborted();
    return { attachment: { version: 2, source: 'local-conversation-attachment', mode: 'local', collaborationId: input.collaborationId, path: nativePath, name: 'source.txt', mimeType: file.type, bytes: file.size }, storageScope: input.storageScope }
  }, send: async input => { if (deferredSend) await deferredSend; if (failSend) throw new Error('Controlled send failure'); sent.push(input); return { storageScope: input.storageScope } } }
const root = createRoot(document.getElementById('root'))
const controller = getFrameworkClientController(api), drafts = getConversationAttachmentDrafts(api)
const button = text => [...document.querySelectorAll('button')].find(row => row.textContent === text || row.getAttribute('aria-label')?.startsWith(text + ' '))
const hostInput = () => [...document.querySelectorAll('label')].find(row => row.textContent.includes('Absolute file path on the Host computer'))?.querySelector('input')
const change = async (element, value) => React.act(async () => { Simulate.change(element, { target: { value } }) })
const flush = async () => React.act(async () => { await new Promise(resolve => setImmediate(resolve)) })
const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); assert.ok(predicate(), 'Expected controlled UI operation did not settle') }
let unmounted = false
try {
  delete globalThis.__DSH_HOST_PATHS__
  await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en' })))
  await flush()
  const scopeA = frameworkScopeKey('local', 'chat-a', 'local-scope')
  check('Browser Local picker is enabled without a desktop bridge', document.querySelector('button[aria-label=Add]').disabled, false)
  check('No permanent Host path field or Attach files text button remains', !!hostInput() || !!button('Attach Host file') || !!button('Attach files'), false)
  // Exercise the merged page with the actual official attachment component.
  // Permission/card callbacks here only expose routing; they grant nothing.
  await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en',
    nativeAttachments: owner => React.createElement(ComposerAttachments, { ...owner, t: value => value, readFileDrag() {} }),
    permissionControl: () => React.createElement('button', { 'data-permission-route': true }, 'Permissions route'),
    nativeInteractions: rows => React.createElement('span', { 'data-native-card-route': true }, rows.map(row => row.role).join(',')),
  })))
  const integratedFile = new File(['one physical drop'], 'integrated.txt', { type: 'text/plain' })
  const integratedDrop = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(integratedDrop, 'dataTransfer', { value: { types: ['Files'], files: [integratedFile], items: [{ kind: 'file', getAsFile: () => integratedFile }] } })
  await React.act(async () => document.querySelector('textarea').dispatchEvent(integratedDrop))
  check('Merged page native document drop and composer handler add exactly one File', [integratedDrop.defaultPrevented, drafts.selections(scopeA).length, drafts.selections(scopeA)[0]?.file === integratedFile], [true, 1, true])
  check('Permission/card routes coexist without starting upload', [!!document.querySelector('[data-permission-route]'), !!document.querySelector('[data-native-card-route]'), uploads.length], [true, true, 0])
  await React.act(async () => button('Remove').click())
  await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en' })))
  const select = async file => {
    const input = document.querySelector('input[type=file]')
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await React.act(async () => document.querySelector('button[aria-label=Add]').click())
    await React.act(async () => button('File').click())
    await React.act(async () => Simulate.change(input))
  }
  const file = new File(['browser original'], 'source.txt', { type: 'text/plain' })
  const transfer = (...files) => ({ types: ['Files'], files, items: files.map(file => ({ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) })) })
  let prevented = false
  const dropped = transfer(file)
  await React.act(async () => Simulate.dragOver(document.querySelector('textarea').parentElement, { dataTransfer: dropped, preventDefault: () => { prevented = true } }))
  check('File dragover prevents browser navigation and advertises copy', [prevented, dropped.dropEffect], [true, 'copy'])
  prevented = false
  await React.act(async () => Simulate.drop(document.querySelector('textarea').parentElement, { dataTransfer: dropped, preventDefault: () => { prevented = true } }))
  check('Dropped ordinary file uses the same unsent in-memory selection', [prevented, uploads.length, drafts.selections(scopeA)[0]?.name], [true, 0, 'source.txt'])
  await React.act(async () => button('Remove').click())
  const folder = transfer(new File([], 'folder'))
  folder.items[0].webkitGetAsEntry = () => ({ isDirectory: true })
  await React.act(async () => Simulate.drop(document.querySelector('textarea').parentElement, { dataTransfer: folder }))
  check('An actual directory is not silently sent as an empty file', drafts.selections(scopeA).length, 0)
  prevented = false
  await React.act(async () => Simulate.paste(document.querySelector('textarea'), { clipboardData: { ...transfer(file), getData: () => 'mixed plain text' }, preventDefault: () => { prevented = true } }))
  check('Paste accepts non-image files without suppressing native text insertion', [prevented, uploads.length, drafts.selections(scopeA)[0]?.name], [false,0,'source.txt'])
  await React.act(async () => button('Remove').click())
  await change(document.querySelector('textarea'), 'Repeated Enter must not send')
  await React.act(async () => Simulate.keyDown(document.querySelector('textarea'), { key: 'Enter', repeat: true, nativeEvent: { isComposing: false } }))
  check('Held Enter does not machine-gun a new message', sent.length, 0)
  await React.act(async () => Simulate.keyDown(document.querySelector('textarea'), { key: 'Enter', nativeEvent: { isComposing: true } }))
  check('IME candidate Enter does not send a message', sent.length, 0)
  await change(document.querySelector('textarea'), 'Keep my draft')
  await select(file)
  check('File remains in composer without a network upload', [uploads.length, drafts.selections(scopeA)[0].state], [0, 'selected'])
  await React.act(async () => button('Remove').click())
  check('Removing unsent File preserves text and makes no copy', [uploads.length, document.querySelector('textarea').value], [0, 'Keep my draft'])
  await select(file)
  currentView = view('chat-b')
  await React.act(async () => controller.publish({ value: currentView }))
  await flush()
  check('Other conversation has no draft File', drafts.selections(frameworkScopeKey('local', 'chat-b', 'local-scope')).length, 0)
  currentView = view('chat-a')
  await React.act(async () => controller.publish({ value: currentView }))
  await flush()
  check('Returning to same conversation retains File and text', [drafts.selections(scopeA)[0].file === file, document.querySelector('textarea').value], [true, 'Keep my draft'])
  await React.act(async () => root.render(null))
  await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en' })))
  await flush()
  check('Actual page remount restores unsent text and selected File from the existing client', [document.querySelector('textarea').value, drafts.selections(scopeA)[0].file === file], ['Keep my draft', true])
  failUpload = true
  await React.act(async () => button('Send').click())
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'error')
  check('Upload failure retains text and File without sending', [sent.length, document.querySelector('textarea').value, drafts.selections(scopeA)[0].file === file], [0, 'Keep my draft', true])
  failUpload = false
  await React.act(async () => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Retry ')).click())
  check('Retry returns file to selected draft without an extra upload', [uploads.length, drafts.selections(scopeA)[0].state], [1, 'selected'])
  failSend = true
  await React.act(async () => button('Send').click())
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'ready' && !button('Send').disabled)
  check('Message failure retains stored reference and draft', [uploads.length, document.querySelector('textarea').value, !!drafts.selections(scopeA)[0].reference], [2, 'Keep my draft', true])
  failSend = false
  await React.act(async () => button('Send').click())
  await waitFor(() => sent.length === 1 && drafts.selections(scopeA).length === 0)
  check('Retry sends same reference without reuploading', [uploads.length, sent[0].attachments[0].path, document.querySelector('textarea').value], [2, nativePath, ''])
  globalThis.__DSH_HOST_PATHS__ = { pathFor: f => f === file ? nativePath : '' }
  await select(file)
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'ready')
  check('Desktop original keeps direct-reference path', [calls.at(-1).path, uploads.length], [nativePath, 2])
  await React.act(async () => button('Remove').click())
  check('Removing original reference does not modify user file', await fs.readFile(nativePath, 'utf8'), 'first user content')
  delete globalThis.__DSH_HOST_PATHS__
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
  const receipt = () => ({ attachment: { version: 2, source: 'local-conversation-attachment', mode: 'local', collaborationId: 'chat-a', path: nativePath, name: 'source.txt', mimeType: file.type, bytes: file.size }, storageScope: 'local-scope' })
  await change(document.querySelector('textarea'), 'Remove during upload keeps this text')
  deferredUpload = deferred()
  await select(file)
  await React.act(async () => button('Send').click())
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'uploading')
  await React.act(async () => button('Remove').click())
  await React.act(async () => deferredUpload.resolve(receipt()))
  await flush()
  check('Removal during real send preparation cannot send removed attachment', [sent.length, drafts.selections(scopeA).length, document.querySelector('textarea').value], [1,0,'Remove during upload keeps this text'])
  deferredUpload = deferred()
  await select(file)
  await React.act(async () => button('Send').click())
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'uploading')
  currentView = view('chat-b')
  await React.act(async () => controller.publish({ value: currentView }))
  await change(document.querySelector('textarea'), 'Different conversation draft stays')
  await React.act(async () => deferredUpload.resolve(receipt()))
  await waitFor(() => sent.length === 2)
  check('Navigation during upload sends only the originally selected conversation', [sent[1].collaborationId, sent[1].text, document.querySelector('textarea').value], ['chat-a','Remove during upload keeps this text','Different conversation draft stays'])
  deferredUpload = undefined
  let preparations = 0
  const originalPrepare = drafts.prepare.bind(drafts)
  drafts.prepare = (...args) => { preparations++; return originalPrepare(...args) }
  await React.act(async () => button('Send').click())
  await waitFor(() => sent.length === 3)
  check('Ordinary text send never calls attachment preparation', [preparations,sent[2].text], [0,'Different conversation draft stays'])
  const reloadedDrafts = getConversationAttachmentDrafts({ ...api })
  check('Fresh page API does not fabricate restored browser Files', reloadedDrafts.selections(scopeA).length, 0)
  await select(file)
  await React.act(async () => drafts.add(scopeA, {mode:'local', collaborationId:'chat-a',storageScope:'local-scope'}, [file]))
  deferredUpload = deferred()
  await React.act(async () => button('Send').click())
  const scopeB=frameworkScopeKey('local','chat-b','local-scope')
  await waitFor(() => drafts.selections(scopeB)[0]?.state === 'uploading')
  const activeUploadSignal=uploadSignals.at(-1)
  await React.act(async () => root.render(null))
  check('Page teardown preserves both conversation drafts and does not abort an accepted send', [drafts.selections(scopeA).length,drafts.selections(scopeB)[0].state,activeUploadSignal.aborted], [1,'uploading',false])
  await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en' })))
  await flush()
  await change(document.querySelector('textarea'), 'New text after remount stays')
  await React.act(async () => deferredUpload.resolve({...receipt(),attachment:{...receipt().attachment,collaborationId:'chat-b'}}))
  await waitFor(() => sent.length === 4)
  check('Accepted upload and send finish in the original conversation after page teardown', [sent[3].collaborationId,drafts.selections(scopeB).length,drafts.selections(scopeA).length],['chat-b',0,1])
  check('Late accepted send does not erase newer text in a remounted page', document.querySelector('textarea').value, 'New text after remount stays')
  let rejectLateSend
  deferredSend = new Promise((_, reject) => { rejectLateSend = reject })
  await React.act(async () => button('Send').click())
  await waitFor(() => controller.pendingDrafts().some(item => item.state === 'sending'))
  await React.act(async () => root.render(null))
  await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en' })))
  await change(document.querySelector('textarea'), 'New text before late failure stays')
  await React.act(async () => rejectLateSend(new Error('Controlled late send failure')))
  await flush()
  check('Late failure after remount preserves new text and reports the original failed submission', [document.querySelector('textarea').value, controller.pendingDrafts().some(item => item.state === 'failed' && item.input.text === 'New text after remount stays')], ['New text before late failure stays', true])
  deferredSend = undefined
  drafts.release()
  check('Owning plugin disposal releases remaining drafts without deleting originals', [drafts.selections(scopeA).length, await fs.readFile(nativePath,'utf8')], [0,'first user content'])
  console.log(JSON.stringify({ status: 'passed', assertions: names.length, names, limits: 'Controlled FrameworkPage/jsdom and mocked transport; actual native UI and binary upload tested separately. Browser File drafts are in memory, not refresh-persistent.' }, null, 2))
} finally {
  if (!unmounted) await React.act(async () => root.unmount()); dom.window.close(); delete globalThis.__DSH_HOST_PATHS__
  await fs.rm(sandbox, { recursive: true, force: true })
}
