import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import os from 'node:os'
import { createHash } from 'node:crypto'
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
    api.onLoad({ filter: /.*/, namespace: 'test-port' }, () => ({ contents: `import React from ${JSON.stringify(require.resolve('react'))}; export const Button=props=>React.createElement('button',props); export const Input=props=>React.createElement('input',props);`, loader: 'js' }))
    api.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'css', namespace: 'test-css' }))
    api.onLoad({ filter: /.*/, namespace: 'test-css' }, () => ({ contents: 'export default {}', loader: 'js' }))
    api.onResolve({ filter: /^\.\/client-error\.js$/ }, () => ({ path: path.join(source, 'src/framework/client-error.ts') }))
  } }], logLevel: 'silent' })
const { React, act, createRoot, RecordMovePanel } = await import(pathToFileURL(outfile).href)
const container = document.getElementById('root'), root = createRoot(container)
let assertions = 0
const check = (value, expected) => { assert.deepEqual(value, expected); assertions++ }
const original = { storageScope: 'original-scope', expectedRevision: 'original-revision', commandId: 'original-command', directory: '/records/B' }
const expectedInput = { ...original, mode: 'local' }
async function mount(api, changed = async () => {}) {
  await act(async () => root.render(React.createElement(RecordMovePanel, { api, storageScope: original.storageScope,
    settingsRevision: 'newer-revision', pendingRequest: original, tr: cn => cn, changed })))
}
async function clear() { await act(async () => root.render(null)) }
async function retry() {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent === '核对并重试原搬家')
  assert(button, 'Original submitted command remains available')
  await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
}
try {
  const calls = []; let failRead = true
  const api = { moveRecords: async input => {
    calls.push(structuredClone(input))
    if (failRead) throw new Error('controlled current-directory read failure')
    return { recordMoveOutcome: { status: 'current-location', commandId: input.commandId, requestedDirectory: input.directory, directory: '/records/C' } }
  } }
  await mount(api); await retry()
  check(calls, [expectedInput]); check(container.textContent.includes('核对并重试原搬家'), true)
  check(container.textContent.includes('记录已搬家并应用'), false)
  // Unmount/remount shares the actual module WeakMap for this API object.
  await clear(); await mount(api); failRead = false; await retry()
  check(calls, [expectedInput, expectedInput])
  check(container.textContent.includes('原请求的完成结果尚未确认'), true)
  check(container.textContent.includes('/records/C'), true)
  check(container.textContent.includes('本次没有再次搬迁'), true)
  check(container.textContent.includes('记录已搬家并应用'), false)
  check(container.textContent.includes('核对并重试原搬家'), false)
  await clear()

  // A matching current directory still cannot attribute an old request.
  await mount({ moveRecords: async input => ({ recordMoveOutcome: { status: 'current-location', commandId: input.commandId, requestedDirectory: input.directory, directory: '/records/B' } }) })
  await retry()
  check(container.textContent.includes('/records/B'), true)
  check(container.textContent.includes('原请求的完成结果尚未确认'), true)
  check(container.textContent.includes('记录已搬家并应用'), false)
  await clear()

  let appliedCalls = 0, failRefresh = true
  const appliedApi = { moveRecords: async input => {
    appliedCalls++
    return { recordMoveOutcome: { status: 'applied', commandId: input.commandId, requestedDirectory: input.directory, directory: '/records/B' } }
  } }
  await mount(appliedApi, async () => { if (failRefresh) throw new Error('controlled refresh failure') })
  await retry()
  check(appliedCalls, 1); check(container.textContent.includes('核对并重试原搬家'), true)
  failRefresh = false; await retry()
  check(appliedCalls, 1); check(container.textContent.includes('记录已搬家并应用'), true)
  check(container.textContent.includes('核对时的记录目录：/records/B'), true)
  check(container.textContent.includes('原请求的完成结果尚未确认'), false)
  await clear()
  console.log(JSON.stringify({ status: 'passed', assertions, componentSHA256: createHash('sha256').update(await fs.readFile(component)).digest('hex'),
    limits: 'Current RecordMovePanel compiled from its full TSX source, real React and ReactDOM in JSDOM. Explicit Button/Input HTML and CSS ports; controlled API outputs/errors. Actual WeakMap retention, effect unmount/remount, clicks and rendered text are exercised. Not DSH native UI, browser network, Windows or device acceptance.' }, null, 2))
} finally { await act(async () => root.unmount()); dom.window.close(); await fs.rm(scratch, { recursive: true, force: true }); stop() }
process.exit(0)
