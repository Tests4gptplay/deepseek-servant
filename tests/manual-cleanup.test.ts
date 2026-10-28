import assert from 'node:assert/strict'
import test from 'node:test'
import { ServantApi } from '../src/application/api.js'
import { AssistantService } from '../src/application/assistant-service.js'
import { ServantStore } from '../src/application/servant-store.js'
import { TaskService } from '../src/application/task-service.js'
import { RetentionService } from '../src/application/retention-service.js'
import { GoalSchema, SettingsSchema, ProposalSchema, ReportSchema } from '../src/contracts/schemas.js'
import type { StoragePort } from '../src/contracts/ports.js'
import type { SkillRecord } from '../src/contracts/knowledge.js'

class MemoryStorage implements StoragePort {
  data = new Map<string, unknown>()
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined }
  async set<T>(key: string, value: T) { this.data.set(key, JSON.parse(JSON.stringify(value))) }
  async list<T>(prefix: string) {
    return [...this.data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T }))
  }
  async delete(key: string) { this.data.delete(key) }
}
const now = '2026-10-25T16:15:00.000Z'
const source = { kind: 'user' as const, id: 'owner' }
const goal = { request: 'Original task', objective: 'Result', constraints: [], deliverables: ['out.txt'], acceptanceCriteria: ['Done'], sourceRef: 'owner-input' }
async function fixture(completedRecords = false) {
  const store = new MemoryStorage()
  const tasks = new TaskService(new ServantStore(store), { clock: { now: () => now } })
  for (const id of ['completed', 'cancelled', 'running', 'paused']) {
    const created = await tasks.submit({ taskId: id, assistantId: 'default', commandId: 'submit-' + id, source,
      workspace: { id: 'workspace', directory: 'D:/isolated' }, goal })
    assert.equal(created.status, 'applied')
    if (id === 'completed' || id === 'cancelled') await tasks.execute(id, { type: 'task.control', commandId: 'cancel-' + id, source, intent: 'cancel' })
    if (id === 'paused') await tasks.execute(id, { type: 'task.control', commandId: 'pause-' + id, source, intent: 'pause' })
  }
  // A terminal aggregate snapshot with no outstanding physical execution.
  const completed = (await tasks.get('completed'))!
  completed.phase = 'completed'; completed.control = 'running'; completed.completedAt = now
  completed.delivery = { id: 'delivery', summary: 'Done', artifacts: [], resultIds: [], createdAt: now, status: 'delivered' }
  await tasks.store.putTask(completed)
  const skill = { skillId: 'servant-kept', revision: 1, scope: { assistantId: 'default', workspaceId: 'workspace' },
    activeVersion: 1, versions: [{ version: 1, status: 'active', body: 'Keep the exact skill', sourceResultIds: [], validations: [], feedback: [], uses: [], createdAt: now }], receipts: {} } as unknown as SkillRecord
  await store.set('knowledge/skills/keep', skill)
  await store.set('assistant/default', { settings: { name: 'Keep me' }, exactConversation: 'Keep the conversation' })
  let compacted = 0
  const nativeCalls: string[] = []
  const retention = new RetentionService({ store, tasks, ...(completedRecords ? { completedTasks: tasks } : {}), now: () => now,
    knowledge: { withRetentionLock: async work => work({ listSkills: async () => [skill], compactSkill: async () => { compacted++; throw new Error('Manual cleanup must not compact skills') } }) },
    nativeSessions: { catalog: async ids => ids.map(sessionId => ({ sessionId, liveAgent: false, liveSession: false, archived: true, sizeBytes: 0 })),
      retire: async sessionId => { nativeCalls.push(sessionId); return { sessionId, status: 'archived' as const, logRetained: true, reclaimedBytes: 0 } } },
  })
  return { store, tasks, retention, nativeCalls, compacted: () => compacted }
}

