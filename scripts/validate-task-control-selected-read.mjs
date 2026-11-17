import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createRequire,registerHooks} from 'node:module'
import {pathToFileURL} from 'node:url'
import {hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const require=createRequire(import.meta.url)
// Use the installed real Markdown module, not a substitute implementation.
const supplemental=registerHooks({resolve(s,c,next){if(s==='mdast-util-from-markdown')return{url:pathToFileURL(require.resolve(s)).href,shortCircuit:true};return next(s,c)}})
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const {preparePhysicalTask,readJson}=await import('../src/framework/task-files.ts')
const baseline=process.argv.includes('--baseline'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'dss-selected-control-'))
const sdk=await openDshStorageFixture(path.join(dir,'sdk'),path.join(dir,'locator')),files=new PhysicalLocalFiles(path.join(dir,'files'))
const controls=new ExecutionControls(sdk.adapter,'selected-control',()=> 'fixed-time',files,sdk.adapter,'host'),checks=[],cost=[]
const check=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const rejects=async(name,fn,re)=>{await assert.rejects(fn,re);checks.push({name,passed:true})}
const create=async(n)=>{const source='tasks/cost'+n+'_P.md';await files.replace(source,'Actual input');return withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId:'91000000-0000-4000-8000-'+String(n).padStart(12,'0'),owner:'A',members:['A']}))}
const originalParse=JSON.parse,originalValues=Object.values,originalRead=files.readBytes.bind(files)
let measured,maps=new WeakMap()
// Instrument only the objects returned by the actual control-file JSON parse.
// Wrappers retain the exact parse/Object.values results and production inputs.
JSON.parse=function(...args){const x=originalParse(...args);if(measured&&x&&x.taskId===measured.taskId&&x.tasks&&x.executions&&x.commands){measured.parses++;for(const kind of ['tasks','executions','commands'])maps.set(x[kind],kind)}return x}
Object.values=function(x){const values=originalValues(x),kind=maps.get(x);if(measured&&kind)measured.enumerations.push({kind,rows:values.length});return values}
files.readBytes=async function(s,p){if(measured)measured.paths.push(p);return originalRead(s,p)}
async function measure(name,taskId,operation,kinds){measured={name,taskId,parses:0,enumerations:[],paths:[]};try{const result=await operation();cost.push(structuredClone(measured));check(name+' enumerated tables',measured.enumerations.map(x=>x.kind),baseline?['tasks','executions','commands',...kinds]:kinds);return result}finally{measured=undefined;maps=new WeakMap()}}
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
try{
 const a=await create(1),b=await create(2)
 for(let i=0;i<24;i++)await controls.setTask('command-'+i,a.taskId,i%2?'running':'paused')
 const ex={taskId:a.taskId,workId:'planner:'+a.taskId,executionId:'current'};await controls.requestExecutionStop('stop-current',ex)
 check('normal task intent',(await measure('task-read',a.taskId,()=>controls.task(a.taskId),[])).intent,'running')
 check('normal execution command',(await measure('execution-read',a.taskId,()=>controls.execution(ex),[])).commandId,'stop-current')
 check('original command replay',(await measure('command-replay',a.taskId,()=>controls.setTask('command-23',a.taskId,'running'),[])).commandId,'command-23')
 check('cold exact Task discovery',(await measure('cold-discovery',a.taskId,()=>new ExecutionControls(sdk.adapter,'selected-control',undefined,files,sdk.adapter,'host').pendingTaskStops(a.taskId),['executions'])).map(x=>x.executionId),['current'])
 await rejects('original command signature unchanged',()=>controls.setTask('command-23',a.taskId,'paused'),/different arguments/)
 await rejects('selected lifecycle unchanged',()=>controls.execution({...ex,lifecycleId:'other-life'}),/another Task lifecycle/)
 await controls.setTask('resume',a.taskId,'running');await controls.finishResume('resume',a);check('resume original completion',await controls.resumeHandled('resume',a),true)
 await rejects('resume identity unchanged',()=>controls.resumeHandled('resume',{...a,lifecycleId:'other-life'}),/identity differs/)
 const p=controls.taskRecordPath(a.taskId),body=await withSnapshot(files,s=>readJson(files,s,p));check('writer keeps version marker',body.version,1)
 // Diagnostic marker-only fixture, not a claim that production writes version 2.
 await files.replace(p,JSON.stringify({...body,version:2}));if(baseline)await rejects('baseline version gate',()=>controls.execution(ex),/original Task/);else check('marker alone cannot block selected command',(await controls.execution(ex)).commandId,'stop-current')
 await files.replace(p,JSON.stringify({...body,taskId:b.taskId}));await rejects('addressed envelope identity preserved',()=>controls.execution(ex),/original Task/);await files.replace(p,JSON.stringify(body))
 const entered=defer(),release=defer(),update=files.updateInExistingDirectory.bind(files);let hold=true
 files.updateInExistingDirectory=(selected,decide,...args)=>update(selected,async bytes=>{if(selected===p&&hold){hold=false;entered.resolve();await release.promise}return decide(bytes)},...args)
 const first=controls.setTask('same-file-first',a.taskId,'paused');await entered.promise;const second=controls.setTask('same-file-second',a.taskId,'running')
 await controls.setTask('independent',b.taskId,'paused');check('other Task remains available',(await controls.task(b.taskId)).intent,'paused');release.resolve();await first;await second;check('same file preserves write order',(await controls.task(a.taskId)).commandId,'same-file-second');files.updateInExistingDirectory=update
 check('exact reads remain same physical file',cost.slice(0,2).map(x=>x.paths.filter(path=>path.endsWith('/control.json'))),[[p],[p]])
 console.log(JSON.stringify({status:'passed',baseline,assertions:checks.length,checks,cost,boundaries:['Real methods/physical files/SDK; no model, Windows or online Git','Marker-only diagnostic is not a claimed production fault','Full JSON parse and I/O remain; no latency or total I/O reduction claimed'],...evidence()},null,2))
}finally{JSON.parse=originalParse;Object.values=originalValues;await files.close();await sdk.close();supplemental.deregister();hooks.deregister();await fs.rm(dir,{recursive:true,force:true})}
