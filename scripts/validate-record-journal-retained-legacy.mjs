// Retained production recovery, exercised with records made by the frozen shipped
// RecordJournal/TaskRecords and migration producer. No call to retired page/read/search.
// Real temporary Linux files; this is not a user migration, Host UI or network test.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'

const { RecordJournal } = await import(new URL('application/record-journal.ts', sourceRoot))
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts', sourceRoot))
const { listLegacyArtifactReferences, legacyDeclaredArtifacts } = await import(new URL('framework/legacy-artifacts.ts', sourceRoot))
const { LEGACY_BASELINE, legacyMigratedTaskId } = await import(new URL('framework/legacy-record-export.ts', sourceRoot))
const { paths, encodeJson } = await import(new URL('framework/task-files.ts', sourceRoot))
const { prepareFrameworkSkillIndex, frameworkSkillIndexPath } = await import(new URL('framework/skills.ts', sourceRoot))
const hash = value => createHash('sha256').update(value).digest('hex')
const historical = readFileSync(new URL('./test-support/historical-55fe/installed-host.js', import.meta.url), 'utf8')
const historicalSha256 = '5a84b25b7619486ea98e7e11b140d02c0a3848e48008ac3cc2dc71a2a5a5d47a'
assert.equal(hash(historical), historicalSha256)
const journalStart = historical.indexOf('// src/application/record-journal.ts')
const journalEnd = historical.indexOf('// src/framework/legacy-artifacts.ts', journalStart)
assert.ok(journalStart >= 0 && journalEnd > journalStart)
const oldClasses = historical.slice(journalStart, journalEnd)
  .replace('import { createHash as createHash10 } from "node:crypto";', '')
  .replace('import { createHash as createHash11 } from "node:crypto";', '')
