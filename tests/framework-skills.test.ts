import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot, type FileChange } from '../src/framework/transactions.js'
import { frameworkSkillControlsPath, type FrameworkSkillControls, frameworkSkillIndexPath, installFrameworkSkillProvider, prepareFrameworkSkillIndex, rebuildFrameworkSkillIndex } from '../src/framework/skills.js'

// Installed official registry + Cordis scope implementation and real SQLite.
// No running model, account, filesystem skill provider or Git network is claimed.
const markdown = (name: string, body = 'Actual validated method') => `---\nname: ${name}\ndescription: Reusable tested operation\n---\n${body}`
async function fixture(t: test.TestContext, register = true, legacyScopes?: Array<{ assistantId: string; workspaceId: string }>, legacyGitParticipants?: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'dss-native-skills-')), files = await LocalFiles.open(directory)
  const ctx = new Context()
  const plugins: Array<{ dispose(): unknown }> = []
  const mount = async () => { plugins.push(await ctx.plugin(SkillRegistry)) }
  if (register) await mount()
  const agent = {} as Agent, scoped = createScope(ctx, agent)
  const installed = installFrameworkSkillProvider(scoped.ctx, agent, files, { legacyScopes, legacyGitParticipants })
  await new Promise(resolve => setImmediate(resolve))
  t.after(async () => { await installed.dispose(); await scoped.dispose(); for (const plugin of plugins) await plugin.dispose(); await files.close(); await rm(directory, { recursive: true, force: true }) })
  const write = (changes: FileChange[]) => withSnapshot(files, async snapshot => {
    const prepared = await prepareFrameworkSkillIndex(files, snapshot, changes)
    await files.commit(snapshot, [...changes, ...prepared.changes], 'skills transaction')
    installed.invalidate()
    return prepared
  })
  return { files, ctx, agent, scoped, installed, write, mount }
}

test('official native registry discovers summaries in actual Agent scope and only get loads body', async t => {
  const { files, ctx, agent, installed, write } = await fixture(t)
  await write([{ path: 'skills/test/SKILL.md', content: markdown('tested-method') }])
  const reads: string[] = [], original = files.read.bind(files)
  files.read = async (snapshot, path) => { reads.push(path); return original(snapshot, path) }
  const registry = ctx.get('skills')!
  assert.equal(installed.available(), true)
  assert.deepEqual(installed.diagnostics(), [])
  assert.deepEqual(await registry.list(), [], 'no global leakage')
  assert.deepEqual(await registry.list({ scope: {} }), [], 'another Agent cannot see the scoped provider')
  const list = await registry.list({ scope: agent })
  assert.equal(list[0]!.name, 'tested-method')
  assert.deepEqual(reads, [frameworkSkillControlsPath, frameworkSkillIndexPath], 'catalog lookup does not read any skill body')
  const skill = await registry.get('tested-method', { scope: agent })
  assert.equal(skill!.content, 'Actual validated method')
  assert.equal(skill!.resourceBase!.kind, 'opaque')
  assert.deepEqual(reads, [frameworkSkillControlsPath, frameworkSkillIndexPath, frameworkSkillControlsPath, 'skills/test/SKILL.md'])
  await installed.dispose()
  assert.deepEqual(await registry.list({ scope: agent }), [])
})

test('Recorder indexes only formal SKILL.md, reports invalid definitions without blocking other archives', async t => {
  const { ctx, agent, write } = await fixture(t)
  const prepared = await write([
    { path: 'archives/T/records.md', content: 'Durable accepted task record' },
    { path: 'skills/ordinary.md', content: markdown('not-a-skill-file') },
    { path: 'skills/broken/SKILL.md', content: '# Not frontmatter' },
    { path: 'skills/valid/SKILL.md', content: markdown('valid-skill') },
    { path: 'skills/manual/SKILL.md', content: '---\nname: manual-skill\ndescription: Only explicitly invoked\ndisable-model-invocation: true\nuser-invocable: true\n---\nManual body' },
  ])
  assert.equal(prepared.issues.length, 1)
  const skills = await ctx.get('skills')!.list({ scope: agent })
  assert.deepEqual(skills.map(skill => skill.name), ['manual-skill', 'valid-skill'])
  assert.equal(skills[0]!.invocation.modelInvocable, false)
})

