import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { installFrameworkSkillProvider } from '../src/framework/skills.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { baselineFixture as fixture, baselineChildSpec as childSpec, BaselineKnowledgeService as KnowledgeService, BaselineConversationStore as ConversationStore, readBaselineSource, loadBaselineModule, LEGACY_TEST_BASELINE } from './legacy-baseline.js'
import { MemoryStorage } from './support.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkHostLoop } from '../src/framework/host-loop.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { FrameworkArtifacts } from '../src/framework/artifacts.js'
import { withSnapshot, FilesConflictError } from '../src/framework/transactions.js'
import { captureLocalLegacy, captureGitLegacy, prepareLegacyMigration as prepareActualMigration, applyLegacyMigration, readMigratedReference, resumeLegacyTask, answerLegacyTask, LEGACY_BASELINE } from '../src/framework/legacy-migration.js'

// These fixtures own only fake Agents and have no live native registry/jobs.
// Explicit evidence is supplied at the same boundary used by Host reconciliation;
// production prepare without that evidence is tested separately below.
const prepareLegacyMigration: typeof prepareActualMigration = (capture, files, snapshot, options, transactions) => prepareActualMigration(capture, files, snapshot, {
  ...options, nativeOwnershipReconciled: Object.fromEntries(capture.tasks.flatMap(task => task.participants.map(participant => [participant.identity,
    (participant.nativeExecutions ?? []).map(execution => ({ executionId: execution.executionId, generation: execution.generation, settled: true }))]))),
}, transactions)
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
async function target(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-legacy-migration-'))
  const files = await LocalFiles.open(directory), storage = new MemoryStorage()
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }) })
  return { files, storage, transactions: new FrameworkTransactions(files, storage, directory) }
}
async function oldLocal(wait?: 'user' | 'job' | 'configuration' | 'resource') {
  assert.equal(LEGACY_TEST_BASELINE, LEGACY_BASELINE)
  const f = await fixture('Original source 🙂\n'.repeat(40_000)), planner = await f.bind('plan')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0,
    strategy: 'Preserve and continue actual old work', children: [childSpec()] }, planner.source)).status, 'applied')
  const worker = await f.bind('dispatch')
  assert.equal((await f.execute({ type: 'execution.report', report: { resultId: 'handoff-result', assignmentVersion: 1, outcome: wait ? 'wait' : 'handoff',
    ...(wait ? { wait: { id: 'wait-1', kind: wait, reason: 'Original wait reason', condition: 'Original condition', resume: 'Resume same unfinished assignment',
      ...(wait === 'user' ? { question: 'Which source should I use?' } : { jobId: 'original-job' }) } } : {}),
    summary: 'Long report 🙂\n'.repeat(20_000), artifacts: [{ id: 'artifact-1', path: '/authorized-fixture/result.bin', description: 'Existing artifact', sha256: sha('actual file') }],
    evidence: ['Actual old report evidence'], frontier: 'Continue remaining work', checkpoint: {
      completed: ['First section'], failedApproaches: [{ approach: 'Old method', outcome: 'Did not meet constraints', evidence: ['Recorded evidence'] }],
      remaining: ['Second section'], nextAction: 'Read exact prior result', nextReads: ['artifact-1'],
    } } }, worker.source)).status, 'applied')
  const memory = await f.store.journal.append({ scope: { kind: 'planner-memory', taskId: 'one' }, commandId: 'long-memory',
    text: 'Persistent complete memory 🚀\n'.repeat(30_000), source: planner.source })
  return { ...f, memory }
}

test('migration: actual baseline separated records preserve full reports/checkpoint/ref and enter the new Planner discovery', async t => {
  const old = await oldLocal(), before = JSON.stringify([...old.storage.data]), capture = await captureLocalLegacy(old.storage)
  assert.equal(capture.tasks[0]!.id, 'one')
  assert.deepEqual(capture.tasks[0]!.participants[0]!.nativeExecutions!.map(item => item.executionId).sort(), Object.keys((await old.get()).executions).sort())
  assert.ok(capture.tasks[0]!.participants[0]!.nativeExecutions!.some(item => item.role === 'planner'))
  for (const item of capture.tasks[0]!.participants[0]!.nativeExecutions!) {
    const original = (await old.get()).executions[item.executionId]!
    assert.equal(item.sessionId, original.sessionId); assert.equal(item.agentId, original.agentId)
    assert.equal(item.recordedSettled, original.physicalState === 'stopped' && original.ownedJobIds.length === 0)
  }
  assert.equal(capture.tasks[0]!.participants[0]!.children[0]!.reports.length, 1)
  const f = await target(t)
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot,
    { id: 'local-upgrade', owner: 'alice', members: { assistant: 'alice' } }))
  const result = await applyLegacyMigration(f.files, f.transactions, plan)
  assert.equal(result.verified, true)
  assert.equal(result.complete, false, 'native reconciliation/global activity adapters are not claimed complete')
  assert.equal(JSON.stringify([...old.storage.data]), before, 'source was never mutated or removed')
  const mapped = plan.manifest.tasks[0]!
  await withSnapshot(f.files, async snapshot => {
    const restored = JSON.parse((await f.files.read(snapshot, mapped.recordPath))!)
    assert.deepEqual(restored, await old.get())
    assert.equal(await f.files.read(snapshot, plan.manifest.references[old.memory.ref]!), await old.store.journal.fullText(old.memory.ref))
    assert.deepEqual(JSON.parse((await f.files.read(snapshot, 'task-runs/' + mapped.taskId + '/alice/workers/a/handoff.json'))!).reports[0].checkpoint,
      (await old.get()).reports['handoff-result']!.checkpoint)
  })
  const wakes: any[] = []
  const loop = new FrameworkHostLoop(f.files, f.transactions, f.storage, { member: 'alice', primary: true, scope: 'migration-test' }, () => ['alice'], {
    wake: async wake => { wakes.push(wake) }, executing: () => false, sealBusiness: async () => {}, clean: async () => {}, startup: async () => {}, observe: async () => {}, error: error => { throw error },
  })
  await loop.poll(); await loop.poll()
  assert.ok(wakes.some(wake => wake.role === 'Planner' && wake.taskId === mapped.taskId), 'real new Host loop discovers migrated member Inbox')
  assert.equal((await applyLegacyMigration(f.files, f.transactions, plan)).verified, true, 'same durable migration can verify/replay after acknowledgement loss')
})

