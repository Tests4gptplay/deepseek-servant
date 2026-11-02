import test from 'node:test'
import assert from 'node:assert/strict'
import type { FrameworkClientApi, FrameworkClientView } from '../src/framework/client-contracts.js'
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res }); return { promise, resolve } }
const view = (mode: 'local' | 'git', scope: string): FrameworkClientView => ({ revision: mode + '-settings', activeMode: mode, collaborationId: 'team', storageScope: scope, settings: { name: 'DeepSeek Servant', userName: '', localDirectory: '/original', ownerRepo: 'owner/repo', repositoryDirectory: '', collaborationId: 'team', workerSeats: 0, workspace: '/test' }, connection: { status: 'unknown', participating: false }, messages: [], tasks: [], legacyTasks: [], archives: [], resources: [] })
// Real React/official UI with an explicit Host projection/RPC seam; no simulated native execution claim.
test('native Foreground processing pill follows confirmed scope/turn and preserves elapsed time across refresh', async () => {
  const { build } = await import('esbuild'), { JSDOM } = await import('jsdom')
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path')
  await build({ nodePaths: [resolve('node_modules')], entryPoints: ['src/framework/client-page.tsx'], outfile: '.validation/framework-foreground-processing-ui/view.mjs', bundle: true, platform: 'node', format: 'esm', external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' }, define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const put = (key: string, value: unknown) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) put(key, key === 'window' ? dom.window : (dom.window as any)[key])
  put('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); put('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); put('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  put('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); put('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { FrameworkPage } = await import(pathToFileURL(resolve('.validation/framework-foreground-processing-ui/view.mjs')).href)
  let root = createRoot(document.getElementById('root')!)

  let current = view('local', 'scope-A'), fail = false, changed: (() => void) | undefined
  let modeGate: ReturnType<typeof deferred<FrameworkClientView>> | undefined
  let reads = 0, now = 100_000
  const timers = new Map<number, () => void>(); let nextTimer = 0
  const realNow = Date.now, realInterval = globalThis.setInterval, realClear = globalThis.clearInterval
  Date.now = () => now
  globalThis.setInterval = ((callback: () => void, delay: number) => { assert.equal(delay, 1000); const id = ++nextTimer; timers.set(id, callback); return id }) as any
  globalThis.clearInterval = ((id: number) => { timers.delete(id) }) as any
  const api = {
    view: async () => { reads++; if (fail) throw new Error('connection unavailable'); return current },
    subscribeChanged: (listener: () => void) => { changed = listener; return () => { changed = undefined } },
    selectMode: async () => modeGate!.promise,
  } as FrameworkClientApi
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const refresh = async () => { await React.act(async () => { changed!(); await tick() }) }
  const pill = () => document.querySelector('[data-foreground-processing]')
  const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  const mount = async () => { await React.act(async () => { root.render(React.createElement(FrameworkPage, { api, language: 'en' })); await tick() }) }
  try {
    await mount()
    assert.equal(pill(), null, 'queued request without a native start never displays processing')
    current = { ...current, settings: { ...current.settings, name: 'My Servant' }, foregroundProcessing: { executionId: 'execution-A', turnId: 'turn-A', startedAt: 95_000 },
      messages: [{ id: 'short', participantId: 'foreground', role: 'assistant', text: 'I am checking that.', createdAt: '2026-11-01T00:00:00Z' }] as any }
    await refresh()
    assert.match(pill()!.textContent!, /My Servant is working.*5s elapsed/)
    assert.equal(pill()!.querySelector('[role="timer"]')!.getAttribute('aria-live'), 'off')
    assert.equal(timers.size, 1)
    assert.equal(document.querySelector('textarea')!.disabled, false, 'pill leaves the composer available')
    assert.equal(pill()!.nextElementSibling?.querySelector('textarea'), document.querySelector('textarea'), 'pill is an independent row immediately above the composer')
    const beforeTick = reads
    now += 2000
    await React.act(async () => { for (const callback of timers.values()) callback(); await tick() })
    assert.match(pill()!.textContent!, /7s elapsed/); assert.equal(reads, beforeTick, 'presentation timer never polls Host')
    await refresh(); assert.match(pill()!.textContent!, /7s elapsed/)
    await React.act(async () => { root.unmount(); await tick() }); assert.equal(timers.size, 0)
    root = createRoot(document.getElementById('root')!)
    now += 3000; await mount(); assert.match(pill()!.textContent!, /10s elapsed/, 'remount uses original native start')
    current = { ...current, foregroundProcessing: undefined, messages: [...current.messages, { id: 'final', participantId: 'foreground', role: 'assistant', text: 'The completed result.', createdAt: '2026-11-01T00:01:00Z' } as any] }
    await refresh(); assert.equal(pill(), null); assert.equal(timers.size, 0)
    current = { ...current, foregroundProcessing: { executionId: 'execution-B', turnId: 'turn-B', startedAt: now } }
    await refresh(); assert.match(pill()!.textContent!, /0s elapsed/)
    fail = true; await refresh(); assert.equal(pill(), null); assert.equal(timers.size, 0)
    fail = false; await refresh(); assert.ok(pill())
    modeGate = deferred()
    await React.act(async () => { button('DSS-cah')!.click(); await tick() })
    assert.equal(pill(), null, 'old scope is hidden while mode navigation is unresolved')
    current = view('git', 'scope-Git')
    await React.act(async () => { modeGate!.resolve(current); await tick() })
    assert.equal(pill(), null, 'Git messages without native owner evidence cannot display processing')
    const newScope = view('git', 'scope-new')
    current = { ...newScope, settings: { ...newScope.settings, name: '' }, foregroundProcessing: { executionId: 'execution-C', turnId: 'turn-C', startedAt: now - 1000 } }
    await refresh(); assert.match(pill()!.textContent!, /DeepSeek Servant is working.*1s elapsed/)
    current = { ...current, foregroundProcessing: undefined }; await refresh()
    assert.equal(pill(), null, 'cancel/error/unknown DTO absence immediately removes the pill')
    assert.equal(timers.size, 0)
  } finally {
    await React.act(async () => { root.unmount(); await tick() })
    Date.now = realNow; globalThis.setInterval = realInterval; globalThis.clearInterval = realClear
    dom.window.close()
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key] }
  }
})

test('SSE error without reset hides stale native processing without making an RPC', async () => {
  const { subscribeEventStreams } = await import('../src/client/event-streams.js')
  const { build } = await import('esbuild'), { JSDOM } = await import('jsdom')
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path')
  await build({ nodePaths: [resolve('node_modules')], entryPoints: ['src/framework/client-page.tsx'], outfile: '.validation/framework-foreground-processing-ui/view.mjs', bundle: true, platform: 'node', format: 'esm', external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' }, define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const put = (key: string, value: unknown) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) put(key, key === 'window' ? dom.window : (dom.window as any)[key])
  put('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); put('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); put('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  put('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); put('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { FrameworkPage } = await import(pathToFileURL(resolve('.validation/framework-foreground-processing-ui/view.mjs')).href)
  let root = createRoot(document.getElementById('root')!)


 let calls=0
 let connectionStatus: 'connected' | 'disconnected' | 'connecting' = 'connected', connectionChanged = () => {}
 const connectionState = { getSnapshot: () => connectionStatus, subscribe: (listener: () => void) => { connectionChanged = listener; return () => { connectionChanged = () => {} } } }
 let pending: ReturnType<typeof deferred<FrameworkClientView>> | undefined
 const sources: Array<{emit:(name:string)=>void}> = []
 const create=()=>{
   const handlers=new Map<string,Set<()=>void>>()
   const source={addEventListener:(name:string,fn:()=>void)=>{const set=handlers.get(name)??new Set();set.add(fn);handlers.set(name,set)},removeEventListener:(name:string,fn:()=>void)=>handlers.get(name)?.delete(fn),close:()=>{},emit:(name:string)=>{for(const fn of handlers.get(name)??[])fn()}}
   sources.push(source);return source as unknown as EventSource
 }
 const current={...view('local','scope'),foregroundProcessing:{executionId:'e',turnId:'t',startedAt:Date.now()-2000}}
 const api={view:async()=>{calls++;return pending ? pending.promise : current},subscribeChanged:(listener:()=>void,availability?: (available:boolean)=>void)=>subscribeEventStreams(['api/deepseek-servant-framework/events'],listener,()=>()=>{},create,availability,connectionState)} as FrameworkClientApi
 const tick=()=>new Promise(resolve=>setImmediate(resolve))
 try {
  await React.act(async()=>{root.render(React.createElement(FrameworkPage,{api,language:'en'}));await tick()})
  assert.equal(!!document.querySelector('[data-foreground-processing]'),false,'initial connecting carrier has no live display authority')
  await React.act(async()=>{sources[0].emit('open');await tick()})
  assert.ok(document.querySelector('[data-foreground-processing]'))
  pending=deferred()
  await React.act(async()=>{sources[0].emit('changed');await tick()})
  const before=calls
  await React.act(async()=>{sources[0].emit('error');await tick()})
  assert.equal(calls,before,'error itself does not initiate an extra network retry')
  assert.equal(!!document.querySelector('[data-foreground-processing]'),false,'stale processing must be hidden on lost event carrier')
  await React.act(async()=>{pending!.resolve(current);await tick()})
  assert.equal(!!document.querySelector('[data-foreground-processing]'),false,'old in-flight view cannot restore stale display after error')
  pending=deferred()
  await React.act(async()=>{sources[0].emit('open');await tick()})
  assert.equal(!!document.querySelector('[data-foreground-processing]'),false,'open waits for a fresh successful view')
  await React.act(async()=>{pending!.resolve(current);await tick()})
  assert.ok(document.querySelector('[data-foreground-processing]'))
  const beforeDisconnect = calls
  await React.act(async()=>{connectionStatus = 'disconnected'; connectionChanged(); await tick()})
  assert.equal(!!document.querySelector('[data-foreground-processing]'), false)
  await React.act(async()=>{connectionStatus = 'connected'; connectionChanged(); await tick()})
  assert.equal(calls, beforeDisconnect, 'official availability does not add RPC retries')
  assert.equal(!!document.querySelector('[data-foreground-processing]'), false, 'official reconnect alone cannot revive the old DTO')
  await React.act(async()=>{sources[0].emit('changed'); await tick()})
  assert.ok(document.querySelector('[data-foreground-processing]'), 'existing notification refresh can restore newly checked native facts')
  await React.act(async()=>{root.render(React.createElement(FrameworkPage,{api,language:'en',transportConnected:false}));await tick()})
  assert.equal(!!document.querySelector('[data-foreground-processing]'),false,'official Connection outage independently hides display')
  assert.equal(document.querySelector('textarea')!.disabled,false,'display availability is not a composer gate')
 } finally {
  await React.act(async()=>{root.unmount();await tick()});dom.window.close()
  for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key]}
 }
})