test('manual cleanup works without limits, keeps running/paused tasks and unrelated records, and leaves policy unchanged', async () => {
  const { store, tasks, retention, compacted } = await fixture()
  const keep = await store.list('knowledge/')
  const assistant = await store.get('assistant/default')
  const running = await tasks.get('running'), paused = await tasks.get('paused')
  const automatic = await retention.preview()
  assert.deepEqual(automatic.archiveTasks, [])
  assert.deepEqual((await retention.sweep()).deletedArchives, [])
  const preview = await retention.preview({ manual: true })
  assert.deepEqual(preview.archiveTasks.map(item => item.taskId).sort(), ['cancelled', 'completed'])
  assert.deepEqual(preview.compactSkills, [])
  const result = await retention.sweep({ previewId: preview.previewId, manual: true })
  assert.deepEqual(result.deletedArchives.sort(), ['cancelled', 'completed'])
  assert.deepEqual(result.skipped, [])
  assert.equal((await store.get<{kind:string}>('task:completed'))!.kind, 'task-tombstone')
  assert.equal(await tasks.get('completed'), undefined)
  assert.deepEqual(await tasks.get('running'), running)
  assert.deepEqual(await tasks.get('paused'), paused)
  assert.deepEqual(await store.list('knowledge/'), keep)
  assert.deepEqual(await store.get('assistant/default'), assistant)
  assert.deepEqual((await retention.configuration()).policy, {})
  assert.equal(compacted(), 0)
  assert.equal(result.remaining.manual, true)
})

test('manual cleanup ignores saved retention periods and only acts on confirmed task identities', async () => {
  const { retention, tasks, compacted } = await fixture()
  const preview = await retention.preview({ manual: true })
  const policy = { taskDetailDays: 3650, archiveDays: 36500, skillHistoryDays: 0, maxFullSkillVersions: 0 }
  await retention.configure(policy)
  await tasks.submit({ taskId: 'later', assistantId: 'default', commandId: 'submit-later', source,
    workspace: { id: 'workspace', directory: 'D:/isolated' }, goal })
  await tasks.execute('later', { type: 'task.control', commandId: 'cancel-later', source, intent: 'cancel' })
  const result = await retention.sweep({ previewId: preview.previewId, manual: true })
  assert.deepEqual(result.deletedArchives.sort(), ['cancelled', 'completed'])
  assert.ok(await tasks.get('later'), 'a task created after confirmation preview must remain')
  assert.deepEqual((await retention.configuration()).policy, policy)
  assert.equal(compacted(), 0)
})

test('background previews do not evict the owners pending manual confirmation', async () => {
  const { retention } = await fixture()
  const manual = await retention.preview({ manual: true })
  for (let i = 0; i < 8; i++) await retention.preview()
  const outcome = await retention.sweep({ previewId: manual.previewId, manual: true })
  assert.deepEqual(outcome.deletedArchives.sort(), ['cancelled', 'completed'])
})

test('owner API requires explicit confirmation; a zero-candidate cleanup is allowed', async () => {
  const { retention, tasks } = await fixture()
  const api = new ServantApi({ retention } as never)
  const signal = new AbortController().signal
  const preview = await api.call('retention', { action: 'preview' }, signal) as { previewId: string; manual: boolean }
  assert.equal(preview.manual, true)
  await assert.rejects(api.call('retention', { action: 'sweep', previewId: preview.previewId }, signal), /确认/)
  assert.ok(await tasks.get('completed'))
  await api.call('retention', { action: 'sweep', previewId: preview.previewId, confirmation: 'clear-ended-task-records' }, signal)
  const empty = await api.call('retention', { action: 'preview' }, signal) as { previewId: string }
  const outcome = await api.call('retention', { action: 'sweep', previewId: empty.previewId, confirmation: 'clear-ended-task-records' }, signal) as { deletedArchives: string[] }
  assert.deepEqual(outcome.deletedArchives, [])
})

test('real sealed histories including hidden entries are erased with receipts and identity markers', async () => {
  const { retention, tasks, store } = await fixture(true)
  await tasks.cleanupCompleted('completed')
  await tasks.archives.hide('completed')
  const keepKeys = ['conversations/default/original', 'foreground-memory/default/Foreground_List',
    'foreground-memory/default/Foreground_Cache', 'records/completed-other/content/keep']
  for (const key of keepKeys) await store.set(key, { text: 'Keep this exact value' })
  const active = await tasks.get('running'), paused = await tasks.get('paused')
  const preview = await retention.preview({ manual: true })
  assert.deepEqual(preview.deleteArchives.map(row => row.taskId).sort(), ['cancelled', 'completed'])
  assert.ok(preview.totals.estimatedReclaimedBytes > 0)
  const before = (await retention.stats()).totalBytes
  const result = await retention.sweep({ previewId: preview.previewId })
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.deletedArchives.sort(), ['cancelled', 'completed'])
  assert.equal(result.reclaimedServantBytes, before - (await retention.stats()).totalBytes)
  for (const id of result.deletedArchives) {
    assert.equal(await tasks.archives.index(id), undefined)
    for (const prefix of ['records/', 'record-archive/', 'task-origin/', 'planner-memory/', 'planner-note/', 'worker-reply/', 'task-runtime/', 'task-staging/'])
      assert.deepEqual(await store.list(prefix + id + '/'), [])
    assert.equal(await store.get('task:' + id), undefined)
    assert.equal((await tasks.execute(id, { type: 'task.control', commandId: 'late-' + id, source, intent: 'cancel' })).code, 'TASK_NOT_FOUND')
  }
  assert.deepEqual(await tasks.get('running'), active)
  assert.deepEqual(await tasks.get('paused'), paused)
  for (const key of keepKeys) assert.deepEqual(await store.get(key), { text: 'Keep this exact value' })
  assert.deepEqual((await retention.preview({ manual: true })).deleteArchives, [])
})

