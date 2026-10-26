import type { CoopStore } from './cache.js'
import type { CoopView, GitRepository, GitSnapshot } from './contracts.js'
import { json, readJson, readText } from './journal.js'
export interface ConversationHeader { id: string; role: 'user' | 'assistant'; createdAt: string; textPath: string; path: string }
export function conversationPaths(snapshot: GitSnapshot, participant: string): string[] {
  return [...snapshot.files.keys()].filter(path => path.startsWith('dss-coop/conversations/' + participant + '/') && path.endsWith('/entry.json')).sort().reverse()
}
export async function conversationHeader(repo: GitRepository, cache: CoopStore, snapshot: GitSnapshot, path: string): Promise<ConversationHeader | undefined> {
  const key = 'message-header/' + path, previous = cache.get<{ sha: string; header: ConversationHeader }>(key), sha = snapshot.files.get(path)!
  if (previous?.sha === sha) return previous.header
  const value = await readJson<Omit<ConversationHeader, 'path'>>(repo, snapshot, path)
  if (!value) return
  const header = { ...value, path }
  await cache.put(key, { sha, header }); return header
}
export async function conversationText(repo: GitRepository, cache: CoopStore, snapshot: GitSnapshot, entry: ConversationHeader): Promise<CoopView['messages'][number]> {
  const stamp = json([...snapshot.files].filter(([path]) => path === entry.path || path.startsWith(entry.textPath + '/')))
  const key = 'message-view/' + entry.path, previous = cache.get<{ stamp: string; value: CoopView['messages'][number] }>(key)
  if (previous?.stamp === stamp) return previous.value
  const value = { id: entry.id, role: entry.role, createdAt: entry.createdAt, text: await readText(repo, snapshot, entry.textPath), commit: snapshot.head }
  await cache.put(key, { stamp, value }); return value
}
export async function conversationPage(repo: GitRepository, cache: CoopStore, snapshot: GitSnapshot, participant: string, before?: string) {
  const paths = conversationPaths(snapshot, participant).filter(path => !before || path < before), page = paths.slice(0, 50), messages: CoopView['messages'] = []
  for (const path of page.reverse()) {
    const header = await conversationHeader(repo, cache, snapshot, path)
    if (header) messages.push(await conversationText(repo, cache, snapshot, header))
  }
  return { messages, moreBefore: paths.length > 50 ? paths[49] : undefined }
}
