// Actual Service knowledgeStatus/withAccessOperation/checkScope/foreground/knowledge,
// Knowledge, GitFiles and FrameworkTransactions. Exact-head publication is a
// controlled immutable repository; its resolver uses accepted operation IDs.
// The existing disconnect suite separately exercises the real RemoteGit resolver.
// UI run/submit/changeStatus are AST-selected source statements with controlled
// display/access ports, not a mounted React page or full Host/native lifecycle.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, webcrypto } from 'node:crypto'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import ts from 'typescript'
import { Repository, put, head } from './test-support/controlled-git/repository.mjs'
const { FrameworkService } = await import(new URL('framework/service.ts', sourceRoot))
const { FrameworkKnowledge } = await import(new URL('framework/knowledge.ts', sourceRoot))
const { FrameworkTransactions, CommandInputsChangedError } = await import(new URL('framework/command-transactions.ts', sourceRoot))
const { GitFiles, FilesOutcomeUnknownError } = await import(new URL('framework/transactions.ts', sourceRoot))
const { SessionGitOperations } = await import(new URL('framework/git-authority.ts', sourceRoot))
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts', sourceRoot))
const { GitConflictError } = await import(new URL('experimental/private-git/github.ts', sourceRoot))
const { GitCommitOutcomeUnknownError } = await import(new URL('experimental/private-git/contracts.ts', sourceRoot))
const controlsPath = 'technical/skills/controls.json', target = 'skills/example/SKILL.md', other = 'skills/other/SKILL.md'
const native = '---\nname: example\ndescription: Original skill\n---\nOriginal complete skill body\n'
const timestamp = '2026-11-10T09:00:00.000Z'
const sha = value => createHash('sha256').update(value).digest('hex')
const tick = () => new Promise(setImmediate)
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve } }
const scratch = await mkdtemp(join(tmpdir(), 'dss-knowledge-status-'))
const handles = [], outcomes = []; let assertions = 0
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); assertions++; outcomes.push(name) }
async function rejects(name, action, expected) { await assert.rejects(action, expected); assertions++; outcomes.push(name) }
const isReceipt = path => path.includes('/command-receipts/') || path.includes('/.command-receipts/')
const content = (f, path) => f.repo.bodies.get('dss-coop/' + path)
const entries = f => JSON.parse(content(f, controlsPath) ?? '{"version":1,"entries":{}}').entries
const body = input => { const { mode, storageScope, commandId, ...request } = input; return request }
const goal = input => ({ status: input.status, ...(input.reason === undefined ? {} : { reason: input.reason }), ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }) })
function repository() {
  const repo = new Repository(), trace = { reads: [], commits: [], conflicts: 0, resolutions: [] }
  const controls = { unknown: new Set(), conflict: new Set() }
  put(repo, target, native); put(repo, other, native.replace('example', 'other')); head(repo)
  for (const name of ['read', 'readBytes']) {
    const original = repo[name].bind(repo)
    repo[name] = async (snapshot, path) => { trace.reads.push(path); return original(snapshot, path) }
  }
  const commit = repo.commitPrepared.bind(repo)
  repo.commitPrepared = async (snapshot, changes, message, operation) => {
    trace.commits.push({ operation, paths: changes.map(row => row.path) })
    await tick(); await controls.before?.({ operation, changes })
    // Keep the real prepareCommit identity: scope/base/writes/message are not
    // randomized to manufacture a conflict between identical operations.
    if (repo.head !== operation.expectedHead && !repo.accepted.has(operation.id)) { trace.conflicts++; throw new GitConflictError() }
    const loss = controls.loseAck; controls.loseAck = undefined
    if (loss === 'before') { controls.unknown.add(operation.id); throw new GitCommitOutcomeUnknownError(operation) }
    const result = await commit(snapshot, changes, message, operation)
    if (loss === 'after') { controls.unknown.add(operation.id); throw new GitCommitOutcomeUnknownError(operation) }
    return result
  }
  const resolve = repo.resolveCommit.bind(repo)
  repo.resolveCommit = async operation => {
    trace.resolutions.push(operation.id)
    if (controls.unknown.has(operation.id)) return { status: 'unknown' }
    if (controls.conflict.has(operation.id)) return { status: 'conflict', head: repo.head }
    return resolve(operation)
  }
  return { repo, trace, controls }
}
function handle(f, local) {
  const rows = new Map(), records = { get: async key => structuredClone(rows.get(key)), set: async (key, value) => rows.set(key, structuredClone(value)),
    delete: async key => rows.delete(key), list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }
  const operations = new SessionGitOperations(), files = local ?? new GitFiles(f.repo, operations)
  const tx = new FrameworkTransactions(files, records, 'test-scope'), options = [], run = tx.run.bind(tx)
  tx.run = (id, request, option, build) => { options.push({ id, request, option: { ...option } }); return run(id, request, option, build) }
  const connection = { files, transactions: tx, scope: 'test-scope' }, access = { connection }
  let notices = 0
  // Actual Service methods remain intact. Only acquisition, construction and
  // native refresh endpoints are controlled; no Host account is opened.
  const service = Object.assign(Object.create(FrameworkService.prototype), {
    closed: false, access: async () => access, running: new Map(), localUpgrades: new Map(), changed() { notices++ },
  })
  const h = { f, files, tx, operations, rows, options, service, access, notices: () => notices }
  handles.push(h); return h
}
async function input(h, id, extra = {}) {
  const mode = h.files instanceof PhysicalLocalFiles ? 'local' : 'git', path = extra.path ?? target
  const selected = await h.service.knowledgeRead({ mode, storageScope: 'test-scope', path })
  return { mode, storageScope: 'test-scope', commandId: id, path, expectedRevision: selected.revision,
    status: 'disabled', reason: 'Original user choice', updatedAt: timestamp, ...extra }
}
function noReceipts(name, f) {
  check(name + ': no receipt reads', f.trace.reads.some(isReceipt), false)
  check(name + ': no receipt writes/deletes', f.trace.commits.some(row => row.paths.some(isReceipt)), false)
}
const clientSource = readFileSync(new URL('framework/client-page.tsx', sourceRoot), 'utf8')
const ast = ts.createSourceFile('client-page.tsx', clientSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const panel = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'KnowledgePanel')
assert.ok(panel?.body)
const extracted = ['run', 'submit', 'changeStatus'].map(name => {
  const found = panel.body.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => ts.isIdentifier(decl.name) && decl.name.text === name))
  assert.equal(found.length, 1, 'Exactly one current KnowledgePanel ' + name)
  return { name, text: found[0].getText(ast), line: ast.getLineAndCharacterOfPosition(found[0].getStart(ast)).line + 1 }
})
const uiCode = ts.transpileModule(extracted.map(row => row.text).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
function ui(h, selected, status = 'disabled', reason = 'Original UI choice', retained = new Map()) {
  let idle, loseResponse = true
  const observed = [], errors = [], notices = [], statusAttempt = {}, active = { current: true }
  const deps = { api: { knowledgeStatus: async value => { observed.push(structuredClone(value)); const result = await h.service.knowledgeStatus(value); if (loseResponse) { loseResponse = false; throw new Error('Controlled HTTP response loss after status success') } return result }, knowledgeEdit: () => { throw new Error('Edit is outside status fixture') } },
    scope: { mode: 'git', storageScope: 'test-scope' }, selected, status, reason, statusAttempt, operations: retained, active,
    setBusy: value => { if (!value) idle?.resolve() }, setError: value => errors.push(value), setNotice: value => notices.push(value), setStatus: () => {}, redraw: () => {}, refresh: async () => {}, frameworkErrorText: String, tr: (_cn, en) => en, crypto: webcrypto }
  const methods = new Function(...Object.keys(deps), uiCode + '\nreturn { changeStatus, submit }')(...Object.values(deps))
  return { ...methods, retained, observed, errors, notices, statusAttempt,
    async invoke() { idle = gate(); methods.changeStatus(); await idle.promise } }
}
try {
  for (const status of ['disabled', 'retired']) {
    const f = repository(), h = handle(f), request = await input(h, 'normal-' + status, { status, ...(status === 'retired' ? { reason: undefined, updatedAt: undefined } : {}) })
    f.trace.reads.length = 0
    await h.service.knowledgeStatus(request)
    check(status + ': exact complete actual controls target', entries(f)[target], goal(request))
    check(status + ': original definition untouched', content(f, target), native)
    check(status + ': only current controls file published', f.trace.commits[0].paths, ['dss-coop/' + controlsPath])
    check(status + ': existing two business reads only', f.trace.reads, ['dss-coop/' + target, 'dss-coop/' + controlsPath])
    check(status + ': actual Git entry selects session-only', h.options.at(-1).option.gitReplay, 'session-only')
    const published = f.trace.commits.length
    const again = await h.service.knowledgeStatus(request)
    check(status + ': successful original old revision retry is current observation', { replay: again.replay, observationOnly: again.observationOnly }, { replay: false, observationOnly: true })
    check(status + ': original retry adds no commit', f.trace.commits.length, published)
    check(status + ': no substitute storage ledger', h.rows.size, 0)
    noReceipts(status, f)
    for (const [field, value] of [['status', status === 'disabled' ? 'retired' : 'disabled'], ['reason', 'Another actual goal'], ['updatedAt', '2026-11-10T10:00:00.000Z']]) {
      await rejects(status + ': different ' + field + ' still checks original target revision', () => h.service.knowledgeStatus({ ...request, commandId: status + '-different-' + field, [field]: value }), CommandInputsChangedError)
      check(status + ': rejected ' + field + ' change preserves target', entries(f)[target], goal(request))
    }
    await rejects(status + ': existing scope check intact', () => h.service.knowledgeStatus({ ...request, storageScope: 'other-scope' }), /destination changed/)
  }
  {
    const f = repository(), h = handle(f), selected = await h.service.knowledgeRead({ mode: 'git', storageScope: 'test-scope', path: target }), page = ui(h, selected)
    await page.invoke()
    const original = structuredClone(page.observed[0]), commits = f.trace.commits.length
    check('actual UI keeps pending original after response loss', page.retained.get(original.commandId).input, original)
    check('actual UI surfaces response failure', page.errors.some(text => text.includes('response loss')), true)
    check('actual UI keeps the original attempt input', page.statusAttempt.current.input, original)
    await page.invoke()
    check('actual UI retries unchanged command/revision/time/reason', page.observed, [original, original])
    check('actual UI retry clears only its resolved pending input', page.retained.has(original.commandId), false)
    check('actual UI retry reports saved after service returns', page.notices.includes('Status saved; original body retained.'), true)
    check('actual UI response retry does not publish again', f.trace.commits.length, commits)
    noReceipts('UI retry', f)
  }
  {
    const f = repository(), first = handle(f), request = await input(first, 'closed-connection')
    await first.service.knowledgeStatus(request)
    const bytes = content(f, controlsPath), commits = f.trace.commits.length
    await first.tx.closeGitSession(new Error('Controlled connection close')); first.operations.close()
    const fresh = handle(f)
    const result = await fresh.service.knowledgeStatus(request)
    check('fresh connection sees actual complete current goal', result.observationOnly, true)
    check('fresh connection does not assert historical command replay', result.replay, false)
    check('fresh connection keeps current controls bytes', content(f, controlsPath), bytes)
    check('fresh connection adds no commit', f.trace.commits.length, commits)
    check('fresh connection needs no prior volatile operation', fresh.operations.rows.size, 0)
    noReceipts('fresh connection', f)
  }
  for (const loss of ['before', 'after']) {
    const f = repository(), h = handle(f), request = await input(h, 'unknown-' + loss)
    f.controls.loseAck = loss
    await rejects(loss + ': original status is UNKNOWN', () => h.service.knowledgeStatus(request), FilesOutcomeUnknownError)
    const operation = f.trace.commits[0].operation, command = 'knowledge-status:' + request.commandId
    check(loss + ': original command retains attempt', h.tx.ownsGitAttempt(command), true)
    if (loss === 'before') {
      // A different actual command publishes the complete target. Its command
      // message changes the deterministic ID; do not relabel it original success.
      const peer = handle(f)
      await peer.service.knowledgeStatus({ ...request, commandId: 'independent-current-goal' })
      check('before: original operation not accepted', f.repo.accepted.has(operation.id), false)
    }
    check(loss + ': matching current controls are present', entries(f)[target], goal(request))
    const reads = f.trace.reads.length, commits = f.trace.commits.length
    await rejects(loss + ': current target does not settle original UNKNOWN', () => h.service.knowledgeStatus(request), FilesOutcomeUnknownError)
    check(loss + ': UNKNOWN retry resolves original exact operation', f.trace.resolutions.at(-1), operation.id)
    check(loss + ': UNKNOWN blocks builder before additional reads', f.trace.reads.length, reads)
    check(loss + ': UNKNOWN does not dispatch another commit', f.trace.commits.length, commits)
    await rejects(loss + ': original UNKNOWN changed arguments rejected', () => h.service.knowledgeStatus({ ...request, reason: 'changed' }), /identity cannot be reused/)
    const fresh = handle(f), current = await fresh.service.knowledgeStatus(request)
    check(loss + ': independent connection observes current goal only', current.observationOnly, true)
    check(loss + ': independent observation leaves original UNKNOWN owned', h.tx.ownsGitAttempt(command), true)
    f.controls.unknown.delete(operation.id)
    if (loss === 'before') f.controls.conflict.add(operation.id) // explicitly controlled negative resolution
    const result = await h.service.knowledgeStatus(request)
    check(loss + ': resolved original releases its attempt', h.tx.ownsGitAttempt(command), false)
    check(loss + ': resolution/convergence does not republish', f.trace.commits.length, commits)
    if (loss === 'after') {
      check('after: real transaction returns confirmed original identity', result.operationId, operation.id)
      check('after: confirmed original receipt is a replay', result.replay, true)
    } else check('before: resolved negative attempt converges as current observation', result.observationOnly, true)
    noReceipts('UNKNOWN ' + loss, f)
  }
  for (const sameSkill of [false, true]) {
    const f = repository(), a = handle(f), b = handle(f), first = await input(a, 'race-a'), second = await input(b, 'race-b', { path: sameSkill ? target : other, status: 'retired' })
    const held = gate(); let arrivals = 0
    f.controls.before = async () => { if (++arrivals === 2) held.resolve(); await held.promise }
    const results = await Promise.allSettled([a.service.knowledgeStatus(first), b.service.knowledgeStatus(second)])
    check((sameSkill ? 'same skill' : 'different skills') + ': actual competing commits reach exact-head CAS', f.trace.conflicts, 1)
    if (sameSkill) {
      check('same skill: one actual change succeeds', results.filter(row => row.status === 'fulfilled').length, 1)
      check('same skill: losing different goal keeps revision protection', results.find(row => row.status === 'rejected').reason instanceof CommandInputsChangedError, true)
      const winner = results[0].status === 'fulfilled' ? first : second
      check('same skill: winning complete control remains', entries(f)[target], goal(winner))
      check('same skill: only one publication accepted', f.repo.accepted.size, 1)
    } else {
      check('different skills: both original revisions remain valid for their own target', results.map(row => row.status), ['fulfilled', 'fulfilled'])
      check('different skills: shared controls rebuild preserves both goals', entries(f), { [target]: goal(first), [other]: goal(second) })
      check('different skills: exactly two effects accepted', f.repo.accepted.size, 2)
    }
    noReceipts('CAS ' + sameSkill, f)
  }
  {
    const f = repository(), a = handle(f), b = handle(f), request = await input(a, 'same-command-race'), held = gate(); let arrivals = 0
    f.controls.before = async () => { if (++arrivals === 2) held.resolve(); await held.promise }
    await Promise.all([a.service.knowledgeStatus(request), b.service.knowledgeStatus(request)])
    check('same command/payload/base retains deterministic operation identity', new Set(f.trace.commits.map(row => row.operation.id)).size, 1)
    check('same command race accepts one publication', f.repo.accepted.size, 1)
    check('same command race keeps complete goal', entries(f)[target], goal(request))
    noReceipts('same command', f)
  }
  {
    const f = repository(), original = handle(f), request = await input(original, 'valid-old-receipt'), savedRun = original.tx.run
    // Real production business builder plus unchanged default transaction
    // produces the preceding durable receipt atomically; no fabricated bytes.
    original.tx.run = (id, value, options, build) => FrameworkTransactions.prototype.run.call(original.tx, id, value, { ...options, gitReplay: undefined }, build)
    await original.service.knowledgeStatus(request)
    original.tx.run = savedRun
    const command = 'knowledge-status:' + request.commandId, path = 'technical/command-receipts/' + sha(command) + '.json', bytes = content(f, path)
    check('old default receipt is valid for exact original command/request', JSON.parse(bytes), { version: 1, id: command, requestHash: sha(JSON.stringify(body(request))) })
    await original.tx.closeGitSession(new Error('Controlled preceding session closed')); original.operations.close()
    f.trace.reads.length = 0; f.trace.commits.length = 0
    const fresh = handle(f)
    check('old receipt is unnecessary for current goal observation', (await fresh.service.knowledgeStatus(request)).observationOnly, true)
    check('valid old receipt remains byte-for-byte unchanged', content(f, path), bytes)
    check('old goal adds no replacement commit', f.trace.commits.length, 0)
    noReceipts('valid old receipt', f)
  }
  {
    const files = new PhysicalLocalFiles(join(scratch, 'local')), h = handle(undefined, files)
    await files.replace(target, native)
    const request = await input(h, 'local-status')
    await h.service.knowledgeStatus(request); await h.service.knowledgeStatus(request)
    const snapshot = await files.snapshot()
    try {
      check('Local actual physical controls have original goal', JSON.parse(await files.read(snapshot, controlsPath)).entries[target], goal(request))
      check('Local original body retained', await files.read(snapshot, target), native)
    } finally { await snapshot.release() }
    check('Local status stays outside generic transaction receipts', h.options.length, 0)
  }
  {
    const f = repository(), h = handle(f), legacy = 'skills/old/record.json', converted = 'skills/old/SKILL.md'
    put(f.repo, legacy, { schemaVersion: 1, kind: 'skill', versions: [] }); put(f.repo, converted, native); head(f.repo)
    let resolutions = 0
    h.access.knowledge = new FrameworkKnowledge(h.files, h.tx, () => {}, { async resolve(path) { assert.equal(path, legacy); resolutions++; return { convertedPath: converted } } })
    const request = { mode: 'git', storageScope: 'test-scope', commandId: 'legacy', path: legacy, expectedRevision: 'original legacy selection', status: 'retired' }
    const before = new Map(f.repo.bodies)
    check('legacy remains existing transition, not a native status write', await h.service.knowledgeStatus(request), { saved: false, convertedPath: converted })
    check('legacy retains original default transaction options', h.options.at(-1).option.gitReplay, undefined)
    check('legacy transition consults existing bridge once', resolutions, 1)
    check('legacy transition does not change any file', f.repo.bodies, before)
    check('legacy transition publishes no commit', f.trace.commits.length, 0)
  }
  {
    const f = repository(), h = handle(f), selected = await input(h, 'edit-boundary')
    await h.service.knowledgeEdit({ mode: selected.mode, storageScope: selected.storageScope, commandId: 'unchanged-edit', path: target, expectedRevision: selected.expectedRevision, baseBody: native, body: native + '\nSeparate direct edit\n' })
    check('direct edit uses current session-only transaction options', h.options.at(-1).option.gitReplay, 'session-only')
    check('separate direct edit publishes the requested definition', content(f, target), native + '\nSeparate direct edit\n')
    check('direct edit never creates a candidate', content(f, 'skills/example/candidates/' + sha('unchanged-edit') + '.md'), undefined)
  }
  console.log(JSON.stringify({ status: 'passed', assertions, outcomes,
    limits: 'Actual complete source Service prototype methods, Knowledge, GitFiles/Transactions. Service constructor/acquisition/native skill refresh are controlled. UI uses three AST-selected KnowledgePanel statements with display/API-response ports, no React render or page lifecycle. Exact-H and deterministic operation IDs use controlled in-memory Git; accepted-ID/negative resolution are injected, not RemoteGit marker/history proof. Fresh connection means new objects after close, not process restart. Local uses a real temporary filesystem. Existing legacy receipt suite remains separate. No GitHub, Dulwich or real DSH acceptance.',
    ui: { sourceSHA256: sha(clientSource), statements: extracted.map(({ name, text, line }) => ({ name, line, sha256: sha(text) })) }, ...evidence() }, null, 2))
} finally {
  for (const h of handles) { await h.tx.closeGitSession(new Error('Controlled suite completion')); h.operations.close(); await h.files.close?.() }
  await rm(scratch, { recursive: true, force: true }); hooks.deregister()
}
