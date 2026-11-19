import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import esbuild from 'esbuild'

// Actual production settings form rendered with React/jsdom. The native
// input/button components and controller are controlled ports; this is not a
// complete DSH browser or network test.
const requireHost=createRequire(new URL('../package.json',import.meta.url))
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'})
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement
globalThis.Event=dom.window.Event;globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.crypto??={randomUUID}
const React=requireHost('react'),{createRoot}=requireHost('react-dom/client'),{Simulate}=requireHost('react-dom/test-utils')
const source=fs.readFileSync(new URL('../src/framework/client-page.tsx',import.meta.url),'utf8')
const start=source.indexOf('function settingsFingerprint('),end=source.indexOf('\nfunction LegacyTasks(',start)
assert.ok(start>=0&&end>start,'actual settings form boundaries')
const blank=source.match(/^const blankSettings:.*$/m)?.[0];assert.ok(blank)
const contents="import { useEffect, useRef, useState } from 'react'\n"+
 "const css=new Proxy({}, {get:(_target,key)=>String(key)})\n"+
 "const Button=({children,variant,size,...props})=><button {...props}>{children}</button>\n"+
 "const Input=props=>{globalThis.inputs.push(props);return <input {...props}/>}\n"+
 "const frameworkErrorText=error=>String(error)\nconst GitInvitation=()=>null\n"+
 blank+'\n'+source.slice(start,end)+'\nexport { FrameworkSettingsForm }\n'
const built=await esbuild.build({stdin:{contents,loader:'tsx',resolveDir:new URL('../',import.meta.url).pathname,sourcefile:'settings-form.tsx'},bundle:true,packages:'external',platform:'node',format:'cjs',jsx:'automatic',write:false})
const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(requireHost,module,module.exports)
const Form=module.exports.FrameworkSettingsForm

const initial={name:'A',userName:'U',localDirectory:'source',ownerRepo:'a/b',repositoryDirectory:'r',collaborationId:'',workerSeats:1,workspace:'old'}
for (const mode of ['local','git']) {
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const calls=[];let setView;let fail=false
 const controller={configure:async input=>{calls.push(input);if(fail)throw Error('save failed');setView(v=>({...v,settings:{...v.settings,...Object.fromEntries(input.changedFields.map(k=>[k,input.settings[k]]))}}))}}
 function App(){const [view,publish]=React.useState({activeMode:mode,settings:structuredClone(initial),revision:'r',connection:{participating:true,status:'connected'}});setView=publish;globalThis.inputs=[];return React.createElement(Form,{view,controller,language:'en',api:{},onPickDirectory:async()=> 'chosen',modelControl:(value,change)=>React.createElement('button',{type:'button',onClick:()=>change({provider:'test',model:'new'})},'pick-model')})}
 try{
  await React.act(async()=>root.render(React.createElement(App)))
  assert.equal([...container.querySelectorAll('button')].some(b=>/Save and connect|collaboration background|Enable background|Disable background/.test(b.textContent)),false)
  const findInput=value=>globalThis.inputs.find(p=>p.value===value)
  await React.act(async()=>findInput('A').onChange({target:{value:'AB'}}));assert.equal(calls.length,0,'typing does not reconnect per character')
  await React.act(async()=>findInput('AB').onBlur());assert.equal(calls.length,1);assert.equal(calls[0].settings.name,'AB')
  await React.act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Choose folder').click());assert.equal(calls.at(-1).settings.workspace,'chosen');assert.deepEqual(calls.at(-1).changedFields,['workspace'])
  await React.act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='pick-model').click());assert.equal(calls.at(-1).settings.background.model,'new')
  await React.act(async()=>findInput(1).onChange({target:{value:'0'}}));await React.act(async()=>findInput(0).onBlur());assert.equal(calls.at(-1).settings.workerSeats,0);assert.match(container.textContent,/Worker seats to 0/)
  fail=true;await React.act(async()=>findInput('U').onChange({target:{value:'V'}}));await React.act(async()=>findInput('V').onBlur());const failed=calls.at(-1);assert.match(container.textContent,/save failed/)
  fail=false;await React.act(async()=>findInput('V').onBlur());assert.equal(calls.at(-1).commandId,failed.commandId,'retry retains command identity');assert.equal(findInput('V').value,'V')
 }finally{await React.act(async()=>root.unmount());container.remove()}
}

{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const calls=[];let publish
 const controller={configure(input){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});calls.push({input,finish(){publish(v=>({...v,settings:{...v.settings,...Object.fromEntries(input.changedFields.map(k=>[k,input.settings[k]]))}}));resolve()},reject});return promise}}
 function App(){const [view,set]=React.useState({activeMode:'local',settings:structuredClone(initial),revision:'r',connection:{participating:true,status:'connected'}});publish=set;globalThis.inputs=[];return React.createElement(Form,{view,controller,language:'en',api:{}})}
 try{
 await React.act(async()=>root.render(React.createElement(App)));const input=v=>globalThis.inputs.find(p=>p.value===v)
 await React.act(async()=>input('A').onChange({target:{value:'B'}}));await React.act(async()=>input('B').onBlur());assert.equal(calls.length,1)
 await React.act(async()=>input('B').onBlur());assert.equal(calls.length,1,'same in-flight save not duplicated')
 await React.act(async()=>input('B').onChange({target:{value:'C'}}));await React.act(async()=>input('C').onBlur());assert.equal(calls.length,2,'new edit is not blocked by slow connection')
 await React.act(async()=>calls[0].finish());assert.ok(input('C'),'older completion cannot erase new draft')
 await React.act(async()=>calls[1].finish());assert.ok(input('C'))
 await React.act(async()=>input('C').onChange({target:{value:'D'}}));await React.act(async()=>container.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(calls.at(-1).input.settings.name,'D');await React.act(async()=>calls.at(-1).finish())
 }finally{await React.act(async()=>root.unmount());container.remove()}
}
console.log('PASS Local/Git actual React settings form: no two buttons, blur save, folder selection immediate, model selection immediate, seats0 submitted, failed-save retry. Controlled controller/native inputs; not native GUI/lifecycle.')
