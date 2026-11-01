import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { historicalBaseline } from './test-suites.mjs'
const root = process.cwd()
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`)
}
const available = spawnSync('git', ['cat-file', '-e', historicalBaseline + '^{commit}'], { stdio: 'ignore' })
if (available.status !== 0) throw new Error(`Historical baseline ${historicalBaseline} is unavailable locally. Provide the existing Git history (CI checkout fetch-depth: 0); this command never fetches from the network.`)
await mkdir('.validation', { recursive: true })
const directory = await mkdtemp(resolve('.validation/historical-'))
const archive = resolve(directory, 'baseline.tar')
run('git', ['archive', '--format=tar', '--output=' + archive, historicalBaseline])
run('tar', ['-xf', archive, '-C', directory])
// The historical tree owns its source, prompts, runner and test discovery. Installed
// packages are shared explicitly; this is not a second dependency installation.
await symlink(resolve(root, 'node_modules'), resolve(directory, 'node_modules'), 'dir')
await writeFile(resolve(directory, 'historical-run.json'), JSON.stringify({ baseline: historicalBaseline, node: process.version, dependencies: resolve(root, 'node_modules'), source: 'git archive; no current source overlays' }, null, 2) + '\n')
console.log(`Historical source/tests: ${historicalBaseline}\nIsolated tree: ${directory}\nDependencies: current installed node_modules (not a historical lockfile reinstall).`)
const result = spawnSync(process.execPath, ['scripts/test.mjs'], { cwd: directory, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
