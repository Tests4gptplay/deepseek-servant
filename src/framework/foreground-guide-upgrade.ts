import { questionNoteInstruction } from './question-note-prompt.js'
import { createHash } from 'node:crypto'
import { foregroundFullGuide, foregroundStorageRecoveryNote } from './role-prompts.js'
import { foregroundGuideUpgradeRules } from './foreground-guide-upgrade-rules.js'

export const foregroundGuideUpgradeVersion = 'foreground-task-runtime-state-v11'
export interface ForegroundGuideUpgrade {
  text: string
  changedRules: number
  /** Preserved, not inferred to be wrong. Never a role or publication gate. */
  unreviewedSections: string[]
}
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex')
const sentences = (line: string) => line.match(/[\s\S]*?\.(?= |$)|[\s\S]+$/g) ?? []
const heading = '# Foreground wake priority: reply briefly, then act'

/** Migrate only verbatim obsolete sentences inside recognizable generated
 * protocol lines. No semantic guessing, blanket paragraph replacement, hidden
 * fallback, retained old Markdown, or extra runtime read is involved. */
export function upgradeForegroundGuide(text: string): ForegroundGuideUpgrade {
  if (!text) return { text, changedRules: 0, unreviewedSections: [] }
  const currentGuide = foregroundFullGuide()
  // Add the naming suggestion only to the exact previous default, preserving custom guides.
  if (text === currentGuide.replace('Keep task titles concise and prefer short English names when they still make the task recognizable. ', ''))
    return { text: currentGuide, changedRules: 1, unreviewedSections: [] }
  // Only the exact previous official default gains the current question guidance.
  // Custom guide text remains untouched; the current core supplies the same rule.
  const previousQuestionGuide = currentGuide.replace(questionNoteInstruction + '\n', '')
  if (text === previousQuestionGuide || text === previousQuestionGuide.replace('\n\n' + foregroundStorageRecoveryNote, ''))
    return { text: currentGuide, changedRules: 1, unreviewedSections: [] }
  // Only the exact previous official default gains this optional suggestion.
  // A customized guide, including an empty one, keeps every existing byte.
  if (text === currentGuide.replace('\n\n' + foregroundStorageRecoveryNote, ''))
    return { text: currentGuide, changedRules: 1, unreviewedSections: [] }
  // These two independent structural anchors establish template ancestry. A
  // wholly rewritten guide remains authoritative user text, not a template.
  const plain = text.replace(/^\uFEFF/, '')
  const lines = plain.split(/\r?\n/)
  if (!lines.includes(heading) || !lines.some(line => line.startsWith(foregroundGuideUpgradeRules.context.prefix)))
    return { text, changedRules: 0, unreviewedSections: ['custom guide (template ancestry not recognized)'] }
  const currentLines = currentGuide.split('\n')
  const groups = Object.entries(foregroundGuideUpgradeRules).map(([name, definition]) => ({
    name, ...definition, rules: definition.rules as Readonly<Record<string, string>>,
    current: currentLines.find(line => line.startsWith(definition.prefix)),
  }))
  let changedRules = 0, fence: string | undefined, comment = false
  const seen = new Set<string>()
  const unreviewedSections = new Set<string>()
  // Retain each original separator and all untouched text, including BOM,
  // CRLF, Unicode, inline customization and trailing whitespace.
  const migrated = plain.split(/(\r?\n)/).map(line => {
    if (comment || line.includes('<!--')) {
      comment = line.includes('-->') ? line.lastIndexOf('<!--') > line.lastIndexOf('-->') : true
      return line
    }
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line), marker = fenceMatch?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && !fenceMatch![2].trim()) fence = undefined
      return line
    }
    if (fence || !line || /^\s|^>/.test(line)) return line
    const parts = sentences(line), first = parts[0]
    if (!first) return line
    const group = groups.find(group => (group.starts as readonly string[]).includes(fingerprint(first)))
    if (!group) return line
    seen.add(group.name)
    const next = parts.map(part => {
      const leading = /^ */.exec(part)![0], sentence = part.slice(leading.length)
      const replacement = group.rules[fingerprint(sentence)]
      if (replacement === undefined || replacement === sentence) return part
      changedRules++
      return replacement ? leading + replacement : ''
    }).join('')
    if (next !== group.current) unreviewedSections.add(group.name)
    return next
  }).join('')
  for (const group of groups) if (!seen.has(group.name)) unreviewedSections.add(group.name + ' (protocol line not recognized)')
  return { text: (text.startsWith('\uFEFF') ? '\uFEFF' : '') + migrated, changedRules,
    unreviewedSections: [...unreviewedSections] }
}
