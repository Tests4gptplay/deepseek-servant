import { FrameworkCleaner, CleanupMaterialsChangedError, captureCleanupInputs, type RetentionManifest } from '../src/framework/cleaner.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot, FilesOutcomeUnknownError } from '../src/framework/transactions.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { initializeTask, paths, readJson, type TaskMetadata } from '../src/framework/task-files.js'
import { installFrameworkRoleTools, workerPaths, workerWakeSignal, signalWorkerId, buildDirectSignal, parseDirectSignal, type FrameworkRoleBinding, type FrameworkRoleServices } from '../src/framework/role-tools.js'
import { frameworkRolePrompt } from '../src/framework/role-prompts.js'
import type { RecoveryRole } from '../src/framework/recovery.js'

// Real LocalFiles and command transactions, isolated native registration/caller boundary.
// These tests do not claim a real model turn or complete Host installation.
async function fixture(t: test.TestContext, role: RecoveryRole, extras: Partial<FrameworkRoleBinding> = {}, route: 'P' | 'O' = 'P', configure?: (services: FrameworkRoleServices, transactions: FrameworkTransactions) => void) {
  const root = await mkdtemp(join(tmpdir(), 'dss-role-tools-')), files = await LocalFiles.open(root)
  const data = new Map<string, unknown>(), definitions = new Map<string, any>(), prompts: string[] = [], effects: Array<() => Promise<void>> = []
  const events = new Map<string, (...args: any[]) => void>()
  const records = { get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => { data.set(key, value) },
    list: async <T>(prefix: string) => [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: value as T })) }
  const transactions = new FrameworkTransactions(files, records, 'test-scope')
  let sequence = 0, concluded = 0, recoveryCallbacks = 0
  const sourcePath = 'tasks/example_' + route + '.md'
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: sourcePath, content: 'Complete the actual requirement' }], 'submit'))
  const task = await withSnapshot(files, async snapshot => {
    const plan = await initializeTask(files, snapshot, sourcePath, 'A', ['B'])
    await files.commit(snapshot, plan.changes, 'init'); return plan.value
  })
  const binding: FrameworkRoleBinding = { workId: role, executionId: 'execution-1', role, owner: 'A',
    ...(['Planner', 'Worker', 'Recorder'].includes(role) ? { taskId: task.taskId } : {}),
    ...(['Planner', 'Worker'].includes(role) ? { member: 'A' } : {}), ...extras }
  const agent = { id: 'agent', session: {} } as Agent
  const services: FrameworkRoleServices = {
    files, transact: (id, request, options, build) => transactions.run(id, request, options, build),
    notifications: async (snapshot, bound, selected) => {
      const taskId = bound.taskId ?? selected
      if (bound.direct) return await files.read(snapshot, bound.direct.signalPath) === undefined ? [] : [bound.direct.signalPath]
      if (bound.role === 'Foreground') return (await files.listDirectory(snapshot, 'state')).filter(entry => entry.path.split('/').at(-1)!.startsWith('Foreground_')).map(entry => entry.path)
      if (!taskId) return []
      if (bound.role === 'Organizer') return (await files.list(snapshot, 'state')).filter(entry => entry.path.endsWith('/' + taskId + '/complete') || entry.path.endsWith('/' + taskId + '/Organizer_Task')).map(entry => entry.path)
      return (await files.listDirectory(snapshot, paths.state(bound.member ?? bound.owner, taskId)))
        .filter(entry => entry.path.split('/').at(-1)!.startsWith(bound.role + '_')).map(entry => entry.path)
    },
    afterRecoveryConsumed: async () => { recoveryCallbacks++ }, onError: error => { throw error },
  }
  const ctx = { tools: { register: (tool: any) => definitions.set(tool.name, tool) },
    systemPrompt: { section: ({ text }: { text: string }) => prompts.push(text) },
    on: (name: string, handler: (...args: any[]) => void) => { events.set(name, handler); return () => { events.delete(name) } },
    effect: (factory: () => () => Promise<void>) => effects.push(factory()),
  } as unknown as Context
  configure?.(services, transactions)
  installFrameworkRoleTools(ctx, agent, binding, services)
  t.after(async () => { for (const effect of effects) await effect(); await files.close(); await rm(root, { recursive: true, force: true }) })
  const call = async (name: string, input: unknown, id = 'call-' + ++sequence, subject = agent) => {
    const definition = definitions.get(name); assert.ok(definition, 'registered ' + name)
    return definition.execute(input, { agent: subject, callId: id, signal: new AbortController().signal, concludeTurn: () => { concluded++ } })
  }
  const snapshot = async () => call('dss_snapshot', { taskId: task.taskId })
  return { files, task, binding, agent, services, definitions, prompts, events, call, snapshot, counts: () => ({ concluded, recoveryCallbacks }) }
}

