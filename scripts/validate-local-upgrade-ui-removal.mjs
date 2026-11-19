import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const source = name => readFile(new URL('../' + name, import.meta.url), 'utf8')
const [client, contracts, page, status, transport] = await Promise.all([
  'src/client.tsx', 'src/framework/client-contracts.ts', 'src/framework/client-page.tsx',
  'src/framework/client-upgrade-status.ts', 'src/framework/transport.ts',
].map(source))
let checks = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++ }
for (const text of [client, contracts, page, status, transport]) {
  check(/keepCurrentLocalUpgradeTarget|FrameworkLocalUpgradeStatus|\bLocalUpgradeStatus\b|\blocalUpgrade\b/u.test(text), false)
}
check(/keep-current-with-original-unexported|keep-retained-stage-without-cleanup/u.test(page + status), false)
// Only the dedicated Local conversion endpoint is gone. Ordinary maintenance,
// record movement, history and Git legacy-task operations remain on transport.
const methodLiteral = transport.match(/const methods = (\[[^\n]+\]) as const/u)?.[1]
assert(methodLiteral)
const methods = JSON.parse(methodLiteral.replaceAll("'", '"'))
for (const method of ['maintenanceView', 'openMaintenancePath', 'moveRecords', 'abandonRecordMove',
  'exportRecords', 'history', 'send', 'configure', 'taskControl', 'legacyRecords', 'legacyControl']) {
  check(methods.includes(method), true)
  check(contracts.includes(method + '(') || contracts.includes(method + '?('), true)
}
check(page.includes('<RecordMovePanel'), true)
check(page.includes('<OriginalTaskReadStatus'), true)
check(contracts.includes("originalTaskRead?: 'loading' | 'failed'"), true)
check(contracts.includes("originalSource?: 'local-sql'"), true)
// Execute the retained read-only status component, not just source matching.
const js = stripTypeScriptTypes(status.replace("import * as React from 'react'", ''), { mode: 'transform' })
const OriginalTaskReadStatus = new Function('React', js.replace('export function ', 'function ') + '; return OriginalTaskReadStatus')(React)
const tr = (_cn, en) => en
check(renderToStaticMarkup(React.createElement(OriginalTaskReadStatus, { tr })), '')
for (const state of ['loading', 'failed']) {
  const html = renderToStaticMarkup(React.createElement(OriginalTaskReadStatus, { status: state, tr }))
  check(html.includes('role="status"'), true)
  check(html.includes('<button'), false)
  check(html.toLowerCase().includes('converted tasks'), true)
}
console.log(JSON.stringify({ passed: true, checks, scope: 'Dedicated Local upgrade UI/API removal; preserved transport names and rendered read-only history status' }))
