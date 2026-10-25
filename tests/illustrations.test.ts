import assert from 'node:assert/strict'
import test from 'node:test'
import { illustrationFor, showCornerIllustration } from '../src/client/illustrations.js'
import { SettingsSchema } from '../src/contracts/schemas.js'
import { AssistantService } from '../src/application/assistant-service.js'
import type { StoragePort } from '../src/contracts/ports.js'

class Store implements StoragePort {
  rows = new Map<string, unknown>()
  async get<T>(key: string) { return structuredClone(this.rows.get(key)) as T | undefined }
  async set<T>(key: string, value: T) { this.rows.set(key, structuredClone(value)) }
  async list<T>(prefix: string) { return [...this.rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })) }
}
const defaults = { name: 'Servant', presetId: 'default', foreground: {}, background: {} }
test('shared defaults, hide only the corner, and swap both artwork positions', () => {
  assert.equal(illustrationFor('conversation', {}), 'welcome')
  assert.equal(illustrationFor('tasks', {}), 'task')
  for (const hasContent of [false, true]) for (const visible of [false, true]) for (const swap of [false, true]) {
    const settings = { showCornerCharacter: visible, swapPageIllustrations: swap }
    assert.equal(showCornerIllustration(hasContent, settings), hasContent && visible)
    assert.equal(illustrationFor('conversation', settings), swap ? 'task' : 'welcome')
    assert.equal(illustrationFor('tasks', settings), swap ? 'welcome' : 'task')
  }
  assert.equal(showCornerIllustration(true, {}), true)
  assert.deepEqual(SettingsSchema.parse(defaults), defaults)
})
test('both preferences persist across service restart without rotating an active foreground', async () => {
  const store = new Store()
  let rotations = 0
  const options = { store, defaults, resolveWorkspace: async () => ({ id: 'test-workspace', directory: 'C:/isolated' }),
    runtime: { send: async () => {}, hasInput: async () => false, inputs: async () => new Map(), conversation: async () => [], deliver: async () => {},
      prepareConfiguration: async () => { rotations++; throw new Error('Appearance must not rotate the foreground') } } }
  const first = new AssistantService(options), original = await first.get()
  const settings = SettingsSchema.parse({ ...original.settings, showCornerCharacter: false, swapPageIllustrations: true })
  await first.configure(original.id, { expectedRevision: original.revision, settings })
  const loaded = await new AssistantService(options).get()
  assert.deepEqual(loaded.settings, settings)
  assert.equal(loaded.sessionId, original.sessionId)
  assert.deepEqual(loaded.priorSessionIds, original.priorSessionIds)
  assert.deepEqual(loaded.inputs, original.inputs)
  assert.equal(rotations, 0)
})

test('optional user name persists, can be cleared, and preserves the foreground session', async () => {
  const store = new Store()
  const options = { store, defaults, resolveWorkspace: async () => ({ id: 'test-workspace', directory: 'C:/isolated' }),
    runtime: { send: async () => {}, hasInput: async () => false, inputs: async () => new Map(), conversation: async () => [], deliver: async () => {},
      prepareConfiguration: async () => { throw new Error('A display name must not rotate the foreground') } } }
  const service = new AssistantService(options), initial = await service.get()
  const named = await service.configure(initial.id, { expectedRevision: initial.revision,
    settings: SettingsSchema.parse({ ...initial.settings, userName: '星客' }) })
  assert.equal((await new AssistantService(options).get()).settings.userName, '星客')
  const cleared = await service.configure(named.id, { expectedRevision: named.revision,
    settings: SettingsSchema.parse({ ...named.settings, userName: '' }) })
  assert.equal((await new AssistantService(options).get()).settings.userName, '')
  assert.equal(cleared.sessionId, initial.sessionId)
})

