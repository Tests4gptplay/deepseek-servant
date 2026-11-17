import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

// A current product-boundary regression, not an old SQL behavior specification.
const root = new URL('../', import.meta.url), hashes = {}, checks = []
async function read(relative) {
  const bytes = await fs.readFile(new URL(relative, root))
  hashes[relative] = createHash('sha256').update(bytes).digest('hex')
  return bytes.toString('utf8')
}
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); checks.push(name) }
for (const old of ['src/framework/local-files.ts', 'src/framework/local-files-worker.ts', 'src/framework/local-debug-records.ts']) {
  check('Retired product module absent: ' + old, await fs.stat(new URL(old, root)).then(() => false, error => { if (error.code !== 'ENOENT') throw error; return true }))
}
async function scan(directory) {
  for (const row of await fs.readdir(new URL(directory, root), { withFileTypes: true })) {
    const relative = directory + row.name
    if (row.isDirectory()) { await scan(relative + '/'); continue }
    if (!/\.(?:ts|tsx|mjs)$/.test(row.name)) continue
    const text = await read(relative)
    assert.doesNotMatch(text, /(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*(?:^|\/)local-files(?:-worker)?\.(?:js|ts)['"]/m, relative)
    assert.doesNotMatch(text, /\b(?:class|new|instanceof)\s+(?:LocalFiles|LocalWorker|LocalCommitOutcomeUnknownError|LocalDebugRecords)\b/, relative)
  }
}
await scan('src/'); checks.push('Production source has no retired SQL imports, constructors, or type branches')
check('Default Local acquisition is physical', /dependencies\.localFilesFactory\s*\?\?\s*PhysicalLocalFiles\.open/.test(await read('src/framework/connection.ts')))
check('Legacy SQL reader remains read-only', /readOnly:\s*true/.test(await read('src/framework/legacy-sqlite-reader.ts')))
for (const reader of ['legacy-record-export.ts', 'legacy-artifacts.ts', 'local-startup-upgrade.ts', 'legacy-local-conversation-view.ts']) {
  check('Actual legacy reader remains: ' + reader, (await read('src/framework/' + reader)).length > 0)
}
const manual = await read('src/framework/manual-cleanup.ts')
check('Manual cleanup no longer invokes SQL command transactions', !/this\.transactions\.run|private async (?:execute|intent|conversationPlan)\(/.test(manual))
check('Mechanical upgrade cannot gate ordinary acquisition', !/openPreparedPhysicalLocalFiles|LocalStartupUpgradeIncompleteError/.test(await read('src/framework/local-startup-upgrade.ts')))
check('Physical pending manual intents still resume', /async resumePending\(/.test(manual) && /technical\/manual-cleanup\/intents\//.test(manual))
const pack = JSON.parse(await read('package.json'))
check('Historical input producer is outside package files', pack.files.every(value => !/^(?:scripts|src)(?:\/|$)/.test(value)))
const { historicalProducer, localFilesWorkerSource } = await import('./test-support/historical-v44/load-sql-producer.mjs')
check('Frozen original worker remains available only to migration tests', localFilesWorkerSource.includes('CREATE TABLE') && Object.keys(historicalProducer.files).length === 2)
for (const relative of ['src/framework/manual-cleanup.ts', 'src/framework/host-loop.ts', 'src/framework/role-tools.ts', 'src/framework/cleaner.ts', 'src/framework/legacy-artifacts.ts']) {
  stripTypeScriptTypes(await read(relative), { mode: 'transform' }); checks.push('Current TypeScript parses: ' + relative)
}
console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, runtime: process.version, platform: process.platform,
  sourceHashes: hashes, historicalProducer,
  limits: 'Product source/import and parse checks plus frozen historical producer verification. Not full TypeScript, a package build, native DSH/Windows, real user data, installation, or final project acceptance.' }, null, 2))
