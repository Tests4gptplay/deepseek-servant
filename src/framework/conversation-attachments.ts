import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { LocalAttachmentFiles, type LocalAttachmentSelection } from './local-attachment-files.js'
import { LocalAttachmentError, type GitConversationAttachmentReference, type LocalConversationAttachmentReference } from './conversation-attachment-reference.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { withSnapshot, type FilesStore, type FilesSnapshot, type FileChange } from './transactions.js'
import { attachmentName, attachmentOriginalPath, conversationAttachmentRoot, GIT_ATTACHMENT_MAX_BYTES, validateConversationAttachment, type ConversationAttachmentReference } from './conversation-attachment-reference.js'

export interface ConversationAttachmentScope { mode: 'local' | 'git'; collaborationId: string }
export interface ConversationAttachmentUpload { mode: 'git'; collaborationId: string; uploadId: string; name: string; mimeType: string; bytes: number }
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const json = (value: unknown) => JSON.stringify(value) + '\n'
export function attachmentManifestPath(ref: GitConversationAttachmentReference): string {
  return conversationAttachmentRoot(ref.mode, ref.collaborationId) + '/manifests/' + digest(ref.path) + '.json'
}
/** Signatures route originals; they do not establish complete media validity.
 * Unrecognized raster claims become ordinary files. Native image admission
 * still fully decodes images before model delivery. */
export function attachmentMimeType(data: Uint8Array, declared: string): string {
  const claim = declared.toLowerCase().split(';')[0]!.trim()
  const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(claim) ? claim : 'application/octet-stream'
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const signature = b.subarray(0, 12)
  let detected: string | undefined
  if (signature.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) detected = 'image/png'
  else if (b[0] === 255 && b[1] === 216 && b[2] === 255) detected = 'image/jpeg'
  else if (['GIF87a', 'GIF89a'].includes(signature.subarray(0, 6).toString('ascii'))) detected = 'image/gif'
  else if (signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP') detected = 'image/webp'
  else if (signature.subarray(4, 8).toString('ascii') === 'ftyp') detected = type.startsWith('audio/') ? 'audio/mp4' : 'video/mp4'
  else if (signature.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) detected = type === 'audio/webm' ? 'audio/webm' : 'video/webm'
  else if (signature.subarray(0, 5).toString('ascii') === '%PDF-') detected = 'application/pdf'
  if (detected) return detected
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type) ? 'application/octet-stream' : type
}

