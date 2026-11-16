import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
const source = fileURLToPath(new URL('../src/', import.meta.url))
const host = path.resolve(process.env.DSH_TEST_PACKAGES || '../../dss-linux-actual-20261114/host-rc3/node_modules/@deepseek-ai')
const { Context } = await import(pathToFileURL(path.join(host, 'cordis/lib/index.js')))
const { LocalAttachmentStore } = await import(pathToFileURL(path.join(host, 'dsh-attachment-local/lib/index.js')))
const hostVersion = JSON.parse(await fs.readFile(path.join(host, 'dsh/package.json'), 'utf8')).version
const built = await build({ stdin: { contents: `export { uploadNativeLocalAttachment } from ${JSON.stringify(path.join(source, 'framework/native-local-attachment-upload.ts'))}`, resolveDir: source, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
const { uploadNativeLocalAttachment } = module.exports
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-official-upload-'))
const ctx = new Context()
const native = new LocalAttachmentStore(ctx, { dshHome: sandbox })
const names = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const bytes = Buffer.from('browser original \u0000 exact bytes')
const metadata = { collaborationId: 'qa', name: 'source.txt', mimeType: 'text/plain', bytes: bytes.length }
async function* chunks(data) { yield data.subarray(0,3); yield data.subarray(3) }
const list = async dir => { const result=[]; for(const item of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])) {const p=path.join(dir,item.name);if(item.isDirectory())result.push(...await list(p));else result.push(p)}return result }
try {
  const ref = await uploadNativeLocalAttachment(native,metadata,chunks(bytes))
  check('Official DSH rc3 native store preserved exact selected bytes', await fs.readFile(ref.path), bytes)
  check('Existing Local reference points inside native Host attachment root', ref.path.startsWith(path.join(sandbox,'attachments','v1','files') + path.sep), true)
  check('Local reference remains original contract', [ref.mode,ref.version,ref.name,ref.bytes], ['local',2,'source.txt',bytes.length])
  const before = await list(sandbox)
  const again = await uploadNativeLocalAttachment(native,metadata,chunks(bytes))
  check('Repeated same file uses native content-addressed storage, no extra files', [again.path,await list(sandbox)], [ref.path,before])
  const sanitized = await uploadNativeLocalAttachment(native,{...metadata,name:'../client/source.txt'},chunks(bytes))
  check('Official sanitizer strips client directory', [sanitized.name,sanitized.path], ['source.txt',ref.path])
  const empty = await uploadNativeLocalAttachment(native,{...metadata,name:'empty.txt',bytes:0},chunks(Buffer.alloc(0)))
  check('Empty file is retained as a valid zero-byte original', (await fs.stat(empty.path)).size,0)
  const bad = Buffer.from('interrupted browser stream')
  async function* interrupted() { yield bad; throw new Error('source stream interrupted') }
  await assert.rejects(()=>uploadNativeLocalAttachment(native,metadata,interrupted()), e => e.code === 'ATTACHMENT_WRITE_FAILED' && /stream interrupted/.test(e.cause?.message))
  names.push('Official storage propagates a failed source stream without a new length gate')
  const badHash=createHash('sha256').update(bad).digest('hex')
  check('Interrupted stream left no content-addressed original', (await list(sandbox)).some(p=>p.includes(badHash)),false)
  const abort=new AbortController();abort.abort(new Error('cancelled selection'))
  await assert.rejects(()=>uploadNativeLocalAttachment(native,metadata,chunks(bytes),abort.signal),/cancelled selection/)
  names.push('Cancelled selection preserves AbortSignal failure')
  check('Published history original survives subsequent failures/cancellation', await fs.readFile(ref.path),bytes)
  console.log(JSON.stringify({status:'passed',hostVersion,assertions:names.length,names,limits:'Real official LocalAttachmentStore in isolated scratch storage, not browser/HTTP/UI or model execution.'},null,2))
} finally { await fs.rm(sandbox,{recursive:true,force:true}) }
