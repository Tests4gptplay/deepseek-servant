import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { JSDOM } from 'jsdom'
import { Context } from '@deepseek-ai/cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'

await mkdir('.validation/model-settings', { recursive: true })
// A read-only red control loads the two original failing sources, without
// replacing the working tree. Pin the diagnosed candidate, not a moving HEAD.
const plugins = process.argv.includes('--baseline') ? [{ name: 'candidate9-red-control', setup(build) {
  build.onLoad({ filter: /src\/experimental\/private-git\/(?:service\.ts|client\/page\.tsx)$/ }, args => {
    const file = args.path.slice(process.cwd().length + 1)
    return { contents: execFileSync('git', ['show', 'c9f3253f9f7ad3a3f9c16971e112eb5c70eddf8b:' + file], { encoding: 'utf8' }), loader: file.endsWith('tsx') ? 'tsx' : 'ts' }
  })
} }] : []
await build({ stdin: { contents: `export { CoopPage } from './src/experimental/private-git/client/page.tsx'; export { ModelPicker } from './src/client/model-picker.tsx'; export { ModeClient } from './src/mode-router/client.ts'; export { modeZh, modeEn } from './src/mode-router/locales.ts';`, resolveDir: process.cwd(), loader: 'tsx' },
  plugins, outfile: '.validation/model-settings/ui.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' } })
