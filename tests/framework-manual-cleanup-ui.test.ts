import test from 'node:test'
import assert from 'node:assert/strict'
import type { FrameworkClientApi, FrameworkClientView } from '../src/framework/client-contracts.js'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res }); return { promise, resolve } }
const view = (mode: 'local' | 'git', storageScope = mode + '-storage'): FrameworkClientView => ({ revision: mode + '-1', activeMode: mode, collaborationId: 'team', storageScope, settings: { name: 'DeepSeek Servant', userName: '', localDirectory: '/test', ownerRepo: 'owner/repo', repositoryDirectory: '', collaborationId: 'team', workerSeats: 0, workspace: '/test' }, connection: { status: 'unknown', participating: false }, messages: [], tasks: [], legacyTasks: [], archives: [], resources: [] })

// Actual React/DOM interaction with an explicit RPC seam, not a filesystem deletion test.
test('Local cleanup UI requires independent confirmation, preserves retry identity and isolates late scope results', async () => {
  const { build } = await import('esbuild'), { JSDOM } = await import('jsdom')
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path')
  await build({ entryPoints: ['src/framework/client-page.tsx'], outfile: '.validation/framework-manual-cleanup-ui.mjs', bundle: true, platform: 'node', format: 'esm', external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' }, define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const put = (key: string, value: unknown) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) put(key, key === 'window' ? dom.window : (dom.window as any)[key])
  put('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); put('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); put('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  put('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); put('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { FrameworkPage } = await import(pathToFileURL(resolve('.validation/framework-manual-cleanup-ui.mjs')).href)
  const root = createRoot(document.getElementById('root')!)
  const preview: Awaited<ReturnType<FrameworkClientApi['cleanupPreview']>> = { id: 'preview-H', tasks: [{ taskId: 'ended-T', signature: 'input-version', files: 7, bytes: 123 }], fileCount: 7, bytes: 123, preservedPaths: ['archives/ended-T/output.bin'] }
  const previews: unknown[] = [], deletes: Array<Parameters<FrameworkClientApi['cleanupRecords']>[0]> = []
  let previewGate: ReturnType<typeof deferred<any>> | undefined, deleteGate: ReturnType<typeof deferred<any>> | undefined, fail = false
  let mode: 'local' | 'git' = 'local', localScope = 'local-storage'
  const result = { deletedPaths: ['archives/ended-T/records.md'], preservedPaths: ['archives/ended-T/output.bin'] } as any
  const api = {
    view: async () => view(mode, mode === 'local' ? localScope : 'git-storage'),
    selectMode: async (input: { mode: 'local' | 'git' }) => { mode = input.mode; return view(mode, mode === 'local' ? localScope : 'git-storage') },
    subscribeChanged: () => () => {},
    cleanupPreview: async (input: unknown) => { previews.push(input); return previewGate ? previewGate.promise : preview },
    cleanupRecords: async (input: Parameters<FrameworkClientApi['cleanupRecords']>[0]) => { deletes.push(structuredClone(input)); if (fail) { fail = false; throw new Error('receipt unknown') } return deleteGate ? deleteGate.promise : result },
  } as FrameworkClientApi
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  const click = async (label: string) => { const target = button(label); assert.ok(target, label); await React.act(async () => { target.click(); await tick() }) }
  const labels = ['Clear ended task records', 'Clear Foreground conversation', 'Clear working List and Cache']
  try {
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { api, language: 'en' })); await tick() })
    assert.equal(button(labels[0]), undefined, 'cleanup is under Settings, not an automatic action')
    await click('Settings')
    for (const label of labels) {
      await click(label); assert.ok(button('Confirm cleanup')); assert.equal(deletes.length, 0)
      if (label === labels[0]) { assert.match(document.body.textContent!, /1 tasks · 7 files · 123 bytes/); assert.match(document.body.textContent!, /artifacts, skills and knowledge remain/) }
      if (label === labels[1]) assert.match(document.body.textContent!, /Background tasks, List and Cache remain/)
      if (label === labels[2]) assert.match(document.body.textContent!, /conversation and task archives remain/)
      await click('Cancel'); assert.equal(deletes.length, 0, 'cancel never invokes destructive RPC')
    }
    assert.equal(previews.length, 1, 'conversation and planning confirmations do not borrow a task preview')
    for (const [index, label] of labels.entries()) {
      await click(label); fail = true; await click('Confirm cleanup')
      assert.match(document.body.textContent!, /receipt unknown/)
      const failed = deletes.at(-1)!, previewCount = previews.length
      await click('Confirm cleanup')
      assert.deepEqual(deletes.at(-1), failed, 'unknown retry keeps command, scope, action and original preview')
      assert.equal(previews.length, previewCount)
      assert.equal(failed.action, ['tasks', 'conversation', 'planning'][index])
      assert.equal(failed.confirmation, ['clear-ended-task-records', 'clear-foreground-conversation', 'clear-work-planning-notes'][index])
      assert.equal(failed.storageScope, 'local-storage')
      if (failed.action === 'tasks') assert.deepEqual(failed.preview, preview)
      assert.match(document.body.textContent!, /retained artifact files: 1/)
    }
    assert.equal(new Set(deletes.map(row => row.commandId)).size, 3, 'independent choices use independent commands')
    previewGate = deferred(); await click(labels[0]); await click('DSS-cah')
    assert.equal(button(labels[0]), undefined, 'Git settings have no Local cleanup entry')
    await React.act(async () => { previewGate!.resolve(preview); await tick() })
    assert.equal(button('Confirm cleanup'), undefined, 'late old Local preview cannot arm Git cleanup')
    localScope = 'local-storage-new'; await click('Local')
    assert.ok(button(labels[0])); assert.equal(button('Confirm cleanup'), undefined)
    previewGate = undefined; deleteGate = deferred(); await click(labels[1]); await click('Confirm cleanup')
    const inFlight = deletes.at(-1)!; assert.equal(inFlight.storageScope, 'local-storage-new')
    await click('DSS-cah'); localScope = 'local-storage-third'; await click('Local')
    await React.act(async () => { deleteGate!.resolve(result); await tick() })
    assert.equal(button('Confirm cleanup'), undefined)
    assert.doesNotMatch(document.body.textContent!, /Records cleared;/, 'old result cannot become success feedback in replacement scope')
    assert.equal(deletes.length, 7, 'late completion does not issue another cleanup in new scope')
    deleteGate = undefined; await click(labels[2]); await click('Confirm cleanup')
    assert.equal(deletes.at(-1)!.storageScope, 'local-storage-third')
    assert.notEqual(deletes.at(-1)!.commandId, inFlight.commandId)
  } finally {
    await React.act(() => root.unmount()); dom.window.close()
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})
