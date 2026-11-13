import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const hooks = registerHooks({
  resolve(s, c, next) {
    if (s.startsWith('.') && c.parentURL?.startsWith(sourceRoot.href) && s.endsWith('.js')) {
      const u = new URL(s.slice(0, -3) + '.ts', c.parentURL)
      if (existsSync(fileURLToPath(u))) return { url: u.href, shortCircuit: true }
    }
    return next(s, c)
  },
  load(u, c, next) {
    if (u.startsWith(sourceRoot.href) && u.endsWith('.ts')) {
      const source = readFileSync(new URL(u), 'utf8')
      loaded.set(u.slice(sourceRoot.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return next(u, c)
  },
})
const { LocalRecordFiles, samePhysicalPublication } = await import('../src/framework/local-record-files.ts')
const target = 'task/Note.md', stage = 'task/.operation/note.stage', fact = 'task/.operation/prepared.json'
const original = '用户原文\r\n', addition = '本次实际新增\r\n'
async function prepared(files) { const body = await files.read(fact); return body ? JSON.parse(body) : undefined }
async function publish(files, callback = value => files.replace(fact, JSON.stringify(value))) {
  await files.appendPrepared(target, stage, addition, await prepared(files), callback)
}
if (process.argv[2] === '--child') {
  const files = new LocalRecordFiles(process.argv[3]), point = process.argv[4], rename = fs.rename
  fs.rename = async (from, to) => {
    const match = from === path.join(files.root, stage) && to === path.join(files.root, target)
    if (match && point === 'before-rename') process.exit(73)
    const result = await rename(from, to)
    if (match && point === 'after-rename') process.exit(73)
    return result
  }
  await publish(files, async value => {
    if (point === 'before-prepared-save') process.exit(73)
    await files.replace(fact, JSON.stringify(value))
    if (point === 'after-prepared-save') process.exit(73)
  })
  throw Error('Requested interruption was not reached: ' + point)
}
let assertions = 0, processInterruptions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const rejects = async promise => { await assert.rejects(promise, /not confirmed/); assertions++ }
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-prepared-append-'))
async function fixture(name) { const files = new LocalRecordFiles(path.join(scratch, name)); await files.replace(target, original); return files }
function interrupt(files, point) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', files.root, point], { encoding: 'utf8' })
  check(result.status, 73); processInterruptions++
}
try {
  // Production fast path does not re-read the destination after rename.
  const files = await fixture('normal'), info = files.fileInfo.bind(files), observations = []
  files.fileInfo = async p => { observations.push(p); return info(p) }
  await publish(files)
  check(observations, [stage]); check(await files.read(target), original + addition)
  check(samePhysicalPublication((await prepared(files)).stageVersion, (await info(target)).version), true)
  check(await files.read(stage), undefined)
  observations.length = 0
  await publish(files, () => { throw Error('A completed rename cannot re-prepare') })
  check(observations, [target]); check(await files.read(target), original + addition)
  // The same prose in a different actual command is still a new append.
  let otherPrepared
  await files.appendPrepared(target, 'task/.other/note.stage', addition, undefined, async value => { otherPrepared = value })
  check(await files.read(target), original + addition + addition); check(typeof otherPrepared.stageVersion, 'string')

  // Every real exit leaves only the actual files for a new process/object.
  for (const point of ['before-prepared-save', 'after-prepared-save', 'before-rename', 'after-rename']) {
    const f = await fixture(point); interrupt(f, point)
    check(await f.read(target), point === 'after-rename' ? original + addition : original)
    await publish(new LocalRecordFiles(f.root))
    check(await f.read(target), original + addition); check(await f.read(stage), undefined)
    await publish(new LocalRecordFiles(f.root))
    check(await f.read(target), original + addition)
  }

  // Pre-rename interruption can coexist with a real different append. Rebuild
  // from that current target and persist the newly prepared file's identity.
  const rebuilt = await fixture('rebuild'); interrupt(rebuilt, 'after-prepared-save')
  const first = await prepared(rebuilt)
  await rebuilt.append(target, '另一次实际命令\r\n')
  interrupt(rebuilt, 'after-rename')
  const second = await prepared(rebuilt)
  check(second.stageVersion === first.stageVersion, false)
  check(samePhysicalPublication(second.stageVersion, (await rebuilt.fileInfo(target)).version), true)
  await publish(new LocalRecordFiles(rebuilt.root))
  check(await rebuilt.read(target), original + '另一次实际命令\r\n' + addition)

  // A missing stage is not publication. Preserve old, missing and replaced
  // destinations and the accepted operation fact; never recreate from doubt.
  for (const change of ['old-target', 'missing-target', 'replaced-target', 'edited-after-rename']) {
    const f = await fixture(change); interrupt(f, change === 'edited-after-rename' ? 'after-rename' : 'after-prepared-save')
    await fs.rm(path.join(f.root, stage), { force: true })
    if (change === 'missing-target') await fs.rm(path.join(f.root, target))
    if (change === 'replaced-target') await f.replace(target, original + addition)
    if (change === 'edited-after-rename') await f.append(target, '用户随后编辑\r\n')
    const before = await f.read(target), saved = await f.read(fact)
    await rejects(publish(f))
    check(await f.read(target), before); check(await f.read(fact), saved); check(await f.read(stage), undefined)
  }

  // Holding this exact file's preparation does not hold unrelated notes.
  const f = await fixture('lanes')
  let enter, release
  const entered = new Promise(resolve => { enter = resolve }), held = new Promise(resolve => { release = resolve })
  const pending = publish(f, async value => { await f.replace(fact, JSON.stringify(value)); enter(); await held })
  await entered
  let sameFinished = false
  const same = f.append(target, '下一个命令\r\n').then(() => { sameFinished = true })
  await f.append('other-task/Note.md', '独立任务')
  check(await f.read('other-task/Note.md'), '独立任务'); check(sameFinished, false)
  release(); await pending; await same
  check(await f.read(target), original + addition + '下一个命令\r\n')
  console.log(JSON.stringify({ status: 'passed', assertions, processInterruptions, sourceHashes: Object.fromEntries(loaded), limits: 'Actual LocalRecordFiles methods and Linux filesystem, ten fresh-process exits before/after actual preparation persistence and native rename. No filesystem or business implementation stubs. Process-local queues only; no Windows or cross-process lock claim.' }, null, 2))
} finally { await fs.rm(scratch, { recursive: true, force: true }); hooks.deregister() }
