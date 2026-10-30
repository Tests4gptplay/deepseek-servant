import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runGit, GitError } from '../src/experimental/private-git/vendor/git-runner.js'

test('Git runner aborts a stalled child at the requested operation deadline, not an output-size threshold', async t => {
  let options:any, killed:string|undefined
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill(signal:string){killed=signal;queueMicrotask(()=>child.emit('close',null,signal));return true}})
  t.mock.method(childProcess,'spawn',(...args:any[])=>{options=args[2];return child as any})
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
  const keepAlive=setTimeout(()=>{},1000)
  try{await assert.rejects(runGit('git',['fetch'],{cwd:process.cwd(),timeoutMs:20}),error=>error instanceof GitError&&error.code===124&&/timed out/.test(error.message))}
  finally{clearTimeout(keepAlive)}
  assert.equal(killed,'SIGTERM');assert.equal(options.shell,undefined);assert.equal(options.maxBuffer,undefined)
})

test('Git runner executes ordinary commands, reports true exit failures and respects cancellation', async () => {
  const result=await runGit('git',['--version'],{cwd:process.cwd()});assert.equal(result.code,0);assert.match(result.stdout,/git version/)
  await assert.rejects(runGit('git',['dss-nonexistent-command'],{cwd:process.cwd()}),error=>error instanceof GitError&&error.code!==0)
  const controller=new AbortController();controller.abort()
  await assert.rejects(runGit('git',['--version'],{cwd:process.cwd(),signal:controller.signal}),error=>(error as Error).name==='AbortError')
})

test('Git runner returns a real 65 MiB Git blob intact without the former 64 MiB rejection',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dss-git-large-output-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const bytes=Buffer.alloc(65*1024*1024,0x61);await writeFile(join(root,'payload'),bytes)
  await runGit('git',['init','--bare','.'],{cwd:root})
  const blob=(await runGit('git',['hash-object','-w','payload'],{cwd:root})).stdout.trim()
  const result=await runGit('git',['show',blob],{cwd:root})
  assert.equal(Buffer.byteLength(result.stdout),bytes.length)
  const expected=createHash('sha256').update(bytes).digest('hex')
  assert.equal(createHash('sha256').update(result.stdout).digest('hex'),expected)
  console.log(JSON.stringify({case:'real-large-git-blob',bytes:bytes.length,sha256:expected,exitCode:result.code}))
})
