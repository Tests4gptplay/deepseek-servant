import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
await mkdir('.validation/lifecycle-ui', { recursive: true })
await build({ entryPoints: { page: 'src/client/page.tsx', source: 'src/client/source.ts', locales: 'src/client/locales.ts' }, outdir: '.validation/lifecycle-ui', outExtension: { '.js': '.mjs' }, bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' },
  define: Object.fromEntries(['STATUS_ICON', 'ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'])
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true })
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
const React = await import('react'), { act } = React, { createRoot } = await import('react-dom/client')
const { ServantPage } = await import('../.validation/lifecycle-ui/page.mjs')
const { createServantSource } = await import('../.validation/lifecycle-ui/source.mjs')
const { en } = await import('../.validation/lifecycle-ui/locales.mjs')
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const root = createRoot(document.getElementById('root'))
let reset = () => {}, slowReads = false
const stalled = defer(), sends = [], notices = []
const view = { assistant: { id: 'default', revision: 1, settings: { name: 'Servant', foreground: { provider: 'fixture', model: 'synthetic' }, showCornerCharacter: false }, workspace: { id: 'test', directory: 'test' }, pendingInputs: [] }, messages: [], tasks: [], workspaces: [], runtime: { status: 'running', workerSeats: 2 } }
const source = createServantSource({ view: async () => slowReads ? stalled.promise : view, retention: async () => ({ totalBytes: 0 }),
  subscribeChanged: () => () => {}, subscribeReset: listener => { reset = listener; return () => {} },
  send: (input, signal) => { const pending = defer(); sends.push({ ...input, signal, ...pending }); return pending.promise },
}, notice => notices.push(notice))
const props = { t: key => en[key] ?? key,
  useServant: selector => selector(React.useSyncExternalStore(source.source.subscribe, source.source.getSnapshot)),
  useModels: selector => selector({ current: null, groups: [], failures: [], status: 'ready', error: null }),
  onSend: source.send, onHistoryPage: source.historyPage, onRefresh: source.refresh }
const input = () => document.querySelector('textarea')
const write = async text => act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input(), text); input().dispatchEvent(new Event('input', { bubbles: true })) })
const enter = async () => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick() })
const sending = () => [...document.querySelectorAll('button')].some(button => button.textContent === en['conversation.sending'])
try {
  await act(async () => { root.render(React.createElement(ServantPage, props)); await tick() })
  await write('ACK independent of read'); await enter(); assert.equal(sending(), true)
  slowReads = true
  await act(async () => { sends[0].resolve({ status: 'queued' }); await tick() })
  assert.equal(sending(), false, 'ACK clears Sending while view read never responds')
  assert.equal(input().value, '', 'ACK clears only the submitted draft')
  slowReads = false
  await act(async () => { reset(); await tick() })
  assert.equal(sends.length, 1, 'reset after ACK does not resend')
  await write('uncertain draft'); await enter()
  const uncertainId = sends[1].messageId
  await act(async () => { reset(); await tick() })
  assert.equal(sending(), false); assert.equal(input().value, 'uncertain draft')
  assert.equal(sends.length, 2, 'reset before ACK does not resend')
  await enter()
  assert.equal(sends[2].messageId, uncertainId, 'explicit unchanged retry retains stable messageId')
  await act(async () => { sends[1].resolve({ status: 'queued' }); await tick() })
  assert.equal(sending(), true); assert.equal(input().value, 'uncertain draft', 'old callback cannot clear newer send/draft')
  await act(async () => { sends[2].resolve({ status: 'queued' }); await tick() })
  assert.equal(input().value, ''); assert.equal(sending(), false)
  await write('first draft'); await enter()
  await write('newer unsent draft')
  await act(async () => { sends[3].resolve({ status: 'queued' }); await tick() })
  assert.equal(input().value, 'newer unsent draft', 'receipt for prior ID never clears edited draft')
  assert.deepEqual(notices.map(n => n.key), ['sent', 'interrupted', 'sent', 'sent'])
  assert.equal(sends.length, 4)
  console.log('PASS: actual React composer/source ACK vs stalled read, lifecycle reset before/after ACK, stable ID explicit retry, no automatic replay, stale callback isolation, preserved newer draft.')
} finally { await act(() => { source.dispose(); root.unmount() }); dom.window.close() }