test('all six scoped prompts are substantive and unavailable optional capabilities are not advertised as tools', async t => {
  for (const role of ['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper'] as const) {
    assert.ok(frameworkRolePrompt(role).includes(role === 'Helper' ? 'diagnose' : role))
    assert.ok(!frameworkRolePrompt(role).includes('TODO'))
  }
  const f = await fixture(t, 'Foreground')
  assert.ok(!f.definitions.has('dss_conversation_send'))
  assert.ok(!f.definitions.has('dss_restore'))
  assert.ok(!f.prompts.join('\n').includes('Do not call create_goal'))
  await assert.rejects(f.call('dss_snapshot', {}, 'foreign', { id: 'another' } as Agent), /scoped Agent/)
})
test('Foreground submission writes only the common task, without an Inbox signal or initialized tree', async t => {
  const f = await fixture(t, 'Foreground'), view = await f.snapshot()
  await f.call('dss_submit_task', { snapshotId: view.snapshotId, name: 'new', route: 'O', text: '# Original\nBody' })
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, 'tasks/new_O.md'), '# Original\nBody')
    assert.deepEqual(await f.files.list(snapshot, 'state'), [])
    assert.equal((await f.files.listDirectory(snapshot, 'tasks')).filter(entry => entry.path.endsWith('.json')).length, 1)
  })
})
test('native command replay after snapshot release returns receipt without appending record twice', async t => {
  const f = await fixture(t, 'Planner'), view = await f.snapshot()
  const input = { snapshotId: view.snapshotId, path: paths.member(f.task.taskId, 'A') + '/Planner_Memory.md', text: 'fact\n' }
  await f.call('dss_record', input, 'same-native-call')
  const replay = await f.call('dss_record', input, 'same-native-call')
  assert.equal(replay.replay, true)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, input.path), 'fact\n'))
})
test('ordinary claim preserves recovery and atomically writes the takeover record', async t => {
  const f = await fixture(t, 'Planner'), state = paths.state('A', f.task.taskId)
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: state + '/Planner_Worker', content: '' }, { path: state + '/recovery', content: '' },
  ], 'notify'))
  const view = await f.snapshot(), memory = paths.member(f.task.taskId, 'A') + '/Planner_Memory.md'
  await f.call('dss_claim', { snapshotId: view.snapshotId, signals: [state + '/Planner_Worker'], recordPath: memory, text: 'Take over result\n' })
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, state + '/Planner_Worker'), undefined)
    assert.equal(await f.files.read(snapshot, state + '/recovery'), '')
    assert.equal(await f.files.read(snapshot, memory), 'Take over result\n')
  })
})
test('only Planner gets recovery consumption and callback follows committed marker deletion', async t => {
  const f = await fixture(t, 'Planner'), state = paths.state('A', f.task.taskId)
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: state + '/recovery', content: '' }], 'recover'))
  const view = await f.snapshot()
  await f.call('dss_recovery_consume', { snapshotId: view.snapshotId, continuation: 'Normal return reached this Planner\n' })
  assert.equal(f.counts().recoveryCallbacks, 1)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, state + '/recovery'), undefined))
  const worker = await fixture(t, 'Worker', { workerId: 'one' })
  assert.ok(!worker.definitions.has('dss_recovery_consume'))
})
test('Worker delivery appends the long result and clears notes only with the notification transaction', async t => {
  const f = await fixture(t, 'Worker', { workerId: 'child-1', generation: 2 }), worker = workerPaths(f.task.taskId, 'A', 'child-1')
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: worker.notes, content: 'Active round findings' }, { path: worker.reply, content: 'Older round\n' },
  ], 'records'))
  const view = await f.snapshot()
  await f.call('dss_worker_deliver', { snapshotId: view.snapshotId, reply: 'New verified result\n' })
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, worker.notes), '')
    assert.equal(await f.files.read(snapshot, worker.reply), 'Older round\nNew verified result\n')
    assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Planner_child-1-Worker-G2'), '')
  })
  assert.equal(f.counts().concluded, 1)
})
test('late notification after a checked snapshot defeats total completion CAS', async t => {
  const f = await fixture(t, 'Planner'), view = await f.snapshot()
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: paths.state('A', f.task.taskId) + '/Planner_Later', content: '' }], 'late'))
  await assert.rejects(f.call('dss_complete', { snapshotId: view.snapshotId, acceptance: 'reviewed', resultPaths: [] }), /Storage changed/)
  await withSnapshot(f.files, async snapshot => assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(f.task.taskId)))?.status, 'running'))
  const next = await f.snapshot()
  await assert.rejects(f.call('dss_complete', { snapshotId: next.snapshotId, acceptance: 'reviewed', resultPaths: [] }), /Pending notifications/)
})
test('direct short Worker delivers without building an ordinary task/member tree', async t => {
  const direct = { inputPath: 'direct/input.md', signalPath: 'state/Worker_Direct_1', resultPath: 'direct/result.md', recipientSignal: 'state/Foreground_Recipient-Time' }
  const f = await fixture(t, 'Worker', { taskId: undefined, member: undefined, workerId: undefined, direct })
  const view = await f.call('dss_snapshot', {})
  await f.call('dss_direct_deliver', { snapshotId: view.snapshotId, text: 'Short task result' })
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, direct.resultPath), 'Short task result')
    assert.equal(await f.files.read(snapshot, direct.recipientSignal), '')
  })
})
test('Recorder saves AI-authored output and verifies it before Cleaner, without waiting for Foreground', async t => {
  const f = await fixture(t, 'Recorder'), archive = paths.archive(f.task.taskId) + '/records.md'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) }], 'complete'))
  const view = await f.snapshot()
  await f.call('dss_recorder_save', { snapshotId: view.snapshotId, outputs: [{ path: archive, text: 'AI summary of actual work' }] })
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, archive), 'AI summary of actual work')
    assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Cleaner'), '')
  })
})
test('Recorder cannot read unrelated originals outside Cache links or finalize a running task', async t => {
  const f = await fixture(t, 'Recorder'), view = await f.snapshot()
  await assert.rejects(f.call('dss_read', { snapshotId: view.snapshotId, path: 'task-runs/another/secret.md' }), /Cache links/)
  await assert.rejects(f.call('dss_recorder_save', { snapshotId: view.snapshotId,
    outputs: [{ path: paths.archive(f.task.taskId) + '/records.md', text: 'premature' }] }), /globally complete/)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Cleaner'), undefined))
})
test('snapshot resources are released at native turn end and child signal encoding round-trips', async t => {
  const f = await fixture(t, 'Planner'), view = await f.snapshot()
  f.events.get('session/event')!(f.agent.session, { type: 'turn/end' })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.call('dss_read', { snapshotId: view.snapshotId, path: f.task.sourcePath }), /released/)
  assert.equal(signalWorkerId(workerWakeSignal('child_with spaces-中文')), 'child_with spaces-中文')
})

