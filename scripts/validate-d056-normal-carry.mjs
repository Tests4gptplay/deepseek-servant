// Normal upgrade only: real shipped legacy writer and current SDK storage open.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {createRequire} from 'node:module'
import {hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const require=createRequire(path.join(process.env.DSS_SDK_HOST_ROOT,'package.json')),ts=require('typescript')
const {JsonStorageBackend}=await import('@deepseek-ai/dsh-storage-json')
const sha=v=>createHash('sha256').update(v).digest('hex')
const bundle=readFileSync(new URL('./test-support/historical-55fe/installed-host.js',import.meta.url),'utf8')
assert.equal(sha(bundle),'5a84b25b7619486ea98e7e11b140d02c0a3848e48008ac3cc2dc71a2a5a5d47a')
const ast=ts.createSourceFile('installed-host.js',bundle,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
const find=name=>{const f=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(f)return f.getText(ast);for(const n of ast.statements)if(ts.isVariableStatement(n))for(const d of n.declarationList.declarations)if(d.name.getText(ast)===name)return `const ${name}=${d.initializer.getText(ast)};`;throw Error('Missing historical writer '+name)}
const dep={...fs,path,JsonStorageBackend,createHash,randomUUID,isDeepStrictEqual}
const h=new Function(...Object.keys(dep),['descriptor','LAYOUT','recordCategories','recordFolder','RecordFilesBackend','ensureRecordTree'].map(find).join('\n')+'\nreturn {RecordFilesBackend,recordFolder,ensureRecordTree}')(...Object.values(dep))
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-d056-normal-')),records=path.join(scratch,'records'),tree=path.join(records,'deepseek_servant'),local=path.join(tree,'framework'),checks=[]
const check=(name,a,b)=>{assert.deepEqual(a,b,name);checks.push(name)}
const defaults={name:'Fixture',userName:'A',localDirectory:local,ownerRepo:'',repositoryDirectory:'/',collaborationId:'default',workerSeats:0,workspace:'',presetId:'standard'}
const settings={revision:'old-settings',settings:defaults},values={'framework-settings/local':settings,'framework-settings/git':settings,'framework-instance-uuid':'10000000-0000-4000-8000-000000000001','framework-active-mode':'local','framework-git-enabled':false,'framework-participation/local':false,'framework-participation/git':false}
let f
try{
 await h.ensureRecordTree(tree)
 const writer=new h.RecordFilesBackend(tree),unit=await writer.kv.open({name:'deepseek_servant',version:1,tables:['records'],hasGlobal:false})
 for(const [key,value] of Object.entries(values)) await unit.putRecord('records',key,{key,value})
 const other='framework-runtime/'+sha('unrelated-scope')+'/roles/original',otherValue={note:'Unrelated runtime data retained'}
 await unit.putRecord('records',other,{key:other,value:otherValue});await writer.close()
 const otherPath=path.join(tree,h.recordFolder(other),'record.json'),otherBytes=await fs.readFile(otherPath)
 const old=Object.keys(values).map(key=>path.join(tree,h.recordFolder(key)))
 f=await openDshStorageFixture(records,path.join(scratch,'locator'))
 for(const [key,value] of Object.entries(values))check('current value '+key,await f.adapter.get(key),value)
 check('new layout selected',JSON.parse(await fs.readFile(path.join(tree,'layout.json'),'utf8')).version,2)
 for(const folder of old)check('old configuration removed '+path.basename(folder),await fs.lstat(folder).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e}),false)
 check('unrelated original retained',await fs.readFile(otherPath),otherBytes)
 check('no cleanup issues',f.adapter.storageView().issues,[])
 await f.close();f=undefined
 f=await openDshStorageFixture(records,path.join(scratch,'locator'))
 for(const [key,value] of Object.entries(values))check('reopen value '+key,await f.adapter.get(key),value)
 check('reopen unrelated original retained',await fs.readFile(otherPath),otherBytes)
 check('reopen has no cleanup issues',f.adapter.storageView().issues,[])
 console.log(JSON.stringify({status:'passed',checks,assertions:checks.length,historicalWriter:sha(bundle),sdk:evidence(),limits:'Actual shipped legacy writer and current SDK storage adapter with disposable Linux files; no forced errors, Windows or full UI.'},null,2))
}finally{await f?.close();await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
