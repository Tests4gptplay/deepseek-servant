import { spawn } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = join(root, 'tests')
const outputDirectory = join(root, '.validation', 'tests')
const entries = (await readdir(sourceDirectory))
  .filter(name => name.endsWith('.test.ts'))
  .sort()
  .map(name => join(sourceDirectory, name))

if (!entries.length) throw new Error('No source regression tests were found.')
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await build({
  entryPoints: entries,
  outdir: outputDirectory,
  outExtension: { '.js': '.mjs' },
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: 'inline',
})

const outputs = entries.map(entry => join(outputDirectory, basename(entry, '.ts') + '.mjs'))
const child = spawn(process.execPath, ['--test', '--test-timeout=30000', ...outputs], { cwd: root, stdio: 'inherit' })
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', (status, signal) => resolveExit(status ?? (signal ? 1 : 0)))
})
if (code !== 0) process.exitCode = code
