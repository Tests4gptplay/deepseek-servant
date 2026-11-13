import { createHash, randomUUID } from 'node:crypto'
import { filePath, type FileChange, type FilesSnapshot, type FilesStore } from './transactions.js'
import { withReevaluatedFileTarget } from './file-read-observation.js'

export interface SkillReadBase { id: string; path: string; revision: string; text: string | null }
export interface SkillCreationBase { path: string; revision: string; text: null; kind: 'creation-precondition' }
export type SkillMergeBase = SkillReadBase | SkillCreationBase
export const isSkillFile = (path: string): boolean => path.startsWith('skills/') && path.split('/').length >= 3
export const skillTextHash = (text: string | null): string | null => text === null ? null : createHash('sha256').update(text).digest('hex')

/** Only complete text actually returned to this Agent is eligible. Never filled
 * by a catalog scan, an internal native projection read, or save-time snapshot.
 * Read views can close without discarding their already-delivered bytes. */
export class SkillReadBases {
  private readonly reads = new Map<string, SkillReadBase>()
  private readonly latest = new Map<string, string>()
  remember(path: string, revision: string, text: string | null): SkillReadBase {
    filePath(path)
    if (!isSkillFile(path)) throw new Error('A skill read baseline must identify an exact skill file.')
    const prior = this.resolve(path)
    if (prior?.revision === revision && prior.text === text) return prior
    const value = Object.freeze({ id: randomUUID(), path, revision, text })
    this.reads.set(value.id, value); this.latest.set(path, value.id)
    return value
  }
  resolve(path: string, id?: string): SkillReadBase | undefined {
    const value = this.reads.get(id ?? this.latest.get(path) ?? '')
    return value?.path === path ? value : undefined
  }
  clear(): void { this.reads.clear(); this.latest.clear() }
}

interface Edit { start: number; end: number; lines: string[] }
export interface SkillMergeRegion { baseStartLine: number; baseEndLine: number; base: string; proposed: string; current: string }
export type SkillTextMerge = { merged: true; text: string } | { merged: false; reason: 'overlapping-edits' | 'delete-modify' | 'concurrent-create'; conflicts: SkillMergeRegion[] }
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
const sameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, index) => line === b[index])

/** Exact Hirschberg LCS. Only linear rows are retained, so file size is not
 * a business conflict. Ties consistently choose the earliest next-side split.
 * Every emitted edit still refers to the original base, including newlines. */
