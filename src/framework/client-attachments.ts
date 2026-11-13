import type { ClientTransportHooks, RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import type { FrameworkClientApi } from './client-contracts.js'
import { GIT_ATTACHMENT_MAX_BYTES, isNativeAttachmentPath, LocalAttachmentError, isLocalAttachmentError, validateConversationAttachment, type ConversationAttachmentReference } from './conversation-attachment-reference.js'
import { frameworkErrorText, frameworkRpcError } from './client-error.js'

export const gitAttachmentByteLimit = GIT_ATTACHMENT_MAX_BYTES
const attachmentRoute = 'api/deepseek-servant-framework/attachment'
const uploadRoute = 'api/deepseek-servant-framework/upload-attachment'

/** Official DSH desktop preload delegates to Electron webUtils.getPathForFile.
 * No File.path, input.value, filename guessing or Blob-copy fallback. */
export function selectedLocalAttachmentPath(file: File): string {
  const paths = (globalThis as typeof globalThis & { __DSH_HOST_PATHS__?: { pathFor(file: File): string } }).__DSH_HOST_PATHS__
  let path: string | undefined
  try { path = paths?.pathFor(file) } catch (error) { throw new LocalAttachmentError('This attachment’s original native path could not be obtained from the DSH desktop picker.', { cause: error }) }
  if (!isNativeAttachmentPath(path)) throw new LocalAttachmentError('This attachment has no original native file path. Select the saved original file in the DSH desktop app; a pasted screenshot or generated Blob is not copied into Local storage.')
  return path
}

/** Match the official client RPC carrier: an explicit fetch hook wins;
 * otherwise document-relative fetch uses the same Host mount. The official
 * desktop transport supplies ownsHost/streamBaseUrl, not a fetch hook. */
export function attachmentFetch(transport: ClientTransportHooks | undefined, browserFetch: RpcFetch): RpcFetch {
  return transport?.fetch?.bind(transport) ?? browserFetch
}

export async function uploadConversationAttachment(fetch: RpcFetch, input: Parameters<NonNullable<FrameworkClientApi['uploadAttachment']>>[0], file: Blob, signal: AbortSignal) {
  signal.throwIfAborted()
  if (file.size !== input.bytes) throw new Error('The selected attachment size changed.')
  const response = await fetch(uploadRoute + '?metadata=' + encodeURIComponent(JSON.stringify(input)), {
    method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'content-type': 'application/octet-stream' }, body: file, signal,
  })
  if (!response.ok) {
    const text = await response.text()
    let failure: { ok?: unknown; error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined
    try { failure = JSON.parse(text) } catch { /* A carrier may reject before the DSS handler. */ }
    if (failure?.ok === false && typeof failure.error?.code === 'string' && typeof failure.error.message === 'string')
      throw frameworkRpcError('uploadAttachment', { code: failure.error.code, message: failure.error.message, details: failure.error.details })
    throw Object.assign(new Error(text || 'Attachment upload failed: HTTP ' + response.status), { status: response.status })
  }
  const result = await response.json() as Awaited<ReturnType<NonNullable<FrameworkClientApi['uploadAttachment']>>>
  signal.throwIfAborted()
  return result
}

export class AttachmentDownloadCapabilityError extends Error {
  constructor(readonly capability: 'webcrypto' | 'client-memory') {
    super(capability === 'webcrypto' ? 'This DSS interface needs WebCrypto SHA-256 to verify this attachment download.'
      : 'This DSS interface could not allocate memory for the complete attachment download.')
  }
}

/** A native anchor is allowed only for this exact authenticated relative route.
 * Return a document-relative path so a served Host mount remains intact. */
export function authenticatedAttachmentDownloadPath(downloadUrl: string): string {
  const path = downloadUrl.startsWith('/') ? downloadUrl.slice(1) : downloadUrl
  if (path.split('?', 1)[0] !== attachmentRoute || path.includes('#') || path.includes('\\')) throw new Error('The attachment download is not an authenticated DSS endpoint.')
  return path
}

/** Served browsers let their download manager receive the authenticated original
 * response directly. They never construct a whole-file JS Blob/ArrayBuffer.
 * A desktop shell uses the same carrier selection as the official client RPC. */
export async function prepareConversationAttachmentDownload(transport: ClientTransportHooks | undefined, result: { downloadUrl: string; mimeType: string; bytes: number }, expectedSha256: string, signal: AbortSignal,
  browserFetch: RpcFetch = (input, init) => globalThis.fetch(input, init)) {
  signal.throwIfAborted()
  const downloadUrl = authenticatedAttachmentDownloadPath(result.downloadUrl)
  if (transport === undefined) return { ...result, downloadUrl }
  return downloadConversationAttachment(attachmentFetch(transport, browserFetch), { ...result, downloadUrl }, expectedSha256, signal)
}

/** The shell-only raw carrier uses a temporary verified object URL, never a
 * stored attachment reference. The served browser path above avoids this buffer. */
export async function downloadConversationAttachment(fetch: RpcFetch, result: { downloadUrl: string; mimeType: string; bytes: number }, expectedSha256: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const path = authenticatedAttachmentDownloadPath(result.downloadUrl)
  if (!globalThis.crypto?.subtle) throw new AttachmentDownloadCapabilityError('webcrypto')
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('The attachment SHA-256 reference is invalid.')
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal })
  if (!response.ok) throw new Error(await response.text() || 'Attachment download failed: HTTP ' + response.status)
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== result.bytes)) { await response.body?.cancel(); throw new Error('The attachment response length differs from the original.') }
  let blob: Blob
  try { blob = await response.blob() } catch (error) { if (error instanceof RangeError) throw new AttachmentDownloadCapabilityError('client-memory'); throw error }
  signal.throwIfAborted()
  if (blob.size !== result.bytes) throw new Error('The attachment download is incomplete.')
  // WebCrypto currently requires one complete buffer. This is a browser-memory
  // constraint, not a Local storage or upload size policy.
  let digest: Uint8Array
  try { digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())) }
  catch (error) { if (error instanceof RangeError) throw new AttachmentDownloadCapabilityError('client-memory'); throw error }
  signal.throwIfAborted()
  if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== expectedSha256) throw new Error('The attachment download failed SHA-256 verification.')
  return { ...result, downloadUrl: URL.createObjectURL(blob) }
}

