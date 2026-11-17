// Real rc.5 AgentLoop, ToolRuntime/run_code, Recorder tool and physical file queue.
// The model and fixed-program PTC execution substrate are controlled ports. The
// SDK, not this test, aborts the inner signal when run_code completes normally.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { evidence } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'

const { AgentRegistry } = await import('@deepseek-ai/dsh-agent')
const { SessionStore } = await import('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { PtcRuntime } = await import('@deepseek-ai/dsh-ptc-runtime')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local')
const { WorkingDirectoryService } = await import('@deepseek-ai/dsh-working-directory')
const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { publishPhysicalRecorder } = await import('../src/framework/physical-recorder-publication.ts')
const { FrameworkSkillCacheRefresh } = await import('../src/framework/skill-cache-refresh.ts')
const { createFrameworkSkillIndexInitialization, frameworkSkillIndexPath, installFrameworkSkillProvider, readFrameworkSkillCatalog } = await import('../src/framework/skills.ts')
const { paths, encodeJson } = await import('../src/framework/task-files.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')

const hash = value => createHash('sha256').update(value).digest('hex')
const skillPath = 'skills/catalog-lifetime/SKILL.md'
const skillText = '---\nname: catalog-lifetime\ndescription: Published Recorder method\n---\n# Method\nPreserve this exact contribution.\n'
const checks = [], observations = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const read = (files, path) => withSnapshot(files, snapshot => files.read(snapshot, path))
const until = async (name, action) => {
  const deadline = Date.now() + 20000
  for (;;) { const result = await action(); if (result) return result; if (Date.now() > deadline) throw new Error('Watchdog: ' + name); await new Promise(resolve => setTimeout(resolve, 5)) }
}
async function hold(files, path) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  const operation = files.updateAsync(path, async () => { entered.resolve(); await released.promise; return { value: undefined } })
  await entered.promise
  return { release: () => released.resolve(), operation }
}
async function fixture(root) {
  const files = new PhysicalLocalFiles(join(root, 'files')), taskId = randomUUID()
  const task = { version: 1, taskId, route: 'P', owner: 'A', members: ['A'], status: 'complete',
    sourcePath: 'tasks/catalog_lifetime_P.md', archiveFolder: 'catalog_lifetime_' + taskId }
  await files.replace(paths.task(taskId), encodeJson(task))
  await files.replace(task.sourcePath, 'Task ID: ' + taskId + '\nOriginal completed objective.\n')
  await files.replace(paths.run(taskId) + '/Recorder_Note.md', 'Original Recorder progress.\n')
  await files.replace(paths.cache(taskId), encodeJson({ version: 1, links: [] }))
  await files.replace(frameworkSkillIndexPath, encodeJson({ version: 1, entries: [] }))
  const input = { outputs: [{ path: paths.archive(task) + '/records.md', text: '# Completed Task\nOriginal objective completed.\n' }, { path: skillPath, text: skillText }], retainedPaths: [] }
  await fs.writeFile(join(root, 'fixture.json'), JSON.stringify({ task, input }))
  return { root, files, task, input }
}