test('migration: actual old pause and cancel commands retain intent without current task wake files', async t => {
  for (const action of ['pause', 'cancel'] as const) {
    const old = await oldLocal()
    const receipt = await old.execute({ type: 'task.control', intent: action }, { kind: 'user', id: 'user' })
    assert.equal(receipt.status, 'applied')
    const capture = await captureLocalLegacy(old.storage), f = await target(t)
    assert.equal(capture.tasks[0]!.continuation, action === 'pause' ? 'paused' : 'cancelled')
    const plan = await withSnapshot(f.files, s => prepareLegacyMigration(capture, f.files, s, { id: action, owner: 'alice', members: { assistant: 'alice' } }))
    await applyLegacyMigration(f.files, f.transactions, plan)
    await withSnapshot(f.files, async s => {
      assert.deepEqual(await f.files.listDirectory(s, 'tasks/'), [])
      assert.deepEqual(await f.files.list(s, 'state/'), [])
    })
  }
})

test('migration: missing/corrupt real legacy parts fail before target publication; changed target yields CAS conflict', async t => {
  const old = await oldLocal()
  const part = [...old.storage.data.keys()].find(key => key.includes('/content/'))!
  const original = old.storage.data.get(part)
  old.storage.data.set(part, { schemaVersion: 1, text: 'Corrupt body' })
  await assert.rejects(captureLocalLegacy(old.storage), /corrupt|hash mismatch/)
  old.storage.data.set(part, original)
  const source = await captureLocalLegacy(old.storage), f = await target(t)
  const plan = await withSnapshot(f.files, s => prepareLegacyMigration(source, f.files, s, { id: 'cas', owner: 'alice', members: { assistant: 'alice' } }))
  await withSnapshot(f.files, s => f.files.commit(s, [{ path: 'instances/another', content: '' }], 'Competing change'))
  await assert.rejects(applyLegacyMigration(f.files, f.transactions, plan), FilesConflictError)
  assert.equal((await withSnapshot(f.files, s => f.files.list(s, 'technical/legacy-migrations/'))).length, 0)
})

test('migration: original user wait is held while a Worker job wait retains normal-chain continuation', async t => {
  for (const kind of ['user', 'job'] as const) {
    const old = await oldLocal(kind), capture = await captureLocalLegacy(old.storage), f = await target(t)
    assert.equal(capture.tasks[0]!.continuation, kind === 'user' ? 'wait-user' : 'wait-result')
    const plan = await withSnapshot(f.files, s => prepareLegacyMigration(capture, f.files, s, { id: kind, owner: 'alice', members: { assistant: 'alice' } }))
    await applyLegacyMigration(f.files, f.transactions, plan)
    const entries = await withSnapshot(f.files, s => f.files.listDirectory(s, 'tasks/'))
    assert.equal(entries.length > 0, kind === 'job')
    assert.deepEqual(JSON.parse((await withSnapshot(f.files, s => f.files.read(s, plan.manifest.tasks[0]!.recordPath)))!).waits, (await old.get()).waits)
  }
})

test('migration: captured artifact bytes join the same commit and work with the current artifact read API', async t => {
  const old = await oldLocal(), capture = await captureLocalLegacy(old.storage), f = await target(t)
  const settings = { id: 'artifacts', owner: 'alice', members: { assistant: 'alice' }, artifacts: [{ sourcePath: '/authorized-fixture/result.bin', bytes: Buffer.from('actual file') }] }
  const plan = await withSnapshot(f.files, s => prepareLegacyMigration(capture, f.files, s, settings))
  await applyLegacyMigration(f.files, f.transactions, plan)
  const path = plan.manifest.references['artifact-1']!
  const reader = new FrameworkArtifacts({ fs: {} } as any, f.files, f.transactions, 'unused-by-read')
  assert.equal(Buffer.from((await reader.read(path)).data).toString(), 'actual file')
  assert.equal(Buffer.from(await withSnapshot(f.files, s => readMigratedReference(f.files, s, plan.manifest, 'artifact-1'))).toString(), 'actual file')
  await assert.rejects(withSnapshot(f.files, s => prepareLegacyMigration(capture, f.files, s, { ...settings, id: 'wrong', artifacts: [{ sourcePath: settings.artifacts[0]!.sourcePath, bytes: Buffer.from('wrong') }] })), /recorded hash/)
})

