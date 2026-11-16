import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ConversationAttachments } from '../../framework/conversation-attachments.js'
import { LocalAttachmentError, isNativeAttachmentPath, type ConversationAttachmentReference, type LocalConversationAttachmentReference, type GitConversationAttachmentReference } from '../../framework/conversation-attachment-reference.js'
import type { FilesSnapshot } from '../../framework/transactions.js'

/** Native image blocks carry actual image content, never a path-as-image URI. */
export interface NativeConversationAttachment {
  reference: ConversationAttachmentReference | string
  content: ContentBlock[]
  delivery: 'image-content' | 'file-content' | 'local-file-path'
  note: string
}
const rasterTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** Local references locate the original; the model's configured native executor
 * owns the subsequent read and its permissions. A path is not image content. */
export async function prepareNativeLocalAttachment(
  reference: LocalConversationAttachmentReference | string, signal: AbortSignal): Promise<NativeConversationAttachment> {
  signal.throwIfAborted()
  const path = typeof reference === 'string' ? reference : reference.path
  if (!isNativeAttachmentPath(path)) throw new LocalAttachmentError('Local attachment input must be its actual absolute native path.')
  const note = 'This is the actual Local file path, not file or image content. This step has not read or checked the file. Use the Host’s existing tools within their permissions to read it. For an image, call the native read_image tool through your current executor; only its actual image result supplies pixels. Report any unavailable tool, unsupported model or access refusal without bypassing it. DSS does not copy the original or add a file-size policy.'
  return { reference, delivery: 'local-file-path', note,
    content: [{ type: 'text', text: note }, { type: 'text', text: JSON.stringify({ path }) }] }
}
export async function prepareNativeConversationAttachment(ctx: Context, store: ConversationAttachments,
  snapshot: FilesSnapshot, ref: GitConversationAttachmentReference, signal: AbortSignal): Promise<NativeConversationAttachment> {
  signal.throwIfAborted()
  const attachments = ctx.get('attachments')
  if (!attachments) throw new Error('This Host has no attachment provider. The original is stored, but has not been given to the model.')
  if (rasterTypes.includes(ref.mimeType)) {
    const { data } = await store.readAt(snapshot, ref, attachments.imageLimits.maxImageBytes, signal)
    signal.throwIfAborted()
    const image = await attachments.saveImage({ data, name: ref.name, mediaType: ref.mimeType as ImageMediaType })
    signal.throwIfAborted()
    const note = 'Image saved and supplied as a native ImageBlock. The LLM projects it for the selected route; this does not confirm visual analysis. The provider may normalize its preview; the Git original and its SHA-256 are unchanged.'
    return { reference: ref, delivery: 'image-content', note,
      content: [{ type: 'text', text: note }, { type: 'image', attachment: image }] }
  }
  const file = await attachments.saveFileStream({ data: store.streamAt(snapshot, ref, signal), name: ref.name, signal })
  signal.throwIfAborted()
  if (file.bytes !== ref.bytes || String(file.attachmentId) !== 'sha256:' + ref.sha256) throw new Error('Native file provider did not preserve the original attachment bytes.')
  const note = ref.mimeType.startsWith('video/')
    ? 'Original video supplied as a native FileBlock. No frames, timestamps, audio or transcription have been analyzed. Use actually available native tools within their permissions; if decoding/transcription tools are unavailable, report that limitation.'
    : 'Original file supplied as a native FileBlock. This is file availability, not evidence that its contents have been analyzed. Use actually available native tools within their permissions.'
  return { reference: ref, delivery: 'file-content', note,
    content: [{ type: 'text', text: note }, { type: 'file', attachment: file }] }
}
