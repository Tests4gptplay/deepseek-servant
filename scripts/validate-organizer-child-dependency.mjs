import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { evidence } from './test-support/dsh-sdk-runtime.mjs'
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { paths, taskInitializationFiles } = await import('../src/framework/task-files.ts')
const { frameworkRolePrompt } = await import('../src/framework/role-prompts.ts')
const { workerRolePrompt } = await import('../src/framework/worker-prompt.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-organizer-dependency-'))
const files = new PhysicalLocalFiles(root)
const overallGoal = 'Deliver the verified combined outcome for the user.'
const parent = { version: 1, taskId: '10000000-0000-4000-8000-000000000111', route: 'O', owner: 'O', members: ['O', 'A', 'B'], status: 'running', sourcePath: 'tasks/10000000-0000-4000-8000-000000000111_O.md', archiveFolder: 'dependency-package_10000000-0000-4000-8000-000000000111' }
const sources = []
const read = async file => { const view = await files.snapshot(); try { return await files.read(view, file) } finally { await view.release() } }
const task = async id => JSON.parse(await read(paths.task(id)))
const notifications = async (t, name, snapshot) => (await files.listDirectory(snapshot, paths.state(t.owner, t.taskId))).filter(row => row.path.split('/').at(-1).startsWith(name + '_')).map(row => row.path)
function role(t, name) {
  const registered = new Map(), agent = { id: name + '-agent-' + t.taskId, session: {} }
  const ctx = { on: () => () => {}, effect: () => {}, systemPrompt: { section() {} }, tools: { register: value => registered.set(value.name, value) } }
  const binding = { role: name, owner: t.owner, taskId: t.taskId, lifecycleId: t.lifecycleId, member: t.owner, workId: 'test-' + name + '-' + t.taskId, executionId: 'execution-' + name + '-' + t.taskId }
  installFrameworkRoleTools(ctx, agent, binding, { files, physicalSignalSources: async () => sources,
    transact: async () => { throw new Error('Unexpected generic transaction in physical fixture') },
    notifications: async snapshot => notifications(t, name, snapshot),
    claimNotifications: async () => {
      const snapshot = await files.snapshot()
      try {
        const pending = await notifications(t, name, snapshot)
        for (const file of pending) { const info = await files.fileInfo(file); sources.push({ path: file, version: info.version }); await files.deleteObserved(file, info.version) }
        return { signals: pending }
      } finally { await snapshot.release() }
    }, onError: () => {} })
  let callId = 0
  return async (tool, input) => { assert.ok(registered.has(tool), 'registered tool ' + tool); return registered.get(tool).execute(input, { agent, callId: tool + '-' + ++callId, signal: new AbortController().signal, concludeTurn() {} }) }
}
async function dispatch(o, objectiveId, member, plan) {
  const view = await o('dss_snapshot', {})
  await o('dss_planner_dispatch', { snapshotId: view.snapshotId, objectiveId, member, route: 'P', plan, decision: 'O directs ' + objectiveId + ' to ' + member + ': ' + plan })
  const current = await task(parent.taskId)
  return task(current.children.find(row => row.objectiveId === objectiveId).taskId)
}
async function completedResult(child, content) {
  const p = role(child, 'Planner')
  await p('dss_claim', {})
  const view = await p('dss_snapshot', {})
  const result = paths.member(child.taskId, child.owner) + '/Reply.md'
  await p('dss_record', { snapshotId: view.snapshotId, path: result, text: content, append: false })
  await p('dss_complete', { snapshotId: view.snapshotId, acceptance: 'Checked the actual objective result.', resultPaths: [result] })
  return result
}
try {
  await files.replace(paths.task(parent.taskId), JSON.stringify(parent))
  await files.replace(parent.sourcePath, 'Task ID: ' + parent.taskId + '\n' + overallGoal + '\nPackage has two independent outcomes; B needs A\'s actual result.')
  for (const change of taskInitializationFiles(parent)) await files.replace(change.path, change.content)
  const o = role(parent, 'Organizer')
  await o('dss_claim', {})
  const a = await dispatch(o, 'upstream', 'A', overallGoal + ' Produce the independent upstream result.')
  let view = await o('dss_snapshot', {})
  const note = paths.run(parent.taskId) + '/Organizer_Note.md'
  await o('dss_record', { snapshotId: view.snapshotId, path: note, text: 'Dependency: upstream A -> target B; purpose: B consumes A actual findings. B waits; upstream running. Next: inspect A result, then dispatch B.\n', append: true })
  assert.deepEqual((await task(parent.taskId)).children.map(row => row.objectiveId), ['upstream'])
  const aReply = 'Verified upstream result: ALPHA.\nFurther use: incorporate this finding into the final combined outcome.'
  const aResult = await completedResult(a, aReply)
  assert.equal((await task(a.taskId)).status, 'complete')
  const claim = await o('dss_claim', {})
  assert.ok(claim.signals.includes(paths.state(parent.owner, parent.taskId) + '/Organizer_Child_' + a.taskId), 'actual upstream completion notified parent O')
  const aMeta = await o('dss_read', { snapshotId: claim.snapshotId, path: paths.task(a.taskId) })
  assert.equal(JSON.parse(aMeta.text).status, 'complete')
  assert.deepEqual(JSON.parse(aMeta.text).resultPaths, [aResult])
  const verified = await o('dss_read', { snapshotId: claim.snapshotId, path: aResult })
  assert.equal(verified.text, aReply)
  assert.ok(verified.text.includes('Further use:'))
  assert.ok(!verified.text.includes('target B') && !verified.text.includes('Task B'), 'A ordinary result does not know or contact sibling B')
  await o('dss_record', { snapshotId: claim.snapshotId, path: note, text: 'Dependency progress: upstream ' + a.taskId + ' complete, verified ' + aResult + ' = ALPHA; now dispatch target B.\n', append: true })
  const material = 'Verified finding for this objective: ALPHA.'
  const b = await dispatch(o, 'target', 'B', overallGoal + ' Produce independent target outcome using ' + material)
  const bPlanner = role(b, 'Planner')
  const bClaim = await bPlanner('dss_claim', {})
  assert.ok(bClaim.signals.includes(paths.state('B', b.taskId) + '/Planner_Inbox'), 'target received its own actual input signal')
  const received = await bPlanner('dss_read', { snapshotId: bClaim.snapshotId, path: paths.inbox(b.taskId, 'B') })
  assert.ok(received.text.includes(material), 'B receives only needed verified material in its own task input')
  assert.ok(received.text.includes(overallGoal), 'B retains the exact complete user goal in its own task input')
  assert.ok(!received.text.includes(a.taskId) && !received.text.includes(aResult) && !received.text.includes('Upstream Task'), 'B input does not reveal A identity, result path or sibling existence')
  const bSource = await read(b.sourcePath)
  assert.ok(!bSource.includes(a.taskId) && !bSource.includes(aResult) && !bSource.includes('Upstream Task'), 'B original requirement also hides A identity and sibling path')
  assert.ok(bSource.includes(overallGoal), 'B original requirement retains the full goal without reading the parent O source')
  assert.ok((await read(note)).includes('upstream A -> target B'))
  assert.ok((await read(note)).includes(a.taskId) && (await read(note)).includes(aResult), 'only O coordination record retains upstream provenance')
  assert.ok((await read(paths.run(parent.taskId) + '/Dispatch.md')).includes('target'))

  // An already open target gets only an O-directed supplement, not a peer-to-peer transfer.
  const open = await dispatch(o, 'open-target', 'B', overallGoal + ' Work on this objective; Organizer may supply additional material.')
  const openPlanner = role(open, 'Planner')
  await openPlanner('dss_claim', {})
  const same = await dispatch(o, 'open-target', 'B', 'Supplement this open target with ' + material)
  assert.equal(same.taskId, open.taskId)
  const supplementClaim = await openPlanner('dss_claim', {})
  assert.ok(supplementClaim.signals.includes(paths.state('B', open.taskId) + '/Planner_Inbox'))
  const supplemented = await openPlanner('dss_read', { snapshotId: supplementClaim.snapshotId, path: paths.inbox(open.taskId, 'B') })
  assert.ok(supplemented.text.includes(material))
  assert.ok(supplemented.text.includes(overallGoal))
  assert.ok(!supplemented.text.includes(a.taskId) && !supplemented.text.includes(aResult) && !supplemented.text.includes('Upstream Task'))
  assert.ok((await read(open.sourcePath)).includes(material))
  assert.ok((await read(open.sourcePath)).includes(overallGoal))
  assert.ok(!(await read(open.sourcePath)).includes(a.taskId) && !(await read(open.sourcePath)).includes(aResult))
  await completedResult(open, 'Open target completed.')
  await assert.rejects(() => dispatch(o, 'open-target', 'B', 'Try to reopen completed child.'), /completed child Task/)
  assert.equal((await task(open.taskId)).status, 'complete')
  assert.equal((await task(parent.taskId)).status, 'running')
  const prompt = frameworkRolePrompt('Organizer')
  assert.ok(prompt.includes('Coordinate dependencies among this O package'))
  assert.ok(prompt.includes('complete true user goal'))
  assert.ok(prompt.includes("not a verbatim copy of a whole package that exposes a sibling's identity"))
  assert.ok(prompt.includes('do not read a parent O package to learn about sibling packages'))
  const plannerPrompt = frameworkRolePrompt('Planner')
  assert.ok(plannerPrompt.includes('Do not read parent O metadata/source/records or siblings'))
  assert.ok(plannerPrompt.includes('complete true user goal'))
  assert.ok(!plannerPrompt.includes('then tasks/<parent.taskId>.json'))
  assert.ok(plannerPrompt.includes('Workers do not contact or assign other separately assigned children'))
  assert.ok(plannerPrompt.includes("state the concrete need in this P Task's ordinary result/acceptance records"))
  assert.ok(workerRolePrompt.includes('Do not follow parent.taskId into the parent package or read sibling child records'))
  assert.ok(workerRolePrompt.includes('Do not relay into a separately assigned child'))
  assert.ok(workerRolePrompt.includes('A different successorId alone neither proves nor forbids inheritance'))
  console.log(JSON.stringify({ status: 'passed', scope: 'Actual registered DSS Zod tools and PhysicalLocalFiles: O record and dispatch, A Planner result/complete, O claim/read/verify and target-only B input or open-child supplement without A identity/path, B claim/read, terminal-child rejection. Claim notification service is a controlled port; no native Agent, real model, GUI, Windows or remote Git is asserted.', aTaskId: a.taskId, bTaskId: b.taskId, resultPath: aResult, evidence: evidence() }, null, 2))
} finally { await files.close(); await fs.rm(root, { recursive: true, force: true }) }
