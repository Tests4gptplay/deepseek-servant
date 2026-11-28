import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {stripTypeScriptTypes} from 'node:module'
import {hooks,evidence,hash} from './test-support/dsh-sdk-runtime.mjs'
const {LocalRecordFiles,LocalTaskRecordParentMissing}=await import('../src/framework/local-record-files.ts')
const {PhysicalLocalFiles,LocalTaskRecordParentMissing:PublicMissing}=await import('../src/framework/physical-local-files.ts')

const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-initial-parent-')),checks=[]
const check=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const outcome=promise=>promise.then(value=>({value}),error=>({error}))
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const records=new LocalRecordFiles(root),logical='task-runs/A/control.json',parent=path.join(root,'task-runs/A')
try{
 check('same narrow type exported by physical adapter',PublicMissing,LocalTaskRecordParentMissing)
 let reads=0,decisions=0
 const read=records.readBytes.bind(records)
 records.readBytes=async(...args)=>{reads++;return read(...args)}
 let result=await outcome(records.updateInExistingDirectory(logical,()=>{decisions++;return{value:1,content:'new'}}))
 check('initial absence is classified',result.error instanceof LocalTaskRecordParentMissing,true)
 check('logical target retained',result.error.path,logical)
 check('original default Error name retained',result.error.name,'Error')
 check('no file read or decision before initial absence',[reads,decisions],[0,0])
 check('no parent is created',await fs.stat(parent).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e}),false)
 await records.replace(logical,'old')
 result=await outcome(records.updateInExistingDirectory(logical,bytes=>{decisions++;return{value:new TextDecoder().decode(bytes),content:'new'}}))
 check('normal existing update still returns original decision',result.value,'old')
 check('normal existing update writes target',new TextDecoder().decode(await read(logical)),'new')

 // Technical API boundaries only: actual Recorder/Cleaner entry is exercised
 // separately by the integration suite, not inferred from these test removals.
 const directory=records.directory.bind(records)
 records.directory=async(target,create)=>{const exists=await directory(target,create);if(target===parent&&create===false&&exists){await fs.rm(parent,{recursive:true});records.directory=directory}return exists}
 result=await outcome(records.updateInExistingDirectory(logical,()=>{throw Error('No decision after initial lstat absence')}))
 check('absence between initial directory lookup and initial lstat is still before-read',result.error instanceof LocalTaskRecordParentMissing,true)
 records.directory=directory

 await records.replace(logical,'before-decide')
 result=await outcome(records.updateInExistingDirectory(logical,async()=>{await records.removeDirectory('task-runs/A');return{value:2,content:'must not recreate'}}))
 check('parent disappearance after decide is not initial absence',result.error instanceof LocalTaskRecordParentMissing,false)
 check('after-decide original error is retained',result.error.message.startsWith('The original Local record directory no longer exists:'),true)
 check('after-decide path remains absent',await read(logical),undefined)

 await records.replace(logical,'before-replacement')
 result=await outcome(records.updateInExistingDirectory(logical,async()=>{await records.removeDirectory('task-runs/A');await fs.mkdir(parent,{recursive:true});await fs.writeFile(path.join(root,logical),'new owner');return{value:3,content:'old owner'}}))
 check('same-name different parent is not initial absence',result.error instanceof LocalTaskRecordParentMissing,false)
 check('new owner content is preserved',new TextDecoder().decode(await read(logical)),'new owner')

 const denied=Object.assign(new Error('Original permission failure'),{code:'EACCES'})
 records.directory=async()=>{throw denied}
 result=await outcome(records.updateInExistingDirectory(logical,()=>({value:4,content:'no'})))
 check('initial permission failure object is unchanged',result.error===denied,true)
 records.directory=directory

 const lstat=fs.lstat,lstatDenied=Object.assign(new Error('Original initial lstat permission'),{code:'EACCES'})
 fs.lstat=async(...args)=>{if(args[0]===parent&&args[1]?.bigint)throw lstatDenied;return lstat(...args)}
 try{result=await outcome(records.updateInExistingDirectory(logical,()=>({value:4,content:'no'})))}finally{fs.lstat=lstat}
 check('initial exact lstat permission failure object is unchanged',result.error===lstatDenied,true)

 await records.removeDirectory('task-runs/A')
 const linked=path.join(root,'linked-parent');await fs.mkdir(linked);await fs.writeFile(path.join(linked,'control.json'),'outside')
 await fs.symlink(linked,parent,'dir')
 result=await outcome(records.updateInExistingDirectory(logical,()=>({value:4,content:'no'})))
 check('symbolic-link parent is not classified as absent',result.error instanceof LocalTaskRecordParentMissing,false)
 check('symbolic-link target remains unchanged',await fs.readFile(path.join(linked,'control.json'),'utf8'),'outside')
 await fs.unlink(parent);await fs.writeFile(parent,'ordinary file')
 result=await outcome(records.updateInExistingDirectory(logical,()=>({value:4,content:'no'})))
 check('non-directory parent is not classified as absent',result.error instanceof LocalTaskRecordParentMissing,false)
 await fs.unlink(parent);await records.replace(logical,'before-unknown')

 const rename=fs.rename,unknown=Object.assign(new Error('Original post-rename UNKNOWN'),{code:'UNKNOWN'})
 fs.rename=async(...args)=>{await rename(...args);if(args[1]===path.join(root,logical))throw unknown}
 try{result=await outcome(records.updateInExistingDirectory(logical,()=>({value:5,content:'published'})))}finally{fs.rename=rename}
 check('post-rename UNKNOWN object is unchanged',result.error===unknown,true)
 check('post-rename UNKNOWN is not initial absence',result.error instanceof LocalTaskRecordParentMissing,false)
 check('original actual publication is not hidden',new TextDecoder().decode(await read(logical)),'published')

 await records.replace('task-runs/B/control.json','B')
 const entered=defer(),release=defer()
 const a=records.updateInExistingDirectory(logical,async()=>{entered.resolve();await release.promise;return{value:'A',content:'A'}})
 await entered.promise
 check('different Task proceeds while A decision is held',await records.updateInExistingDirectory('task-runs/B/control.json',()=>({value:'B done',content:'B done'})),'B done')
 release.resolve();check('held A keeps its result',await a,'A')

 const ordinary='ordinary/new/path.json'
 check('general updateAsync still creates ordinary parent',await records.updateAsync(ordinary,()=>({value:6,content:'ordinary'})),6)
 check('general ordinary content unchanged',new TextDecoder().decode(await read(ordinary)),'ordinary')

 const callCounts=[];let baseline
 if(process.env.DSS_PARENT_LOOKUP_BASELINE){
 const baselineText=await fs.readFile(process.env.DSS_PARENT_LOOKUP_BASELINE,'utf8')
 baseline={path:process.env.DSS_PARENT_LOOKUP_BASELINE,sha256:hash(baselineText)}
 const {LocalRecordFiles:Baseline}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(baselineText,{mode:'transform'})).toString('base64'))
 for(const [name,Type] of [['baseline',Baseline],['candidate',LocalRecordFiles]]){
  const store=new Type(path.join(root,'cost-'+name)),file='task-runs/T/control.json'
  await store.replace(file,'before')
  const names=['lstat','open','rename','unlink','mkdir'],originals=Object.fromEntries(names.map(n=>[n,fs[n]])),counts=Object.fromEntries(names.map(n=>[n,0]))
  try{
   for(const n of names)fs[n]=async(...args)=>{counts[n]++;return originals[n](...args)}
   await store.updateInExistingDirectory(file,()=>({value:undefined,content:'after'}))
  }finally{for(const n of names)fs[n]=originals[n]}
  callCounts.push({name,counts})
 }
 check('normal fixed-file Node call counts unchanged',callCounts[1].counts,callCounts[0].counts)
 }

 const physical=new PhysicalLocalFiles(path.join(root,'physical'))
 await physical.close()
 result=await outcome(Promise.resolve().then(()=>physical.updateInExistingDirectory(logical,()=>({value:7,content:'closed'}))))
 check('closed physical connection is not initial parent absence',result.error instanceof LocalTaskRecordParentMissing,false)
 check('closed physical connection keeps original error',result.error.message,'Physical Local storage is closed.')

 console.log(JSON.stringify({status:'passed',assertions:checks.length,checks,callCounts,...(baseline?{baseline}:{}),...evidence(),limits:'Real physical file operations with controlled technical API boundaries. Initial absence is distinguished before file read/decision, not taken as proof of business completion. No production Runtime fallback is present in this component. Actual Recorder/Cleaner lifecycle integration is a separate suite. Baseline comparison counts selected Node calls, not filesystem total I/O or device latency. No generic replace/update/delete semantics change or added queue. Counts are assertions, not real-device scenarios; no Windows/full DSH/Git acceptance.'},null,2))
}finally{hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