function legacyRecord(status = 'active', version = 1) {
  return { schemaVersion: 1, kind: 'skill', skillId: 'legacy-test', scope: { assistantId: 'assistant', workspaceId: 'workspace' }, revision: 1, activeVersion: version,
    versions: [{ version: 1, status, title: 'Legacy title', description: 'Legacy verified method', applicability: 'Original workspace only', body: 'Original active body', validations: [{ validationId: 'old-proof' }], contentHash: 'preserved-old-hash' }], receipts: {} }
}
test('legacy scopes and exact activeVersion/active/nonretired predicates are preserved, never automatically promoted', async t => {
  const allowed = [{ assistantId: 'assistant', workspaceId: 'workspace' }]
  const { files, ctx, agent, write } = await fixture(t, true, allowed)
  const path = 'skills/assistant/workspace/legacy-test/record.json'
  await write([{ path, content: JSON.stringify(legacyRecord()) }])
  assert.equal((await ctx.get('skills')!.get('servant-legacy-test', { scope: agent }))!.content.includes('Original active body'), true)
  const other = {} as Agent, otherScope = createScope(ctx, other)
  const noLegacy = installFrameworkSkillProvider(otherScope.ctx, other, files)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(await ctx.get('skills')!.list({ scope: other }), [], 'no implicit legacy scope admission')
  } finally { await noLegacy.dispose(); await otherScope.dispose() }
  for (const record of [legacyRecord('candidate'), legacyRecord('disabled'), legacyRecord('active', 2),
    { ...legacyRecord(), versions: [{ ...legacyRecord().versions[0], bodyRetiredAt: '2026-10-31' }] }]) {
    const raw = JSON.stringify(record)
    await write([{ path, content: raw }])
    assert.deepEqual(await ctx.get('skills')!.list({ scope: agent }), [])
    await withSnapshot(files, async snapshot => assert.equal(await files.read(snapshot, path), raw, 'native adapter never alters old provenance'))
  }
})

test('late native registry service mounts through official inject and teardown removes it', async t => {
  const { ctx, agent, installed, write, mount } = await fixture(t, false)
  assert.equal(installed.available(), false)
  assert.match(installed.diagnostics()[0]!, /unavailable/)
  await write([{ path: 'skills/late/SKILL.md', content: markdown('late-skill') }])
  await mount()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(installed.available(), true)
  assert.equal((await ctx.get('skills')!.list({ scope: agent }))[0]!.name, 'late-skill')
})

test('changed content is not loaded through a stale catalog locator; explicit rebuild/invalidation discovers preserved files', async t => {
  const { files, ctx, agent, installed, write } = await fixture(t)
  const path = 'skills/changing/SKILL.md'
  await write([{ path, content: markdown('changing-skill', 'Old body') }])
  await ctx.get('skills')!.list({ scope: agent })
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path, content: markdown('changing-skill', 'New body') }], 'outside indexed adapter'))
  assert.equal(await ctx.get('skills')!.get('changing-skill', { scope: agent }), undefined)
  await withSnapshot(files, async snapshot => {
    const rebuilt = await rebuildFrameworkSkillIndex(files, snapshot)
    await files.commit(snapshot, rebuilt.changes, 'explicit adapter rebuild')
  })
  installed.invalidate()
  assert.equal((await ctx.get('skills')!.get('changing-skill', { scope: agent }))!.content, 'New body')
})


test('native parser compatibility rejects legacy invocation aliases instead of silently enabling them', async t => {
  const { ctx, agent, write } = await fixture(t)
  const prepared = await write([{ path: 'skills/alias/SKILL.md', content: '---\nname: wrong-alias\ndescription: Not model callable\ndisableModelInvocation: true\n---\nbody' }])
  assert.equal(prepared.issues.length, 1)
  assert.deepEqual(await ctx.get('skills')!.list({ scope: agent }), [])
})


test('only successfully loaded native skill directories grant bounded resource reads, and disposal clears grants', async t => {
  const { ctx, agent, installed, write, files } = await fixture(t)
  await write([
    { path: 'skills/one/SKILL.md', content: markdown('skill-one') },
    { path: 'skills/two/SKILL.md', content: markdown('skill-two') },
  ])
  await ctx.get('skills')!.list({ scope: agent })
  assert.equal(installed.canReadResource('skills/one/example.bin'), false, 'a catalog preview is not a skill load')
  assert.equal(await ctx.get('skills')!.get('unknown', { scope: agent }), undefined)
  await ctx.get('skills')!.get('skill-one', { scope: agent })
  for (const path of ['skills/one', 'skills/one/SKILL.md', 'skills/one/resources/example.bin']) assert.equal(installed.canReadResource(path), true)
  for (const path of ['skills', 'skills/two/example.bin', 'skills/one-other/file', 'skills/one/../two/file', 'skills/one//file', '/skills/one/file', 'tasks/private.md']) assert.equal(installed.canReadResource(path), false)
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'skills/two/SKILL.md', content: markdown('skill-two', 'Changed body') }], 'stale locator'))
  assert.equal(await ctx.get('skills')!.get('skill-two', { scope: agent }), undefined)
  assert.equal(installed.canReadResource('skills/two/example.bin'), false)
  await installed.dispose()
  assert.equal(installed.canReadResource('skills/one/example.bin'), false)
})