function edits(base: readonly string[], next: readonly string[]): Edit[] {
  let prefix = 0, suffix = 0
  while (prefix < base.length && prefix < next.length && base[prefix] === next[prefix]) prefix++
  while (suffix < base.length - prefix && suffix < next.length - prefix && base[base.length - suffix - 1] === next[next.length - suffix - 1]) suffix++
  const aEnd = base.length - suffix, bEnd = next.length - suffix
  const row = (aStart: number, aEnd: number, bStart: number, bEnd: number, reverse: boolean): Uint32Array => {
    const width = bEnd - bStart, lengths = new Uint32Array(width + 1)
    for (let i = 0; i < aEnd - aStart; i++) {
      let diagonal = 0
      for (let j = 1; j <= width; j++) {
        const previous = lengths[j]!
        lengths[j] = base[reverse ? aEnd - i - 1 : aStart + i] === next[reverse ? bEnd - j : bStart + j - 1]
          ? diagonal + 1 : Math.max(previous, lengths[j - 1]!)
        diagonal = previous
      }
    }
    return lengths
  }
  // Return only the split, so neither DP row is retained by recursive frames.
  const split = (aStart: number, middle: number, aEnd: number, bStart: number, bEnd: number): number => {
    const left = row(aStart, middle, bStart, bEnd, false), right = row(middle, aEnd, bStart, bEnd, true)
    let best = -1, at = 0
    for (let j = 0; j <= bEnd - bStart; j++) {
      const length = left[j]! + right[bEnd - bStart - j]!
      if (length > best) { best = length; at = j }
    }
    return bStart + at
  }
  const result: Edit[] = []
  let cursorA = prefix, cursorB = prefix
  const match = (i: number, j: number) => {
    if (i > cursorA || j > cursorB) result.push({ start: cursorA, end: i, lines: next.slice(cursorB, j) })
    cursorA = i + 1; cursorB = j + 1
  }
  const visit = (aStart: number, aEnd: number, bStart: number, bEnd: number): void => {
    if (aStart === aEnd || bStart === bEnd) return
    if (aEnd - aStart === 1) {
      for (let j = bStart; j < bEnd; j++) if (base[aStart] === next[j]) { match(aStart, j); break }
      return
    }
    const middle = aStart + Math.floor((aEnd - aStart) / 2), at = split(aStart, middle, aEnd, bStart, bEnd)
    visit(aStart, middle, bStart, at); visit(middle, aEnd, at, bEnd)
  }
  visit(prefix, aEnd, prefix, bEnd)
  if (cursorA < aEnd || cursorB < bEnd) result.push({ start: cursorA, end: aEnd, lines: next.slice(cursorB, bEnd) })
  return result
}
const overlaps = (a: Edit, b: Edit): boolean => {
  if (a.start === a.end && b.start === b.end) return a.start === b.start
  // An insertion exactly at a replacement boundary is not independently
  // orderable without judging the text. Preserve it for explicit resolution.
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end
  return a.start < b.end && b.start < a.end
}
const apply = (base: readonly string[], changes: readonly Edit[], start = 0, end = base.length): string => {
  const result: string[] = []; let cursor = start
  for (const change of changes) { result.push(base.slice(cursor, change.start).join(''), change.lines.join('')); cursor = change.end }
  result.push(base.slice(cursor, end).join('')); return result.join('')
}
export function mergeSkillText(baseText: string | null, proposed: string, current: string | null): SkillTextMerge {
  if (current === proposed) return { merged: true, text: proposed }
  if (current === baseText) return { merged: true, text: proposed }
  if (baseText === null || current === null) return { merged: false,
    reason: baseText === null ? 'concurrent-create' : 'delete-modify', conflicts: [] }
  if (proposed === baseText) return { merged: true, text: current }
  const base = lines(baseText), own = edits(base, lines(proposed)), published = edits(base, lines(current))
  const duplicates = new Set<Edit>(), conflicts: SkillMergeRegion[] = []
  for (const left of own) for (const right of published) {
    if (left.start === right.start && left.end === right.end && sameLines(left.lines, right.lines)) { duplicates.add(left); continue }
    if (!overlaps(left, right)) continue
    const start = Math.min(left.start, right.start), end = Math.max(left.end, right.end)
    conflicts.push({ baseStartLine: start + 1, baseEndLine: end,
      base: base.slice(start, end).join(''), proposed: apply(base, [left], start, end), current: apply(base, [right], start, end) })
  }
  if (conflicts.length) return { merged: false, reason: 'overlapping-edits', conflicts }
  const combined = [...published, ...own.filter(edit => !duplicates.has(edit))].sort((a, b) => a.start - b.start || a.end - b.end)
  return { merged: true, text: apply(base, combined) }
}

export interface SkillProposal { path: string; text: string; baseReadId?: string }
export interface SkillMergeIssue {
  path: string; reason: 'current-read-required' | 'current-not-text' | Exclude<SkillTextMerge, { merged: true }>['reason']
  baseReadId?: string; baseRevision?: string; baseKind?: 'complete-read' | 'creation-precondition'; currentRevision: string
  base: string | null; proposed: string; current: string | null; currentExists: boolean; currentSha256: string | null; currentBytes: number; conflicts: SkillMergeRegion[]
}
export class SkillMergeRequired extends Error {
  constructor(readonly issues: SkillMergeIssue[]) { super('Read current skill contents to establish editing intent, or merge the reported overlapping contributions.'); this.name = 'SkillMergeRequired' }
}
/** The caller freezes selected bases for a logical save. A CAS retry recomputes
 * against latest cumulative authority with the same original proposal/base. */
