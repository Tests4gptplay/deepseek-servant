import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
// Compare actual dss_recorder_save metadata reads recorded by the independent
// retention regression. This is a method/body-read count, not network timing.
const [beforePath, afterPath] = process.argv.slice(2)
if (!beforePath || !afterPath) throw new Error('Provide the baseline and revised independent-retention JSON files.')
const before = JSON.parse(await readFile(beforePath, 'utf8')), after = JSON.parse(await readFile(afterPath, 'utf8'))
const checks = [], cases = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
check('Baseline behavior regression passes', before.passed, 80)
check('Revised behavior regression passes', after.passed, 80)
const key = row => row.mode + '/' + row.name
const prior = new Map(before.familyReadObservations.map(row => [key(row), row]))
check('Same actual save cases', after.familyReadObservations.map(key), before.familyReadObservations.map(key))
for (const row of after.familyReadObservations) {
  const old = prior.get(key(row)), label = key(row), familySize = row.familyPaths.length
  // Real dispatchPlannerObjective generates a fresh child UUID in each run.
  // Compare the same fixture traversal positions, never assume cross-run IDs.
  check(label + ': same Task family size', row.familyPaths.length, old.familyPaths.length)
  check(label + ': same initialized root', row.familyPaths[0], old.familyPaths[0])
  const count = (value, predicate) => value.reads.filter(predicate).length
  const normal = entry => entry.taskFamily && entry.outputReferenceFamily
  const archiveNormal = entry => normal(entry) && entry.prepareArchive
  check(label + ': one family traversal removed', old.reads.length - row.reads.length, familySize)
  for (const [index, path] of row.familyPaths.entries()) {
    check(label + ': exactly one metadata body read removed for ' + path,
      count(old, entry => entry.path === old.familyPaths[index]) - count(row, entry => entry.path === path), 1)
  }
  check(label + ': other Task family reads retained', count(row, entry => entry.taskFamily && !entry.outputReferenceFamily), count(old, entry => entry.taskFamily && !entry.outputReferenceFamily))
  check(label + ': non-family identity reads retained', count(row, entry => !entry.taskFamily), count(old, entry => !entry.taskFamily))
  if (row.mode === 'local') {
    check(label + ': old prepareArchive duplicate was reached', count(old, archiveNormal), familySize)
    check(label + ': prepareArchive duplicate removed', count(row, archiveNormal), 0)
    check(label + ': early physical wrapper still reads its own family', count(row, normal), familySize)
    const first = old.reads.filter(entry => entry.taskFamily && entry.prepareArchive && !entry.outputReferenceFamily)
    const second = old.reads.filter(archiveNormal)
    check(label + ': original adjacent reads used same view', [...new Set(second.map(entry => entry.revision))], [...new Set(first.map(entry => entry.revision))])
  } else {
    check(label + ': old Git duplicate was reached', count(old, normal), familySize)
    check(label + ': Git normalization adds no family traversal', count(row, normal), 0)
    check(label + ': Git validation reads retained', count(row, entry => entry.validate), count(old, entry => entry.validate))
    const first = old.reads.filter(entry => entry.taskFamily && entry.validate)
    check(label + ': original Git adjacent reads used same H', [...new Set(old.reads.filter(normal).map(entry => entry.revision))], [...new Set(first.map(entry => entry.revision))])
  }
  cases.push({ mode: row.mode, name: row.name, familySize, metadataReadsBefore: old.reads.length, metadataReadsAfter: row.reads.length,
    normalizationFamilyReadsBefore: count(old, normal), normalizationFamilyReadsAfter: count(row, normal) })
}
console.log(JSON.stringify({ passed: checks.length, checks, cases, limits: ['Actual registered save and storage methods, controlled native Agent registration/remote Git transport.', 'Counter observes files.read once per Task metadata body; Physical internal readBytes is not counted twice.', 'Call-stack labels include async frames. This does not measure HTTP requests or latency.'] }, null, 2))