export type AttachmentOwner = { mode: 'local' | 'git'; collaborationId: string; storageScope: string }
export interface ComposerAttachment {
  id: string
  file?: File
  name: string
  mimeType: string
  bytes?: number
  originalPath?: string
  state: 'queued' | 'uploading' | 'ready' | 'error'
  reference?: ConversationAttachmentReference
  error?: string
  issue?: 'git-size' | 'unavailable'
}
const emptyAttachments: readonly ComposerAttachment[] = []

/** Files, upload identities and receipts stay with their original conversation.
 * Each selection runs independently. Navigation never moves a selection. */
export class ConversationAttachmentDrafts {
  private rows = new Map<string, ComposerAttachment[]>()
  private owners = new Map<string, AttachmentOwner>()
  private requests = new Map<string, AbortController>()
  private listeners = new Set<() => void>()
  private revision = 0
  constructor(private api: FrameworkClientApi) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.revision
  private changed() { this.revision++; for (const listener of this.listeners) listener() }
  selections(scope: string): readonly ComposerAttachment[] { return this.rows.get(scope) ?? emptyAttachments }
  add(scope: string, owner: AttachmentOwner, files: readonly File[]): void {
    const rows = [...this.selections(scope)]
    this.owners.set(scope, { ...owner })
    const added = files.map(file => ({ id: crypto.randomUUID(), file, name: file.name, mimeType: file.type || 'application/octet-stream', bytes: file.size, state: 'queued' as const }))
    rows.push(...added); this.rows.set(scope, rows)
    for (const row of added) this.enqueue(scope, row)
    this.changed()
  }
  /** An explicit Host path is an address on the Host, not a browser File or an upload. */
  addHostPath(scope: string, owner: AttachmentOwner, nativePath: string): void {
    if (owner.mode !== 'local' || !isNativeAttachmentPath(nativePath)) throw new LocalAttachmentError('Enter an absolute file path on the DSH Host computer.')
    const name = nativePath.replaceAll('\\', '/').split('/').at(-1)
    if (!name) throw new LocalAttachmentError('Enter the complete absolute file path on the DSH Host computer.')
    const row: ComposerAttachment = { id: crypto.randomUUID(), name, mimeType: 'application/octet-stream', originalPath: nativePath, state: 'queued' }
    this.owners.set(scope, { ...owner })
    this.rows.set(scope, [...this.selections(scope), row])
    this.enqueue(scope, row)
    this.changed()
  }
  private enqueue(scope: string, row: ComposerAttachment): void {
    const owner = this.owners.get(scope)!
    if (owner.mode === 'git' && row.file && row.file.size > gitAttachmentByteLimit) { row.state = 'error'; row.issue = 'git-size'; return }
    if (owner.mode === 'local' ? !this.api.selectLocalAttachment : !this.api.uploadAttachment) { row.state = 'error'; row.issue = 'unavailable'; return }
    row.state = 'queued'; row.error = undefined; row.issue = undefined
    const request = new AbortController(); this.requests.set(row.id, request)
    const operation = Promise.resolve().then(async () => {
      if (request.signal.aborted || !this.selections(scope).includes(row)) return
      row.state = 'uploading'; this.changed()
      try {
        let receipt: { attachment: ConversationAttachmentReference; storageScope: string }
        if (owner.mode === 'local') {
          const path = row.originalPath ?? selectedLocalAttachmentPath(row.file!)
          row.originalPath = path
          receipt = await this.api.selectLocalAttachment!({ ...owner, mode: 'local', selectionId: row.id, path, name: row.name, mimeType: row.mimeType }, request.signal)
        } else receipt = await this.api.uploadAttachment!({ ...owner, mode: 'git', uploadId: row.id, name: row.name, mimeType: row.mimeType, bytes: row.file!.size }, row.file!, request.signal)
        if (request.signal.aborted || !this.selections(scope).includes(row)) return
        const reference = validateConversationAttachment(receipt.attachment, owner)
        if (receipt.storageScope !== owner.storageScope || (reference.mode === 'git' && reference.bytes !== row.file!.size) || (reference.mode === 'local' && reference.path !== row.originalPath)) {
          throw new Error('The attachment receipt does not match its conversation and original file.')
        }
        row.reference = { ...reference }; row.bytes = reference.bytes; row.state = 'ready'
      } catch (reason) {
        if (!request.signal.aborted && this.selections(scope).includes(row)) { row.state = 'error'; row.error = isLocalAttachmentError(reason) ? reason.message : frameworkErrorText(reason) }
      } finally {
        if (this.requests.get(row.id) === request) this.requests.delete(row.id)
        this.changed()
      }
    })
    void operation.catch(() => {})
  }
  retry(scope: string, id: string): void {
    const row = this.selections(scope).find(item => item.id === id)
    if (!row || row.state !== 'error') return
    this.enqueue(scope, row); this.changed()
  }
  remove(scope: string, id: string): void {
    this.requests.get(id)?.abort(); this.requests.delete(id)
    this.rows.set(scope, this.selections(scope).filter(row => row.id !== id)); this.changed()
  }
  acknowledge(scope: string, references: readonly ConversationAttachmentReference[]): void {
    const keys = new Set(references.map(reference => reference.path + ':' + reference.sha256))
    this.rows.set(scope, this.selections(scope).filter(row => !row.reference || !keys.has(row.reference.path + ':' + row.reference.sha256)))
    this.changed()
  }
}
const stores = new WeakMap<FrameworkClientApi, ConversationAttachmentDrafts>()
export function getConversationAttachmentDrafts(api: FrameworkClientApi): ConversationAttachmentDrafts {
  let store = stores.get(api)
  if (!store) { store = new ConversationAttachmentDrafts(api); stores.set(api, store) }
  return store
}
export function sameAttachmentReferences(left: readonly ConversationAttachmentReference[] = [], right: readonly ConversationAttachmentReference[] = []): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
export function attachmentKind(mimeType: string): 'image' | 'video' | 'file' {
  return mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'file'
}
export function attachmentByteLabel(bytes: number): string {
  return bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
}
