// Exact current React form + actual client controller/Service and rc.5 SDK JSON
// persistence. Normal connection acquisition is controlled; no injected failure.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const supplemental = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw Error("Markdown outside validation")}', shortCircuit: true }
  return next(specifier, context)
} })
const { FrameworkService } = await import('../src/framework/service.ts')
const { FrameworkClientController } = await import('../src/framework/client-contracts.ts')
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const requireHost = createRequire(process.env.DSS_SDK_HOST_ROOT + '/package.json')
const { JSDOM } = requireHost('jsdom'), esbuild = requireHost('esbuild')
const source = await fs.readFile(new URL('../src/framework/client-page.tsx', import.meta.url), 'utf8')
for (const fragment of ['{settingsOpen && settingsContent}', 'onClose={() => setSettingsOpen(false)}', "setSettingsTab('settings'); setSettingsOpen(true)"]) assert.ok(source.includes(fragment))
const start = source.indexOf('function settingsFingerprint('), end = source.indexOf('\nfunction LegacyTasks(', start)
const blank = source.match(/^const blankSettings:.*$/m)?.[0]
assert.ok(start >= 0 && end > start && blank)
const foregroundStart = source.indexOf('  const saveForegroundModel = ('), foregroundEnd = source.indexOf('  const unknownPhysicalSource', foregroundStart)
const fieldStart = source.indexOf('<fieldset disabled={!!modelSaving || changingMode}'), fieldEnd = source.indexOf('</fieldset>', fieldStart) + '</fieldset>'.length
assert.ok(foregroundStart > 0 && foregroundEnd > foregroundStart && fieldStart > 0 && fieldEnd > fieldStart)
const foregroundState = source.split('\n').filter(line => /^  const \[model/.test(line) || line.startsWith('  const modelOperation = ')).join('\n')
const foregroundComponent = `function ForegroundControl({view,controller,props}) { const tr=(_cn,en)=>en, changingMode=false; const [error,setError]=useState(''); const scope=JSON.stringify([view.activeMode,view.collaborationId,view.storageScope]); ${foregroundState}\n ${source.slice(foregroundStart,foregroundEnd)} return (${source.slice(fieldStart,fieldEnd)}) }\nexport { ForegroundControl }\n`
const contents = `import { useEffect, useRef, useState } from 'react'\nconst css = new Proxy({}, { get: (_t, key) => String(key) })\n` +
  `const Button = ({ children, variant, size, ...props }) => <button {...props}>{children}</button>\nconst Input = props => <input {...props} />\n` +
  `const frameworkErrorText = error => String(error)\nconst GitInvitation = () => null\n` + blank + '\n' + source.slice(start, end) + '\nexport { FrameworkSettingsForm }\n' + foregroundComponent
const built = await esbuild.build({ stdin: { contents, loader: 'tsx', resolveDir: new URL('../', import.meta.url).pathname, sourcefile: 'current-settings.tsx' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic', write: false })
const module = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireHost, module, module.exports)
const Form = module.exports.FrameworkSettingsForm, ForegroundControl = module.exports.ForegroundControl, dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })
const React = requireHost('react'), { createRoot } = requireHost('react-dom/client'), { Simulate } = requireHost('react-dom/test-utils')
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const checks=[],results=[]
const check=(label,actual,expected)=>{assert.deepEqual(actual,expected,label);checks.push(label)}
const fresh=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}}
async function fixture(mode, options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'d020-interleavings-'))
  const sdk=await openDshStorageFixture(path.join(directory,'records'),path.join(directory,'locator'))
  const defaults={name:'Original',userName:'Fixture',localDirectory:'/selected-local',ownerRepo:'fixture/project',repositoryDirectory:'/',collaborationId:'fixture',workerSeats:1,workspace:'/workspace'}
  const service=new FrameworkService({},sdk.adapter,defaults)
  service.saved.set(mode,{revision:'rev-1',settings:{...defaults}})
  const targetKey=mode==='local'?'localDirectory':'ownerRepo'
  const targetValue=mode==='local'?'/new-local':'fixture/new-repo'
  const targetLabel=mode==='local'?'Local data directory':'Git owner/repository'
  const opened=[];let stops=0
  const makeRunning=()=>{const settings=structuredClone(service.config(mode).settings);return{
    runtime:{config:settings,setForegroundModel:FrameworkRoleRuntime.prototype.setForegroundModel,setBackgroundModel(){},updateWorkerSeats(){}},
    workspaceSelection:settings.workspace,
    connection:{scope:JSON.stringify([mode,settings[targetKey],settings.collaborationId]),registration:{workerSeats:settings.workerSeats},updateWorkerSeats:async seats=>({workerSeats:seats}),members:async()=>[],cancelPending(){}},resources:[]}}
  if(options.running)service.running.set(mode,makeRunning())
  const view=()=>({activeMode:mode,...structuredClone(service.config(mode)),collaborationId:service.config(mode).settings.collaborationId,storageScope:service.running.get(mode)?.connection.scope,messages:[],resources:[],tasks:[],executions:[],archives:[],connection:{status:service.running.has(mode)?'connected':'stopped',participating:service.running.has(mode)}})
  service.settingsView=async()=>view();service.prepareGit=()=>{};service.report=()=> 'controlled-report';service.clearResolvedErrors=()=>{}
  service.stopRunning=async(active,signal)=>{check(mode+': stop targets current runtime',active,service.running.get(mode));check(mode+': stop signal live',signal.aborted,false);stops++}
  const firstOpen=options.holdFirstOpen?fresh():undefined,openEntered=fresh()
  service.open=async(_mode,signal)=>{
    opened.push(service.config(mode).settings[targetKey])
    if(opened.length===1&&firstOpen){openEntered.resolve();await new Promise((resolve,reject)=>{
      const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true})
      firstOpen.promise.then(()=>{signal.removeEventListener('abort',abort);resolve()})
    })}
    signal.throwIfAborted();const active=makeRunning();service.running.set(mode,active);return active
  }
  const modelRead=options.holdModelRead?fresh():undefined,readEntered=fresh(),originalGet=sdk.adapter.get.bind(sdk.adapter)
  let readHeld=false
  if(modelRead)sdk.adapter.get=async key=>{
    if(!readHeld&&key==='framework-settings/'+mode){readHeld=true;readEntered.resolve();await modelRead.promise}
    return originalGet(key)
  }
  const modelReply=options.holdModelReply?fresh():undefined,aReply=options.holdFirstConfigReply?fresh():undefined,bReply=options.holdSecondConfigReply?fresh():undefined
  const requests=[],outcomes=[];let configCount=0
  const api={configure(input){const index=++configCount;requests.push({type:'settings',input:structuredClone(input)})
      const outcome=service.configure(input).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',error}));outcomes.push(outcome)
      return outcome.then(async result=>{if(index===1&&aReply)await aReply.promise;if(index===2&&bReply)await bReply.promise;if(result.status==='rejected')throw result.error;return result.value})
    },foregroundModel(input){requests.push({type:'model',input:structuredClone(input)})
      const outcome=service.foregroundModel(input).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',error}));outcomes.push(outcome)
      return outcome.then(async result=>{if(modelReply)await modelReply.promise;if(result.status==='rejected')throw result.error;return result.value})
    },view:async()=>view()}
  const controller=new FrameworkClientController(api);controller.current={value:view(),loading:false,drafts:[]}
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
  function App(){const[open,setOpen]=React.useState(false),snapshot=React.useSyncExternalStore(controller.subscribe,controller.snapshot)
    return React.createElement(React.Fragment,null,
      React.createElement('button',{onClick:()=>setOpen(true)},'Open settings'),
      React.createElement('button',{onClick:()=>setOpen(false)},'Close settings'),
      open&&React.createElement(Form,{view:snapshot.value,controller,language:'en',api,
        onPickDirectory:async()=>'/picked',
        presetControl:(_value,onChange)=>React.createElement('button',{type:'button',onClick:()=>onChange('new-preset')},'Select preset'),
        modelControl:(_value,onChange,_label,control)=>React.createElement(React.Fragment,null, React.createElement('output',{'data-follow':JSON.stringify(control.followModel ?? null)}),
          React.createElement('button',{type:'button',onClick:()=>onChange({provider:'fixture',model:'new-background'})},'Choose background'),
          React.createElement('button',{type:'button',onClick:()=>onChange(undefined)},'Clear background'))}),
      !open&&React.createElement(ForegroundControl,{view:snapshot.value,controller,
        props:{modelControl:(_value,onChange,_label,control)=>React.createElement('button',{disabled:control.disabled,onClick:()=>onChange({provider:'fixture',model:'new-foreground'})},'Choose foreground model')}}))}
  await React.act(async()=>root.render(React.createElement(App)))
  const button=label=>[...container.querySelectorAll('button')].find(row=>row.textContent?.includes(label))
  const input=label=>[...container.querySelectorAll('label')].find(row=>row.textContent?.includes(label))?.querySelector('input')
  const click=async label=>React.act(async()=>button(label).click())
  const edit=async(label,value)=>{const element=input(label);assert.ok(element,label+' input');await React.act(async()=>Simulate.change(element,{target:{value}}))}
  const saved=()=>sdk.adapter.get('framework-settings/'+mode)
  const status=()=>[...container.querySelectorAll('[role=status]')].some(row=>row.textContent?.includes('Settings saved.'))
  const close=async()=>{modelRead?.resolve();modelReply?.resolve();firstOpen?.resolve();aReply?.resolve();bReply?.resolve();sdk.adapter.get=originalGet;await React.act(async()=>root.unmount());container.remove();await Promise.allSettled(outcomes);await sdk.close();await fs.rm(directory,{recursive:true,force:true})}
  return{mode,service,controller,requests,outcomes,defaults,targetKey,targetValue,targetLabel,opened,get stops(){return stops},click,edit,input,button,saved,status,modelRead,readEntered,openEntered,firstOpen,modelReply,aReply,bReply,close}
}
async function run(mode,label,options,action){const f=await fixture(mode,options);try{await action(f);results.push({mode,scenario:label,checks:checks.length})}finally{await f.close()}}
for(const mode of ['local','git']){
 await run(mode,'model-finishes-during-name-draft',{running:true,holdModelRead:true},async f=>{
   await f.click('Choose foreground model'); await f.readEntered.promise;
   await f.click('Open settings'); await f.edit('Name','Draft name');
   f.modelRead.resolve(); await Promise.all(f.outcomes); await React.act(async()=>{});
   check(mode+': name draft retained',f.input('Name').value,'Draft name');
   const output=document.querySelector('output[data-follow]');
   check(mode+': background-follow model shown',JSON.parse(output.getAttribute('data-follow')),{provider:'fixture',model:'new-foreground'});
 });
 await run(mode,'settings-then-composer-model',{holdFirstOpen:true},async f=>{
   await f.click('Open settings');await f.edit('Name','A name');await f.click('Save and connect');await f.openEntered.promise
   await f.click('Close settings');await f.click('Choose foreground model');f.firstOpen.resolve()
   check(mode+': original D020 two commands succeed',(await Promise.all(f.outcomes)).map(x=>x.status),['fulfilled','fulfilled'])
   await React.act(async()=>Promise.resolve())
   check(mode+': original D020 durable A+B',[(await f.saved()).settings.name,(await f.saved()).settings.foreground],['A name',{provider:'fixture',model:'new-foreground'}])
   check(mode+': original D020 UI A+B',[f.controller.snapshot().value.settings.name,f.controller.snapshot().value.settings.foreground],['A name',{provider:'fixture',model:'new-foreground'}])
 })
 await run(mode,'model-before-old-settings-reply',{holdFirstOpen:true,holdFirstConfigReply:true},async f=>{
   await f.click('Open settings');await f.edit('Name','A name');await f.click('Save and connect');await f.openEntered.promise
   await f.click('Close settings');await f.click('Choose foreground model');f.firstOpen.resolve()
   check(mode+': model completes before A client reply',(await Promise.all(f.outcomes)).map(x=>x.status),['fulfilled','fulfilled'])
   await React.act(async()=>Promise.resolve())
   check(mode+': B projects A name plus model before A reply',[f.controller.snapshot().value.settings.name,f.controller.snapshot().value.settings.foreground],['A name',{provider:'fixture',model:'new-foreground'}])
   f.aReply.resolve();await React.act(async()=>Promise.resolve())
   check(mode+': late A reply cannot roll back B',[f.controller.snapshot().value.settings.name,f.controller.snapshot().value.settings.foreground],['A name',{provider:'fixture',model:'new-foreground'}])
 })
 await run(mode,'model-during-foreground-processing',{running:true},async f=>{
   const processing={executionId:'execution',turnId:'turn',startedAt:1},groups=[{id:'group',turnId:'turn',startedAt:1,closed:false,activity:'thinking',counts:[]}]
   const runtime=f.service.running.get(mode).runtime
   f.controller.current={...f.controller.snapshot(),value:{...f.controller.snapshot().value,foregroundProcessing:processing,foregroundProcessGroups:groups}}
   await f.click('Choose foreground model');check(mode+': in-progress model save succeeds',(await f.outcomes[0]).status,'fulfilled')
   await React.act(async()=>Promise.resolve())
   check(mode+': native processing retained after model projection',f.controller.snapshot().value.foregroundProcessing,processing)
   check(mode+': process groups retained after model projection',f.controller.snapshot().value.foregroundProcessGroups,groups)
   check(mode+': current runtime not replaced',f.service.running.get(mode).runtime,runtime)
 })
 await run(mode,'model-durable-reply-late' ,{running:true,holdModelReply:true},async f=>{
   await f.click('Choose foreground model');check(mode+': model RPC submitted',f.requests[0].type,'model')
   check(mode+': model Service commit', (await f.outcomes[0]).status,'fulfilled')
   check(mode+': model durable before form',(await f.saved()).settings.foreground,{provider:'fixture',model:'new-foreground'})
   check(mode+': controller still old',f.controller.snapshot().value.revision,'rev-1')
   await f.click('Open settings');await f.edit('Name','Changed name');await f.click('Save and connect')
   check(mode+': name-only intent',f.requests[1].input.changedFields,['name'])
   check(mode+': settings completion',(await f.outcomes[1]).status,'fulfilled')
   check(mode+': durable M2 plus name',[(await f.saved()).settings.foreground,(await f.saved()).settings.name],[{provider:'fixture',model:'new-foreground'},'Changed name'])
   check(mode+': no stop for unrelated form',f.stops,0);f.modelReply.resolve()
 })
 await run(mode,'model-read-pending',{running:true,holdModelRead:true},async f=>{
   await f.click('Choose foreground model');await f.readEntered.promise
   await f.click('Open settings');await f.edit('Name','Changed name');await f.click('Save and connect');f.modelRead.resolve()
   const outcomes=await Promise.all(f.outcomes)
   check(mode+': queued model and settings both succeed',outcomes.map(x=>x.status),['fulfilled','fulfilled'])
   check(mode+': earlier model kept',[(await f.saved()).settings.foreground,(await f.saved()).settings.name],[{provider:'fixture',model:'new-foreground'},'Changed name'])
   check(mode+': no stop for same target',f.stops,0)
 })
 await run(mode,'two-forms-different-fields',{holdFirstOpen:true},async f=>{
   await f.click('Open settings');await f.edit('Name','A name');await f.click('Save and connect');await f.openEntered.promise
   check(mode+': A settings physically saved',(await f.saved()).settings.name,'A name')
   await f.click('Close settings');await f.click('Open settings');await f.edit('Local display name','B user');await f.click('Save and connect');f.firstOpen.resolve()
   check(mode+': normal A cancellation then B completion',(await Promise.all(f.outcomes)).map(x=>x.status),['rejected','fulfilled'])
   check(mode+': A and B durable',[(await f.saved()).settings.name,(await f.saved()).settings.userName],['A name','B user'])
   await React.act(async()=>Promise.resolve())
   check(mode+': form projects A',f.input('Name').value,'A name')
   check(mode+': form projects B',f.input('Local display name').value,'B user')
   check(mode+': D011 saved label',f.status(),true)
   await f.click('Save and connect');check(mode+': pristine next save has empty intent',f.requests[2].input.changedFields,[])
   check(mode+': pristine next save succeeds',(await f.outcomes[2]).status,'fulfilled')
   check(mode+': pristine next save retains A+B',[(await f.saved()).settings.name,(await f.saved()).settings.userName],['A name','B user'])
 })
 await run(mode,'inflight-third-edit',{holdFirstOpen:true,holdSecondConfigReply:true},async f=>{
   await f.click('Open settings');await f.edit('Name','A name');await f.click('Save and connect');await f.openEntered.promise
   await f.click('Close settings');await f.click('Open settings');await f.edit('Local display name','B user');await f.click('Save and connect');f.firstOpen.resolve()
   check(mode+': B committed while response delayed',(await Promise.all(f.outcomes)).map(x=>x.status),['rejected','fulfilled'])
   await f.edit('Name','C name');f.bReply.resolve();await React.act(async()=>{await f.controller.navigationRead})
   check(mode+': newer C remains in form',f.input('Name').value,'C name')
   check(mode+': newer C not falsely saved',f.status(),false)
   await f.click('Save and connect');check(mode+': C next save succeeds',(await f.outcomes[2]).status,'fulfilled')
   check(mode+': C and B durable',[(await f.saved()).settings.name,(await f.saved()).settings.userName],['C name','B user'])
 })
 await run(mode,'explicit-restore-and-optional-clear',{holdFirstOpen:true},async f=>{
   await f.click('Open settings');await f.edit('Name','A name');await f.click('Choose background');await f.click('Save and connect');await f.openEntered.promise
   await f.click('Close settings');await f.click('Open settings');await f.edit('Name','Temporary');await f.edit('Name','Original');await f.click('Clear background');await f.click('Save and connect');f.firstOpen.resolve()
   check(mode+': B explicit intent',f.requests[1].input.changedFields,['background','name'])
   check(mode+': B finishes',(await Promise.all(f.outcomes)).map(x=>x.status),['rejected','fulfilled'])
   check(mode+': restored name and cleared optional model',[(await f.saved()).settings.name,(await f.saved()).settings.background],['Original',undefined])
 })
 await run(mode,'target-switch-then-other-field',{holdFirstOpen:true},async f=>{
   await f.click('Open settings');await f.edit(f.targetLabel,f.targetValue);await f.click('Save and connect');await f.openEntered.promise
   await f.click('Close settings');await f.click('Open settings');await f.edit('Name','B name');await f.click('Save and connect');f.firstOpen.resolve()
   check(mode+': B finishes after A canceled',(await Promise.all(f.outcomes)).map(x=>x.status),['rejected','fulfilled'])
   check(mode+': target and B name durable',[(await f.saved()).settings[f.targetKey],(await f.saved()).settings.name],[f.targetValue,'B name'])
   check(mode+': both connection acquisitions use new target',f.opened,[f.targetValue,f.targetValue])
 })
 await run(mode,'all-form-field-intents',{},async f=>{
   await f.click('Open settings');await f.click('Browse local task workspace');await f.click('Select preset');await f.click('Choose background')
   await f.edit('Worker seats per task','2')
   for(const label of ['Show the bottom-right character','Swap conversation and task illustrations']){
     const box=f.input(label);assert.ok(box,label)
     await React.act(async()=>Simulate.change(box,{target:{checked:!box.checked}}))
   }
   await f.click('Save and connect')
   check(mode+': all form controls submit explicit fields',f.requests[0].input.changedFields,['background','presetId','showCornerCharacter','swapPageIllustrations','workerSeats','workspace'])
   check(mode+': all controls save',(await f.outcomes[0]).status,'fulfilled')
   check(mode+': workspace and seats durable',[(await f.saved()).settings.workspace,(await f.saved()).settings.workerSeats],['/picked',2])
 })
 await run(mode,'pending-model-old-target-switch' ,{running:true,holdModelRead:true},async f=>{
   await f.click('Choose foreground model');await f.readEntered.promise
   await f.click('Open settings');await f.edit(f.targetLabel,f.targetValue);await f.click('Save and connect');f.modelRead.resolve()
   check(mode+': old-scope model canceled but target saved',(await Promise.all(f.outcomes)).map(x=>x.status),['rejected','fulfilled'])
   check(mode+': no old model carried',[(await f.saved()).settings[f.targetKey],(await f.saved()).settings.foreground],[f.targetValue,undefined])
   check(mode+': target switch reaches stop branch',f.stops,1)
   check(mode+': target switch acquires new target',f.opened,[f.targetValue])
 })
}
// Normal independent panel refresh can advance native observations while a
// successful model RPC is in transit. The model receipt owns no such fields.
{
 const initialSettings={name:'Original',userName:'Fixture',localDirectory:'/selected-local',ownerRepo:'fixture/project',repositoryDirectory:'/',collaborationId:'fixture',workerSeats:1,workspace:'/workspace'}
 const old={activeMode:'local',revision:'r1',settings:initialSettings,collaborationId:'fixture',storageScope:'local-scope',messages:[],resources:[],tasks:[],executions:[],archives:[],connection:{status:'starting',participating:true},faultOccurrence:1,faultOwner:'old'}
 const saved={...old,revision:'r2',settings:{...initialSettings,foreground:{provider:'fixture',model:'new-foreground'}}}
 const freshView={...saved,connection:{status:'connected',participating:true},executions:[{workId:'work',executionId:'execution',sessionId:'session',role:'Foreground',state:'running'}],faultOccurrence:2,faultOwner:'new',foregroundProcessing:{executionId:'execution',turnId:'turn',startedAt:1}}
 const reply=fresh(),api={foregroundModel:()=>reply.promise,view:async()=>freshView,history:async()=>({messages:[],order:[],revision:'r2',storageScope:'local-scope'})}
 const controller=new FrameworkClientController(api);controller.current={value:old,loading:false,drafts:[]}
 const pending=controller.foregroundModel({mode:'local',storageScope:'local-scope',commandId:'model',model:saved.settings.foreground})
 await controller.refresh()
 check('refresh advanced connection before model reply',controller.snapshot().value.connection.status,'connected')
 reply.resolve(saved);await pending
 check('late model receipt keeps newer connection',controller.snapshot().value.connection.status,'connected')
 check('late model receipt keeps newer executions',controller.snapshot().value.executions,freshView.executions)
 check('late model receipt keeps newer fault occurrence',controller.snapshot().value.faultOccurrence,2)
 check('late model receipt keeps newer fault owner',controller.snapshot().value.faultOwner,'new')
 check('late model receipt keeps newer processing',controller.snapshot().value.foregroundProcessing,freshView.foregroundProcessing)
 results.push({mode:'local',scenario:'late-model-receipt-after-view-refresh',checks:checks.length})
}
console.log(JSON.stringify({status:'passed',assertions:checks.length,scenarios:results,sourceSha256:createHash('sha256').update(source).digest('hex'),...evidence(),limits:'Exact current React form/model-control fragments, controller, Service and real SDK JSON persistence. Normal RPC, SDK read and connect-acquisition delays; controlled native/connection ports. No injected error, live GitHub, full DSH or Windows acceptance.'},null,2))
supplemental.deregister();hooks.deregister();dom.window.close()
