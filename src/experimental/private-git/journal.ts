import { createHash } from 'node:crypto'
import type { GitChange, GitReceipt, GitRepository, GitSnapshot } from './contracts.js'
import { GitConflictError } from './github.js'

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
export const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'
export function segment(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid record identity.')
  return id
}
export interface TextManifest { version: 1; sha256: string; characters: number; chunks: string[] }
export function textChanges(path: string, text: string): GitChange[] {
  const changes: GitChange[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 65_536, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    changes.push({ path: path + '/parts/' + changes.length.toString().padStart(6, '0') + '.txt', content: text.slice(start, end) })
    start = end
  }
  const manifest: TextManifest = { version: 1, sha256: digest(text), characters: text.length, chunks: changes.map(change => change.path) }
  return [...changes, { path: path + '/manifest.json', content: json(manifest) }]
}
export async function readJson<T>(repo: GitRepository, snapshot: GitSnapshot, path: string): Promise<T | undefined> {
  const text = await repo.read(snapshot, path)
  return text === undefined ? undefined : JSON.parse(text) as T
}
export async function readText(repo: GitRepository, snapshot: GitSnapshot, path: string): Promise<string> {
  const manifest = await readJson<TextManifest>(repo, snapshot, path + '/manifest.json')
  if (!manifest || manifest.version !== 1) throw new Error('Missing text manifest: ' + path)
  const parts: string[] = []
  for (const chunk of manifest.chunks) {
    if (!chunk.startsWith(path + '/parts/') || chunk.includes('..') || chunk.includes('\\')) throw new Error('Invalid text chunk reference: ' + chunk)
    const text = await repo.read(snapshot, chunk)
    if (text === undefined) throw new Error('Missing text chunk: ' + chunk)
    parts.push(text)
  }
  const text = parts.join('')
  if (text.length !== manifest.characters || digest(text) !== manifest.sha256) throw new Error('Text record integrity mismatch: ' + path)
  return text
}

/** Builds directly against confirmed Git; a successful write never dispatches an Agent. */
export class GitJournal {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(readonly repo: GitRepository, readonly participantId: string) { segment(participantId) }
  transact(id: string, request: unknown, build: (snapshot: GitSnapshot) => Promise<readonly GitChange[]>): Promise<GitReceipt> {
    segment(id)
    const execute = async (): Promise<GitReceipt> => {
      const receiptPath = 'dss-coop/events/' + this.participantId + '/' + id + '.json'
      const requestHash = digest(JSON.stringify(request))
      for (let attempt = 0; attempt < 4; attempt++) {
        const snapshot = await this.repo.snapshot()
        const receipt = await readJson<{ requestHash: string }>(this.repo, snapshot, receiptPath)
        if (receipt) {
          if (receipt.requestHash !== requestHash) throw new Error('The operation identity was reused for different input.')
          return { commit: snapshot.head, replay: true }
        }
        const changes = await build(snapshot)
        try {
          return await this.repo.commit(snapshot, [...changes, { path: receiptPath, content: json({ id, participantId: this.participantId, requestHash }) }], 'DSS coop: ' + id)
        } catch (error) {
          if (!(error instanceof GitConflictError) || attempt === 3) throw error
        }
      }
      throw new GitConflictError()
    }
    const result = this.pending.then(execute, execute)
    this.pending = result.catch(() => {})
    return result
  }
  async immutable(snapshot: GitSnapshot, path: string, content: string): Promise<GitChange[]> {
    const previous = await this.repo.read(snapshot, path)
    if (previous === undefined) return [{ path, content }]
    if (previous !== content) throw new Error('An immutable Git record already has different content: ' + path)
    return []
  }
}