test('Worker cannot claim into long Reply instead of current-round notes', async t => {
  const f = await fixture(t, 'Worker', { workerId: 'child' }), worker = workerPaths(f.task.taskId, 'A', 'child')
  const signal = paths.state('A', f.task.taskId) + '/' + workerWakeSignal('child')
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: signal, content: '' }], 'notify'))
  const view = await f.snapshot()
  await assert.rejects(f.call('dss_claim', { snapshotId: view.snapshotId, signals: [signal], recordPath: worker.reply, text: 'claimed' }), /continuation record/)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, signal), '')
    assert.equal(await f.files.read(snapshot, worker.reply), undefined)
  })
})
test('Recorder retains saved output but does not signal Cleaner when retained evidence cannot be read', async t => {
  const f = await fixture(t, 'Recorder'), archive = paths.archive(f.task.taskId) + '/records.md'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) }], 'complete'))
  const view = await f.snapshot()
  await assert.rejects(f.call('dss_recorder_save', { snapshotId: view.snapshotId, outputs: [{ path: archive, text: 'Actual records' }], retainedPaths: ['missing/evidence.md'] }), /not accessible/)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, archive), 'Actual records')
    assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Cleaner'), undefined)
  })
  assert.equal(f.counts().concluded, 0)
})
test('Recorder cannot substitute only a skill for the Task records', async t => {
  const f = await fixture(t, 'Recorder'), view = await f.snapshot()
  await assert.rejects(f.call('dss_recorder_save', { snapshotId: view.snapshotId, outputs: [{ path: 'skills/example.md', text: 'method' }] }), /Task records/)
})
test('signal parsers preserve encoded identities and reject malformed paths without throwing', () => {
  const name = buildDirectSignal('Worker', 'member_with_underscore', 'direct 中文')
  assert.deepEqual(parseDirectSignal(name), { role: 'Worker', member: 'member_with_underscore', id: 'direct 中文', inputPath: 'direct/direct 中文.md', recordPath: 'direct/direct 中文/takeover.md' })
  for (const name of ['Worker_A_Direct_%ZZ', 'Worker_A_Direct_..', 'Worker_A_Direct_a%2Fb']) assert.equal(parseDirectSignal(name), undefined)
  assert.equal(signalWorkerId('Worker_%ZZ_Planner'), undefined)
  assert.equal(signalWorkerId('Worker_a%2Fb_Planner'), undefined)
})
test('Organizer claims before reviewing a member and returns work through the same Task Inbox', async t => {
  const f = await fixture(t, 'Organizer', {}, 'O'), state = paths.state('B', f.task.taskId)
  const signal = state + '/complete'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: signal, content: '' },
    { path: paths.memberStatus(f.task.taskId, 'B'), content: JSON.stringify({ state: 'complete', deliveryId: 'older' }) },
  ], 'member completed'))
  const claimed = await f.snapshot()
  await f.call('dss_claim', { snapshotId: claimed.snapshotId, signals: [signal], recordPath: paths.run(f.task.taskId) + '/Organizer_Note.md', text: 'Review B evidence next.\n' })
  const reviewed = await f.snapshot()
  await f.call('dss_member_dispatch', { snapshotId: reviewed.snapshotId, member: 'B', plan: 'Correct the demonstrated defect', decision: 'Result does not satisfy requirement X.\n' })
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, signal), undefined)
    assert.equal(await f.files.read(snapshot, paths.inbox(f.task.taskId, 'B')), 'Correct the demonstrated defect')
    assert.equal((await readJson<{state:string}>(f.files, snapshot, paths.memberStatus(f.task.taskId, 'B')))?.state, 'running')
    assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(f.task.taskId)))?.taskId, f.task.taskId)
  })
})

