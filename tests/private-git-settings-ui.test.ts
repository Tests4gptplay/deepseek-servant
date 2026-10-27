import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { CoopPage } from '../src/experimental/private-git/client/page.js'
import { CoopSettingsSchema, type CoopView } from '../src/experimental/private-git/contracts.js'
import { GITHUB_CLI_SETUP_REQUIRED } from '../src/experimental/private-git/github.js'
import { modeZh } from '../src/mode-router/locales.js'
import type { ModeClient } from '../src/mode-router/client.js'

test('settings omit authorization controls and show actionable CLI failure above the form', async t => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const host = dom.window.document.getElementById('root')!
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  })
  const view: CoopView = { settings: CoopSettingsSchema.parse({ ownerRepo: 'example/private' }), instanceId: 'fixture', status: 'unconfigured', error: GITHUB_CLI_SETUP_REQUIRED, pending: [], messages: [], tasks: [] }
  const snapshot = { ready: true, activeMode: 'PRIVATE_GIT_EXPERIMENTAL', view }
  const calls: string[] = []
  const client = {
    subscribe: () => () => {}, snapshot: () => snapshot, loadCoop: async () => {}, refresh: async () => {},
    call: async (method: string) => { calls.push(method) },
  } as unknown as ModeClient
  await act(async () => root.render(createElement(CoopPage, { client, t: key => modeZh[key], settingsOnly: true })))
  assert.equal(host.textContent?.includes('GitHub 授权来源'), false)
  assert.equal(host.textContent?.includes('已保存授权优先'), false)
  assert.equal(host.textContent?.includes('未配置存储凭据'), false)
  const alert = host.querySelector('[role="alert"]')!
  assert.ok(alert.textContent?.includes('请配置 GitHub CLI'))
  assert.ok(alert.compareDocumentPosition(host.querySelector('input')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING)
  await act(async () => (alert.querySelector('button') as HTMLButtonElement).click())
  assert.deepEqual(calls, ['configure', 'connect'])
})
