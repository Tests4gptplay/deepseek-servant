import type { StoragePort } from '../src/contracts/ports.js'
export class MemoryStorage implements StoragePort {
  data = new Map<string, unknown>()
  writes: Array<{ key: string; value: unknown }> = []
  fail?: (key: string, value: unknown) => boolean
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined }
  async set<T>(key: string, value: T): Promise<void> {
    if (this.fail?.(key, value)) throw new Error('Injected storage interruption')
    const copy = JSON.parse(JSON.stringify(value))
    this.data.set(key, copy); this.writes.push({ key, value: copy })
  }
  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return [...this.data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T }))
  }
  async delete(key: string): Promise<void> { this.data.delete(key) }
}
export const taskInput = (id = 'one') => ({
  taskId: id, assistantId: 'assistant', commandId: 'submit-' + id,
  source: { kind: 'user' as const, id: 'user', sessionId: 'source-session', messageId: 'message-' + id },
  workspace: { id: 'workspace', directory: 'C:/isolated-workspace' },
  goal: { request: 'Original complete request', objective: 'Produce the requested result', constraints: [],
    deliverables: ['result.txt'], acceptanceCriteria: ['All required content is present'], sourceRef: 'source-session/message-' + id },
})
