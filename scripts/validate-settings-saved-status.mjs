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
 "const Input=props=><input {...props}/>\n"+
 "const frameworkErrorText=error=>String(error)\nconst GitInvitation=()=>null\n"+
 blank+'\n'+source.slice(start,end)+'\nexport { FrameworkSettingsForm }\n'
const built=await esbuild.build({stdin:{contents,loader:'tsx',resolveDir:new URL('../',import.meta.url).pathname,sourcefile:'settings-form.tsx'},bundle:true,packages:'external',platform:'node',format:'cjs',jsx:'automatic',write:false})
const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(requireHost,module,module.exports)
const Form=module.exports.FrameworkSettingsForm
const initial={name:'A',userName:'',localDirectory:'',ownerRepo:'',repositoryDirectory:'',collaborationId:'',workerSeats:0,workspace:''}
const saved=container=>[...container.querySelectorAll('[role="status"]')].some(element=>element.textContent?.includes('Settings saved.'))
const nameInput=container=>[...container.querySelectorAll('label')].find(element=>element.textContent?.includes('Name'))?.querySelector('input')
const saveButton=container=>[...container.querySelectorAll('button')].find(element=>element.textContent?.includes('Save and connect'))
async function run(editWhilePending){
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);let publishView;const calls=[]
 const controller={configure(input){let finish;const pending=new Promise(resolve=>{finish=resolve});calls.push({input:structuredClone(input),finish:()=>{publishView(current=>({...current,settings:structuredClone(input.settings),revision:'rev-2'}));finish()}});return pending},participation:async()=>{}}
 function App(){const [view,setView]=React.useState(()=>({activeMode:'local',settings:structuredClone(initial),revision:'rev-1',connection:{status:'stopped',participating:false}}));publishView=setView;return React.createElement(Form,{view,controller,language:'en',api:{}})}
 try{
  await React.act(async()=>root.render(React.createElement(App)));assert.equal(nameInput(container)?.value,'A')
  await React.act(async()=>saveButton(container).click());assert.equal(calls.length,1);assert.equal(calls[0].input.settings.name,'A');assert.equal(saved(container),false)
  const edit=async()=>{const input=nameInput(container);assert.ok(input);await React.act(async()=>Simulate.change(input,{target:{value:'B'}}));assert.equal(nameInput(container)?.value,'B')}
  if(editWhilePending)await edit()
  await React.act(async()=>{calls[0].finish();await Promise.resolve()})
  if(!editWhilePending){assert.equal(saved(container),true,'confirmed unchanged A is acknowledged');await edit()}
  assert.equal(calls.length,1,'editing alone does not submit')
  assert.equal(saved(container),false,'unsaved B must not be labelled saved')
 }finally{await React.act(async()=>root.unmount());container.remove()}
}
await run(false);await run(true)
console.log(JSON.stringify({status:'passed',cases:['save A then edit B','edit B while saving A'],limits:'Actual settings form and React state/effect via jsdom; native components and controller are controlled ports, not complete DSH browser or network.'},null,2))
