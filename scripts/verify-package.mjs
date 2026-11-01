import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

// Offline packaging only. This does not install dependencies, contact a registry,
// create a native Agent, or claim that the complete Host has been exercised.
const root = process.cwd()
const initialCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
await mkdir('.validation', { recursive: true })
const directory = await mkdtemp(resolve('.validation/package-'))
const output = execFileSync('npm', ['--cache', resolve('.validation/npm-cache'), '--offline', 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], { encoding: 'utf8', cwd: root })
const [packed] = JSON.parse(output)
assert.ok(packed?.filename)
const tarball = join(directory, packed.filename)
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
assert.ok(manifest.files.every(path => typeof path === 'string' && !/[?*\[\]]/.test(path)), 'Verify explicit file entries before expanding package patterns.')
const allowed = new Set(['package.json', ...manifest.files].map(path => 'package/' + path))
const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
for (const path of listing) {
  assert.ok(allowed.has(path), 'File outside the explicit package manifest: ' + path)
  assert.ok(path.startsWith('package/') && !path.split('/').includes('..'), 'Unsafe package path: ' + path)
  assert.ok(!/^package\/(?:tests|src|scripts|node_modules|\.validation|\.git)(?:\/|$)/.test(path), 'Development material in package: ' + path)
  assert.ok(!/AGENTS\.md|\.bundle$|\.env(?:\.|$)/.test(path), 'Private/development file in package: ' + path)
}
const missing = [...allowed].filter(path => !listing.includes(path))
assert.deepEqual(missing, [], 'Required manifest entries are missing from the package: ' + missing.join(', '))
assert.equal(new Set(listing).size, listing.length, 'Duplicate package entries are not allowed.')
const detailed = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' }).trim().split('\n')
assert.ok(detailed.every(line => line.startsWith('-')), 'Package may contain only regular files, not links or special entries.')
execFileSync('tar', ['-xzf', tarball, '-C', directory])
const pkg = JSON.parse(await readFile(join(directory, 'package/package.json'), 'utf8'))
assert.equal(pkg.name, manifest.name)
assert.equal(pkg.version, manifest.version)
assert.deepEqual(pkg.exports, manifest.exports)
assert.equal(pkg.main, 'lib/host.js')
assert.equal(pkg.exports['./client'], './lib/client.js')
for (const path of ['lib/host.js', 'lib/client.js']) {
  assert.deepEqual(await readFile(join(directory, 'package', path)), await readFile(path), 'Packed bundle differs from built candidate: ' + path)
}
const host = await import(pathToFileURL(join(directory, 'package', pkg.main)).href)
assert.equal(host.name, 'deepseek-servant')
assert.equal(typeof host.apply, 'function')
assert.ok(host.Config.safeParse({}).success)
let registration
vm.runInNewContext(await readFile(join(directory, 'package/lib/client.js'), 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value } } } })
assert.equal(registration?.id, 'deepseek-servant')
assert.equal(typeof registration?.factory, 'function')
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), initialCommit, 'Commit changed during package verification.')
const evidence = { commit: initialCommit,
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), tarball,
  sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), files: listing,
  verified: ['offline npm pack', 'package file allowlist', 'packed bundle byte equality', 'packed host module import/config', 'client registration envelope captured; factory not executed'],
  dependencies: 'Host import resolves existing repository node_modules; not a fresh dependency installation',
  notVerified: ['complete Host startup', 'real Agent loop', 'browser interaction', 'remote Git account'] }
await writeFile(join(directory, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
