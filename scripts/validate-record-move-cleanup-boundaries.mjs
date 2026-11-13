import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sourceRoot, hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
const { copyRecordTree, retireRecordTreeSource } = await import(new URL('framework/record-tree-copy.ts', sourceRoot))
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-copy-cleanup-'))
const checks = [], check = (name, value, expected) => { assert.deepEqual(value, expected, name); checks.push(name) }
const exists = file => fs.lstat(file).then(()=>true, e=>{if(e.code!=='ENOENT')throw e;return false})
const put = async (file, body) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body) }
async function fixture(name) {
  const root = path.join(scratch, name), source = path.join(root, 'source'), destination = path.join(root, 'destination')
  await put(path.join(source, 'archive/body.txt'), 'exact original\r\n')
  await put(path.join(source, 'binary.bin'), Buffer.from([0, 255, 13, 10]))
  await fs.mkdir(path.join(source, 'empty'))
  await put(path.join(root, 'outside.txt'), 'unrelated')
  const copy = await copyRecordTree(source, destination, undefined, async()=>{})
  return { root, source, destination, copy }
}
try {
  const normal = await fixture('normal')
  await retireRecordTreeSource(normal.copy)
  check('normal exact source removed', await exists(normal.source), false)
  check('target original unchanged', await fs.readFile(path.join(normal.destination, 'archive/body.txt'), 'utf8'), 'exact original\r\n')
  check('target binary unchanged', await fs.readFile(path.join(normal.destination, 'binary.bin')), Buffer.from([0, 255, 13, 10]))
  check('empty copied directory remains at destination', await exists(path.join(normal.destination, 'empty')), true)
  check('parent unrelated original remains', await fs.readFile(path.join(normal.root, 'outside.txt'), 'utf8'), 'unrelated')
  await retireRecordTreeSource(normal.copy); checks.push('already removed source is harmless')
  for (const kind of ['append', 'new-file']) {
    const f = await fixture(kind)
    const original = path.join(f.source, 'archive/body.txt')
    if (kind === 'append') await fs.appendFile(original, 'later user edit')
    else await put(path.join(f.source, 'later-user-file.txt'), 'new original')
    await assert.rejects(()=>retireRecordTreeSource(f.copy), /Old copy changed/); checks.push(kind + ': changed original refuses cleanup')
    check(kind + ': earlier original is not partially removed', await exists(original), true)
    check(kind + ': copied target unchanged', await fs.readFile(path.join(f.destination, 'archive/body.txt'), 'utf8'), 'exact original\r\n')
  }
  const replaced = await fixture('replaced-target')
  await fs.rename(replaced.destination, replaced.destination + '-original')
  await fs.cp(replaced.destination + '-original', replaced.destination, { recursive: true })
  await assert.rejects(()=>retireRecordTreeSource(replaced.copy), /ownership changed/); checks.push('byte-identical replacement is not owned destination')
  check('source retained when destination ownership changes', await fs.readFile(path.join(replaced.source, 'archive/body.txt'), 'utf8'), 'exact original\r\n')
  const linked = await fixture('changed-source-path')
  await fs.rename(linked.source, linked.source + '-original'); await fs.symlink(linked.source + '-original', linked.source)
  await assert.rejects(()=>retireRecordTreeSource(linked.copy), /locations changed/); checks.push('source pathname symlink is not followed')
  check('original behind replacement symlink retained', await fs.readFile(path.join(linked.source + '-original', 'archive/body.txt'), 'utf8'), 'exact original\r\n')
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, ...evidence(), limits: 'Real ordinary cloud Linux file copies, user edits, directory replacement and symlink, no injected errors, delays or production mechanism. Direct helper scope checks complement real Service/UI tests; no native Windows claim.' }, null, 2))
} finally { hooks.deregister(); await fs.rm(scratch, { recursive: true, force: true }) }
