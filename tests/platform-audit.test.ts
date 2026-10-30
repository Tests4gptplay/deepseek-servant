import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { RecordFilesBackend, ensureRecordTree, recordFolder } from '../src/adapters/dsh/record-files.js'
import { DshStorageAdapter } from '../src/adapters/dsh/storage.js'
import { CoopCache } from '../src/experimental/private-git/cache.js'
import { CoopSettingsSchema } from '../src/experimental/private-git/contracts.js'
import { GitHubClient, GitHubMembers, inspectPrivateRepo } from '../src/experimental/private-git/github.js'
import { normalizeClaims, pathsOverlap } from '../src/runtime/scheduler.js'
import { localizeServantError, servantDiagnostics } from '../src/client/error-text.js'
import { zh, en } from '../src/client/locales.js'

const text = (locale: typeof en) => ((key: keyof typeof en) => locale[key]) as any
test('UIQA: all known DSS diagnostics localize in English without altering saved text, Chinese or paths', () => {
  for (const [source, translated] of servantDiagnostics) {
    assert.equal(localizeServantError(source, text(en)), translated)
    assert.equal(localizeServantError(source, text(zh)), source)
    if (source.endsWith('：')) assert.equal(localizeServantError(source + 'E:\\同名 User\\记录', text(en)), translated + 'E:\\同名 User\\记录')
  }
  assert.equal(localizeServantError('/tmp/中国 name/record.json: 记录路径、身份或封装不匹配', text(en)), '/tmp/中国 name/record.json: The record path, identity or envelope does not match.')
  assert.equal(localizeServantError('User-supplied 中文 message', text(en)), 'User-supplied 中文 message')
  assert.equal(localizeServantError('2 条前台消息等待修复后重新接纳。', text(en)), '2 foreground message(s) await repair before readmission.')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.ok(Object.values(en).every(value => !/\p{Script=Han}/u.test(value)))
})

test('UIQA: actual relative-path migration rejection is readable in English', async () => {
  let error = ''
  const adapter = { directory: '/tmp/fixture', serial: (operation: () => unknown) => operation() }
  try { await DshStorageAdapter.prototype.moveRecords.call(adapter as any, 'relative', '/tmp/fixture', new AbortController().signal) }
  catch (reason) { error = (reason as Error).message }
  assert.equal(localizeServantError(error, text(en)), 'Enter the full absolute path of the folder.')
})

test('UIQA: same-name, case variants, reserved words and Unicode records retain distinct durable identities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss audit 同名 '))
  t.after(() => rm(root, { recursive: true, force: true }))
  await ensureRecordTree(root)
  const keys = ['task:Name','task:name','task:CON','task:AUX','task:é','task:e\u0301','assistant/Name','assistant/name','task:' + 'a'.repeat(600)]
  const folders = keys.map(recordFolder)
  assert.equal(new Set(folders.map(value => value.toLowerCase())).size, keys.length)
  assert.ok(folders.every(folder => win32.basename(folder).length <= 98))
  const backend = new RecordFilesBackend(root)
  const unit = await backend.kv.open({ name:'deepseek_servant',version:1,tables:['records'],hasGlobal:false })
  for (const key of keys) await unit.putRecord('records', key, { key, value: key })
  await backend.close()
  const reopened = new RecordFilesBackend(root)
  const saved = await (await reopened.kv.open({name:'deepseek_servant',version:1,tables:['records'],hasGlobal:false})).loadAll()
  assert.equal(Object.keys(saved.tables.records!).length, keys.length)
  for (const key of keys) assert.deepEqual(saved.tables.records![key], { key, value: key })
  await reopened.close()
})

test('UIQA: identical display logins do not join caches belonging to different numeric GitHub identities', async () => {
  const rows = new Map<string, any>()
  let global = { instanceId:'same-display-name', settings:CoopSettingsSchema.parse({}) }
  const context = {storageDomain:{open:async()=>({global:{get:()=>global,set:async(value:any)=>{global=value}},table:()=>({get:(key:string)=>rows.get(key),put:async(key:string,value:any)=>{rows.set(key,value)},delete:async(key:string)=>{rows.delete(key)},entries:()=>rows.entries()}),close:async()=>{}})}} as any
  const cache = await CoopCache.open(context)
  const connection = (id:number) => ({identity:{id,login:'same-name'},repository:{id:77,fullName:'fixture/private',branch:'main',private:true,permissions:{pull:true,push:true,admin:true}}})
  await cache.put('connection',connection(101));await cache.put('draft/same-id',{text:'first identity'})
  await cache.put('connection',connection(202));assert.equal(cache.get('draft/same-id'),undefined);await cache.put('draft/same-id',{text:'second identity'})
  await cache.put('connection',connection(101));assert.deepEqual(cache.get('draft/same-id'),{text:'first identity'})
  await cache.close()
})

test('UIQA: account verification rejects a different numeric ID even with the same login', async () => {
  const session = {request:async(_method:string,path:string)=>path==='/user'?{id:202,login:'same-name'}:{id:77,full_name:'fixture/private',private:true,default_branch:'main'}} as any
  await assert.rejects(inspectPrivateRepo(session,{ownerRepo:'fixture/private',repositoryId:77,participantId:101}),/account changed/)
})

test('UIQA: stale member action is rejected before any credential or network operation', async () => {
  let calls=0
  const client=new GitHubClient(async()=>{calls++;return {value:'synthetic-only',source:'fixture'}},async()=>{calls++;return Response.json({})})
  const members=new GitHubMembers(client,()=>({ownerRepo:'fixture/second',repositoryId:2,participantId:10}))
  await assert.rejects(members.remove('same-name',{expectedRepositoryId:1,expectedParticipantId:10}),/account or repository changed/)
  assert.equal(calls,0)
})

test('UIQA: member operation captures the reviewed binding before asynchronous authentication', async () => {
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),routes:string[]=[]
  let binding={ownerRepo:'fixture/first',repositoryId:1,participantId:10}
  const client=new GitHubClient(async()=>{await gate;return {value:'synthetic-only',source:'fixture'}},async(url,init)=>{
    const path=new URL(url).pathname;routes.push((init?.method??'GET')+' '+path)
    if(path==='/user')return Response.json({id:10,login:'owner'})
    if(init?.method==='DELETE')return new Response(null,{status:204})
    return Response.json({id:1,full_name:'fixture/first',private:true,default_branch:'main',permissions:{admin:true}})
  })
  const members=new GitHubMembers(client,()=>binding)
  const pending=members.remove('same-name',{expectedRepositoryId:1,expectedParticipantId:10})
  binding={ownerRepo:'fixture/second',repositoryId:2,participantId:10};release();await pending
  assert.ok(routes.includes('DELETE /repos/fixture/first/collaborators/same-name'))
  assert.ok(routes.every(path=>!path.includes('fixture/second')))
})

test('UIQA: Windows drive/UNC case normalization and POSIX sibling boundaries', () => {
  const claim=(directory:string,scope:string)=>normalizeClaims({workspace:{id:'fixture',directory}} as any,[scope])[0]!
  assert.equal(pathsOverlap(claim('E:\\Same Name','Foo\\data.json'),claim('e:\\same name','foo')),true)
  assert.equal(pathsOverlap(claim('\\\\server\\share\\Root','Folder/a'),claim('\\\\SERVER\\SHARE\\ROOT','folder')),true)
  assert.equal(pathsOverlap(claim('/tmp/root','foo'),claim('/tmp/root','foobar')),false)
  assert.equal(pathsOverlap(claim('/tmp/root','foo/**'),claim('/tmp/root','foo/a')),true)
})
