import { publishPreparedPhysicalFile } from './physical-publication-evidence.js'
import type { DirectSignalSources } from './physical-direct-delivery.js'
import { createHash } from 'node:crypto'
import { PhysicalLocalFiles } from './physical-local-files.js'
import { taskFamily } from './task-relations.js'
import { paths, readJson, encodeJson, readMemberStatus, taskLifecycle } from './task-files.js'
import type { ExecutionControls } from './execution-control.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { withSnapshot, type FileChange, type FilesStore } from './transactions.js'

/** Existing button continuation publication, shared with the controlled Foreground write. */
export async function publishTaskResume(access: { files: FilesStore; controls: ExecutionControls; transactions: FrameworkTransactions; member: string; active: boolean; commandHostKey?: string; physicalSignalSources?: DirectSignalSources },
  input: { taskId: string; lifecycleId?: string }, commandId: string): Promise<void> {
  if (access.files instanceof PhysicalLocalFiles) return publishPhysicalResume(access as typeof access & { files: PhysicalLocalFiles }, input, commandId)
  await access.transactions.run('task-resume-signals:' + commandId,
    { taskId: input.taskId, commandId: commandId }, { reevaluate: true, ...(access.commandHostKey ? { taskOwner: { ...input, hostKey: access.commandHostKey } } : {}) }, async snapshot => {
        const family = await taskFamily(access.files, snapshot, input.taskId);
        if (!family[0] || taskLifecycle(family[0]) !== (input.lifecycleId ?? '')) throw new Error('Task lifecycle changed before resume publication.');
        const states = await access.controls.taskStates(family, snapshot);
        const root = states.get(input.taskId);
        if (root?.commandId !== commandId || root.intent !== 'running') return [];
        const changes: FileChange[] = [], suffix = createHash('sha256').update(commandId).digest('hex');
        for (const selected of family) {
            const state = states.get(selected.taskId);
            if (selected.status !== 'running' || state?.intent === 'paused' || state?.intent === 'cancelled') continue;
            if (selected.route === 'O') changes.push({
                path: paths.state(selected.owner, selected.taskId) + '/Organizer_UserResume_' + suffix, content: '',
            });
            for (const recipient of selected.members ?? [selected.owner]) {
                if (access.active && recipient === access.member) continue;
                const status = await readMemberStatus(access.files, snapshot, paths.memberStatus(selected.taskId, recipient));
                const inbox = await access.files.read(snapshot, paths.inbox(selected.taskId, recipient));
                if (status?.state === 'complete' || !inbox?.length) continue;
                changes.push({ path: paths.state(recipient, selected.taskId) + '/Planner_UserResume_' + suffix, content: '' });
            }
        }
        return changes;
    });
}

