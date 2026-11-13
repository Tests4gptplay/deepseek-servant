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
const entry = `export { FrameworkPage } from ${JSON.stringify(path.join(source, 'framework/client-page.tsx'))};
export { getFrameworkClientController, frameworkScopeKey } from ${JSON.stringify(path.join(source, 'framework/client-contracts.ts'))};
export { getConversationAttachmentDrafts } from ${JSON.stringify(path.join(source, 'framework/client-attachments.ts'))};
export { LocalAttachmentFiles } from ${JSON.stringify(path.join(source, 'framework/local-attachment-files.ts'))};
export { attachmentMimeType } from ${JSON.stringify(path.join(source, 'framework/conversation-attachments.ts'))};
export { prepareNativeLocalAttachment } from ${JSON.stringify(path.join(source, 'adapters/dsh/attachments.ts'))};`
const built = await esbuild.build({ stdin: { contents: entry, resolveDir: source, loader: 'ts' }, bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', logLevel: 'silent', plugins: [{ name: 'controlled-css-port', setup(api) {
    api.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'css', namespace: 'css' }))
    api.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: 'export default {}', loader: 'js' }))
  } }] })
const primitives = new Proxy({}, { get(_target, key) {
  if (key === 'Button') return React.forwardRef(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children))
  if (key === 'Input') return React.forwardRef((props, ref) => React.createElement('input', { ...props, ref }))
  if (key === 'SegmentedControl') return ({ options, onChange }) => React.createElement('div', {}, options.map(option => React.createElement('button', { key: option.value, onClick: () => onChange(option.value) }, option.label)))
  if (key === 'Menu') return ({ anchor }) => anchor
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
let currentView = view('chat-a'), pendingReply, calls = [], sent = []
const api = { view: async () => currentView, history: async () => ({ messages: [] }), subscribeChanged: () => () => {},
  selectLocalAttachment: async (input, signal) => {
    calls.push(input)
    if (input.path === otherPath && pendingReply) return new Promise(resolve => { pendingReply.resolve = resolve })
    const local = new LocalAttachmentFiles({ collaborationId: input.collaborationId })
    const attachment = await local.select(input, attachmentMimeType, signal)
    return { attachment, storageScope: input.storageScope }
  }, send: async input => { sent.push(input); return { storageScope: input.storageScope } } }
const root = createRoot(document.getElementById('root'))
const controller = getFrameworkClientController(api), drafts = getConversationAttachmentDrafts(api)
const button = text => [...document.querySelectorAll('button')].find(row => row.textContent === text)
const hostInput = () => [...document.querySelectorAll('label')].find(row => row.textContent.includes('Absolute file path on the Host computer'))?.querySelector('input')
const change = async (element, value) => React.act(async () => { Simulate.change(element, { target: { value } }) })
const flush = async () => React.act(async () => { await new Promise(resolve => setImmediate(resolve)) })
const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); assert.ok(predicate(), 'Expected controlled UI operation did not settle') }
try {
  delete globalThis.__DSH_HOST_PATHS__
  await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en' })))
  await flush()
  check('Browser-style Local file picker is not offered without Desktop bridge', button('Attach files').disabled, true)
  check('Host path field explains browser versus Host ownership', !!hostInput(), true)
  await change(hostInput(), 'relative.txt')
  await React.act(async () => button('Attach Host file').click())
  check('Invalid entry remains in its field without an attachment row', [hostInput().value, document.querySelectorAll('[data-selected-attachment]').length], ['relative.txt', 0])
  check('Invalid entry reports a visible error', document.body.textContent.includes('absolute file path on the DSH Host computer'), true)
  const missingPath = path.join(sandbox, 'later.txt')
  await change(hostInput(), missingPath)
  await React.act(async () => button('Attach Host file').click())
  const scopeA = frameworkScopeKey('local', 'chat-a', 'local-scope')
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'error')
  check('Missing Host original reports a per-file error and blocks only attachment send', [!!drafts.selections(scopeA)[0].error, button('Send').disabled], [true, true])
  const retryId = drafts.selections(scopeA)[0].id
  await fs.writeFile(missingPath, 'arrived on Host')
  await React.act(async () => button('Retry selection').click())
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'ready')
  check('Retry uses same Host selection identity after original becomes available', [drafts.selections(scopeA)[0].id, calls.at(-1).selectionId], [retryId, retryId])
  await React.act(async () => button('Remove').click())
  await change(hostInput(), nativePath)
  await React.act(async () => button('Attach Host file').click())
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'ready')
  check('Host path selection uses original-path RPC with no bytes', [calls.at(-1).path, 'bytes' in calls.at(-1)], [nativePath, false])
  check('Original is ready and no upload was needed', [drafts.selections(scopeA)[0].state, drafts.selections(scopeA)[0].file], ['ready', undefined])
  check('Ready row displays actual Host path', document.body.textContent.includes(nativePath), true)
  await React.act(async () => button('Send').click())
  await flush()
  check('Send carries Local original reference', [sent.length, sent[0].attachments[0].path, sent[0].attachments[0].mode], [1, nativePath, 'local'])
  check('Acknowledged selection is removed', drafts.selections(scopeA).length, 0)
  const nativeReads = [], nativeCtx = { tools: { execute: async input => { nativeReads.push(input); return { isError: false, content: [{ type: 'image', attachment: { attachmentId: 'controlled-image' } }] } } } }
  const execution = () => ({ signal: new AbortController().signal, agent: {}, token: {}, rootCallId: 'root', callId: randomUUID(), deferContext() {}, concludeTurn() {} })
  const ordinary = await prepareNativeLocalAttachment(nativeCtx, sent[0].attachments[0], execution())
  check('Ordinary Host path stays a path for existing Host file tools', [ordinary.delivery, nativeReads.length], ['local-file-path', 0])
  for (const [imagePath, mimeType] of [[pngPath, 'image/png'], [jpegPath, 'image/jpeg']]) {
    await change(hostInput(), imagePath)
    await React.act(async () => button('Attach Host file').click())
    await waitFor(() => drafts.selections(scopeA)[0]?.state === 'ready')
    const reference = drafts.selections(scopeA)[0].reference
    check('Host header identifies manually entered ' + mimeType, [reference.mimeType, reference.path], [mimeType, imagePath])
    const visual = await prepareNativeLocalAttachment(nativeCtx, reference, execution())
    check('Manual ' + mimeType + ' reaches current Agent native read_image', [visual.delivery, nativeReads.at(-1).name, nativeReads.at(-1).arguments.file_path], ['image-content', 'read_image', imagePath])
    await React.act(async () => button('Remove').click())
  }

  pendingReply = {}
  await change(hostInput(), otherPath)
  await React.act(async () => button('Attach Host file').click())
  await flush()
  check('Pending original belongs only to chat A', drafts.selections(scopeA).map(row => row.state), ['uploading'])
  currentView = view('chat-b')
  await React.act(async () => controller.publish({ value: currentView }))
  await flush()
  const scopeB = frameworkScopeKey('local', 'chat-b', 'local-scope')
  check('Navigation hides old pending attachment and Host path text', [drafts.selections(scopeB).length, hostInput().value], [0, ''])
  await React.act(async () => { pendingReply.resolve({ attachment: await new LocalAttachmentFiles({ collaborationId: 'chat-a' }).select({ mode: 'local', collaborationId: 'chat-a', selectionId: calls.at(-1).selectionId, path: otherPath, name: 'other.txt', mimeType: 'application/octet-stream' }, (_head, declared) => declared), storageScope: 'local-scope' }) })
  await flush()
  check('Late receipt remains in chat A, not chat B', [drafts.selections(scopeA)[0].state, drafts.selections(scopeB).length], ['ready', 0])
  currentView = view('chat-a')
  await React.act(async () => controller.publish({ value: currentView }))
  await flush()
  check('Return to chat A preserves its own original', drafts.selections(scopeA)[0].reference.path, otherPath)
  await React.act(async () => button('Remove').click())
  check('Remove clears only that selected Host path row', drafts.selections(scopeA).length, 0)
  await change(hostInput(), nativePath)
  currentView = view('chat-b')
  await React.act(async () => controller.publish({ value: currentView }))
  await flush()
  check('Unsubmitted Host path is not shown in another conversation', hostInput().value, '')
  currentView = view('chat-a')
  await React.act(async () => controller.publish({ value: currentView }))
  await flush()
  check('Unsubmitted Host path returns only to its owning conversation', hostInput().value, nativePath)
  pendingReply = {}
  await change(hostInput(), otherPath)
  await React.act(async () => button('Attach Host file').click())
  await flush()
  check('New Host path waits for its original RPC', drafts.selections(scopeA)[0].state, 'uploading')
  await React.act(async () => button('Remove').click())
  await React.act(async () => { pendingReply.resolve({ attachment: await new LocalAttachmentFiles({ collaborationId: 'chat-a' }).select({ mode: 'local', collaborationId: 'chat-a', selectionId: calls.at(-1).selectionId, path: otherPath, name: 'other.txt', mimeType: 'application/octet-stream' }, (_head, declared) => declared), storageScope: 'local-scope' }) })
  await flush()
  check('Removing a pending Host path keeps its late reply retired', drafts.selections(scopeA).length, 0)
  const picked = new dom.window.File(['browser File bytes are not the Host original'], 'source.txt', { type: 'text/plain' })
  globalThis.__DSH_HOST_PATHS__ = { pathFor: file => file === picked ? nativePath : '' }
  await React.act(async () => root.render(React.createElement(FrameworkPage, { api, language: 'en' })))
  check('Desktop bridge keeps existing file picker enabled', button('Attach files').disabled, false)
  const fileInput = document.querySelector('input[type=file]')
  Object.defineProperty(fileInput, 'files', { value: [picked], configurable: true })
  await React.act(async () => button('Attach files').click())
  await React.act(async () => Simulate.change(fileInput))
  await waitFor(() => drafts.selections(scopeA)[0]?.state === 'ready')
  check('Bridge-present picker still attaches original Host path, not File bytes', [calls.at(-1).path, drafts.selections(scopeA)[0].reference.path], [nativePath, nativePath])
  await React.act(async () => button('Remove').click())
  check('Explicit Host entry did not copy or modify original', await fs.readFile(nativePath, 'utf8'), 'first user content')
  console.log(JSON.stringify({ status: 'passed', assertions: names.length, names, limits: 'Full FrameworkPage with controlled React primitives and browser-like jsdom, actual LocalAttachmentFiles on scratch originals, controlled RPC/transport; no real Electron preload, signed-in Web, Windows host, or Git provider.' }, null, 2))
} finally {
  await React.act(async () => root.unmount()); dom.window.close(); delete globalThis.__DSH_HOST_PATHS__
  await fs.rm(sandbox, { recursive: true, force: true })
}
