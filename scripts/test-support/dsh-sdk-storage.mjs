import './dsh-sdk-runtime.mjs'
const { Context } = await import('@deepseek-ai/cordis')
const { Storage } = await import('@deepseek-ai/dsh-storage')
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain')
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json')
const { DshStorageAdapter } = await import('../../src/adapters/dsh/storage.ts')

/** Actual SDK services in a temporary fixture, without model/accounts/network.
 * The caller supplies both owned directories. Close also releases the native
 * locator/default backends, which are normally owned by the Host plugins.
 */
export async function openDshStorageFixture(directory, locatorDirectory) {
  const ctx = new Context()
  new Storage(ctx)
  const native = new JsonStorageBackend(directory), locator = new JsonStorageBackend(locatorDirectory)
  ctx.storage.backend.register('json', native)
  ctx.storage.backend.register('locator', locator)
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'json', routes: { deepseek_servant_location: 'locator' } }))
  let adapter, closing
  const close = () => closing ??= (async () => {
    const outcomes = await Promise.allSettled([adapter?.close()])
    outcomes.push(...await Promise.allSettled([ctx.storageDomain.closeAll()]))
    outcomes.push(...await Promise.allSettled([native.close(), locator.close()]))
    const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Native storage fixture close failed.')
  })()
  try { adapter = await DshStorageAdapter.open(ctx) }
  catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native storage fixture open failed.') }
    throw error
  }
  return { ctx, adapter, native, locator, close }
}
