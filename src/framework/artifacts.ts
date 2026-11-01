import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { FrameworkTransactions, type CommandOptions } from './command-transactions.js'
import { filePath, withSnapshot, type FilesSnapshot, type FilesStore } from './transactions.js'
import { paths } from './task-files.js'

export interface ArtifactReference {
  path: string
  manifestPath: string
  name: string
  sha256: string
  bytes: number
}
export interface PreserveArtifactInput { taskId: string; sourcePath: string; destinationPath: string; name?: string }
export interface PreserveArtifactOptions extends CommandOptions { cwd?: string; signal?: AbortSignal }
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
    const archive = paths.archive(input.taskId)
    if (!destination.startsWith(archive + '/')) throw new Error('An artifact destination must be inside its task archive.')
    if (destination === archive + '/records.md' || destination === archive + '/retention.json') throw new Error('This archive path is reserved for task records, not artifact bytes.')
    if (!input.sourcePath.trim()) throw new Error('An artifact source path is required.')
    const name = input.name ?? destination.slice(destination.lastIndexOf('/') + 1)
    const request = { taskId: input.taskId, sourcePath: input.sourcePath, destinationPath: destination, name, cwd: options.cwd ?? this.workspace }
    const requestHash = sha256(JSON.stringify(request))
    const receiptPath = 'technical/artifacts/commands/' + sha256(commandId) + '.json'
    await this.transactions.run(commandId, request, options, async snapshot => {
      // Receipts are in the same commit as the actual bytes. Replays do not touch
      // the source, which can have changed or disappeared since the original call.
      const old = await this.files.read(snapshot, receiptPath)
      if (old !== undefined) {
        const receipt = JSON.parse(old) as ArtifactCommand
        if (receipt.requestHash !== requestHash) throw new Error('Artifact command arguments changed.')
        await this.readAt(snapshot, receipt.artifact.path)
        return []
      }
      const data = await this.capture(input.sourcePath, request.cwd, options.signal)
      const artifact: ArtifactReference = { path: destination, manifestPath: manifestPath(destination), name, sha256: sha256(data), bytes: data.byteLength }
      const existing = await this.files.readBytes(snapshot, destination)
      if (existing !== undefined) {
        const prior = await this.readAt(snapshot, destination)
        if (prior.artifact.sha256 !== artifact.sha256 || prior.artifact.name !== name) throw new Error('An archived artifact reference cannot be overwritten with different content or identity.')
      }
      const manifest: ArtifactManifest = { version: 1, taskId: input.taskId, ...artifact }
      return [
        { path: destination, bytes: data },
        { path: artifact.manifestPath, content: encode(manifest) },
        { path: receiptPath, content: encode({ version: 1, requestHash, artifact } satisfies ArtifactCommand) },
      ]
    })
    // A successful commit/remote receipt alone is not a successful integrity read.
    // Always fetch all bytes from authoritative storage before returning a link.
    return withSnapshot(this.files, async snapshot => {
      const raw = await this.files.read(snapshot, receiptPath)
      if (raw === undefined) throw new Error('Committed artifact receipt is missing.')
      const receipt = JSON.parse(raw) as ArtifactCommand
      if (receipt.version !== 1 || receipt.requestHash !== requestHash) throw new Error('Artifact receipt does not match the command.')
      const result = await this.readAt(snapshot, receipt.artifact.path)
      if (JSON.stringify(result.artifact) !== JSON.stringify(receipt.artifact)) throw new Error('Artifact receipt and manifest disagree.')
      return result.artifact
    })
  }

  /** For the download endpoint: returns original bytes only after complete verification. */
  read(path: string): Promise<{ artifact: ArtifactReference; data: Uint8Array }> {
    return withSnapshot(this.files, snapshot => this.readAt(snapshot, filePath(path)))
  }

  private async readAt(snapshot: FilesSnapshot, path: string): Promise<{ artifact: ArtifactReference; data: Uint8Array }> {
    const index = manifestPath(filePath(path)), raw = await this.files.read(snapshot, index)
    if (raw === undefined) throw new Error('Artifact manifest is missing: ' + path)
    const manifest = JSON.parse(raw) as ArtifactManifest
    if (manifest.version !== 1 || manifest.path !== path || manifest.manifestPath !== index
      || !path.startsWith(paths.archive(manifest.taskId) + '/') || typeof manifest.name !== 'string'
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid artifact manifest: ' + path)
    const data = await this.files.readBytes(snapshot, path)
    if (data === undefined || data.byteLength !== manifest.bytes || sha256(data) !== manifest.sha256) throw new Error('Artifact integrity verification failed: ' + path)
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
