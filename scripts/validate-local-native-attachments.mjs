import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Production Local file and attachment modules against real Linux scratch
// originals. Native DSH image persistence and UI carrier are controlled ports;
// this checks their input/output contract, not actual DSH visual projection.
const root = new URL('../src/', import.meta.url), loaded = new Map()
const schema = `const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw new Error("Markdown parsing is outside this attachment check")}', shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-llm') return { url: 'data:text/javascript,export class HarnessError extends Error { constructor(message,code,options){super(message,options);this.code=code;this.name=new.target.name} }', shortCircuit: true }
    if (specifier === 'zod') return { url: 'data:text/javascript;base64,' + Buffer.from(schema).toString('base64'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/role-tools.ts', root).href) return { url: 'data:text/javascript,export function workerPaths(){throw new Error("Worker task path construction is outside this check")}', shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      loaded.set(url.slice(root.href.length), createHash('sha256').update(source).digest('hex'))
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const { ConversationAttachments } = await import('../src/framework/conversation-attachments.ts')
const { validateConversationAttachment, LocalAttachmentError } = await import('../src/framework/conversation-attachment-reference.ts')
const { prepareNativeConversationAttachment, prepareNativeLocalAttachment } = await import('../src/adapters/dsh/attachments.ts')
const { ConversationAttachmentDrafts, selectedLocalAttachmentPath, attachmentFetch, uploadConversationAttachment, prepareConversationAttachmentDownload } = await import('../src/framework/client-attachments.ts')
const { frameworkErrorText, installClientErrorReporter } = await import('../src/framework/client-error.ts')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-native-attachments-'))
const snapshot = { revision: 'controlled', release: async () => {} }
const names = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected); names.push(name) }
const rejects = async (name, action, match) => { await assert.rejects(action, match); names.push(name) }
const noStore = new Proxy({}, { get(_target, key) { return () => { throw new Error('Local must not access DSS stored bytes: ' + String(key)) } } })
const local = new ConversationAttachments(noStore, noStore, { mode: 'local', collaborationId: 'c' })
const selection = filename => ({ mode: 'local', collaborationId: 'c', selectionId: 's', path: filename, name: path.basename(filename), mimeType: 'text/plain' })
const noNative = { get: () => undefined }
const execution = () => ({ agent: { id: 'actual-current-agent' }, signal: new AbortController().signal, token: Symbol('current-tool'), rootCallId: 'root-call', callId: 'attachment-call', deferContext() {}, concludeTurn() {} })
try {
  // Official Desktop rc.5 supplies ownsHost/streamBaseUrl but no fetch hook.
  // Its relative HTTP bridge is the same route used by the native client RPC.
  const desktopTransport = { ownsHost: true, streamBaseUrl: 'dsh-app://app/' }
  const uploadFile = new Blob(['desktop bytes']), requests = []
  const desktopFetch = async (url, init) => {
    requests.push({ url, init })
    return init.method === 'POST' ? Response.json({ attachment: 'controlled Git receipt' })
      : new Response(uploadFile, { headers: { 'content-length': String(uploadFile.size) } })
  }
  const selectedFetch = attachmentFetch(desktopTransport, desktopFetch)
  check('Official Desktop without fetch keeps its document-relative carrier', selectedFetch, desktopFetch)
  await uploadConversationAttachment(selectedFetch, { mode: 'git', bytes: uploadFile.size, name: 'desktop.txt' }, uploadFile, new AbortController().signal)
  check('Desktop Git upload uses original relative Host endpoint', requests[0].url.startsWith('api/deepseek-servant-framework/upload-attachment?metadata='), true)
  check('Desktop Git upload preserves actual original Blob', requests[0].init.body, uploadFile)
  const download = await prepareConversationAttachmentDownload(desktopTransport,
    { downloadUrl: '/api/deepseek-servant-framework/attachment?ref=actual', mimeType: 'text/plain', bytes: uploadFile.size },
    createHash('sha256').update('desktop bytes').digest('hex'), new AbortController().signal, desktopFetch)
  check('Desktop Git download uses same relative Host endpoint', requests[1].url, 'api/deepseek-servant-framework/attachment?ref=actual')
  check('Desktop Git download returns verified original body', await (await fetch(download.downloadUrl)).text(), 'desktop bytes')
  URL.revokeObjectURL(download.downloadUrl)
  const hooked = { marker: 'bound', fetch() { return this.marker } }
  check('An existing explicit fetch hook still owns its carrier', attachmentFetch(hooked, desktopFetch)(), 'bound')
  const textPath = path.join(sandbox, 'source.txt')
  await fs.writeFile(textPath, 'first text')
  const ref = await local.selectLocal(selection(textPath))
  check('Local reference is exact original path', ref.path, textPath)
  check('Local reference format has no hash/version lock', [ref.version, ref.sha256], [2, undefined])
  await local.initialize(); await local.validateReferences(snapshot, [ref]); names.push('Local select/initialize/send-validation perform no DSS writes or manifest reads')
  let response = await prepareNativeLocalAttachment(noNative, ref, execution())
  check('Local ordinary file returns exact path for existing Host tools', [response.delivery, JSON.parse(response.content[1].text).path], ['local-file-path', textPath])
  await fs.writeFile(textPath, 'edited original with more bytes')
  response = await prepareNativeLocalAttachment(noNative, ref, execution())
  check('Normal edit keeps original path without claiming an unread current size', JSON.parse(response.content[1].text), { path: textPath })
  await fs.writeFile(path.join(sandbox, 'replacement'), 'atomic replacement')
  await fs.rename(path.join(sandbox, 'replacement'), textPath)
  response = await prepareNativeLocalAttachment(noNative, ref, execution())
  check('Atomic replacement keeps original path without version gate or extra read', JSON.parse(response.content[1].text), { path: textPath })
  check('Returned grant remains exact original reference', response.reference, ref)
  const spacedPath = path.join(sandbox, ' saved original ')
  await fs.writeFile(spacedPath, 'space preserved')
  const spaced = await local.selectLocal(selection(spacedPath))
  check('Native filename is preserved without Git filename sanitization', validateConversationAttachment(spaced).name, ' saved original ')
  await fs.writeFile(textPath, Buffer.from([0, 255, 1, 2]))
  response = await prepareNativeLocalAttachment(noNative, ref, execution())
  check('Binary file stays original-path delivery, no FileBlock copy', response.delivery, 'local-file-path')
  check('Binary result exposes only exact selected path', JSON.parse(response.content[1].text).path, textPath)
  const realFakepathDirectory = path.join(sandbox, 'fakepath')
  await fs.mkdir(realFakepathDirectory)
  const validFakepath = path.join(realFakepathDirectory, 'original.txt')
  await fs.writeFile(validFakepath, 'real file')
  check('Actual directory named fakepath is not blacklisted', (await local.selectLocal(selection(validFakepath))).path, validFakepath)
  check('Ordinary file result has no paging or added read limit', ['nextOffsetBytes','offsetBytes','maximumBytes','text'].some(key=>key in JSON.parse(response.content[1].text)), false)
  await rejects('Directory is not a regular attachment', () => local.selectLocal(selection(sandbox)), LocalAttachmentError)
  await rejects('Missing original is per-attachment error', () => local.selectLocal(selection(path.join(sandbox, 'missing'))), LocalAttachmentError)
  await rejects('Local raw upload is rejected before storing any bytes', () => local.upload({ mode: 'local', collaborationId: 'c', uploadId: 's', name: 'x', mimeType: 'text/plain', bytes: 1 }, (async function*(){yield Buffer.from('x')})()), /Only Git accepts/)
  assert.throws(() => validateConversationAttachment({ ...ref, version: 1, source: 'conversation-attachment' }), LocalAttachmentError); names.push('Old Local attachment compatibility is absent')
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'))
  await rejects('Cancellation preserves AbortSignal reason', () => local.selectLocal(selection(textPath), cancelled.signal), /cancelled/)
  let images = 0, files = 0, imageBytes
  const native = { imageLimits: { maxImageBytes: 1024 }, saveImage: async input => { images++; imageBytes = input.data; return { attachmentId: 'native:image', bytes: input.data.byteLength, mediaType: input.mediaType } }, saveFileStream: async () => { files++; throw new Error('No Local file copy') } }
  // Controlled official read_image boundary; host policy/model/decoder tests are
  // separate from this scratch-original routing check.
  const ctx = { get: name => name === 'attachments' ? native : undefined, tools: { execute: async input => {
    assert.equal(input.name, 'read_image'); assert.equal(input.agent.id, 'actual-current-agent')
    assert.equal(typeof input.parent, 'symbol'); assert.equal(input.rootCallId, 'root-call')
    try {
      const data = await fs.readFile(input.arguments.file_path)
      if (data.byteLength > native.imageLimits.maxImageBytes) throw new Error('actual image provider limit')
      const image = await native.saveImage({ data, mediaType: 'image/png' })
      return { isError: false, value: { path: input.arguments.file_path }, content: [{type:'text',text:'Actual native controlled result'}, {type:'image',attachment:image}] }
    } catch (error) { return { isError:true, error:{message:error.message}, content:[{type:'text',text:error.message}] } }
  } } }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XkAAAAASUVORK5CYII=', 'base64')
  const imagePath = path.join(sandbox, 'image.png'); await fs.writeFile(imagePath, png)
  const imageRef = await local.selectLocal({ ...selection(imagePath), mimeType: 'image/png' })
  response = await prepareNativeLocalAttachment(ctx, imageRef, execution())
  check('Local image reaches current Host tool with actual original bytes', Buffer.from(imageBytes), png)
  check('Local image emits native ImageBlock, not URI text', [response.delivery, response.content[1].type, response.content[1].attachment.attachmentId], ['image-content', 'image', 'native:image'])
  check('Local native route does not saveFileStream', [images, files], [1, 0])
  native.imageLimits.maxImageBytes = 16
  await rejects('Actual current provider image byte limit is enforced', () => prepareNativeLocalAttachment(ctx, imageRef, execution()), /actual image provider limit/)
  await rejects('Absent native image provider fails this image only', () => prepareNativeLocalAttachment(noNative, imageRef, execution()), LocalAttachmentError)
  await fs.unlink(imagePath)
  await rejects('Deleted original preserves native missing-file result without fallback', () => prepareNativeLocalAttachment(ctx, imageRef, execution()), /ENOENT/)
  let faults = 0; const uninstall = installClientErrorReporter(() => faults++)
  check('Per-attachment failure remains visible', frameworkErrorText(new LocalAttachmentError('select original')), 'select original')
  check('Per-attachment failure does not trigger global reporter', faults, 0); uninstall()

  const file = new File(['text'], 'source.txt', { type: 'text/plain' }), pasted = new File(['pixels'], 'image.png', { type: 'image/png' })
  globalThis.__DSH_HOST_PATHS__ = { pathFor: f => f === file ? textPath : '' }
  check('Client consumes official desktop pathFor only', selectedLocalAttachmentPath(file), textPath)
  assert.throws(() => selectedLocalAttachmentPath(pasted), LocalAttachmentError); names.push('Pathless pasted File fails only that selection')
  const receipt = { attachment: ref, storageScope: 'scope' }, calls = []
  const drafts = new ConversationAttachmentDrafts({ selectLocalAttachment: async input => { calls.push(input); return receipt } })
  drafts.add('local', { mode: 'local', collaborationId: 'c', storageScope: 'scope' }, [file, pasted])
  for (let i=0; i<30 && drafts.selections('local').some(r => r.state === 'queued' || r.state === 'uploading'); i++) await new Promise(resolve => setTimeout(resolve, 2))
  check('Local selection works on RPC-only API with no raw uploader', drafts.selections('local').map(row => row.state), ['ready', 'error'])
  check('Client sends only path metadata, no Blob payload', [calls.length, calls[0].path, 'bytes' in calls[0]], [1, textPath, false])
  check('No path selection error is visible on its own row', !!drafts.selections('local')[1].error, true)
  // Local RPCs run independently, while the row order remains the selection order.
  const secondFile = new File(['other'], 'second.txt', {type:'text/plain'})
  globalThis.__DSH_HOST_PATHS__ = {pathFor:f=>f===file?textPath:f===secondFile?path.join(sandbox,'second.txt'):''}
  const concurrentCalls = [], resolvers = []
  const concurrent = new ConversationAttachmentDrafts({selectLocalAttachment: input=> {concurrentCalls.push(input);return new Promise(resolve=>resolvers.push(resolve))}})
  concurrent.add('parallel',{mode:'local',collaborationId:'c',storageScope:'scope'},[file,secondFile])
  await new Promise(resolve=>setTimeout(resolve,0))
  check('Local selection RPCs start without waiting for another selection',concurrentCalls.length,2)
  resolvers[1]({attachment:{...ref,path:path.join(sandbox,'second.txt'),name:'second.txt'},storageScope:'scope'})
  await new Promise(resolve=>setTimeout(resolve,0))
  check('Out-of-order Local receipt preserves original selected row order',concurrent.selections('parallel').map(row=>[row.file.name,row.state]),[['source.txt','uploading'],['second.txt','ready']])
  resolvers[0](receipt); await new Promise(resolve=>setTimeout(resolve,0))
  // An outstanding selection cannot move into another composer or reappear
  // after Remove. A repeated retry keeps the original selection identity.
  let resolvePending
  const pendingCalls = []
  const delayed = new ConversationAttachmentDrafts({ selectLocalAttachment: input => { pendingCalls.push(input); return new Promise(resolve => { resolvePending = resolve }) } })
  delayed.add('first', { mode: 'local', collaborationId: 'c', storageScope: 'scope' }, [file])
  await new Promise(resolve => setTimeout(resolve, 0))
  const removed = delayed.selections('first')[0]
  delayed.remove('first', removed.id); resolvePending(receipt)
  await new Promise(resolve => setTimeout(resolve, 0))
  check('Removed pending original is not restored by late receipt', delayed.selections('first'), [])
  check('Selection never moves to another conversation draft', delayed.selections('other'), [])
  let attempt = 0; const retryIds = []
  const retrying = new ConversationAttachmentDrafts({ selectLocalAttachment: async input => { retryIds.push(input.selectionId); if (++attempt === 1) throw new LocalAttachmentError('temporary missing original'); return receipt } })
  retrying.add('r', { mode: 'local', collaborationId: 'c', storageScope: 'scope' }, [file])
  await new Promise(resolve => setTimeout(resolve, 0)); retrying.retry('r', retrying.selections('r')[0].id)
  await new Promise(resolve => setTimeout(resolve, 0))
  check('Retry keeps exact selection identity', [retrying.selections('r')[0].state, retryIds[0] === retryIds[1]], ['ready', true])
  delete globalThis.__DSH_HOST_PATHS__

  // Invoke the actual service methods without booting unrelated agents or
  // installed DSH providers. Only access/config/native open are controlled.
  const serviceSource = readFileSync(new URL('framework/service.ts', root), 'utf8')
  const serviceJs = stripTypeScriptTypes(serviceSource, { mode: 'transform' })
  loaded.set('framework/service.ts', createHash('sha256').update(serviceSource).digest('hex'))
  const method = name => {
    const match = new RegExp('\\n    (?:async )?' + name + '\\(').exec(serviceJs)
    assert.ok(match)
    const start = match.index + 1, next = /\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(serviceJs.slice(start + match[0].length))
    assert.ok(next)
    return serviceJs.slice(start, start + match[0].length + next.index)
  }
  const z = new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return z},apply(){return z}})
  const Service = new Function('z','LocalAttachmentError','validateConversationAttachment', 'return class {\n' + ['selectLocalAttachment','openLocalAttachment'].map(method).join('\n') + '\n}')(z,LocalAttachmentError,validateConversationAttachment)
  const service = new Service(), opened = [], active = { connection:{scope:'scope'}, conversation:{scope:{mode:'local',collaborationId:'c'},attachments:local} }
  service.access = async mode => { assert.equal(mode,'local'); return active }
  service.checkScope = (_active,scope) => assert.equal(scope,'scope')
  service.config = () => ({settings:{collaborationId:'c'}})
  service.ctx = {get:()=>({canOpenWorkspacePath:()=>true,openWorkspacePath:async input=>opened.push(input.path)})}
  const serviceReceipt = await service.selectLocalAttachment({...selection(textPath),storageScope:'scope'})
  check('Actual service Local selection returns same original',serviceReceipt.attachment.path,textPath)
  await service.openLocalAttachment({mode:'local',collaborationId:'c',storageScope:'scope',reference:serviceReceipt.attachment})
  check('Actual service native open receives selected path',opened,[textPath])
  await rejects('Actual service rejects wrong conversation',()=>service.selectLocalAttachment({...selection(textPath),collaborationId:'other',storageScope:'scope'}),LocalAttachmentError)
  const transportSource = readFileSync(new URL('framework/transport.ts', root),'utf8')
  check('Both Local RPC routes registered', ['selectLocalAttachment','openLocalAttachment'].every(name=>transportSource.includes("'"+name+"'") && transportSource.includes('service.'+name+'(')),true)
  const clientSource = readFileSync(new URL('client.tsx',root),'utf8')
  check('Client Local RPC stays independent of the Git byte transport', clientSource.includes("selectLocalAttachment: (input, signal) => call('selectLocalAttachment'") && !clientSource.includes('...(rawAttachmentFetch ?'),true)
  const map = new Map(), store = { read: async(_s,p)=>map.has(p)?Buffer.from(map.get(p)).toString():undefined,
    readBytes: async(_s,p)=>map.get(p), snapshot: async()=>snapshot, prefetch: async()=>{} }
  const transactions = { run: async(_id,_body,_options,build)=> { for (const change of await build(snapshot)) map.set(change.path, change.bytes ?? Buffer.from(change.content)) } }
  const git = new ConversationAttachments(store, transactions, { mode: 'git', collaborationId: 'c' })
  const gitRef = await git.upload({ mode: 'git', collaborationId: 'c', uploadId: 'g', name: 'git.txt', mimeType: 'text/plain', bytes: 3 }, (async function*(){ yield Buffer.from('git') })())
  check('Git reference remains v1 repository original', [gitRef.version, gitRef.mode, gitRef.path.startsWith('conversations/git/c/attachments/')], [1,'git',true])
  check('Git original still verifies expected SHA-256', Buffer.from((await git.readAt(snapshot, gitRef)).data).toString(), 'git')
  check('Git retains its marker, manifest and original independently', map.size, 3)
  const gitNative = { imageLimits:{maxImageBytes:1024}, saveFileStream: async input => { let data=Buffer.alloc(0); for await(const chunk of input.data)data=Buffer.concat([data,chunk]); return { bytes:data.length, attachmentId:'sha256:'+createHash('sha256').update(data).digest('hex') } } }
  response = await prepareNativeConversationAttachment({get:()=>gitNative},git,snapshot,gitRef,new AbortController().signal)
  check('Git continues actual native FileBlock contract', response.content[1].type, 'file')
  console.log(JSON.stringify({ passed: names.length, checks: names, limits: ['Linux temporary files only', 'Controlled native saveImage/FileBlock port, not real DSH decoder or model vision', 'No installed desktop UI or Windows file picker verification', 'No full dependency typecheck or build'], loaded: Object.fromEntries(loaded) }, null, 2))
} finally { await fs.rm(sandbox, { recursive: true, force: true }); hooks.deregister() }
