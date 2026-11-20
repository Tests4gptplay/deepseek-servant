import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
const { openDshStorageFixture } = await import('./test-support/dsh-sdk-storage.mjs')
const { FrameworkRecordMove, recordMoveKey } = await import('../src/framework/record-move.ts')
const { LocalLocationRegistry } = await import('../src/framework/local-location.ts')
const { RecordMoveNotStartedError } = await import('../src/framework/client-error.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-return-'))
const signal = new AbortController().signal
const get = p => fs.readFile(p, 'utf8')
const put = async (p, v) => { await fs.mkdir(path.dirname(p), {recursive:true}); await fs.writeFile(p,v) }
let checks=0
const check=(a,b)=>{assert.deepEqual(a,b);checks++}
async function round(kind, adjacent = false) {
  const base=path.join(root,kind+(adjacent?'-adjacent':'')), A=path.join(base,'A'), B=path.join(base,'B'), C=path.join(base,'C')
  const initial=path.join(A,'deepseek_servant','framework')
  // A historical custom scope can have a non-path identity from a previous
  // canonical relocation. This fixture keeps a realistic external first root.
  const realInitial=kind==='custom'?path.join(base,'external-original'):initial
  const actualScope=JSON.stringify(['local',realInitial])
  const fixture=await openDshStorageFixture(A,path.join(base,'locator'))
  const store=fixture.adapter,registry=new LocalLocationRegistry(store)
  const mover=new FrameworkRecordMove(store,store,{
    async quiesce() {},
    async applySettings(receipt) { await store.set('framework-settings/local',receipt.settingsAfter) },
    async restoreSettings(receipt) { await store.set('framework-settings/local',receipt.settingsBefore) },
    async reopen() {},
  })
  const settings=(localDirectory,revision)=>({revision,settings:{localDirectory}})
  const request=(sourceRecords,targetRecords,sourceLocal,revision)=>({sourceRecords,targetRecords,sourceLocal,scope:actualScope,
    localBackend:'physical',settingsBefore:settings(sourceLocal,revision),nextSettingsRevision:revision+'-next'})
  const run=(id,...args)=>mover.run(id,request(...args),signal)
  try {
    await put(path.join(realInitial,'data','current.txt'),'active A')
    const first=await run('A-B',A,B,realInitial,'r1')
    check(first.phase,'applied')
    check(await get(path.join(first.targetLocal,'data','current.txt')),'active A')
    await put(path.join(A,'deepseek_servant','old-extra.txt'),'modified original A tech')
    await put(path.join(realInitial,'data','current.txt'),'modified original Local A')
    await put(path.join(first.targetLocal,'data','current.txt'),'new active B')
    await assert.rejects(()=>run('wrong-target',B,realInitial,first.targetLocal,'r2'),RecordMoveNotStartedError);checks++
    if(kind==='custom') {
      const malformed={...request(B,realInitial,first.targetLocal,'r2'),commandId:'misdirected-old',localKind:'custom',
        targetLocal:path.join(realInitial,'old-scratch'),settingsAfter:settings(realInitial,'old-wrong'),phase:'prepared'}
      await store.set(recordMoveKey,{version:1,receipts:[first,malformed]})
      await assert.rejects(()=>mover.resumePending(signal),e=>!(e instanceof RecordMoveNotStartedError) && /Abandon this/.test(String(e)));checks++
      check((await mover.pendingReceipt()).phase,'prepared')
      check((await mover.abandon('misdirected-old',signal)).phase,'abandoned')
      check(await get(path.join(realInitial,'data','current.txt')),'modified original Local A')
    }
    const second=adjacent?first:await run('B-C',B,C,first.targetLocal,'r2')
    await put(path.join(second.targetLocal,'data','current.txt'),adjacent?'new active B':'new active C')
    const third=await run(adjacent?'B-A':'C-A',adjacent?B:C,A,second.targetLocal,'r3')
    check(third.returnFrom,'A-B');check(third.phase,'applied')
    check(await registry.resolve(third.targetLocal),actualScope)
    check(await get(path.join(third.targetLocal,'data','current.txt')),adjacent?'new active B':'new active C')
    check(await get(path.join(third.retainedTargets[0],'old-extra.txt')),'modified original A tech')
    if(kind==='owned') check(await get(path.join(third.retainedTargets[0],'framework/data/current.txt')),'modified original Local A')
    else check(await get(path.join(realInitial,'data','current.txt')),'modified original Local A')
    await put(path.join(third.targetLocal,'data','current.txt'),'current A after return')
    await put(path.join(first.targetLocal,'data','current.txt'),'modified retained B Local')
    const realMove = store.moveRecords.bind(store)
    if(kind==='custom') {
      store.moveRecords=async(...args)=>{await realMove(...args);throw Error('Controlled lost technical acknowledgement')}
      await assert.rejects(()=>run('A-B-again',A,B,third.targetLocal,'r4'),/lost technical acknowledgement/);checks++
      check(store.storageView().directory,B)
      check((await mover.pendingReceipt()).phase,'prepared')
      await assert.rejects(()=>mover.abandon('A-B-again',signal),/target may be active/);checks++
      check((await mover.pendingReceipt()).phase,'prepared')
      store.moveRecords=realMove
    }
    const fourth=kind==='custom'?await mover.resumePending(signal):await run('A-B-again',A,B,third.targetLocal,'r4')
    check(fourth.returnFrom,adjacent?'B-A':'B-C')
    check(await get(path.join(fourth.targetLocal,'data','current.txt')),'current A after return')
    const retainedLocal=kind==='custom'?fourth.retainedTargets.find(x=>x.startsWith(first.targetLocal+'.dss-retained-')):path.join(fourth.retainedTargets[0],'framework')
    check(await get(path.join(retainedLocal,'data','current.txt')),'modified retained B Local')
    check(await registry.resolve(fourth.targetLocal),actualScope)
    check((await mover.resumePending(signal)),undefined)
    const receipts=await store.get(recordMoveKey)
    check(receipts.receipts.length,1);check(receipts.receipts[0].localCopy,undefined)
  } finally { await fixture.close() }
}
try {
 await round('owned',true); await round('custom',true)
 await round('owned'); await round('custom')
 console.log(JSON.stringify({status:'passed',checks,...evidence()},null,2))
} finally {
 hooks.deregister()
 await fs.rm(root,{recursive:true,force:true})
}