test('Foreground conversation claims update the real scoped index and memory, separate from task signals', async t => {
  let conversation!: FrameworkConversation
  const f = await fixture(t, 'Foreground', {}, 'P', (services, transactions) => {
    conversation = new FrameworkConversation(services.files, transactions, { mode: 'local', collaborationId: 'shared' })
    services.conversation = {
      foregroundRoot: conversation.foregroundRoot,
      read: async input => {
        if (input.mode === 'pending') return conversation.pendingForeground()
        if (input.mode === 'memory') return conversation.readForeground()
        if (input.mode === 'message') return conversation.read(input.reference ?? '')
        throw new Error('This test calls only pending/memory.')
      },
      send: async () => { throw new Error('Not called in this test.') },
      claim: (input, _binding, commandId) => conversation.claimForeground(commandId, input.messageIds, input, { expectedRevision: input.expectedRevision }),
    }
    const generic = services.notifications
    services.notifications = async (snapshot, binding, taskId) => {
      const conversations = new Set(await conversation.notificationPaths(snapshot))
      return (await generic(snapshot, binding, taskId)).filter(path => !conversations.has(path))
    }
  })
  await conversation.send('human-send', { id: 'message', participantId: 'human', createdAt: '2026-10-31T16:00:00Z', role: 'user', recipient: 'ai', text: 'Please inspect the task.' })
  const generic = await f.snapshot()
  assert.deepEqual(generic.notifications, [])
  assert.equal(await f.call('dss_conversation_read', { mode: 'message', reference: 'missing' }), null)
  await f.call('dss_snapshot_release', { snapshotId: generic.snapshotId })
  const pending = await f.call('dss_conversation_read', { mode: 'pending' })
  assert.equal(pending.messages[0].text, 'Please inspect the task.')
  await f.call('dss_conversation_claim', { expectedRevision: pending.revision, messageIds: ['message'], list: 'Inspect task', cache: 'Input understood' })
  assert.deepEqual((await conversation.pendingForeground()).messages, [])
  assert.deepEqual(await f.call('dss_conversation_read', { mode: 'memory' }), { list: 'Inspect task', cache: 'Input understood' })
})
test('Foreground supplement commits original Task body and P notification together, defeating a stale completion', async t => {
  const f = await fixture(t, 'Foreground'), view = await f.snapshot(), old = await f.files.snapshot()
  try {
    await f.call('dss_supplement_task', { snapshotId: view.snapshotId, text: 'Additional accepted requirement' })
    await assert.rejects(f.files.commit(old, [{ path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) }], 'stale complete'), /Storage changed/)
  } finally { await old.release() }
  await withSnapshot(f.files, async snapshot => {
    assert.ok((await f.files.read(snapshot, f.task.sourcePath))?.endsWith('Additional accepted requirement'))
    assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Planner_Foreground'), '')
    assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(f.task.taskId)))?.status, 'running')
  })
})
test('completion winning the race rejects stale supplement and fresh reread requires a new Task', async t => {
  const f = await fixture(t, 'Foreground'), view = await f.snapshot()
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) }], 'complete wins'))
  await assert.rejects(f.call('dss_supplement_task', { snapshotId: view.snapshotId, text: 'Too late' }), /Storage changed/)
  const fresh = await f.snapshot()
  await assert.rejects(f.call('dss_supplement_task', { snapshotId: fresh.snapshotId, text: 'Too late' }), /new Task/)
  await withSnapshot(f.files, async snapshot => {
    assert.ok(!(await f.files.read(snapshot, f.task.sourcePath))?.includes('Too late'))
    assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Planner_Foreground'), undefined)
  })
})
test('O member completion preserves explicit deliverable references in the long Reply', async t => {
  const f = await fixture(t, 'Planner', { member: 'B' }, 'O'), result = paths.member(f.task.taskId, 'B') + '/result.md'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: result, content: 'Delivered evidence' }, { path: paths.state('B', f.task.taskId) + '/recovery', content: '' }], 'result'))
  const view = await f.snapshot()
  await f.call('dss_complete', { snapshotId: view.snapshotId, acceptance: 'Checked actual evidence', resultPaths: [result] })
  await withSnapshot(f.files, async snapshot => {
    assert.ok((await f.files.read(snapshot, paths.member(f.task.taskId, 'B') + '/Reply.md'))?.includes(JSON.stringify(result)))
    assert.equal(await f.files.read(snapshot, paths.state('B', f.task.taskId) + '/complete'), '')
    assert.equal(await f.files.read(snapshot, paths.state('B', f.task.taskId) + '/recovery'), undefined)
    assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(f.task.taskId)))?.status, 'running')
  })
})

test('Foreground direct submission writes only its explicit input and existing target notification atomically', async t => {
  const f = await fixture(t, 'Foreground'), view = await f.snapshot()
  const request = { snapshotId: view.snapshotId, id: 'short-1', member: 'B', role: 'Worker', text: 'Inspect this one item', resultPath: 'direct/short-1/result.md', recipientSignal: 'state/Foreground_Direct-short-1' }
  await f.call('dss_submit_direct', request, 'direct-submit')
  assert.equal((await f.call('dss_submit_direct', request, 'direct-submit')).replay, true)
  await withSnapshot(f.files, async snapshot => {
    const input = await f.files.read(snapshot, 'direct/short-1.md')
    assert.ok(input?.includes('Inspect this one item'))
    assert.ok(input?.includes('"resultPath": "direct/short-1/result.md"'))
    assert.equal(await f.files.read(snapshot, 'state/' + buildDirectSignal('Worker', 'B', 'short-1')), '')
    assert.equal((await f.files.listDirectory(snapshot, 'tasks')).filter(entry => entry.path.endsWith('.json')).length, 1)
  })
  const fresh = await f.snapshot()
  await assert.rejects(f.call('dss_submit_direct', { ...request, snapshotId: fresh.snapshotId, text: 'Overwrite old request' }), /identity already exists/)
  const collision = await f.snapshot()
  await assert.rejects(f.call('dss_submit_direct', { ...request, snapshotId: collision.snapshotId, id: 'collision', resultPath: 'direct/collision.md' }), /must not overwrite/)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, 'direct/collision.md'), undefined))
})
test('direct submission rejects a stale view without leaving either input or signal', async t => {
  const f = await fixture(t, 'Foreground'), view = await f.snapshot()
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: 'other.md', content: 'another committed write' }], 'race'))
  await assert.rejects(f.call('dss_submit_direct', { snapshotId: view.snapshotId, id: 'short-race', member: 'A', role: 'Planner', text: 'Short request', resultPath: 'direct/result.md', recipientSignal: 'state/Foreground_Result' }), /Storage changed/)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, 'direct/short-race.md'), undefined)
    assert.equal(await f.files.read(snapshot, 'state/' + buildDirectSignal('Planner', 'A', 'short-race')), undefined)
  })
})

