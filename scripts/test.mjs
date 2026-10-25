import { build } from 'esbuild'
import { mkdir, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
await mkdir('.validation', { recursive: true })
const names = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).sort()
for (const name of names) await build({ entryPoints: ['tests/' + name], bundle: true,
  outfile: '.validation/' + name.replace(/\.ts$/, '.mjs'), platform: 'node', format: 'esm', packages: 'external', target: 'node24' })
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...names.map(name => '.validation/' + name.replace(/\.ts$/, '.mjs'))], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
