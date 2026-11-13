import {currentSource,emitEvidence} from './support.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {serviceFixture as fixture} from './service-fixture.mjs'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const auditRoot=await fs.mkdtemp(path.join(os.tmpdir(),'dss-switch-lifecycle-'))
process.on('exit',()=>{})
for(const mode of ['local','git']){
 test(`${mode}: workspace selection retains six original native owners, publishes future default after settings save`,async()=>{
  const f=await fixture({mode,workspace:path.join(auditRoot,mode+'-old')}),next=path.join(auditRoot,mode+'-new'),oldAgents=[...f.agents.values()];
  await f.service.configure(f.request({workspace:next}));
  assert.equal(f.service.running.get(mode),f.running);assert.equal(f.events.some(e=>['native-dispose','connection-close','loop-stop','connect'].includes(e[0])),false);
  assert.equal(f.runtime.config.workspace,next);assert.equal(f.runtime.workspaces.root,next);assert(oldAgents.every(a=>!a.disposed&&a.cwd===f.config.workspace));
  const identity={workId:'fresh',executionId:'fresh-'+mode,role:'Worker'};const fresh=await f.runtime.native.open(identity,{sessionId:'fresh-'+mode,cwd:f.runtime.config.workspace});assert.equal(fresh.cwd,next)
 })
 test(`${mode}: same selected path retains original runtime without another registry resolution`,async()=>{const f=await fixture({mode,workspace:path.join(auditRoot,mode+'-same')});await f.service.configure(f.request({workspace:f.config.workspace+'/.',background:{provider:'p',model:'new'}}));assert.equal(f.events.some(e=>['resolve-workspace','native-dispose'].includes(e[0])),false);assert.equal(f.runtime.config.background.model,'new')})
 test(`${mode}: storage and preset changes keep their distinct original stop/reconnect behavior`,async()=>{for(const change of [mode==='local'?{localDirectory:'/other-local'}:{ownerRepo:'owner/other'},{presetId:'other'}]){const f=await fixture({mode,workspace:path.join(auditRoot,mode+'-scope')});await f.service.configure(f.request({...change,workspace:path.join(auditRoot,mode+'-scope-new')}));assert.equal(f.events.filter(e=>e[0]==='native-dispose').length,6);assert.equal(f.events.filter(e=>e[0]==='connect').length,1)}})
 test(`${mode}: persistence pending leaves old root published and ordinary foreground send independent`,async()=>{const f=await fixture({mode,workspace:path.join(auditRoot,mode+'-persist')}),gate=deferred();f.setPersistGate(gate.promise);const pending=f.service.configure(f.request({workspace:path.join(auditRoot,mode+'-persist-new')}));while(!f.events.some(e=>e[0]==='persist'))await new Promise(r=>setImmediate(r));assert.equal(f.runtime.config.workspace,f.config.workspace);assert.equal(await f.service.send({mode,id:'during-workspace-save'}),'during-workspace-save');gate.resolve();await pending;assert.equal(f.events.some(e=>e[0]==='native-dispose'),false)})
 test(`${mode}: settings persistence failure does not publish new default or stop existing execution`,async()=>{const f=await fixture({mode,workspace:path.join(auditRoot,mode+'-failed')}),failure=Error('actual settings write failed');f.service.persistSettings=async()=>{throw failure};await assert.rejects(f.service.configure(f.request({workspace:path.join(auditRoot,mode+'-failed-new')})),e=>e===failure);assert.equal(f.runtime.config.workspace,f.config.workspace);assert.equal(f.current().settings.workspace,f.config.workspace);assert.equal(f.service.running.get(mode),f.running);assert.equal(f.events.some(e=>e[0]==='native-dispose'),false)})
 test(`${mode}: real destination-is-file error does not close original native owners`,async()=>{const f=await fixture({mode,workspace:path.join(auditRoot,mode+'-invalid')}),target=path.join(auditRoot,mode+'-file');await fs.writeFile(target,'not a directory');await assert.rejects(f.service.configure(f.request({workspace:target})));assert.equal(f.runtime.config.workspace,f.config.workspace);assert.equal(f.events.some(e=>e[0]==='native-dispose'),false)})
 test(`${mode}: cancelled settings operation during local binding preparation leaves old root and agents`,async()=>{const f=await fixture({mode,workspace:path.join(auditRoot,mode+'-abort')}),gate=deferred(),entered=deferred();f.runtime.prepareWorkspaceSelection=async()=>{entered.resolve();await gate.promise};const pending=f.service.configure(f.request({workspace:path.join(auditRoot,mode+'-abort-new')}));await entered.promise;for(const owner of f.service.configurationOwners)owner.controller.abort();gate.resolve();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(f.current().settings.workspace,f.config.workspace);assert.equal(f.runtime.config.workspace,f.config.workspace);assert.equal(f.events.some(e=>e[0]==='native-dispose'),false)})
}
test.after(async()=>{await fs.rm(auditRoot,{recursive:true,force:true})})
console.log('Exact candidate configure/stop/disposal/setter method bodies; actual NativeExecutions and filesystem workspace preparation; native Agents, registry persistence and service storage are controlled. No actual model or remote Git.')
