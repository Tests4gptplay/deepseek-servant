// Real initialization-owner, acquisition, transaction and GitFiles methods.
// The repository boundary is a controlled immutable-head/CAS transport, not a
// real remote Git server, full Host scheduler, UI, or native model session.
// All test state is in memory; this script never writes evidence by default.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { sourceRoot, hooks } from './test-support/dsh-sdk-runtime.mjs'
import { Repository, put, head } from './test-support/controlled-git/repository.mjs'
const { GitFiles, FilesOutcomeUnknownError } = await import(new URL('framework/transactions.ts', sourceRoot))
const { SessionGitOperations } = await import(new URL('framework/git-authority.ts', sourceRoot))
const { FrameworkTransactions } = await import(new URL('framework/command-transactions.ts', sourceRoot))
const { createRoleGuideInitialization } = await import(new URL('framework/role-guides.ts', sourceRoot))
const { foregroundGuidePath } = await import(new URL('framework/foreground-prompt.ts', sourceRoot))
const { foregroundFullGuide, foregroundStorageRecoveryNote } = await import(new URL('framework/role-prompts.ts', sourceRoot))
const { createFrameworkSkillIndexInitialization, frameworkSkillIndexPath } = await import(new URL('framework/skills.ts', sourceRoot))
const { GitConflictError } = await import(new URL('experimental/private-git/github.ts', sourceRoot))
const { GitCommitOutcomeUnknownError } = await import(new URL('experimental/private-git/contracts.ts', sourceRoot))
const fixtures = []
const tick = () => new Promise(setImmediate)
const gate = () => { let release; return { promise: new Promise(resolve => { release = resolve }), release } }
const skillText = (name, body = 'original') => `---\nname: ${name}\ndescription: Test ${name}\n---\n${body}\n`
const hasReceipt = path => path.includes('/command-receipts/') || path.includes('/.command-receipts/')
function fixture() {
  const repo = new Repository(), originalCommit = repo.commitPrepared.bind(repo), originalRead = repo.read.bind(repo), originalBytes = repo.readBytes.bind(repo)
  const trace = { reads: [], commits: [], conflicts: 0, resolutions: [] }
  const controls = { before: undefined, loseAck: undefined }
  repo.read = async (snapshot, path) => { trace.reads.push(path); return originalRead(snapshot, path) }
  repo.readBytes = async (snapshot, path) => { trace.reads.push(path); return originalBytes(snapshot, path) }
  repo.commitPrepared = async (snapshot, changes, message, operation) => {
    trace.commits.push({ operation, changes })
    await tick()
    await controls.before?.({ repo, operation, changes })
    if (repo.head !== operation.expectedHead && !repo.accepted.has(operation.id)) { trace.conflicts++; throw new GitConflictError() }
    const loss = controls.loseAck; controls.loseAck = undefined
    if (loss === 'before') { repo.resolution = { status: 'unknown' }; throw new GitCommitOutcomeUnknownError(operation) }
    const result = await originalCommit(snapshot, changes, message, operation)
    if (loss === 'after') { repo.resolution = { status: 'unknown' }; throw new GitCommitOutcomeUnknownError(operation) }
    return result
  }
  const originalResolve = repo.resolveCommit.bind(repo)
  repo.resolveCommit = async operation => { trace.resolutions.push(operation.id); return originalResolve(operation) }
  // The stock controlled repository compares file dependencies; these tests also
  // exercise catalog discovery, so validate its actual recorded list predicates.
  const originalEqual = repo.dependenciesEqual.bind(repo)
  repo.dependenciesEqual = async (before, current, dependencies) => {
    if (!await originalEqual(before, current, dependencies)) return false
    const selected = (snapshot, list) => [...repo.views.get(snapshot)].filter(([path]) => path.startsWith(list.prefix)
      && (!list.selection?.names || list.selection.names.includes(path.split('/').at(-1))))
      .sort(([a], [b]) => a.localeCompare(b))
    return dependencies.lists.every(list => JSON.stringify(selected(before, list)) === JSON.stringify(selected(current, list)))
  }
  const files = new GitFiles(repo, new SessionGitOperations()), rows = new Map()
  const records = { get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)),
    delete: async key => rows.delete(key), list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }
  const tx = new FrameworkTransactions(files, records, 'session-acquisition-tests')
  const read = async path => { const snapshot = await files.snapshot(); try { return await files.read(snapshot, path) } finally { await snapshot.release() } }
  const noReceipts = () => {
    assert.equal(trace.commits.some(row => row.changes.some(change => hasReceipt(change.path))), false, 'no command receipt writes')
    assert.equal(trace.reads.some(hasReceipt), false, 'no command receipt reads')
    assert.equal([...repo.bodies.keys()].some(hasReceipt), false, 'no command receipt retained')
    assert.equal(rows.size, 0, 'no replacement SDK record')
  }
  const value = { repo, files, tx, trace, controls, read, noReceipts }; fixtures.push(value); return value
}
after(async () => { for (const f of fixtures) await f.tx.closeGitSession(new Error('Controlled test end')); hooks.deregister() })

