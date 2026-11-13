import { PhysicalLocalFiles } from './physical-local-files.js'
import { preservePhysicalArtifact } from './physical-artifact-publication.js'
import { taskCommandReceiptRoot } from './task-command-paths.js'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { FrameworkTransactions, type CommandOptions } from './command-transactions.js'
import { filePath, withSnapshot, type FilesSnapshot, type FilesStore } from './transactions.js'
import { readTaskArchiveIdentity, taskArchiveReadPath } from './task-archive.js'
import { paths, taskLifecycle, taskArchiveOwnsPath } from './task-files.js'

export interface ArtifactReference {
  path: string
  manifestPath: string
  name: string
  sha256: string
  bytes: number
}
export interface PreserveArtifactInput { taskId: string; sourcePath: string; destinationPath: string; name?: string }
export interface PreserveArtifactOptions extends CommandOptions { cwd?: string; signal?: AbortSignal; beforeWrite?: (snapshot: FilesSnapshot) => Promise<void> }
interface ArtifactManifest extends ArtifactReference { version: 1; taskId: string }
interface ArtifactCommand { version: 1; requestHash: string; artifact: ArtifactReference }
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const manifestPath = (path: string) => 'technical/artifacts/manifests/' + sha256(path) + '.json'
const encode = (value: unknown) => JSON.stringify(value) + '\n'
// Transfer window, not an artifact size limit. Total allocation/storage limits are
// the runtime/backend's actual limits and are surfaced without truncation.
const WINDOW = 1024 * 1024

/** Captures actual filesystem bytes into the same authoritative Local/Git store.
 * ctx.fs is a capability seam, NOT itself an agent permission check. Invoke this
 * through the native tool permission pipeline, with the agent's actual cwd.
 * No source paths are opened through Node, and no host-local attachment IDs are
 * represented as cross-member references.
 */
export class FrameworkArtifacts {
  constructor(private readonly ctx: Pick<Context, 'fs'>, private readonly files: FilesStore,
    private readonly transactions: FrameworkTransactions, private readonly workspace: string) {}

