import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoragePort } from '../src/contracts/ports.js'
import type { SkillRecord } from '../src/contracts/knowledge.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkKnowledge } from '../src/framework/knowledge.js'
import { withSnapshot, FilesConflictError } from '../src/framework/transactions.js'
import { prepareFrameworkSkillIndex, frameworkSkillIndexPath, frameworkSkillControlsPath, rebuildFrameworkSkillIndex } from '../src/framework/skills.js'
const markdown = '---\nname: sample\ndescription: Demonstrates a known method\n---\nOriginal verified method\n'
const legacy: SkillRecord = { schemaVersion: 1, kind: 'skill', skillId: 'old', scope: { assistantId: 'A', workspaceId: 'W' }, revision: 1, activeVersion: 1, receipts: {}, versions: [{ skillId: 'old', version: 1, scope: { assistantId: 'A', workspaceId: 'W' }, title: 'Old method', description: 'Original', applicability: 'Test scope', body: 'Validated old body', contentHash: 'original-hash', status: 'active', createdAt: '2026-10-01T00:00:00Z', sourceResultIds: ['accepted-result'], validations: [{ validationId: 'v', resultId: 'accepted-result', contentHash: 'original-hash', explanation: 'Synthetic unit-test evidence', artifactRefs: ['evidence'], validatedAt: '2026-10-02T00:00:00Z' }], uses: [], feedback: [] }] }
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dss-knowledge-')), files = await LocalFiles.open(root)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }) })
  const values = new Map<string, unknown>()
  const storage: StoragePort = { get: async key => structuredClone(values.get(key)) as never, set: async (key, value) => { values.set(key, structuredClone(value)) }, list: async () => [] }
  const tx = new FrameworkTransactions(files, storage, 'scope')
  let changed = 0
  const knowledge = new FrameworkKnowledge(files, tx, () => changed++)
  await withSnapshot(files, async snapshot => {
    const writes = [{ path: 'skills/sample/SKILL.md', content: markdown }, { path: 'skills/old/record.json', content: JSON.stringify(legacy) }]
    await files.commit(snapshot, [...writes, ...(await prepareFrameworkSkillIndex(files, snapshot, writes)).changes], 'fixtures')
  })
  return { files, knowledge, changed: () => changed }
}
test('explicit knowledge list reads stored entries without altering source or claiming invalid material active', async t => {
  const f = await fixture(t)
  const before = await withSnapshot(f.files, async s => s.revision)
  const listing = await f.knowledge.list()
  assert.equal(listing.items.length, 2)
  assert.equal(listing.items.find(item => item.kind === 'markdown')!.status, 'active')
  assert.equal(await withSnapshot(f.files, async s => s.revision), before)
})
test('legacy edit appends a candidate without copying validation or changing the active version and old body', async t => {
  const f = await fixture(t), { revision } = await f.knowledge.list()
  const input = { path: 'skills/old/record.json', expectedRevision: revision, body: 'New unverified edit', createdAt: '2026-10-31T00:00:00Z' }
  await f.knowledge.edit('edit', input)
  const after = JSON.parse((await f.knowledge.read(input.path)).text!) as SkillRecord
  assert.equal(after.activeVersion, 1)
  assert.deepEqual(after.versions[0], legacy.versions[0])
  assert.equal(after.versions[1]!.status, 'candidate')
  assert.deepEqual(after.versions[1]!.validations, []); assert.deepEqual(after.versions[1]!.sourceResultIds, [])
  await f.knowledge.edit('edit', input)
  assert.equal((JSON.parse((await f.knowledge.read(input.path)).text!) as SkillRecord).versions.length, 2)
})
test('Markdown edit saves a noninjected candidate and preserves active definition', async t => {
  const f = await fixture(t), { revision } = await f.knowledge.list()
  await f.knowledge.edit('edit-md', { path: 'skills/sample/SKILL.md', expectedRevision: revision, body: 'Proposed replacement', createdAt: '2026-10-31T00:00:00Z' })
  assert.equal((await f.knowledge.read('skills/sample/SKILL.md')).text, markdown)
  const row = (await f.knowledge.list()).items.find(item => item.kind === 'markdown')!
  assert.equal(row.candidates.length, 1)
  assert.equal(await withSnapshot(f.files, s => f.files.read(s, row.candidates[0]!.path)), 'Proposed replacement')
  const index = await withSnapshot(f.files, s => f.files.read(s, frameworkSkillIndexPath))
  assert.equal(index!.includes(row.candidates[0]!.path), false)
})
test('disable and retire preserve history and remain effective after a catalog rebuild', async t => {
  const f = await fixture(t)
  await f.knowledge.setStatus('off', { path: 'skills/sample/SKILL.md', expectedRevision: (await f.knowledge.list()).revision, status: 'disabled' })
  await f.knowledge.setStatus('retire', { path: 'skills/old/record.json', expectedRevision: (await f.knowledge.list()).revision, status: 'retired', reason: 'Explicit user action' })
  const record = JSON.parse((await f.knowledge.read('skills/old/record.json')).text!) as SkillRecord
  assert.equal(record.activeVersion, undefined)
  assert.equal(record.versions[0]!.body, legacy.versions[0]!.body)
  assert.deepEqual(record.versions[0]!.validations, legacy.versions[0]!.validations)
  await withSnapshot(f.files, async s => f.files.commit(s, (await rebuildFrameworkSkillIndex(f.files, s)).changes, 'rebuild'))
  const controls = JSON.parse((await withSnapshot(f.files, s => f.files.read(s, frameworkSkillControlsPath)))!)
  assert.equal(controls.entries['skills/sample/SKILL.md'].status, 'disabled')
  assert.equal((await f.knowledge.read('skills/sample/SKILL.md')).text, markdown)
})
test('stale knowledge edits return CAS conflict and do not overwrite a newer record', async t => {
  const f = await fixture(t), first = await f.knowledge.list()
  await f.knowledge.setStatus('off', { path: 'skills/sample/SKILL.md', expectedRevision: first.revision, status: 'disabled' })
  await assert.rejects(f.knowledge.edit('stale', { path: 'skills/sample/SKILL.md', expectedRevision: first.revision, body: 'changed', createdAt: '2026-10-31T00:00:00Z' }), FilesConflictError)
  assert.equal((await f.knowledge.read('skills/sample/SKILL.md')).text, markdown)
})
test('malformed historical definition can be explicitly disabled without rewriting it or fabricating a candidate', async t => {
  const f = await fixture(t)
  await withSnapshot(f.files, s => f.files.commit(s, [{ path: 'skills/old/record.json', content: '{bad' }], 'damaged stored record'))
  const revision = (await f.knowledge.list()).revision
  await assert.rejects(f.knowledge.edit('bad-edit', { path: 'skills/old/record.json', expectedRevision: revision, body: 'replacement', createdAt: '2026-10-31T00:00:00Z' }))
  await f.knowledge.setStatus('off-bad', { path: 'skills/old/record.json', expectedRevision: revision, status: 'disabled' })
  assert.equal(await withSnapshot(f.files, s => f.files.read(s, 'skills/old/record.json')), '{bad')
  const row = (await f.knowledge.list()).items.find(item => item.path === 'skills/old/record.json')!
  assert.equal(row.status, 'disabled'); assert.equal(row.indexed, false); assert.ok(row.error)
})
