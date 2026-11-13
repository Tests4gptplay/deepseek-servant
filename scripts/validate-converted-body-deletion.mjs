import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Repository-frozen v44-derived SQL writer -> current converter -> physical
// body, then actual Service access, prepare and send.
// Installed Koffi/Zod/Markdown packages are used; only .js -> .ts source
// resolution is supplied by this harness.
const root = new URL('../src/', import.meta.url)
const baseline = new URL('./test-support/historical-v44/conversation-producer/src/', import.meta.url)
const baselineHashes = JSON.parse(readFileSync(new URL('./test-support/historical-v44/conversation-producer/SOURCE.json', import.meta.url))).files
const hash = value => createHash('sha256').update(value).digest('hex'), loaded = new Map(), oldLoaded = new Map()
const hooks = registerHooks({
 resolve(specifier, context, next) {
  if (specifier.startsWith('.') && [root, baseline].some(base => context.parentURL?.startsWith(base.href)) && specifier.endsWith('.js')) {
   const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
   if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
 },
 load(url, context, next) {
  const base = [root, baseline].find(base => url.startsWith(base.href))
  if (base && url.endsWith('.ts')) {
   const source = readFileSync(new URL(url), 'utf8'), relative = url.slice(base.href.length), sum = hash(source)
   if (base === baseline) { assert.equal(sum, baselineHashes['src/' + relative], 'Exact v44 source: ' + relative); oldLoaded.set(relative, sum) }
   else loaded.set(relative, sum)
   return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
 }
})
const { FrameworkService } = await import('../src/framework/service.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { LocalRecordFiles } = await import('../src/framework/local-record-files.ts')
const { restoreLegacyConversationScope, localConversationUpgradeKey } = await import('../src/framework/local-upgrade-conversation.ts')
const { FrameworkConversation: OldConversation } = await import(new URL('framework/conversation.ts', baseline))
const { FrameworkTransactions: OldTransactions } = await import(new URL('framework/command-transactions.ts', baseline))
const { LocalFiles: OldFiles } = await import(new URL('framework/local-files.ts', baseline))
class Records {
 constructor(directory) { this.files = new LocalRecordFiles(directory); this.onSet = undefined }
 async get(key) { const raw = await this.files.read(hash(key) + '.json'); return raw === undefined ? undefined : JSON.parse(raw) }
 async set(key, value) { await this.files.replace(hash(key) + '.json', JSON.stringify(value)); await this.onSet?.(key, value) }
 async delete(key) { return this.files.delete(hash(key) + '.json') }
 async list() { throw Error('The addressed conversation must not scan all Host records') }
}
const names = [], check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); names.push(name) }
const scope = { mode: 'local', collaborationId: 'old-chat' }, ids = ['first', 'second', 'third']
const originalTexts = ['\uFEFF原文😀\r\n\0keep', '', '后来的输入']
const disk = directory => new Records(directory + '-records')
async function seed(directory) {
 const files = await OldFiles.open(directory), records = disk(directory), transactions = new OldTransactions(files, records, 'v44-source')
 const old = new OldConversation(files, transactions, scope)
 for (let i = 0; i < ids.length; i++) await old.send('v44-' + ids[i], { id: ids[i], participantId: 'old-user', createdAt: `2026-11-07T00:00:0${i}.000Z`, role: 'user', recipient: 'ai', text: originalTexts[i] })
 await files.close()
 return records
}

const expected = process.env.DSS_EXPECT_RECOVERED === '1'
if(process.argv[2] === '--converted-stop') {
 const directory=process.argv[3], records=disk(directory)
 records.onSet=(_key,value)=>{if(value.kind==='dss-once-conversation-full-text' && value.converted.length===1 && value.status!=='complete') process.kill(process.pid,'SIGKILL')}
 await restoreLegacyConversationScope(directory,scope.collaborationId,records)
 throw Error('Actual converted-entry save boundary not reached')
}
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-converted-body-deletion-'))
try {
 const records=await seed(scratch), sqlBefore=hash(await fs.readFile(path.join(scratch,'dss-files.sqlite')))
 const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--converted-stop',scratch],{encoding:'utf8',timeout:30000})
 check('Actual stopped process',child.signal,'SIGKILL')
 const state=await records.get(localConversationUpgradeKey(scratch,scope.collaborationId))
 check('One complete entry is actually durable',state.converted.length,1)
 check('Scope has not completed',state.status==='complete',false)
 const entryPath=state.converted[0], entry=JSON.parse(await fs.readFile(path.join(scratch,entryPath),'utf8'))
 check('Current entry references physical full text',entry.textPath.endsWith('/text.txt'),true)
 check('Published body contains exact original',await fs.readFile(path.join(scratch,entry.textPath),'utf8'),originalTexts[0])
 await fs.unlink(path.join(scratch,entry.textPath))
 const restored=await restoreLegacyConversationScope(scratch,scope.collaborationId,disk(scratch))
 check('Normal deleted-body resume outcome',restored.status,expected?'complete':'incomplete')
 if(!expected)check('Original body gate explains failure',restored.issues.some(i=>i.message==='The already-converted physical message body is missing.'),true)
 check('Deletion stays deleted',existsSync(path.join(scratch,entry.textPath)),false)
 check('Actual original SQL is unchanged',hash(await fs.readFile(path.join(scratch,'dss-files.sqlite'))),sqlBefore)
 const settings={name:'DSS',userName:'user',localDirectory:scratch,ownerRepo:'',repositoryDirectory:'',collaborationId:scope.collaborationId,workerSeats:0,workspace:''}
 const service=new FrameworkService({},disk(scratch),settings)
 service.saved.set('local',{revision:'fixture',settings})
 try{
  const access=await service.access('local')
  check('Real Service opens physical Local access',access.connection.files instanceof PhysicalLocalFiles,true)
  const newMessage={mode:'local',collaborationId:scope.collaborationId,storageScope:access.connection.scope,id:'new-after-recovery',createdAt:'2026-11-11T00:00:00Z',text:'New request after preserved deletion',recipient:'ai',device:'dsh-web'}
  if(!expected){
   check('Pending Service retains old read-only view',!!access.legacyConversation,true)
   await assert.rejects(()=>service.send(newMessage),/This conversation conversion is incomplete/)
  }else{
   await service.send(newMessage)
   check('Real Service prepare retires old read-only view',access.legacyConversation,undefined)
   const files=access.connection.files,conversation=access.conversation,snapshot=await files.snapshot()
   try{
    const index=JSON.parse(await files.read(snapshot,conversation.indexPath))
    check('Real Service sendStored accepts new message',index.messages.map(row=>row.id),[...ids,'new-after-recovery'])
    for(let i=1;i<ids.length;i++){
     const retained=JSON.parse(await files.read(snapshot,index.messages[i].path))
     check('Pending old body was restored '+ids[i],await files.read(snapshot,retained.textPath),originalTexts[i])
    }
   }finally{await snapshot.release()}
   check('New-day page can read later user message',(await conversation.page(10,undefined,{date:'2026-11-11'})).messages.map(row=>row.id),['new-after-recovery'])
   await assert.rejects(()=>conversation.page(10),/Original message text is missing/)
   check('Real Service send never mutates original SQL',hash(await fs.readFile(path.join(scratch,'dss-files.sqlite'))),sqlBefore)
  }
 }finally{await service.dispose()}
 console.log(JSON.stringify({status:expected?'recovered':'baseline-blocked',assertions:names.length,names,restored,sourceHashes:Object.fromEntries(loaded),frozenProducerHashes:Object.fromEntries(oldLoaded),limits:'Repository-frozen v44-derived SQL producer matches its repository manifest, but external original zip provenance is not independently verified and two dependency modules say reconstructed from 55fe. Real Linux disk, installed Koffi/Zod/Markdown packages, durable converted entry, controlled SIGKILL at its completed save boundary, then ordinary unlink and fresh converter. Actual FrameworkService.access/send/sendStored/prepare are exercised with its true Local connection; native DSH Host startup/model/React UI are not exercised. Service settings and DSH storage port are explicitly supplied; no Windows/power-loss claim.'},null,2))
}finally{hooks.deregister();await fs.rm(scratch,{recursive:true,force:true});await fs.rm(scratch+'-records',{recursive:true,force:true})}
