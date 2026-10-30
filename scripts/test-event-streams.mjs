import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await (await import('node:fs/promises')).mkdir(root+'/.validation/events-ui', {recursive:true})
const require = createRequire(root + '/package.json')
const { build } = require('esbuild'), { JSDOM } = require('jsdom')
await build({ entryPoints:[root+'/src/client.tsx'], outfile:root+'/.validation/events-ui/client.mjs', bundle:true, platform:'node', format:'esm', target:'node24', external:['react','react/*','react-dom','react-dom/*'], loader:{'.css':'empty'}, define: Object.fromEntries(['STATUS_ICON','ICON','WELCOME_CHARACTER','TASK_EMPTY_CHARACTER'].map(k=>['__SERVANT_'+k+'_DATA_URI__','""'])) })
const NativeEventSource = globalThis.EventSource
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
globalThis.document=dom.window.document
const { apply } = await import('../.validation/events-ui/client.mjs')
const tick=()=>new Promise(r=>setImmediate(r))
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const evidence=[]
for (const terminal of ['404','503','wrong-mime']) {
  let stage='ready', requests=0, reads=0, reply='pause/resume replies only'
  const openResponses=new Set(), instances=[], errors=[], waiting=defer()
  const server=createServer((req,res)=>{
    requests++
    if(stage==='startup') {res.writeHead(terminal==='wrong-mime'?200:Number(terminal),{'content-type':'text/plain'});res.end('endpoint not ready');return}
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'})
    res.write('retry: 10\nevent: changed\ndata: {}\n\n')
    openResponses.add(res);res.on('close',()=>openResponses.delete(res))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${server.address().port}/`
  dom.reconfigure({url:origin})
  globalThis.EventSource=class extends NativeEventSource {
    constructor(url){super(url);instances.push(this);this.addEventListener('error',()=>{errors.push({state:this.readyState});if(instances.length===2&&instances.every(e=>e.readyState===NativeEventSource.CLOSED))waiting.resolve()})}
  }
  const listeners=new Map(),cleanups=[],slots=new Map()
  const observable=value=>({getSnapshot:()=>value,subscribe:()=>()=>{}})
  const services={sessions:{list:observable({phase:'ready',ids:[],byId:{}})},workspaces:{list:observable({phase:'ready',items:[]})},modelDirectories:{},remote:{},connection:{rpc:{call:async (_base,endpoint,payload)=>{
    assert.equal(endpoint,'deepseek-servant-mode/shared')
    if(payload.method==='retention')return {ok:true,value:{totalBytes:0}}
    assert.equal(payload.method,'view'); reads++
    return {ok:true,value:{assistant:{id:'default',revision:1,settings:{},workspace:{},pendingInputs:[]},messages:[{id:reply,text:reply,role:'assistant',at:'2026-10-29T00:00:00Z'}],tasks:[],knowledge:[],workspaces:[],runtime:{status:'running'},conversationMode:'LOCAL'}}
  }}}}
  const ctx={get:key=>services[key],effect:fn=>{const end=fn();if(end)cleanups.push(end)},on:(key,fn)=>{listeners.set(key,fn);return()=>listeners.delete(key)},locale:{register:()=>()=>{},bind:()=>key=>key},slots:{inject:(_name,fn)=>fn(),register:spec=>{slots.set(spec.name+':'+(spec.key??spec.id),spec);return()=>{}}}}
  apply(ctx)
  const props=slots.get('main:deepseek-servant').inject()
  const source=props.hooks.servant
  const stop=source.subscribe(()=>{})
  while(instances.length<2||instances.some(e=>e.readyState!==NativeEventSource.OPEN))await tick()
  while(source.getSnapshot().status!=='ready')await tick()
  const initialRequests=requests
  stage='startup'
  for(const res of openResponses)res.destroy()
  await waiting.promise
  assert.equal(instances.length,2)
  assert(instances.every(e=>e.readyState===NativeEventSource.CLOSED))
  const terminalRequests=requests
  stage='ready'
  const readsBeforeReset=reads
  listeners.get('connection/reset')()
  await tick();await tick()
  assert.equal(source.getSnapshot().status,'ready')
  assert(reads>readsBeforeReset,'native reset performs one current RPC read')
  assert.equal(instances.length,4,'native reset recreates both terminated SSE')
  while(instances.slice(2).some(e=>e.readyState!==NativeEventSource.OPEN))await tick()
  while(source.getSnapshot().status!=='ready')await tick()
  assert.equal(requests,terminalRequests+2)
  reply='final foreground delivery, committed after reconnect'
  for(const res of openResponses)res.write('event: changed\ndata: {}\n\n')
  while(source.getSnapshot().value.messages.at(-1).text!==reply)await tick()
  assert.equal(source.getSnapshot().value.messages.filter(message=>message.text===reply).length,1,'multiple stream invalidations do not duplicate the final message')
  evidence.push({terminal,initialRequests,terminalRequests,sseInstancesAfterNativeReset:instances.length,statesAfterNativeReset:instances.map(e=>e.readyState),readsBeforeReset,readsAfterRecovery:reads,automaticDelivery:true,finalMessageCount:source.getSnapshot().value.messages.length,errors})
  stop();for(const fn of cleanups.reverse())await fn();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
globalThis.EventSource=NativeEventSource;dom.window.close()
const sourceHash=createHash('sha256').update(await readFile(root+'/src/client.tsx')).digest('hex')
const result={status:'PASS_CLIENT_REAL_HTTP_SSE_RECOVERY',runtime:process.version,clientSourceHash:sourceHash,scope:'Exact candidate client apply, native Node EventSource and real isolated loopback HTTP; synthetic native Context/RPC. Does not prove original browser received any terminal response.',evidence}
await writeFile(root+'/.validation/events-ui/result.json',JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
