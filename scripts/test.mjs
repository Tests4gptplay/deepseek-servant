import { build } from 'esbuild'
import { mkdir, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { currentSuites, historicalSuites } from './test-suites.mjs'
const present = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).sort()
const classified = [...currentSuites, ...historicalSuites]
if (new Set(classified).size !== classified.length) throw new Error('Duplicate test suite classification.')
const unknown = present.filter(name => !classified.includes(name))
const missing = classified.filter(name => !present.includes(name))
if (unknown.length || missing.length) throw new Error(`Test classification must be explicit. Unclassified: ${unknown.join(', ') || '(none)'}. Missing: ${missing.join(', ') || '(none)'}. Update scripts/test-suites.mjs after reviewing actual imports and assertion ownership.`)
await mkdir('.validation/current', { recursive: true })
console.log(`Current implementation: ${currentSuites.length} suites; ${historicalSuites.length} historical implementation suites retained separately. No failure-based exclusion.`)
for (const name of currentSuites) await build({ entryPoints: ['tests/' + name], bundle: true,
  outfile: '.validation/current/' + name.replace(/\.ts$/, '.mjs'), platform: 'node', format: 'esm', packages: 'external', target: 'node24' })
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...currentSuites.map(name => '.validation/current/' + name.replace(/\.ts$/, '.mjs'))], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
