import test from 'node:test'
import assert from 'node:assert/strict'
import { AssistantService } from '../src/application/assistant-service.js'
import { installRoleTools } from '../src/roles/tools.js'
import { foregroundMemoryGuide } from '../src/contracts/foreground-memory.js'
import { MemoryStorage } from './support.js'

test('local foreground notes survive fresh services, stay out of prompt bodies and freely replace or delete', async () => {
  const store = new MemoryStorage()
  const options = { store, defaults: { name: 'Servant', presetId: 'standard', foreground: {}, background: {} }, runtime: {} as any, resolveWorkspace: async () => ({ id: 'workspace', directory: process.cwd() }) }
  const service = new AssistantService(options)
  const text = 'Private ongoing conversation. '.repeat(10_000)
  await service.foregroundMemory('default', 'Foreground_Cache', text)
  await service.foregroundMemory('default', 'Foreground_List', 'Important pending task; source: original-message; task: one.')
  const fresh = new AssistantService(options)
  assert.equal((await fresh.foregroundMemory('default', 'Foreground_Cache') as any).text, text)
  const sections: string[] = [], definitions = new Map<string, any>()
  const agent = { id: 'foreground', session: { snapshotEvents: () => [] } } as any
  installRoleTools({ systemPrompt: { section: (item: any) => sections.push(item.text) }, tools: { register: (item: any) => definitions.set(item.name, item) } } as any,
    agent, { role: 'foreground', assistantId: 'default', sessionId: 'session' }, { assistants: fresh } as any)
  assert.ok(sections.join('\n').includes('foreground-memory/default/Foreground_List'))
  assert.ok(!sections.join('\n').includes('Private ongoing conversation'))
  const invoke = (input: unknown) => definitions.get('foreground_memory').execute(input, { agent, signal: new AbortController().signal, callId: 'one' })
  await invoke({ action: 'replace', document: 'Foreground_Cache', text: 'Only current topic remains.' })
  assert.equal((await invoke({ action: 'read', document: 'Foreground_Cache' })).text, 'Only current topic remains.')
  await invoke({ action: 'clear', document: 'Foreground_Cache' })
  await invoke({ action: 'clear', document: 'Foreground_List' })
  assert.equal((await invoke({ action: 'read', document: 'Foreground_Cache' })).exists, false)
  assert.equal((await store.list('foreground-memory/')).length, 0)
})

test('foreground notes persist by default with requested cleanup and scheduled conversational review', () => {
  const text = foregroundMemoryGuide('list-ref', 'cache-ref', 'Read via tools.')
  for (const phrase of ['Keep completed items', '7 days', '30 days', 'user-specified', 'reminder alone does not reset',
    'Keep memory by default', 'only when the user requests cleanup', 'no word or character quota', 'body is not preloaded']) assert.ok(text.includes(phrase), phrase)
})
