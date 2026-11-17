import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
const source = new URL('../src/framework/local-record-files.ts', import.meta.url)
const sourceText = readFileSync(source, 'utf8')
const hook = registerHooks({load(url, context, next) { return url === source.href
  ? {format:'module',source:stripTypeScriptTypes(sourceText,{mode:'transform'}),shortCircuit:true}:next(url,context)}})
const { LocalRecordFiles } = await import(source.href)
const hash = value => createHash('sha256').update(value).digest('hex')
const checks = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const rejects = async (name, action, match) => { await assert.rejects(async () => action(), match); checks.push(name) }
const originalOpen = fs.open, originalRename = fs.rename
if (['--partial-exit', '--owner-gap-exit', '--complete-exit'].includes(process.argv[2])) {
  const mode = process.argv[2], directory = process.argv[3], stage = process.argv[4] ?? 'owned/stage.raw', files = new LocalRecordFiles(directory)
  fs.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) === path.join(directory, stage + '.copying')) {
      if (mode === '--owner-gap-exit') process.exit(89)
      const write = handle.write.bind(handle)
      handle.write = async (...writeArgs) => { const result = await write(...writeArgs); if (mode === '--partial-exit') process.exit(88); return result }
    }
    return handle
  }
  fs.rename = async (from, to) => { if (mode === '--complete-exit' && String(to) === path.join(directory, stage)) process.exit(90); return originalRename(from, to) }
  await files.stageCopy('source.bin', stage)
  throw new Error('Partial process exit was not reached')
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-stream-copy-'))
const files = new LocalRecordFiles(root)
let maxRead = 0, maxWrite = 0, sourceReads = 0, forbiddenWholeReads = 0
try {
  await files.replace('source.bin', new Uint8Array([239, 187, 191, 0, 255, 7]))
  const first = await files.stageCopy('source.bin', 'owned/first.raw')
  check('Raw zero/BOM/nontext bytes copied exactly', Array.from(await files.readBytes('owned/first.raw')), [239, 187, 191, 0, 255, 7])
  check('Streaming capture returns exact digest and length', first, {bytes:6,sha256:hash(new Uint8Array([239,187,191,0,255,7]))})
  await files.replace('source.bin', 'later user source edit')
  check('Complete stage wins over later edited source', await files.stageCopy('source.bin', 'owned/first.raw'), first)
  await files.delete('source.bin')
  check('Complete stage recovers even when original source is missing', await files.stageCopy('source.bin', 'owned/first.raw'), first)
  check('Missing source without stage stays missing', await files.stageCopy('source.bin', 'owned/missing.raw'), undefined)
  await files.replace('zero.bin', new Uint8Array())
  check('Zero-length original is present and copied', await files.stageCopy('zero.bin', 'owned/zero.raw'), {bytes:0,sha256:hash(new Uint8Array())})
  check('Zero-length stage exists', (await files.fileInfo('owned/zero.raw')).bytes, 0)
  await rejects('Source cannot escape selected logical root', () => files.stageCopy('../outside', 'owned/escape.raw'), /relative file path/)
  await rejects('Stage cannot escape selected logical root', () => files.stageCopy('zero.bin', '../escape.raw'), /relative file path/)
  await rejects('Source and owned stage must be distinct', () => files.stageCopy('zero.bin', 'zero.bin'), /distinct stage/)
  await fs.symlink(path.join(root, 'zero.bin'), path.join(root, 'source-link'))
  await rejects('Symlink source is not followed', () => files.stageCopy('source-link', 'owned/link.raw'), /ordinary Local record/)
  await fs.symlink(path.join(root, 'zero.bin'), path.join(root, 'owned', 'target-link'))
  await rejects('Symlink stage is not overwritten', () => files.stageCopy('zero.bin', 'owned/target-link'), /ordinary Local record/)
  await fs.symlink(path.join(root, 'zero.bin'), path.join(root, 'owned', 'partial-link.raw.copying'))
  await rejects('Symlink incomplete stage is not followed', () => files.stageCopy('zero.bin', 'owned/partial-link.raw'), /ordinary Local record/)
  await fs.unlink(path.join(root, 'owned', 'target-link')); await fs.unlink(path.join(root, 'owned', 'partial-link.raw.copying'))
  await files.replace('short.bin', '0123456789')
  fs.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]).endsWith('short.raw.copying')) {
      const write = handle.write.bind(handle)
      handle.write = (buffer, offset, length, position) => write(buffer, offset, Math.min(length, 2), position)
    }
    return handle
  }
  await files.stageCopy('short.bin', 'owned/short.raw')
  check('Short OS writes are drained before reusing the buffer', await files.read('owned/short.raw'), '0123456789')
  fs.open = originalOpen
  const failStage = 'owned/fail.raw'
  fs.rename = async (from, to) => { if (String(to) === path.join(root, failStage)) throw new Error('controlled stream rename failure'); return originalRename(from, to) }
  await rejects('Stream rename failure remains explicit', () => files.stageCopy('short.bin', failStage), /controlled stream rename failure/)
  fs.rename = originalRename
  check('Failed stream publication keeps original untouched', await files.read('short.bin'), '0123456789')
  check('Failed stream publication does not leave partial as complete', await files.fileInfo(failStage), undefined)
  check('Failed live attempt removes its exact incomplete sibling', await files.fileInfo(failStage + '.copying'), undefined)
  const aborted = new AbortController()
  fs.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]).endsWith('abort.raw.copying')) {
      const write = handle.write.bind(handle)
      handle.write = async (...writeArgs) => { const result = await write(...writeArgs); aborted.abort(new Error('explicit task abort')); return result }
    }
    return handle
  }
  await rejects('Explicit task abort stops before final stage publication', () => files.stageCopy('short.bin', 'owned/abort.raw', aborted.signal), /explicit task abort/)
  fs.open = originalOpen
  check('Explicit task abort removes exact partial only', await files.fileInfo('owned/abort.raw.copying'), undefined)
  check('Explicit task abort preserves source', await files.read('short.bin'), '0123456789')
  await files.replace('held.bin', 'held stream original')
  let releaseRead, enteredRead
  const readGate = new Promise(resolve => releaseRead = resolve), readEntered = new Promise(resolve => enteredRead = resolve)
  fs.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) === path.join(root, 'held.bin')) {
      const read = handle.read.bind(handle); let first = true
      handle.read = async (...readArgs) => { if (first) { first = false; enteredRead(); await readGate }; return read(...readArgs) }
    }
    return handle
  }
  const copying = files.stageCopy('held.bin', 'owned/held.raw')
  try {
    await readEntered
    check('A held exact source copy does not block another stage', await files.stageCopy('short.bin', 'owned/independent.raw'), {bytes:10,sha256:hash('0123456789')})
    await files.replace('independent.txt', 'ordinary unrelated write')
    check('A held source copy does not block ordinary unrelated writes', await files.read('independent.txt'), 'ordinary unrelated write')
  } finally { releaseRead(); await copying; fs.open = originalOpen }
  check('Held source resumes its same exact original', await files.read('owned/held.raw'), 'held stream original')
  await files.replace('header.md', '\uFEFFTask ID: 00000000-0000-4000-8000-000000000001\r\n原文')
  check('Known header read does not change original', Buffer.from(await files.readPrefix('header.md', 3)).toString('hex'), 'efbbbf')
  const info = await files.fileInfo('header.md'), listed = (await files.listMetadata('', false)).find(entry => entry.path === 'header.md')
  check('Exact fileInfo returns the actual ordinary listing observation', info.version, listed.version)
  check('Exact observation supports existing conditional deletion', await files.deleteObserved('header.md', info.version), true)
  await files.replace('source.bin', Buffer.alloc(1024 * 1024, 91))
  const exited = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--partial-exit', root], {encoding:'utf8'})
  check('Actual process exits during incomplete raw copy', exited.status, 88)
  check('Partial process stop never publishes an incomplete stage', await files.fileInfo('owned/stage.raw'), undefined)
  check('Partial process stop retains its exact unfinished sibling', !!await files.fileInfo('owned/stage.raw.copying'), true)
  check('Cold exact continuation copies full original', await files.stageCopy('source.bin', 'owned/stage.raw'), {bytes:1024*1024,sha256:hash(Buffer.alloc(1024*1024,91))})
  check('Cold continuation ends the exact partial sibling', await files.fileInfo('owned/stage.raw.copying'), undefined)
  // Source edits are detected only for this actual capture, not normal reads.
  for (const kind of ['same-length', 'replacement', 'truncate', 'append', 'at-eof']) {
    const body = Buffer.alloc(768 * 1024, 65), logical = 'changing-' + kind + '.bin', target = path.join(root, logical), stage = 'owned/changing-' + kind + '.raw'
    await files.replace(logical, body)
    let edited = false
    fs.open = async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === target && args[1] === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))) {
        const read = handle.read.bind(handle)
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs)
          if (!edited && (kind === 'at-eof' ? !result.bytesRead : result.bytesRead)) {
            edited = true
            if (kind === 'replacement') await files.replace(logical, Buffer.alloc(body.length, 66))
            else if (kind === 'truncate') await fs.truncate(target, 7)
            else if (kind === 'append') await fs.appendFile(target, 'user addition')
            else { const edit = await originalOpen(target, 'r+'); try { await edit.write(Buffer.from('user edit'), 0, 9, 0) } finally { await edit.close() } }
          }
          return result
        }
      }
      return handle
    }
    await rejects('Changing source ' + kind + ' is not published as a consistent original', () => files.stageCopy(logical, stage), /changed during capture/)
    fs.open = originalOpen
    check('Changing source ' + kind + ' leaves no accepted stage', await files.fileInfo(stage), undefined)
    check('Changing source ' + kind + ' leaves current user bytes readable', !!await files.readBytes(logical), true)
    const retried = await files.stageCopy(logical, stage)
    check('An ordinary later capture uses current ' + kind + ' source', retried, await files.fingerprint(logical))
  }
  await files.replace('owned/unknown.raw.copying', 'existing user material')
  await rejects('Pre-existing unowned partial is never truncated', () => files.stageCopy('source.bin', 'owned/unknown.raw'), /Unowned partial/)
  check('Unowned partial keeps exact user content', await files.read('owned/unknown.raw.copying'), 'existing user material')
  await files.replace('owned/unknown-complete.raw', 'existing complete user material')
  await rejects('Pre-existing unowned complete stage is not adopted', () => files.stageCopy('source.bin', 'owned/unknown-complete.raw'), /unowned or changed/)
  check('Unowned complete stage stays untouched', await files.read('owned/unknown-complete.raw'), 'existing complete user material')
  for (const kind of ['content', 'identity', 'source']) {
    const stage = 'owned/changed-partial-' + kind + '.raw'
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--partial-exit', root, stage], {encoding:'utf8'})
    check('Actual interrupted partial exists for ' + kind, child.status, 88)
    if (kind === 'content') await fs.writeFile(path.join(root, stage + '.copying'), 'user changed partial')
    else if (kind === 'identity') await files.replace(stage + '.copying', 'user replaced partial')
    else await files.replace('source.bin', Buffer.alloc(1024 * 1024, 92))
    const before = await fs.readFile(path.join(root, stage + '.copying'))
    await rejects('Changed interrupted ' + kind + ' is preserved, not resumed', () => files.stageCopy('source.bin', stage), /changed|preserved/)
    check('Interrupted ' + kind + ' bytes remain exact', await fs.readFile(path.join(root, stage + '.copying')), before)
    check('Interrupted ' + kind + ' is not published', await files.fileInfo(stage), undefined)
  }
  const gap = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--owner-gap-exit', root, 'owned/gap.raw'], {encoding:'utf8'})
  check('Actual exit before ownership persistence leaves an explicit unknown', gap.status, 89)
  await rejects('No ownership proof is not permission to discard even an empty partial', () => files.stageCopy('source.bin', 'owned/gap.raw'), /Unowned partial/)
  check('Unknown empty partial is preserved', (await files.fileInfo('owned/gap.raw.copying')).bytes, 0)
  const completed = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--complete-exit', root, 'owned/completed.raw'], {encoding:'utf8'})
  check('Actual exit after verified completion leaves a resumable exact capture', completed.status, 90)
  const sourceFingerprint = await files.fingerprint('source.bin'); await files.delete('source.bin')
  check('Verified completed partial can finish without rereading a removed source', await files.stageCopy('source.bin', 'owned/completed.raw'), sourceFingerprint)
  check('Completed continuation consumes exact partial', await files.fileInfo('owned/completed.raw.copying'), undefined)
  await files.replace('source.bin', Buffer.alloc(1024 * 1024, 91))
  // Excluded live private-temp overwrite fixture: not a supported source edit.
  // An edit during final owner persistence is still not permission to move
  // modified bytes into the accepted stage or delete them on failure.
  const finalStage = 'owned/final-edited.raw'; let completionEdited = false
  fs.rename = async (from, to) => {
    const result = await originalRename(from, to)
    if (String(to) === path.join(root, finalStage + '.capture.json') && !completionEdited) {
      const owner = JSON.parse(await fs.readFile(to, 'utf8'))
      if (owner.completed) { completionEdited = true; await fs.writeFile(path.join(root, finalStage + '.copying'), 'user edit at completion') }
    }
    return result
  }
  await rejects('Changed partial during completion persistence is not published', () => files.stageCopy('source.bin', finalStage), /partial changed/)
  fs.rename = originalRename
  check('Completion-window user bytes are preserved', await files.read(finalStage + '.copying'), 'user edit at completion')
  check('Completion-window changed partial is not a complete stage', await files.fileInfo(finalStage), undefined)
  await rejects('Cold completed-partial receipt cannot override subsequent user bytes', () => files.stageCopy('source.bin', finalStage), /edited|preserved/)
  check('Cold failed completion preserves the same user edit', await files.read(finalStage + '.copying'), 'user edit at completion')
  await files.replace('owned/first.raw', 'user changed completed stage')
  await rejects('Completed stage owner does not permit replacing user edits', () => files.stageCopy('source.bin', 'owned/first.raw'), /unowned or changed/)
  check('Edited complete stage remains readable without a read gate', await files.read('owned/first.raw'), 'user changed completed stage')
  let sourceOpenCount = 0
  fs.open = async (...args) => { if (String(args[0]) === path.join(root, 'source.bin')) sourceOpenCount++; return originalOpen(...args) }
  const simultaneous = await Promise.all([files.stageCopy('source.bin', 'owned/same.raw'), files.stageCopy('source.bin', 'owned/same.raw')])
  fs.open = originalOpen
  check('Same-stage concurrent calls share one accepted source capture', simultaneous[0], simultaneous[1])
  check('Same-stage concurrent calls do not open/truncate the source twice', sourceOpenCount, 1)
  await rejects('Different source cannot adopt another source capture at same stage', () => files.stageCopy('short.bin', 'owned/same.raw'), /ownership differs/)
  for (const mode of ['fresh', 'cold']) for (const event of ['target-appeared', 'partial-replaced']) {
    const stage = 'owned/final-' + mode + '-' + event + '.raw', partial = stage + '.copying'
    if (mode === 'cold') {
      const stopped = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--complete-exit', root, stage], {encoding:'utf8'})
      check('Cold final-path fixture stopped after real verified completion ' + event, stopped.status, 90)
    }
    let changed = false
    fs.open = async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === path.join(root, partial) && (args[1] & constants.O_RDWR)) {
        const close = handle.close.bind(handle)
        handle.close = async () => {
          await close()
          if (!changed) {
            changed = true
            if (event === 'target-appeared') await fs.writeFile(path.join(root, stage), 'user target appeared during capture')
            else {
              await fs.writeFile(path.join(root, partial + '.user'), 'user replaced final partial')
              await originalRename(path.join(root, partial + '.user'), path.join(root, partial))
            }
          }
        }
      }
      return handle
    }
    try { await rejects(mode + ' capture preserves ' + event + ' after handle close', () => files.stageCopy('source.bin', stage), /destination appeared|partial changed/) }
    finally { fs.open = originalOpen }
    if (event === 'target-appeared') {
      check(mode + ' capture never overwrites observed new target', await files.read(stage), 'user target appeared during capture')
      if (mode === 'cold') check('Cold capture keeps its verified partial when target appears', !!await files.fileInfo(partial), true)
    } else {
      check(mode + ' capture does not move/delete replaced partial', await files.read(partial), 'user replaced final partial')
      check(mode + ' replaced partial is not a completed stage', await files.fileInfo(stage), undefined)
    }
  }
  const peer = new LocalRecordFiles(root)
  for (const target of ['stage', 'partial']) {
    const stage = 'owned/queued-' + target + '.raw', partial = stage + '.copying'
    const stopped = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--complete-exit', root, stage], {encoding:'utf8'})
    check('Queued ' + target + ' writer fixture has a real cold partial', stopped.status, 90)
    let enter, release, first = true, settled = false
    const entered = new Promise(resolve => enter = resolve), gate = new Promise(resolve => release = resolve)
    fs.open = async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === path.join(root, partial) && (args[1] & constants.O_RDWR)) {
        const read = handle.read.bind(handle)
        handle.read = async (...reads) => { if (first) { first = false; enter(); await gate }; return read(...reads) }
      }
      return handle
    }
    const capturing = files.stageCopy('source.bin', stage)
    try {
      await entered
      const logical = target === 'stage' ? stage : partial
      const queued = peer.replace(logical, 'later ordinary writer').then(() => settled = true)
      await peer.replace('independent-' + target + '.txt', 'independent progress')
      check('Same-process ' + target + ' writer waits only for that exact capture', settled, false)
      release(); await capturing; await queued
      check('Queued ordinary ' + target + ' write runs after capture and remains intact', await files.read(logical), 'later ordinary writer')
    } finally { release(); await capturing; fs.open = originalOpen }
  }
  // Create a 128MiB original using one fixed block; the test fixture itself does
  // not allocate a giant source buffer. Observe every transport read/write call.
  const singleBytes = 128 * 1024 * 1024, block = Buffer.alloc(256 * 1024), digest = createHash('sha256')
  const largeSource = path.join(root, 'large.bin'), largeHandle = await fs.open(largeSource, 'w')
  try { for (let n = 0; n < singleBytes / block.length; n++) { block.fill(n % 251); digest.update(block); await largeHandle.write(block) }; await largeHandle.sync() }
  finally { await largeHandle.close() }
  const expected = digest.digest('hex'), memoryBefore = process.memoryUsage()
  fs.open = async (...args) => {
    const handle = await originalOpen(...args), filename = String(args[0])
    if (filename === largeSource || filename.endsWith('large.raw') || filename.endsWith('large.raw.copying')) {
      handle.readFile = async () => { forbiddenWholeReads++; throw new Error('Whole-file allocation is prohibited by this streaming test') }
      const read = handle.read.bind(handle), write = handle.write.bind(handle)
      handle.read = async (buffer, offset, length, position) => { maxRead = Math.max(maxRead, length); if (filename === largeSource) sourceReads++; return read(buffer, offset, length, position) }
      handle.write = async (buffer, offset, length, position) => { maxWrite = Math.max(maxWrite, length); return write(buffer, offset, length, position) }
    }
    return handle
  }
  const large = await files.stageCopy('large.bin', 'owned/large.raw')
  check('128MiB single-file capture returns exact bytes/hash', large, {bytes:singleBytes,sha256:expected})
  check('128MiB stage hash is also streamed', await files.fingerprint('owned/large.raw'), large)
  check('No whole-file reads occur on large capture/hash path', forbiddenWholeReads, 0)
  check('Read transport window stays fixed at 256KiB', maxRead, 256 * 1024)
  check('Write transport window stays fixed at 256KiB', maxWrite, 256 * 1024)
  check('Source is read once in bounded windows plus EOF', sourceReads, singleBytes / (256 * 1024) + 1)
  const memoryAfter = process.memoryUsage()
  fs.open = originalOpen
  check('Published stage can be moved without any content copy', await files.rename('owned/large.raw', 'archive/large.bin'), true)
  check('Exact final archive still streams to the original digest', await files.fingerprint('archive/large.bin'), large)
  await files.removeDirectory('owned')
  check('Known stage cleanup leaves final archive intact', !!await files.fileInfo('archive/large.bin'), true)
  console.log(JSON.stringify({passed:checks.length,processExitPoints:3,singleBytes,maxRead,maxWrite,sourceReads,forbiddenWholeReads,memoryBefore,memoryAfter,checks,
    sourceSha256:hash(sourceText),limits:['Node24 Linux actual filesystem with controlled syscall failures; not Windows/native DSH.', 'Fixed original transfer buffers and metadata-only fileInfo are verified; caller-authored text and per-file reference metadata remain ordinary allocations.', 'Portable fs.rename is not atomic no-replace or bound to an opened handle. Final path checks and process-local queues do not exclude an external change after the last check.']},null,2))
} finally { fs.open = originalOpen; fs.rename = originalRename; hook.deregister(); await fs.rm(root,{recursive:true,force:true}) }
