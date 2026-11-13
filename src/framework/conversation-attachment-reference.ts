interface AttachmentMetadata {
  collaborationId: string
  path: string
  name: string
  mimeType: string
  bytes: number
}
/** Git originals are repository objects; Local originals remain at the exact
 * path selected on their source Host. These are deliberately separate formats. */
export interface GitConversationAttachmentReference extends AttachmentMetadata {
  version: 1
  source: 'conversation-attachment'
  mode: 'git'
  sha256: string
}
export interface LocalConversationAttachmentReference extends AttachmentMetadata {
  version: 2
  source: 'local-conversation-attachment'
  mode: 'local'
  /** Optional observation, never a lock on subsequent original-file edits. */
  sha256?: string
}
export type ConversationAttachmentReference = GitConversationAttachmentReference | LocalConversationAttachmentReference
export class LocalAttachmentError extends Error {
  readonly code = 'dss/local-attachment'
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'LocalAttachmentError' }
}
export function isLocalAttachmentError(value: unknown): value is Error & { code: string } {
  return !!value && typeof value === 'object' && (value as { code?: string }).code === 'dss/local-attachment'
}
export const GIT_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024
function validateConversationId(collaborationId: string): void {
  if (!collaborationId || /[\\/\0\r\n]/u.test(collaborationId) || ['.', '..'].includes(collaborationId)) throw new Error('Invalid conversation identity.')
}
export function conversationAttachmentRoot(mode: 'git', collaborationId: string): string {
  if (mode !== 'git') throw new Error('Local originals have no DSS attachment storage root.')
  validateConversationId(collaborationId)
  return 'conversations/git/' + encodeURIComponent(collaborationId) + '/attachments'
}
export function attachmentName(name: string): string {
  const leaf = name.replaceAll('\\', '/').split('/').at(-1)?.replace(/[\x00-\x1f\x7f]/gu, '').trim()
  if (!leaf || leaf === '.' || leaf === '..') throw new Error('Attachment needs a valid non-empty filename, without a local path.')
  return leaf
}
export function isNativeAttachmentPath(path: unknown): path is string {
  return typeof path === 'string' && !/[\x00-\x1f\x7f]/u.test(path)
    && (path.startsWith('/') || /^[a-z]:[\\/]/iu.test(path) || /^\\\\[^\\]+\\[^\\]+\\/u.test(path))
}
export function attachmentOriginalPath(reference: Pick<GitConversationAttachmentReference, 'mode' | 'collaborationId' | 'sha256' | 'name'>): string {
  return conversationAttachmentRoot(reference.mode, reference.collaborationId) + '/' + reference.sha256 + '/' + encodeURIComponent(reference.name).replace(/\./g, '%2E')
}
export function validateConversationAttachment(value: unknown, scope?: { mode: 'local' | 'git'; collaborationId: string }): ConversationAttachmentReference {
  const ref = value as ConversationAttachmentReference | undefined
  if (!ref || !['local', 'git'].includes(ref.mode) || typeof ref.collaborationId !== 'string' || typeof ref.path !== 'string' || typeof ref.name !== 'string'
    || !ref.name || (ref.mode === 'git' && attachmentName(ref.name) !== ref.name) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
    || typeof ref.mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(ref.mimeType)
    || scope && (ref.mode !== scope.mode || ref.collaborationId !== scope.collaborationId)) throw new Error('Invalid attachment reference or conversation scope.')
  validateConversationId(ref.collaborationId)
  const common = { collaborationId: ref.collaborationId, path: ref.path, name: ref.name, mimeType: ref.mimeType, bytes: ref.bytes }
  if (ref.mode === 'local') {
    if (ref.version !== 2 || ref.source !== 'local-conversation-attachment' || !isNativeAttachmentPath(ref.path) || ref.path.replaceAll('\\', '/').split('/').at(-1) !== ref.name
      || ref.sha256 !== undefined && (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)))
      throw new LocalAttachmentError('This Local attachment has no valid original-file reference. Select the original file again.')
    return { version: 2, source: 'local-conversation-attachment', mode: 'local', ...common, ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }) }
  }
  if (ref.version !== 1 || ref.source !== 'conversation-attachment' || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.path !== attachmentOriginalPath(ref)) throw new Error('Invalid Git attachment reference.')
  if (ref.bytes > GIT_ATTACHMENT_MAX_BYTES) throw new Error('Git attachments must not exceed 104,857,600 bytes (100 MiB).')
  return { version: 1, source: 'conversation-attachment', mode: 'git', ...common, sha256: ref.sha256 }
}
export function isConversationAttachmentPath(path: string): boolean {
  return /^conversations\/git\/[^/]+\/attachments(?:\/|$)/u.test(path)
}