test('migration: committed data with lost local acknowledgement replays the same migration without rewriting source or task identity', async t => {
  const old = await oldLocal(), capture = await captureLocalLegacy(old.storage), f = await target(t)
  const plan = await withSnapshot(f.files, s => prepareLegacyMigration(capture, f.files, s, { id: 'lost-receipt', owner: 'alice', members: { assistant: 'alice' } }))
  f.storage.fail = (key, value) => key.startsWith('framework-commands/') && !!(value as any)?.receipt
  await assert.rejects(applyLegacyMigration(f.files, f.transactions, plan), /Injected/)
  const head = await withSnapshot(f.files, s => Promise.resolve(s.revision))
  f.storage.fail = undefined
  const restarted = new FrameworkTransactions(f.files, f.storage, f.files.directory)
  assert.equal((await applyLegacyMigration(f.files, restarted, plan)).verified, true)
  assert.equal(await withSnapshot(f.files, s => Promise.resolve(s.revision)), head)
  assert.equal((await withSnapshot(f.files, s => f.files.listDirectory(s, 'tasks/'))).filter(file => file.path.endsWith('.json')).length, 1)
})

test('migration: explicit old resume/answer use original normalized work and stable actions, never reopen cancellation', async t => {
  for (const kind of ['pause', 'user', 'cancel'] as const) {
    const old = await oldLocal(kind === 'user' ? 'user' : undefined)
    if (kind !== 'user') assert.equal((await old.execute({ type: 'task.control', intent: kind }, { kind: 'user', id: 'user' })).status, 'applied')
    const capture = await captureLocalLegacy(old.storage), f = await target(t)
    const plan = await withSnapshot(f.files, s => prepareLegacyMigration(capture, f.files, s, { id: 'control-' + kind, owner: 'alice', members: { assistant: 'alice' } }))
    await applyLegacyMigration(f.files, f.transactions, plan)
    const input = { manifestPath: plan.manifestPath, oldTaskId: 'one', member: 'alice' }
    if (kind === 'cancel') { await assert.rejects(resumeLegacyTask(f.files, f.transactions, 'resume', input), /Ended/); continue }
    const action = kind === 'pause' ? () => resumeLegacyTask(f.files, f.transactions, 'resume', input)
      : () => answerLegacyTask(f.files, f.transactions, 'answer', { ...input, waitId: 'wait-1', answer: 'Use the approved original source.' })
    if (kind === 'user') await assert.rejects(answerLegacyTask(f.files, f.transactions, 'wrong-answer', { ...input, waitId: 'not-the-wait', answer: 'Do not guess' }), /not pending/)
    const result = await action()
    const head = await withSnapshot(f.files, s => Promise.resolve(s.revision))
    assert.equal((await action()).taskId, result.taskId)
    assert.equal(await withSnapshot(f.files, s => Promise.resolve(s.revision)), head)
    const inbox = await withSnapshot(f.files, s => f.files.read(s, 'task-runs/' + result.taskId + '/alice/alice_Inbox/alice_' + result.taskId + '.md'))
    assert.ok(inbox?.includes(kind === 'pause' ? 'resume' : 'Use the approved original source.'))
    assert.deepEqual(JSON.parse((await withSnapshot(f.files, s => f.files.read(s, plan.manifest.tasks[0]!.recordPath)))!), await old.get(), 'original record is retained unchanged')
  }
})

/** Compile the actual historical fixture and every relative production import
 * from the pinned Git commit, in memory. No current source can silently replace
 * the historical producer. Fake Agents are the original baseline test double;
 * no native agent, model, credential or network call is made.
 */