interface ResumeSignal { path: string; taskId: string; lifecycleId?: string; stage: string; prepared?: { version: string }; published?: true; skipped?: true }
interface ResumePublication { version: 2; taskId: string; lifecycleId?: string; commandId: string; signals: ResumeSignal[] }
// Only retries of the same user command share this lane. Each independent Task
// and command publishes without borrowing another Task's control/observation I/O.
const resumeWrites = new Map<string, Promise<void>>()
async function publishPhysicalResume(access: Parameters<typeof publishTaskResume>[0] & { files: PhysicalLocalFiles },
  input: { taskId: string; lifecycleId?: string }, commandId: string): Promise<void> {
  const suffix = createHash('sha256').update(commandId).digest('hex')
  const directory = paths.run(input.taskId)
  const stem = directory + '/.user-resume-' + suffix
  const path = stem + '.json', lane = JSON.stringify([access.files.directory, path])
  const operation = (resumeWrites.get(lane) ?? Promise.resolve()).then(async () => {
    const retire = async () => { await access.files.delete(path) }
    // These files belong to the already-created Task directory. A late resume
    // must not recreate that directory after its Recorder/Cleaner handoff.
    const persist = (pending: ResumePublication) => access.files.updateInExistingDirectory(path, async () => ({ value: undefined, content: encodeJson(pending) }))
    if (await access.controls.resumeHandled(commandId, input)) { await retire(); return }
    await withSnapshot(access.files, async snapshot => {
      const family = await taskFamily(access.files, snapshot, input.taskId)
      if (!family[0] || taskLifecycle(family[0]) !== taskLifecycle(input)) throw new Error('Task lifecycle changed before resume publication.')
      // Access and the active Runtime may own different PhysicalLocalFiles.
      // Keep the existing controls/write owner and let it open its own live view.
      const states = await access.controls.taskStates(family), root = states.get(input.taskId)
      let pending = await readJson<ResumePublication>(access.files, snapshot, path)
      if (pending && (pending.version !== 2 || pending.taskId !== input.taskId || taskLifecycle(pending) !== taskLifecycle(input)
        || pending.commandId !== commandId || !Array.isArray(pending.signals))) throw new Error('Task resume publication identity differs.')
      if (root?.commandId !== commandId || root.intent !== 'running') {
        // This old command can never become current by replay. Retire only its
        // still-owned staged sources and record that disposition on the original
        // command, before removing its temporary publication plan.
        for (const [index, signal] of (pending?.signals ?? []).entries()) {
          if (signal.stage !== stem + '-' + index + '.stage') throw new Error('Task resume stage identity differs.')
          await access.files.delete(signal.stage)
        }
        await access.controls.finishResume(commandId, input)
        await retire()
        return
      }
      if (!pending) {
        const signals: ResumeSignal[] = []
        const add = (selected: typeof family[number], target: string) => signals.push({ path: target, taskId: selected.taskId,
          ...(selected.lifecycleId ? { lifecycleId: selected.lifecycleId } : {}), stage: stem + '-' + signals.length + '.stage' })
        for (const selected of family) {
          const state = states.get(selected.taskId)
          if (selected.status !== 'running' || state?.intent === 'paused' || state?.intent === 'cancelled') continue
          if (selected.route === 'O') add(selected, paths.state(selected.owner, selected.taskId) + '/Organizer_UserResume_' + suffix)
          for (const recipient of selected.members ?? [selected.owner]) {
            if (access.active && recipient === access.member) continue
            const status = await readMemberStatus(access.files, snapshot, paths.memberStatus(selected.taskId, recipient))
            const inbox = await access.files.read(snapshot, paths.inbox(selected.taskId, recipient))
            if (status?.state === 'complete' || !inbox?.length) continue
            add(selected, paths.state(recipient, selected.taskId) + '/Planner_UserResume_' + suffix)
          }
        }
        pending = { version: 2, ...input, commandId, signals }
        await persist(pending)
      }
      for (const [index, signal] of pending.signals.entries()) {
        const selected = family.find(task => task.taskId === signal.taskId && taskLifecycle(task) === taskLifecycle(signal))
        const destinations = selected ? [
          ...(selected.route === 'O' ? [paths.state(selected.owner, selected.taskId) + '/Organizer_UserResume_' + suffix] : []),
          ...(selected.members ?? [selected.owner]).map(member => paths.state(member, selected.taskId) + '/Planner_UserResume_' + suffix),
        ] : []
        if (signal.stage !== stem + '-' + index + '.stage' || !destinations.includes(signal.path))
          throw new Error('Task resume signal is outside its addressed Task responsibility.')
        if (signal.published || signal.skipped) continue
        // A later explicit pause or lifecycle change wins over an interrupted
        // resume. Descendant controls are never rewritten by the parent action.
        if (!selected || selected.status !== 'running' || await access.controls.taskHeld(signal.taskId, signal.lifecycleId)) {
          await access.files.delete(signal.stage)
          signal.skipped = true
          await persist(pending)
          continue
        }
        const current = (await access.controls.taskStates([input])).get(input.taskId)
        if (current?.commandId !== commandId || current.intent !== 'running') return
        if (!signal.prepared) {
          await access.files.updateInExistingDirectory(signal.stage, async bytes => ({ value: undefined, ...(bytes === undefined ? { content: '' } : {}) }))
          const staged = await access.files.fileInfo(signal.stage)
          if (!staged) throw new Error('The prepared Task resume notification is missing.')
          signal.prepared = { version: staged.version }
          await persist(pending)
        }
        const staged = await access.files.read(snapshot, signal.stage)
        if (staged !== undefined && staged !== '') throw new Error('A resume notification must remain an empty file.')
        if (typeof signal.prepared.version !== 'string') throw new Error('The Task resume notification has no prepared file identity.')
        try {
          await publishPreparedPhysicalFile(access.files, signal.stage, signal.path, signal.prepared.version,
            access.physicalSignalSources && (() => access.physicalSignalSources!(signal.path)))
        } catch (error) {
          // A source removed by Cleaner is not a delivered notification. The
          // attempted rename may have created only this now-empty destination;
          // remove that exact empty directory without deleting any new file.
          try { await access.files.removeEmptyDirectory(signal.path.slice(0, signal.path.lastIndexOf('/'))) }
          catch (cleanupError) {
            if (!['ENOTEMPTY', 'EEXIST'].includes((cleanupError as NodeJS.ErrnoException).code ?? ''))
              throw new AggregateError([error, cleanupError], 'The Task resume publication and its empty-directory cleanup remain unconfirmed.')
          }
          throw error
        }
        signal.published = true
        await persist(pending)
      }
      await access.controls.finishResume(commandId, input)
      await retire()
    })
  })
  const settled = operation.then(() => {}, () => {})
  resumeWrites.set(lane, settled)
  try { await operation } finally { if (resumeWrites.get(lane) === settled) resumeWrites.delete(lane) }
}
