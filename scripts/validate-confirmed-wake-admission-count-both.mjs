import assert from 'node:assert/strict'
import { fixture, hash, checks, check, evidence, root, fs, path } from './w129/candidate-fixture.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')

async function localFixture(name) {
  const home = path.join(root, name)
  await fs.mkdir(home)
  const sdk = await openDshStorageFixture(path.join(home, 'sdk'), path.join(home, 'locator'))
  const files = new PhysicalLocalFiles(path.join(home, 'records'))
  const records = sdk.adapter
  const config = { scope: name, mode: 'local', member: 'A', primary: true, instanceUUID: '11111111-1111-4111-8111-111111111111', collaborationId: 'local', workerSeats: 1, workspace: home }
  const errors = []
  const rt = new FrameworkRoleRuntime(sdk.ctx, files, records, config, {
    sharedRecords: records, members: () => ['A'], resources: () => [], error: error => errors.push(String(error)),
  })
  return { rt, records, errors, close: async () => { await files.close(); await sdk.close() } }
}

for (const mode of ['git', 'local']) {
  const f = await (mode === 'git' ? fixture('known-wake-git') : localFixture('known-wake-local'))
  const {rt, records} = f
  const original = rt.admissionWakes.bind(rt)
  let reads = 0
  rt.admissionWakes = (...args) => { reads++; return original(...args) }
  // The new Git existence query uses the same fresh listing, without a cloned array.
  if (typeof records.some === 'function') {
    const originalSome = records.some.bind(records)
    records.some = (...args) => { reads++; return originalSome(...args) }
  }
  // End at the first existing source/role qualification boundary. All wake
  // writes, reads, competition checks and Host queuing before it are real.
  let reached
  const probeKey = 'dss-policy-test-boundary'
  rt.error = error => f.errors.push(String(error))
  const actual = rt.roleRecords.get.bind(rt.roleRecords)
  rt.roleRecords.get = id => { if (id === reached) throw new Error(probeKey); return actual(id) }
  const queue = async () => { await rt.pumping?.catch(error => { if (error.message !== probeKey) throw error }) }
  const request = id => ({ id, role:'Foreground', reason:'notification', sources:[] })
  const key = id => rt.prefix+'wakes/'+hash(id)
  async function defer(id) {
    const callback = await rt.wakeDiscovered(request(id))
    assert.equal(typeof callback, 'function')
    check(mode+' '+id+' is durable before admission', (await records.get(key(id))).request.id, id)
    return callback
  }
  async function cleanup(ids) {
    reached = undefined
    for (const id of ids) await rt.updateWake(key(id), row => row && ({ ...row, delivered:true }))
  }
  try {
    const regular = await defer('regular')
    reads=0; reached = rt.requestKey(request('regular'))
    regular(); regular(); await queue()
    check(mode+' direct wake uses one existing competition scan', reads, 1)
    const boundary = f.errors.length
    check(mode+' direct wake reaches original post-competition code', String(f.errors.at(-1)?.message ?? f.errors.at(-1)).includes(probeKey), true)
    check(mode+' no parallel targeted pump',rt.targetedPumps.size,0)
    reads=0; await rt.runQueue(false, 'regular').catch(()=>{})
    check(mode+' ordinary discovery uses two scans', reads, 2)
    check(mode+' ordinary path reaches same boundary',f.errors.length,boundary)
    await cleanup(['regular'])

    const delivered = await defer('delivered')
    await cleanup(['delivered'])
    reads=0; delivered(); await queue('delivered')
    check(mode+' delivered wake never reaches competition scan again', reads, 0)

    const prior = await defer('superseded')
    const successor = { ...request('successor'), reason:'startup-recovery' }
    await rt.wake(successor, { replacesUnadmittedWake:'superseded' })
    reached=rt.requestKey(request('superseded'))
    const caught=f.errors.length
    prior(); await queue('superseded')
    check(mode+' exact recovery successor keeps priority',f.errors.length,caught)
    await cleanup(['superseded','successor'])

    const generic = await defer('generic-prior')
    await rt.wake({...successor,id:'generic-successor'}, { completedRoundsBeforeRestart:0 })
    reached=rt.requestKey(request('generic-prior'))
    generic(); await queue('generic-prior')
    check(mode+' same-work recovery keeps generic priority',f.errors.length,caught)
    await cleanup(['generic-prior','generic-successor'])

    await defer('pending-other-role')
    check(mode+' another pending wake keeps shared discovery',
      await rt.wakeDiscovered({ id:'background-pending',role:'Planner',reason:'notification',sources:[] }),true)
    await cleanup(['pending-other-role','background-pending'])

    const once = await defer('same-id')
    check(mode+' existing wake does not enqueue a new confirmed dispatch',await rt.wakeDiscovered(request('same-id')),false)
    await cleanup(['same-id'])
    const update = rt.updateWake
    rt.updateWake = async () => { throw new Error('injected write failure') }
    await assert.rejects(rt.wakeDiscovered(request('failed')),/injected write failure/)
    check(mode+' failed write leaves no targeted admission',rt.targetedPumps.has('failed'),false)
    rt.updateWake = update
    rt.closed = true
    once()
    check(mode+' closing host discards deferred dispatch',rt.queueing,undefined)
  } finally { await f.close() }
}
console.log(JSON.stringify({status:'passed',checks,scope:'Actual Git transport/physical Local and durable SDK storage, controlled boundary before native execution.',...evidence()},null,2))
