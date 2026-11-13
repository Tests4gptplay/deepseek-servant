/** Portable, authenticated-store identity. Never a local path or signed URL. */
export interface ConversationAttachmentReference {
  version: 1
  source: 'conversation-attachment'
  mode: 'local' | 'git'
  collaborationId: string
  path: string
  name: string
  mimeType: string
  bytes: number
  sha256: string
}
export const GIT_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024
export function conversationAttachmentRoot(mode: 'local' | 'git', collaborationId: string): string {
  if (!collaborationId || /[\\/\0\r\n]/u.test(collaborationId) || ['.', '..'].includes(collaborationId)) throw new Error('Invalid conversation identity.')
  const key = encodeURIComponent(collaborationId)
  return mode === 'git' ? 'conversations/git/' + key + '/attachments' : 'conversations/local/attachments/' + key
}
export function attachmentName(name: string): string {
  const leaf = name.replaceAll('\\', '/').split('/').at(-1)?.replace(/[\x00-\x1f\x7f]/gu, '').trim()
  if (!leaf || leaf === '.' || leaf === '..') throw new Error('Attachment needs a valid non-empty filename, without a local path.')
  return leaf
}
export function attachmentOriginalPath(reference: Pick<ConversationAttachmentReference, 'mode' | 'collaborationId' | 'sha256' | 'name'>): string {
  return conversationAttachmentRoot(reference.mode, reference.collaborationId) + '/' + reference.sha256 + '/' + encodeURIComponent(reference.name).replace(/\./g, '%2E')
}
export function validateConversationAttachment(value: unknown, scope?: { mode: 'local' | 'git'; collaborationId: string }): ConversationAttachmentReference {
  const ref = value as ConversationAttachmentReference | undefined
  if (!ref || ref.version !== 1 || ref.source !== 'conversation-attachment' || !['local', 'git'].includes(ref.mode)
    || typeof ref.collaborationId !== 'string' || typeof ref.path !== 'string' || typeof ref.name !== 'string'
    || attachmentName(ref.name) !== ref.name || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
    || !/^[a-f0-9]{64}$/.test(ref.sha256) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(ref.mimeType)
    || ref.path !== attachmentOriginalPath(ref) || scope && (ref.mode !== scope.mode || ref.collaborationId !== scope.collaborationId))
    throw new Error('Invalid attachment reference or conversation scope.')
  if (ref.mode === 'git' && ref.bytes > GIT_ATTACHMENT_MAX_BYTES) throw new Error('Git attachments must not exceed 104,857,600 bytes (100 MiB).')
  return { version: 1, source: 'conversation-attachment', mode: ref.mode, collaborationId: ref.collaborationId,
    path: ref.path, name: ref.name, mimeType: ref.mimeType, bytes: ref.bytes, sha256: ref.sha256 }
}
export function isConversationAttachmentPath(path: string): boolean {
  return /^conversations\/git\/[^/]+\/attachments(?:\/|$)/u.test(path)
    || /^conversations\/local\/attachments(?:\/?$|\/[^/]+(?:\/?$|\/(?:\.dss-attachments\.json$|(?:parts|manifests)(?:\/|$)|[a-f0-9]{64}(?:\/|$))))/u.test(path)
}