async function oldGit(wait = false, archive = false): Promise<Array<[string, string]> & { archive?: { prior: Array<[string, string]>; head: string } }> {
  const source = readBaselineSource('tests/private-git.test.ts')
  const prefix = source.slice(0, source.indexOf('\ntest('))
  assert.ok(prefix.includes('async function root('))
  const code = prefix + `\nimport { CoopFinalizer } from '../src/experimental/private-git/finalizer.js';\nexport async function produce() {
    const repo = new MemoryRepo(), target = instance(repo), planner = await root(repo, target);
    await write(target, planner, { op: 'root_plan', id: 'plan', expectedRevision: 0, works: [{ id:'work',title:'Work',direction:'Full direction',acceptance:'Verified result',participantId:'1',instanceId:target.cache.instanceId,version:1 }] });
    await write(target, planner, { op:'participant_plan',id:'children',expectedRevision:0,children:[{id:'child',workId:'work',assignmentVersion:1,title:'Child',direction:'Continue this work',acceptance:'Verified',dependencies:[]}] });
    await write(target, planner, { op:'entry',id:'real-skill',kind:'skill',text:'Historical scoped Git skill\\n' + 'Exact original steps 🙂'.repeat(5000) });
    await write(target, planner, { op:'outcome',id:'ready',kind:${wait ? "'wait',question:'Choose the original source?'" : "'plan_ready'"},text:'Plan ready',memory:'Historical long memory 🚀\\n'.repeat(30000),note:'Current exact frontier' });
    if (${archive}) {
      const head = await repo.snapshot(), task = await readJson(repo, head, taskPath(planner.binding.taskId) + '/contract.json');
      await repo.commit(head, [{ path: taskPath(task.id) + '/contract.json', content: json({...task,status:'accepted'}) },
        ...[...head.files.keys()].filter(path=>path.includes('/actions/')).map(path=>({path,content:json({...JSON.parse(repo.blobs.get(head.files.get(path))),state:'closed'})}))]);
      const before = await repo.snapshot(), prior = [...repo.files].map(([path,sha])=>[path,repo.blobs.get(sha)]);
      const finalizer = new CoopFinalizer(repo, target.journal, target.cache);
      const accepted = await readJson(repo,before,taskPath(task.id)+'/contract.json');
      await finalizer.finalize(before,accepted); await finalizer.finalize(await repo.snapshot(),accepted);
      return Object.assign([...repo.files].map(([path,sha])=>[path,repo.blobs.get(sha)]),{archive:{prior,head:before.head}});
    }
    return [...repo.files].map(([path, sha]) => [path, repo.blobs.get(sha)]);
  }`
  const module = await loadBaselineModule<{ produce(): ReturnType<typeof oldGit> }>('tests/private-git.test.ts', code)
  return module.produce()
}