test('Planner completion consumes its existing recovery marker with acceptance and replays the postcommit callback', async t => {
  const f = await fixture(t, 'Planner'), marker = paths.state('A', f.task.taskId) + '/recovery'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: marker, content: '' }], 'recovery'))
  const view = await f.snapshot(), input = { snapshotId: view.snapshotId, acceptance: 'Accepted after normal continuation', resultPaths: [] }
  await f.call('dss_complete', input, 'complete-recovery')
  assert.equal(f.counts().recoveryCallbacks, 1)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, marker), undefined)
    assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(f.task.taskId)))?.status, 'complete')
    assert.equal((await f.files.list(snapshot, 'technical/recovery-consumptions')).length, 1)
  })
  await f.call('dss_complete', input, 'complete-recovery')
  assert.equal(f.counts().recoveryCallbacks, 2, 'service receives the same receipt and performs its own idempotent reset')
})
test('Organizer total completion never consumes another member recovery marker', async t => {
  const f = await fixture(t, 'Organizer', {}, 'O'), marker = paths.state('B', f.task.taskId) + '/recovery'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: marker, content: '' }, { path: paths.state('A', f.task.taskId) + '/Organizer_Task', content: null },
  ], 'reviewed task'))
  const view = await f.snapshot()
  await f.call('dss_complete', { snapshotId: view.snapshotId, acceptance: 'All member results accepted', resultPaths: [] })
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, marker), ''))
  assert.equal(f.counts().recoveryCallbacks, 0)
})

test('binary result references remain valid and dss_read returns metadata rather than base64', async t => {
  const f = await fixture(t, 'Planner'), path = 'deliverables/result.png', bytes = Uint8Array.from([137, 80, 78, 71, 0, 255])
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path, bytes }], 'binary result'))
  const view = await f.snapshot()
  const result = await f.call('dss_read', { snapshotId: view.snapshotId, path })
  assert.equal(result.binary, true); assert.equal(result.bytes, bytes.length)
  assert.equal(result.text, undefined); assert.equal(result.base64, undefined)
  await f.call('dss_complete', { snapshotId: view.snapshotId, acceptance: 'Verified deliverable', resultPaths: [path] })
})
test('Recorder may retain real binary evidence while verifying its authored UTF8 records', async t => {
  const f = await fixture(t, 'Recorder'), path = 'archives/' + f.task.taskId + '/proof.zip'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path, bytes: Uint8Array.from([80, 75, 0, 255]) },
    { path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) },
  ], 'complete with binary evidence'))
  const view = await f.snapshot()
  await f.call('dss_recorder_save', { snapshotId: view.snapshotId, outputs: [{ path: paths.archive(f.task.taskId) + '/records.md', text: 'Verified original ZIP retained.' }], retainedPaths: [path] })
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Cleaner'), ''))
})
test('only Helper exposes the explicit overall-restoration request, without an automatic restart', async t => {
  const requests: unknown[] = []
  const configure = (services: FrameworkRoleServices) => { services.helper = {
    request: async () => ({}), restore: async () => ({}), healthyCycle: async () => ({}),
    restoreHost: async (binding, input, id) => { requests.push({ role: binding.role, input, id }); return { arranged: true } },
  } }
  const helper = await fixture(t, 'Helper', {}, 'P', configure)
  const input = { facts: 'Scheduling stopped', hypotheses: 'An error persisted', actionsTaken: 'Saved diagnostics', continuation: 'Inspect eligible managers' }
  assert.deepEqual(await helper.call('dss_restore_host', input, 'restore-host'), { arranged: true })
  assert.deepEqual(requests, [{ role: 'Helper', input, id: 'agent:restore-host' }])
  const worker = await fixture(t, 'Worker', { workerId: 'child' }, 'P', configure)
  assert.equal(worker.definitions.has('dss_restore_host'), false)
})
test('artifact tool forwards the actual Agent and fixed revision to the provided native service', async t => {
  const requests: any[] = []
  const f = await fixture(t, 'Recorder', {}, 'P', services => { services.artifacts = {
    preserve: async (agent, input, binding, commandId, options) => { requests.push({ agent, input, binding, commandId, options }); return { verified: true } },
  } })
  const view = await f.snapshot(), destinationPath = paths.archive(f.task.taskId) + '/evidence.png'
  assert.deepEqual(await f.call('dss_preserve_artifact', { snapshotId: view.snapshotId, sourcePath: '/authorized/work/result.png', destinationPath }, 'preserve'), { verified: true })
  assert.equal(requests[0].agent, f.agent)
  assert.equal(requests[0].options.expectedRevision, view.revision)
  assert.equal(requests[0].options.snapshot.revision, view.revision)
  assert.deepEqual(requests[0].input, { sourcePath: '/authorized/work/result.png', destinationPath, taskId: f.task.taskId })
  const fresh = await f.snapshot()
  await assert.rejects(f.call('dss_preserve_artifact', { snapshotId: fresh.snapshotId, sourcePath: '/authorized/work/result.png', destinationPath: 'archives/another/result.png' }), /this Task archive/)
  assert.equal(requests.length, 1)
})