await build({ stdin: { contents: `export { CoopService } from './src/experimental/private-git/service.ts'; export { CoopCache } from './src/experimental/private-git/cache.ts'; export { CoopSettingsSchema } from './src/experimental/private-git/contracts.ts'; export { GitHubClient } from './src/experimental/private-git/github.ts';`, resolveDir: process.cwd() },
  plugins, outfile: '.validation/model-settings/service.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'])
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true })
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
const React = await import('react'), { act } = React, { createRoot } = await import('react-dom/client')
const { CoopPage, ModelPicker, ModeClient, modeZh, modeEn } = await import('../.validation/model-settings/ui.mjs')
const { CoopService, CoopCache, CoopSettingsSchema, GitHubClient } = await import('../.validation/model-settings/service.mjs')
const storageRoot = await mkdtemp(join(tmpdir(), 'dss-model-settings-'))
const defaultModel = { provider: 'fixture', model: 'host-model', reasoningEffort: 'high' }
const original = { provider: 'fixture', model: 'old-model', reasoningEffort: 'low' }
const roundtrip = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const requests = []
let backend, facility, cache, service, client, root
async function open() {
  const ctx = new Context(), storage = new Storage(ctx)
  backend = new JsonStorageBackend(storageRoot)
  storage.backend.register('json', backend)
  facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  cache = await CoopCache.open(ctx)
  service = new CoopService(cache, { resolve: async () => { throw new Error('test must not resolve credentials') } }, new GitHubClient(async () => { throw new Error('test must not access GitHub') }), () => defaultModel)
  client = new ModeClient(async (method, raw) => {
    // Native transport is JSON. Both directions intentionally cross it.
    const input = roundtrip(raw)
    if (method === 'selection') return { activeMode: 'PRIVATE_GIT_EXPERIMENTAL' }
    assert.equal(method, 'call')
    if (input.method === 'configure') requests.push(input.params)
    return roundtrip(await service.call(input.method, input.params))
  }, listener => service.subscribe(listener))
}
const modelCatalog = { current: defaultModel, status: 'ready', error: null, failures: [], groups: [
  { id: 'fixture', name: 'Fixture', models: [
    { id: 'old-model', name: 'Old model', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }] } },
    { id: 'host-model', name: 'Host model', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } },
  ] }, { id: 'other', name: 'Other provider', models: [{ id: 'plain-model', name: 'Plain model' }] },
] }
const controls = {
  model: (value, onChange, disabled) => React.createElement(ModelPicker, { value, onChange, disabled, models: modelCatalog, autoLabel: modeZh.autoModel, autoHint: modeZh.autoModelHint, onRefresh: async () => {}, t: key => key, label: modeZh.model }),
  preset: value => React.createElement('span', null, value),
}
const buttons = () => [...document.querySelectorAll('button')]
const button = text => { const result = buttons().find(item => item.textContent === text); assert.ok(result, `button ${text}`); return result }
async function click(element) { await act(async () => { element.click(); await tick() }) }
async function settle() { await act(async () => { await client.refresh(); await tick() }) }
async function mount() { root = createRoot(document.getElementById('root')); await act(async () => { root.render(React.createElement(CoopPage, { client, controls, settingsOnly: true, t: key => modeZh[key] })); await tick() }); await settle() }
async function unmount() { await act(async () => { root.unmount(); await tick() }) }
async function choose(name) {
  await click(document.querySelector('button[aria-label="模型"]'))
  const option = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find(item => item.textContent.startsWith(name))
  assert.ok(option, `model option ${name}`)
  await click(option)
}
async function save() {
  await click(button(modeZh.save))
  for (let i = 0; i < 200 && button(modeZh.save).disabled; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  await settle()
  assert.equal(button(modeZh.save).disabled, false, 'save finished')
  assert.ok(document.body.textContent.includes(modeZh.saved), document.body.textContent)
}
function route(settings) { return roundtrip({ provider: settings.provider, model: settings.model, reasoningEffort: settings.reasoningEffort }) }
async function persisted() { return JSON.parse(await readFile(join(storageRoot, 'deepseek_servant_coop', 'global.json'), 'utf8')) }
async function close() { client.dispose(); await service.dispose(); await facility.closeAll(); await backend.close() }
try {
  await open()
  assert.deepEqual(route(cache.settings), {}, 'new installation starts in Auto')
  await service.configure(original)
  await mount()
  await choose(modeZh.autoModel)
  await save()
  assert.deepEqual(route(cache.settings), {}, 'Auto cleared the real CoopCache')
  assert.deepEqual(requests.at(-1).provider, null)
  assert.equal(requests.at(-1).model, null)
  assert.equal(requests.at(-1).reasoningEffort, null)
  assert.deepEqual(route(cache.settings), {}, 'Auto cleared the real CoopCache')
  assert.deepEqual(route((await persisted()).record.settings), {}, 'native JSON storage contains no model override')
  await unmount(); await mount()
  assert.match(document.querySelector('button[aria-label="模型"]').textContent, /^Auto · Host model · High/)
  await unmount(); await close(); await open(); await mount()
  assert.deepEqual(route(cache.settings), {}, 'new service/cache/backend instance reads persisted Auto')
  await choose('Old model'); await save()
  assert.deepEqual(route(cache.settings), original, 'explicit route saves successfully')
  await choose('Plain model'); await save()
  assert.deepEqual(route(cache.settings), { provider: 'other', model: 'plain-model' }, 'provider switch clears unsupported old effort')
  assert.equal(requests.at(-1).reasoningEffort, null)
  await act(async () => { await client.call('configure', { workerSeats: 3 }); await client.refresh() })
  assert.deepEqual(route(cache.settings), { provider: 'other', model: 'plain-model' }, 'unrelated partial update preserves route')
  await unmount(); await close(); await open(); await mount()
  assert.deepEqual(route(cache.settings), { provider: 'other', model: 'plain-model' }, 'explicit route survives restart')
  assert.equal(cache.settings.workerSeats, 3)
  await choose(modeZh.autoModel); await save(); await save()
  assert.deepEqual(route(cache.settings), {}, 'repeated Auto save is stable')
  assert.equal(modeZh.model, '模型'); assert.equal(modeEn.model, 'Model')
  assert.equal(modeEn.autoModel, 'Auto / Follow host')
  assert.equal(CoopSettingsSchema.parse({}).model, undefined)
  console.log('PASS: real React CoopPage + ModelPicker, ModeClient JSON transport boundary, real CoopService + CoopCache + native DomainFacility/JsonStorageBackend persistence; explicit→Auto→save→reopen→new service readback; explicit save; provider switch clears effort; unrelated partial save preserves route; repeated save; zh/en labels. No model, GitHub, user machine or credentials used.')
  console.log('Isolated native storage evidence:', storageRoot)
} finally { if (root) await unmount(); if (service) await close(); dom.window.close() }
