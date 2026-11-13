import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { FrameworkTransactions } from './command-transactions.js'
import { withSnapshot, type FilesStore, type FilesSnapshot, type FileChange } from './transactions.js'
import { attachmentName, attachmentOriginalPath, conversationAttachmentRoot, GIT_ATTACHMENT_MAX_BYTES, validateConversationAttachment, type ConversationAttachmentReference } from './conversation-attachment-reference.js'

export interface ConversationAttachmentScope { mode: 'local' | 'git'; collaborationId: string }
interface AttachmentPart { path: string; sha256: string; bytes: number }
interface ChunkManifest { version: 1; storage: 'local-chunks'; reference: ConversationAttachmentReference; chunks: AttachmentPart[] }
const CHUNK_BYTES = 4 * 1024 * 1024
export interface ConversationAttachmentUpload extends ConversationAttachmentScope { uploadId: string; name: string; mimeType: string; bytes: number }
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const json = (value: unknown) => JSON.stringify(value) + '\n'
export function attachmentManifestPath(ref: ConversationAttachmentReference): string {
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

/** Conversation-owned originals in the existing authoritative Local/Git tree. */
export class ConversationAttachments {
  readonly root: string
  readonly markerPath: string
  constructor(readonly files: FilesStore, readonly transactions: FrameworkTransactions, readonly scope: ConversationAttachmentScope) {
    this.root = conversationAttachmentRoot(scope.mode, scope.collaborationId)
    this.markerPath = this.root + '/.dss-attachments.json'
  }
  async markerChanges(snapshot: FilesSnapshot): Promise<FileChange[]> {
    return await this.files.readBytes(snapshot, this.markerPath) === undefined
      ? [{ path: this.markerPath, content: json({ version: 1, purpose: 'conversation-attachment-originals' }) }] : []
  }
  /** One acquisition check. A new command only when absent avoids replay receipts
   * suppressing repair after deletion; existing/custom bytes are never replaced. */
  async initialize(): Promise<void> {
    const missing = await withSnapshot(this.files, async snapshot => (await this.markerChanges(snapshot)).length !== 0, { files: [this.markerPath] })
    if (!missing) return
    await this.transactions.run('conversation-attachments/initialize/' + randomUUID(), { scope: this.scope },
      { reevaluate: true, gitEmptyResult: 'observation-only', readPlan: { files: [this.markerPath] } }, snapshot => this.markerChanges(snapshot))
  }
  async writeBytes(input: ConversationAttachmentUpload, data: Uint8Array): Promise<ConversationAttachmentReference> {
    if (input.mode !== this.scope.mode || input.collaborationId !== this.scope.collaborationId || !input.uploadId) throw new Error('Attachment upload scope changed.')
    if (input.bytes !== data.byteLength) throw new Error('Attachment upload length differs from the original file.')
    if (input.mode === 'git' && data.byteLength > GIT_ATTACHMENT_MAX_BYTES) throw new Error('Git attachments must not exceed 104,857,600 bytes (100 MiB).')
    const name = attachmentName(input.name), sha256 = digest(data), mimeType = attachmentMimeType(data, input.mimeType)
    const ref = validateConversationAttachment({ version: 1, source: 'conversation-attachment', ...this.scope,
      name, sha256, mimeType, bytes: data.byteLength, path: attachmentOriginalPath({ ...this.scope, name, sha256 }) }, this.scope)
    const manifest = attachmentManifestPath(ref)
    await this.transactions.run('conversation-attachments/upload/' + this.scope.mode + '/' + this.scope.collaborationId + '/' + input.uploadId,
      { ref }, { reevaluate: true, readPlan: { files: [this.markerPath, manifest, ref.path] } }, async snapshot => {
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
  /** Bounded HTTP ingress. Local commits immutable 4 MiB parts before publishing
   * one complete manifest; Git's single original blob obeys its product limit.
   * No partial upload is a usable message reference. Incomplete parts remain
   * private and are never automatically deleted. */
  async upload(input: ConversationAttachmentUpload, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<ConversationAttachmentReference> {
    if (input.mode !== this.scope.mode || input.collaborationId !== this.scope.collaborationId || !input.uploadId
      || !Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new Error('Invalid attachment upload metadata.')
    const name = attachmentName(input.name)
    if (input.mode === 'git') {
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
    const parts: AttachmentPart[] = [], whole = createHash('sha256')
    let count = 0, used = 0, pending = new Uint8Array(CHUNK_BYTES), header = new Uint8Array()
    const storePart = async () => {
      if (!used) return
      const data = pending.slice(0, used), sha256 = digest(data)
      const part: AttachmentPart = { path: this.root + '/parts/' + sha256, sha256, bytes: data.byteLength }
      await this.transactions.run('conversation-attachment/part/' + randomUUID(), { part },
        { reevaluate: true, readPlan: { files: [part.path], signal } }, async snapshot => {
          const old = await this.files.readBytes(snapshot, part.path)
          if (old !== undefined) {
            if (old.byteLength !== part.bytes || digest(old) !== sha256) throw new Error('Stored attachment part failed integrity verification.')
            return []
          }
          return [{ path: part.path, bytes: data }]
        })
      parts.push(part); used = 0
    }
    for await (const chunk of source) {
      signal?.throwIfAborted(); count += chunk.byteLength
      if (count > input.bytes) throw new Error('Attachment upload exceeds its declared size.')
      whole.update(chunk)
      if (header.byteLength < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.byteLength)])
      for (let offset = 0; offset < chunk.byteLength;) {
        const take = Math.min(CHUNK_BYTES - used, chunk.byteLength - offset)
        pending.set(chunk.subarray(offset, offset + take), used); used += take; offset += take
        if (used === CHUNK_BYTES) await storePart()
      }
    }
    signal?.throwIfAborted()
    if (count !== input.bytes) throw new Error('Attachment upload length differs from the original file.')
    await storePart(); pending = new Uint8Array()
    const sha256 = whole.digest('hex'), mimeType = attachmentMimeType(header, input.mimeType)
    const ref = validateConversationAttachment({ version: 1, source: 'conversation-attachment', ...this.scope,
      name, sha256, mimeType, bytes: count, path: attachmentOriginalPath({ ...this.scope, name, sha256 }) }, this.scope)
    const manifest: ChunkManifest = { version: 1, storage: 'local-chunks', reference: ref, chunks: parts }
    const path = attachmentManifestPath(ref)
    await this.transactions.run('conversation-attachments/upload/' + this.scope.mode + '/' + this.scope.collaborationId + '/' + input.uploadId,
      { ref }, { reevaluate: true, readPlan: { files: [this.markerPath, path, ref.path], signal } }, async snapshot => {
        const changes = await this.markerChanges(snapshot), old = await this.files.read(snapshot, path)
        if (old !== undefined) {
          if (!isDeepStrictEqual(JSON.parse(old), manifest)) throw new Error('Attachment identity already has different content.')
          return changes
        }
        const descriptor = await this.files.readBytes(snapshot, ref.path)
        if (descriptor !== undefined) throw new Error('Attachment original path is already occupied.')
        return [...changes, { path, content: json(manifest) }, { path: ref.path, content: json({ version: 1, storage: 'local-chunks', manifest: path }) }]
      })
    return ref
  }
  async referenceAtPath(snapshot: FilesSnapshot, path: string): Promise<ConversationAttachmentReference> {
    if (!path.startsWith(this.root + '/')) throw new Error('Attachment path belongs to another conversation.')
    const manifest = this.root + '/manifests/' + digest(path) + '.json'
    await this.files.prefetch?.(snapshot, { files: [manifest] })
    const raw = await this.files.read(snapshot, manifest)
    if (raw === undefined) throw new Error('Attachment original reference is missing.')
    const saved = JSON.parse(raw), reference = validateConversationAttachment(saved.reference ?? saved, this.scope)
    if (reference.path !== path) throw new Error('Attachment original path differs from its manifest.')
    return reference
  }
  private async manifest(snapshot: FilesSnapshot, value: unknown): Promise<{ reference: ConversationAttachmentReference; chunks?: AttachmentPart[] }> {
    const reference = validateConversationAttachment(value, this.scope), path = attachmentManifestPath(reference)
    await this.files.prefetch?.(snapshot, { files: [path] })
    const raw = await this.files.read(snapshot, path)
    if (raw === undefined) throw new Error('Attachment manifest is missing.')
    const saved = JSON.parse(raw) as ConversationAttachmentReference | ChunkManifest
    if ('storage' in saved && saved.storage === 'local-chunks') {
      if (reference.mode !== 'local' || saved.version !== 1 || !isDeepStrictEqual(saved.reference, reference) || !Array.isArray(saved.chunks)) throw new Error('Invalid attachment manifest.')
      let total = 0
      for (const part of saved.chunks) {
        if (!/^[a-f0-9]{64}$/.test(part.sha256) || part.path !== this.root + '/parts/' + part.sha256
          || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > CHUNK_BYTES) throw new Error('Invalid attachment part.')
        total += part.bytes
      }
      if (!Number.isSafeInteger(total) || total !== reference.bytes) throw new Error('Attachment parts do not match the original length.')
      return { reference, chunks: saved.chunks }
    }
    if (!isDeepStrictEqual(saved, reference)) throw new Error('Attachment manifest differs from its original reference.')
    return { reference }
  }
  /** Holds one immutable snapshot across streaming and verifies every part before
   * emitting it, then the complete original digest. Native saveFileStream does
   * not publish a file reference until this iterator finishes successfully. */
  async *streamAt(snapshot: FilesSnapshot, value: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const { reference: ref, chunks } = await this.manifest(snapshot, value), whole = createHash('sha256')
    let finalPart: Uint8Array | undefined
    if (chunks) {
      for (const part of chunks) {
        signal?.throwIfAborted()
        const data = await this.files.readBytes(snapshot, part.path)
        if (data === undefined || data.byteLength !== part.bytes || digest(data) !== part.sha256) throw new Error('Attachment part is missing or failed SHA-256 verification.')
        whole.update(data)
        if (finalPart) yield finalPart
        finalPart = data
      }
    } else {
      await this.files.prefetch?.(snapshot, { files: [ref.path], signal })
      const data = await this.files.readBytes(snapshot, ref.path)
      if (data === undefined || data.byteLength !== ref.bytes) throw new Error('Attachment original is missing or has a different length.')
      whole.update(data)
      finalPart = data
    }
    if (whole.digest('hex') !== ref.sha256) throw new Error('Attachment original failed SHA-256 verification.')
    // Never satisfy HTTP Content-Length before the whole-original digest is
    // known. Holding the final bounded part avoids a second read/transfer.
    if (finalPart) yield finalPart
  }
  async readAt(snapshot: FilesSnapshot, value: unknown, maximumBytes?: number): Promise<{ reference: ConversationAttachmentReference; data: Uint8Array }> {
    const reference = validateConversationAttachment(value, this.scope)
    if (maximumBytes !== undefined && reference.bytes > maximumBytes) throw new Error('Image exceeds this Host attachment provider’s configured byte limit; original remains stored.')
    const chunks: Uint8Array[] = []
    for await (const chunk of this.streamAt(snapshot, reference)) chunks.push(chunk)
    return { reference, data: Buffer.concat(chunks, reference.bytes) }
  }
  read(value: unknown) { return withSnapshot(this.files, snapshot => this.readAt(snapshot, value)) }
  async validateReferences(snapshot: FilesSnapshot, refs: readonly ConversationAttachmentReference[] | undefined): Promise<void> {
    for (const ref of refs ?? []) for await (const _chunk of this.streamAt(snapshot, ref)) { /* bounded verification before publishing a message */ }
  }
}
