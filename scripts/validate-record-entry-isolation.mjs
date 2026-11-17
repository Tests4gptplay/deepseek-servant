import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {sourceRoot,loaded as sources,hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
// Observe actual native opens and tree loads without replacing their outcomes.
// File replacements below are controlled filesystem operations, not observed product incidents.
const state={opens:[],treeLoads:0}
const {JsonStorageBackend}=await import('@deepseek-ai/dsh-storage-json')
const allNative=[],nativeOpen=JsonStorageBackend.prototype.openUnit,nativeClose=JsonStorageBackend.prototype.close
JsonStorageBackend.prototype.openUnit=async function(...args){
 state.opens.push(this.root);if(!allNative.includes(this))allNative.push(this)
 return nativeOpen.apply(this,args)
}
const { RecordFilesBackend, recordFolder, ensureRecordTree } = await import(new URL('adapters/dsh/record-files.ts',sourceRoot))
const nativeTreeLoad=RecordFilesBackend.prototype.loadAll;RecordFilesBackend.prototype.loadAll=function(...args){state.treeLoads++;return nativeTreeLoad.apply(this,args)}
const selectedCase = process.env.DSS_RECORD_ENTRY_CASE
if (selectedCase && !['linked-folder', 'linked-file', 'directory-instead-of-json', 'file-instead-of-folder', 'malformed-json', 'ordinary-notes'].includes(selectedCase))
  throw new Error('Unknown record entry isolation case: ' + selectedCase)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-entry-isolation-')), adapters = [], nativeFixtures = []
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async (operation, pattern) => { await assert.rejects(operation, pattern); assertions++ }
const hash = value => createHash('sha256').update(value).digest('hex')
const bad = 'framework-user-controls/' + hash('scope') + '/tasks/' + hash('bad')
const good = 'framework-user-controls/' + hash('scope') + '/tasks/' + hash('good')
const envelope = (key, value) => JSON.stringify({ unit: { name: 'record', version: 1 }, tables: { records: { [key]: { key, value } } }, global: null })
async function writeRecord(tree, key, value) {
  const folder = path.join(tree, recordFolder(key))
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'record.json'), envelope(key, value))
  return folder
}
async function fixture(name, damage) {
  const directory = path.join(temporary, name), tree = path.join(directory, 'deepseek_servant')
  await ensureRecordTree(tree)
  const folder = await writeRecord(tree, bad, 'original-bad'), file = path.join(folder, 'record.json')
  await writeRecord(tree, good, 'healthy')
  const external = path.join(directory, 'outside-owned-tree'); await fs.mkdir(external)
  const outside = path.join(external, 'record.json'), outsideText = envelope(bad, 'do-not-follow')
  await fs.writeFile(outside, outsideText)
  await damage({ tree, folder, file, external, outside })
  const native=await openDshStorageFixture(directory,path.join(directory,'locator'))
  nativeFixtures.push(native)
  const adapter=native.adapter,files=adapter.records.files
  adapters.push(adapter)
  return { tree, folder, file, files, adapter, outside, outsideText }
}
try {
  for (const [name, damage, remove] of [
    ['linked-folder', async f => { await fs.rm(f.folder, { recursive: true }); await fs.symlink(f.external, f.folder) }, f => fs.unlink(f.folder)],
    ['linked-file', async f => { await fs.unlink(f.file); await fs.symlink(f.outside, f.file) }, f => fs.unlink(f.file)],
    ['directory-instead-of-json', async f => { await fs.unlink(f.file); await fs.mkdir(f.file); await fs.writeFile(path.join(f.file, 'keep.txt'), 'keep') }, f => fs.rm(f.file, { recursive: true })],
    ['file-instead-of-folder', async f => { await fs.rm(f.folder, { recursive: true }); await fs.writeFile(f.folder, 'keep original blocker') }, f => fs.unlink(f.folder)],
    ['malformed-json', f => fs.writeFile(f.file, '{keep malformed original'), f => fs.unlink(f.file)],
  ]) {
    if (selectedCase && selectedCase !== name) continue
    const f = await fixture(name, damage), opens = state.opens.length, loads = state.treeLoads
    check(await f.adapter.get(good), 'healthy')
    check(state.opens.length, opens) // An unrelated exact read does not retry the damaged record.
    check(f.files.needsRetry(good), false)
    check(f.files.needsRetry(bad), true)
    await rejects(() => f.adapter.get(bad), /记录|JSON/)
    await rejects(() => f.adapter.set(bad, 'must-not-overwrite'), /记录|JSON/)
    await rejects(() => f.adapter.delete(bad), /记录|JSON/)
    check(await fs.readFile(f.outside, 'utf8'), f.outsideText)
    if (name === 'linked-folder') check((await fs.lstat(f.folder)).isSymbolicLink(), true)
    if (name === 'linked-file') check((await fs.lstat(f.file)).isSymbolicLink(), true)
    if (name === 'directory-instead-of-json') check(await fs.readFile(path.join(f.file, 'keep.txt'), 'utf8'), 'keep')
    if (name === 'file-instead-of-folder') check(await fs.readFile(f.folder, 'utf8'), 'keep original blocker')
    if (name === 'malformed-json') check(await fs.readFile(f.file, 'utf8'), '{keep malformed original')
    check((await f.adapter.list('framework-user-controls/')).map(row => row.key), [good])
    check(f.adapter.storageView().issues.length, 1)
    check(state.treeLoads, loads)
    await f.adapter.set(good, 'still-writable'); check(await f.adapter.get(good), 'still-writable')
    await remove(f); await writeRecord(f.tree, bad, 'repaired')
    check(await f.adapter.get(bad), 'repaired')
    check(state.treeLoads, loads + 1) // Fresh tree open reloads its committed view after exact recovery.
    check(f.adapter.storageView().issues, [])
    check((await f.adapter.list('framework-user-controls/')).map(row => row.key).sort(), [bad, good].sort())
    await f.adapter.close()
    check(allNative.filter(backend => backend.root.startsWith(f.tree + path.sep)).every(backend => backend.closed), true)
  }

  if (!selectedCase || selectedCase === 'ordinary-notes') {
    const ignored = await fixture('ordinary-notes', async f => { await fs.writeFile(path.join(path.dirname(f.folder), 'notes.txt'), 'unrelated notes'); await fs.unlink(f.file) })
    check(await ignored.adapter.get(bad), undefined)
    check(ignored.adapter.storageView().issues, [])
    check(await fs.readFile(path.join(path.dirname(ignored.folder), 'notes.txt'), 'utf8'), 'unrelated notes')
    check(existsSync(ignored.file), false)
  }
  console.log(JSON.stringify({ status: 'passed', assertions, ...evidence(), sourceHashes: Object.fromEntries(sources),
    limits: 'Actual production adapter/backend and recovered native SDK Context/Storage/locator Domain/Json backend. Controlled filesystem replacements exercise actual native reads and recovery; no native read/close failure is injected. These are boundary fixtures, not evidence that normal producers create malformed records. Linux fixtures; no Windows, user data or Git.' }, null, 2))
} finally {
  await Promise.allSettled(adapters.map(adapter => adapter.close()))
  await Promise.allSettled(nativeFixtures.map(f=>f.close()));await Promise.allSettled(allNative.map(backend=>nativeClose.call(backend)));JsonStorageBackend.prototype.openUnit=nativeOpen;RecordFilesBackend.prototype.loadAll=nativeTreeLoad;hooks.deregister()
  await fs.rm(temporary, { recursive: true, force: true })
}
