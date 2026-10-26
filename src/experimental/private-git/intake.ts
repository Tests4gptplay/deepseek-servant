import type { GitRepository, GitSnapshot, UserIntent } from './contracts.js'
import { readJson, readText } from './journal.js'
import { Id } from './protocol.js'

/** Read a specific input when its AI asks to act on it. The watcher does not call this. */
export async function readIntent(repo: GitRepository, snapshot: GitSnapshot, participant: string, id: string): Promise<UserIntent | undefined> {
  const input = await readJson<UserIntent & { textPath?: string }>(repo, snapshot, 'dss-coop/intents/' + participant + '/' + Id.parse(id) + '.json')
    ?? await readJson<UserIntent & { textPath?: string }>(repo, snapshot, 'dss-coop/inputs/' + participant + '/' + Id.parse(id) + '.json')
  if (!input) return
  return { ...input, text: typeof input.text === 'string' ? input.text : input.textPath ? await readText(repo, snapshot, input.textPath) : '' }
}
