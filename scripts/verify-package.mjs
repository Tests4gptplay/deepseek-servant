import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

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
// The bundled Python runtime is the only directory entry. Its existing index
// supplies exact member paths and hashes instead of trusting an npm directory glob.
const vendor = 'python/vendor'
const vendorDevelopmentPath = /(?:^|\/)(?:test|tests|__tests__|fixture|fixtures|test-support)(?:\/|$)|\.data\/scripts(?:\/|$)/i
const vendorManifest = vendor + '/manifest.json'
assert.ok(manifest.files.includes(vendor), 'The bundled Python runtime must be included.')
const vendorManifestBytes = await readFile(vendorManifest)
const vendorFiles = Object.entries(JSON.parse(vendorManifestBytes).files).map(([path, sha256]) => {
  assert.match(path, /^(?:common|native)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/)
  assert.ok(path.split('/').every(part => part !== '.' && part !== '..'), 'Unsafe Python vendor path: ' + path)
  assert.ok(!vendorDevelopmentPath.test(path), 'Development or standalone CLI file in bundled runtime: ' + path)
  assert.match(sha256, /^[a-f0-9]{64}$/, 'Missing Python vendor SHA-256: ' + path)
  return [vendor + '/' + path, sha256]
})
assert.ok(vendorFiles.length > 0, 'The bundled Python runtime index is empty.')
const allowed = new Set(['package.json', ...manifest.files.flatMap(path =>
  path === vendor ? [vendorManifest, ...vendorFiles.map(([vendorPath]) => vendorPath)] : [path]
)].map(path => 'package/' + path.replace(/^\.\//, '')))
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
assert.deepEqual(await readFile(join(directory, 'package', vendorManifest)), vendorManifestBytes)
for (const [path, sha256] of vendorFiles)
  assert.equal(createHash('sha256').update(await readFile(join(directory, 'package', path))).digest('hex'), sha256, 'Packed Python vendor hash differs: ' + path)
const pkg = JSON.parse(await readFile(join(directory, 'package/package.json'), 'utf8'))
assert.equal(pkg.name, manifest.name)
assert.equal(pkg.version, manifest.version)
assert.deepEqual(pkg.exports, manifest.exports)
assert.equal(pkg.main, 'lib/host.js')
assert.equal(pkg.exports['./client'], './lib/client.js')
for (const path of ['lib/host.js', 'lib/client.js']) {
  assert.deepEqual(await readFile(join(directory, 'package', path)), await readFile(path), 'Packed bundle differs from built candidate: ' + path)
}
// Validate package bytes as data. Never execute the Host or client here.
const bundledHost = await readFile(join(directory, 'package/lib/host.js'), 'utf8')
const bundledHelper = await readFile(join(directory, 'package/lib/dulwich-helper.py'), 'utf8')
assert.doesNotMatch(bundledHost, /fixtureTransport|isolated loopback|fixture transport requires/i)
assert.doesNotMatch(bundledHelper, /isolated loopback|request\.get\('fixture'\)/i)
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), initialCommit, 'Commit changed during package verification.')
const evidence = { commit: initialCommit,
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), tarball,
  sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), files: listing,
  verified: ['offline npm pack', 'package file allowlist', 'packed Python vendor member hashes', 'packed bundle byte equality', 'no production loopback test route'],
  dependencies: 'No dependency installation or Host execution',
  notVerified: ['complete Host startup', 'real Agent loop', 'browser interaction', 'remote Git account'] }
await writeFile(join(directory, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
