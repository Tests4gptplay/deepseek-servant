// Exercise the actual native JSON publish boundary: rename succeeds, then
// fsync of that record's parent directory fails. No Service/Storage.set wrapper.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'

const supplemental = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw Error("Markdown is outside settings validation")}', shortCircuit: true }
  return next(specifier, context)
} })
const { FrameworkService } = await import('../src/framework/service.ts')
const { recordFolder } = await import('../src/adapters/dsh/record-files.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-native-settings-window-'))
const defaults = { name: 'Fixture', userName: 'Fixture', localDirectory: '/selected-local', ownerRepo: 'fixture/project', repositoryDirectory: '/', collaborationId: 'fixture', workerSeats: 1, workspace: '/workspace' }
const route = model => ({ provider: 'fixture', model })
const checks = [], fixtures = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const key = 'framework-settings/local'
const recordFile = path.join(root, 'records', 'deepseek_servant', recordFolder(key), 'record.json')
const recordDirectory = path.dirname(recordFile)
const diskValue = async () => JSON.parse(await fs.readFile(recordFile, 'utf8')).tables.records[key].value
const configure = (service, commandId, settings) => service.configure({ mode: 'local', commandId, settings, changedFields: Object.keys(settings) })
function serviceFor(storage) {
  const service = new FrameworkService({}, storage, defaults)
  service.saved.set('local', { revision: 'initial-local', settings: { ...defaults } })
  service.settingsView = async mode => ({ activeMode: mode, ...structuredClone(service.config(mode)) })
  service.changed = () => {}
  service.prepareGit = () => {}
  service.report = () => 'controlled-native-directory-fsync-failure'
  service.clearResolvedErrors = () => {}
  service.connect = async (_mode, signal) => { signal.throwIfAborted() }
  return service
}
async function failAtNativeDirectoryFsync(run) {
  const nativeOpen = fs.open, observations = []
  fs.open = async (...args) => {
    const handle = await nativeOpen(...args)
    if (String(args[0]) === recordDirectory && args[1] === 'r' && observations.length === 0) {
      observations.push({ file: await fs.readFile(recordFile, 'utf8'), path: String(args[0]), stack: new Error().stack })
      handle.sync = async () => { throw Object.assign(new Error('controlled native post-rename directory fsync EIO'), { code: 'EIO' }) }
    }
    return handle
  }
  syncBuiltinESMExports()
  try { await assert.rejects(run, /native post-rename directory fsync EIO/) }
  finally { fs.open = nativeOpen; syncBuiltinESMExports() }
  check('actual native directory fsync was reached after rename', observations.length, 1)
  check('native fsync target is the current settings record folder', observations[0].path, recordDirectory)
  check('native call stack identifies SDK fsyncDirectory', observations[0].stack.includes('fsyncDirectory'), true)
  return JSON.parse(observations[0].file).tables.records[key].value
}
try {
  let sdk = await openDshStorageFixture(path.join(root, 'records'), path.join(root, 'locator')); fixtures.push(sdk)
  const first = serviceFor(sdk.adapter)
  await configure(first, 'initial', defaults)
  const prior = await sdk.adapter.get(key), selected = { ...defaults, name: 'Selected after native rename' }
  const atFsync = await failAtNativeDirectoryFsync(() => configure(first, 'rename-fsync-setting', selected))
  check('native directory fsync sees replaced settings document', atFsync.settings, selected)
  check('disk has replacement after native rejection', (await diskValue()).settings, selected)
  check('same live SDK cache retains prior settings after native rejection', await sdk.adapter.get(key), prior)
  check('same live Service cache retains prior settings after native rejection', first.config('local'), prior)
  await sdk.close()
  sdk = await openDshStorageFixture(path.join(root, 'records'), path.join(root, 'locator')); fixtures.push(sdk)
  const coldSetting = await sdk.adapter.get(key)
  check('cold SDK loads actual replaced settings', coldSetting.settings, selected)
  const retried = serviceFor(sdk.adapter)
  await configure(retried, 'rename-fsync-setting', selected)
  check('cold Service retry recognizes selected value without new revision', retried.config('local'), coldSetting)

  await retried.foregroundModel({ mode: 'local', commandId: 'model-before', model: route('before') })
  const priorModel = await sdk.adapter.get(key)
  const atModelFsync = await failAtNativeDirectoryFsync(() => retried.foregroundModel({ mode: 'local', commandId: 'rename-fsync-model', model: route('after') }))
  check('native directory fsync sees replaced model document', atModelFsync.settings.foreground, route('after'))
  check('disk has replacement model after native rejection', (await diskValue()).settings.foreground, route('after'))
  check('same live SDK cache retains prior model after native rejection', await sdk.adapter.get(key), priorModel)
  check('same live Service cache retains prior model after native rejection', retried.config('local'), priorModel)
  await sdk.close()
  sdk = await openDshStorageFixture(path.join(root, 'records'), path.join(root, 'locator')); fixtures.push(sdk)
  const coldModel = await sdk.adapter.get(key)
  check('cold SDK loads actual replaced model', coldModel.settings.foreground, route('after'))
  const retriedModel = serviceFor(sdk.adapter)
  await retriedModel.foregroundModel({ mode: 'local', commandId: 'rename-fsync-model', model: route('after') })
  check('cold Service model retry recognizes selected value without new revision', retriedModel.config('local'), coldModel)
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, ...evidence(), limits: 'Real native DSH JSON SDK rename and exact subsequent POSIX parent-directory fsync path on Linux with controlled sync failure. No model/UI, Windows, actual device fsync fault, or remote Git. The older post-success Storage.set wrappers are not equivalent to this native failure path.' }, null, 2))
} finally {
  try { await Promise.all(fixtures.map(fixture => fixture.close())) }
  finally { await fs.rm(root, { recursive: true, force: true }); supplemental.deregister(); hooks.deregister() }
}
