import test from 'node:test'
import assert from 'node:assert/strict'
import type { FrameworkClientApi, FrameworkClientView } from '../src/framework/client-contracts.js'
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res }); return { promise, resolve } }
const view = (mode: 'local' | 'git', includeArchives = false): FrameworkClientView => ({ revision: mode + '-1', activeMode: mode, collaborationId: 'team', storageScope: mode + '-storage', settings: { name: 'DeepSeek Servant', userName: '', localDirectory: '/test', ownerRepo: 'owner/repo', repositoryDirectory: '', collaborationId: 'team', workerSeats: 0, workspace: '/test' }, connection: { status: 'unknown', participating: false }, messages: [], tasks: [], legacyTasks: [{ migrationId: 'migration-one', oldTaskId: 'old-task', taskId: 'new-task', continuation: 'complete', ...(mode === 'local' ? { recordPath: 'technical/legacy/task.json' } : {}), ...(includeArchives ? { recordsAvailable: true } : {}) }], archives: [], resources: [] })
// Real React and official UI components, with an explicit RPC boundary.
test('legacy original data and full records have distinct real requests, Local export and scope-safe late replies', async () => {
  const { build } = await import('esbuild'), { JSDOM } = await import('jsdom')
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path')
  await build({ nodePaths: [resolve('node_modules')], entryPoints: ['src/framework/client-page.tsx'], outfile: '.validation/framework-legacy-records-ui/view.mjs', bundle: true, platform: 'node', format: 'esm', external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' }, define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const put = (key: string, value: unknown) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) put(key, key === 'window' ? dom.window : (dom.window as any)[key])
  put('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); put('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); put('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  put('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); put('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { FrameworkPage } = await import(pathToFileURL(resolve('.validation/framework-legacy-records-ui/view.mjs')).href)
  const root = createRoot(document.getElementById('root')!)
  let mode: 'local' | 'git' = 'local', includeArchives = false
  let gate: ReturnType<typeof deferred<{ text: string; revision: string }>> | undefined
  let exportGate: ReturnType<typeof deferred<{ path: string; sha256: string; bytes: number }>> | undefined
  const reads: unknown[] = [], exports: unknown[] = [], files: string[] = []
  const original = 'BEGIN COMPLETE ORIGINAL\n' + 'Full retained record 🚀\n'.repeat(20_000) + 'END COMPLETE ORIGINAL'
  const api = {
    view: async (input: { includeArchives?: boolean }) => { includeArchives ||= !!input.includeArchives; return view(mode, includeArchives) },
    selectMode: async (input: { mode: 'local' | 'git' }) => { mode = input.mode; includeArchives = false; return view(mode) },
    subscribeChanged: () => () => {},
    legacyRecords: async (input: unknown) => { reads.push(input); return gate ? gate.promise : { text: original, revision: 'records-H' } },
    readFile: async (input: { path: string }) => { files.push(input.path); return { path: input.path, text: '{"kind":"original-task-json"}', revision: 'task-H' } },
    exportRecords: async (input: unknown) => { exports.push(input); return exportGate ? exportGate.promise : { path: '/actual-export/old-task-records.md', sha256: 'digest', bytes: 123 } },
  } as FrameworkClientApi
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  const click = async (label: string) => { const target = button(label); assert.ok(target, label); await React.act(async () => { target.click(); await tick() }) }
  try {
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { api, language: 'en' })); await tick() })
    assert.equal(reads.length, 0)
    await click('Tasks')
    assert.equal(button('Complete original records'), undefined, 'availability is supplied only by explicit archive discovery')
    const data = [...document.querySelectorAll('button')].find(item => item.textContent?.startsWith('Original task data'))!
    assert.ok(data)
    await React.act(async () => { data.click(); await tick() })
    assert.deepEqual(files, ['technical/legacy/task.json']); assert.equal(reads.length, 0)
    await click('Close')
    await click('Archives')
    assert.equal(reads.length, 0, 'opening archive catalog does not decode complete bodies')
    await click('Complete original records')
    assert.deepEqual(reads[0], { mode: 'local', storageScope: 'local-storage', migrationId: 'migration-one', oldTaskId: 'old-task' })
    assert.ok(document.body.textContent!.includes(original), 'the actual viewer receives the entire returned original')
    await click('Close'); await click('Export complete original records')
    assert.deepEqual(exports[0], { mode: 'local', storageScope: 'local-storage', migrationId: 'migration-one', oldTaskId: 'old-task' })
    assert.match(document.body.textContent!, /actual-export\/old-task-records.md/)
    gate = deferred(); await click('Complete original records'); await click('DSS-cah')
    await React.act(async () => { gate!.resolve({ text: 'LATE OLD LOCAL FULL RECORD', revision: 'old-H' }); await tick() })
    assert.ok(!document.body.textContent!.includes('LATE OLD LOCAL FULL RECORD'))
    assert.equal(button('Export complete original records'), undefined)
    gate = undefined; await click('Tasks'); await click('Archives'); assert.equal([...document.querySelectorAll('button')].some(item => item.textContent?.startsWith('Original task data')), false); await click('Complete original records')
    assert.deepEqual(reads.at(-1), { mode: 'git', storageScope: 'git-storage', migrationId: 'migration-one', oldTaskId: 'old-task' })
    await click('Close'); await click('Local'); await click('Tasks'); await click('Archives')
    exportGate = deferred(); await click('Export complete original records'); await click('DSS-cah')
    await React.act(async () => { exportGate!.resolve({ path: '/late-old-local-export', sha256: 'digest', bytes: 1 }); await tick() })
    assert.ok(!document.body.textContent!.includes('/late-old-local-export'))
  } finally {
    await React.act(() => root.unmount()); dom.window.close()
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
