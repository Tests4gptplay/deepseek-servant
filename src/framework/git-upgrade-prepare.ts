import { createHash, randomUUID } from 'node:crypto'
import { gitUpgradeWakePath, parseGitUpgradeWake, type GitUpgradeWake } from './git-startup-upgrade-agent.js'
import { readLegacySkillSource } from './legacy-skill-source.js'
import type { FilesSnapshot, FilesStore } from './transactions.js'
import type { FrameworkTransactions } from './command-transactions.js'
interface Preparation { status: 'existing' | 'prepared' | 'no-originals'; wake: GitUpgradeWake; issues: Array<{ path: string; reason: string }> }
/** Called only with the package's observed one-time startup signal. The snapshot
 * belongs to the already authorized Git Files root, never a guessed repository. */
export async function prepareGitUpgradeWake(files: FilesStore, snapshot: FilesSnapshot, operationId: string, signal: AbortSignal): Promise<Preparation> {
  signal.throwIfAborted()
  const current = await files.read(snapshot, gitUpgradeWakePath)
  if (current !== undefined) return { status: 'existing', wake: parseGitUpgradeWake(current), issues: [] }
  const entries = await files.list(snapshot, 'skills', { names: ['record.json', 'legacy-git.json'] })
  const folders = new Map<string, Array<{ path: string; sha256: string }>>(), issues: Preparation['issues'] = []
  for (const entry of entries) {
    signal.throwIfAborted()
    if (!/^skills\/(?:[^/\\\0\r\n]+\/)+(?:record\.json|legacy-git\.json)$/.test(entry.path)) continue
    const bytes = await files.readBytes(snapshot, entry.path)
    if (bytes === undefined) throw new Error('Listed original is unavailable in this exact snapshot: ' + entry.path)
    const folder = entry.path.slice(0, entry.path.lastIndexOf('/') + 1), originals = folders.get(folder) ?? []
    originals.push({ path: entry.path, sha256: createHash('sha256').update(bytes).digest('hex') }); folders.set(folder, originals)
    try { readLegacySkillSource(entry.path, new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
    catch (error) { issues.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) }) }
  }
  const pending = [...folders].sort(([a], [b]) => a.localeCompare(b)).map(([folder, originals]) => ({
    sourcePath: originals.some(row => row.path === folder + 'record.json') ? folder + 'record.json' : folder + 'legacy-git.json',
    originals: originals.sort((a, b) => a.path.localeCompare(b.path)) }))
  const wake = parseGitUpgradeWake(JSON.stringify({ version: 1, kind: 'dss-g09-git-skills', operationId, nativeSessions: [], pending }))
  return { status: pending.length ? 'prepared' : 'no-originals', wake, issues }
}
class GitWakeObserved extends Error { constructor(readonly preparation: Preparation) { super('Existing wake or no originals observed; no preparation publication was submitted.') } }
export async function ensureGitUpgradeWake(files: FilesStore, transactions: FrameworkTransactions, signal: AbortSignal): Promise<Preparation> {
  const operationId = randomUUID(); let result: Preparation | undefined
  try { await transactions.runFinalization('g09:prepare:' + operationId, { operationId },
    { reevaluate: true, readPlan: { signal }, beforeAttempt: () => signal.throwIfAborted() }, async snapshot => {
      result = await prepareGitUpgradeWake(files, snapshot, operationId, signal)
      if (result.status !== 'prepared') throw new GitWakeObserved(result)
      return [{ path: gitUpgradeWakePath, content: JSON.stringify(result.wake, null, 2) + '\n' }]
    }, async snapshot => {
      const text = await files.read(snapshot, gitUpgradeWakePath)
      return text !== undefined && parseGitUpgradeWake(text).operationId === operationId
    }) } catch (error) { if (error instanceof GitWakeObserved) return error.preparation; throw error }
  if (!result) throw new Error('Git startup preparation has no confirmed observation.')
  return result
}
