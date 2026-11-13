import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evidence, hash } from './test-support/dsh-sdk-runtime.mjs'
const { Context } = await import('@deepseek-ai/cordis')
const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { FileSystemSkillProvider } = await import('@deepseek-ai/dsh-skill-filesystem')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { installFrameworkSkillProvider, readFrameworkSkillCatalog, prepareFrameworkSkillIndex,
  initializeFrameworkSkillIndex, refreshPhysicalFrameworkSkillIndex,
  frameworkSkillIndexPath, frameworkSkillControlsPath } = await import('../src/framework/skills.ts')
const variant = 'applied'
const candidate = true
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-native-format-'))
const output = process.env.DSS_SKILL_FORMAT_RESULT_DIR
if (output) await fs.mkdir(output, { recursive: true })
const assertions = [], comparisons = [], mounts = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); assertions.push(name) }
const ok = (name, actual) => { assert.ok(actual, name); assertions.push(name) }
const put = async (root, relative, body) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body) }
const definition = (name, extra = '', desc = 'Native fixture') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\nExact body for ${name}.\n\n`
const cases = []
const add = (id, extra = '', options = {}) => {
  const name = `case-${id}`
  cases.push({ id, name, text: definition(name, extra, options.desc), nativeValid: true, baselineValid: true, ...options })
}
add('defaults')
add('complete', 'whenToUse: >-\n  Use with the exact native\n  input and original context.\nmetadata:\n  owner: owner-a\n  nested:\n    values: [1, true, null, custom]\n  custom-key: unchanged\n')
add('empty-optionals', 'whenToUse: ""\nmetadata: {}\n')
add('whitespace-routing', 'whenToUse: " "\n')
add('ignored-number-optionals', 'whenToUse: 7\nmetadata: 7\n')
add('ignored-null-optionals', 'whenToUse: null\nmetadata: null\n')
add('ignored-array-metadata', 'whenToUse: [route]\nmetadata: [one, two]\n')
add('nonfinite-metadata', 'metadata:\n  positive: .inf\n  negative: -.inf\n  not-a-number: .nan\n')
add('circular-metadata', 'metadata: &self\n  owner: owner-a\n  nested: *self\n')
add('whitespace-description', '', { desc: '" "', baselineValid: false })
for (const [id, yaml, expected] of [
 ['true', 'true', true], ['false', 'false', false], ['one', '1', true], ['zero', '0', false],
 ['string-one', '"1"', true], ['string-zero', '"0"', false], ['string-true', '"true"', true], ['string-false', '"false"', false],
 ['yes', 'yes', true], ['no', 'no', false], ['on', 'on', true], ['off', 'off', false],
 ['mixed-yes', '"YeS"', true], ['mixed-no', '"nO"', false], ['caps-on', '"ON"', true], ['caps-off', '"OFF"', false],
 ['caps-true', '"TRUE"', true], ['caps-false', '"FALSE"', false],
]) add(`bool-${id}`, `disable-model-invocation: ${yaml}\nuser-invocable: ${yaml}\n`, { baselineValid: id === 'true' || id === 'false', expectedInvocation: { modelInvocable: !expected, userInvocable: expected } })
add('disable-only', 'disable-model-invocation: yes\n', { baselineValid: false, expectedInvocation: { modelInvocable: false, userInvocable: true } })
add('user-only', 'user-invocable: off\n', { baselineValid: false, expectedInvocation: { modelInvocable: true, userInvocable: false } })
for (const [id, yaml] of [['null', 'null'], ['tilde', '~'], ['empty', '""'], ['padded', '" true "'], ['two', '2'], ['negative', '-1'], ['float', '1.5'], ['array', '[]'], ['object', '{}'], ['unknown', 'maybe']]) {
 for (const [key, short] of [['disable-model-invocation', 'model'], ['user-invocable', 'user']]) add(`invalid-${short}-${id}`, `${key}: ${yaml}\n`, { nativeValid: false, baselineValid: false })
}
for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) add(`legacy-${key.toLowerCase()}`, `${key}: null\n`, { nativeValid: false, baselineValid: false })
add('missing-name', '', { text: '---\ndescription: Missing name\n---\nBody', nativeValid: false, baselineValid: false })
add('invalid-name', '', { text: definition('bad--name'), nativeValid: false, baselineValid: false })
add('empty-description', '', { desc: '""', nativeValid: false, baselineValid: false })
add('number-description', '', { desc: '7', nativeValid: false, baselineValid: false })
add('duplicate-key', 'name: duplicate-name\n', { nativeValid: false, baselineValid: false })
add('invalid-yaml', 'metadata: [unclosed\n', { nativeValid: false, baselineValid: false })
add('no-frontmatter', '', { text: '# Ordinary Markdown\n', nativeValid: false, baselineValid: false })
add('array-frontmatter', '', { text: '---\n- name: array\n- description: list\n---\nBody', nativeValid: false, baselineValid: false })
add('crlf', '', { text: definition('case-crlf', 'whenToUse: Windows line endings\nmetadata: {platform: fixture}\n').replaceAll('\n', '\r\n') })
add('closing-eof', '', { text: '---\nname: case-closing-eof\ndescription: Empty body is native\n---' })
for (const [id, transform] of [
 ['bom-extension', s => '\uFEFF' + s],
 ['dots-extension', s => s.replace('\n---\n\nExact', '\n...\n\nExact')],
 ['closing-space-extension', s => s.replace('\n---\n\nExact', '\n--- \t\n\nExact')],
]) add(id, '', { text: transform(definition(`case-${id}`)), nativeValid: false, baselineValid: true, extension: true })
const nativeRoot = path.join(scratch, 'official'), dssRoot = path.join(scratch, 'dss')
const extract = s => s && ({ name: s.name, description: s.description, whenToUse: s.whenToUse, invocation: s.invocation, metadata: s.metadata, content: s.content })
async function mount(root) {
 const ctx = new Context(); new SkillRegistry(ctx)
 const key = {}, scope = createScope(ctx, key), files = new PhysicalLocalFiles(root)
 const provider = installFrameworkSkillProvider(scope.ctx, key, files)
 for (let n = 0; n < 30 && !provider.available(); n++) await new Promise(resolve => setImmediate(resolve))
 ok('DSS provider mounts in actual native scope', provider.available())
 const value = {ctx, key, scope, files, provider, options: {scope: key}, close: async () => { await provider.dispose(); await scope.dispose(); await files.close() }}
 mounts.push(value); return value
}
let nativeScope, nativeProvider, unmountNative
try {
 for (const item of cases) {
   await put(nativeRoot, `${item.id}/SKILL.md`, item.text)
   await put(dssRoot, `skills/${item.id}/SKILL.md`, item.text)
 }
 await put(dssRoot, 'skills/history/record.json', JSON.stringify({name: 'old-record', description: 'Not a native definition', body: 'Never activate'}))
 await put(dssRoot, 'skills/history/legacy-git.json', JSON.stringify({name: 'old-git', description: 'Not a native definition', body: 'Never activate'}))
 await put(dssRoot, 'skills/history/resources/original-SKILL.md', definition('retained-resource'))
 const nativeContext = new Context(); new SkillRegistry(nativeContext)
 const nativeKey = {}; nativeScope = createScope(nativeContext, nativeKey)
 unmountNative = nativeScope.ctx.skills.registerProvider(control => nativeProvider = new FileSystemSkillProvider(nativeScope.ctx, control, {
   providerName: 'actual-native-oracle', includeDefaultRoots: false, customSkillDirs: [nativeRoot],
   dshHome: path.join(scratch, 'unused-dsh'), agentsHome: path.join(scratch, 'unused-agents'), watch: false,
 }))
 const nativeOptions = {scope: nativeKey}, nativeSnapshot = await nativeContext.skills.snapshot(nativeOptions)
 check('official fixture observation complete', nativeSnapshot.complete, true)
 const m = await mount(dssRoot), dssSnapshot = await m.ctx.skills.snapshot(m.options)
 check('DSS fixture observation complete', dssSnapshot.complete, true)
 const catalog = await readFrameworkSkillCatalog(m.files)
 for (const item of cases) {
   const official = await nativeContext.skills.get(item.name, nativeOptions)
   const loaded = await m.ctx.skills.get(item.name, m.options)
   const admitted = candidate ? item.nativeValid || item.extension === true : item.baselineValid
   check(item.id + ': official admission matches actual grammar', !!official, item.nativeValid)
   check(item.id + ': DSS admission', !!loaded, admitted)
   const summary = dssSnapshot.skills.find(s => s.name === item.name)
   const officialSummary = nativeSnapshot.skills.find(s => s.name === item.name)
   if (candidate && item.nativeValid) {
     check(item.id + ': current native definition fields preserved', extract(loaded), extract(official))
     check(item.id + ': native summary routing preserved', summary.whenToUse, officialSummary.whenToUse)
     check(item.id + ': metadata is not part of native SkillSummary', Object.hasOwn(summary, 'metadata'), false)
     check(item.id + ': metadata not forced through JSON discovery catalog', Object.hasOwn(catalog.find(s => s.name === item.name), 'metadata'), false)
   }
   if (item.expectedInvocation && official) check(item.id + ': exact native invocation default/normalization', official.invocation, item.expectedInvocation)
   if (!candidate && official && loaded && (official.whenToUse !== loaded.whenToUse || official.metadata !== undefined)) comparisons.push({id: item.id, difference: 'baseline drops optional native fields'})
   if (!!official !== !!loaded) comparisons.push({id: item.id, difference: item.extension ? 'preserved pre-existing DSS delimiter/BOM extension' : 'baseline narrower admission'})
 }
 check('legacy JSON and retained resource do not enter catalog', catalog.some(s => ['old-record','old-git','retained-resource'].includes(s.name)), false)
 check('metadata does not mount any definition into global scope', (await m.ctx.skills.list()).length, 0)
 check('metadata does not mount any definition into sibling scope', (await m.ctx.skills.list({scope:{}})).length, 0)
 // Catalog persistence and physical refresh use the real physical-files implementation.
 const transactionsUnused = {run: () => {throw new Error('Physical catalog initialization must not use transaction fallback')}}
 const init = await initializeFrameworkSkillIndex(m.files, transactionsUnused)
 check('physical catalog initialization creates derived metadata', init.status, 'created')
 const diskCatalog = JSON.parse(await fs.readFile(path.join(dssRoot, frameworkSkillIndexPath), 'utf8'))
 check('initial catalog persists only summary routing', diskCatalog.entries.find(e => e.name === 'case-complete').whenToUse,
   candidate ? 'Use with the exact native input and original context.' : undefined)
 check('valid derived catalog has no rewrite requirement', (await initializeFrameworkSkillIndex(m.files, transactionsUnused)).status, 'unchanged')
 if (candidate) {
   const circular = await m.ctx.skills.get('case-circular-metadata', m.options)
   check('native YAML self-alias remains the same object after persisted discovery', circular.metadata.nested, circular.metadata)
   const nonfinite = await m.ctx.skills.get('case-nonfinite-metadata', m.options)
   check('native Infinity is not changed to JSON null', nonfinite.metadata.positive, Infinity)
   ok('native NaN is not changed to JSON null', Number.isNaN(nonfinite.metadata['not-a-number']))
 }
 // The unchanged, old catalog schema permits absent optional fields. No blanket scan/version gate.
 const staleRoot = path.join(scratch, 'stale'), skillPath = 'skills/current/SKILL.md'
 const original = definition('current-method', 'whenToUse: Current original routing\nmetadata: {owner: owner-a, phase: original}\n')
 await put(staleRoot, skillPath, original)
 const staleRow = {path:skillPath, hash:'old-disposable-hash', name:'current-method', description:'Native fixture', invocation:{modelInvocable:true,userInvocable:true},kind:'markdown'}
 await put(staleRoot, frameworkSkillIndexPath, JSON.stringify({version:1,entries:[staleRow]}))
 const st = await mount(staleRoot)
 const oldCatalogBytes = await fs.readFile(path.join(staleRoot, frameworkSkillIndexPath))
 const scans = [], originalList = st.files.list.bind(st.files)
 st.files.list = async (...args) => { scans.push(args[1]); return originalList(...args) }
 check('old v1 absent-field catalog remains valid without a compatibility scan', (await initializeFrameworkSkillIndex(st.files, transactionsUnused)).status, 'unchanged')
 check('old v1 list initially has only its recorded summary', (await st.ctx.skills.list(st.options))[0].whenToUse, undefined)
 const staleLoaded = await st.ctx.skills.get('current-method', st.options)
 check('current get parses routing even when persisted summary is old', staleLoaded.whenToUse, candidate ? 'Current original routing' : undefined)
 check('current get parses metadata even when persisted summary is old', staleLoaded.metadata, candidate ? {owner:'owner-a',phase:'original'} : undefined)
 check('get discovery refresh repairs in-memory routing', (await st.ctx.skills.list(st.options))[0].whenToUse, candidate ? 'Current original routing' : undefined)
 check('read/get does not rewrite old catalog file', await fs.readFile(path.join(staleRoot, frameworkSkillIndexPath)), oldCatalogBytes)
 check('old catalog init/list/current get do not add a root scan', scans, [])
 const edited = definition('current-method', 'whenToUse: Updated routing\nmetadata: {owner: owner-b, phase: changed}\n')
 await put(staleRoot, skillPath, edited)
 const changed = await st.ctx.skills.get('current-method', st.options)
 check('same-name get observes changed current routing', changed.whenToUse, candidate ? 'Updated routing' : undefined)
 check('same-name get observes changed current metadata', changed.metadata, candidate ? {owner:'owner-b',phase:'changed'} : undefined)
 check('same-name get updates later native summaries', (await st.ctx.skills.list(st.options))[0].whenToUse, candidate ? 'Updated routing' : undefined)
 check('normal physical refresh reports no issues', await refreshPhysicalFrameworkSkillIndex(st.files, [skillPath]), [])
 const refreshed = JSON.parse(await fs.readFile(path.join(staleRoot, frameworkSkillIndexPath),'utf8'))
 check('normal physical refresh persists routing', refreshed.entries[0].whenToUse, candidate ? 'Updated routing' : undefined)
 st.provider.replaceCatalog(await readFrameworkSkillCatalog(st.files)); st.provider.notifyCatalogChange()
 check('shared refreshed catalog reaches native list', (await st.ctx.skills.list(st.options))[0].whenToUse, candidate ? 'Updated routing' : undefined)
 const staged = definition('staged-method', 'whenToUse: Staged routing\nmetadata: &self\n  next: *self\nuser-invocable: yes\n')
 const snapshot = await st.files.snapshot()
 let prepared
 try {prepared = await prepareFrameworkSkillIndex(st.files,snapshot,[{path:'skills/staged/SKILL.md',content:staged}])} finally {await snapshot.release()}
 if(candidate) {
   check('staged shared index path accepts native booleans and circular metadata',prepared.issues,[])
   check('staged catalog is JSON without silently serializing metadata',JSON.parse(prepared.changes[0].content).entries.find(e=>e.name==='staged-method').whenToUse,'Staged routing')
 }
 await put(staleRoot, skillPath, definition('current-method'))
 const absent = await st.ctx.skills.get('current-method', st.options)
 check('removed whenToUse does not survive on loaded definition', Object.hasOwn(absent, 'whenToUse'), false)
 check('removed metadata does not survive on loaded definition', Object.hasOwn(absent, 'metadata'), false)
 check('removed whenToUse does not survive in-memory refresh', Object.hasOwn((await st.ctx.skills.list(st.options))[0], 'whenToUse'), false)
 // Malformed optional cache metadata must not invent a whole-root rejection gate.
 await put(staleRoot, frameworkSkillIndexPath, JSON.stringify({version:1,entries:[{...staleRow,whenToUse:7}]}))
 st.provider.invalidate()
 const permissive = await st.ctx.skills.snapshot(st.options)
 if(candidate) {
  check('invalid optional cached routing is ignored like native optional field',permissive.complete,true)
  check('invalid optional cached routing does not hide valid skill',permissive.skills.map(s=>s.name),['current-method'])
  check('invalid optional cached routing is not forwarded to native registry',Object.hasOwn(permissive.skills[0],'whenToUse'),false)
 }
 await put(staleRoot, skillPath, definition('renamed-method','whenToUse: Renamed routing\nmetadata: {owner: another-owner}\n'))
 check('rename never returns new identity as old requested name',await st.ctx.skills.get('current-method',st.options),undefined)
 check('rename refresh discovers new native identity',(await st.ctx.skills.list(st.options)).map(s=>s.name),['renamed-method'])
 check('renamed current definition loads metadata',(await st.ctx.skills.get('renamed-method',st.options)).metadata,candidate?{owner:'another-owner'}:undefined)
 await put(staleRoot,frameworkSkillControlsPath,JSON.stringify({version:1,entries:{[skillPath]:{status:'disabled'}}}))
 check('current disabled control still prevents get after cached list',await st.ctx.skills.get('renamed-method',st.options),undefined)
 check('disabled control still prevents list after refresh',(await st.ctx.skills.list(st.options)).length,0)
 for (const item of cases) check(item.id + ': source definition bytes stay untouched', await fs.readFile(path.join(dssRoot,`skills/${item.id}/SKILL.md`),'utf8'), item.text)
 const result = {status:'passed',variant,assertions:assertions.length,names:assertions,fixtureCases:cases.length,
   comparisons,limits:['No live Agent/model, Windows/device, Git transport, full project build or typecheck.','DSS pre-existing BOM/dots/trailing-space delimiter extensions are retained.','Existing v1 optional fields refresh on current get or ordinary refresh; no global cache scan.'],
   ...evidence(),scriptHash:hash(readFileSync(fileURLToPath(import.meta.url)))}
 if (output) await fs.writeFile(path.join(output,variant+'-result.json'),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result))
} catch(error) {
 if (output) await fs.writeFile(path.join(output,variant+'-failure.json'),JSON.stringify({status:'failed',variant,assertions:assertions.length,names:assertions,error:{message:error.message,stack:error.stack},...evidence()},null,2)+'\n')
 throw error
} finally {
 for(const m of mounts.reverse()) await m.close()
 unmountNative?.();await nativeProvider?.dispose();await nativeScope?.dispose()
 await fs.rm(scratch,{recursive:true,force:true})
}
