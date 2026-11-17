import { createHash } from 'node:crypto'
import { filePath } from './transactions.js'

/** Existing physical message locator, independent of retry timestamp/filename. */
export function physicalConversationEntryPath(collaborationId: string, messageId: string): string {
  filePath(collaborationId)
  if (collaborationId.includes('/') || !messageId) throw new Error('Use the actual conversation and message identity.')
  return 'conversations/local/' + encodeURIComponent(collaborationId) + '/messages/message-'
    + createHash('sha256').update(messageId, 'utf8').digest('hex') + '/entry.json'
}
