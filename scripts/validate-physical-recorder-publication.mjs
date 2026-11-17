import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Real production Recorder tool, physical files, merge/catalog and Host/Cleaner.
// SDK schemas, native registry identity, simple YAML and Markdown syntax are
// explicit controlled ports, not installed DSH/Windows/parser acceptance.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hash = value => createHash('sha256').update(value).digest('hex')
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'zod') return { url: data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`), shortCircuit: true }
  if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(text){return {type:'root',children:[...text.matchAll(/\\[[^\\]]*\\]\\(([^)]*)\\)/g)].map(m=>({type:'link',url:m[1],position:{start:{offset:m.index},end:{offset:m.index+m[0].length}}}))}}`), shortCircuit: true }
  if (specifier === '@deepseek-ai/dsh-scope') return { url: data('export const scopeOf=scope=>scope.agent'), shortCircuit: true }
  if (specifier === '@deepseek-ai/dsh-skill') return { url: data("export const isSkillName=name=>/^[a-z][a-z0-9-]*$/.test(name)"), shortCircuit: true }
  if (specifier === 'yaml') return { url: data(`export function parse(text){return Object.fromEntries(text.split(/\\r?\\n/).filter(Boolean).map(line=>{const i=line.indexOf(':');if(i<0)throw new Error('fixture invalid YAML');return [line.slice(0,i),line.slice(i+1).trim()]}))}`), shortCircuit: true }
  if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
    const source = readFileSync(new URL(url), 'utf8'); loaded.set(url.slice(sourceRoot.href.length), hash(source))
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
} })
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { physicalRecorderPendingPath } = await import('../src/framework/physical-recorder-publication.ts')
const { publishPhysicalSkillProposal } = await import('../src/framework/skill-merge.ts')
const { frameworkSkillIndexPath, refreshPhysicalFrameworkSkillIndex } = await import('../src/framework/skills.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { FrameworkCleaner } = await import('../src/framework/cleaner.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { taskHistoryPath } = await import('../src/framework/task-history.ts')
const { readArchivedReference, readTaskRequirementReference } = await import('../src/framework/recorder-retention.ts')
const { taskReference } = await import('../src/framework/published-references.ts')
const { paths, encodeJson, taskLifecycleKey } = await import('../src/framework/task-files.ts')
const pendingReason = 'Skill publication was still unfinished at the archive handoff; its outcome is not confirmed.'
const checks = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const rejects = async (name, action, re) => { await assert.rejects(action, re); checks.push(name) }
const read = (files, logical) => withSnapshot(files, snapshot => files.read(snapshot, logical))
const readBytes = (files, logical) => withSnapshot(files, snapshot => files.readBytes(snapshot, logical))
const skillText = (a = 'one', b = 'two') => `---\nname: example\ndescription: Tested method\n---\n${a}\nkeep\n${b}\n`
function toolsFor(files, task, options = {}) {
  const tools = new Map(), agent = { id: 'recorder-' + task.taskId, session: {} }
  const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } }
  let concluded = 0, invalidated = 0
  installFrameworkRoleTools(ctx, agent, { role: 'Recorder', taskId: task.taskId, lifecycleId: task.lifecycleId, owner: task.owner,
    workId: 'recorder-work', executionId: 'recorder-execution' }, { files, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => { throw error },
    transact: async () => { throw new Error('Recorder must not use generic transaction publication') }, skillsChanged: () => invalidated++, ...options })
  return { get concluded() { return concluded }, get invalidated() { return invalidated },
    call: (name, input, callId = 'save') => tools.get(name).execute(input, { agent, callId, signal: new AbortController().signal, concludeTurn: () => concluded++ }) }
}
async function fixture(directory, name = 'root', child = true) {
  const files = new PhysicalLocalFiles(path.join(directory, 'local')), id = '00000000-0000-4000-8000-' + hash(name).slice(0, 12)
  const total = { version: 1, taskId: id, route: child ? 'O' : 'P', owner: 'A', members: ['A'], lifecycleId: 'round', status: 'complete',
    sourcePath: 'tasks/' + name + '_O.md', archiveFolder: name + '_' + id }
  const family = [total]
  if (child) {
    const id = '00000000-0000-4000-8000-' + hash(name + '-child').slice(0, 12)
    const sub = { version: 1, taskId: id, route: 'P', owner: 'B', members: ['B'], lifecycleId: 'child-round', status: 'complete',
      sourcePath: 'tasks/' + id + '_P.md', archiveFolder: total.archiveFolder + '/child_' + id, parent: { taskId: total.taskId, owner: 'A', objectiveId: 'child' }, resultPaths: [paths.run(id) + '/empty.bin'] }
    family.push(sub); total.children = [{ taskId: id, member: 'B', objectiveId: 'child' }]
  }
  for (const task of family) {
    await files.replace(paths.task(task.taskId), encodeJson(task))
    await files.replace(task.sourcePath, 'Task ID: ' + task.taskId + '\nOriginal requirement\r\n')
    await files.replace(paths.run(task.taskId) + '/binary.bin', new Uint8Array([0, 255, 0, 10, 13, 128]))
    await files.replace(paths.run(task.taskId) + '/empty.bin', new Uint8Array())
    await files.replace(paths.run(task.taskId) + '/Recorder_Note.md', 'temporary note, do not retain all')
    await files.replace(paths.cache(task.taskId), encodeJson({ version: 1, links: [{ kind: 'directory', path: paths.run(task.taskId) + '/' }] }))
  }
  const native = path.join(directory, 'original-native.bin'); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(native, 'original native result')
  total.workspaceResults = [{ path: native, taskId: total.taskId, owner: 'A', instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]
  await files.replace(paths.task(total.taskId), encodeJson(total))
  const input = { outputs: [{ path: paths.archive(total) + '/records.md', text: 'AI-authored exact root process record\r\n' }],
    // These interruption/streaming scenarios deliberately select the original.
    // Independent no-selection/link-selection cases live in their own test.
    retainedPaths: family.flatMap(task => [paths.run(task.taskId) + '/binary.bin', paths.run(task.taskId) + '/empty.bin', task.sourcePath]) }
  await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ total, family, input, native }))
  return { files, total, family, input, native, directory }
}
async function run(fixture, options = {}) {
  const role = toolsFor(fixture.files, fixture.total, options), view = await role.call('dss_snapshot', {}, 'view')
  const input = { ...fixture.input, snapshotId: view.snapshotId }
  const result = await role.call('dss_recorder_save', input)
  return { role, input, result }
}
class TechnicalRecords {
  constructor(directory) { this.files = new LocalRecordFiles(directory) }
  name(key) { return 'records/' + Buffer.from(key).toString('base64url') + '.json' }
  async get(key) { const text = await this.files.read(this.name(key)); return text === undefined ? undefined : JSON.parse(text) }
  async set(key, value) { await this.files.replace(this.name(key), JSON.stringify(value)) }
  async delete(key) { await this.files.delete(this.name(key)) }
}
async function clean(fixture) {
  const { files, total, directory } = fixture, transactions = { run() { throw new Error('No generic publication') } }, records = new TechnicalRecords(path.join(directory, 'technical')), errors = []
  const cleaner = new FrameworkCleaner(files, transactions, async () => {})
  const host = new FrameworkHostLoop(files, transactions, records, { scope: directory, member: 'A', primary: true, instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, () => ['A'], {
    async wake() {}, executing() { return false }, async releaseTask() {}, error(error) { errors.push(error) }, async observe() {},
    async clean(task, snapshot, observation) { return (await cleaner.clean(task, observation)).status === 'released' },
  })
  host.record = await records.get(host.key) ?? { initial: {}, completed: {} }
  await withSnapshot(files, snapshot => host.scanTask(total, snapshot, performance.now()))
  // scanTask owns the Recorder notice, but native release and the resumed
  // Cleaner are separate Host operations. Observe this Task's durable Host
  // completion rather than treating the end of the scan as deletion.
  const key = taskLifecycleKey(total), deadline = performance.now() + 5000
  while (true) {
    if (errors.length) throw new AggregateError(errors)
    if (await host.taskReleased(total.taskId, total.lifecycleId)) break
    if (performance.now() >= deadline) throw new Error('Own Host/Cleaner did not finish: ' + key)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (errors.length) throw new AggregateError(errors)
}
function interrupt(files, fixture, at) {
  const replace = files.replace.bind(files), rename = files.rename.bind(files), create = files.createIfAbsent.bind(files), copy = files.stageCopy.bind(files)
  if (at === 'original-partial') {
    const open = fs.open
    fs.open = async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('/originals/' + hash(fixture.total.sourcePath) + '.raw.copying')) {
        const write = handle.write.bind(handle)
        handle.write = async (...writes) => { const result = await write(...writes); process.exit(86); return result }
      }
      return handle
    }
  }
  files.stageCopy = async (source, stage, signal) => { const result = await copy(source, stage, signal); if (at === 'original-staged' && result) process.exit(86); return result }
  files.replace = async (p, content) => {
    const result = await replace(p, content)
    if (at === 'skill-result' && p.includes('/skill-results/') && JSON.parse(content).result) process.exit(86)
    if (at === 'accepted' && p === physicalRecorderPendingPath(fixture.total.taskId)) process.exit(86)
    if (at === 'prepared-archive' && p.endsWith('/archive-plan.json')) process.exit(86)
    if (at === 'ready' && p === physicalRecorderPendingPath(fixture.total.taskId) && JSON.parse(content).cleanerPrepared) process.exit(86)
    return result
  }
  files.createIfAbsent = async (p, content) => { const result = await create(p, content); if (at === 'failed-proposal-stage' && p.includes('/skill-proposals/') && p.endsWith('.raw')) process.exit(86); if (at === 'catalog-stage' && p.includes('/catalog/') && p.endsWith('.raw')) process.exit(86); if (at === 'original-staged' && p.includes('/originals/') && p.endsWith('.raw')) process.exit(86); if (at === 'cleaner-stage' && p.includes('/.recorder-cleaner-')) process.exit(86); return result }
  files.rename = async (from, to) => { const result = await rename(from, to)
    if (at === 'original' && to.includes('/retained/')) process.exit(86)
    if (at === 'records' && to === fixture.input.outputs[0].path) process.exit(86)
    if (at === 'identity' && to === taskHistoryPath(fixture.total.taskId)) process.exit(86)
    if (at === 'catalog' && to === paths.archive(fixture.total) + '/retention.json') process.exit(86)
    if (at === 'cleaner-renamed' && to.endsWith('/Cleaner')) process.exit(86)
    return result
  }
}
if (process.argv[2] === '--held-skill-exit') {
  const directory = process.argv[3], saved = JSON.parse(await fs.readFile(path.join(directory, 'fixture.json'), 'utf8'))
  const fixture = { ...saved, directory, files: new PhysicalLocalFiles(path.join(directory, 'local')) }
  let enter; const entered = new Promise(resolve => enter = resolve)
  void fixture.files.updateAsync('skills/example/SKILL.md', async () => { enter(); await new Promise(() => {}); return { value: undefined } })
  await entered
  void run(fixture)
  for (;;) {
    const pendingText = await read(fixture.files, physicalRecorderPendingPath(fixture.total.taskId))
    if (pendingText) { const pending = JSON.parse(pendingText), marker = paths.run(pending.task.taskId) + '/.recorder-handoff/' + hash(pending.commandId) + '/skill-results/' + hash('skills/example/SKILL.md') + '.json'; if (await read(fixture.files, marker)) break }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  process.exit(87)
}
if (process.argv[2] === '--interrupt') {
  const [at, directory] = process.argv.slice(3), saved = JSON.parse(await fs.readFile(path.join(directory, 'fixture.json'), 'utf8'))
  const fixture = { ...saved, directory, files: new PhysicalLocalFiles(path.join(directory, 'local')) }
  interrupt(fixture.files, fixture, at); await run(fixture); throw new Error('Unreached fault checkpoint ' + at)
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-recorder-physical-')), opened = []
try {
  const f = await fixture(path.join(scratch, 'basic')); opened.push(f.files)
  const { role, input, result } = await run(f)
  check('Actual Recorder tool saves directly', result.saved, true); check('Successful archive concludes turn', role.concluded, 1)
  check('Root authored bytes unchanged', await read(f.files, input.outputs[0].path), input.outputs[0].text)
  check('Only total Cleaner emitted', await read(f.files, paths.state('A', f.total.taskId) + '/Cleaner'), '')
  check('No child Cleaner emitted', await read(f.files, paths.state('B', f.family[1].taskId) + '/Cleaner'), undefined)
  const catalog = JSON.parse(await read(f.files, paths.archive(f.total) + '/retention.json'))
  for (const task of f.family) {
    const history = JSON.parse(await read(f.files, taskHistoryPath(task.taskId)))
    check('Historical identity exists before cleanup ' + task.taskId, history.taskId, task.taskId)
    check('History excludes runtime members ' + task.taskId, 'members' in history, false)
    for (const [name, expected] of [['binary.bin', [0, 255, 0, 10, 13, 128]], ['empty.bin', []]]) {
      const target = catalog.relocatedReferences[paths.run(task.taskId) + '/' + name]
      check('Original is nested in real owner archive ' + task.taskId + name, target.startsWith(paths.archive(task) + '/retained/'), true)
      check('Exact retained bytes ' + task.taskId + name, Array.from(await readBytes(f.files, target)), expected)
    }
  }
  check('Native workspace original unchanged', await fs.readFile(f.native, 'utf8'), 'original native result')
  check('Native workspace result not copied into archive', Object.values(catalog.relocatedReferences).some(p => p.endsWith('original-native.bin')), false)
  check('Temporary Note is not archived by default', Object.keys(catalog.relocatedReferences).some(p => p.endsWith('Recorder_Note.md')), false)
  await f.files.replace(input.outputs[0].path, 'user edited physical record')
  await rejects('Confirmed Recorder handoff retires its old tool scope', () => role.call('dss_recorder_save', input), /Snapshot is released/)
  await toolsFor(f.files, f.total).call('dss_recorder_save', input)
  check('Cold-scope replay does not overwrite ordinary user edit', await read(f.files, input.outputs[0].path), 'user edited physical record')
  await clean(f)
  check('Actual Host/Cleaner removes pending package', await read(f.files, physicalRecorderPendingPath(f.total.taskId)), undefined)
  check('Actual Host/Cleaner removes runtime metadata', await read(f.files, paths.task(f.total.taskId)), undefined)
  check('Actual Host/Cleaner consumes original notice', await read(f.files, paths.state('A', f.total.taskId) + '/Cleaner'), undefined)
  await rejects('Retired Recorder scope stays ended after Cleaner', () => role.call('dss_recorder_save', input), /Snapshot is released/)
  await toolsFor(f.files, f.total).call('dss_recorder_save', input)
  check('Consumed Cleaner is not reemitted on cold-scope replay', await read(f.files, paths.state('A', f.total.taskId) + '/Cleaner'), undefined)
  check('No runtime namespace recreated', existsSync(path.join(f.files.directory, paths.run(f.total.taskId))), false)
  const s = await fixture(path.join(scratch, 'skills'), 'skills', false); opened.push(s.files)
  const skill = 'skills/example/SKILL.md'; await s.files.replace(skill, skillText())
  const sr = toolsFor(s.files, s.total), sv = await sr.call('dss_snapshot', {}, 'view')
  const baseline = await sr.call('dss_read', { snapshotId: sv.snapshotId, path: skill }, 'read')
  await s.files.replace(skill, skillText('one', 'peer-two'))
  const si = { ...s.input, snapshotId: sv.snapshotId, outputs: [...s.input.outputs, { path: skill, text: skillText('own-one'), baseReadId: baseline.baseReadId }] }
  const success = await sr.call('dss_recorder_save', si)
  check('Independent skill changes merge', await read(s.files, skill), skillText('own-one', 'peer-two'))
  check('Successful skills leave no failed-proposal archive', success.unmergedSkills, [])
  check('Successful skill refreshes actual catalog', JSON.parse(await read(s.files, frameworkSkillIndexPath)).entries[0].path, skill)
  check('Native skill cache notified', sr.invalidated, 1)
  const c = await fixture(path.join(scratch, 'conflict'), 'conflict', false); opened.push(c.files)
  await c.files.replace(skill, skillText())
  const cr = toolsFor(c.files, c.total), cv = await cr.call('dss_snapshot', {}, 'view'), cb = await cr.call('dss_read', { snapshotId: cv.snapshotId, path: skill }, 'read')
  await c.files.replace(skill, skillText('peer-one'))
  const conflict = await cr.call('dss_recorder_save', { ...c.input, snapshotId: cv.snapshotId, outputs: [...c.input.outputs, { path: skill, text: skillText('own-one'), baseReadId: cb.baseReadId }] })
  check('Conflict keeps original Recorder unfinished', conflict.saved, false); check('Conflict does not conclude Recorder', cr.concluded, 0)
  check('Conflict preserves peer skill unchanged', await read(c.files, skill), skillText('peer-one'))
  check('Conflict reports exact unfinished target', conflict.pendingSkills.length, 1)
  check('Conflict exact proposal bytes', conflict.pendingSkills[0].detail.proposed, skillText('own-one')); check('Conflict reason is real overlap', conflict.pendingSkills[0].reason, 'overlapping-edits')
  check('Conflict does not emit Cleaner before resolution', await read(c.files, paths.state('A', c.total.taskId) + '/Cleaner'), undefined)
  check('No failed-proposal append to temporary Note', await read(c.files, paths.run(c.total.taskId) + '/Recorder_Note.md'), 'temporary note, do not retain all')
  const u = await fixture(path.join(scratch, 'unread'), 'unread', false); opened.push(u.files)
  await u.files.replace(skill, skillText()); u.input.outputs.push({ path: skill, text: skillText('unread proposal') })
  const unread = await run(u); check('Unread full base is accurately reported', unread.result.pendingSkills[0].reason, 'current-read-required')
  check('Unread skill remains original Recorder work before Cleaner', await read(u.files, paths.state('A', u.total.taskId) + '/Cleaner'), undefined)
  const i = await fixture(path.join(scratch, 'index'), 'index', false); opened.push(i.files); i.input.outputs.push({ path: skill, text: skillText() })
  const update = i.files.updateAsync.bind(i.files); i.files.updateAsync = async (p, decide) => { if (p === frameworkSkillIndexPath) throw new Error('controlled index unavailable'); return update(p, decide) }
  const index = await run(i); check('Catalog failure leaves published skill', await read(i.files, skill), skillText())
  check('Catalog failure reported independently', index.result.skillIssues[0].includes('controlled index unavailable'), true)
  check('Catalog failure does not mislabel skill unmerged', index.result.unmergedSkills, [])
  check('Catalog failure does not block Cleaner', await read(i.files, paths.state('A', i.total.taskId) + '/Cleaner'), '')
  const p = await fixture(path.join(scratch, 'notifications'), 'notifications', false); opened.push(p.files)
  const notification = await run(p, { notifications: async () => ['new-source'] })
  check('Pending input returns normal continuation', notification.result.notifications, ['new-source'])
  check('Pending input does not start save', await read(p.files, physicalRecorderPendingPath(p.total.taskId)), undefined)
  check('Pending input keeps turn open', notification.role.concluded, 0)
  const childRole = toolsFor(f.files, f.family[1]), childView = await childRole.call('dss_snapshot', {}, 'view')
  await rejects('Child cannot publish separate Recorder', () => childRole.call('dss_recorder_save', { snapshotId: childView.snapshotId, outputs: [{ path: paths.archive(f.family[1]) + '/records.md', text: 'bad' }], retainedPaths: [] }), /Only the terminal total Task/)
  // Same real skill file serializes merges; other exact paths are independent.
  const concurrent = new PhysicalLocalFiles(path.join(scratch, 'concurrent')); opened.push(concurrent)
  await concurrent.replace(skill, skillText())
  const base = { id: 'exact-read', path: skill, revision: 'read', text: skillText() }
  await Promise.all([publishPhysicalSkillProposal(concurrent, { path: skill, text: skillText('left') }, base), publishPhysicalSkillProposal(concurrent, { path: skill, text: skillText('one', 'right') }, base)])
  check('Concurrent actual skill merge keeps both contributions', await read(concurrent, skill), skillText('left', 'right'))
  await concurrent.replace('skills/second/SKILL.md', skillText().replace('name: example', 'name: second'))
  await Promise.all([refreshPhysicalFrameworkSkillIndex(concurrent, [skill]), refreshPhysicalFrameworkSkillIndex(concurrent, ['skills/second/SKILL.md'])])
  check('Concurrent catalog updates preserve both skill rows', JSON.parse(await read(concurrent, frameworkSkillIndexPath)).entries.map(row => row.path).sort(), [skill, 'skills/second/SKILL.md'].sort())
  for (const point of ['accepted', 'prepared-archive', 'original-staged', 'original', 'records', 'identity', 'catalog', 'cleaner-stage', 'ready', 'cleaner-renamed']) {
    const interrupted = await fixture(path.join(scratch, point), point); opened.push(interrupted.files)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', point, interrupted.directory], { encoding: 'utf8' })
    check('Actual process exit reached ' + point, child.status, 86)
    if (point === 'prepared-archive' || point === 'original-staged') for (const task of interrupted.family) await interrupted.files.replace(paths.run(task.taskId) + '/binary.bin', 'changed source after accepted package')
    if (point === 'cleaner-renamed') await clean(interrupted)
    const resumed = await run(interrupted)
    check('Cold Recorder resumes ' + point, resumed.result.saved, true)
    const manifest = JSON.parse(await read(interrupted.files, paths.archive(interrupted.total) + '/retention.json'))
    check('Cold resume exact accepted binary ' + point, Array.from(await readBytes(interrupted.files, manifest.relocatedReferences[paths.run(interrupted.total.taskId) + '/binary.bin'])), [0, 255, 0, 10, 13, 128])
    check('Cold resume no duplicated records ' + point, await read(interrupted.files, interrupted.input.outputs[0].path), interrupted.input.outputs[0].text)
    if (point === 'cleaner-renamed') check('Consumed notification not reemitted after cold restart', await read(interrupted.files, paths.state('A', interrupted.total.taskId) + '/Cleaner'), undefined)
  }
  const m = await fixture(path.join(scratch, 'missing-stage'), 'missing-stage', false); opened.push(m.files)
  const dead = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', 'ready', m.directory], { encoding: 'utf8' }); check('Missing-stage fixture reached', dead.status, 86)
  const pending = JSON.parse(await read(m.files, physicalRecorderPendingPath(m.total.taskId))), stage = paths.run(m.total.taskId) + '/.recorder-cleaner-' + hash(pending.commandId) + '.stage'
  await m.files.delete(stage)
  await rejects('Missing source alone is not delivery proof', () => run(m), /handoff is unconfirmed/)
  check('Unknown handoff does not recreate signal', await read(m.files, paths.state('A', m.total.taskId) + '/Cleaner'), undefined)
  check('Unknown handoff retains accepted bytes', !!await read(m.files, physicalRecorderPendingPath(m.total.taskId)), true)
  // Ordinary Local archive reads remain live after user edits and missing hashes.
  const original = paths.run(f.total.taskId) + '/binary.bin', mapped = catalog.relocatedReferences[original]
  await f.files.replace(mapped, new Uint8Array([55, 0, 99]))
  check('Mapped physical bytes stay user-editable', Array.from(await withSnapshot(f.files, snap => readArchivedReference(f.files, snap, f.total.taskId, original))), [55, 0, 99])
  const currentCatalog = JSON.parse(await read(f.files, paths.archive(f.total) + '/retention.json'))
  delete currentCatalog.verifiedReferences; delete currentCatalog.relocatedSources
  await f.files.replace(paths.archive(f.total) + '/retention.json', encodeJson(currentCatalog))
  check('Missing historical hash does not reject Local bytes', Array.from(await withSnapshot(f.files, snap => readArchivedReference(f.files, snap, f.total.taskId, original))), [55, 0, 99])
  const requirement = currentCatalog.relocatedReferences[f.total.sourcePath]
  await f.files.replace(requirement, 'User edited archived requirement without old Task marker')
  check('Mapped physical requirement edit stays readable', (await withSnapshot(f.files, snap => readTaskRequirementReference(f.files, snap, f.total, f.total.sourcePath))).text, 'User edited archived requirement without old Task marker')
  await f.files.delete(requirement)
  check('Missing mapped requirement reports missing', (await withSnapshot(f.files, snap => readTaskRequirementReference(f.files, snap, f.total, f.total.sourcePath))).text, undefined)
  await f.files.delete(mapped)
  check('Missing mapped physical original reports missing', await withSnapshot(f.files, snap => readArchivedReference(f.files, snap, f.total.taskId, original)), undefined)
  currentCatalog.relocatedReferences[original] = 'archives/unrelated/secret.txt'
  await f.files.replace(paths.archive(f.total) + '/retention.json', encodeJson(currentCatalog))
  await rejects('Live physical archive mapping cannot escape Task', () => withSnapshot(f.files, snap => readArchivedReference(f.files, snap, f.total.taskId, original)), /escapes its Task/)
  const nonPhysical = { read: f.files.read.bind(f.files), readBytes: f.files.readBytes.bind(f.files) }
  currentCatalog.relocatedReferences[original] = mapped
  await f.files.replace(paths.archive(f.total) + '/retention.json', encodeJson(currentCatalog))
  await rejects('Non-physical stored-byte verification remains independent', () => withSnapshot(f.files, snap => readArchivedReference(nonPhysical, snap, f.total.taskId, original)), /lacks verified content/)
  // Pause only one real archive target. Another total Task and ordinary records
  // can proceed; no whole-Task, store or global skill publication lock exists.
  const a = await fixture(path.join(scratch, 'independent-a'), 'independent-a', false), b = await fixture(a.directory, 'independent-b', false)
  opened.push(a.files, b.files)
  let release, entered; const held = new Promise(resolve => release = resolve), start = new Promise(resolve => entered = resolve)
  const renameA = a.files.rename.bind(a.files)
  a.files.rename = async (from, to) => { if (to === a.input.outputs[0].path) { entered(); await held } return renameA(from, to) }
  const waiting = run(a); await start
  await a.files.append(paths.run(a.total.taskId) + '/Recorder_Note.md', ' independent ordinary record')
  check('Ordinary same-Task record independent of archive save', (await read(a.files, paths.run(a.total.taskId) + '/Recorder_Note.md')).endsWith(' independent ordinary record'), true)
  check('Another total Task saves while first archive target waits', (await run(b)).result.saved, true)
  release(); await waiting
  const changed = await fixture(path.join(scratch, 'changed-after-write'), 'changed-after-write', false); opened.push(changed.files)
  const interrupted = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', 'records', changed.directory], { encoding: 'utf8' })
  check('Changed-target fixture reached real interrupted write', interrupted.status, 86)
  await changed.files.replace(changed.input.outputs[0].path, 'user intervened after interrupted own write')
  await rejects('Uncertain own write never overwrites intervening archive edit', () => run(changed), /changed archive file/)
  check('Intervening archive edit remains intact', await read(changed.files, changed.input.outputs[0].path), 'user intervened after interrupted own write')
  check('Unsettled required archive does not send Cleaner', await read(changed.files, paths.state('A', changed.total.taskId) + '/Cleaner'), undefined)
  const invalid = await fixture(path.join(scratch, 'binary-skill'), 'binary-skill', false); opened.push(invalid.files)
  await invalid.files.replace(skill, new Uint8Array([255, 0, 2])); invalid.input.outputs.push({ path: skill, text: skillText() })
  const binary = await run(invalid)
  check('Binary current skill accurately reported', binary.result.pendingSkills[0].reason, 'current-not-text')
  check('Binary current skill never overwritten', Array.from(await readBytes(invalid.files, skill)), [255, 0, 2])
  check('Binary skill conflict does not prematurely hand off Cleaner', await read(invalid.files, paths.state('A', invalid.total.taskId) + '/Cleaner'), undefined)
  const callback = await fixture(path.join(scratch, 'cache-error'), 'cache-error', false); opened.push(callback.files); callback.input.outputs.push({ path: skill, text: skillText() })
  const cacheFailure = await run(callback, { skillsChanged() { throw new Error('controlled registry refresh') } })
  check('Skill cache error still concludes successful Recorder', cacheFailure.role.concluded, 1)
  check('Skill cache error returned accurately', cacheFailure.result.skillIssues.some(issue => issue.includes('controlled registry refresh')), true)
  const uncertain = await fixture(path.join(scratch, 'uncertain-skill'), 'uncertain-skill', false); opened.push(uncertain.files)
  uncertain.input.outputs.push({ path: skill, text: skillText() })
  const actualUpdate = uncertain.files.update.bind(uncertain.files); let lostSkillReply = false
  uncertain.files.update = async (p, decide) => { const result = await actualUpdate(p, decide); if (p === skill && !lostSkillReply) { lostSkillReply = true; throw new Error('controlled post-write transport outcome') }; return result }
  const uncertainResult = await run(uncertain)
  check('Skill unknown outcome does not claim publication succeeded', uncertainResult.result.pendingSkills[0].outcome, 'unknown')
  check('Actual skill bytes remain without rollback', await read(uncertain.files, skill), skillText())
  check('Unknown contribution keeps original Recorder before Cleaner', await read(uncertain.files, paths.state('A', uncertain.total.taskId) + '/Cleaner'), undefined)
  const resolvedUnknown = await run(uncertain)
  check('Original UNKNOWN confirms current contribution without republishing', resolvedUnknown.result.saved, true)

  // Definitive rejection result is durable before any archive/Cleaner. The old
  // failed-proposal-stage cutoff no longer exists in the corrected ordering.
  const rejected = await fixture(path.join(scratch, 'skill-result'), 'skill-result', false); opened.push(rejected.files)
  await rejected.files.replace(skill, skillText()); rejected.input.outputs.push({path:skill,text:skillText('unfinished')})
  await fs.writeFile(path.join(rejected.directory,'fixture.json'),JSON.stringify({total:rejected.total,family:rejected.family,input:rejected.input,native:rejected.native}))
  const rejectedExit=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt','skill-result',rejected.directory],{encoding:'utf8'})
  check('Actual process stops after definitive file result',rejectedExit.status,86)
  const rejectedResume=await run(rejected)
  check('Cold original definitive conflict remains available to Recorder',rejectedResume.result.pendingSkills[0].reason,'current-read-required')
  check('Cold original conflict never creates Cleaner',await read(rejected.files,paths.state('A',rejected.total.taskId)+'/Cleaner'),undefined)
  const stopped = await fixture(path.join(scratch, 'catalog-stage'), 'catalog-stage', false); opened.push(stopped.files)
  const exactProposal = skillText('finished') + '\n[Original requirement](' + stopped.total.sourcePath + ')\r\n'
  stopped.input.outputs.push({path:skill,text:exactProposal})
  await fs.writeFile(path.join(stopped.directory,'fixture.json'),JSON.stringify({total:stopped.total,family:stopped.family,input:stopped.input,native:stopped.native}))
  const stoppedProcess=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--interrupt','catalog-stage',stopped.directory],{encoding:'utf8'})
  check('Actual process stops after final catalog stage before descriptor',stoppedProcess.status,86)
  await stopped.files.replace(stopped.input.outputs[0].path,'User edits already confirmed records after interruption')
  const recovered=await run(stopped)
  check('Cold finalization resumes confirmed skill and archive',recovered.result.saved,true)
  check('Cold finalization preserves initially published normalized skill bytes exactly',await read(stopped.files,skill),exactProposal.replace(stopped.total.sourcePath,taskReference(stopped.total.taskId,stopped.total.sourcePath)))
  check('Cold finalization never rewrites confirmed user-edited record',await read(stopped.files,stopped.input.outputs[0].path),'User edits already confirmed records after interruption')
  const finishSoon = async promise => {
    let timer
    try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Controlled validation deadline: derived catalog incorrectly held completed Recorder')), 2500) })]) }
    finally { clearTimeout(timer) }
  }
  const until = async predicate => {
    for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    throw new Error('Original one-time settlement did not finish in the controlled check')
  }
  // A real same-file queue holds this Recorder, not Cleaner or unrelated work.
  const heldSkill = await fixture(path.join(scratch,'held-skill'),'held-skill',false);opened.push(heldSkill.files)
  heldSkill.input.outputs.push({path:skill,text:skillText()})
  let unlockSkill,enterSkill;const skillGate=new Promise(r=>unlockSkill=r),skillEntered=new Promise(r=>enterSkill=r)
  const skillBlocker=heldSkill.files.updateAsync(skill,async()=>{enterSkill();await skillGate;return{value:undefined}})
  try{
    await skillEntered;let finished=false;const saving=run(heldSkill).then(result=>{finished=true;return result})
    await until(async()=>!!await read(heldSkill.files,physicalRecorderPendingPath(heldSkill.total.taskId)))
    check('Own Recorder waits for its actual skill file queue',finished,false)
    check('No Cleaner while original skill file remains queued',await read(heldSkill.files,paths.state('A',heldSkill.total.taskId)+'/Cleaner'),undefined)
    unlockSkill();await skillBlocker;const result=await finishSoon(saving)
    check('Original queued skill actually completes after release',result.result.saved,true)
    check('Original queued skill is not cancelled',await read(heldSkill.files,skill),skillText())
    await clean(heldSkill);check('Only completed Recorder invokes own cleanup',await read(heldSkill.files,paths.task(heldSkill.total.taskId)),undefined)
  }finally{unlockSkill();await skillBlocker}
  const heldIndex = await fixture(path.join(scratch, 'held-index'), 'held-index', false); opened.push(heldIndex.files)
  heldIndex.input.outputs.push({ path: skill, text: skillText() })
  let unlockIndex, enterIndex
  const indexGate = new Promise(resolve => unlockIndex = resolve), indexEntered = new Promise(resolve => enterIndex = resolve)
  const indexBlocker = heldIndex.files.updateAsync(frameworkSkillIndexPath, async () => { enterIndex(); await indexGate; return { value: undefined } })
  try {
    await indexEntered
    const result = await finishSoon(run(heldIndex))
    check('Held actual catalog queue does not block archive', result.result.saved, true)
    check('Held catalog does not turn a successful skill into a failed proposal', result.result.unmergedSkills, [])
    check('Held actual catalog result is reported unfinished', result.result.skillIssues.some(issue => issue.includes('unfinished at the archive handoff')), true)
    await finishSoon(clean(heldIndex))
    check('Actual Cleaner does not wait for held catalog queue', await read(heldIndex.files, paths.task(heldIndex.total.taskId)), undefined)
  } finally { unlockIndex(); await indexBlocker }
  // Actual final skill rename completion precedes this Recorder's own Cleaner.
  const nativeRename=fs.rename
  for(const outcome of ['success','failure']){
    const late=await fixture(path.join(scratch,'late-'+outcome),'late-'+outcome,false);opened.push(late.files);late.input.outputs.push({path:skill,text:skillText()})
    let releaseRename,enteredRename;const renameGate=new Promise(r=>releaseRename=r),renameEntered=new Promise(r=>enteredRename=r)
    fs.rename=async(from,to)=>{if(String(to)===path.join(late.files.directory,skill)){enteredRename();await renameGate;if(outcome==='failure')throw Error('controlled late skill rename failure')}return nativeRename(from,to)}
    try{
      let finished=false;const saving=run(late).then(result=>{finished=true;return result});await renameEntered
      check('Recorder remains active while issued rename returns '+outcome,finished,false)
      check('No Cleaner before issued rename returns '+outcome,await read(late.files,paths.state('A',late.total.taskId)+'/Cleaner'),undefined)
      releaseRename();const result=await finishSoon(saving)
      if(outcome==='success'){check('Actual returned skill success permits final save',result.result.saved,true);check('Actual returned skill bytes are preserved',await read(late.files,skill),skillText());await clean(late);check('Own Cleaner follows completed skill',await read(late.files,paths.task(late.total.taskId)),undefined)}
      else{check('Unconfirmed rename failure remains original Recorder work',result.result.pendingSkills[0].outcome,'unknown');check('Unconfirmed rename failure does not trigger Cleaner',await read(late.files,paths.state('A',late.total.taskId)+'/Cleaner'),undefined);check('Failed issued rename is not retried',await read(late.files,skill),undefined)}
    }finally{releaseRename();fs.rename=nativeRename}
  }
  const lostProcess=await fixture(path.join(scratch,'held-process-exit'),'held-process-exit',false);opened.push(lostProcess.files);lostProcess.input.outputs.push({path:skill,text:skillText()})
  await fs.writeFile(path.join(lostProcess.directory,'fixture.json'),JSON.stringify({total:lostProcess.total,family:lostProcess.family,input:lostProcess.input,native:lostProcess.native}))
  const lost=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--held-skill-exit',lostProcess.directory],{encoding:'utf8',timeout:4000})
  check('Actual process exits while original skill attempt is queued',lost.status,87)
  const lostResume=await run(lostProcess)
  check('Cold original queued operation completes under its original identity',lostResume.result.saved,true)
  check('Cold original queued skill executes its previously unapplied contribution',await read(lostProcess.files,skill),skillText())
  check('Only the completed cold original Recorder hands to Cleaner',await read(lostProcess.files,paths.state('A',lostProcess.total.taskId)+'/Cleaner'),'')
  // A normal current source read is allowed, but a changing stream is not
  // accepted as a consistent original and never sends Cleaner.
  const changing = await fixture(path.join(scratch, 'changing-original'), 'changing-original', false); opened.push(changing.files)
  const changingSource = paths.run(changing.total.taskId) + '/binary.bin'
  await changing.files.replace(changingSource, Buffer.alloc(768 * 1024, 65))
  const nativeOpen = fs.open; let sourceEdited = false
  fs.open = async (...args) => {
    const handle = await nativeOpen(...args)
    if (String(args[0]) === path.join(changing.files.directory, changingSource)) {
      const nativeRead = handle.read.bind(handle)
      handle.read = async (...reads) => {
        const result = await nativeRead(...reads)
        if (!sourceEdited && result.bytesRead) { sourceEdited = true; await fs.writeFile(path.join(changing.files.directory, changingSource), Buffer.alloc(768 * 1024, 66)) }
        return result
      }
    }
    return handle
  }
  try { await rejects('Actual Recorder rejects an original changed during streaming', () => run(changing), /changed during capture/) }
  finally { fs.open = nativeOpen }
  check('Changed original does not send Cleaner', await read(changing.files, paths.state('A', changing.total.taskId) + '/Cleaner'), undefined)
  check('Changed original remains ordinary readable user data', (await readBytes(changing.files, changingSource))[0], 66)
  check('Same accepted Recorder can later capture the now-stable source', (await run(changing)).result.saved, true)
  const changedRetention = JSON.parse(await read(changing.files, paths.archive(changing.total) + '/retention.json'))
  check('Later actual archive has latest stable original bytes', (await readBytes(changing.files, changedRetention.relocatedReferences[changingSource]))[0], 66)
  for (const mode of ['unchanged', 'user-edit', 'source-edit']) {
    const interrupted = await fixture(path.join(scratch, 'partial-' + mode), 'partial-' + mode, false); opened.push(interrupted.files)
    const exit = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--interrupt', 'original-partial', interrupted.directory], {encoding:'utf8'})
    check('Actual Recorder exits inside source capture ' + mode, exit.status, 86)
    const pending = JSON.parse(await read(interrupted.files, physicalRecorderPendingPath(interrupted.total.taskId)))
    const partial = paths.run(interrupted.total.taskId) + '/.recorder-handoff/' + hash(pending.commandId) + '/originals/' + hash(interrupted.total.sourcePath) + '.raw.copying'
    if (mode === 'unchanged') {
      check('Actual Recorder resumes only its owned unchanged partial', (await run(interrupted)).result.saved, true)
      await clean(interrupted)
      check('Completed resumed Recorder ends own capture metadata with known runtime cleanup', existsSync(path.join(interrupted.files.directory, paths.run(interrupted.total.taskId))), false)
    } else {
      if (mode === 'user-edit') await fs.writeFile(path.join(interrupted.files.directory, partial), 'user edited interrupted partial')
      else await interrupted.files.replace(interrupted.total.sourcePath, 'Task ID: ' + interrupted.total.taskId + '\nUser changed current requirement\n')
      const bytes = await readBytes(interrupted.files, partial)
      await rejects('Actual Recorder preserves ambiguous interrupted ' + mode, () => run(interrupted), /changed|preserved/)
      check('Actual Recorder does not overwrite interrupted ' + mode + ' bytes', await readBytes(interrupted.files, partial), bytes)
      check('Ambiguous interrupted ' + mode + ' does not trigger Cleaner', await read(interrupted.files, paths.state('A', interrupted.total.taskId) + '/Cleaner'), undefined)
    }
  }
  // Real material scale: 12 distinct 4MiB originals. Neither small command nor
  // progress metadata embeds bodies, and no archive destination is recopied.
  const large = await fixture(path.join(scratch, 'large-material'), 'large-material', false); opened.push(large.files)
  const materialBytes = 12 * 4 * 1024 * 1024
  for (let n = 0; n < 12; n++) {
    const logical = paths.run(large.total.taskId) + '/material-' + n + '.bin', bytes = Buffer.alloc(4 * 1024 * 1024, n)
    bytes[0] = 0xef; bytes[1] = 0xbb; bytes[2] = 0xbf
    await large.files.replace(logical, bytes); large.input.retainedPaths.push(logical)
  }
  let rawBytes = 0, rawWrites = 0, cursorBytes = 0, maxCursor = 0, commandBytes = 0, archiveReplacements = 0
  const largeCreate = large.files.createIfAbsent.bind(large.files), largeReplace = large.files.replace.bind(large.files), largeCopy = large.files.stageCopy.bind(large.files), largeRead = large.files.readBytes.bind(large.files)
  large.files.stageCopy = async (source, stage, signal) => { const prior = await large.files.fileInfo(stage), result = await largeCopy(source, stage, signal); if (!prior && result) { rawWrites++; rawBytes += result.bytes }; return result }
  large.files.readBytes = async (snapshot, logical) => { if (/material-\d+\.bin$/.test(logical) || logical.includes('/originals/') && logical.endsWith('.raw')) throw new Error('Recorder attempted a whole-original read instead of streaming: ' + logical); return largeRead(snapshot, logical) }
  large.files.createIfAbsent = async (p, content) => {
    const made = await largeCreate(p, content)
    if (made && p.includes('/originals/') && p.endsWith('.raw')) { rawWrites++; rawBytes += Buffer.byteLength(content) }
    return made
  }
  large.files.replace = async (p, content) => {
    if (p.endsWith('/progress.json')) { const bytes = Buffer.byteLength(content); cursorBytes += bytes; maxCursor = Math.max(maxCursor, bytes) }
    if (p === physicalRecorderPendingPath(large.total.taskId)) commandBytes += Buffer.byteLength(content)
    if (p.startsWith('archives/')) archiveReplacements++
    return largeReplace(p, content)
  }
  const memoryBefore = process.memoryUsage(), largeResult = await run(large), memoryAfter = process.memoryUsage()
  large.files.readBytes = largeRead
  check('48MiB actual originals archive while whole-original readBytes is forbidden', largeResult.result.saved, true)
  check('Original raw staging writes are once per selected source', rawWrites, 15)
  check('Original raw staging is linear in actual source bytes', rawBytes < materialBytes + 4096, true)
  check('Small command metadata never embeds originals', commandBytes < 20000, true)
  check('Publication cursor remains constant-size per file', maxCursor < 128, true)
  check('All cursor writes stay metadata-only', cursorBytes < 20000, true)
  check('Prepared archives publish via rename, not repeated byte replacement', archiveReplacements, 0)
  const bigManifest = JSON.parse(await read(large.files, paths.archive(large.total) + '/retention.json'))
  for (const n of [0, 5, 11]) {
    const body = await readBytes(large.files, bigManifest.relocatedReferences[paths.run(large.total.taskId) + '/material-' + n + '.bin'])
    check('Large original preserves BOM and raw body ' + n, [body.length, ...body.slice(0, 4)], [4 * 1024 * 1024, 239, 187, 191, n])
  }
  await clean(large)
  check('Large-operation stage/descriptor/cursor tree ends with actual cleanup', existsSync(path.join(large.files.directory, paths.run(large.total.taskId))), false)
  console.log(JSON.stringify({ passed: checks.length, processExitPoints: 14, scale: { materialBytes, rawBytes, rawWrites, commandBytes, cursorBytes, maxCursor, memoryBefore, memoryAfter }, checks, sourceHashes: Object.fromEntries(loaded), limitations: ['Controlled Linux Node24 files; no native DSH, Windows, full typecheck, build or deploy.', 'Simple fixture Markdown/YAML/schema/native-skill ports explicitly stubbed.'] }, null, 2))
} finally { await Promise.allSettled(opened.map(files => files.close())); hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
