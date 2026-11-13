import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
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
/** Native Local reads belong to the current Host tool execution, not the DSS
 * repository reader. A plain path is an address, never a filesystem grant. */
export async function prepareNativeLocalAttachment(ctx: Context,
  reference: LocalConversationAttachmentReference | string, exec: ToolRunContext): Promise<NativeConversationAttachment> {
  exec.signal.throwIfAborted()
  const path = typeof reference === 'string' ? reference : reference.path
  if (!isNativeAttachmentPath(path)) throw new LocalAttachmentError('Local attachment input must be its actual absolute native path.')
  const image = /\.(png|jpe?g|webp|gif)$/iu.test(path)
    || typeof reference !== 'string' && rasterTypes.includes(reference.mimeType)
  if (!image) {
    const note = 'Use the original native path with the Host’s existing file-reading and processing tools within their permissions. This step has not read or checked the file, and does not confirm its contents, availability or analysis. DSS does not copy the original or add a file-size policy. For an extension-less image, use the Host’s read_image tool with this same path.'
    return { reference, delivery: 'local-file-path', note,
      content: [{ type: 'text', text: note }, { type: 'text', text: JSON.stringify({ path }) }] }
  }
  if (typeof ctx.tools?.execute !== 'function') throw new LocalAttachmentError('This Host has no native tool execution capability for reading the image. Its original path remains available: ' + path)
  const result = await ctx.tools.execute({ name: 'read_image', arguments: { file_path: path },
    agent: exec.agent, signal: exec.signal, parent: exec.token, rootCallId: exec.rootCallId,
    callId: (String(exec.callId) + ':read_image') as ToolCallId })
  for (const context of result.additionalContexts ?? []) exec.deferContext(context)
  if (result.isError) {
    // Preserve the Host's actual refusal/error, including its routable identity.
    // Never retry through Node fs or call a registered tool body directly.
    const info = result.error.info
    const error = info?.code ? new (await import('@deepseek-ai/dsh-llm')).HarnessError(result.error.message, info.code, { cause: result })
      : new Error(result.error.message, { cause: result })
    if (info?.name) error.name = info.name
    throw error
  }
  if (result.concludesTurn) exec.concludeTurn()
  return { reference, delivery: result.content.some(block => block.type === 'image') ? 'image-content' : 'local-file-path',
    content: result.content, note: 'The Host read_image result is supplied unchanged. The Host may normalize and store its own image preview; DSS does not copy the Local original. This is not confirmation of visual analysis.' }
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