test('manual cleanup removes legacy orphan markers and delivery receipts but keeps runtime settings', async () => {
  const { retention, store } = await fixture(true)
  const marker = { schemaVersion: 1, kind: 'task-tombstone', id: 'old-cleaned', assistantId: 'default',
    workspaceId: 'workspace', revision: 6, retiredAt: now }
  await store.set('task:old-cleaned', marker)
  await store.set('assistant-history/default/delivery/old', { taskId: marker.id, status: 'sent' })
  await store.set('settings/runtime', { workerSeats: 2 })
  const result = await retention.sweep({ manual: true })
  assert.deepEqual(result.skipped, [])
  assert.ok(result.deletedArchives.includes(marker.id))
  assert.equal(await store.get('task:old-cleaned'), undefined)
  assert.equal(await store.get('assistant-history/default/delivery/old'), undefined)
  assert.deepEqual(await store.get('settings/runtime'), { workerSeats: 2 })
  assert.equal((await retention.stats()).permanent.archiveBytes, 0)
  assert.deepEqual((await retention.preview({ manual: true })).deleteArchives, [])
})

test('an interrupted explicit history deletion resumes from its saved deletion marker', async () => {
  const { retention, tasks, store } = await fixture(true)
  await tasks.cleanupCompleted('completed')
  const remove = store.delete.bind(store)
  store.delete = async key => { if (key.startsWith('records/completed/')) throw new Error('Interrupted deletion'); await remove(key) }
  const preview = await retention.preview({ manual: true })
  const result = await retention.sweep({ previewId: preview.previewId })
  assert.ok(result.skipped.some(row => row.id === 'completed'))
  assert.equal((await tasks.archives.index('completed'))?.deleting, true)
  store.delete = remove
  await tasks.archives.resumeCleanup()
  assert.equal(await tasks.archives.index('completed'), undefined)
  assert.deepEqual(await store.list('records/completed/'), [])
  assert.ok(await tasks.get('running'))
})

test('long text, names, task lists, skill bodies and evidence survive validation and message delivery exactly', async () => {
  const text = '  原文🧭\n'.repeat(20000) + '  tail  '
  const settings = SettingsSchema.parse({ name: '助理'.repeat(600), userName: '  用户'.repeat(600) + '  ', presetId: 'default', foreground: { provider: 'test', model: 'test' }, background: {} })
  assert.equal(settings.userName, '  用户'.repeat(600) + '  ')
  assert.equal(GoalSchema.parse({ ...goal, request: text, constraints: Array(150).fill(text.slice(0, 10)) }).request, text)
  assert.equal(ProposalSchema.parse({ skillId: 'skill', title: '标题'.repeat(600), description: text, body: text, applicability: text, resultId: 'result', explanation: text, artifactRefs: [] }).body, text)
  assert.equal(ReportSchema.parse({ resultId: 'result', assignmentVersion: 1, outcome: 'progress', summary: text, artifacts: [], evidence: Array(150).fill(text.slice(0, 10)), frontier: text }).summary, text)
  const store = new MemoryStorage()
  const delivered: string[] = []
  const assistants = new AssistantService({ store, defaults: settings, resolveWorkspace: async () => ({ id: 'workspace', directory: 'D:/isolated' }),
    runtime: { send: async (_assistant, message) => { delivered.push(message) }, hasInput: async () => false, inputs: async () => new Map(), conversation: async () => [], deliver: async () => {} } })
  const api = new ServantApi({ assistants } as never)
  await api.call('send', { messageId: 'long-input', text }, new AbortController().signal)
  assert.deepEqual(delivered, [text])
  assert.equal((await assistants.userInput('default', 'long-input'))!.text, text)
})
