import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantRuntimeProfile } from '../src/domain/model-route.js'
import { AssistantService } from '../src/application/assistant-service.js'
import type { Assistant } from '../src/contracts/assistant.js'
import type { StoragePort } from '../src/contracts/ports.js'

const foreground = { provider: 'foreground-provider', model: 'foreground-model', reasoningEffort: 'high' }
const unrelatedHost = { provider: 'host-provider', model: 'host-model', reasoningEffort: 'low' }
test('background Auto follows the Servant foreground model and reasoning, not the ordinary DSH chat', () => {
  const assistant = { revision: 1, settings: { presetId: 'standard', foreground, background: {} }, autoModel: unrelatedHost } as Assistant
  assert.deepEqual(assistantRuntimeProfile(assistant).foreground, foreground)
  assert.deepEqual(assistantRuntimeProfile(assistant).background, foreground)
  assistant.settings.foreground = { ...foreground, model: 'new-foreground', reasoningEffort: 'max' }
  assert.deepEqual(assistantRuntimeProfile(assistant).background, assistant.settings.foreground)
  assistant.settings.background = { provider: 'independent', model: 'background-only' }
  assert.deepEqual(assistantRuntimeProfile(assistant).background, assistant.settings.background)
})
test('the first concrete foreground choice is saved; later host selections do not replace it', async () => {
  const data = new Map<string, unknown>()
  const store: StoragePort = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set: async (key, value) => { data.set(key, structuredClone(value)) },
    list: async <T>(prefix: string) => [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })),
  }
  const service = new AssistantService({ store,
    defaults: { name: 'Servant', presetId: 'standard', foreground: {}, background: {} },
    resolveWorkspace: async () => ({ id: 'test', directory: 'C:/isolated' }),
    runtime: { send: async () => {}, deliver: async () => {}, hasInput: async () => false, inputs: async () => new Map(), conversation: async () => [] } })
  await service.sendMessage('default', 'one', 'First request', foreground)
  assert.deepEqual((await service.get()).settings.foreground, foreground)
  await service.sendMessage('default', 'two', 'Second request', unrelatedHost)
  const saved = await service.get()
  assert.deepEqual(saved.settings.foreground, foreground)
  assert.deepEqual(saved.inputs.two.runtimeProfile!.background, foreground)
})