  async preserve(commandId: string, input: PreserveArtifactInput, options: PreserveArtifactOptions = {}): Promise<ArtifactReference> {
    const destination = filePath(input.destinationPath)
    if (!input.sourcePath.trim()) throw new Error('An artifact source path is required.')
    const name = input.name ?? destination.slice(destination.lastIndexOf('/') + 1)
    const request = { taskId: input.taskId, sourcePath: input.sourcePath, destinationPath: destination, name, cwd: options.cwd ?? this.workspace }
    const requestHash = sha256(JSON.stringify(request))
    if (options.taskOwner && options.taskOwner.taskId !== input.taskId) throw new Error('Artifact command belongs to another Task.')
    const receiptPath = options.taskOwner ? taskCommandReceiptRoot(options.taskOwner) + 'artifact-results/' + sha256(commandId) + '.json'
      : 'technical/artifacts/commands/' + sha256(commandId) + '.json'
    if (this.files instanceof PhysicalLocalFiles) return preservePhysicalArtifact(this.files,
      { commandId, requestHash, taskId: input.taskId, destination, manifestPath: manifestPath(destination), name },
      async () => {
        options.signal?.throwIfAborted()
        const target = await this.ctx.fs.resolve(input.sourcePath, { cwd: request.cwd, signal: options.signal })
        const before = await this.ctx.fs.stat(target, options.signal)
        if (!before || before.type !== 'file') throw new Error('Artifact source must be an existing regular file.')
        return {
          // DSH FsInfo requires an opaque string version; size is optional.
          // Store/compare the token verbatim, never derive a native path or
          // freshness fields from the target or the backend's version format.
          version: JSON.stringify([before.version, before.size]),
          read: async (offset, length) => {
            options.signal?.throwIfAborted()
            return this.ctx.fs.readByteRange(target, { offset, length }, options.signal)
          },
          verify: async bytes => {
            const after = await this.ctx.fs.stat(target, options.signal)
            if (!after || after.type !== 'file' || after.version !== before.version || after.size !== before.size
              || (after.size !== undefined && after.size !== bytes))
              throw new Error('Artifact source changed while being captured; no archive was written.')
            options.signal?.throwIfAborted()
          },
        }
      }, async snapshot => {
        await options.beforeWrite?.(snapshot)
        const task = await readTaskArchiveIdentity(this.files, snapshot, input.taskId), archive = paths.archive(task)
        if (options.taskOwner && taskLifecycle(task) !== taskLifecycle(options.taskOwner)) throw new Error('Artifact command belongs to another Task lifecycle.')
        if (!destination.startsWith(archive + '/') || !taskArchiveOwnsPath(task, destination)) throw new Error('An artifact destination must be inside its task archive.')
        if (['records.md', 'retention.json', 'state.json'].some(name => destination === archive + '/' + name || destination.startsWith(archive + '/' + name + '/')))
          throw new Error('This archive path is reserved for task records, not artifact bytes.')
        return taskLifecycle(task)
      }, options.beforeAttempt ?? (() => {}), options.signal)
    let result: ArtifactReference | undefined, captured: { data: Uint8Array; sha256: string } | undefined
    // This invocation imports its one successful capture, not a later version
    // of the native source. Reevaluate current Task/destination facts on a
    // conflict; their own checks below protect identity and existing contents.
    await this.transactions.run(commandId, request, { reevaluate: true, ...options, preserveInputs: false,
      readPlan: { ...options.readPlan, signal: options.signal ?? options.readPlan?.signal, files: [...(options.readPlan?.files ?? []),
        receiptPath, destination, manifestPath(destination)] } }, async (snapshot, resumedChanges) => {
      await options.beforeWrite?.(snapshot)
      const task = await readTaskArchiveIdentity(this.files, snapshot, input.taskId), archive = paths.archive(task)
      if (options.taskOwner && taskLifecycle(task) !== taskLifecycle(options.taskOwner)) throw new Error('Artifact command belongs to another Task lifecycle.')
      if (!destination.startsWith(archive + '/') || !taskArchiveOwnsPath(task, destination)) throw new Error('An artifact destination must be inside its task archive.')
      if (['records.md', 'retention.json', 'state.json'].some(name => destination === archive + '/' + name || destination.startsWith(archive + '/' + name + '/'))) throw new Error('This archive path is reserved for task records, not artifact bytes.')
      // Receipts are in the same commit as the actual bytes. Replays do not touch
      // the source, which can have changed or disappeared since the original call.
      const old = await this.files.read(snapshot, receiptPath)
      if (old !== undefined) {
        const receipt = JSON.parse(old) as ArtifactCommand
        if (receipt.requestHash !== requestHash) throw new Error('Artifact command arguments changed.')
        result = receipt.artifact
        return []
      }
      if (!captured) {
        const prior = resumedChanges?.find(change => change.path === destination)
        if (prior?.bytes !== undefined) {
          // These are this exact command's own previously prepared outputs,
          // still held by its unresolved transaction, not a new source read.
          const manifest = resumedChanges!.find(change => change.path === manifestPath(destination))!
          captured = { data: prior.bytes, sha256: (JSON.parse(manifest.content!) as ArtifactManifest).sha256 }
        } else {
          const data = await this.capture(input.sourcePath, request.cwd, options.signal)
          captured = { data, sha256: sha256(data) }
        }
      }
      const { data } = captured
      const artifact: ArtifactReference = { path: destination, manifestPath: manifestPath(destination), name, sha256: captured.sha256, bytes: data.byteLength }
      const existing = await this.files.readBytes(snapshot, destination)
      if (existing !== undefined) {
        const prior = await this.readAt(snapshot, destination, existing)
        if (prior.artifact.sha256 !== artifact.sha256 || prior.artifact.name !== name) throw new Error('An archived artifact reference cannot be overwritten with different content or identity.')
      }
      result = artifact
      const manifest: ArtifactManifest = { version: 1, taskId: input.taskId, ...artifact }
      return [
        { path: destination, bytes: data },
        { path: artifact.manifestPath, content: encode(manifest) },
        { path: receiptPath, content: encode({ version: 1, requestHash, artifact } satisfies ArtifactCommand) },
      ]
    })
    if (result) return result
    // A replay can skip the builder. Recover the saved reference without
    // recapturing its source or turning the return into a second integrity read.
    return withSnapshot(this.files, async snapshot => {
      let raw = await this.files.read(snapshot, receiptPath)
      if (raw === undefined && options.taskOwner) {
        // Cross-Host replay already matched the original ordinary command
        // receipt. Locate only that command's result in this exact lifecycle.
        const ownerRoot = taskCommandReceiptRoot(options.taskOwner)
        const lifecycleRoot = ownerRoot.slice(0, ownerRoot.lastIndexOf('/', ownerRoot.length - 2) + 1)
        const name = sha256(commandId) + '.json'
        const matches = (await this.files.list(snapshot, lifecycleRoot, { names: [name],
          pathSegments: [...lifecycleRoot.slice(0, -1).split('/'), null, 'artifact-results', name] }))
          .filter(entry => /^[a-f0-9]{64}\/artifact-results\/[a-f0-9]{64}\.json$/.test(entry.path.slice(lifecycleRoot.length)))
        if (matches.length > 1) throw new Error('Artifact command has multiple original result records.')
        if (matches.length === 1) raw = await this.files.read(snapshot, matches[0]!.path)
      }
      if (raw === undefined) throw new Error('Saved artifact reference is missing.')
      const saved = JSON.parse(raw) as ArtifactCommand
      if (saved.version !== 1 || saved.requestHash !== requestHash) throw new Error('Artifact command arguments changed.')
      return saved.artifact
    })
  }

