import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { attachmentMimeType } from './conversation-attachments.js'
import { validateConversationAttachment, type LocalConversationAttachmentReference } from './conversation-attachment-reference.js'

/** The official Host store owns browser-uploaded originals. DSS keeps only its
 * existing Local path reference; shared native objects must never be deleted
 * when a draft selection is removed. */
export async function uploadNativeLocalAttachment(
  attachments: Pick<AttachmentStore, 'saveFileStream' | 'fileHostPath'>,
  input: { collaborationId: string; name: string; mimeType: string },
  source: AsyncIterable<Uint8Array>, signal?: AbortSignal,
): Promise<LocalConversationAttachmentReference> {
  const head = new Uint8Array(12)
  let headBytes = 0
  async function* bytes() {
    for await (const chunk of source) {
      const part = chunk.subarray(0, head.length - headBytes)
      head.set(part, headBytes); headBytes += part.byteLength
      yield chunk
    }
  }
  const file = await attachments.saveFileStream({ name: input.name, data: bytes(), ...(signal ? { signal } : {}) })
  const path = attachments.fileHostPath(file)
  if (!path) throw new Error('This Host attachment provider does not expose a local file path.')
  return validateConversationAttachment({
    version: 2, source: 'local-conversation-attachment', mode: 'local', collaborationId: input.collaborationId,
    path, name: file.name, bytes: file.bytes, mimeType: attachmentMimeType(head.subarray(0, headBytes), input.mimeType),
  }, { mode: 'local', collaborationId: input.collaborationId }) as LocalConversationAttachmentReference
}
