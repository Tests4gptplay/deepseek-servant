import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

await mkdir('.validation/history-ui', { recursive: true })
await build({
  entryPoints: { page: 'src/mode-router/page.tsx', locales: 'src/client/locales.ts', modes: 'src/mode-router/locales.ts' },
  outdir: '.validation/history-ui', outExtension: { '.js': '.mjs' }, bundle: true,
  platform: 'node', format: 'esm', target: 'node24',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  loader: { '.css': 'empty' },
  define: Object.fromEntries(['STATUS_ICON', 'ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])),
})
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'WheelEvent'])
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true })
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ModePage: ServantPage } = await import('../.validation/history-ui/page.mjs')
const { modeZh } = await import('../.validation/history-ui/modes.mjs')
let modeSnapshot = { ready: true, activeMode: 'LOCAL' }
const modeListeners = new Set()
const modeClient = { snapshot: () => modeSnapshot, subscribe: fn => { modeListeners.add(fn); return () => modeListeners.delete(fn) },
  select: async mode => { modeSnapshot = { ...modeSnapshot, activeMode: mode }; for (const fn of modeListeners) fn() }, loadCoop: async () => {} }
const { zh } = await import('../.validation/history-ui/locales.mjs')
const root = createRoot(document.getElementById('root'))
const historyCalls = [], sends = []
const messages = (start, end) => Array.from({ length: end - start }, (_, offset) => ({
  id: 'message-' + (start + offset), ref: 'ref-' + (start + offset), role: 'assistant', text: 'Message ' + (start + offset),
}))
let snapshot = {
  status: 'ready', pending: [], history: { canGoNewer: false },
  value: {
    assistant: { id: 'default', revision: 1, settings: { name: 'Servant', foreground: { provider: 'fixture', model: 'model' }, showCornerCharacter: false }, workspace: { id: 'test', directory: 'test' }, pendingInputs: [] },
    messages: messages(8, 16), conversationBefore: 'ref-8', tasks: [], workspaces: [],
    runtime: { status: 'running', workerSeats: 2 },
  },
}
const props = {
  modeClient,
  modeText: key => modeZh[key] ?? key,
  t: (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replace('{' + name + '}', value), zh[key] ?? key),
  useServant: selector => selector(snapshot),
  useModels: selector => selector({ current: null, groups: [], failures: [], status: 'ready', error: null }),
  onHistoryPage: async (...args) => { historyCalls.push(args) },
  onSend: async (...args) => { sends.push(args); return true },
}
const render = () => root.render(React.createElement(ServantPage, props))
const click = async element => { assert.ok(element); await act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))) }
try {
  await act(render)
  const log = document.querySelector('[role="log"]')
  let top = 0
  Object.defineProperties(log, {
    clientHeight: { get: () => 100 },
    scrollHeight: { get: () => log.querySelectorAll('article').length * 50 },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, log.scrollHeight - 100)) } },
  })
  snapshot = { ...snapshot, value: { ...snapshot.value, messages: [...snapshot.value.messages] } }
  await act(render)
  assert.equal(top, 300, 'initial history is at its newest message')
  await act(() => { log.scrollTop = 30; log.dispatchEvent(new Event('scroll', { bubbles: true })) })
  assert.deepEqual(historyCalls, [['older']], 'scrolling near the top preloads before hitting it')
  await act(() => log.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true })))
  assert.equal(historyCalls.length, 1, 'rapid scroll events share one preload')
  snapshot = { ...snapshot, status: 'loading', history: { before: 'ref-8', canGoNewer: true } }
  await act(render)
  snapshot = { ...snapshot, status: 'ready', value: { ...snapshot.value, messages: messages(0, 16), conversationBefore: undefined } }
  await act(render)
  assert.equal(top, 430, 'prepending 400px preserves the text at the previous 30px reading position')
  assert.equal(log.querySelectorAll('article').length, 16)
  snapshot = { ...snapshot, value: { ...snapshot.value, messages: messages(0, 17) } }
  await act(render)
  assert.equal(top, 430, 'a new message does not drag a history reader to the bottom')

  snapshot = { ...snapshot, history: { date: '2026-10-26', canGoNewer: false } }
  await act(render)
  await click(document.querySelector('button[aria-label="日期"]'))
  assert.ok(document.querySelector('[role="dialog"] [role="grid"]'))
  assert.equal(document.querySelector('input[type="date"]'), null, 'calendar is rendered with host primitives, not an OS date popup')
  await click(document.querySelector('button[aria-label="下个月"]'))
  await click([...document.querySelectorAll('[role="gridcell"]')].find(cell => cell.textContent === '3'))
  assert.deepEqual(historyCalls.at(-1), ['date', '2026-11-03'])
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await click(document.querySelector('button[aria-label="日期"]'))
  await act(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(document.activeElement.getAttribute('aria-label'), '日期')
  await click(document.querySelector('button[aria-label="日期"]'))
  await click([...document.querySelectorAll('button')].find(button => button.textContent === '全部日期'))
  assert.deepEqual(historyCalls.at(-1), ['date', ''])

  const input = document.querySelector('textarea')
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'hello foreground')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await Promise.resolve() })
  assert.equal(sends.length, 1)
  assert.equal(sends[0][1], 'hello foreground')
  assert.deepEqual(sends[0][2], { provider: 'fixture', model: 'model' })
  assert.equal(input.value, '')
  const draft = 'Keep this unsubmitted draft'
  await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, draft); input.dispatchEvent(new Event('input', { bubbles: true })) })
  const modeButton = () => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === modeSnapshot.activeMode.replace('LOCAL', 'local').replace('PRIVATE_GIT_EXPERIMENTAL', 'DSS-cah'))
  await click(modeButton())
  assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim()), ['local', 'DSS-cah'])
  await click([...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim() === 'DSS-cah'))
  assert.equal(modeSnapshot.activeMode, 'PRIVATE_GIT_EXPERIMENTAL')
  assert.equal(document.querySelector('textarea'), input, 'mode switch preserves the original composer element')
  assert.equal(input.value, draft)
  assert.equal(sends.length, 1, 'selection alone does not send or create a task')
  await click(modeButton())
  await click([...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim() === 'local'))
  assert.equal(input.value, draft)
  console.log('PASS: mode selector, preserved composer/draft, scroll preload, in-flight coalescing, reading anchor, background update, themed date selection, Escape, clear date and Enter send.')
} finally {
  await act(() => root.unmount())
  dom.window.close()
}