for (const entry of [
  { name: 'guide', path: foregroundGuidePath, create: f => createRoleGuideInitialization(f.files, f.tx), target: foregroundFullGuide() },
  { name: 'catalog', path: frameworkSkillIndexPath, create: f => createFrameworkSkillIndexInitialization(f.files, f.tx), target: '{"version":1,"entries":[]}\n' },
]) {
  test(entry.name + ': missing target publishes only business bytes; cold acquisition is a no-op', async () => {
    const f = fixture(), acquire = entry.create(f)
    assert.equal((await acquire()).status, 'created')
    assert.equal(await f.read(entry.path), entry.target)
    assert.equal(f.trace.commits.length, 1)
    assert.equal((await entry.create(f)()).status, 'unchanged')
    assert.equal(f.trace.commits.length, 1); f.noReceipts()
  })
  test(entry.name + ': peer supplies target before CAS, current-head builder observes no write', async () => {
    const f = fixture(); let injected = false
    f.controls.before = () => { if (!injected) { injected = true; put(f.repo, entry.path, entry.target); head(f.repo) } }
    assert.equal((await entry.create(f)()).status, 'unchanged')
    assert.equal(f.trace.conflicts, 1); assert.equal(f.repo.calls.length, 0, 'rejected operation never applied')
    assert.equal(await f.read(entry.path), entry.target); f.noReceipts()
  })
  for (const loss of ['before', 'after']) test(entry.name + ': ' + loss + '-publication UNKNOWN never inferred from current target; original operation resolves', async () => {
    const f = fixture(), acquire = entry.create(f); f.controls.loseAck = loss
    await assert.rejects(acquire(), FilesOutcomeUnknownError)
    const operationId = f.trace.commits[0].operation.id
    assert.equal(await f.read(entry.path), loss === 'after' ? entry.target : undefined)
    // Visible target can come from the original accepted operation or a peer.
    if (loss === 'before') { put(f.repo, entry.path, entry.target); head(f.repo) }
    await assert.rejects(acquire(), FilesOutcomeUnknownError)
    assert.deepEqual(f.trace.resolutions, [operationId]); assert.equal(f.trace.commits.length, 1)
    f.repo.resolution = loss === 'after' ? undefined : { status: 'conflict', head: f.repo.head }
    const result = await acquire()
    assert.equal(result.status, loss === 'after' ? 'created' : 'unchanged')
    assert.equal(f.repo.calls.length, loss === 'after' ? 1 : 0)
    assert.equal(f.trace.resolutions.every(id => id === operationId), true)
    f.noReceipts()
  })
  test(entry.name + ': cancellation before publication starts no commit', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort(new Error('Owner cancelled'))
    await assert.rejects(entry.create(f)(controller.signal), /Owner cancelled/)
    assert.equal(f.trace.commits.length, 0); f.noReceipts()
  })
}

