import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// SDK dependencies must already exist at the explicitly selected Host root.
// The ordinary project SDK loader checks it; this runner installs nothing.
const root = await mkdtemp(join(tmpdir(), 'dss-workspace-switch-suite-'))
const tests = [
  'creation-binding.test.mjs',
  'binding-lifecycle.test.mjs',
  'switch-lifecycle.test.mjs',
  'save-targets.test.mjs',
].map(name => fileURLToPath(new URL('./test-support/workspace-switch/' + name, import.meta.url)))
console.log('Workspace switch: 52 current-design checks. Historical workspace output is covered separately by validate-history-workspace-reference.mjs. Evidence goes to stdout; no output file is retained by default.')
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', new URL('./test-support/dsh-sdk-runtime.mjs', import.meta.url).href,
      '--test', ...tests,
    ], {
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (result.signal) throw new Error('Workspace-switch checks ended by signal: ' + result.signal)
  process.exitCode = result.code ?? 1
} finally {
  // Own the whole child fixture tree as well as each suite's normal cleanup.
  // A failing test/close or dependency-loading error cannot retain that tree.
  await rm(root, { recursive: true, force: true })
}