  /** Download current physical bytes; Git verifies its immutable archived object. */
  read(path: string): Promise<{ artifact: ArtifactReference; data: Uint8Array }> {
    return withSnapshot(this.files, snapshot => this.readAt(snapshot, filePath(path)))
  }

  private async readAt(snapshot: FilesSnapshot, path: string, capturedBytes?: Uint8Array): Promise<{ artifact: ArtifactReference; data: Uint8Array }> {
    const index = manifestPath(filePath(path)), raw = await this.files.read(snapshot, index)
    if (raw === undefined) throw new Error('Artifact manifest is missing: ' + path)
    const manifest = JSON.parse(raw) as ArtifactManifest
    const task = await readTaskArchiveIdentity(this.files, snapshot, manifest.taskId)
    if (manifest.version !== 1 || manifest.path !== path || manifest.manifestPath !== index
      || !(taskArchiveOwnsPath(task, path) || taskArchiveReadPath(task) !== paths.archive(task) && path.startsWith(taskArchiveReadPath(task) + '/')) || typeof manifest.name !== 'string'
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid artifact manifest: ' + path)
    // preserve() already read these exact destination bytes at this snapshot.
    // Reuse that read, but still verify the manifest against their actual hash.
    const data = capturedBytes ?? await this.files.readBytes(snapshot, path)
    if (data === undefined) throw new Error('Artifact file is missing: ' + path)
    if (this.files instanceof PhysicalLocalFiles) return { data,
      artifact: { path, manifestPath: index, name: manifest.name, sha256: sha256(data), bytes: data.byteLength } }
    if (data.byteLength !== manifest.bytes || sha256(data) !== manifest.sha256) throw new Error('Artifact integrity verification failed: ' + path)
    const artifact: ArtifactReference = { path, manifestPath: index, name: manifest.name, sha256: manifest.sha256, bytes: manifest.bytes }
    return { artifact, data }
  }

  private async capture(sourcePath: string, cwd: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()
    const target = await this.ctx.fs.resolve(sourcePath, { cwd, signal })
    const before = await this.ctx.fs.stat(target, signal)
    if (!before || before.type !== 'file') throw new Error('Artifact source must be an existing regular file.')
    const chunks: Uint8Array[] = []
    let offset = 0
    for (;;) {
      signal?.throwIfAborted()
      // FsInfo.size is the observed byte length when supplied. Keep the first
      // read even for an empty file so the source's byte-read permission is
      // checked; after reading nonempty bytes, the final stat below verifies
      // their count and the source's version/size without another EOF read.
      if (offset > 0 && before.size !== undefined && offset >= before.size) break
      const chunk = await this.ctx.fs.readByteRange(target, { offset, length: WINDOW }, signal)
      if (chunk.byteLength > WINDOW) throw new Error('Filesystem returned more bytes than the requested window.')
      if (chunk.byteLength === 0) break
      chunks.push(chunk.slice()); offset += chunk.byteLength
    }
    const after = await this.ctx.fs.stat(target, signal)
    if (!after || after.type !== 'file' || after.version !== before.version || after.size !== before.size
      || (after.size !== undefined && after.size !== offset)) throw new Error('Artifact source changed while being captured; no archive was written.')
    signal?.throwIfAborted()
    return Buffer.concat(chunks, offset)
  }
}