test('guide: exact prior official template migrates; custom guide is preserved', async () => {
  const f = fixture(); put(f.repo, foregroundGuidePath, foregroundFullGuide().replace('\n\n' + foregroundStorageRecoveryNote, '')); head(f.repo)
  assert.equal((await createRoleGuideInitialization(f.files, f.tx)()).status, 'migrated')
  assert.equal(await f.read(foregroundGuidePath), foregroundFullGuide())
  put(f.repo, foregroundGuidePath, 'User custom guide\n'); head(f.repo)
  assert.equal((await createRoleGuideInitialization(f.files, f.tx)()).status, 'unchanged')
  assert.equal(await f.read(foregroundGuidePath), 'User custom guide\n'); f.noReceipts()
})
test('guide: prior completed-Task restoration sentence migrates once and then stays unchanged', async () => {
  const f=fixture(),current=foregroundFullGuide()
  const oldRestore='After the user explicitly chooses restoration, call dss_task_restore with the original taskId, actual retained recordPaths, the evidence-based route and owner, and continuation explaining their decision, known progress and missing information.'
  const currentRestore='After the user explicitly chooses restoration, check retained Task status: a known completed Task stays complete, and a later correction or new requirement uses a new Task ID referencing its results. Otherwise call dss_task_restore with the original taskId, actual retained recordPaths, the evidence-based route and owner, and continuation explaining their decision, known progress and missing information.'
  assert.ok(current.includes(currentRestore))
  put(f.repo,foregroundGuidePath,current.replace(currentRestore,oldRestore));head(f.repo)
  const changed=await createRoleGuideInitialization(f.files,f.tx)()
  assert.equal(changed.status,'migrated');assert.equal(changed.changedRules,1)
  assert.equal(await f.read(foregroundGuidePath),current)
  assert.equal(f.trace.commits.length,1)
  assert.equal((await createRoleGuideInitialization(f.files,f.tx)()).status,'unchanged')
  assert.equal(f.trace.commits.length,1)
  f.noReceipts()
})
test('guide: concurrent custom content wins; unrelated main change reparents original payload', async () => {
  const custom = fixture(); let once = false
  custom.controls.before = () => { if (!once) { once = true; put(custom.repo, foregroundGuidePath, 'Concurrent user guide\n'); head(custom.repo) } }
  assert.equal((await createRoleGuideInitialization(custom.files, custom.tx)()).status, 'unchanged')
  assert.equal(await custom.read(foregroundGuidePath), 'Concurrent user guide\n'); custom.noReceipts()
  const unrelated = fixture(); once = false
  unrelated.controls.before = () => { if (!once) { once = true; put(unrelated.repo, 'messages/peer.md', 'untouched'); head(unrelated.repo) } }
  assert.equal((await createRoleGuideInitialization(unrelated.files, unrelated.tx)()).status, 'created')
  assert.equal(unrelated.trace.conflicts, 1); assert.equal(unrelated.trace.commits.length, 2)
  assert.equal(await unrelated.read('messages/peer.md'), 'untouched'); unrelated.noReceipts()
})
test('catalog: corrupt catalog rebuild re-evaluates changed and newly discovered definitions at current main', async () => {
  const f = fixture(); put(f.repo, frameworkSkillIndexPath, 'broken'); put(f.repo, 'skills/one/SKILL.md', skillText('one')); head(f.repo)
  let once = false
  f.controls.before = () => { if (!once) { once = true; put(f.repo, 'skills/one/SKILL.md', skillText('one', 'new current body')); put(f.repo, 'skills/two/SKILL.md', skillText('two')); head(f.repo) } }
  assert.equal((await createFrameworkSkillIndexInitialization(f.files, f.tx)()).status, 'rebuilt')
  const catalog = JSON.parse(await f.read(frameworkSkillIndexPath))
  assert.deepEqual(catalog.entries.map(row => row.name), ['one', 'two'])
  assert.equal(f.trace.conflicts, 1); assert.equal(f.trace.commits.length, 2)
  const current = fixture(); put(current.repo, 'skills/one/SKILL.md', skillText('one', 'new current body')); put(current.repo, 'skills/two/SKILL.md', skillText('two')); head(current.repo)
  await createFrameworkSkillIndexInitialization(current.files, current.tx)()
  assert.equal(await f.read(frameworkSkillIndexPath), await current.read(frameworkSkillIndexPath)); f.noReceipts(); current.noReceipts()
})