for (const lostAck of [false, true]) test(`Recorder save fixes input versions before readback${lostAck ? ' and preserves them on unknown replay' : ''}`, async t => {
  const f = await fixture(t, 'Recorder'), task = { ...f.task, status: 'complete' as const }
  const notes = workerPaths(task.taskId, 'A', 'child').notes, archive = paths.archive(task.taskId) + '/records.md'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: paths.task(task.taskId), content: JSON.stringify(task) }, { path: notes, content: 'Before Recorder evaluation' },
  ], 'completed task material'))
  const expected = await withSnapshot(f.files, snapshot => captureCleanupInputs(f.files, snapshot, task)), view = await f.snapshot()
  const transact = f.services.transact
  let intercepted = false
  // Reuse actual command coordinator; the seam models a committed archive followed
  // by late Worker output before the next native tool step, optionally losing ACK.
  f.services.transact = async (command, request, options, build) => {
    const result = await transact(command, request, options, build)
    if (!intercepted && !command.endsWith(':cleaner')) {
      intercepted = true
      await withSnapshot(f.files, async snapshot => {
        const manifest = await readJson<RetentionManifest>(f.files, snapshot, paths.archive(task.taskId) + '/retention.json')
        assert.equal(await f.files.read(snapshot, archive), 'Summary before late fact')
        assert.deepEqual(manifest?.inputs, expected)
        assert.ok(manifest?.recorderCommand?.endsWith(':original-save'))
        await f.files.commit(snapshot, [{ path: notes, content: 'Before Recorder evaluation\nLate Worker fact' }], 'late Worker before readback')
      })
      if (lostAck) throw new FilesOutcomeUnknownError('archive-ack-lost', undefined, result)
    }
    return result
  }
  const input = { snapshotId: view.snapshotId, outputs: [{ path: archive, text: 'Summary before late fact' }] }
  if (lostAck) await assert.rejects(f.call('dss_recorder_save', input, 'original-save'), FilesOutcomeUnknownError)
  await f.call('dss_recorder_save', input, 'original-save')
  await withSnapshot(f.files, async snapshot => {
    const manifest = await readJson<RetentionManifest>(f.files, snapshot, paths.archive(task.taskId) + '/retention.json')
    assert.deepEqual(manifest?.inputs, expected, 'readback H or replay must not recapture newer material')
    assert.equal(await f.files.read(snapshot, paths.state('A', task.taskId) + '/Cleaner'), '')
  })
  const coordinator = { run: f.services.transact } as unknown as FrameworkTransactions
  const cleaner = new FrameworkCleaner(f.files, coordinator, async () => { assert.fail('Changed material cannot release Task') })
  await assert.rejects(withSnapshot(f.files, snapshot => cleaner.clean(task, snapshot)), CleanupMaterialsChangedError)
})

test('Recorder readback rejects a retention manifest replaced by a different save command', async t => {
  const f = await fixture(t, 'Recorder'), archive = paths.archive(f.task.taskId) + '/records.md'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) }], 'complete'))
  const view = await f.snapshot(), transact = f.services.transact
  let replaced = false
  f.services.transact = async (...args) => {
    const receipt = await transact(...args)
    if (!replaced) {
      replaced = true
      await withSnapshot(f.files, async snapshot => {
        const path = paths.archive(f.task.taskId) + '/retention.json', manifest = await readJson<RetentionManifest>(f.files, snapshot, path)
        await f.files.commit(snapshot, [{ path, content: JSON.stringify({ ...manifest, recorderCommand: 'another-save' }) }], 'another Recorder save wins')
      })
    }
    return receipt
  }
  await assert.rejects(f.call('dss_recorder_save', { snapshotId: view.snapshotId, outputs: [{ path: archive, text: 'Records' }] }), /different save operation/)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Cleaner'), undefined))
})

test('Recorder resave removes an older Cleaner request atomically until new readback succeeds', async t => {
  const f = await fixture(t, 'Recorder'), archive = paths.archive(f.task.taskId) + '/records.md', cleaner = paths.state('A', f.task.taskId) + '/Cleaner'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) },
    { path: archive, content: 'Prior summary' }, { path: cleaner, content: '' },
  ], 'prior cleanup candidate'))
  const view = await f.snapshot(), transact = f.services.transact
  let checked = false
  f.services.transact = async (...args) => {
    const result = await transact(...args)
    if (!checked) {
      checked = true
      await withSnapshot(f.files, async snapshot => {
        assert.equal(await f.files.read(snapshot, archive), 'Reevaluated summary')
        assert.equal(await f.files.read(snapshot, cleaner), undefined, 'new save removes old request in same commit')
        assert.ok((await readJson<RetentionManifest>(f.files, snapshot, paths.archive(f.task.taskId) + '/retention.json'))?.inputs)
      })
    }
    return result
  }
  await assert.rejects(f.call('dss_recorder_save', { snapshotId: view.snapshotId, outputs: [{ path: archive, text: 'Reevaluated summary' }], retainedPaths: ['missing/retained-reference'] }), /not accessible/)
  assert.equal(checked, true)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, archive), 'Reevaluated summary')
    assert.equal(await f.files.read(snapshot, cleaner), undefined)
  })
})

for (const phase of ['files-cleaned', 'released'] as const) test(`shared cleanup ${phase} prevents a still-live Worker from recreating the old Task notes`, async t => {
  const f = await fixture(t, 'Worker', { workerId: 'child' }), notes = workerPaths(f.task.taskId, 'A', 'child').notes
  // Shared durable receipt is the boundary visible to another Host. No remote
  // native STOP acknowledgement or local runtime disposal is assumed here.
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) },
    { path: 'technical/cleanup/' + f.task.taskId + '.json', content: JSON.stringify({ version: 1, taskId: f.task.taskId, phase, retentionHash: 'evaluated-retention', deletedPaths: [notes], preservedPaths: [] }) },
    { path: notes, content: null },
  ], 'another Host confirms shared file cleanup'))
  const view = await f.snapshot()
  await assert.rejects(f.call('dss_record', { snapshotId: view.snapshotId, path: notes, text: 'Late old Worker result', append: true }), /clean|releas|retir|closed/i)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, notes), undefined, 'retired namespace must not reappear'))
})

test('globally complete Task still accepts late Worker facts before an actual cleanup receipt', async t => {
  const f = await fixture(t, 'Worker', { workerId: 'child' }), notes = workerPaths(f.task.taskId, 'A', 'child').notes
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) }], 'globally complete but not cleaned'))
  const view = await f.snapshot()
  await f.call('dss_record', { snapshotId: view.snapshotId, path: notes, text: 'Late fact must remain available to Recorder', append: true })
  await withSnapshot(f.files, async snapshot => assert.match((await f.files.read(snapshot, notes))!, /Late fact must remain available/))
})

