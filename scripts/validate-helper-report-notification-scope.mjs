import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const deps = await import('./test-support/dsh-sdk-runtime.mjs')
const { Context } = await import('@deepseek-ai/cordis')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')

// Real installed SDK ToolRuntime.execute -> registered DSS tools -> actual Linux
// physical files. Session event storage/flush is explicitly controlled; no model,
// full Host, Windows or remote Git run is claimed. Boundary names test an existing
// ordinary-write entry, not a reason to introduce any product gate.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-helper-notify-scope-'))
const observations = [], failures = []
const read = async (files, file) => {
  const snapshot = await files.snapshot()
  try { return await files.read(snapshot, file) } finally { await snapshot.release() }
}
async function fixture(name, action) {
  const files = new PhysicalLocalFiles(path.join(scratch, name))
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  const events = [], errors = [], agent = { id: 'helper-agent-' + name, session: { snapshotEvents: () => events } }
  let flushes = 0, calls = 0
  ctx.provide('sessions', { flush: async session => { assert.equal(session, agent.session); flushes++ } })
  const scope = createScope(ctx, agent)
  installFrameworkRoleTools(scope.ctx, agent,
    { role: 'Helper', owner: 'A', workId: 'helper-work-' + name, executionId: 'helper-execution-' + name },
    { files, transact: async () => { throw Error('Unexpected generic transaction') }, notifications: async () => [],
      claimNotifications: async () => ({ signals: [] }), onError: error => errors.push(error) })
  const call = async (tool, input) => {
    const callId = name + '-' + ++calls
    events.push({ type: 'tool/call', data: { name: tool, callId, arguments: JSON.stringify(input) } })
    const result = await ctx.tools.execute({ name: tool, arguments: input, agent, callId, signal: new AbortController().signal })
    if (result.isError) throw new Error(result.error?.message ?? JSON.stringify(result))
    return result.value
  }
  try {
    await action({ files, call, flushes: () => flushes })
    assert.deepEqual(errors, [])
    observations.push({ case: name, status: 'passed', sdkToolDispatches: calls, nativeSessionFlushes: flushes })
  } catch (error) {
    failures.push({ case: name, name: error.name, message: error.message })
    observations.push({ case: name, status: 'failed', sdkToolDispatches: calls, nativeSessionFlushes: flushes })
  } finally { await scope.dispose(); await files.close() }
}
try {
  for (const [name, basename, option, append] of [
    ['notify-omitted-append', 'a'.repeat(240) + '.md', {}, true],
    ['notify-false-append', '实'.repeat(80) + '.md', { notifyForeground: false }, true],
    ['notify-false-replace', 'r'.repeat(240) + '.md', { notifyForeground: false }, false],
  ]) {
    await fixture(name, async ({ files, call, flushes }) => {
      const report = 'debug/helper-reports/' + basename
      const initial = 'Original facts\r\n', text = 'New actual findings 多语言😀\n'
      // Establish file availability by an actual write, not an assumed generic
      // 255-character/byte filesystem rule. No notification is requested.
      await files.replace(report, initial)
      assert.equal(await read(files, report), initial)
      const view = await call('dss_snapshot', {})
      await call('dss_record', { snapshotId: view.snapshotId, path: report, text, append, ...option })
      assert.equal(await read(files, report), append ? initial + text : text)
      assert.equal(flushes(), 0)
      const snapshot = await files.snapshot()
      try {
        assert.deepEqual(await files.listDirectory(snapshot, 'state'), [])
        assert.deepEqual(await files.listDirectoryNames(snapshot, 'debug/.helper-publications'), [])
      } finally { await snapshot.release() }
      observations.push({ case: name, reportNameBytes: Buffer.byteLength(basename), unusedSignalNameBytes: Buffer.byteLength('Foreground_Helper_Report_' + basename), originalWritten: true, completeTextPreserved: true, noSignal: true, noCompoundPublication: true })
    })
  }
  await fixture('short-explicit-notification', async ({ files, call, flushes }) => {
    const report = 'debug/helper-reports/actual-findings.md', text = 'Actual requested notice\n'
    const view = await call('dss_snapshot', {})
    await call('dss_record', { snapshotId: view.snapshotId, path: report, text, append: false, notifyForeground: true })
    assert.equal(await read(files, report), text)
    assert.equal(await read(files, 'state/Foreground_Helper_Report_actual-findings.md'), '')
    assert.equal(flushes(), 1)
  })
  const result = { status: failures.length ? 'failed' : 'passed', cases: 4, observations, failures,
    ...deps.evidence(), scriptHash: deps.hash(readFileSync(fileURLToPath(import.meta.url))),
    limits: 'Actual installed Cordis/SystemPrompt/ToolRuntime with production DSS registration, real schemas and Linux physical files. Agent/session event storage and flush are controlled. No model, complete Host, Windows or remote Git behavior claimed. No assertion endorses a universal 255-byte filename limit.' }
  const output = process.env.DSS_HELPER_REPORT_EVIDENCE_OUTPUT
  if (output) await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  if (failures.length) process.exitCode = 1
} finally { await fs.rm(scratch, { recursive: true, force: true }); deps.hooks.deregister() }