test('default replayable command still atomically writes and reads its original durable receipt', async () => {
  const f = fixture(); let builds = 0
  const build = async () => { builds++; return [{ path: 'messages/original.md', content: 'Original message' }] }
  await f.tx.run('ordinary-command', { body: 'Original message' }, {}, build)
  assert.equal(f.trace.commits[0].changes.some(row => hasReceipt(row.path)), true)
  const replay = await f.tx.run('ordinary-command', { body: 'Original message' }, {}, build)
  assert.equal(replay.replay, true); assert.equal(builds, 1)
  assert.equal((await f.tx.committedReceipt('ordinary-command', { body: 'Original message' })).replay, true)
})
test('session-only concurrent duplicate retains one original pending operation and no completed-result index', async () => {
  const f = fixture(), held = gate(); let builds = 0
  f.controls.before = () => held.promise
  const build = async snapshot => { builds++; return await f.files.read(snapshot, 'fixed.json') === 'target' ? [] : [{ path: 'fixed.json', content: 'target' }] }
  const options = { gitReplay: 'session-only', reevaluate: true }, first = f.tx.run('original', {}, options, build), second = f.tx.run('original', {}, options, build)
  assert.equal(first, second); held.release(); await first
  const again = await f.tx.run('original', {}, options, build)
  assert.equal(again.observationOnly, true); assert.equal(builds, 2); assert.equal(f.trace.commits.length, 1); f.noReceipts()
})

test('owner cancellation after a rejected CAS prevents reparent dispatch', async () => {
  const f = fixture(), controller = new AbortController(); let once = false
  f.controls.before = () => { if (!once) { once = true; put(f.repo, 'unrelated.md', 'peer'); head(f.repo); controller.abort(new Error('Cancelled during conflict')) } }
  await assert.rejects(createRoleGuideInitialization(f.files, f.tx)(controller.signal), /Cancelled during conflict/)
  assert.equal(f.trace.commits.length, 1); assert.equal(await f.read(foregroundGuidePath), undefined); f.noReceipts()
})
test('existing finalization proof still confirms without any ordinary receipt', async () => {
  const f = fixture(); put(f.repo, 'temporary.json', 'original'); head(f.repo)
  const proof = async snapshot => await f.files.read(snapshot, 'temporary.json') === undefined
  const result = await f.tx.runFinalization('finalize', {}, { reevaluate: true }, async () => [{ path: 'temporary.json', content: null }], proof)
  assert.equal(result.replay, false)
  const replay = await f.tx.runFinalization('finalize', {}, {}, async () => { throw Error('must not replay finalizer') }, proof)
  assert.equal(replay.replay, true); assert.equal(f.trace.commits.length, 1)
  assert.equal(f.trace.commits[0].changes.some(row => hasReceipt(row.path)), false)
})
for (const entry of [
  { name: 'guide', create: f => createRoleGuideInitialization(f.files, f.tx) },
  { name: 'catalog', create: f => createFrameworkSkillIndexInitialization(f.files, f.tx) },
]) test(entry.name + ': a separate acquisition may accept current state without confirming the original UNKNOWN', async () => {
  const f = fixture(), original = entry.create(f); f.controls.loseAck = 'after'
  await assert.rejects(original(), FilesOutcomeUnknownError)
  assert.equal((await entry.create(f)()).status, 'unchanged', 'new acquisition observes current business target')
  await assert.rejects(original(), FilesOutcomeUnknownError, 'original acquisition still owns unresolved native outcome')
  assert.equal(f.trace.commits.length, 1); f.noReceipts()
})
test('actual initialization owner retains only unfinished acquisitions, then stops its existing continuation', async () => {
  const { FrameworkInitialization } = await import(new URL('framework/initialization-repair.ts', sourceRoot))
  const f = fixture(), owner = new FrameworkInitialization(f.files, f.tx), errors = []
  f.controls.loseAck = 'after'
  await assert.rejects(owner.initializeGuide(), FilesOutcomeUnknownError)
  assert.equal(owner.hasPending(), true)
  await owner.resume(error => errors.push(error), () => {})
  assert.equal(errors.length, 1); assert.ok(errors[0] instanceof FilesOutcomeUnknownError)
  assert.equal(owner.hasPending(), true)
  f.repo.resolution = undefined
  await owner.resume(error => errors.push(error), () => {})
  assert.equal(owner.hasPending(), false)
  const calls = f.trace.commits.length
  await owner.resume(() => { throw Error('finished acquisitions cannot resume') }, () => { throw Error('no new catalog') })
  assert.equal(f.trace.commits.length, calls); f.noReceipts()
})
