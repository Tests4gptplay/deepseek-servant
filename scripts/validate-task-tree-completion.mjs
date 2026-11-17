import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Current requirement: child P/O success/cancellation only hands status/results
// to its parent. Only a root starts Foreground + Recorder and eventual Cleaner.
// These tests invoke current dss_complete/dss_recorder_save, cancelTask and the
// Host's real terminal scan with fresh in-memory FilesStore snapshots. Native
// DSH, schema validation, physical storage, Git transport and full typechecking
// are explicitly outside this controlled check. Markdown accepts only plain
// no-link fixtures through an explicit stub; skills are not published.
// No source is bundled/packaged.
const sourceRoot = new URL('../src/', import.meta.url)
const loaded = new Map()
const schemaStub = `
const schema = new Proxy(function () {}, {
  get(_target, key) { if (key === 'parse') return value => value; if (key === 'toJSONSchema') return () => ({}); return schema },
  apply() { return schema }
}); export const z = schema;
`
const skillsStub = `
export function isFrameworkSkillDefinitionPath(){throw new Error("Skill definition classification is outside this focused test")} export const frameworkSkillIndexPath = 'skills/index.md';
export async function prepareFrameworkSkillIndex(_files, _snapshot, changes) {
  if (changes.some(change => change.path.startsWith('skills/'))) throw new Error('Skill publication is outside this focused validation');
  return { changes: [], issues: [] };
}
`
const dataModule = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: dataModule(schemaStub), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: dataModule("export function fromMarkdown(text) { if (['[', ']', '<', '>'].some(mark => text.includes(mark))) throw new Error('Linked Markdown is outside this focused validation'); return { type: 'root', children: [] }; }"), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', sourceRoot).href) return { url: dataModule(skillsStub), shortCircuit: true }
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
  }
})
const { paths, encodeJson, taskCompletionSignals, childCompletionSignal, foregroundTaskSignal, taskInitializationFiles } = await import('../src/framework/task-files.ts')
const { cancelTask } = await import('../src/framework/task-cancellation.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { FrameworkHostLoop } = await import('../src/framework/host-loop.ts')
const { FrameworkCleaner, observeCleanup } = await import('../src/framework/cleaner.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { taskLifecycle, readJson } = await import('../src/framework/task-files.ts')
const { FilesConflictError, withSnapshot } = await import('../src/framework/transactions.ts')
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (action, pattern) => { await assert.rejects(action, pattern); assertions++ }
const digest = value => createHash('sha256').update(value).digest('hex')
class MemoryFiles {
  data = new Map()
  revision = 0
  writes = []
  seed(path, text) { this.data.set(path, text); this.revision++ }
  task(task) { this.seed(paths.task(task.taskId), encodeJson(task)); this.seed(task.sourcePath, 'Task ID: ' + task.taskId + '\nOriginal requirement\n') }
  async snapshot() { return { revision: String(this.revision), data: new Map(this.data), release: async () => {} } }
  async read(snapshot, path) { return snapshot.data.get(path) }
  async readBytes(snapshot, path) { const value = await this.read(snapshot, path); return value === undefined ? undefined : Buffer.from(value) }
  async list(snapshot, prefix) { return [...snapshot.data].filter(([path]) => path === prefix || path.startsWith(prefix.replace(/\/$/, '') + '/')).map(([path, value]) => ({ path, version: digest(value), bytes: Buffer.byteLength(value) })) }
  async listDirectory(snapshot, prefix, selection) {
    const root = prefix.replace(/\/$/, '') + '/'
    return (await this.list(snapshot, prefix)).filter(entry => !entry.path.slice(root.length).includes('/') && (!selection?.paths || selection.paths.includes(entry.path)))
  }
  async commit(snapshot, changes) {
    if (snapshot.revision !== String(this.revision)) throw new FilesConflictError(snapshot.revision)
    for (const change of changes) {
      if (change.deleteTree) { for (const path of this.data.keys()) if (path.startsWith(change.path + '/')) this.data.delete(path) }
      else if (change.content === null) this.data.delete(change.path)
      else this.data.set(change.path, change.content ?? Buffer.from(change.bytes).toString())
    }
    this.writes.push(structuredClone(changes)); this.revision++
    return { revision: String(this.revision), replay: false }
  }
  metadata(id) { return JSON.parse(this.data.get(paths.task(id))) }
}
const ids = [1, 2, 3, 4, 5].map(n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'))
function task(id, route, owner, parent) {
  return { version: 1, taskId: id, route, owner, status: 'running', sourcePath: `tasks/${id}_${route}.md`, archiveFolder: id, members: [owner], ...(parent ? { parent } : {}) }
}
function fixture() {
  const root = task(ids[0], 'O', 'A')
  const group = task(ids[1], 'O', 'B', { taskId: root.taskId, owner: root.owner, objectiveId: 'group' })
  const leaf = task(ids[2], 'P', 'C', { taskId: group.taskId, owner: group.owner, objectiveId: 'leaf' })
  const sibling = task(ids[3], 'P', 'D', { taskId: root.taskId, owner: root.owner, objectiveId: 'sibling' })
  group.archiveFolder = root.archiveFolder + '/' + group.taskId
  leaf.archiveFolder = group.archiveFolder + '/' + leaf.taskId
  sibling.archiveFolder = root.archiveFolder + '/' + sibling.taskId
  root.children = [{ objectiveId: 'group', taskId: group.taskId, member: group.owner }, { objectiveId: 'sibling', taskId: sibling.taskId, member: sibling.owner }]
  group.children = [{ objectiveId: 'leaf', taskId: leaf.taskId, member: leaf.owner }]
  const files = new MemoryFiles()
  for (const item of [root, group, leaf, sibling]) {
    files.task(item)
    for (const change of taskInitializationFiles(item)) files.seed(change.path, change.content)
    files.seed(paths.run(item.taskId) + '/evidence.md', 'Keep exact original evidence ' + item.taskId)
    files.seed(paths.state(item.owner, item.taskId) + '/recovery', '')
  }
  return { files, root, group, leaf, sibling }
}
function transactions(files) {
  const receipts = new Map()
  return async (id, request, options, build) => {
    if (receipts.has(id)) return { ...receipts.get(id), replay: true }
    options.beforeAttempt?.()
    const snapshot = await files.snapshot()
    const changes = await build(snapshot)
    const derived = options.deriveChanges ? await options.deriveChanges(snapshot, changes) : []
    const receipt = await files.commit(snapshot, [...changes, ...derived])
    receipts.set(id, receipt)
    return receipt
  }
}
function roleTools(files, selected, role = selected.route === 'P' ? 'Planner' : 'Organizer', transact = transactions(files), extraServices = {}) {
  const tools = new Map(), errors = []
  const agent = { id: role + ':' + selected.taskId, session: {} }
  const ctx = { on: () => () => {}, effect: () => {}, systemPrompt: { section: () => {} }, tools: { register: tool => tools.set(tool.name, tool) } }
  const binding = { role, taskId: selected.taskId, owner: selected.owner, member: selected.owner, workId: agent.id, executionId: agent.id + ':execution' }
  installFrameworkRoleTools(ctx, agent, binding, {
    files, transact, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => errors.push(error), ...extraServices
  })
  let ended = 0
  return { errors, get ended() { return ended }, call: async (name, input, callId = name) => {
    const tool = tools.get(name)
    assert.ok(tool, name)
    return tool.execute(input, { agent, callId, signal: new AbortController().signal, concludeTurn: () => ended++ })
  } }
}
const signalPaths = files => [...files.data.keys()].filter(path => path.startsWith('state/') && path.split('/').at(-1) !== 'recovery').sort()
async function complete(files, selected) {
  const role = roleTools(files, selected)
  const view = await role.call('dss_snapshot', {})
  const input = { snapshotId: view.snapshotId, acceptance: 'Accepted the real evidence.', resultPaths: [paths.run(selected.taskId) + '/evidence.md'] }
  await role.call('dss_complete', input)
  return { role, input }
}

try {
  // Both independent roots and nested P/O keep their own route and Task IDs.
  for (const route of ['P', 'O']) for (const status of ['running', 'complete', 'cancelled']) {
    const root = { ...task(ids[4], route, 'A'), status }
    check(taskCompletionSignals(root).map(item => item.path), [foregroundTaskSignal(root.taskId), paths.state('A', root.taskId) + '/Recorder'])
    check(taskCompletionSignals({ ...root, parent: { taskId: ids[0], owner: 'A', objectiveId: 'nested' } }), [])
  }

  const success = fixture()
  const originalEvidence = new Map([...success.files.data].filter(([path]) => path.endsWith('/evidence.md')))
  const leafDone = await complete(success.files, success.leaf)
  check(success.files.metadata(success.leaf.taskId).status, 'complete')
  check(success.files.metadata(success.leaf.taskId).resultPaths, [paths.run(success.leaf.taskId) + '/evidence.md'])
  check(signalPaths(success.files), [childCompletionSignal(success.leaf.parent, success.leaf.taskId)])
  check(JSON.parse(success.files.data.get(paths.memberStatus(success.leaf.taskId, success.leaf.owner))), { state: 'complete' })
  const writes = success.files.writes.length
  await leafDone.role.call('dss_complete', leafDone.input)
  check(success.files.writes.length, writes)
  await rejects(() => leafDone.role.call('dss_complete', leafDone.input, 'different-command'), /already closed/)
  await complete(success.files, success.group)
  await complete(success.files, success.sibling)
  check(signalPaths(success.files).some(path => path.endsWith('/Recorder') || path.endsWith('/Cleaner') || path.startsWith('state/Foreground')), false)
  await complete(success.files, success.root)
  check(signalPaths(success.files).filter(path => path.endsWith('/Recorder')), [paths.state(success.root.owner, success.root.taskId) + '/Recorder'])
  check(signalPaths(success.files).filter(path => path.startsWith('state/Foreground')), [foregroundTaskSignal(success.root.taskId)])
  for (const [path, value] of originalEvidence) check(success.files.data.get(path), value)
  for (const original of [success.root, success.group, success.leaf, success.sibling]) {
    const stored = success.files.metadata(original.taskId)
    check([stored.taskId, stored.route, stored.parent], [original.taskId, original.route, original.parent])
  }

  // Invalid parent associations cannot turn a child into a standalone root.
  const invalid = fixture()
  invalid.files.seed(paths.task(invalid.group.taskId), encodeJson({ ...invalid.group, children: [] }))
  await rejects(() => complete(invalid.files, invalid.leaf), /actual open parent/)
  check(signalPaths(invalid.files), [])
  check(invalid.files.metadata(invalid.leaf.taskId).status, 'running')

  // Cancellation of a selected child subtree notifies only its still-open
  // parent; cancellation of the total tree produces only one root Recorder.
  for (const selectRoot of [false, true]) {
    const { files, root, group, leaf, sibling } = fixture()
    const selected = selectRoot ? root : group
    const before = new Map(files.data), stops = []
    const access = { files, member: selected.owner, transact: transactions(files), afterCancel: async ids => stops.push(ids) }
    const result = await cancelTask(access, { taskId: selected.taskId }, 'cancel')
    check(new Set(result.cancelledTaskIds), new Set(selectRoot ? [root.taskId, group.taskId, sibling.taskId, leaf.taskId] : [group.taskId, leaf.taskId]))
    const signals = signalPaths(files)
    if (selectRoot) check(signals, [foregroundTaskSignal(root.taskId), paths.state(root.owner, root.taskId) + '/Recorder'].sort())
    else {
      check(signals.length, 1)
      check(signals[0].startsWith(paths.state(root.owner, root.taskId) + '/Organizer_ChildCancelled_'), true)
      check(files.metadata(root.taskId).status, 'running')
      check(files.metadata(sibling.taskId).status, 'running')
    }
    const writes = files.writes.length
    check(await cancelTask(access, { taskId: selected.taskId }, 'cancel'), result)
    check(files.writes.length, writes)
    check(stops.length, 2) // Replay may still reconcile native stopping.
    for (const [path, value] of before) if (!path.endsWith('.json')) check(files.data.get(path), value)
    await cancelTask(access, { taskId: selected.taskId }, 'cancel-again')
    check(signalPaths(files), signals)
  }

  // Cancellation does not rewrite already completed descendants or their result.
  const mixed = fixture()
  await complete(mixed.files, mixed.leaf)
  const leafBefore = mixed.files.data.get(paths.task(mixed.leaf.taskId))
  await cancelTask({ files: mixed.files, member: mixed.root.owner, transact: transactions(mixed.files) }, { taskId: mixed.root.taskId }, 'total-cancel')
  check(mixed.files.data.get(paths.task(mixed.leaf.taskId)), leafBefore)
  check(signalPaths(mixed.files).filter(path => path.endsWith('/Recorder')).length, 1)

  // Original shipped v44 task-files.ts taskCompletionSignals emitted Recorder
  // for child Tasks as well as roots. A retained old Recorder context must not
  // publish a child archive/Cleaner after the root-only design change. This
  // fixture represents that actual former producer, not invented old O behavior
  // and not evidence that any particular user has such a retained context.
  for (const selected of [success.group, success.leaf]) {
    const recorder = roleTools(success.files, success.files.metadata(selected.taskId), 'Recorder')
    const view = await recorder.call('dss_snapshot', {})
    const before = new Map(success.files.data)
    await rejects(() => recorder.call('dss_recorder_save', {
      snapshotId: view.snapshotId, outputs: [{ path: view.archiveRecordsPath, text: 'Should not be published' }], retainedPaths: []
    }), /Child Tasks retain their runtime/)
    check(success.files.data, before)
    check(recorder.ended, 0)
  }

  // Run the actual Host terminal scan, including cold recreation and stale
  // Recorder/Cleaner signals. It may seal the child's business lane, but cannot
  // schedule Recorder, delete files, or release its Host associations.
  for (const route of ['P', 'O']) for (const status of ['complete', 'cancelled']) {
    const { files, group, leaf } = fixture()
    const selected = { ...(route === 'P' ? leaf : group), status }
    files.seed(paths.task(selected.taskId), encodeJson(selected))
    files.seed(paths.state(selected.owner, selected.taskId) + '/Recorder', '')
    files.seed(paths.state(selected.owner, selected.taskId) + '/Cleaner', '')
    const retained = new Map(files.data), events = [], errors = []
    const storageMap = new Map()
    const storage = { get: async key => storageMap.get(key), set: async (key, value) => storageMap.set(key, value) }
    const actions = { wake: async request => { events.push(['wake', request.role]); return true }, executing: () => false,
      sealBusiness: async () => { events.push(['seal']) }, cancelledBusinessStopped: async () => true,
      clean: async () => { events.push(['clean']); return true }, releaseTask: async () => { events.push(['release']) }, error: error => errors.push(error) }
    for (let restart = 0; restart < 2; restart++) {
      const loop = new FrameworkHostLoop(files, {}, storage, { member: selected.owner, primary: true, scope: 'validation', instanceUUID: ids[4] }, () => [selected.owner], actions)
      for (let poll = 0; poll < 2; poll++) await loop.scanTask(selected, await files.snapshot(), performance.now())
    }
    check(errors, [])
    check(events.filter(([kind]) => ['wake', 'clean', 'release'].includes(kind)), [])
    check(events.filter(([kind]) => kind === 'seal').length, 1)
    for (const [path, value] of retained) check(files.data.get(path), value)
  }

  // Root Host behavior remains reachable, and a failed stop on a cancelled
  // root still defers Recorder, but never gates an existing Cleaner handoff.
  for (const stopped of [false, true]) {
    const { files, root } = fixture()
    const selected = { ...root, status: 'cancelled' }
    files.seed(paths.task(root.taskId), encodeJson(selected))
    files.seed(paths.state(root.owner, root.taskId) + '/Recorder', '')
    const events = [], errors = [], state = new Map()
    const loop = new FrameworkHostLoop(files, {}, { get: async key => state.get(key), set: async (key, value) => state.set(key, value) },
      { member: root.owner, primary: true, scope: 'validation', instanceUUID: ids[4] }, () => [root.owner], {
        wake: async request => { events.push(request.role); return true }, executing: () => false, sealBusiness: async () => {},
        cancelledBusinessStopped: async () => stopped, clean: async () => { events.push('Cleaner-observation'); return false }, error: error => errors.push(error)
      })
    await loop.scanTask(selected, await files.snapshot(), performance.now())
    check(errors, [])
    check(events, stopped ? ['Recorder'] : [])
  }

  // Total Cleaner discovery trusts its notification/continuation independently
  // of task status. Ordinary running work and child signals do not gain it.
  for (const kind of ['running-root-cleaner', 'cancelled-root-cleaner', 'running-root-continuation', 'ordinary-running-root', 'running-child-cleaner']) {
    const { files, root, leaf } = fixture()
    const child = kind === 'running-child-cleaner'
    const selected = { ...(child ? leaf : root), status: kind.startsWith('cancelled') ? 'cancelled' : 'running' }
    files.seed(paths.task(selected.taskId), encodeJson(selected))
    if (kind.endsWith('-cleaner')) {
      files.seed(paths.state(selected.owner, selected.taskId) + '/Cleaner', '')
      files.seed(paths.state(selected.owner, selected.taskId) + '/Recorder', '')
    }
    const continuing = kind.endsWith('-continuation')
    if (continuing) files.seed(paths.archive(selected) + '/state.json', encodeJson({ version: 1, taskId: selected.taskId, lifecycles: { '': { cleanup: { phase: 'files-cleaned', deletedPaths: [] } } } }))
    if (kind === 'ordinary-running-root') files.seed(paths.state(root.owner, root.taskId) + '/Organizer_Task', '')
    const events = [], errors = [], listed = []
    const listDirectory = files.listDirectory.bind(files)
    files.listDirectory = async (...args) => { listed.push(args[1]); return listDirectory(...args) }
    const storage = { get: async () => undefined, set: async () => {} }
    const loop = new FrameworkHostLoop(files, {}, storage,
      { member: selected.owner, primary: true, scope: 'independent-cleaner', instanceUUID: ids[4] }, () => [selected.owner], {
        wake: async request => { events.push(request.role); return true }, executing: () => false,
        sealBusiness: async () => { events.push('seal') }, cancelledBusinessStopped: async () => { events.push('cancel-stop'); return false },
        clean: async (_task, _snapshot, observation) => { events.push('clean'); check(observation.status, continuing ? 'files-cleaned' : 'delete'); return false }, error: error => errors.push(error)
      })
    await loop.scanTask(selected, await files.snapshot(), performance.now())
    check(errors, [])
    check(events, child ? [] : kind === 'ordinary-running-root' ? ['Organizer'] : ['clean'])
    check(listed.filter(prefix => prefix === paths.state(selected.owner, selected.taskId)).length, continuing ? 0 : 1)
  }

  // The total Recorder reads each real child's Cache and original process
  // material, including nested O -> P Worker records, without child archives.
  const reading = fixture()
  const { files: readFiles, root: readRoot, group: readGroup, leaf: readLeaf, sibling: readSibling } = reading
  for (const item of [readRoot, readGroup, readLeaf, readSibling]) readFiles.seed(paths.task(item.taskId), encodeJson({ ...item, status: 'complete' }))
  const workerRoot = paths.member(readLeaf.taskId, readLeaf.owner) + '/workers/worker-one'
  for (const name of ['contract.md', 'notes.md', 'reply.md', 'handoff.json', 'records/first.md']) readFiles.seed(workerRoot + '/' + name, 'Actual child material: ' + name)
  const leafCache = JSON.parse(readFiles.data.get(paths.cache(readLeaf.taskId)))
  leafCache.links.push({ kind: 'file', path: 'materials/child-only.md' }, { kind: 'directory', path: 'materials/child-folder/' })
  readFiles.seed(paths.cache(readLeaf.taskId), encodeJson(leafCache))
  readFiles.seed('materials/child-only.md', 'Exact delegated file')
  readFiles.seed('materials/child-folder/nested/details.md', 'Linked directory evidence')
  readFiles.seed('materials/child-folder-other/private.md', 'Not linked')
  const unrelated = task(ids[4], 'P', 'outsider')
  readFiles.task(unrelated)
  readFiles.seed(paths.run(unrelated.taskId) + '/private.md', 'Unrelated task')
  const capacityCalls = []
  const rootRecorder = roleTools(readFiles, readRoot, 'Recorder', transactions(readFiles), {
    capacity: async (_agent, input, snapshot) => { capacityCalls.push(input); return { paths: input.paths, revision: snapshot.revision } }
  })
  const claim = await rootRecorder.call('dss_claim', {})
  const snapshotId = claim.snapshotId
  for (const item of [readGroup, readLeaf, readSibling]) {
    for (const path of [paths.task(item.taskId), paths.cache(item.taskId)]) {
      const result = await rootRecorder.call('dss_read', { snapshotId, path })
      check(result.text, readFiles.data.get(path))
    }
    const source = await rootRecorder.call('dss_read', { snapshotId, path: item.sourcePath })
    check(source.text, readFiles.data.get(item.sourcePath))
    check(source.path, 'task-references/' + item.taskId + '/' + encodeURIComponent(item.sourcePath))
    const alias = await rootRecorder.call('dss_read', { snapshotId, path: source.path })
    check(alias.text, source.text)
  }
  for (const path of [paths.run(readGroup.taskId) + '/Organizer_Note.md', paths.member(readLeaf.taskId, readLeaf.owner) + '/Planner_Memory.md',
    ...['contract.md', 'notes.md', 'reply.md', 'handoff.json', 'records/first.md'].map(name => workerRoot + '/' + name),
    'materials/child-only.md', 'materials/child-folder/nested/details.md']) {
    const result = await rootRecorder.call('dss_read', { snapshotId, path })
    check(result.exists, true)
    check(result.text, readFiles.data.get(path))
  }
  const direct = await rootRecorder.call('dss_list', { snapshotId, directory: workerRoot })
  check(direct.files.map(file => file.path).sort(), ['contract.md', 'notes.md', 'reply.md', 'handoff.json'].map(name => workerRoot + '/' + name).sort())
  const recursive = await rootRecorder.call('dss_list', { snapshotId, directory: workerRoot + '/', recursive: true })
  check(recursive.files.some(file => file.path === workerRoot + '/records/first.md'), true)
  check((await rootRecorder.call('dss_recorder_capacity', { snapshotId, paths: [workerRoot + '/notes.md', readLeaf.sourcePath] })).paths,
    [workerRoot + '/notes.md', readLeaf.sourcePath])
  check(capacityCalls.length, 1)
  for (const path of [paths.task(unrelated.taskId), unrelated.sourcePath, paths.run(unrelated.taskId) + '/private.md',
    'materials/child-folder-other/private.md', paths.run(readLeaf.taskId) + '-adjacent/secret.md']) {
    const original = await rootRecorder.call('dss_read', { snapshotId, path })
    check(original.exists, readFiles.data.has(path))
    if (original.exists) check(original.text, readFiles.data.get(path))
  }
  for (const directory of ['task-runs', 'tasks', 'Recorder Cache/' + readLeaf.taskId, 'materials/child-only.md']) {
    const listed = await rootRecorder.call('dss_list', { snapshotId, directory, recursive: true })
    check(Array.isArray(listed.files), true)
  }
  await rejects(() => rootRecorder.call('dss_read', { snapshotId,
    path: 'task-references/' + unrelated.taskId + '/' + encodeURIComponent(unrelated.sourcePath) }), /outside this Task requirement chain/)
  check([...readFiles.data.keys()].some(path => path.startsWith('archives/')), false)
  // A fixed Git read view retains its bytes; Cache is not read admission.
  readFiles.seed(workerRoot + '/notes.md', 'Later write')
  check((await rootRecorder.call('dss_read', { snapshotId, path: workerRoot + '/notes.md' })).text, 'Actual child material: notes.md')
  readFiles.seed(paths.task(readGroup.taskId), encodeJson({ ...readGroup, status: 'complete', children: [] }))
  const latest = await rootRecorder.call('dss_snapshot', {})
  check((await rootRecorder.call('dss_read', { snapshotId: latest.snapshotId, path: workerRoot + '/notes.md' })).text, 'Later write')
  readFiles.seed(paths.task(readGroup.taskId), encodeJson({ ...readGroup, status: 'complete', children: [{ ...readGroup.children[0], member: 'wrong-owner' }] }))
  const broken = await rootRecorder.call('dss_snapshot', {})
  await rejects(() => rootRecorder.call('dss_read', { snapshotId: broken.snapshotId, path: workerRoot + '/notes.md' }), /association.*inconsistent/)
  // The root can still read its own original even when one child edge needs repair.
  check((await rootRecorder.call('dss_read', { snapshotId: broken.snapshotId, path: readRoot.sourcePath })).exists, true)

  // Root save ownership checks are exercised before retention/Markdown or
  // skill publication. Each node's technical/history files remain protected.
  const saving = fixture()
  for (const item of [saving.root, saving.group, saving.leaf, saving.sibling]) saving.files.seed(paths.task(item.taskId), encodeJson({ ...item, status: 'complete' }))
  const totalRecorder = roleTools(saving.files, saving.root, 'Recorder')
  const saveView = await totalRecorder.call('dss_snapshot', {})
  const rootOutput = { path: saveView.archiveRecordsPath, text: 'Total account' }
  const saveBefore = new Map(saving.files.data)
  const invalidOutputs = [
    { output: 'archives/unrelated_' + ids[4] + '/records.md', pattern: /actual Task tree/ },
    ...[saving.root, saving.group, saving.leaf, saving.sibling].flatMap(item => [
      { output: paths.archive(item) + '/state.json', pattern: /program-managed/ },
      { output: paths.archive(item) + '/state.json/nested', pattern: /program-managed/ },
      { output: paths.archive(item) + '/retention.json', pattern: /program-managed/ },
      { output: paths.archive(item) + '/lifecycles/old/records.md', pattern: /read-only historical/ }
    ])
  ]
  for (const { output, pattern } of invalidOutputs) {
    await rejects(() => totalRecorder.call('dss_recorder_save', { snapshotId: saveView.snapshotId,
      outputs: [rootOutput, { path: output, text: 'Must not write' }], retainedPaths: [] }, output), pattern)
    check(saving.files.data, saveBefore)
  }
  await rejects(() => totalRecorder.call('dss_recorder_save', { snapshotId: saveView.snapshotId,
    outputs: [{ path: paths.archive(saving.leaf) + '/records.md', text: 'Only child summary' }], retainedPaths: [] }, 'missing-root'), /Save the AI-authored Task records/)
  check(totalRecorder.ended, 0)

  // A valid total save may include an optional child's authored file and
  // explicitly selected evidence and requirement, with no per-child records.md
  // or child Recorder. The
  // Markdown shim accepts only no-link plain text; skill publication is not run.
  const leafOutputPath = paths.archive(saving.leaf) + '/process.md'
  const leafOriginal = paths.run(saving.leaf.taskId) + '/evidence.md'
  const saveInput = { snapshotId: saveView.snapshotId, outputs: [rootOutput, { path: leafOutputPath, text: 'Child process account' }], retainedPaths: [leafOriginal, saving.leaf.sourcePath] }
  await totalRecorder.call('dss_recorder_save', saveInput, 'valid-total-save')
  check(totalRecorder.ended, 1)
  check(saving.files.data.get(rootOutput.path), 'Total account')
  check(saving.files.data.get(leafOutputPath), 'Child process account')
  const catalog = JSON.parse(saving.files.data.get(paths.archive(saving.root) + '/retention.json'))
  check(catalog.outputs, [rootOutput.path, leafOutputPath])
  check(catalog.relocatedReferences[leafOriginal].startsWith(paths.archive(saving.leaf) + '/retained/'), true)
  check(saving.files.data.get(catalog.relocatedReferences[leafOriginal]), saving.files.data.get(leafOriginal))
  check(saving.files.data.has(paths.archive(saving.sibling) + '/records.md'), false)
  check(signalPaths(saving.files), [paths.state(saving.root.owner, saving.root.taskId) + '/Cleaner'])
  const beforeReplay = saving.files.writes.length
  await totalRecorder.call('dss_recorder_save', saveInput, 'valid-total-save')
  check(saving.files.writes.length, beforeReplay)

  // After the one total cleanup, child original aliases resolve through the
  // root catalog; child catalogs/Recorders are still absent and unnecessary.
  const savedCleaner = new FrameworkCleaner(saving.files, {
    runObservedFinalization: async (_id, _request, snapshot, build) => saving.files.commit(snapshot, await build(snapshot))
  })
  {
    const snapshot = await saving.files.snapshot()
    await savedCleaner.clean(saving.root, await observeCleanup(saving.files, snapshot, saving.root, performance.now()))
  }
  const afterSaveCleanup = await totalRecorder.call('dss_snapshot', {})
  const childAlias = 'task-references/' + saving.leaf.taskId + '/' + encodeURIComponent(saving.leaf.sourcePath)
  const childRequirement = await totalRecorder.call('dss_read', { snapshotId: afterSaveCleanup.snapshotId, path: childAlias })
  check(childRequirement.exists, true)
  check(childRequirement.text, saveBefore.get(saving.leaf.sourcePath))
  check(saving.files.data.has(saving.leaf.sourcePath), false)
  check(saving.files.data.has(paths.archive(saving.leaf) + '/retention.json'), false)
  savedCleaner.close()

  // A relevant concurrent parent change invalidates a completion attempt;
  // failed/unknown publication never becomes a successful child handoff.
  const racing = fixture()
  let changed = false
  const racedTransact = async (_id, _request, _options, build) => {
    const snapshot = await racing.files.snapshot()
    const changes = await build(snapshot)
    if (!changed) {
      changed = true
      racing.files.seed(paths.task(racing.group.taskId), encodeJson({ ...racing.group, status: 'cancelled' }))
    }
    return racing.files.commit(snapshot, changes)
  }
  const racingRole = roleTools(racing.files, racing.leaf, 'Planner', racedTransact)
  const racingView = await racingRole.call('dss_snapshot', {})
  const racingInput = { snapshotId: racingView.snapshotId, acceptance: 'Racing acceptance', resultPaths: [paths.run(racing.leaf.taskId) + '/evidence.md'] }
  await rejects(() => racingRole.call('dss_complete', racingInput), /Storage changed/)
  check(racing.files.metadata(racing.leaf.taskId).status, 'running')
  check(signalPaths(racing.files), [])
  await rejects(() => racingRole.call('dss_complete', racingInput), /actual open parent/)
  check(racingRole.ended, 0)

  // The actual total Cleaner and Host lane acknowledgement run together.
  // Native stop/release callbacks are controlled; no child Cleaner is called.
  const finalizing = fixture()
  const finalFamily = [finalizing.root, finalizing.group, finalizing.sibling, finalizing.leaf].map(item => ({ ...item, status: 'complete' }))
  for (const item of finalFamily) finalizing.files.seed(paths.task(item.taskId), encodeJson(item))
  finalizing.files.seed(paths.state(finalizing.root.owner, finalizing.root.taskId) + '/Cleaner', '')
  const releaseCalls = [], cleanCalls = [], cleanupErrors = [], hostState = new Map()
  const cleaner = new FrameworkCleaner(finalizing.files, {
    runObservedFinalization: async (_id, _request, snapshot, build) => finalizing.files.commit(snapshot, await build(snapshot))
  })
  const hostStorage = { get: async key => hostState.get(key), set: async (key, value) => hostState.set(key, value) }
  const hostIdentity = { member: finalizing.root.owner, primary: true, scope: 'total-cleanup', instanceUUID: ids[4] }
  const cleanupActions = {
    wake: async () => { throw new Error('No Recorder wake remains during this total handoff') }, executing: () => false,
    sealBusiness: async () => {}, releaseTask: async taskId => { releaseCalls.push(taskId) }, error: error => cleanupErrors.push(error),
    clean: async (member, _snapshot, observation) => {
      cleanCalls.push(member.taskId)
      try { return (await cleaner.clean(member, observation)).status === 'deleted' }
      catch (error) { if (error instanceof FilesConflictError) return false; throw error }
    }
  }
  const totalHost = new FrameworkHostLoop(finalizing.files, {}, hostStorage, hostIdentity, () => [hostIdentity.member], cleanupActions)
  for (let poll = 0; poll < 4; poll++) await totalHost.scanTask(finalFamily[0], await finalizing.files.snapshot(), performance.now())
  check(cleanupErrors, [])
  check(releaseCalls, [...finalFamily].reverse().map(item => item.taskId))
  check([...new Set(cleanCalls)], [finalizing.root.taskId])
  const deleteTransactions = finalizing.files.writes.filter(changes => changes.some(change => change.content === null))
  check(deleteTransactions.length, 1)
  for (const item of finalFamily) {
    check(await totalHost.taskReleased(item.taskId), true)
    check(finalizing.files.data.has(paths.run(item.taskId) + '/evidence.md'), false)
    check(finalizing.files.data.has(paths.cache(item.taskId)), false)
    check(finalizing.files.data.has(item.sourcePath), false)
    check(finalizing.files.metadata(item.taskId).status, 'complete')
  }
  const afterTotalCleanup = new Map(finalizing.files.data)
  const coldHost = new FrameworkHostLoop(finalizing.files, {}, hostStorage, hostIdentity, () => [hostIdentity.member], cleanupActions)
  const cleanCallCount = cleanCalls.length
  for (const item of finalFamily) await coldHost.scanTask(item, await finalizing.files.snapshot(), performance.now())
  check(cleanCalls.length, cleanCallCount)
  check(finalizing.files.data, afterTotalCleanup)
  cleaner.close()

  // If one Host release remains unknown, confirmed directory deletion is not
  // repeated and this Host does not re-release its already completed child.
  const partial = fixture(), partialEvents = [], partialErrors = []
  const partialFamily = [partial.root, partial.group, partial.sibling, partial.leaf]
  partial.files.seed(paths.state(partial.root.owner, partial.root.taskId) + '/Cleaner', '')
  const partialCleaner = new FrameworkCleaner(partial.files, {
    runObservedFinalization: async (_id, _request, snapshot, build) => partial.files.commit(snapshot, await build(snapshot))
  })
  let pendingRelease = true
  const partialHost = new FrameworkHostLoop(partial.files, {}, { get: async () => undefined, set: async () => {} },
    hostIdentity, () => [hostIdentity.member], {
      wake: async () => { throw new Error('No new role during the accepted cleanup') }, executing: () => false,
      sealBusiness: async () => {}, error: error => partialErrors.push(error),
      clean: async (selected, _snapshot, observation) => (await partialCleaner.clean(selected, observation)).status === 'deleted',
      releaseTask: async taskId => { partialEvents.push(taskId); if (pendingRelease && taskId === partial.sibling.taskId) throw new Error('Original Host stop remains unknown') }
    })
  await partialHost.scanTask(partial.root, await partial.files.snapshot(), performance.now())
  check(partialErrors.map(error => error.message), ['Original Host stop remains unknown'])
  check(partialEvents, [partial.leaf.taskId, partial.sibling.taskId, partial.group.taskId, partial.root.taskId])
  for (const member of partialFamily) check(partial.files.data.has(paths.run(member.taskId) + '/evidence.md'), false)
  check(await partialHost.taskReleased(partial.leaf.taskId), true)
  check(await partialHost.taskReleased(partial.sibling.taskId), false)
  check(await partialHost.taskReleased(partial.group.taskId), true)
  check(await partialHost.taskReleased(partial.root.taskId), false)
  pendingRelease = false
  await partialHost.scanTask(partial.root, await partial.files.snapshot(), performance.now())
  check(partialEvents, [partial.leaf.taskId, partial.sibling.taskId, partial.group.taskId, partial.root.taskId, partial.sibling.taskId, partial.root.taskId])
  check(partial.files.writes.filter(changes => changes.some(change => change.deleteTree)).length, 1)
  check(await partialHost.taskReleased(partial.root.taskId), true)
  partialCleaner.close()

  // Invoke the exact transpiled cleanAt method from current role-runtime.ts.
  // Its class/native environment is replaced with explicit dependency fakes,
  // not a copied implementation. This tests method logic, not native stopping.
  const runtimeText = readFileSync(new URL('framework/role-runtime.ts', sourceRoot), 'utf8')
  const runtimeJs = stripTypeScriptTypes(runtimeText, { mode: 'transform' })
  const methodStart = runtimeJs.indexOf('async cleanAt(')
  const methodEnd = runtimeJs.indexOf('\n    async releaseLocalTask(', methodStart)
  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'Current runtime method boundaries must be present')
  const RuntimeCleanCase = new Function('paths', 'taskLifecycle', 'return class { ' + runtimeJs.slice(methodStart, methodEnd) + ' }')(paths, taskLifecycle)
  const runCleanCase = async ({ rootRecorderPending = false, selectedChild = false } = {}) => {
    const { files, root, group, leaf, sibling } = fixture()
    const family = [root, group, leaf, sibling].map(item => ({ ...item, status: 'complete' }))
    files.seed(paths.state(leaf.owner, leaf.taskId) + '/Recorder', '') // stale, never a child archive prerequisite
    if (rootRecorderPending) files.seed(paths.state(root.owner, root.taskId) + '/Recorder', '')
    const calls = []
    const runtime = {
      files, cleanupResidues: new Map(),
      cleaner: { clean: async member => { calls.push(['clean', member.taskId]); return { status: 'deleted' } } },
      environment: { changed: () => calls.push(['changed']) }
    }
    const selected = selectedChild ? family[2] : family[0]
    const result = await RuntimeCleanCase.prototype.cleanAt.call(runtime, selected, await files.snapshot(), { status: 'delete', task: selected, family })
    return { result, calls, family }
  }
  // Trust the existing total Cleaner handoff regardless of lingering role
  // signals or native/business observations. Stopping belongs after deletion.
  for (const formerGate of [{ rootRecorderPending: true }, {}]) {
    const tested = await runCleanCase(formerGate)
    check(tested.result, true)
    check(tested.calls, [['clean', tested.family[0].taskId], ['changed']])
  }
  const childCleanup = await runCleanCase({ selectedChild: true })
  check(childCleanup.result, false)
  check(childCleanup.calls, [])
  check(runtimeText.includes('this.cleaner = new FrameworkCleaner(files, this.transactions)'), true)
  check(runtimeText.includes('assertCleanupRoleAuthority'), false)
  check(runtimeText.includes('assertCleanupOrganizerAuthority'), false)

  // Actual post-delete release method: an unknown native stop keeps its
  // association unresolved, but never retroactively blocks or repeats deletion.
  const releaseStart = runtimeJs.indexOf('async releaseLocalTask(')
  const releaseEnd = runtimeJs.indexOf('\n    async cancelledOrganizerStopped(', releaseStart)
  assert.ok(releaseStart >= 0 && releaseEnd > releaseStart)
  const RuntimeReleaseCase = new Function('withSnapshot', 'readJson', 'paths', 'taskLifecycle', 'PhysicalLocalFiles',
    'return class { ' + runtimeJs.slice(releaseStart, releaseEnd) + ' }')(withSnapshot, readJson, paths, taskLifecycle, PhysicalLocalFiles)
  const uncertain = fixture()
  for (const member of [uncertain.root, uncertain.group, uncertain.leaf, uncertain.sibling]) uncertain.files.seed(paths.task(member.taskId), encodeJson({ ...member, status: 'complete' }))
  uncertain.files.seed(paths.state(uncertain.root.owner, uncertain.root.taskId) + '/Cleaner', '')
  let nativeStopConfirmed = false
  const releaseEvents = [], oldExecution = { identity: { taskId: uncertain.leaf.taskId, executionId: 'retained-native' }, stopped: false }
  const releaseRuntime = {
    files: uncertain.files, cleanupResidues: new Map(), roleRecords: new Map([['retained-native', oldExecution]]),
    stopOwnedRecord: async record => { releaseEvents.push(['stop', record.identity.taskId]); return nativeStopConfirmed ? { status: 'stopped' } : { status: 'unconfirmed', reason: 'Native stop remains unknown' } },
    saveRole: async record => { releaseRuntime.roleRecords.set('retained-native', record); releaseEvents.push(['saved-stop', record.identity.taskId]) },
    releaseTask: async member => { releaseEvents.push(['released', member.taskId]) }
  }
  const uncertainCleaner = new FrameworkCleaner(uncertain.files, {
    runObservedFinalization: async (_id, _request, snapshot, build) => uncertain.files.commit(snapshot, await build(snapshot))
  })
  const observeUncertain = async () => observeCleanup(uncertain.files, await uncertain.files.snapshot(), uncertain.files.metadata(uncertain.root.taskId), performance.now())
  check((await uncertainCleaner.clean(uncertain.root, await observeUncertain())).status, 'deleted')
  check(uncertain.files.data.has(paths.run(uncertain.leaf.taskId) + '/evidence.md'), false)
  check(releaseEvents, [])
  await rejects(async () => RuntimeReleaseCase.prototype.releaseLocalTask.call(releaseRuntime, uncertain.leaf.taskId, uncertain.leaf.lifecycleId, uncertain.leaf), /Native stop remains unknown/)
  check(releaseRuntime.roleRecords.get('retained-native').stopped, false)
  check(releaseEvents.filter(([kind]) => kind === 'released'), [])
  nativeStopConfirmed = true
  check((await uncertainCleaner.clean(uncertain.root, await observeUncertain())).status, 'deleted')
  await RuntimeReleaseCase.prototype.releaseLocalTask.call(releaseRuntime, uncertain.leaf.taskId, uncertain.leaf.lifecycleId, uncertain.leaf)
  check(releaseRuntime.roleRecords.get('retained-native').stopped, true)
  check(releaseEvents.filter(([kind]) => kind === 'released').at(-1), ['released', uncertain.leaf.taskId])
  check(uncertain.files.writes.filter(changes => changes.some(change => change.content === null)).length, 1)
  uncertainCleaner.close()

  // Source checks only for the native runtime admission path; no DSH Agent is
  // started here. A retained v44 child Recorder request is covered structurally,
  // not claimed as a native resume test or an existing user record.
  const runtime = readFileSync(new URL('framework/role-runtime.ts', sourceRoot), 'utf8')
  stripTypeScriptTypes(runtime, { mode: 'transform' })
  check(runtime.includes("if (request.role === 'Recorder') return !!task && (!!task.parent || task.owner !== this.config.member || !isTerminalTask(task));"), true)
  check(runtime.includes('if (task?.parent) return [];'), true)
  loaded.set('framework/role-runtime.ts', digest(runtime))
  console.log(JSON.stringify({ result: 'PASS', assertions, node: process.version,
    scope: 'Current-source controlled completion/cancellation/Host-lane checks; schema and native Agent execution stubbed/unrun',
    loadedSourceSha256: Object.fromEntries([...loaded].sort(([a], [b]) => a.localeCompare(b))) }, null, 2))
} finally { hooks.deregister() }
