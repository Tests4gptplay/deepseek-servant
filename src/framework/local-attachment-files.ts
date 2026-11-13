import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { isNativeAttachmentPath, LocalAttachmentError, validateConversationAttachment, type LocalConversationAttachmentReference } from './conversation-attachment-reference.js'

export interface LocalAttachmentSelection {
  mode: 'local'; collaborationId: string; selectionId: string; path: string; name: string; mimeType: string
}
const wrap = (error: unknown): Error => error instanceof LocalAttachmentError ? error
  : new LocalAttachmentError('This attachment’s original path is not readable on this Host. Check the original file and try again.', { cause: error })
const BLOCK_BYTES = 256 * 1024

/** Reads only an explicitly selected original. No writes, imported copies,
 * chunks, manifests, version locks, fallback directories or guessed paths. */
export class LocalAttachmentFiles {
  constructor(private readonly scope: { collaborationId: string }) {}
  private checkPath(value: string): void {
    if (!isNativeAttachmentPath(value) || !path.isAbsolute(value)) throw new LocalAttachmentError('This attachment needs the actual absolute path returned by the desktop file picker on this Host.')
  }
  private async acquire(value: string): Promise<{ file: FileHandle; bytes: number }> {
    this.checkPath(value)
    const file = await open(value, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new LocalAttachmentError('Select a regular file whose length can be represented safely on this Host.')
      return { file, bytes: stat.size }
    } catch (error) { await file.close(); throw error }
  }
  private reference(value: unknown): LocalConversationAttachmentReference {
    return validateConversationAttachment(value, { mode: 'local', ...this.scope }) as LocalConversationAttachmentReference
  }
  async select(input: LocalAttachmentSelection, mime: (head: Uint8Array, declared: string) => string, signal?: AbortSignal): Promise<LocalConversationAttachmentReference> {
    try {
      signal?.throwIfAborted()
      if (input.mode !== 'local' || input.collaborationId !== this.scope.collaborationId || !input.selectionId)
        throw new LocalAttachmentError('Invalid original-file selection metadata.')
      this.checkPath(input.path)
      if (path.basename(input.path) !== input.name) throw new LocalAttachmentError('The selected filename does not match its original native path.')
      const selected = await this.acquire(input.path)
      try {
        const head = new Uint8Array(12), { bytesRead } = await selected.file.read(head, 0, head.length, 0)
        signal?.throwIfAborted()
        return { version: 2, source: 'local-conversation-attachment', mode: 'local', collaborationId: input.collaborationId,
          path: input.path, name: input.name, mimeType: mime(head.subarray(0, bytesRead), input.mimeType), bytes: selected.bytes }
      } finally { await selected.file.close() }
    } catch (error) { signal?.throwIfAborted(); throw wrap(error) }
  }
  async *stream(value: unknown, signal?: AbortSignal, maximumBytes?: number): AsyncIterable<Uint8Array> {
    try {
      signal?.throwIfAborted()
      const ref = this.reference(value), selected = await this.acquire(ref.path)
      try {
        if (maximumBytes !== undefined && selected.bytes > maximumBytes) throw new LocalAttachmentError('This attachment’s current size exceeds the actual image provider limit. The original file is unchanged.')
        let total = 0
        for await (const block of selected.file.createReadStream({ autoClose: false, highWaterMark: BLOCK_BYTES, signal })) {
          signal?.throwIfAborted(); total += block.byteLength
          if (maximumBytes !== undefined && total > maximumBytes) throw new LocalAttachmentError('This attachment’s current size exceeds the actual image provider limit. The original file is unchanged.')
          yield block
        }
      } finally { await selected.file.close() }
    } catch (error) { signal?.throwIfAborted(); throw wrap(error) }
  }
  async validate(value: unknown, signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted()
      const selected = await this.acquire(this.reference(value).path)
      await selected.file.close(); signal?.throwIfAborted()
    } catch (error) { signal?.throwIfAborted(); throw wrap(error) }
  }
  async inspect(value: LocalConversationAttachmentReference, signal?: AbortSignal) {
    try {
      signal?.throwIfAborted()
      const selected = await this.acquire(this.reference(value).path)
      try {
        // Media signature only, not a new user-facing file-read window.
        const head = new Uint8Array(12), { bytesRead } = await selected.file.read(head, 0, head.length, 0)
        signal?.throwIfAborted()
        return { head: head.subarray(0, bytesRead), bytes: selected.bytes }
      } finally { await selected.file.close() }
    } catch (error) { signal?.throwIfAborted(); throw wrap(error) }
  }
}