const old = new Function('createHash10', 'createHash11', oldClasses + '\nreturn {RecordJournal,TaskRecords,canonicalJson}')(createHash, createHash)
const producerStart = historical.indexOf('async function prepareLegacyMigration(')
const producerEnd = historical.indexOf('async function applyLegacyMigration(', producerStart)
assert.ok(producerStart >= 0 && producerEnd > producerStart)
const producer = historical.slice(producerStart, producerEnd)
const produce = new Function('identity','hash12','legacyDeclaredArtifacts','legacyMigratedTaskId','encodeJson','utf8','decode','paths','workerPaths','prepareFrameworkSkillIndex','frameworkSkillIndexPath',
  producer + '\nreturn prepareLegacyMigration')(
  value => value, hash, legacyDeclaredArtifacts, legacyMigratedTaskId, encodeJson, value => Buffer.from(value), value => Buffer.from(value).toString(), paths,
  () => { throw new Error('Paused historical Task must not construct a new Worker path in this recovery check') }, prepareFrameworkSkillIndex, frameworkSkillIndexPath)

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-retained-record-journal-'))
const at = '2026-01-01T00:00:00.000Z'
const artifact = { id: 'preserved-report-output', path: '/old-work/output.txt', description: 'Original report declaration' }
function inputTask() {
  const report = { resultId: 'result', assignmentVersion: 1, outcome: 'complete', summary: '', artifacts: [artifact], evidence: [],
    frontier: 'Original end', executionId: 'old-execution', childId: 'old-child', goalRevision: 1, receivedAt: at,
    disposition: 'unreviewed', commandId: 'old-report', sequence: 1 }
  // Put an actual surrogate pair across the naive first 64 KiB code-unit cut.
  // It is test data for the retained chunk format, never a new input-size gate.
  const prefix = old.canonicalJson(report).indexOf('"summary":""') + '"summary":"'.length
  assert.ok(prefix > 0 && prefix < 64 * 1024 - 1)
  report.summary = 'x'.repeat(64 * 1024 - 1 - prefix) + '😀' + 'y'.repeat(4 * 64 * 1024) + '完整尾部'
  const child = { id: 'old-child', title: 'Original worker', objective: 'Original report', inputArtifacts: [], acceptanceCriteria: [],
    dependsOn: [], writeScopes: [], resources: [], assignmentVersion: 1, goalRevision: 1, status: 'reported', progressSegments: 1 }
  const execution = { executionId: 'old-execution', taskId: 'old-task', role: 'worker', agentId: 'old-agent', sessionId: 'old-session',
    actionId: 'old-action', childId: child.id, assignmentVersion: 1, goalRevision: 1, generation: 1, state: 'closed',
    physicalState: 'stopped', ownedJobIds: [], writeScopes: [], resources: [], startedAt: at, observedAt: at }
  return { schemaVersion: 1, id: 'old-task', assistantId: 'old-assistant', revision: 1, workspace: { id: 'old-work', directory: '/old-work' },
    source: { kind: 'user', id: 'old-user' }, control: 'paused', phase: 'evaluating', goal: { revision: 1, request: 'Original request',
      objective: 'Restore original report', constraints: [], deliverables: [], acceptanceCriteria: [], sourceRef: 'old-message' },
    plan: { revision: 1, goalRevision: 1, strategy: 'Original strategy', childIds: [child.id] }, needsPlanning: false, priority: 0,
    children: { [child.id]: child }, executions: { [execution.executionId]: execution }, reports: { result: report },
    waits: {}, incidents: {}, pendingActions: {}, receipts: {}, decisions: [], createdAt: at, updatedAt: at }
}
function memoryStorage() {
  const rows = new Map()
  return { rows, get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)),
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }
}
async function seed(kind) {
  const task = inputTask(), storage = memoryStorage(), records = new old.TaskRecords(new old.RecordJournal(storage))
  const prepared = records.prepare(task)
  const reportWrite = prepared.writes.find(write => write.metadata.field === 'reports')
  assert.ok(reportWrite.text.length > 256 * 1024)
  assert.equal(reportWrite.text.charCodeAt(64 * 1024 - 1), 0xd83d)
  assert.equal(reportWrite.text.charCodeAt(64 * 1024), 0xde00)
  if (kind === 'persisted') {
    await records.write(prepared)
    storage.rows.set('task:' + task.id, prepared.root)
  } else storage.rows.set('task-staging/' + encodeURIComponent(task.id) + '/commit', prepared)
  const files = new PhysicalLocalFiles(path.join(scratch, kind))
  const snapshot = await files.snapshot()
  let plan
  try {
    plan = await produce({ mode: 'local', baseline: LEGACY_BASELINE, revision: 'frozen-records-' + kind,
      records: [...storage.rows].map(([key, value]) => ({ key, bytes: Buffer.from(encodeJson(value)) })), texts: [],
      tasks: [{ id: task.id, original: task, continuation: 'paused', request: task.goal.request, participants: [] }], issues: [] },
      files, snapshot, { id: 'retained-' + kind, owner: 'A', members: {} })
  } finally { await snapshot.release() }
  for (const change of plan.changes) await files.replace(change.path, change.bytes ?? change.content)
  const originalFiles = new Map()
  const view = await files.snapshot()
  try { for (const change of plan.changes) originalFiles.set(change.path, Buffer.from(await files.readBytes(view, change.path))) }
  finally { await view.release() }
  return { files, plan, task, expected: reportWrite.text, originalFiles }
}
function inspectParts(parts, text) {
  assert.ok(parts.length > 1)
  assert.equal(parts[0].text.length, 64 * 1024 - 1, 'the high surrogate moves to the next stored part')
  assert.equal(parts[1].text.startsWith('😀'), true)
  for (const part of parts) {
    assert.ok(part.text.length <= 64 * 1024)
    assert.equal(part.text.isWellFormed(), true)
    assert.equal(hash(part.text), part.meta.sha256)
    assert.equal(Buffer.byteLength(part.text), part.meta.bytes)
  }
  assert.equal(parts.map(part => part.text).join(''), text)
}
const results = []
for (const kind of ['persisted', 'staged']) test('retained legacy entry restores full ' + kind + ' report and original references', async () => {
  const f = await seed(kind), reads = [], writes = []
  const fullText = RecordJournal.prototype.fullText, append = RecordJournal.prototype.append
  RecordJournal.prototype.fullText = async function(ref) {
    const text = await fullText.call(this, ref)
    reads.push({ ref, text, hash: hash(text), bytes: Buffer.byteLength(text) })
    const entry = await this.manifest(ref), parts = []
    for (const meta of entry.parts) parts.push({ meta, text: (await this.storage.get(meta.key)).text })
    inspectParts(parts, text)
    return text
  }
  RecordJournal.prototype.append = async function(input) {
    const result = await append.call(this, input); writes.push({ input, result }); return result
  }
  try {
    const snapshot = await f.files.snapshot()
    let found
    try { found = await listLegacyArtifactReferences(f.files, snapshot, f.plan.manifestPath) }
    finally { await snapshot.release() }
    assert.equal(reads.length, 1)
    assert.equal(reads[0].text, f.expected)
    assert.equal(reads[0].hash, hash(f.expected))
    assert.equal(reads[0].bytes, Buffer.byteLength(f.expected))
    assert.deepEqual(JSON.parse(reads[0].text), f.task.reports.result)
    assert.equal(writes.length, kind === 'staged' ? 1 : 0)
    if (kind === 'staged') assert.equal(writes[0].input.text, f.expected)
    assert.deepEqual(found.map(row => ({ oldTaskId: row.oldTaskId, id: row.id, sourcePath: row.sourcePath,
      originalAbsolutePath: row.originalAbsolutePath, status: row.status })), [
      { oldTaskId: f.task.id, id: artifact.id, sourcePath: artifact.path, originalAbsolutePath: artifact.path, status: 'pending' },
    ])
    const current = await f.files.snapshot()
    try { for (const [file, bytes] of f.originalFiles) assert.deepEqual(Buffer.from(await f.files.readBytes(current, file)), bytes, 'preserved bytes: ' + file) }
    finally { await current.release() }
    results.push({ kind, characters: reads[0].text.length, bytes: reads[0].bytes, sha256: reads[0].hash,
      actualAppendCalls: writes.length, actualFullTextCalls: reads.length, preservedFiles: f.originalFiles.size })
  } finally {
    RecordJournal.prototype.fullText = fullText; RecordJournal.prototype.append = append
    await f.files.close()
  }
})
after(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
  console.log(JSON.stringify({ scope: 'Actual listLegacyArtifactReferences -> retained journal methods; frozen historical producer inputs; temporary Linux files. No user-data/Host/UI/network claim.',
    historicalSha256, results, ...evidence() }))
  hooks.deregister()
})