// This boundary executor accepts only the two exact test-generated programs.
// It does not create or alter an AbortController, simulate a tool result, inject
// an I/O error, or claim Node subprocess/sandbox implementation coverage.
class FixedProgramRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'controlled-fixed-program'
  resolve(request) { return { ...request, cwd: request.cwd, timeoutMs: null } }
  async run(spec) {
    const match = /^return await tools\.(dss_snapshot|dss_recorder_save)\((.*)\);$/.exec(spec.program)
    assert(match, 'Only exact fixture programs enter the controlled substrate')
    return { logs: [], value: await spec.bindings[0].functions[match[1]](JSON.parse(match[2])) }
  }
}
async function nativeRecorder(f, mode, cache, ctx, observeSignal) {
  let snapshot, result, stage = 0
  const sessionId = 'catalog-recorder-' + randomUUID(), providerName = 'catalog-wire-' + randomUUID()
  class Model extends LlmAdapter {
    async *stream() {
      assert(stage < 2, 'The successful final save ends the native turn')
      const name = stage++ === 0 ? 'dss_snapshot' : 'dss_recorder_save'
      const input = name === 'dss_snapshot' ? {} : { ...f.input, snapshotId: snapshot.snapshotId }
      const call = mode === 'ptc' ? { name: 'run_code', input: { code: 'return await tools.' + name + '(' + JSON.stringify(input) + ');', description: 'Save the completed Recorder archive.' } } : { name, input }
      yield { type: 'tool-call-delta', index: 0, name: call.name, id: name, argumentsDelta: JSON.stringify(call.input) }
      yield { type: 'finish', reason: 'tool-calls' }
    }
  }
  ctx.llm.registerAdapter([providerName], new Model())
  const stop = ctx.on('session/event', (session, event) => {
    if (String(session.id) !== sessionId) return
    const content = event.type === 'tool/result' ? event.data.message.content : event.type === 'tool/ptc-dispatch' ? event.data.content : []
    for (const block of content) if (block.type === 'text') {
      let value; try { value = JSON.parse(block.text) } catch { continue }
      if (value?.snapshotId) snapshot = value
      if (value?.saved) result = value
    }
  })
  const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: providerName, model: 'controlled' },
    setup(scope, agent) {
      scope.tools.presentAs(mode)
      scope.on('tools/pre-execute', (exec, next) => { if (exec.name === 'dss_recorder_save') observeSignal(exec.signal); return next() })
      installFrameworkRoleTools(scope, agent, { role: 'Recorder', owner: f.task.owner, taskId: f.task.taskId,
        workId: 'recorder-' + f.task.taskId, executionId: sessionId }, { files: f.files, notifications: async () => [],
        claimNotifications: async () => ({ signals: [] }), onError: error => { throw error },
        transact: async () => { throw new Error('Physical Recorder must not use a generic transaction') },
        skillsChanged: () => cache.request() })
    } })
  try {
    ctx.agents.withInitiator(handle.agent, () => handle.agent.followup({ id: 'input-' + sessionId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Save the completed Task records and supplied skill.' }] }))
    await handle.agent.whenIdle()
    const events = handle.agent.session.snapshotEvents()
    check(mode + ': actual native turn completed normally', events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind, 'completed')
    assert(result?.saved, JSON.stringify(events.filter(event => event.type === 'tool/result').map(event => event.data)))
    return result
  } finally { stop(); await handle.dispose() }
}

if (process.argv[2] === '--interrupt-child') {
  const root = process.argv[3], { task, input } = JSON.parse(await fs.readFile(join(root, 'fixture.json'), 'utf8'))
  const files = new PhysicalLocalFiles(join(root, 'files')), commandId = 'interrupted-original-save'
  await hold(files, frameworkSkillIndexPath)
  await hold(files, paths.archive(task) + '/records.md')
  void publishPhysicalRecorder(files, { ...input, commandId, taskId: task.taskId, owner: task.owner, bases: new Map() }, () => {}, async () => {})
    .catch(error => { process.send?.({ error: String(error) }); process.exitCode = 1 })
  const resultPath = paths.run(task.taskId) + '/.recorder-handoff/' + hash(commandId) + '/skill-results/' + hash(skillPath) + '.json'
  await until('actual persisted successful skill result', async () => JSON.parse(await read(files, resultPath) ?? '{}').result?.published)
  process.send?.({ published: true })
  setInterval(() => {}, 1000)
} else {
  const expectOld = process.argv.includes('--expect-old'), root = await fs.mkdtemp(join(tmpdir(), 'dss-recorder-catalog-lifetime-'))
  let sdk, cache, scope, provider, jp, lp
  const opened = [], held = []
  try {
    const workspace = join(root, 'workspace'); await fs.mkdir(workspace)
    sdk = await openDshStorageFixture(join(root, 'storage'), join(root, 'locator')); const ctx = sdk.ctx
    new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx); new LlmRuntime(ctx)
    new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new FixedProgramRuntime(ctx); new SkillRegistry(ctx)
    new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 1048576 }); new WorkingDirectoryService(ctx, { defaultDirectory: workspace })
    jp = ctx.plugin(jsonl, { root: join(root, 'sessions'), compression: 'none' }); await jp.await()
    lp = ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 }); await lp.await()
    for (const mode of ['native', 'ptc']) {
      const f = await fixture(join(root, mode)); opened.push(f.files)
      const reader = { id: 'reader-' + mode }; scope = createScope(ctx, reader)
      provider = installFrameworkSkillProvider(scope.ctx, reader, f.files); await provider.settleRegistration()
      const errors = []; cache = new FrameworkSkillCacheRefresh(f.files, () => [provider], error => errors.push(error))
      check(mode + ': initial real native catalog is empty', (await ctx.skills.list({ scope: reader })).length, 0)
      const blocker = await hold(f.files, frameworkSkillIndexPath); held.push(blocker)
      let signal
      const result = await nativeRecorder(f, mode, cache, ctx, value => signal = value)
      check(mode + ': definition published before handoff', await read(f.files, skillPath), skillText)
      check(mode + ': own Cleaner already notified while catalog waits', await read(f.files, paths.state('A', f.task.taskId) + '/Cleaner'), '')
      check(mode + ': handoff accurately reports unfinished catalog', result.skillIssues.some(issue => issue.includes('unfinished at the archive handoff')), true)
      check(mode + ': real SDK signal state after normal completion and dispose', signal.aborted, mode === 'ptc')
      blocker.release(); await blocker.operation
      const retentionPath = paths.archive(f.task) + '/retention.json'
      await until(mode + ' actual asynchronous catalog settlement', async () => !(JSON.parse(await read(f.files, retentionPath)).skillPublication?.issues ?? []).some(issue => issue.includes('unfinished at the archive handoff')))
      await cache.settled()
      check(mode + ': cache refresh errors', errors, [])
      const discovered = (await ctx.skills.list({ scope: reader })).some(skill => skill.name === 'catalog-lifetime')
      check(mode + ': real native discovery matches selected candidate', discovered, !(expectOld && mode === 'ptc'))
      observations.push({ case: mode, completedNormally: true, signalAborted: signal.aborted, saved: result.saved, discovered })
      await cache.close(); cache = undefined; await provider.dispose(); provider = undefined; await scope.dispose(); scope = undefined
    }
    const cold = await fixture(join(root, 'cold')); opened.push(cold.files)
    const child = fork(fileURLToPath(import.meta.url), ['--interrupt-child', cold.root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let childOutput = ''; child.stdout.on('data', bytes => childOutput += bytes); child.stderr.on('data', bytes => childOutput += bytes)
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child publication watchdog: ' + childOutput)), 20000)
        child.once('message', message => { clearTimeout(timer); message.published ? resolve() : reject(new Error(JSON.stringify(message))) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited before published result: ' + childOutput)) })
      })
      child.kill('SIGTERM'); check('cold: actual child process interrupted', (await exited).signal, 'SIGTERM')
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited }
    check('cold: confirmed definition survives process exit', await read(cold.files, skillPath), skillText)
    const publishedVersion = (await cold.files.fileInfo(skillPath)).version
    check('cold: valid earlier catalog still omits definition', (await readFrameworkSkillCatalog(cold.files)).length, 0)
    const initialization = await createFrameworkSkillIndexInitialization(cold.files, { run() { throw new Error('Local index initialization must not transact') } }, { missingOnly: true })()
    check('cold: real Host missing-only initialization does not repair a valid stale catalog', initialization.status, 'unchanged')
    const errors = [], reader = { id: 'cold-reader' }; scope = createScope(ctx, reader)
    provider = installFrameworkSkillProvider(scope.ctx, reader, cold.files); await provider.settleRegistration()
    cache = new FrameworkSkillCacheRefresh(cold.files, () => [provider], error => errors.push(error))
    await nativeRecorder(cold, 'native', cache, ctx, () => {})
    await until('cold asynchronous continuation', async () => expectOld || (await readFrameworkSkillCatalog(cold.files)).some(entry => entry.path === skillPath))
    await cache.settled()
    const discovered = (await ctx.skills.list({ scope: reader })).some(skill => skill.name === 'catalog-lifetime')
    check('cold: resumed discovery matches selected candidate', discovered, !expectOld)
    check('cold: exact definition preserved by continuation', await read(cold.files, skillPath), skillText)
    check('cold: confirmed definition is not rewritten', (await cold.files.fileInfo(skillPath)).version, publishedVersion)
    check('cold: catalog continuation has no cache error', errors, [])
    observations.push({ case: 'cold', processInterrupted: 'SIGTERM', initialization: initialization.status, resumed: true, discovered, definitionRewritten: false })
    console.log(JSON.stringify({ status: 'passed', expected: expectOld ? 'old defects observed' : 'corrected lifetime and continuation', checks, observations, root,
      scriptSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
      limits: 'Actual Linux files, per-file queue, SIGTERM, rc.5 AgentLoop/ToolRuntime/PTC dispatch/normal settlement and SkillRegistry. Controlled model, fixed-program PTC substrate, notification ports and seeded completed Task. No Node PTC subprocess/sandbox, full Host cleanup, Windows, live model or user incident claimed.', ...evidence() }, null, 2))
  } finally {
    for (const blocker of held) blocker.release()
    await Promise.allSettled(held.map(blocker => blocker.operation))
    await cache?.close(); await provider?.dispose(); await scope?.dispose(); await lp?.dispose(); await jp?.dispose()
    for (const files of opened) await files.close()
    await sdk?.close()
  }
}
