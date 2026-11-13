// Actual frozen legacy producer/status methods, Linux SQLite/files and pinned
// SDK registry/scopes/storage. Explicit native proposals; no model or UI run.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import * as sdk from './test-support/dsh-sdk-runtime.mjs'
const { Context } = await import('@deepseek-ai/cordis')
const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { openDshStorageFixture } = await import('./test-support/dsh-sdk-storage.mjs')
const { publishLegacyNativeSkill } = await import('../src/framework/local-upgrade-skill.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkKnowledge } = await import('../src/framework/knowledge.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { refreshPhysicalFrameworkSkillIndex, installFrameworkSkillProvider } = await import('../src/framework/skills.ts')
const json = value => JSON.stringify(value, null, 2) + '\n'
const hash = value => createHash('sha256').update(value).digest('hex')
const names = [], results = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const bundled = readFileSync(new URL('./test-support/historical-55fe/installed-host.js', import.meta.url), 'utf8')
check('Frozen old producer SHA', hash(bundled), '5a84b25b7619486ea98e7e11b140d02c0a3848e48008ac3cc2dc71a2a5a5d47a')
const producerSource = bundled.slice(bundled.indexOf('async function prepareLegacyMigration('), bundled.indexOf('async function applyLegacyMigration('))
const outside = () => { throw new Error('Task mapping is outside this skill-only fixture') }
const producer = new Function('identity', 'hash12', 'legacyDeclaredArtifacts', 'legacyMigratedTaskId', 'encodeJson', 'utf8', 'decode', 'paths', 'workerPaths', 'prepareFrameworkSkillIndex', 'frameworkSkillIndexPath', producerSource + '\nreturn prepareLegacyMigration')(
  value => value, hash, outside, outside, json, value => Buffer.from(value), value => Buffer.from(value).toString(), {}, outside, async () => ({ changes: [], issues: [] }), 'technical/skills/catalog.json')
const knowledgeSource = bundled.slice(bundled.indexOf('var candidateIndex = "technical/skills/candidates.json";'), bundled.indexOf('// src/framework/task-index.ts'))
const OldKnowledge = new Function('createHash20', 'filePath', 'withSnapshot', 'frameworkSkillControlsPath', 'frameworkSkillIndexPath', 'prepareFrameworkSkillIndex', knowledgeSource + '\nreturn FrameworkKnowledge')(
  createHash, value => value, (_files, work) => work({ revision: 'historical' }), 'technical/skills/controls.json', 'technical/skills/catalog.json', async () => ({ changes: [], issues: [] }))
const date = '2026-11-09T00:00:00Z', controlsPath = 'technical/skills/controls.json', existingPath = 'skills/existing/SKILL.md'
const native = body => '---\n' + json({ name: 'same-method', description: 'Original method' }).trim() + '\n---\n' + body
const proposal = native('Incoming original method.\n'), existing = native('Existing distinct method.\n')
async function legacyRows(status) {
  const scope = { assistantId: 'historical-assistant', workspaceId: 'historical-workspace' }
  const version = { skillId: 'same-method', version: 1, title: 'Original title', description: 'Original method', applicability: 'Original scope', body: 'Incoming original method.\n', contentHash: 'original-hash', scope, status: 'active', createdAt: date, sourceResultIds: [], validations: [], uses: [], feedback: [] }
  const record = { schemaVersion: 1, kind: 'skill', skillId: 'same-method', scope, revision: 1, activeVersion: 1, versions: [version], receipts: {} }
  const rows = new Map(), files = { read: async (_s, p) => rows.get(p)?.toString(), readBytes: async (_s, p) => rows.get(p), list: async () => [], listDirectory: async () => [] }
  const put = changes => { for (const row of changes) rows.set(row.path, Buffer.from(row.bytes ?? row.content)) }
  put((await producer({ mode: 'local', revision: 'original', baseline: 'shipped-55fe', records: [{ key: 'knowledge/skills/same-method', bytes: Buffer.from(json(record)) }], texts: [], tasks: [], issues: [] }, files, { revision: 'historical' }, { id: 'original-import', owner: 'A', members: {} })).changes)
  const sourcePath = [...rows.keys()].find(p => p.endsWith('/record.json')), folder = sourcePath.slice(0, -'record.json'.length)
  const transactions = { run: async (_id, _request, _options, build) => { put(await build({ revision: 'historical' })); return { revision: 'historical', replay: false } } }
  if (status !== 'active') await new OldKnowledge(files, transactions).setStatus('original-user-choice', { path: sourcePath, expectedRevision: 'historical', status, reason: 'Original user choice', updatedAt: date })
  // Ordinary legacy folder resources; availability controls above come only
  // from the shipped status method, never a handcrafted controls entry.
  rows.set(folder + 'resources/original.bin', Buffer.from([0, 255, 0]))
  rows.set(folder + 'resources/empty.bin', Buffer.alloc(0))
  return { rows, sourcePath, folder, targetPath: folder + 'SKILL.md' }
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-inactive-skill-'))
const storage = await openDshStorageFixture(path.join(scratch, 'storage'), path.join(scratch, 'locator'))
try {
  for (const [incomingStatus, existingStatus] of [['disabled', 'active'], ['retired', 'active'], ['active', 'active'], ['active', 'disabled'], ['active', 'retired']]) {
    const label = incomingStatus + '-into-' + existingStatus, original = await legacyRows(incomingStatus)
    const directory = path.join(scratch, label), database = path.join(directory, 'dss-files.sqlite')
    await fs.mkdir(directory)
    const db = new DatabaseSync(database)
    db.exec('CREATE TABLE files(path TEXT PRIMARY KEY,content TEXT NOT NULL,version TEXT NOT NULL,bytes INTEGER NOT NULL,binary BLOB) STRICT')
    for (const [p, bytes] of original.rows) db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(p, '', 'actual-old-producer', bytes.length, bytes)
    db.close()
    const sqlBefore = hash(await fs.readFile(database))
    await fs.mkdir(path.dirname(path.join(directory, existingPath)), { recursive: true })
    await fs.writeFile(path.join(directory, existingPath), existing)
    const files = new PhysicalLocalFiles(directory), ctx = new Context()
    new SkillRegistry(ctx)
    const key = {}, scope = createScope(ctx, key)
    let provider
    try {
      check(label + ': existing native index', await refreshPhysicalFrameworkSkillIndex(files, [existingPath]), [])
      const knowledge = new FrameworkKnowledge(files, new FrameworkTransactions(files, storage.adapter, 'local:' + directory))
      if (existingStatus !== 'active') {
        const current = await knowledge.read(existingPath)
        await knowledge.setStatus('existing-user-choice', { path: existingPath, expectedRevision: current.revision, status: existingStatus, reason: 'Current user choice', updatedAt: date })
      }
      const report = await publishLegacyNativeSkill(directory, original.sourcePath, proposal, storage.adapter)
      const conflict = incomingStatus === 'active' && existingStatus === 'active'
      results.push({ incomingStatus, existingStatus, report })
      console.log(JSON.stringify({ scenario: label, report }))
      check(label + ': completion', report.status, conflict ? 'incomplete' : 'complete')
      check(label + ': issues', report.issues.map(row => row.code), conflict ? ['target-conflict'] : [])
      check(label + ': original SQL unchanged', hash(await fs.readFile(database)), sqlBefore)
      check(label + ': existing body preserved', await fs.readFile(path.join(directory, existingPath), 'utf8'), existing)
      const controls = JSON.parse(await fs.readFile(path.join(directory, controlsPath), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '{"entries":{}}' }))
      if (existingStatus !== 'active') check(label + ': current choice preserved', controls.entries[existingPath], { status: existingStatus, reason: 'Current user choice', updatedAt: date })
      if (conflict) {
        check(label + ': competing target unpublished', await fs.access(path.join(directory, original.targetPath)).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false }), false)
      } else {
        check(label + ': supplied native body exact', await fs.readFile(path.join(directory, original.targetPath), 'utf8'), proposal)
        check(label + ': raw original history exact', await fs.readFile(path.join(directory, original.folder + 'resources/original-record.json')), original.rows.get(original.sourcePath))
        for (const name of ['original.bin', 'empty.bin']) check(label + ': resource ' + name, await fs.readFile(path.join(directory, original.folder + 'resources/' + name)), original.rows.get(original.folder + 'resources/' + name))
        if (incomingStatus === 'active') check(label + ': incoming remains active', controls.entries[original.targetPath], undefined)
        else {
          const oldControlBytes = original.rows.get(controlsPath), oldControl = JSON.parse(oldControlBytes).entries[original.sourcePath]
          check(label + ': original choice mapped exactly', controls.entries[original.targetPath], oldControl)
          check(label + ': original control history exact', await fs.readFile(path.join(directory, original.folder + 'resources/original-controls.json')), oldControlBytes)
        }
      }
      const shown = (await knowledge.list()).items.filter(item => item.kind === 'markdown' && item.name === 'same-method')
        .map(item => [item.path, item.status]).sort((a, b) => a[0].localeCompare(b[0]))
      const expectedShown = [[existingPath, existingStatus], ...conflict ? [] : [[original.targetPath, incomingStatus]]].sort((a, b) => a[0].localeCompare(b[0]))
      check(label + ': knowledge UI keeps path-distinct names and statuses', shown, expectedShown)
      provider = installFrameworkSkillProvider(scope.ctx, key, files)
      await provider.settleRegistration()
      check(label + ': actual provider available', provider.available(), true)
      check(label + ': actual SDK lists only one active same-name method', (await ctx.skills.list({ scope: key })).map(item => item.name), ['same-method'])
      check(label + ': actual SDK loads the active body', (await ctx.skills.get('same-method', { scope: key })).content, existingStatus === 'active' ? 'Existing distinct method.' : 'Incoming original method.')
    } finally { await provider?.dispose(); await scope.dispose(); await files.close() }
  }
  console.log(JSON.stringify({ status: 'passed', assertions: names.length, names, results, ...sdk.evidence(), scriptHash: hash(readFileSync(new URL(import.meta.url))), limits: 'Actual pinned SDK and Linux files/SQLite; frozen legacy producer/status with in-memory old transaction port. Explicit native proposal, no model, no live DSH UI, Windows or Git.' }, null, 2))
} finally { await storage.close(); await fs.rm(scratch, { recursive: true, force: true }) }