test('migration: fixed historical Git producer manifests/outcome/long memory survive conversion with exact ref mapping', async t => {
  const original = await oldGit(), source = await target(t), destination = await target(t)
  await withSnapshot(source.files, snapshot => source.files.commit(snapshot, original.map(([path, content]) => ({ path: path.replace(/^dss-coop\//, ''), content })), 'Replay historical producer bytes'))
  const capture = await withSnapshot(source.files, snapshot => captureGitLegacy(source.files, snapshot))
  assert.equal(capture.tasks.length, 1)
  assert.equal(capture.tasks[0]!.participants[0]!.children.length, 1)
  assert.ok(capture.texts.some(text => text.text.length > 500_000))
  const identity = capture.tasks[0]!.participants[0]!.identity
  const plan = await withSnapshot(destination.files, snapshot => prepareLegacyMigration(capture, destination.files, snapshot,
    { id: 'git-upgrade', owner: 'alice', members: { [identity]: 'alice' } }))
  const result = await applyLegacyMigration(destination.files, destination.transactions, plan)
  assert.equal(result.verified, true)
  assert.equal(result.complete, false, 'conversation activity index remains an explicit adapter obligation')
  await withSnapshot(destination.files, async snapshot => {
    for (const [path, body] of original) assert.equal(Buffer.from((await destination.files.readBytes(snapshot, plan.manifest.references[path]!))!).toString(), body)
    for (const text of capture.texts) assert.equal(await destination.files.read(snapshot, plan.manifest.references[text.ref]!), text.text)
  })
})

test('migration: repository-root selection does not read or copy unrelated project and credential-shaped files', async t => {
  const original = await oldGit(), source = await target(t)
  await withSnapshot(source.files, snapshot => source.files.commit(snapshot, [
    ...original.map(([path, content]) => ({ path: path.replace(/^dss-coop\//, ''), content })),
    { path: 'project/config.json', content: '{"unrelated":true}' }, { path: '.env', content: 'SYNTHETIC_FIXTURE_ONLY' },
    { path: 'tasks/unrelated/private-config.json', content: 'SYNTHETIC_FIXTURE_ONLY' },
    { path: 'README.md', content: 'Unrelated project README' },
    { path: 'inputs/1/path-looking-body.json', content: JSON.stringify({ id: 'path-looking-body', participantId: '1', text: 'dss-coop/.env' }) },
  ], 'Historical record tree alongside unrelated project fixtures'))
  const reads: string[] = [], originalRead = source.files.readBytes.bind(source.files)
  source.files.readBytes = async (snapshot, path) => { reads.push(path); return originalRead(snapshot, path) }
  const capture = await withSnapshot(source.files, snapshot => captureGitLegacy(source.files, snapshot))
  for (const path of ['project/config.json', '.env', 'tasks/unrelated/private-config.json', 'README.md']) {
    assert.equal(reads.includes(path), false, 'must not read ' + path)
    assert.equal(capture.records.some(record => record.key === path), false, 'must not retain ' + path)
  }
  assert.deepEqual(original.map(([path]) => path.replace(/^dss-coop\//, '')).filter(path => !capture.records.some(record => record.key === path)), [], 'complete historical producer objects retained')
})

test('migration: new framework technical state cannot contaminate fixed baseline Local capture revision', async () => {
  const old = await oldLocal(), first = await captureLocalLegacy(old.storage)
  await old.storage.set('framework-settings', { revision: 1 })
  await old.storage.set('framework-commands/example', { state: 'unknown' })
  await old.storage.set('framework-instances/example', { sequence: 2 })
  const second = await captureLocalLegacy(old.storage)
  assert.equal(second.revision, first.revision)
  assert.deepEqual(second.records, first.records)
  assert.deepEqual(second.texts, first.texts)
  assert.deepEqual(second.tasks, first.tasks)
  let reads = 0
  const concurrentNewState = { list: async <T>(prefix: string) => {
    await old.storage.set('framework-settings', { revision: ++reads })
    return old.storage.list<T>(prefix)
  } }
  assert.equal((await captureLocalLegacy(concurrentNewState)).revision, first.revision)
  await old.storage.set('settings/runtime', { schemaVersion: 1, revision: 2, workerSeats: 3 })
  assert.notEqual((await captureLocalLegacy(old.storage)).revision, first.revision, 'actual old settings remain part of the source')
})

test('migration: actual legacy conversation exchanges and foreground bodies become the current readable index without notifications', async t => {
  const storage = new MemoryStorage(), old = new ConversationStore(storage, 'UTC')
  for (let turn = 1; turn <= 7; turn++) {
    const at = `2026-10-30T00:00:0${turn}.000Z`
    await old.complete('default', 'old-session', turn, [
      { id: 'user-' + turn, role: 'user', text: 'Original user ' + turn, at },
      { id: 'reply-' + turn, role: 'assistant', text: ('Complete reply 🙂 ' + turn).repeat(5000), at },
    ], at)
  }
  await old.append('default', 'old-session', { id: 'system-long', role: 'system', source: 'deepseek-servant-status', text: 'Exact status 🚀'.repeat(9000), at: '2026-10-30T00:00:08.000Z' })
  await old.append('default', 'old-session', { id: 'unanswered', role: 'user', text: 'Original unanswered request', at: '2026-10-30T00:00:09.000Z' })
  await storage.set('foreground-memory/default/Foreground_List', { text: 'Original pending work', updatedAt: '2026-10-30' })
  await storage.set('foreground-memory/default/Foreground_Cache', { text: 'Original cache 🙂'.repeat(5000), updatedAt: '2026-10-30' })
  const before = JSON.stringify([...storage.data]), capture = await captureLocalLegacy(storage), f = await target(t)
  const scope = { mode: 'local' as const, collaborationId: 'local-existing' }
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot, {
    id: 'local-conversation-upgrade', owner: 'alice', members: {}, conversations: [{ scope, assistantId: 'default', participantId: 'alice' }],
  }, f.transactions))
  await applyLegacyMigration(f.files, f.transactions, plan)
  const current = new FrameworkConversation(f.files, f.transactions, scope), page = await current.page(100)
  const original = await old.page('default', undefined, 100)
  assert.deepEqual(page.messages.map(({ id, role, text, source }) => ({ id, role, text, source })), original.messages.map(({ id, role, text, source }) => ({ id, role, text, source })))
  assert.deepEqual((await current.recentExchanges()).map(exchange => [exchange.human.text, exchange.assistant.text]), (await old.seed('default')).map(exchange => exchange.map(message => message.text)))
  assert.deepEqual(await current.readForeground(), { list: 'Original pending work', cache: 'Original cache 🙂'.repeat(5000) })
  assert.deepEqual((await current.pendingForeground()).messages, [])
  assert.equal(plan.manifest.pendingAdapters.includes('conversation-index'), false)
  assert.equal(JSON.stringify([...storage.data]), before)
})

test('migration: real legacy Git need_user holds active-root work and exposes exact waiting execution identity', async t => {
  const source = await target(t), original = await oldGit(true)
  await withSnapshot(source.files, snapshot => source.files.commit(snapshot, original.map(([path, content]) => ({ path: path.replace(/^dss-coop\//, ''), content })), 'Replay original need_user'))
  const captured = await withSnapshot(source.files, snapshot => captureGitLegacy(source.files, snapshot))
  const task = captured.tasks[0]!
  assert.equal((task.original as any).status, 'active')
  assert.equal(task.continuation, 'wait-user')
  assert.equal(task.participants[0]!.continuation, 'wait-user')
  assert.ok(task.participants[0]!.nativeExecutions!.some(item => item.role === 'planner' && item.sessionId))
  assert.ok(task.participants[0]!.nativeExecutions!.every(item => !item.recordedSettled), 'published outcome alone does not establish physical termination')
  assert.equal(task.waits?.[0]?.question, 'Choose the original source?')
  assert.equal(task.waits?.[0]?.id, (task.waits?.[0]?.original as any).binding.executionId)
  const targetFiles = await target(t)
  const plan = await withSnapshot(targetFiles.files, snapshot => prepareLegacyMigration(captured, targetFiles.files, snapshot,
    { id: 'git-user-wait', owner: 'alice', members: { [task.participants[0]!.identity]: 'alice' } }))
  assert.equal(plan.changes.some(change => change.path.startsWith('state/') || change.path.endsWith('/Inbox.md')), false)
  // An actual newer request changes the exact baseline observedTrigger. The old
  // question remains preserved history, not the current pending user decision.
  await withSnapshot(source.files, snapshot => source.files.commit(snapshot, [{ path: 'tasks/' + task.id + '/requests/' + (task.participants[0]!.original as any).participantId + '/original/new-request.json', content: JSON.stringify({ id: 'new-request', text: 'A later user reply' }) }], 'Later original request'))
  const later = await withSnapshot(source.files, snapshot => captureGitLegacy(source.files, snapshot))
  assert.equal(later.tasks[0]!.continuation, 'running')
  assert.deepEqual(later.tasks[0]!.waits, [])
})

test('migration: real old knowledge records retain scope/provenance and only the original active skill body', async t => {
  const storage = new MemoryStorage(), scope = { assistantId: 'default', workspaceId: 'workspace-one' }
  const old = new KnowledgeService({ store: storage, evidence: {
    resolveResult: async resultId => ({ ...scope, resultId, taskId: 'completed-original', status: 'accepted', summary: 'Real fixture evidence', artifactRefs: ['artifact-original'] }),
    resolveUserSource: async () => scope,
  } })
  for (const skillId of ['active-method', 'candidate-method']) await old.proposeSkill({ commandId: 'propose-' + skillId, skillId, scope,
    title: 'Original method', description: 'Original scope description', body: 'Exact method 🙂'.repeat(10000), applicability: 'Only original workspace', sourceResultId: 'accepted-result' })
  const proposed = (await old.getSkill('active-method', scope))!
  await old.validateSkill({ commandId: 'validate-active', skillId: 'active-method', scope, version: 1, contentHash: proposed.versions[0]!.contentHash,
    resultId: 'accepted-result', explanation: 'Observed original verified result', artifactRefs: ['artifact-original'] })
  await old.putProjectFact({ id: 'fact-one', scope, text: 'Long exact fact 🚀'.repeat(5000), sourceResultId: 'accepted-result' })
  await old.putPreference({ id: 'preference-one', scope, text: 'Original preference', applicability: 'Original scope', userSourceRef: 'original-user-reference' })
  const capture = await captureLocalLegacy(storage), f = await target(t)
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot, { id: 'knowledge-upgrade', owner: 'alice', members: {} }))
  await applyLegacyMigration(f.files, f.transactions, plan)
  await withSnapshot(f.files, async snapshot => {
    const index = JSON.parse((await f.files.read(snapshot, 'knowledge/legacy-index.json'))!)
    assert.equal(index.entries.length, 4)
    const catalog = JSON.parse((await f.files.read(snapshot, 'technical/skills/catalog.json'))!)
    assert.equal(catalog.entries.length, 1)
    assert.equal(catalog.entries[0].name, 'servant-active-method')
    assert.deepEqual(catalog.entries[0].scope, scope)
    assert.equal(catalog.entries[0].activeVersion, 1)
    assert.equal(plan.manifest.issues.some(issue => issue.includes('Not a native skill definition')), false)
    for (const entry of index.entries) {
      assert.deepEqual(entry.scope, scope)
      assert.deepEqual(JSON.parse((await f.files.read(snapshot, entry.path))!), await storage.get(entry.sourceKey))
    }
    assert.equal(await f.files.read(snapshot, 'skills/default/workspace-one/active-method/SKILL.md'), await old.getSkillBody('servant-active-method', scope))
    assert.equal(await f.files.read(snapshot, 'skills/default/workspace-one/candidate-method/SKILL.md'), undefined)
  })
  assert.ok(plan.manifest.pendingAdapters.includes('native-knowledge-provider-registration'), 'physical migration is not claimed as native registration')
})

test('migration: missing physical reconciliation holds only unresolved native work without creating wake files', async t => {
  const old = await oldLocal(), captured = await captureLocalLegacy(old.storage), f = await target(t)
  const plan = await withSnapshot(f.files, snapshot => prepareActualMigration(captured, f.files, snapshot, { id: 'unconfirmed-owner', owner: 'alice', members: { assistant: 'alice' } }))
  assert.equal(plan.manifest.tasks[0]!.continuation, 'unresolved')
  assert.ok(plan.manifest.pendingAdapters.includes('native-ownership:one:assistant'))
  assert.equal(plan.changes.some(change => change.path.startsWith('state/') || change.path.endsWith('/Inbox.md')), false)
  assert.equal(captured.tasks[0]!.continuation, 'running', 'captured original facts were not mutated')
  const wrongGeneration = await withSnapshot(f.files, snapshot => prepareActualMigration(captured, f.files, snapshot, { id: 'wrong-generation', owner: 'alice', members: { assistant: 'alice' }, nativeOwnershipReconciled: { assistant: captured.tasks[0]!.participants[0]!.nativeExecutions!.map(execution => ({ executionId: execution.executionId, generation: execution.generation + 1, settled: true })) } }))
  assert.equal(wrongGeneration.manifest.tasks[0]!.continuation, 'unresolved')
})

test('migration: actual old finalizer archive and cleanup retain historical source objects through exact sourceHead reads', async t => {
  const original = await oldGit(false, true), current = await target(t), historical = await target(t)
  assert.ok(original.archive)
  for (const [target, rows] of [[current, original], [historical, original.archive.prior]] as const) {
    await withSnapshot(target.files, snapshot => target.files.commit(snapshot, rows.map(([path, content]) => ({ path: path.replace(/^dss-coop\//, ''), content })), 'Replay exact old finalizer fixture'))
  }
  const readPaths: string[] = []
  const files = Object.create(current.files) as LocalFiles
  files.readBytes = async (snapshot, path) => {
    if (snapshot.revision === (await withSnapshot(historical.files, s => Promise.resolve(s.revision)))) { readPaths.push(path); return historical.files.readBytes(snapshot, path) }
    return current.files.readBytes(snapshot, path)
  }
  const capture = await withSnapshot(current.files, snapshot => captureGitLegacy(files, snapshot, { at: async head => {
    assert.equal(head, original.archive!.head); return historical.files.snapshot()
  } }))
  assert.equal(capture.tasks.length, 1)
  assert.equal(capture.tasks[0]!.continuation, 'complete')
  assert.ok(readPaths.length > 0)
  assert.ok(readPaths.every(path => path.startsWith('tasks/') || path.startsWith('status/tasks/')))
  const destination = await target(t)
  const plan = await withSnapshot(destination.files, snapshot => prepareLegacyMigration(capture, destination.files, snapshot, { id: 'completed-git-archive', owner: 'alice', members: {} }))
  await applyLegacyMigration(destination.files, destination.transactions, plan)
  assert.equal(plan.changes.some(change => change.path.startsWith('state/') || change.path.endsWith('/Inbox.md')), false)
  for (const path of readPaths) {
    const originalBody = original.archive!.prior.find(([key]) => key === 'dss-coop/' + path)![1]
    await withSnapshot(destination.files, async snapshot => assert.equal(Buffer.from(await readMigratedReference(destination.files, snapshot, plan.manifest, 'dss-coop/' + path + '?revision=' + original.archive!.head)).toString(), originalBody))
  }
})

test('migration: repeated artifact IDs retain task-qualified references rather than silently selecting another task body', async t => {
  const old = await oldLocal(), capture = await captureLocalLegacy(old.storage), second = structuredClone(capture.tasks[0]!)
  second.id = 'two'
  const task = second.original as any
  task.id = 'two'
  task.reports['handoff-result'].artifacts[0].path = '/authorized-fixture/second.bin'
  task.reports['handoff-result'].artifacts[0].sha256 = sha('second file')
  capture.tasks.push(second)
  const f = await target(t), plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot, { id: 'task-scoped-artifacts', owner: 'alice', members: { assistant: 'alice' }, artifacts: [
    { sourcePath: '/authorized-fixture/result.bin', bytes: Buffer.from('actual file') }, { sourcePath: '/authorized-fixture/second.bin', bytes: Buffer.from('second file') },
  ] }))
  await applyLegacyMigration(f.files, f.transactions, plan)
  assert.equal(plan.manifest.references['artifact-1'], undefined)
  for (const [taskId, expected] of [['one', 'actual file'], ['two', 'second file']]) await withSnapshot(f.files, async snapshot =>
    assert.equal(Buffer.from(await readMigratedReference(f.files, snapshot, plan.manifest, 'legacy-task/' + taskId + '/artifact-1')).toString(), expected))
})

test('migration: real legacy Git skill writer preserves original native identity and participant scope without Local version fabrication', async t => {
  const source = await target(t), original = await oldGit()
  await withSnapshot(source.files, snapshot => source.files.commit(snapshot, original.map(([path, content]) => ({ path: path.replace(/^dss-coop\//, ''), content })), 'Replay original scoped Git skill'))
  const capture = await withSnapshot(source.files, snapshot => captureGitLegacy(source.files, snapshot)), f = await target(t)
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot, { id: 'git-skill-scope', owner: 'alice', members: {} }))
  await applyLegacyMigration(f.files, f.transactions, plan)
  const sourceEntry = capture.records.find(record => /^knowledge\/[^/]+\/skill\/.+\/source.json$/.test(record.key))!
  const sourcePath = 'dss-coop/' + sourceEntry.key.slice(0, -'/source.json'.length), body = capture.texts.find(item => item.ref === sourcePath)!.text
  await withSnapshot(f.files, async snapshot => {
    const artifact = plan.changes.find(change => change.path.endsWith('/legacy-git.json'))!
    const migrated = JSON.parse((await f.files.read(snapshot, artifact.path))!)
    assert.equal(migrated.body, body); assert.equal(migrated.name, 'coop-' + sha(sourcePath).slice(0, 16))
    assert.equal(migrated.participantId, sourceEntry.key.split('/')[1]); assert.equal(migrated.activeVersion, undefined)
    assert.deepEqual(migrated.source.metadata, JSON.parse(Buffer.from(sourceEntry.bytes).toString()))
  })
  const ctx = new Context(), plugin = await ctx.plugin(SkillRegistry), agent = {} as Agent, scoped = createScope(ctx, agent)
  const provider = installFrameworkSkillProvider(scoped.ctx, agent, f.files, { legacyGitParticipants: [sourceEntry.key.split('/')[1]!] })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const registry = ctx.get('skills')!, name = 'coop-' + sha(sourcePath).slice(0, 16)
    assert.deepEqual(await registry.list(), [], 'no global migration leakage')
    assert.equal((await registry.list({ scope: agent }))[0]?.name, name)
    assert.equal((await registry.get(name, { scope: agent }))?.content, body)
  } finally { await provider.dispose(); await scoped.dispose(); await plugin.dispose() }
})

test('migration: two real legacy user waits receive independent answers; later answer uses R3 without resetting resumed work', async t => {
  const old = await fixture('Original two-child request'), planner = await old.bind('plan')
  assert.equal((await old.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Two original questions', children: [childSpec('a'), childSpec('b')] }, planner.source)).status, 'applied')
  for (const id of ['a', 'b']) {
    const worker = await old.bind('dispatch', id)
    assert.equal((await old.execute({ type: 'execution.report', report: { resultId: 'wait-result-' + id, assignmentVersion: 1, outcome: 'wait', summary: 'Need original decision', artifacts: [], evidence: [], frontier: 'Wait for source',
      wait: { id: 'wait-' + id, kind: 'user', reason: 'Original decision ' + id, condition: 'User answers', resume: 'Continue ' + id, question: 'Which original source for ' + id + '?' } } }, worker.source)).status, 'applied')
  }
  const capture = await captureLocalLegacy(old.storage), f = await target(t)
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot, { id: 'two-original-waits', owner: 'alice', members: { assistant: 'alice' } }))
  await applyLegacyMigration(f.files, f.transactions, plan)
  const input = { manifestPath: plan.manifestPath, oldTaskId: 'one', member: 'alice' }
  const first = await answerLegacyTask(f.files, f.transactions, 'answer-a', { ...input, waitId: 'wait-a', answer: 'Source A' })
  const root = 'task-runs/' + first.taskId + '/alice'
  const progressed = [{ path: root + '/Plan.md', content: 'NEW PLAN: do not reset' }, { path: root + '/Planner_Memory.md', content: 'NEW MEMORY' }, { path: root + '/workers/a/notes.md', content: 'NEW WORKER CHECKPOINT' }]
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, progressed, 'Real resumed progress'))
  await withSnapshot(f.files, async snapshot => {
    const manifest = JSON.parse((await f.files.read(snapshot, plan.manifestPath))!)
    assert.equal(manifest.tasks[0].memberContinuations[0].continuation, 'running')
    assert.deepEqual(manifest.tasks[0].memberContinuations[0].waits.map((wait: any) => wait.id), ['wait-b'])
  })
  const secondInput = { ...input, waitId: 'wait-b', answer: 'Source B' }
  await answerLegacyTask(f.files, f.transactions, 'answer-b', secondInput)
  const revision = await withSnapshot(f.files, snapshot => Promise.resolve(snapshot.revision))
  await answerLegacyTask(f.files, f.transactions, 'answer-b', secondInput)
  assert.equal(await withSnapshot(f.files, snapshot => Promise.resolve(snapshot.revision)), revision)
  await withSnapshot(f.files, async snapshot => {
    for (const change of progressed) assert.equal(await f.files.read(snapshot, change.path), change.content)
    assert.equal(await f.files.read(snapshot, 'state/alice/' + first.taskId + '/Planner_Foreground'), '')
    const task = JSON.parse((await f.files.read(snapshot, 'tasks/' + first.taskId + '.json'))!)
    assert.ok((await f.files.read(snapshot, task.sourcePath))?.includes('Source B'))
    const manifest = JSON.parse((await f.files.read(snapshot, plan.manifestPath))!)
    assert.deepEqual(manifest.tasks[0].memberContinuations[0].waits, [])
  })
  await assert.rejects(answerLegacyTask(f.files, f.transactions, 'second-command-same-answer', secondInput), /not pending/)
})

test('migration: original configuration/resource waits keep the existing user-answer capability and displayed reason', async t => {
  for (const kind of ['configuration', 'resource'] as const) {
    const old = await oldLocal(kind), capture = await captureLocalLegacy(old.storage), f = await target(t)
    assert.equal(capture.tasks[0]!.continuation, 'wait-user')
    assert.equal(capture.tasks[0]!.waits?.[0]?.question, 'Original wait reason')
    assert.equal((capture.tasks[0]!.waits?.[0]?.original as any).kind, kind)
    const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot, { id: 'legacy-' + kind, owner: 'alice', members: { assistant: 'alice' } }))
    await applyLegacyMigration(f.files, f.transactions, plan)
    const result = await answerLegacyTask(f.files, f.transactions, 'answer-' + kind, { manifestPath: plan.manifestPath, oldTaskId: 'one', member: 'alice', waitId: 'wait-1', answer: 'Original condition is now satisfied' })
    assert.ok(result.taskId)
  }
})