for (const historyCleared of [false, true]) test('Foreground selected cleaned Task does not block scoped List/Cache or durable conversation reply; manual=' + historyCleared, async t => {
  let conversation!: FrameworkConversation
  const f = await fixture(t, 'Foreground', {}, 'P', (services, transactions) => {
    conversation = new FrameworkConversation(services.files, transactions, { mode: 'local', collaborationId: 'global-after-cleanup' })
    services.conversation = {
      foregroundRoot: conversation.foregroundRoot,
      read: async input => input.mode === 'memory' ? conversation.readForeground() : conversation.read(input.reference ?? ''),
      send: (input, _binding, commandId) => conversation.send(commandId, { id: input.id, text: input.text, role: 'assistant', participantId: 'A', createdAt: '2026-10-31T18:25:00Z', recipient: input.intent, replyTo: input.replyTo }),
      claim: (input, _binding, commandId) => conversation.claimForeground(commandId, input.messageIds, input, { expectedRevision: input.expectedRevision }),
    }
  })
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: 'technical/cleanup/' + f.task.taskId + '.json', content: JSON.stringify({ version: 1, taskId: f.task.taskId, phase: 'released', historyCleared }) }], 'selected old Task released'))
  for (const name of ['Foreground_List.md', 'Foreground_Cache.md']) {
    const view = await f.snapshot()
    assert.equal(view.taskId, f.task.taskId, 'selected Task remains present in this global role snapshot')
    await f.call('dss_record', { snapshotId: view.snapshotId, path: conversation.foregroundRoot + '/' + name, text: name + ' stays writable', append: false })
  }
  await f.call('dss_conversation_send', { id: 'completed-notice', text: 'Task finished; original result remains available.', intent: 'human' })
  const memory = await conversation.readForeground()
  assert.equal(memory.list, 'Foreground_List.md stays writable')
  assert.equal(memory.cache, 'Foreground_Cache.md stays writable')
  const reply = await conversation.read('completed-notice')
  assert.equal(reply?.role, 'assistant'); assert.equal(reply?.recipient, 'human')
  assert.equal(reply?.text, 'Task finished; original result remains available.')
  assert.equal((await conversation.pendingForeground()).messages.length, 0, 'assistant reply does not invent a user-to-AI wake signal')
})

test('Helper selected cleaned Task can still preserve its permitted global diagnostic record', async t => {
  const f = await fixture(t, 'Helper')
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: 'technical/cleanup/' + f.task.taskId + '.json', content: JSON.stringify({ version: 1, taskId: f.task.taskId, phase: 'released' }) }], 'old Task released'))
  const view = await f.snapshot(), path = 'debug/2026-10-31.md'
  await f.call('dss_record', { snapshotId: view.snapshotId, path, text: 'Diagnostics remain available after Task cleanup.' })
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, path), 'Diagnostics remain available after Task cleanup.'))
})

for (const selected of [
  { name: 'own O', owner: 'A', route: 'O', allowed: true },
  { name: 'foreign O', owner: 'B', route: 'O', allowed: false },
  { name: 'own P', owner: 'A', route: 'P', allowed: false },
  { name: 'foreign P', owner: 'B', route: 'P', allowed: false },
] as const) test(`Organizer records preserve selected Task ownership: ${selected.name}`, async t => {
  const f = await fixture(t, 'Organizer', {}, 'O')
  const target: TaskMetadata = { ...f.task, taskId: 'selected-' + selected.owner + '-' + selected.route, owner: selected.owner, route: selected.route }
  const recordPaths = ['Organizer_Note.md', 'Dispatch.md'].map(name => paths.run(target.taskId) + '/' + name)
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: paths.task(target.taskId), content: JSON.stringify(target) },
    ...recordPaths.map(path => ({ path, content: 'Original other record\n' })),
  ], 'independent Task record ownership'))
  for (const path of recordPaths) {
    const view = await f.call('dss_snapshot', { taskId: target.taskId })
    const writing = f.call('dss_record', { snapshotId: view.snapshotId, path, text: 'Organizer decision\n', append: true })
    if (selected.allowed) await writing
    else await assert.rejects(writing, /Organizer records belong to this principal’s O task/)
    await withSnapshot(f.files, async snapshot => {
      assert.equal(await f.files.read(snapshot, path), 'Original other record\n' + (selected.allowed ? 'Organizer decision\n' : ''))
      assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(f.task.taskId)))?.owner, 'A')
    })
    // Narrow role-record ownership does not restrict the collaboration's reads.
    const readView = await f.call('dss_snapshot', { taskId: target.taskId })
    const read = await f.call('dss_read', { snapshotId: readView.snapshotId, path })
    assert.equal(read.exists, true)
    await f.call('dss_snapshot_release', { snapshotId: readView.snapshotId })
  }
})