/** Git repository originals and Local selected native paths have distinct storage routes. */
export class ConversationAttachments {
  readonly root: string
  readonly markerPath: string
  constructor(readonly files: FilesStore, readonly transactions: FrameworkTransactions, readonly scope: ConversationAttachmentScope) {
    this.root = scope.mode === 'git' ? conversationAttachmentRoot('git', scope.collaborationId) : ''
    this.markerPath = scope.mode === 'git' ? this.root + '/.dss-attachments.json' : ''
  }
  private local(): LocalAttachmentFiles {
    if (this.scope.mode !== 'local') throw new LocalAttachmentError('Select this original in its Local conversation.')
    return new LocalAttachmentFiles({ collaborationId: this.scope.collaborationId })
  }
  selectLocal(input: LocalAttachmentSelection, signal?: AbortSignal): Promise<LocalConversationAttachmentReference> { return this.local().select(input, attachmentMimeType, signal) }
  inspectLocal(ref: LocalConversationAttachmentReference, signal?: AbortSignal) { return this.local().inspect(ref, signal) }
  async validateLocal(ref: LocalConversationAttachmentReference, signal?: AbortSignal) { return this.local().validate(ref, signal) }
  async markerChanges(snapshot: FilesSnapshot): Promise<FileChange[]> {
    if (this.scope.mode === 'local') return []
    return await this.files.readBytes(snapshot, this.markerPath) === undefined
      ? [{ path: this.markerPath, content: json({ version: 1, purpose: 'conversation-attachment-originals' }) }] : []
  }
  /** Fill only a currently missing directory marker. Existing/custom bytes are
   * preserved; this acquisition needs no persistent command acknowledgement. */
  async initialize(): Promise<void> {
    if (this.scope.mode === 'local') return
    const missing = await withSnapshot(this.files, async snapshot => (await this.markerChanges(snapshot)).length !== 0, { files: [this.markerPath] })
    if (!missing) return
    await this.transactions.run('conversation-attachments/initialize/' + randomUUID(), { scope: this.scope },
      { reevaluate: true, gitReplay: 'session-only', readPlan: { files: [this.markerPath] } }, snapshot => this.markerChanges(snapshot))
  }
  async writeBytes(input: ConversationAttachmentUpload, data: Uint8Array): Promise<ConversationAttachmentReference> {
    if (input.mode !== 'git' || this.scope.mode !== 'git' || input.collaborationId !== this.scope.collaborationId || !input.uploadId) throw new Error('Attachment upload scope changed.')
    if (input.bytes !== data.byteLength) throw new Error('Attachment upload length differs from the original file.')
    if (input.mode === 'git' && data.byteLength > GIT_ATTACHMENT_MAX_BYTES) throw new Error('Git attachments must not exceed 104,857,600 bytes (100 MiB).')
    const name = attachmentName(input.name), sha256 = digest(data), mimeType = attachmentMimeType(data, input.mimeType)
    const ref = validateConversationAttachment({ version: 1, source: 'conversation-attachment', ...this.scope,
      name, sha256, mimeType, bytes: data.byteLength, path: attachmentOriginalPath({ mode: 'git', collaborationId: this.scope.collaborationId, name, sha256 }) }, this.scope) as GitConversationAttachmentReference
    const manifest = attachmentManifestPath(ref)
    await this.transactions.run('conversation-attachments/upload/' + this.scope.mode + '/' + this.scope.collaborationId + '/' + input.uploadId,
      { ref }, { reevaluate: true, gitReplay: 'session-only', readPlan: { files: [this.markerPath, manifest, ref.path] } }, async snapshot => {
        const changes = await this.markerChanges(snapshot)
        const previous = await this.files.read(snapshot, manifest), bytes = await this.files.readBytes(snapshot, ref.path)
        if (previous !== undefined || bytes !== undefined) {
          if (previous === undefined || bytes === undefined || !isDeepStrictEqual(JSON.parse(previous), ref)
            || bytes.byteLength !== ref.bytes || digest(bytes) !== ref.sha256) throw new Error('Attachment identity already exists with different or incomplete content.')
          return changes
        }
        return [...changes, { path: ref.path, bytes: data }, { path: manifest, content: json(ref) }]
      })
    return ref
  }
  /** Only Git uploads bytes. Local always uses its explicit selected-path RPC. */
  async upload(input: ConversationAttachmentUpload, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<ConversationAttachmentReference> {
    if (input.mode !== 'git' || this.scope.mode !== 'git' || input.collaborationId !== this.scope.collaborationId || !input.uploadId
      || !Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new Error('Only Git accepts attachment byte uploads. Select the original native file for Local.')
    if (input.bytes > GIT_ATTACHMENT_MAX_BYTES) throw new Error('Git attachments must not exceed 104,857,600 bytes (100 MiB).')
    const chunks: Uint8Array[] = []; let count = 0
    for await (const chunk of source) {
      signal?.throwIfAborted(); count += chunk.byteLength
      if (count > input.bytes || count > GIT_ATTACHMENT_MAX_BYTES) throw new Error('Attachment upload exceeds its declared size.')
      chunks.push(chunk.slice())
    }
    signal?.throwIfAborted()
    return this.writeBytes(input, Buffer.concat(chunks, count))
  }
  async referenceAtPath(snapshot: FilesSnapshot, path: string): Promise<GitConversationAttachmentReference> {
    if (this.scope.mode !== 'git') throw new LocalAttachmentError('Use the complete selected original-file reference to read this Local attachment.')
    if (!path.startsWith(this.root + '/')) throw new Error('Attachment path belongs to another conversation.')
    const manifest = this.root + '/manifests/' + digest(path) + '.json'
    await this.files.prefetch?.(snapshot, { files: [manifest] })
    const raw = await this.files.read(snapshot, manifest)
    if (raw === undefined) throw new Error('Attachment original reference is missing.')
    const saved = JSON.parse(raw), reference = validateConversationAttachment(saved, this.scope)
    if (reference.mode !== 'git' || reference.path !== path) throw new Error('Attachment original path differs from its manifest.')
    return reference
  }
  private async gitReference(snapshot: FilesSnapshot, reference: GitConversationAttachmentReference): Promise<void> {
    const path = attachmentManifestPath(reference)
    await this.files.prefetch?.(snapshot, { files: [path] })
    const raw = await this.files.read(snapshot, path)
    if (raw === undefined) throw new Error('Attachment manifest is missing.')
    if (!isDeepStrictEqual(JSON.parse(raw), reference)) throw new Error('Attachment manifest differs from its original reference.')
  }
  async *streamAt(snapshot: FilesSnapshot, value: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const ref = validateConversationAttachment(value, this.scope)
    if (ref.mode === 'local') { yield* this.local().stream(ref, signal); return }
    await this.gitReference(snapshot, ref)
    signal?.throwIfAborted()
    await this.files.prefetch?.(snapshot, { files: [ref.path], signal })
    const data = await this.files.readBytes(snapshot, ref.path)
    if (data === undefined || data.byteLength !== ref.bytes) throw new Error('Attachment original is missing or has a different length.')
    if (digest(data) !== ref.sha256) throw new Error('Attachment original failed SHA-256 verification.')
    yield data
  }
  async readAt(snapshot: FilesSnapshot, value: unknown, maximumBytes?: number, signal?: AbortSignal): Promise<{ reference: ConversationAttachmentReference; data: Uint8Array }> {
    const reference = validateConversationAttachment(value, this.scope)
    if (reference.mode === 'git' && maximumBytes !== undefined && reference.bytes > maximumBytes) throw new Error('Image exceeds this Host attachment provider’s configured byte limit; original remains stored.')
    const chunks: Uint8Array[] = []; let length = 0
    const stream = reference.mode === 'local' ? this.local().stream(reference, signal, maximumBytes) : this.streamAt(snapshot, reference, signal)
    for await (const chunk of stream) { length += chunk.byteLength; chunks.push(chunk) }
    const data = Buffer.concat(chunks, length)
    return { reference: reference.mode === 'local' ? { ...reference, bytes: length, sha256: digest(data), mimeType: attachmentMimeType(data, reference.mimeType) } : reference, data }
  }
  read(value: unknown) { return withSnapshot(this.files, snapshot => this.readAt(snapshot, value)) }
  async validateReferences(snapshot: FilesSnapshot, refs: readonly ConversationAttachmentReference[] | undefined): Promise<void> {
    for (const value of refs ?? []) {
      const ref = validateConversationAttachment(value, this.scope)
      if (ref.mode === 'local') await this.validateLocal(ref)
      else await this.gitReference(snapshot, ref)
    }
  }
}