test('official actual-agent pre-step waterfall invalidates catalog before a consumer snapshots, without background body reads', async t => {
  const { ctx, agent, files, write } = await fixture(t)
  await write([{ path: 'skills/first/SKILL.md', content: markdown('first-skill') }])
  const registry = ctx.get('skills')!
  assert.deepEqual((await registry.list({ scope: agent })).map(skill => skill.name), ['first-skill'])
  // Simulates a different Host updating shared storage: no local invalidate call.
  await withSnapshot(files, async snapshot => {
    const changes = [{ path: 'skills/second/SKILL.md', content: markdown('second-skill') }]
    const prepared = await prepareFrameworkSkillIndex(files, snapshot, changes)
    await files.commit(snapshot, [...changes, ...prepared.changes], 'remote Recorder equivalent')
  })
  assert.deepEqual((await registry.list({ scope: agent })).map(skill => skill.name), ['first-skill'], 'real registry cache exists before a step boundary')
  const reads: string[] = [], original = files.read.bind(files)
  files.read = async (snapshot, path) => { reads.push(path); return original(snapshot, path) }
  let names: string[] = []
  const off = ctx.on('agent/pre-step', async (event, next) => {
    const result = await next() // Mirrors official tool-skill catalog's ordering.
    names = (await registry.snapshot({ scope: event.agent })).skills.map(skill => skill.name)
    return result
  })
  try {
    await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter' as const, messages: [] }))
    assert.deepEqual(names, ['first-skill', 'second-skill'])
    assert.deepEqual(reads, [frameworkSkillControlsPath, frameworkSkillIndexPath])
  } finally { off() }
})

import { BaselineKnowledgeService as KnowledgeService } from './legacy-baseline.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { captureLocalLegacy, prepareLegacyMigration, applyLegacyMigration } from '../src/framework/legacy-migration.js'
import { MemoryStorage } from './support.js'

test('real legacy knowledge validation and migration CAS produce a discoverable native scoped skill with exact original body', async t => {
  const legacyScope = { assistantId: 'default', workspaceId: 'original-workspace' }
  const oldStorage = new MemoryStorage(), transactionsStorage = new MemoryStorage()
  const old = new KnowledgeService({ store: oldStorage, evidence: {
    resolveResult: async resultId => ({ ...legacyScope, resultId, taskId: 'accepted-task', status: 'accepted', summary: 'Verified method', artifactRefs: ['retained-evidence'] }),
  } })
  for (const skillId of ['validated-method', 'candidate-method']) await old.proposeSkill({ commandId: 'propose-' + skillId, skillId, scope: legacyScope,
    title: 'Validated original', description: 'Original metadata', applicability: 'Original workspace only', body: 'Original complete method 😀', sourceResultId: 'accepted-result' })
  const proposed = (await old.getSkill('validated-method', legacyScope))!
  await old.validateSkill({ commandId: 'validate-original', skillId: 'validated-method', scope: legacyScope, version: 1,
    contentHash: proposed.versions[0]!.contentHash, resultId: 'accepted-result', explanation: 'Actually verified result', artifactRefs: ['retained-evidence'] })
  const { files, ctx, agent, installed } = await fixture(t, true, [legacyScope])
  const capture = await captureLocalLegacy(oldStorage)
  const plan = await withSnapshot(files, snapshot => prepareLegacyMigration(capture, files, snapshot, { id: 'native-skill-migration', owner: 'A', members: {} }))
  await applyLegacyMigration(files, new FrameworkTransactions(files, transactionsStorage, 'migration-native-skills'), plan)
  installed.invalidate()
  const registry = ctx.get('skills')!
  assert.deepEqual((await registry.list({ scope: agent })).map(skill => skill.name), ['servant-validated-method'])
  assert.equal((await registry.get('servant-validated-method', { scope: agent }))!.content, await old.getSkillBody('servant-validated-method', legacyScope))
  assert.equal(await registry.get('servant-candidate-method', { scope: agent }), undefined)
  assert.equal(installed.canReadResource('skills/default/original-workspace/validated-method/example.txt'), true)
  assert.equal(installed.canReadResource('skills/default/original-workspace/candidate-method/example.txt'), false)
})