for (const fault of ['changed-binary', 'missing-digest'] as const) test(`Recorder readback rejects ${fault} after its first save transaction`, async t => {
  const f = await fixture(t, 'Recorder'), archive = paths.archive(f.task.taskId) + '/records.md', attachment = paths.archive(f.task.taskId) + '/binary.bin'
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: paths.task(f.task.taskId), content: JSON.stringify({ ...f.task, status: 'complete' }) },
    { path: attachment, bytes: Uint8Array.from([0, 255, 254]) },
  ], 'completed task binary evidence'))
  const view = await f.snapshot(), transact = f.services.transact
  let altered = false
  f.services.transact = async (...args) => {
    const receipt = await transact(...args)
    if (!altered) {
      altered = true
      await withSnapshot(f.files, async snapshot => {
        const path = paths.archive(f.task.taskId) + '/retention.json', manifest = await readJson<RetentionManifest>(f.files, snapshot, path)
        assert.match(manifest!.verifiedReferences![archive]!, /^[a-f0-9]{64}$/)
        assert.match(manifest!.verifiedReferences![attachment]!, /^[a-f0-9]{64}$/)
        if (fault === 'missing-digest') {
          delete manifest!.verifiedReferences![attachment]
          await f.files.commit(snapshot, [{ path, content: JSON.stringify(manifest) }], 'candidate loses verification evidence')
        } else await f.files.commit(snapshot, [{ path: attachment, bytes: Uint8Array.from([0, 255, 253]) }], 'declared retained reference changed')
      })
    }
    return receipt
  }
  await assert.rejects(f.call('dss_recorder_save', { snapshotId: view.snapshotId, outputs: [{ path: archive, text: 'Actual AI-authored archive' }], retainedPaths: [attachment] }), /retained reference differs/)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, paths.state('A', f.task.taskId) + '/Cleaner'), undefined)
    assert.equal(await f.files.read(snapshot, archive), 'Actual AI-authored archive')
  })
})

test('Foreground registers full-text search/text pages and automatically injects only memory purpose/path guide', async t => {
  let conversation!: FrameworkConversation, reads = 0
  const f = await fixture(t, 'Foreground', {}, 'P', (services, transactions) => {
    conversation = new FrameworkConversation(services.files, transactions, { mode: 'local', collaborationId: 'long-text-tools' })
    services.conversation = {
      foregroundRoot: conversation.foregroundRoot,
      read: async input => {
        reads++
        if (input.mode === 'search') return conversation.search(input.query!, input.cursor, input.limit)
        if (input.mode === 'text') return conversation.readText(input.reference!, input.cursor, input.limit)
        return conversation.readForeground()
      },
      send: async () => { throw new Error('Not used by this read-only test') },
      claim: async () => { throw new Error('Not used by this read-only test') },
    }
  })
  const guide = f.prompts.join('\n')
  assert.equal(reads, 0, 'registering purpose/path guide never preloads memory body')
  for (const phrase of ['Foreground_List.md', 'Foreground_Cache.md', 'Keep completed items', '7 days', '30 days', 'user-specified waiting/review date', 'a reminder alone does not reset', 'No extra polling', 'no word or character quota', 'body is not preloaded']) assert.ok(guide.includes(phrase), phrase)
  const original = 'a'.repeat(70_000) + 'search-original' + 'z'.repeat(80_000)
  await conversation.send('text-source', { id: 'text-source', participantId: 'human', role: 'user', createdAt: '2026-11-01T00:00:00Z', text: original })
  const found = await f.call('dss_conversation_read', { mode: 'search', query: 'search-original' })
  assert.equal(found.matches[0].message.ref, 'text-source')
  const page = await f.call('dss_conversation_read', { mode: 'text', reference: found.matches[0].message.ref, cursor: 69_990, limit: 40 })
  assert.equal(page.text, original.slice(69_990, 70_030)); assert.equal(page.nextCursor, 70_030)
  await assert.rejects(f.call('dss_conversation_read', { mode: 'search', query: 'search-original', limit: 51 }))
  await assert.rejects(f.call('dss_conversation_read', { mode: 'text', reference: 'text-source', limit: 262145 }))
})

test('Foreground supplement cannot reopen an explicitly history-cleared running Local Task', async t => {
  const f = await fixture(t, 'Foreground')
  const receipt = 'technical/cleanup/' + f.task.taskId + '.json'
  await withSnapshot(f.files, s => f.files.commit(s, [{ path: receipt, content: JSON.stringify({ version: 1, taskId: f.task.taskId, phase: 'released', historyCleared: true, retentionHash: 'manual', deletedPaths: [], preservedPaths: [] }) }], 'manual cancelled history cleared'))
  const before = await withSnapshot(f.files, s => f.files.read(s, f.task.sourcePath)), snapshot = await f.snapshot()
  await assert.rejects(f.call('dss_supplement_task', { snapshotId: snapshot.snapshotId, text: 'Must use a new task' }), /history.*cleared|new Task/)
  assert.equal(await withSnapshot(f.files, s => f.files.read(s, f.task.sourcePath)), before)
})

for (const role of ['Organizer', 'Planner', 'Worker', 'Recorder'] as const) test(role + ' business mutation does not reopen manually cleared running Task', async t => {
  const f = await fixture(t, role, role === 'Worker' ? { workerId: 'child' } : {}, role === 'Organizer' ? 'O' : 'P')
  await withSnapshot(f.files, s => f.files.commit(s, [{ path: 'technical/cleanup/' + f.task.taskId + '.json', content: JSON.stringify({ version: 1, taskId: f.task.taskId, phase: 'released', historyCleared: true, retentionHash: 'manual', deletedPaths: [], preservedPaths: [] }) }], 'manual cancelled history cleared'))
  const snapshot = await f.snapshot()
  const request = role === 'Organizer' ? { name: 'dss_member_dispatch', input: { member: 'B', plan: 'Reopen', decision: 'Reopen' } }
    : role === 'Planner' ? { name: 'dss_worker_assign', input: { childId: 'new-child', contract: 'Reopen', decision: 'Reopen' } }
    : role === 'Worker' ? { name: 'dss_worker_deliver', input: { reply: 'Reopen', records: [] } }
    : { name: 'dss_recorder_save', input: { outputs: [{ path: paths.archive(f.task.taskId) + '/records.md', text: 'Recreated history' }] } }
  await assert.rejects(f.call(request.name, { ...request.input, snapshotId: snapshot.snapshotId }), /history.*cleared|new Task/)
})
