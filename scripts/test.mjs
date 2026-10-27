import { build } from 'esbuild'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
await mkdir('.validation', { recursive: true })
const names = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).sort()
const roleTexts = Object.fromEntries(await Promise.all(['foreground', 'planner', 'worker'].map(async role => [role, await readFile('src/roles/' + role + '.md', 'utf8')])))
const coopRoleTexts = Object.fromEntries(await Promise.all(['foreground', 'planner', 'worker'].map(async role => [role, await readFile('src/experimental/private-git/prompts/' + role + '.md', 'utf8')])))
for (const name of names) await build({ entryPoints: ['tests/' + name], bundle: true,
  outfile: '.validation/' + name.replace(/\.ts$/, '.mjs'), platform: 'node', format: 'esm', packages: 'external', target: 'node24', define: { __SERVANT_ROLE_TEXTS__: JSON.stringify(roleTexts), __COOP_ROLE_TEXTS__: JSON.stringify(coopRoleTexts) } })
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...names.map(name => '.validation/' + name.replace(/\.ts$/, '.mjs'))], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
