import test from 'node:test'
import assert from 'node:assert/strict'
import type { FrameworkClientApi, FrameworkClientView } from '../src/framework/client-contracts.js'
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res }); return { promise, resolve } }
const view = (mode: 'local' | 'git', scope: string): FrameworkClientView => ({ revision: mode + '-settings', activeMode: mode, collaborationId: 'team', storageScope: scope, settings: { name: 'DeepSeek Servant', userName: '', localDirectory: '/original', ownerRepo: 'owner/repo', repositoryDirectory: '', collaborationId: 'team', workerSeats: 0, workspace: '/test' }, connection: { status: 'unknown', participating: false }, messages: [], tasks: [], legacyTasks: [], archives: [], resources: [] })
// Real React/official UI; the move RPC is an explicit controlled seam, not a disk migration.
test('record move requires confirmation, preserves unknown command across closing, and isolates late scope results', async () => {
  const { build } = await import('esbuild'), { JSDOM } = await import('jsdom')
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path')
  await build({ nodePaths: [resolve('node_modules')], entryPoints: ['src/framework/client-page.tsx'], outfile: '.validation/framework-record-move-ui/view.mjs', bundle: true, platform: 'node', format: 'esm', external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' }, define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const put = (key: string, value: unknown) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) put(key, key === 'window' ? dom.window : (dom.window as any)[key])
  put('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); put('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); put('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  put('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); put('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { FrameworkPage } = await import(pathToFileURL(resolve('.validation/framework-record-move-ui/view.mjs')).href)
  const root = createRoot(document.getElementById('root')!)
  let mode: 'local' | 'git' = 'local', localScope = 'original-local'
  let fail = false, gate: ReturnType<typeof deferred<FrameworkClientView>> | undefined
  const calls: Array<Parameters<FrameworkClientApi['moveRecords']>[0]> = []
  const current = () => view(mode, mode === 'local' ? localScope : 'git-storage')
  const api = {
    view: async () => current(), subscribeChanged: () => () => {},
    selectMode: async (input: { mode: 'local' | 'git' }) => { mode = input.mode; return current() },
    moveRecords: async (input: Parameters<FrameworkClientApi['moveRecords']>[0]) => {
      calls.push(structuredClone(input))
      if (fail) { fail = false; throw new Error('move receipt unknown') }
      return gate ? gate.promise : current()
    },
  } as FrameworkClientApi
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  const click = async (label: string) => { const target = button(label); assert.ok(target, label); await React.act(async () => { target.click(); await tick() }) }
  const enter = async (text: string) => {
    const input = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('Target record directory (absolute path)'))!.querySelector('input')!
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await tick()
    })
  }
  try {
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { api, language: 'en' })); await tick() })
    assert.equal(button('Move and apply'), undefined)
    await click('Settings'); await enter('/authorized/target'); await click('Move and apply')
    assert.equal(calls.length, 0); assert.match(document.body.textContent!, /both Local and Git modes/)
    assert.match(document.body.textContent!, /Native Host logs are not moved/)
    await click('Cancel'); assert.equal(calls.length, 0)
    await click('Move and apply'); fail = true; await click('Confirm move and apply')
    assert.equal(calls.length, 1); assert.equal(calls[0]!.directory, '/authorized/target'); assert.equal(calls[0]!.expectedRevision, 'local-settings')
    assert.match(document.body.textContent!, /move receipt unknown/)
    assert.match(document.body.textContent!, /Closing this panel does not cancel/)
    await click('Close'); await click('Settings')
    assert.ok(button('Resolve and retry original move')); assert.equal(button('Move and apply'), undefined)
    await click('Resolve and retry original move')
    assert.deepEqual(calls[1], calls[0]); assert.match(document.body.textContent!, /Records moved and applied/)
    await enter('/authorized/second'); await click('Move and apply'); gate = deferred(); await click('Confirm move and apply')
    const pending = calls.at(-1)!; assert.notEqual(pending.commandId, calls[0]!.commandId)
    await click('Close'); await click('Settings'); assert.equal(calls.length, 3, 'remount observes the same in-flight request without resending it')
    await click('Close'); await click('DSS-cah'); await click('Settings')
    assert.equal(button('Move and apply'), undefined); assert.equal(button('Resolve and retry original move'), undefined)
    await React.act(async () => { gate!.resolve(view('local', 'original-local')); await tick() })
    assert.doesNotMatch(document.body.textContent!, /Records moved and applied/)
    localScope = 'replacement-local'; await click('Close'); await click('Local'); await click('Settings')
    assert.ok(button('Move and apply')); assert.equal(button('Resolve and retry original move'), undefined)
    assert.equal(calls.length, 3)
    const serverRequest = { commandId: 'durable-host-command', storageScope: 'retained-original-scope', expectedRevision: 'retained-settings-revision', directory: '/durable/original-target' }
    const restoredCalls: unknown[] = []
    let restoredDone = false
    const restoredView = () => restoredDone ? view('local', 'retained-original-scope') : { ...view('local', ''), storageScope: undefined, pendingRecordMove: serverRequest }
    const freshApi = { view: async () => restoredView(), subscribeChanged: () => () => {}, moveRecords: async (input: unknown) => { restoredCalls.push(input); restoredDone = true; return restoredView() } } as FrameworkClientApi
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { key: 'after-browser-reload', api: freshApi, language: 'en' })); await tick() })
    await click('Settings')
    assert.equal(restoredCalls.length, 0, 'server pending receipt does not automatically submit a move')
    assert.ok(button('Resolve and retry original move'), 'missing ordinary storage scope does not hide the retained move')
    assert.equal(button('Move and apply'), undefined)
    await click('Resolve and retry original move')
    assert.deepEqual(restoredCalls, [{ ...serverRequest, mode: 'local' }], 'fresh API/WeakMap restores exact durable identity without generating a replacement command')
  } finally {
    await React.act(() => root.unmount()); dom.window.close()
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