export async function mergeSkillProposals(files: FilesStore, snapshot: FilesSnapshot,
  proposals: readonly SkillProposal[], bases: Map<string, SkillMergeBase | undefined>): Promise<FileChange[]> {
  const changes: FileChange[] = [], issues: SkillMergeIssue[] = []
  for (const proposal of proposals) {
    let base = bases.get(proposal.path)
    await withReevaluatedFileTarget(snapshot, proposal.path, async () => {
      const bytes = await files.readBytes(snapshot, proposal.path)
      // New publication is create-if-absent. This is a frozen creation
      // precondition, explicitly NOT an AI read. If a peer creates the file,
      // the next CAS evaluation compares that new content with null.
      if (!base && proposal.baseReadId === undefined && bytes === undefined) {
        base = { path: proposal.path, revision: snapshot.revision, text: null, kind: 'creation-precondition' }
        bases.set(proposal.path, base)
      }
      let current: string | null = null, invalid = false
      if (bytes !== undefined) try { current = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); invalid = current.includes('\0') } catch { invalid = true }
      const merged = invalid ? undefined : current === proposal.text ? { merged: true as const, text: current }
        : base ? mergeSkillText(base.text, proposal.text, current) : undefined
      if (!merged?.merged) issues.push({ path: proposal.path,
        reason: invalid ? 'current-not-text' : !base ? 'current-read-required' : merged!.reason,
        ...(base ? { ...('id' in base ? { baseReadId: base.id, baseKind: 'complete-read' as const } : { baseKind: 'creation-precondition' as const }), baseRevision: base.revision } : {}), currentRevision: snapshot.revision,
        base: base?.text ?? null, proposed: proposal.text, current, currentExists: bytes !== undefined,
        currentSha256: bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex'), currentBytes: bytes?.byteLength ?? 0, conflicts: merged && !merged.merged ? merged.conflicts : [] })
      else if (merged.text !== current) changes.push({ path: proposal.path, content: merged.text })
    })
  }
  if (issues.length) throw new SkillMergeRequired(issues)
  return changes
}

/** Physical publication coordinates only this actual skill file. Full reads
 * delivered to the Recorder remain its editing baseline; catalog projections
 * and save-time reads never become an implicit replacement baseline. */
export async function publishPhysicalSkillProposal(files: import('./physical-local-files.js').PhysicalLocalFiles,
  proposal: SkillProposal, base?: SkillMergeBase, signal?: AbortSignal): Promise<{ changed: boolean }> {
  filePath(proposal.path)
  if (!isSkillFile(proposal.path)) throw new Error('Choose an exact skill file.')
  return files.update(proposal.path, bytes => {
    const selected = base ?? (proposal.baseReadId === undefined && bytes === undefined
      ? { path: proposal.path, revision: 'physical-creation', text: null, kind: 'creation-precondition' as const } : undefined)
    let current: string | null = null, invalid = false
    if (bytes !== undefined) try { current = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); invalid = current.includes('\0') } catch { invalid = true }
    const merged = invalid ? undefined : current === proposal.text ? { merged: true as const, text: current }
      : selected ? mergeSkillText(selected.text, proposal.text, current) : undefined
    if (!merged?.merged) throw new SkillMergeRequired([{ path: proposal.path,
      reason: invalid ? 'current-not-text' : !selected ? 'current-read-required' : merged!.reason,
      ...(selected ? { ...('id' in selected ? { baseReadId: selected.id, baseKind: 'complete-read' as const } : { baseKind: 'creation-precondition' as const }), baseRevision: selected.revision } : {}),
      currentRevision: 'physical-current-file', base: selected?.text ?? null, proposed: proposal.text, current,
      currentExists: bytes !== undefined, currentSha256: bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex'), currentBytes: bytes?.byteLength ?? 0,
      conflicts: merged && !merged.merged ? merged.conflicts : [],
    }])
    return { value: { changed: merged.text !== current }, ...(merged.text !== current ? { content: merged.text } : {}) }
  }, signal)
}
