import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { mergeSkillText } from '../src/framework/skill-merge.js'

const document = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}\n`).join('')

test('large divergent skill edits stop at the merge work budget', () => {
  const base = document('base', 5_000)
  const proposed = document('proposed', 5_000)
  const current = document('current', 5_000)
  const started = performance.now()
  const result = mergeSkillText(base, proposed, current)
  const elapsedMs = performance.now() - started

  assert.deepEqual(result, { merged: false, reason: 'merge-budget-exceeded', conflicts: [] })
  assert.ok(elapsedMs < 1_000, `merge budget check took ${elapsedMs.toFixed(1)} ms`)
})

test('unbalanced Hirschberg recursion shares the actual work budget', () => {
  const base = document('base', 9)
  const proposed = document('proposed', 200_000)
  const current = base + 'current-tail\n'

  assert.deepEqual(mergeSkillText(base, proposed, current), {
    merged: false,
    reason: 'merge-budget-exceeded',
    conflicts: [],
  })
})

test('conflict text materialization cannot amplify input past its character budget', () => {
  const padding = 'x'.repeat(200)
  const base = Array.from({ length: 256 }, (_, index) => `base-${index}:${padding}\n`).join('')
  const proposed = Array.from({ length: 256 }, (_, index) => `proposed-${index}:${padding}\n`).join('')
  const current = Array.from({ length: 256 }, (_, index) =>
    `${index % 2 ? 'base' : 'current'}-${index}:${padding}\n`).join('')

  assert.deepEqual(mergeSkillText(base, proposed, current), {
    merged: false,
    reason: 'merge-budget-exceeded',
    conflicts: [],
  })
})

test('small overlapping edits still report their exact conflict text', () => {
  assert.deepEqual(mergeSkillText('title\nbase\ntail\n', 'title\nproposal\ntail\n', 'title\ncurrent\ntail\n'), {
    merged: false,
    reason: 'overlapping-edits',
    conflicts: [{ baseStartLine: 2, baseEndLine: 2, base: 'base\n', proposed: 'proposal\n', current: 'current\n' }],
  })
})

test('small independent skill edits retain both contributions', () => {
  const base = 'title\nalpha\nmiddle\nomega\ntail\n'
  const proposed = 'title\nalpha from proposal\nmiddle\nomega\ntail\n'
  const current = 'title\nalpha\nmiddle\nomega from current\ntail\n'

  assert.deepEqual(mergeSkillText(base, proposed, current), {
    merged: true,
    text: 'title\nalpha from proposal\nmiddle\nomega from current\ntail\n',
  })
})
