import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'

// Controlled native admission/storage boundary. The copied methods below are
// extracted verbatim from the source under test, not alternate implementations
// of source lookup or signal consumption. Existing RoleRecord-shaped facts are
// persisted to fixture files before actual consumeWakeSignals deletes a signal.
export async function physicalReceiver(files, member = 'A', loaded = new Map()) {
  const { PhysicalLocalFiles } = await import('../../src/framework/physical-local-files.ts')
  const { withSnapshot } = await import('../../src/framework/transactions.ts')
  const { assertTaskLifecycle } = await import('../../src/framework/task-files.ts')
  const { parseDirectSignal, signalWorkerId } = await import('../../src/framework/role-tools.ts')
  const { FrameworkConversation, localForegroundRoleRecordPath } = await import('../../src/framework/conversation.ts')
  const source = readFileSync(new URL('../../src/framework/role-runtime.ts', import.meta.url), 'utf8')
  const hash = value => createHash('sha256').update(value).digest('hex')
  loaded.set('framework/role-runtime.ts', hash(source))
  const js = stripTypeScriptTypes(source, { mode: 'transform' })
  const method = name => {
    const match = new RegExp('\\n    (?:async )?' + name + '\\(').exec(js)
    assert(match, name)
    const start = match.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start + match[0].length))
    assert(next, name)
    return js.slice(start, start + match[0].length + next.index)
  }
  const deps = { PhysicalLocalFiles, withSnapshot, assertTaskLifecycle, parseDirectSignal, signalWorkerId, hash, localForegroundRoleRecordPath, GitAuthorityStore: class {} }
  const Runtime = new Function(...Object.keys(deps), 'return class {\n' + ['roleKey', 'roleRecordPath', 'physicalSignalSources', 'assertOrganizerBusiness', 'addressedSignals', 'consumeWakeSignals', 'taskNoticeState', 'taskNoticeConsumption'].map(method).join('\n') + '\n}')(...Object.values(deps))
  const runtime = new Runtime(), gets = []
  Object.assign(runtime, { files, conversation: new FrameworkConversation(files, {}, { mode: 'local', collaborationId: 'fixture' }), prefix: '.test-runtime/' + member + '/', config: { member, primary: true }, closed: false,
    roleRecords: new Map(), wakeConsumptions: new Map(), forgetForegroundNotices() {},
    native: { get() {} }, taskNotices: new WeakMap(), taskNoticeClock: 0,
    records: {
      async get(key) { gets.push(key); return withSnapshot(files, async s => { const text = await files.read(s, key + '.json'); return text === undefined ? undefined : JSON.parse(text) }) },
      async set(key, value) { await files.replace(key + '.json', JSON.stringify(value)) },
      async list() { throw Error('Exact publication evidence must not scan runtime records') }
    }
  })
  return {
    runtime, gets, sources: p => runtime.physicalSignalSources(p),
    async accept(path, { role, taskId, lifecycleId, workerId, consume = true } = {}) {
      const parts = path.split('/'), name = parts.at(-1)
      role ??= name.startsWith('Foreground_') ? 'Foreground' : name.split('_')[0]
      taskId ??= role === 'Foreground' ? undefined : parts[2]
      workerId ??= role === 'Worker' ? signalWorkerId(name) : undefined
      const info = await files.fileInfo(path); assert(info, 'Only a published physical signal can be accepted')
      const workId = runtime.roleKey(role, taskId, workerId), executionId = 'fixture-execution:' + hash(workId)
      const identity = { workId, executionId, role, member, ...(taskId ? { taskId } : {}), ...(lifecycleId ? { lifecycleId } : {}), ...(workerId ? { workerId } : {}) }
      const record = { identity, lastWake: { id: 'fixture-wake:' + info.version, role, ...(taskId ? { taskId } : {}), sources: [{ path, version: info.version }] } }
      await runtime.records.set(runtime.prefix + 'roles/' + hash(workId), record)
      runtime.roleRecords.set(workId, record)
      if (consume) await runtime.consumeWakeSignals(identity)
      return record
    }
  }
}
