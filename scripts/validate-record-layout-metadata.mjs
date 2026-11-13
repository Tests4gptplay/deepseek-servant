import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Real marker preparation/carry functions and filesystem. No native Domain is
// opened; its unavailable JSON import is a throwing sentinel, not a fake SDK.
const sourceURL = new URL('../src/adapters/dsh/record-files.ts', import.meta.url)
const source = readFileSync(sourceURL, 'utf8')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-storage-json') return {
      url: 'data:text/javascript,export class JsonStorageBackend { constructor() { throw new Error("Native SDK must not run in marker tests") } }',
      shortCircuit: true,
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === sourceURL.href) return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    return next(url, context)
  },
})
const { ensureRecordTree, configurationCarryRequired, finishConfigurationCarry } = await import(sourceURL.href)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-layout-metadata-'))
const format = 'deepseek-servant-record-folders'
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (operation, pattern) => { await assert.rejects(operation, pattern); assertions++ }
async function fixture(name, layout) {
  const root = path.join(temporary, name), marker = path.join(root, 'layout.json')
  await fs.mkdir(root)
  const text = JSON.stringify(layout, null, 4) + '\n'
  await fs.writeFile(marker, text)
  return { root, marker, text }
}
try {
  const extra = { ownerNote: 'Keep this user field', extension: { enabled: true, values: [1, 2] }, __protoField: 'ordinary data' }
  const current = await fixture('current-extra', { format, version: 2, ...extra })
  await ensureRecordTree(current.root, false, false)
  check(await configurationCarryRequired(current.root), false)
  await finishConfigurationCarry(current.root)
  check(await fs.readFile(current.marker, 'utf8'), current.text)

  const previous = await fixture('previous-extra', { format, version: 1, ...extra })
  await ensureRecordTree(previous.root, true, false)
  check(await configurationCarryRequired(previous.root), true)
  await finishConfigurationCarry(previous.root)
  check(JSON.parse(await fs.readFile(previous.marker, 'utf8')), { format, version: 2, ...extra })
  check(await configurationCarryRequired(previous.root), false)
  const completed = await fs.readFile(previous.marker, 'utf8')
  await finishConfigurationCarry(previous.root)
  check(await fs.readFile(previous.marker, 'utf8'), completed)

  // Version metadata is not a startup/write lock. Only the known v1 marker
  // requests the existing, exact seven-configuration carry operation.
  for (const [name, layout] of [['future', { format, version: 99, ...extra }], ['unversioned', { format, ...extra }]]) {
    const f = await fixture(name, layout)
    await ensureRecordTree(f.root, false, false)
    check(await configurationCarryRequired(f.root), false)
    await finishConfigurationCarry(f.root)
    check(await fs.readFile(f.marker, 'utf8'), f.text)
  }

  for (const [name, layout] of [['edited-format', { format: 'User annotation', version: 2, ...extra }],
    ['note-only', { note: 'Keep my annotation' }], ['null-marker', null], ['text-marker', 'User text']]) {
    const edited = await fixture(name, layout)
    await ensureRecordTree(edited.root, false, false)
    check(await configurationCarryRequired(edited.root), false)
    check(await configurationCarryRequired(edited.root, 'folders-v1'), true)
    check(await configurationCarryRequired(edited.root, 'folders-v2'), false)
    await finishConfigurationCarry(edited.root)
    check(await fs.readFile(edited.marker, 'utf8'), edited.text)
  }

  const missing = path.join(temporary, 'missing')
  await ensureRecordTree(missing, true, false)
  check(await configurationCarryRequired(missing), true)
  await finishConfigurationCarry(missing)
  check(JSON.parse(await fs.readFile(path.join(missing, 'layout.json'), 'utf8')), { format, version: 2 })

  const truncated = await fixture('truncated', { format, version: 2 })
  await fs.writeFile(truncated.marker, '{truncated original')
  await ensureRecordTree(truncated.root, false, false)
  await finishConfigurationCarry(truncated.root)
  check(await fs.readFile(truncated.marker, 'utf8'), '{truncated original')
  check(await configurationCarryRequired(truncated.root), false)
  check(await configurationCarryRequired(truncated.root, 'folders-v1'), true)
  check(await configurationCarryRequired(current.root, 'folders-v1'), false)
  check(await fs.readdir(truncated.root), ['layout.json'])
  const directoryMarker = path.join(temporary, 'directory-marker')
  await fs.mkdir(path.join(directoryMarker, 'layout.json'), { recursive: true })
  await rejects(() => ensureRecordTree(directoryMarker), /布局标记不是普通文件/)
  await fs.rmdir(path.join(directoryMarker, 'layout.json'))
  await ensureRecordTree(directoryMarker, false, false)
  check(JSON.parse(await fs.readFile(path.join(directoryMarker, 'layout.json'), 'utf8')), { format, version: 2 })
  const linkMarker = path.join(temporary, 'symlink-marker')
  await fs.mkdir(linkMarker)
  await fs.symlink(current.marker, path.join(linkMarker, 'layout.json'))
  await rejects(() => ensureRecordTree(linkMarker), /布局标记不是普通文件/)
  check(await fs.readFile(current.marker, 'utf8'), current.text)
  console.log(JSON.stringify({ status: 'passed', assertions, sourceSHA256: createHash('sha256').update(source).digest('hex'),
    limits: 'Actual layout marker and carry-boundary functions on cloud Linux. Native Domain/JSON SDK are not executed; no desktop, real user records, or production cutover.' }, null, 2))
} finally {
  hooks.deregister()
  await fs.rm(temporary, { recursive: true, force: true })
}
