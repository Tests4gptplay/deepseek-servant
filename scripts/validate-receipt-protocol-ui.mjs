import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSync, transformSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Compile the actual TSX component and exercise its rendered button handlers.
// State, API and primitive rendering are controlled; no Native or DSH UI claim.
// Error formatting/reporting uses the current production module, not a text shim.
const errorModule = { exports: {} }
const errorCode = buildSync({ entryPoints: [fileURLToPath(new URL('../src/framework/client-error.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22' }).outputFiles[0].text
new Function('module', errorCode)(errorModule)
const { frameworkErrorText, installClientErrorReporter } = errorModule.exports
const reportedErrors = []
const stopReporting = installClientErrorReporter(error => reportedErrors.push(error))
const source = readFileSync(new URL('../src/framework/manual-cleanup-panel.tsx', import.meta.url), 'utf8')
const compiled = transformSync(source.replace(/^import .*\n/gm, ''), { loader: 'tsx', format: 'cjs', jsxFactory: 'h' }).code
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const module = { exports: {} }
const state = []
let cursor = 0
const useState = initial => {
  const index = cursor++
  if (!(index in state)) state[index] = initial
  return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
}
new Function('module', 'h', 'useState', 'Button', 'css', 'frameworkErrorText', compiled)(
  module, h, useState, function Button() {}, { section: 'section' }, frameworkErrorText)
const { ManualCleanupPanel } = module.exports
const selection = {
  kind: 'conversation', scope: 'local-choice',
  messageIds: [{ id: 'original-message', path: 'conversations/local/c/message/entry.json' }],
  processGroupIds: [], foreground: { executionId: 'original-run', sessionId: 'original-session', generation: 1 },
  processSessionIds: ['original-session'], wakeKeys: [], pendingTasks: [],
}
const calls = []
let failNextClear = true
const apiFailure = new Error('controlled API failure')
const api = {
  async cleanupPreview(input) {
    calls.push({ type: 'preview', input })
    assert.equal(input.action, 'conversation')
    return selection
  },
  async cleanupRecords(input) {
    calls.push({ type: 'clear', input })
    if (failNextClear) { failNextClear = false; throw apiFailure }
    return { cleared: true, preservedPaths: [], deletedPaths: [], receipt: { revision: 'complete', replay: true } }
  },
}
const render = () => {
  cursor = 0
  return ManualCleanupPanel({ api, storageScope: 'local-choice', tr: (_cn, en) => en,
    changed: async () => { calls.push({ type: 'changed' }) } })
}
const nodes = tree => tree === null || tree === undefined || typeof tree === 'boolean' ? []
  : Array.isArray(tree) ? tree.flatMap(nodes)
  : typeof tree === 'object' ? [tree, ...tree.props.children.flatMap(nodes)] : []
const text = tree => tree === null || tree === undefined || typeof tree === 'boolean' ? ''
  : Array.isArray(tree) ? tree.map(text).join('')
  : typeof tree === 'object' ? tree.props.children.map(text).join('') : String(tree)
const button = (tree, label) => {
  const match = nodes(tree).find(node => typeof node.type === 'function' && text(node) === label)
  assert.ok(match, `rendered button: ${label}`)
  return match
}
const flush = () => new Promise(resolve => setImmediate(resolve))

let tree = render()
button(tree, 'Clear Foreground conversation').props.onClick()
await flush()
tree = render()
assert.deepEqual(calls.map(call => call.type), ['preview'])
assert.match(text(tree), /Clears only this selected Foreground conversation/)
assert.match(text(tree), /If its original execution is still running, it is stopped and its final output is collected/)
assert.match(text(tree), /Later messages, background tasks, List and Cache remain/)
assert.match(text(tree), /1 selected conversation messages/)
button(tree, 'Confirm cleanup').props.onClick()
await flush()
tree = render()
assert.deepEqual(calls.map(call => call.type), ['preview', 'clear'])
assert.equal(calls[1].input.preview, selection)
assert.equal(calls[1].input.confirmation, 'clear-foreground-conversation')
assert.ok(calls[1].input.commandId)
assert.equal(reportedErrors.length, 1)
assert.equal(reportedErrors[0], apiFailure)
assert.equal(text(tree).includes(apiFailure.message), false)
assert.ok(text(tree).includes('Retry this same operation if its outcome is unknown'))
button(tree, 'Confirm cleanup').props.onClick()
await flush()
tree = render()
assert.deepEqual(calls.map(call => call.type), ['preview', 'clear', 'clear', 'changed'])
assert.equal(calls[2].input.preview, selection)
assert.equal(calls[2].input.commandId, calls[1].input.commandId)
assert.equal(calls[2].input.storageScope, 'local-choice')
assert.ok(text(tree).includes('Cleanup finished'))
assert.equal(nodes(tree).some(node => text(node) === 'Confirm cleanup'), false)
stopReporting()
console.log(JSON.stringify({ status: 'passed', assertions: 19,
  scope: 'Actual compiled TSX handlers and current error module/reporter; controlled API/state, Button and virtual tree. API rejection checks the existing UI contract, not a reproduced backend fault. No Native, browser, SDK or full React lifecycle.' }))
