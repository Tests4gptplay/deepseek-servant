import { readTaskArchiveIdentity, taskArchiveReadPath } from './task-archive.js'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { readTaskReferenceIdentity, taskHistoryChange } from './task-history.js'
import { materialLinks, parseTaskReference, referenceTaskId, taskReference } from './published-references.js'
import { linkedChild, taskFamily } from './task-relations.js'
import { fileReadFingerprint, withReevaluatedFileTarget } from './file-read-observation.js'
import { createHash } from 'node:crypto'
import { filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'
import { encodeJson, paths, taskArchiveOwnsPath, taskArchiveSelection, readJson, taskIdentity, taskLifecycle, taskWorkingRoots, type TaskMetadata } from './task-files.js'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const within = (path: string, root: string) => path === root || path.startsWith(root + '/')
/** Live skills have their own lifecycle. Archived copies remain ordinary Task
 * material; a historical Task must not freeze or rewrite the current skill. */
export const isLiveSkillReference = (path: string): boolean => within(filePath(path), 'skills')
/** Recorder-owned archive catalog, not a Cleaner permission or input snapshot. */
export interface RetentionManifest {
  workspaceResults?: TaskMetadata['workspaceResults']
  lifecycleId?: string
  relocatedReferences?: Record<string, string>
  relocatedSources?: Record<string, { sourcePath: string; sourceRevision: string; sha256: string }>
  outputs: string[]
  retainedPaths: string[]
  recorderRequest?: string
  skillPublication?: { issues: string[]; unmerged: Array<{ path: string; reason: string; proposalPreservedAt: string }> }
  recorderCommand?: string
  verifiedReferences?: Record<string, string>
  /** Original references actually absent during this retention attempt. */
  missingReferences?: string[]
}
export function taskStateSignal(task: TaskMetadata, path: string, bytes: { byteLength: number }): boolean {
  return [...new Set([task.owner, ...(task.members ?? [])])].some(member => within(path, paths.state(member, task.taskId)))
    && (bytes.byteLength === 0 || /^(recovery|Cleaner|complete|running|(?:Foreground|Planner|Worker|Organizer|Recorder|Helper)(?:_.*)?)$/.test(path.split('/').at(-1)!))
}
/** Physical Recorder can retain one original at a time in its own exact staging
 * files. The builder keeps reference metadata, not every original body. Git's
 * existing immutable transaction plan continues to use the default path. */
export interface RecorderRetentionOriginalSink {
  info(sourcePath: string): Promise<{ bytes: number; directory?: false } | { directory: true } | undefined>
  taskIdentity(sourcePath: string): Promise<string | undefined>
  retain(sourcePath: string, archiveRoot: string): Promise<{ path: string; bytes: number; sha256: string } | undefined>
  fingerprint(path: string): Promise<string | undefined>
}
/** A link explicitly authored in this save selects that material. Do not walk
 * the linked body or infer retention from old catalogs or unselected originals.
 * Normalize requirement links before independent skill publication as well as
 * archive publication, so later reuse of a submission filename is unambiguous. */
export function selectRecorderOutputReferences<T extends { path: string; text: string }>(members: readonly TaskMetadata[], outputs: readonly T[]): { outputs: T[]; retainedPaths: string[] } {
  const roots = members.flatMap(taskWorkingRoots), retainedPaths = new Set<string>()
  return { outputs: outputs.map(output => {
    let text = output.text
    for (const link of materialLinks(output.text).reverse()) {
      let explicit: ReturnType<typeof parseTaskReference>
      try { explicit = parseTaskReference(link.path) } catch { continue }
      const owners = members.filter(member => explicit
        ? member.taskId === explicit.taskId && member.sourcePath === explicit.original : member.sourcePath === link.path)
      if (owners.length > 1) throw new Error('Ambiguous Task requirement link: ' + link.path)
      if (owners.length === 1) {
        const owner = owners[0]!
        retainedPaths.add(owner.sourcePath)
        text = text.slice(0, link.start) + taskReference(owner.taskId, owner.sourcePath) + text.slice(link.end)
      } else if (roots.some(root => within(link.path, root))) retainedPaths.add(link.path)
    }
    return text === output.text ? output : { ...output, text }
  }), retainedPaths: [...retainedPaths] }
}
export async function prepareRecorderOutputReferences<T extends { path: string; text: string }>(files: FilesStore, snapshot: FilesSnapshot,
  task: TaskMetadata, outputs: readonly T[]): Promise<{ outputs: T[]; retainedPaths: string[] }> {
  const family = task.parent ? await taskRequirementChain(files, snapshot, task, true) : await taskFamily(files, snapshot, task.taskId)
  return selectRecorderOutputReferences(family.length ? family : [task], outputs)
}
/** Copy authoritative bytes, never generate a summary or reinterpret native files.
 * Recorder persists this plan with its archive before sending its Cleaner signal. */
export async function prepareRecorderRetention(files: FilesStore, snapshot: FilesSnapshot, task: TaskMetadata,
  manifest: RetentionManifest, staged: readonly FileChange[], originals?: RecorderRetentionOriginalSink): Promise<{ changes: FileChange[]; ancestorChanges: FileChange[]; task: TaskMetadata; retention: RetentionManifest }> {
  if (taskLifecycle(task) !== taskLifecycle(manifest)) throw new Error('Recorder retention belongs to another Task lifecycle.')
  // A total Recorder owns the known task tree's material. Children do not run
  // their own Recorder or move their originals before the total handoff.
  const family = task.parent ? [task] : await taskFamily(files, snapshot, task.taskId)
  const members = family.length ? family : [task]
  for (const change of staged) if (change.path.startsWith('archives/')
    && !members.some(member => taskArchiveOwnsPath(member, change.path)))
    throw new Error('Recorder archive output is outside this total Task tree.')
  const changes = new Map(staged.map(change => [change.path, change]))
  const archive = paths.archive(task)
  const commandRoots = members.flatMap(member => [paths.run(member.taskId) + '/.command-receipts', paths.run(member.taskId) + '/.recorder-handoff.json', paths.run(member.taskId) + '/.recorder-handoff'])
  const recorderStage = (path: string) => members.some(member => path.startsWith(paths.run(member.taskId) + '/.recorder-cleaner-') && /^\.recorder-cleaner-[a-f0-9]{64}\.stage$/.test(path.split('/').at(-1)!))
  const programStates = new Set(members.map(member => paths.archive(member) + '/state.json'))
  if (manifest.retainedPaths.some(path => commandRoots.some(root => within(path, root)) || recorderStage(path))) throw new Error('Task command receipts and Recorder handoff material are not retained outputs.')
  if (manifest.retainedPaths.some(path => programStates.has(path))) throw new Error('Program state is not a Recorder retained output.')
  const roots = members.flatMap(taskWorkingRoots), mapping = { ...manifest.relocatedReferences }, sources = { ...manifest.relocatedSources }
  // Git reuses only this immutable view’s reads. Physical capture streams into
  // exact owned stages and keeps descriptors, never a cache of original bodies.
  // Authored staged writes take precedence in either mode.
  const reads = new Map<string, Promise<Uint8Array | undefined>>()
  const missingReferences = new Set<string>()
  const directories = new Set<string>()
  const read = async (path: string) => {
    const change = changes.get(path)
    if (change) return change.bytes ?? (change.content === null ? undefined : Buffer.from(change.content!, 'utf8'))
    if (originals) return files.readBytes(snapshot, path)
    let pending = reads.get(path)
    if (!pending) { pending = files.readBytes(snapshot, path); reads.set(path, pending) }
    return pending
  }
  const requirements = task.parent ? await taskRequirementChain(files, snapshot, task, true) : members
  const authored: Array<{ path: string; text: string }> = []
  for (const output of manifest.outputs) {
    // Only this save's actual authored outputs select linked originals. Existing
    // live skills and previous archive bodies are not a keep-everything source.
    if (!changes.has(output)) continue
    const bytes = await read(output)
    if (bytes === undefined) continue
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { continue }
    if (!text.includes('\0')) authored.push({ path: output, text })
  }
  const linked = selectRecorderOutputReferences(requirements, authored)
  for (let index = 0; index < authored.length; index++) {
    const output = linked.outputs[index]!
    if (output.text !== authored[index]!.text) changes.set(output.path, { path: output.path, content: output.text })
  }
  const sourceOwners = new Map(members.map(member => [member.sourcePath, member]))
  const working = (path: string) => roots.some(root => within(path, root)) || sourceOwners.has(path)
  const expandReference = async (reference: string): Promise<string[]> => {
    const path = filePath(reference)
    if (commandRoots.some(root => within(path, root))) return []
    // A Task result may point at a live skill, including a legacy directory
    // reference. Keep the link without reading or expanding its mutable tree.
    if (isLiveSkillReference(path)) return [path]
    const requirement = sourceOwners.get(path)
    const identity = requirement ? originals ? await originals.taskIdentity(path)
      : taskIdentity(new TextDecoder('utf-8').decode(await read(path) ?? new Uint8Array())) : undefined
    if (requirement && identity !== requirement.taskId) {
      missingReferences.add(path)
      return [path]
    }
    const bytes = originals ? undefined : await read(path)
    const staged = changes.get(path)
    const info = originals ? staged && staged.content !== null
      ? { bytes: staged.bytes?.byteLength ?? Buffer.byteLength(staged.content ?? '', 'utf8') }
      : await originals.info(path) : bytes === undefined ? undefined : { bytes: bytes.byteLength }
    // Exact metadata distinguishes a file from a missing reference without
    // reading a physical original into an aggregate body buffer.
    const directory = info !== undefined && 'directory' in info && info.directory === true
    if (directory) directories.add(path)
    const listed = info === undefined || directory ? await files.list(snapshot, path + '/', taskArchiveOwnsPath(task, path) ? taskArchiveSelection(task) : undefined) : []
    const entries = [...new Set([...(info === undefined || directory ? [] : [path]), ...listed.map(entry => entry.path)])].filter(entry => !programStates.has(entry) && entry !== archive + '/retention.json' && !commandRoots.some(root => within(entry, root)) && !recorderStage(entry))
    // Keep the Recorder's references in its publication; Cleaner neither
    // reinterprets these references nor supplements the archive later.
    if (!entries.length) {
      if (info === undefined && !listed.length) missingReferences.add(path)
      return [path]
    }
    const result: string[] = []
    for (const source of entries) {
      // An explicitly selected directory can contain a known requirement too;
      // use the same exact identity check as an individual source selection.
      if (source !== path && sourceOwners.has(source)) { result.push(...await expand(source)); continue }
      if (!working(source)) { result.push(source); continue }
      const sourceOwner = sourceOwners.get(source) ?? members.find(member => taskWorkingRoots(member).some(root => within(source, root))) ?? task
      if (originals) {
        const retained = await originals.retain(source, paths.archive(sourceOwner))
        if (!retained) throw new Error('Retained reference is missing: ' + source)
        if (members.some(member => taskStateSignal(member, source, { byteLength: retained.bytes }))) continue
        mapping[source] = retained.path
        sources[retained.path] = { sourcePath: source, sourceRevision: snapshot.revision, sha256: retained.sha256 }
        result.push(retained.path); continue
      }
      const value = source === path && bytes !== undefined ? bytes : await read(source)
      if (value === undefined) throw new Error('Retained reference is missing: ' + source)
      const leaf = source.split('/').at(-1)!
      // State's control signals are not user artifacts, even when a legacy
      // manifest retained their parent directory. Never archive an R/Cleaner.
      if (members.some(member => taskStateSignal(member, source, value))) continue
      const destination = paths.archive(sourceOwner) + '/retained/' + hash(source) + '/' + hash(value) + '/' + leaf
      const prior = await read(destination)
      if (prior !== undefined && hash(prior) !== hash(value)) throw new Error('Archived retained reference already differs: ' + destination)
      if (prior === undefined) changes.set(destination, { path: destination, bytes: value })
      mapping[source] = destination; sources[destination] = { sourcePath: source, sourceRevision: snapshot.revision, sha256: hash(value) }; result.push(destination)
    }
    return [...new Set(result)]
  }
  const expansions = new Map<string, Promise<string[]>>()
  const expand = (reference: string): Promise<string[]> => {
    const path = filePath(reference)
    let pending = expansions.get(path)
    if (!pending) { pending = expandReference(path); expansions.set(path, pending) }
    return pending
  }
  const archiveOutputs = manifest.outputs.filter(path => !isLiveSkillReference(path))
  const retainedOriginals = [...new Set([...manifest.retainedPaths, ...linked.retainedPaths].filter(path => !isLiveSkillReference(path)))]
  const originalReferences = [...archiveOutputs, ...retainedOriginals, ...(task.resultPaths ?? [])]
  const currentReferences = await resolveChildResultReferences(files, snapshot, task, originalReferences, true)
  const outputEnd = archiveOutputs.length, retainedEnd = outputEnd + retainedOriginals.length
  const expandMany = async (references: readonly string[]): Promise<string[]> => {
    if (!originals) return [...new Set((await Promise.all(references.map(expand))).flat())]
    const result = new Set<string>()
    for (const reference of references) for (const path of await expand(reference)) result.add(path)
    return [...result]
  }
  const outputs = await expandMany(currentReferences.slice(0, outputEnd))
  const retainedPaths = await expandMany(currentReferences.slice(outputEnd, retainedEnd))
  const resultPaths = task.resultPaths ? await expandMany(currentReferences.slice(retainedEnd)) : undefined
  // Keep historical relocation metadata, but never use it to replace a live
  // skill reference in this Task or its ancestors with a Task-owned copy.
  const replacements = Object.fromEntries(Object.entries(mapping).filter(([path]) => !isLiveSkillReference(path)))
  for (let index = 0; index < originalReferences.length; index++) {
    if (originalReferences[index] === currentReferences[index]) continue
    replacements[originalReferences[index]!] = currentReferences[index]!
  }
  const workspaceResults = [...new Map(members.flatMap(member => member.workspaceResults ?? []).map(result => [JSON.stringify(result), result])).values()]
  const updated = { ...task, ...(resultPaths ? { resultPaths } : {}) }
  if (JSON.stringify(task.resultPaths) !== JSON.stringify(resultPaths)) {
    changes.set(paths.task(task.taskId), { path: paths.task(task.taskId), content: encodeJson(updated) })
  }
  // Shared ancestor references are derived edits, not this Recorder's output
  // targets. Rebuild them from the current snapshot while guarding only the
  // actual migrated bytes and reciprocal ancestry, never the whole parent JSON.
  const ancestorChanges: FileChange[] = []
  let child = task
  const ancestors = new Set([task.taskId])
  while (child.parent && Object.keys(replacements).length) {
    const parentId = child.parent.taskId, parent = await readRequirementParent(files, snapshot, child, true)
    if (ancestors.has(parentId)) throw new Error('Task parent association is cyclic: ' + parentId)
    ancestors.add(parentId)
    const remap = (references: readonly string[]) => [...new Set(references.map(path => replacements[path] ?? path))]
    const retentionPath = paths.archive(parent) + '/retention.json'
    const retained = await withReevaluatedFileTarget(snapshot, retentionPath,
      () => readJson<RetentionManifest>(files, snapshot, retentionPath))
    if (retained && taskLifecycle(parent) !== taskLifecycle(retained)) throw new Error('Ancestor retention belongs to another Task lifecycle.')
    // Latest lists are authoritative. Relocate only sources still present;
    // a peer deletion/replacement is never restored from historical membership.
    const parentResults = parent.resultPaths && remap(parent.resultPaths)
    if (JSON.stringify(parent.resultPaths) !== JSON.stringify(parentResults)) {
      ancestorChanges.push({ path: paths.task(parent.taskId), content: encodeJson({ ...parent, resultPaths: parentResults }) })
    }
    if (retained) {
      const next = { ...retained, outputs: remap(retained.outputs), retainedPaths: remap(retained.retainedPaths) }
      if (JSON.stringify(next.outputs) !== JSON.stringify(retained.outputs) || JSON.stringify(next.retainedPaths) !== JSON.stringify(retained.retainedPaths)) {
        const verified = { ...retained.verifiedReferences }
        for (const [oldPath, newPath] of Object.entries(replacements)) {
          if (!retained.outputs.includes(oldPath) && !retained.retainedPaths.includes(oldPath)) continue
          const sourceHash = verified[oldPath], targetHash = verified[newPath]
          if (sourceHash === undefined && targetHash === undefined) continue
          const bytes = await read(newPath)
          if (bytes === undefined || sourceHash !== undefined && sourceHash !== hash(bytes)
            || targetHash !== undefined && targetHash !== hash(bytes))
            throw new Error('Ancestor retained reference verification conflicts: ' + newPath)
          if (sourceHash !== undefined) { verified[newPath] = sourceHash; delete verified[oldPath] }
        }
        ancestorChanges.push({ path: retentionPath, content: encodeJson({ ...next, verifiedReferences: verified }) })
      }
    }
    child = parent
  }
  const retainedResults = (resultPaths ?? []).filter(path => !isLiveSkillReference(path))
  for (const member of members) {
    // The total Recorder preserves each original Task's actual result links,
    // not only the root result list. Exact parent/child classification survives
    // without members, controls, role state or cleanup inventory.
    const results = member.taskId === task.taskId ? resultPaths : member.resultPaths
      ? await expandMany(await resolveChildResultReferences(files, snapshot, task, member.resultPaths, true)) : undefined
    retainedResults.push(...(results ?? []).filter(path => !isLiveSkillReference(path)))
    if (files instanceof PhysicalLocalFiles) {
      const history = taskHistoryChange(member, results)
      changes.set(history.path, history)
    } else if (member.taskId !== task.taskId && JSON.stringify(member.resultPaths) !== JSON.stringify(results)) {
      changes.set(paths.task(member.taskId), { path: paths.task(member.taskId), content: encodeJson({ ...member, resultPaths: results }) })
    }
  }
  const references = [...new Set([...outputs, ...retainedPaths, ...retainedResults])], verifiedReferences: Record<string, string> = {}
  for (const path of references) {
    if (missingReferences.has(path) || directories.has(path)) continue
    const changed = changes.get(path)
    if (originals && !changed) {
      const fingerprint = await originals.fingerprint(path)
      if (fingerprint !== undefined) verifiedReferences[path] = fingerprint
      continue
    }
    const bytes = await read(path)
    if (bytes !== undefined) verifiedReferences[path] = hash(bytes)
  }
  return { changes: [...changes.values()], ancestorChanges, task: updated,
    retention: { ...manifest, ...(workspaceResults.length ? { workspaceResults } : {}), outputs, retainedPaths: [...new Set([...retainedPaths, ...retainedResults])], verifiedReferences,
      missingReferences: missingReferences.size ? [...missingReferences] : undefined,
      ...(Object.keys(mapping).length ? { relocatedReferences: mapping, relocatedSources: sources } : {}) } }
}

/** Only the selected relocation is material to resolving an original. Native
 * storage dependencies still retain the full catalog for atomic publication. */
async function readReferenceMapping(files: FilesStore, snapshot: FilesSnapshot, taskId: string, originalPath: string, historical = false): Promise<RetentionManifest | undefined> {
  const task = await readTaskArchiveIdentity(files, snapshot, taskId)
  const path = (historical ? taskArchiveReadPath(task) : paths.archive(task)) + '/retention.json'
  let manifest = await withReevaluatedFileTarget(snapshot, path, () => readJson<RetentionManifest>(files, snapshot, path))
  if (!manifest?.relocatedReferences?.[originalPath]) {
    const metadata = await readTaskReferenceIdentity(files, snapshot, taskId)
    if (metadata?.parent) for (const ancestor of (await taskRequirementChain(files, snapshot, metadata)).slice(1)) {
      const ancestorPath = (historical ? taskArchiveReadPath(ancestor) : paths.archive(ancestor)) + '/retention.json'
      const candidate = await withReevaluatedFileTarget(snapshot, ancestorPath, () => readJson<RetentionManifest>(files, snapshot, ancestorPath))
      if (candidate?.relocatedReferences?.[originalPath]) { manifest = candidate; break }
    }
  }
  const target = manifest?.relocatedReferences?.[originalPath]
  const source = target ? manifest?.relocatedSources?.[target] : undefined
  fileReadFingerprint(snapshot, 'archived-reference:' + taskId + ':' + originalPath,
    hash(JSON.stringify([target ?? null, target ? manifest?.verifiedReferences?.[target] ?? null : null,
      source ? [source.sourcePath, typeof source.sourceRevision === 'string' && !!source.sourceRevision, source.sha256] : null])))
  return manifest
}

/** Exact legacy link lookup, scoped by an already-known Task identity. Never
 * scans other archives or guesses the owner of an old submission filename. */
export async function readArchivedReference(files: FilesStore, snapshot: FilesSnapshot, taskId: string,
  originalPath: string, historical = false): Promise<Uint8Array | undefined> {
  filePath(originalPath)
  const task = await readTaskArchiveIdentity(files, snapshot, taskId)
  const root = historical ? taskArchiveReadPath(task) : paths.archive(task), manifest = await readReferenceMapping(files, snapshot, taskId, originalPath, historical)
  if (!manifest) return undefined
  const target = manifest.relocatedReferences?.[originalPath]
  if (target === undefined) return undefined
  if (typeof target !== 'string' || !filePath(target).startsWith(root + '/')) throw new Error('Archived reference escapes its Task: ' + originalPath)
  // Physical retained files remain ordinary user-editable files. The exact
  // Task mapping and archive boundary locate them; old save-time hashes are
  // provenance, not an ordinary-read admission gate. Missing remains missing.
  if (files instanceof PhysicalLocalFiles) return files.readBytes(snapshot, target)
  const expected = manifest.verifiedReferences?.[target]
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Archived reference lacks verified content: ' + originalPath)
  const bytes = await files.readBytes(snapshot, target)
  if (bytes === undefined || hash(bytes) !== expected) throw new Error('Archived reference integrity differs: ' + originalPath)
  const source = manifest.relocatedSources?.[target]
  if (!source || source.sourcePath !== originalPath || source.sha256 !== expected || typeof source.sourceRevision !== 'string' || !source.sourceRevision) throw new Error('Archived reference source identity differs: ' + originalPath)
  return bytes
}

/** Resolve one Task's original requirement, never a later Task that reused its
 * submission filename. Retained fallback must verify the existing exact source
 * mapping within that archive. Git also verifies archived bytes/provenance;
 * physical Local reads the current mapped file. No scan or substitution. */
export async function readTaskRequirementReference(files: FilesStore, snapshot: FilesSnapshot,
  task: TaskMetadata, requested: string, historical = false): Promise<{ path: string; text: string | undefined } | undefined> {
  const sourcePath = filePath(task.sourcePath), archive = historical ? taskArchiveReadPath(task) : paths.archive(task)
  if (requested !== sourcePath && !requested.startsWith(archive + '/')) return undefined
  const live = requested === sourcePath ? await files.read(snapshot, sourcePath) : undefined
  if (live !== undefined && taskIdentity(live) === task.taskId) return { path: sourcePath, text: live }
  const retention = await readReferenceMapping(files, snapshot, task.taskId, sourcePath, historical)
  const target = retention?.relocatedReferences?.[sourcePath]
  if (target && (requested === sourcePath || requested === target)) {
    const bytes = await readArchivedReference(files, snapshot, task.taskId, sourcePath, historical)
    const text = bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (files instanceof PhysicalLocalFiles) return { path: target, text }
    if (text === undefined || taskIdentity(text) !== task.taskId)
      throw new Error('Archived Task requirement identity differs: ' + sourcePath)
    return { path: target, text }
  }
  if (requested !== sourcePath) return undefined
  if (live !== undefined) throw new Error('The original Task requirement path now belongs to different material and has no verified retained original: ' + sourcePath)
  return { path: sourcePath, text: undefined } // A genuinely absent original remains absent, not fabricated.
}

/** Path-only callers retain the same resolution and integrity semantics. */
export async function resolveTaskRequirementReference(files: FilesStore, snapshot: FilesSnapshot,
  task: TaskMetadata, requested: string, historical = false): Promise<string | undefined> {
  return (await readTaskRequirementReference(files, snapshot, task, requested, historical))?.path
}

/** Resolve only a reciprocal descendant's recorded relocation, never a
 * repository-wide alias or a sibling reached through an ancestor. */
export async function resolveChildResultReferences(files: FilesStore, snapshot: FilesSnapshot, parent: TaskMetadata,
  references: readonly string[], relocating = false, selectedChildOnly = false): Promise<string[]> {
  // Organizer acceptance can follow an explicitly named working Task. Recorder
  // still uses the original whole-family resolver, including directory inputs.
  // An unlocated or mixed input keeps the existing general path unchanged.
  if (selectedChildOnly && !relocating && parent.route === 'O' && references.length
    && references.every(path => !path.startsWith('task-references/') && referenceTaskId(path) !== undefined)) {
    const tasks = new Map<string, Promise<TaskMetadata | undefined>>()
    const retentions = new Map<string, Promise<RetentionManifest | undefined>>()
    const task = (id: string): Promise<TaskMetadata | undefined> => {
      let pending = tasks.get(id)
      if (!pending) { pending = readJson<TaskMetadata>(files, snapshot, paths.task(id)); tasks.set(id, pending) }
      return pending
    }
    const retention = (child: TaskMetadata): Promise<RetentionManifest | undefined> => {
      let pending = retentions.get(child.taskId)
      if (!pending) { pending = readJson<RetentionManifest>(files, snapshot, paths.archive(child) + '/retention.json'); retentions.set(child.taskId, pending) }
      return pending
    }
    const resolve = async (path: string): Promise<string | undefined> => {
      const id = referenceTaskId(path)!
      if (id === parent.taskId) return path
      const selected = await task(id)
      if (!selected || selected.taskId !== id) return undefined // Family fallback determines whether a linked child is missing.
      let child = selected
      const visited = new Set<string>([id])
      while (child.taskId !== parent.taskId) {
        const parentId = child.parent?.taskId
        if (!parentId) return path // Another Task tree's ordinary path.
        if (visited.has(parentId)) return undefined
        const ancestor = await task(parentId)
        if (!ancestor || ancestor.taskId !== parentId || !linkedChild(ancestor, child)) return undefined
        visited.add(parentId)
        child = ancestor
      }
      if (!taskWorkingRoots(selected).some(root => within(path, root))) return path
      const mapped = (await retention(selected))?.relocatedReferences?.[path]
      if (!mapped) return path
      if (!filePath(mapped).startsWith(paths.archive(selected) + '/')) throw new Error('Relocated child result escapes its archive: ' + path)
      return mapped
    }
    const selected: Array<string | undefined> = []
    for (const path of references) selected.push(await resolve(path))
    if (selected.every((path): path is string => path !== undefined)) return selected
  }
  if (references.some(path => path.startsWith('task-references/'))) {
    const chain = relocating && !parent.parent ? await taskFamily(files, snapshot, parent.taskId)
      : await taskRequirementChain(files, snapshot, parent, relocating)
    references = await Promise.all(references.map(async path => {
      const reference = parseTaskReference(path)
      if (!reference) return path
      const owner = chain.find(task => task.taskId === reference.taskId && task.sourcePath === reference.original)
      if (!owner) throw new Error('Task reference is outside this Task requirement chain.')
      // Retention validates the selected source identity before copying. Do not
      // load a physical original's whole body merely to unwrap its stable link.
      return relocating ? reference.original : (await resolveTaskRequirementReference(files, snapshot, owner, reference.original))!
    }))
  }
  if (parent.route !== 'O' || !references.length) return [...references]
  const replacements = new Map<string, string>()
  for (const child of (await taskFamily(files, snapshot, parent.taskId)).slice(1)) {
    const selected = references.filter(path => taskWorkingRoots(child).some(root => within(path, root)) || path === child.sourcePath)
    if (!selected.length) continue
    const retention = await readJson<RetentionManifest>(files, snapshot, paths.archive(child) + '/retention.json')
    for (const path of selected) {
      const target = retention?.relocatedReferences?.[path]
      if (!target) continue
      if (!filePath(target).startsWith(paths.archive(child) + '/')) throw new Error('Relocated child result escapes its archive: ' + path)
      replacements.set(path, target)
    }
  }
  return references.map(path => replacements.get(path) ?? path)
}

/** Only Recorder's mechanical relocation uses this projection. Other reads of
 * ancestor material remain ordinary assessed inputs. Native dependency capture
 * still sees the complete bytes and rejects stale publication in both modes. */
async function readRequirementParent(files: FilesStore, snapshot: FilesSnapshot, child: TaskMetadata, relocating: boolean): Promise<TaskMetadata> {
  const id = child.parent!.taskId, path = paths.task(id)
  const read = () => relocating ? readJson<TaskMetadata>(files, snapshot, path) : readTaskReferenceIdentity(files, snapshot, id)
  const parent = await (relocating ? withReevaluatedFileTarget(snapshot, path, read) : read())
  if (!parent || parent.taskId !== id || !linkedChild(parent, child)) throw new Error('Task parent association differs: ' + id)
  if (relocating) fileReadFingerprint(snapshot, 'recorder-ancestor-identity:' + child.taskId + ':' + id,
    hash(JSON.stringify({ version: parent.version, taskId: parent.taskId, owner: parent.owner, route: parent.route,
      lifecycleId: taskLifecycle(parent), sourcePath: parent.sourcePath, parent: parent.parent,
      child: parent.children?.filter(link => link.taskId === child.taskId) })))
  return parent
}
export async function taskRequirementChain(files: FilesStore, snapshot: FilesSnapshot, task: TaskMetadata, relocating = false): Promise<TaskMetadata[]> {
  const result = [task], seen = new Set([task.taskId])
  let child = task
  while (child.parent) {
    const id = child.parent.taskId, parent = await readRequirementParent(files, snapshot, child, relocating)
    if (seen.has(id)) throw new Error('Task parent association is cyclic: ' + id)
    seen.add(id); result.push(parent); child = parent
  }
  return result
}
