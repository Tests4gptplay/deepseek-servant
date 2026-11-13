import type { LegacyTask, MigrationManifest } from './legacy-migration.js'
import { legacyMigratedTaskId } from './legacy-record-export.js'
import { initializeTask, isTerminalTask, paths, readJson, encodeJson, type TaskMetadata, type TaskRoute } from './task-files.js'
import { filePath, type FilesStore, type FilesSnapshot, type FileChange } from './transactions.js'

/** The empty notification addresses preserved material, not a route decision. */
export function legacyRoutingSignal(migrationId: string, taskId: string): string {
  for (const value of [migrationId, taskId]) { filePath(value); if (value.includes('/')) throw new Error('Migration identity occupies one path segment.') }
  return 'state/Foreground_Legacy_' + encodeURIComponent(migrationId).replaceAll('_', '%5F') + '_' + encodeURIComponent(taskId).replaceAll('_', '%5F')
}

/** Called only by Foreground's explicit submission, never migration discovery.
 * Host preserves source/ownership and applies the AI-selected route atomically. */
export async function routeLegacyTask(files: FilesStore, snapshot: FilesSnapshot,
  input: { manifestPath: string; oldTaskId: string; name: string; route: TaskRoute; decision: string }): Promise<FileChange[]> {
  filePath(input.manifestPath); filePath(input.name)
  if (input.name.includes('/')) throw new Error('Task name occupies one filename segment.')
  const manifest = await readJson<MigrationManifest>(files, snapshot, input.manifestPath)
  if (!manifest || manifest.version !== 1 || input.manifestPath !== 'technical/legacy-migrations/' + manifest.id + '/manifest.json')
    throw new Error('Choose the actual preserved migration manifest.')
  const mapped = manifest.tasks.find(task => task.oldId === input.oldTaskId)
  if (!mapped || mapped.taskId !== legacyMigratedTaskId(manifest.id, mapped.oldId)) throw new Error('The original mapped Task identity is inconsistent.')
  const taskId = mapped.taskId, existing = await readJson<TaskMetadata>(files, snapshot, paths.task(taskId))
  if (existing) {
    if (isTerminalTask(existing)) throw new Error('The migrated Task is complete; use its durable results in a new Task.')
    if (existing.taskId !== taskId || existing.owner !== manifest.owner || existing.route !== input.route)
      throw new Error('An existing migrated Task retains its explicit route and owner.')
    // Another admitted decision or an idempotent later call cannot replace work.
    return []
  }
  if (!mapped.routePending || !['running', 'wait-result'].includes(mapped.continuation))
    throw new Error('This preserved Task has no pending Foreground routing responsibility.')
  const original = await readJson<LegacyTask>(files, snapshot, mapped.continuationPath)
  if (!original || original.id !== mapped.oldId || typeof original.request !== 'string') throw new Error('Original task requirement is unavailable.')
  const root = input.manifestPath.slice(0, -'manifest.json'.length), controls: Array<{ path: string; action: unknown }> = []
  for (const entry of await files.listDirectory(snapshot, root + 'controls/')) {
    const action = await readJson<{ oldTaskId?: string; taskId?: string }>(files, snapshot, entry.path)
    if (action?.oldTaskId === mapped.oldId && action.taskId === taskId) controls.push({ path: entry.path, action })
  }
  const sourcePath = 'tasks/' + input.name + '_' + input.route + '.md'
  if (await files.read(snapshot, sourcePath) !== undefined) throw new Error('This task filename already exists; select a distinct task name.')
  const source = 'Task ID: ' + taskId + '\n' + original.request + '\n\n## Preserved continuation\n' + encodeJson({
    originalTask: mapped.recordPath, continuationPath: mapped.continuationPath, referenceIndex: input.manifestPath,
    memberRecords: mapped.members.map(member => paths.member(taskId, member)), memberContinuations: mapped.memberContinuations,
    controls,
  }) + '\nPreserve participant pauses, pending questions, cancellations and completed effects. Intake of this requirement does not authorize reopening held work.\n\n## Foreground routing decision\n' + input.decision
  const overlay = Object.create(files) as FilesStore
  overlay.read = (view, path) => path === sourcePath ? Promise.resolve(source) : files.read(view, path)
  const initialized = await initializeTask(overlay, snapshot, sourcePath, manifest.owner, mapped.members, taskId)
  const changes = new Map(initialized.changes.map(change => [change.path, change]))
  changes.set(sourcePath, { path: sourcePath, content: source })
  if (input.route === 'P') {
    const path = paths.inbox(taskId, manifest.owner), prior = await files.read(snapshot, path)
    if (prior) changes.set(path, { path, content: source + '\n\n## Preserved member input\n' + prior })
  }
  mapped.routePending = false
  changes.set(input.manifestPath, { path: input.manifestPath, content: encodeJson(manifest) })
  return [...changes.values()]
}
