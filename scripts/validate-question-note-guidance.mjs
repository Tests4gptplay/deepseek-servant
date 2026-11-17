import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

// Current requirement: the asking AI records its question before asking and the
// user's answer and conclusion afterwards in its existing Note. Waiting for the
// human is normal, not an inactivity fault. Controlled calls below verify the
// actual prompt/record interfaces; they do not simulate model compliance.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map(), checks = []
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(sourceRoot.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const { questionNoteInstruction } = await import('../src/framework/question-note-prompt.ts')
const { frameworkRolePrompt, foregroundFullGuide, foregroundStorageRecoveryNote } = await import('../src/framework/role-prompts.ts')
const { foregroundCorePrompt, foregroundGuidePath } = await import('../src/framework/foreground-prompt.ts')
const { upgradeForegroundGuide } = await import('../src/framework/foreground-guide-upgrade.ts')
const { initializeRoleGuides } = await import('../src/framework/role-guides.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools, workerPaths } = await import('../src/framework/role-tools.ts')
const { ExecutionObservations } = await import('../src/framework/execution-observation.ts')
const { OBSERVATION_INTERVALS_MS } = await import('../src/framework/recovery.ts')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-question-note-'))
const files = new PhysicalLocalFiles(scratch), cleanups = [], generated = {}
const read = async file => { const snapshot = await files.snapshot(); try { return await files.read(snapshot, file) } finally { await snapshot.release() } }
const taskP = { version: 1, taskId: '10000000-0000-4000-8000-000000000001', route: 'P', owner: 'A', members: ['A'], status: 'running', sourcePath: 'tasks/question-record-p.md' }
const taskO = { ...taskP, taskId: '20000000-0000-4000-8000-000000000002', route: 'O', sourcePath: 'tasks/question-record-o.md' }
let callCount = 0
function install(binding) {
  const sections = [], tools = new Map([['ask_user_question', { original: true }]])
  const agent = { id: binding.executionId, session: { snapshotEvents: () => [] } }
  const ctx = { on: () => () => {}, effect: callback => cleanups.push(callback), systemPrompt: { section: section => sections.push(section) }, tools: { register: tool => tools.set(tool.name, tool) } }
  installFrameworkRoleTools(ctx, agent, binding, { files, transact: async () => { throw new Error('Unexpected generic transaction') }, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => { throw error } })
  return { sections, tools, call: (name, input) => tools.get(name).execute(input, { agent, callId: 'question-record-call-' + ++callCount, signal: new AbortController().signal }) }
}
let observations
try {
  for (const role of ['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper']) {
    const prompt = frameworkRolePrompt(role)
    generated[role] = prompt
    check(role + ' receives one question record instruction', prompt.split(questionNoteInstruction).length - 1, 1)
    check(role + ' records before asking', prompt.includes('Before asking the user a question, use dss_record'), true)
    check(role + ' records the received answer and conclusion', prompt.includes("After receiving the user's answer, record that answer and the resulting conclusion against the original question in the same Note"), true)
    check(role + ' checks questions at completion or handoff', prompt.includes('Before ending or handing off the work, check those question records'), true)
    check(role + ' treats human wait as normal', prompt.includes("Waiting for the user's answer is normal operation"), true)
  }
  check('No new numeric time, retry or limit rule beyond native -1 was introduced', /\d/.test(questionNoteInstruction.replaceAll('-1', '')), false)
  check('Infinite wait is conditional on declared native support', questionNoteInstruction.includes('schema exposes timeout and allows -1'), true)
  check('Legacy calls must not invent timeout parameter', questionNoteInstruction.includes('If the schema has no timeout parameter, call it as declared without adding that parameter'), true)
  check('Existing Foreground core takes priority over older guide', foregroundCorePrompt.includes('question records and waiting for user answers even if an older or customized guide says otherwise'), true)
  const full = foregroundFullGuide(), previous = full.replace(questionNoteInstruction + '\n', '')
  generated['Foreground-full'] = full
  check('New generated full guide has question instruction once', full.split(questionNoteInstruction).length - 1, 1)
  check('Exact former default gains current instruction', upgradeForegroundGuide(previous).text, full)
  check('Exact former default without storage suggestion gains both current rules', upgradeForegroundGuide(previous.replace('\n\n' + foregroundStorageRecoveryNote, '')).text, full)
  check('Current guide is idempotent', upgradeForegroundGuide(full).changedRules, 0)
  const custom = previous + '\n用户自己的补充，不可覆盖。\n'
  check('Customized guide retains all original bytes', upgradeForegroundGuide(custom).text, custom)
  check('Wholly custom guide remains untouched', upgradeForegroundGuide('用户自己的完整指南。').text, '用户自己的完整指南。')
  check('Blank custom guide remains blank', upgradeForegroundGuide('').text, '')
  const unreachableTransaction = { run: async () => { throw new Error('Unexpected generic transaction') } }
  check('Physical generated MD is created through existing initialization', (await initializeRoleGuides(files, unreachableTransaction)).status, 'created')
  check('Persisted generated MD matches current full guide', await read(foregroundGuidePath), full)
  await files.replace(foregroundGuidePath, previous)
  check('Physical exact former default migrates', (await initializeRoleGuides(files, unreachableTransaction)).status, 'migrated')
  check('Physical migrated MD matches current full guide', await read(foregroundGuidePath), full)
  await files.replace(foregroundGuidePath, custom)
  check('Physical custom guide is not changed', (await initializeRoleGuides(files, unreachableTransaction)).status, 'unchanged')
  check('Physical custom content remains exact', await read(foregroundGuidePath), custom)
  for (const task of [taskP, taskO]) {
    await files.replace('tasks/' + task.taskId + '.json', JSON.stringify(task))
    await files.replace(task.sourcePath, 'Original question context')
    await files.replace('task-runs/' + task.taskId + '/existing.md', 'Existing task directory')
  }
  const common = { owner: 'A', member: 'A', taskId: taskP.taskId }
  const worker = workerPaths(taskP.taskId, 'A', 'actual-child')
  const cases = [
    ['Foreground', { recordPath: 'conversation/Foreground_Cache.md' }, 'conversation/Foreground_Cache.md'],
    ['Organizer', { ...common, taskId: taskO.taskId }, 'task-runs/' + taskO.taskId + '/Organizer_Note.md'],
    ['Planner', { ...common }, 'task-runs/' + taskP.taskId + '/A/Plan_Note.md'],
    ['Worker', { ...common, workerId: 'actual-child', notePath: worker.notes, recordPath: worker.notes }, worker.notes],
    ['Recorder', { ...common }, 'task-runs/' + taskP.taskId + '/Recorder_Note.md'],
    ['Helper', { recordPath: 'debug/2026-11-10.md' }, 'debug/2026-11-10.md'],
    ['Worker', { recordPath: 'direct/actual-item/takeover.md', direct: { inputPath: 'direct/actual-item.md', signalPath: 'state/Worker_A_Direct_actual-item' } }, 'direct/actual-item/takeover.md'],
  ]
  for (const [role, extra, note] of cases) {
    const binding = { role, owner: 'A', workId: note, executionId: note, ...extra }, installed = install(binding)
    check(note + ' role prompt injection is current', installed.sections.find(section => section.name === 'deepseek-servant:framework-role').text, frameworkRolePrompt(role))
    check(note + ' native ask tool is unchanged', installed.tools.get('ask_user_question').original, true)
    await files.replace(note, 'Existing facts\n')
    const view = await installed.call('dss_snapshot', {})
    await installed.call('dss_record', { snapshotId: view.snapshotId, path: note, text: 'Question: Which destination should receive the result? Context: original task.\n', append: true })
    await installed.call('dss_record', { snapshotId: view.snapshotId, path: note, text: 'Answer to the destination question: the existing project folder. Conclusion: use that folder.\n', append: true })
    check(note + ' retains context, question, actual answer and conclusion in the same record', await read(note), 'Existing facts\nQuestion: Which destination should receive the result? Context: original task.\nAnswer to the destination question: the existing project folder. Conclusion: use that folder.\n')
    const injected = installed.sections.find(section => section.name === 'deepseek-servant:framework-binding').text
    check(note + ' actual supplied location is visible to AI', injected.includes(note), true)
  }
  const rows = new Map(), arranged = [], errors = [], listeners = new Set()
  let clock = 0, waiting = false
  const agent = { observe: () => ({ state: 'running', jobs: [], waitingForUser: waiting }), subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback) }, subscribeProgress: () => () => {} }
  observations = new ExecutionObservations({ get: async key => rows.get(key), set: async (key, value) => rows.set(key, value), list: async () => [...rows.values()] }, { arrange: async action => arranged.push(action) }, error => errors.push(error), () => clock)
  await observations.bind({ workId: 'actual-wait', executionId: 'actual-wait', role: 'Worker' }, agent)
  waiting = true; for (const listener of listeners) listener(); await observations.tick()
  clock += OBSERVATION_INTERVALS_MS.reduce((a, b) => a + b, 0); await observations.tick()
  check('Human wait survives the full existing observation cycle without probe/warning/restart', arranged.length, 0)
  waiting = false; for (const listener of listeners) listener(); await observations.tick()
  check('Answer does not trigger immediate stale fault', arranged.length, 0)
  check('Observation test has no errors', errors.length, 0)
  const sdkRoot = process.env.DSS_SDK_HOST_ROOT
  if (!sdkRoot || !path.isAbsolute(sdkRoot)) throw new Error('Set DSS_SDK_HOST_ROOT to the actual installed DSH Host dependency tree.')
  const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'))
  const askModule = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-tool-ask-user')).href)
  const nativeQuestions = [{ id: 'destination', question: 'Which destination?' }]
  for (const mode of ['legacy', 'timed']) {
    let tool, calls = []
    const nativeCtx = { tools: { register: value => { tool = value } }, userQuestions: { ask: async request => { calls.push({ method: 'ask', request }); return { answers: [{ id: 'destination', selected: [], custom: 'original folder' }] } }, askTimed: async () => { throw new Error('Infinite waiting must not call askTimed') } } }
    askModule.apply(nativeCtx, { mode })
    check(mode + ' exposes timeout only when supported', Object.hasOwn(tool.parameters.properties, 'timeout'), mode === 'timed')
    if (mode === 'timed') check('Actual native tool description allows -1', tool.parameters.properties.timeout.description.includes('Use -1 only when an answer is required before proceeding'), true)
    const args = { questions: nativeQuestions, ...(mode === 'timed' ? { timeout: -1 } : {}) }
    await tool.execute(args, { callId: 'native-question-call', signal: new AbortController().signal })
    check(mode + ' uses the original blocking ask branch', calls.map(call => call.method), ['ask'])
    check(mode + ' preserves the original questions', calls[0].request.questions, nativeQuestions)
  }
  const sdkManifest = JSON.parse(readFileSync(sdkRequire.resolve('@deepseek-ai/dsh-tool-ask-user/package.json'), 'utf8'))
  const output = process.env.DSS_QUESTION_GUIDANCE_EVIDENCE
  if (output) { await fs.mkdir(output, { recursive: true }); for (const [name, text] of Object.entries(generated)) await fs.writeFile(path.join(output, name + '.md'), text + '\n') }
  console.log(JSON.stringify({ status: 'passed', checks, actualAskToolVersion: sdkManifest.version, sourceHashes: Object.fromEntries(loaded), limits: 'Current generated and injected text, exact default guide migration, controlled tool registry with real dss_snapshot/dss_record and physical files, actual installed native ask tool dispatch with controlled answer service, and actual ExecutionObservations with controlled clock. No model compliance, actual remote Git transport, browser behavior, Windows or deployed Host claimed.' }, null, 2))
} finally {
  await observations?.dispose()
  for (const cleanup of cleanups) await cleanup()()
  await files.close()
  await fs.rm(scratch, { recursive: true, force: true })
  hooks.deregister()
}