test('legacy Git skills use only explicit authenticated participant admission and preserve body without invented activation versions', async t => {
  const { files, ctx, agent, write, installed } = await fixture(t, true, undefined, ['101'])
  const record = (participantId: string) => ({ version: 1, kind: 'legacy-git-skill', participantId,
    name: 'coop-' + participantId, description: 'Original Git method', body: 'Exact original Git skill body 😀',
    source: { path: 'dss-coop/knowledge/' + participantId + '/skill/original', metadata: { taskId: 'old-task', executionId: 'old-execution' } } })
  await write(['101', '202'].map(id => ({ path: 'skills/legacy-git/' + id + '/original/legacy-git.json', content: JSON.stringify(record(id)) })))
  const registry = ctx.get('skills')!
  assert.deepEqual((await registry.list({ scope: agent })).map(skill => skill.name), ['coop-101'])
  assert.equal((await registry.get('coop-101', { scope: agent }))!.content, record('101').body)
  assert.equal(await registry.get('coop-202', { scope: agent }), undefined)
  assert.equal(installed.canReadResource('skills/legacy-git/101/original/resource'), true)
  assert.equal(installed.canReadResource('skills/legacy-git/202/original/resource'), false)
  await withSnapshot(files, async snapshot => {
    const index = JSON.parse((await files.read(snapshot, frameworkSkillIndexPath))!)
    for (const entry of index.entries) { assert.equal(entry.activeVersion, undefined); assert.equal(entry.scope, undefined) }
  })
  const other = {} as Agent, otherScope = createScope(ctx, other)
  const denied = installFrameworkSkillProvider(otherScope.ctx, other, files)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(await registry.list({ scope: other }), [], 'no participant whitelist means no legacy Git skills')
  } finally { await denied.dispose(); await otherScope.dispose() }
})


for (const status of ['disabled', 'retired'] as const) {
  test(`native skill ${status} control defeats cached candidates, survives rebuild and preserves original bodies`, async t => {
    const { files, ctx, agent, installed, write } = await fixture(t)
    const controlledPath = 'skills/controlled/SKILL.md', otherPath = 'skills/other/SKILL.md'
    const originalBody = markdown('controlled-skill', 'Validated original content')
    await write([{ path: controlledPath, content: originalBody }, { path: otherPath, content: markdown('other-skill', 'Unaffected method') }])
    const registry = ctx.get('skills')!
    assert.equal((await registry.get('controlled-skill', { scope: agent }))!.content, 'Validated original content')
    assert.equal((await registry.list({ scope: agent })).length, 2, 'native catalog candidates are cached before control changes')
    const control: FrameworkSkillControls = { version: 1, entries: { [controlledPath]: { status, reason: 'Explicit technical test control', updatedAt: '2026-10-31T00:00:00Z' } } }
    await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: frameworkSkillControlsPath, content: JSON.stringify(control) }], 'control changed by another Host'))
    const reads: Array<{ path: string; revision: string }> = [], originalRead = files.read.bind(files)
    files.read = async (snapshot, path) => { reads.push({ path, revision: snapshot.revision }); return originalRead(snapshot, path) }
    assert.equal(await registry.get('controlled-skill', { scope: agent }), undefined, 'old native candidate cannot bypass the new control')
    assert.deepEqual(reads.map(read => read.path), [frameworkSkillControlsPath], 'controlled body is not loaded at all')
    reads.length = 0
    await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter' as const, messages: [] }))
    assert.deepEqual((await registry.list({ scope: agent })).map(skill => skill.name), ['other-skill'])
    assert.deepEqual(reads.map(read => read.path), [frameworkSkillControlsPath, frameworkSkillIndexPath])
    assert.equal(new Set(reads.map(read => read.revision)).size, 1, 'control and catalog are read at the same authoritative snapshot')
    assert.equal((await registry.get('other-skill', { scope: agent }))!.content, 'Unaffected method')
    await withSnapshot(files, async snapshot => {
      assert.equal(await files.read(snapshot, controlledPath), originalBody, 'disable/retire does not delete historical evidence')
      const rebuilt = await rebuildFrameworkSkillIndex(files, snapshot)
      assert.equal(rebuilt.changes.some(change => change.path === frameworkSkillControlsPath), false)
      await files.commit(snapshot, rebuilt.changes, 'explicit catalog rebuild')
    })
    installed.invalidate()
    assert.deepEqual((await registry.list({ scope: agent })).map(skill => skill.name), ['other-skill'])
    // Even a later new definition and rebuilt catalog do not silently activate a
    // path whose independent disable/retire control remains authoritative.
    await write([{ path: controlledPath, content: markdown('controlled-skill', 'New content must stay hidden') }])
    assert.equal(await registry.get('controlled-skill', { scope: agent }), undefined)
    await withSnapshot(files, async snapshot => assert.deepEqual(JSON.parse((await files.read(snapshot, frameworkSkillControlsPath))!), control))
  })
}
