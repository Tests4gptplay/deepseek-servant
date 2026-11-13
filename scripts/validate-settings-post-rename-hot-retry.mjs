// Same live Service/SDK retry after the native JSON rename→directory-fsync window.
// This is a controlled failure at the SDK's real operation, not a disk-fault report.
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
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-native-hot-settings-'))
const fixtures = [], checks = [], key = 'framework-settings/local'
const defaults = { name: 'Fixture', userName: 'Fixture', localDirectory: '/selected-local', ownerRepo: 'fixture/project', repositoryDirectory: '/', collaborationId: 'fixture', workerSeats: 1, workspace: '/workspace', background: { provider: 'fixture', model: 'background-old' } }
const route = model => ({ provider: 'fixture', model })
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const recordFile = path.join(root, 'records', 'deepseek_servant', recordFolder(key), 'record.json')
const directory = path.dirname(recordFile)
const onDisk = async () => JSON.parse(await fs.readFile(recordFile, 'utf8')).tables.records[key].value
const configure = (service, commandId, settings, changedFields = Object.keys(settings)) => service.configure({ mode: 'local', commandId, settings, changedFields })
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
async function rejectInsideSdk(run) {
  const originalOpen = fs.open, reached = []
  fs.open = async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) === directory && args[1] === 'r' && reached.length === 0) {
      reached.push({ path: String(args[0]), stack: new Error().stack, disk: await onDisk() })
      handle.sync = async () => { throw Object.assign(new Error('controlled native directory fsync EIO'), { code: 'EIO' }) }
    }
    return handle
  }
  syncBuiltinESMExports()
  try { await assert.rejects(run, /controlled native directory fsync EIO/) }
  finally { fs.open = originalOpen; syncBuiltinESMExports() }
  check('one native post-rename directory sync intercepted', reached.length, 1)
  check('intercepted SDK fsyncDirectory stack', reached[0].stack.includes('fsyncDirectory'), true)
  return reached[0].disk
}
const without = (settings, field) => Object.fromEntries(Object.entries(settings).filter(([key]) => key !== field))
try {
  const sdk = await openDshStorageFixture(path.join(root, 'records'), path.join(root, 'locator')); fixtures.push(sdk)
  const service = serviceFor(sdk.adapter)
  await configure(service, 'initial', defaults)
  await service.foregroundModel({ mode: 'local', commandId: 'model-initial', model: route('front-old') })
  const beforeSettings = await sdk.adapter.get(key)
  const newSettings = { ...beforeSettings.settings, name: 'After native rename' }
  const settingsAtFailure = await rejectInsideSdk(() => configure(service, 'hot-settings', newSettings, ['name']))
  check('native rename wrote selected name before sync failed', settingsAtFailure.settings.name, newSettings.name)
  check('SDK hot cache remains old immediately after rejection', await sdk.adapter.get(key), beforeSettings)
  check('Service hot cache remains old immediately after rejection', service.config('local'), beforeSettings)
  await service.foregroundModel({ mode: 'local', commandId: 'intervening-model', model: route('front-between') })
  const beforeSettingsRetry = await sdk.adapter.get(key)
  check('intervening real model selection is current before settings retry', beforeSettingsRetry.settings.foreground, route('front-between'))
  await configure(service, 'hot-settings', newSettings, ['name'])
  const afterSettings = await sdk.adapter.get(key)
  check('same Service/SDK retry selects requested name', afterSettings.settings.name, newSettings.name)
  check('same Service/SDK retry preserves intervening model and other fields', without(afterSettings.settings, 'name'), without(beforeSettingsRetry.settings, 'name'))
  check('same Service/SDK and disk agree on settings after retry', service.config('local'), afterSettings)
  check('disk agrees on settings and revision after retry', await onDisk(), afterSettings)
  check('retry uses one current revision, not prior cached revision', afterSettings.revision === beforeSettings.revision, false)
  check('retry revision follows a fresh successful publish', afterSettings.revision === settingsAtFailure.revision, false)

  const beforeModel = await sdk.adapter.get(key)
  const modelAtFailure = await rejectInsideSdk(() => service.foregroundModel({ mode: 'local', commandId: 'hot-model', model: route('front-new') }))
  check('native rename wrote selected model before sync failed', modelAtFailure.settings.foreground, route('front-new'))
  check('SDK hot cache remains old model immediately after rejection', await sdk.adapter.get(key), beforeModel)
  check('Service hot cache remains old model immediately after rejection', service.config('local'), beforeModel)
  await configure(service, 'intervening-name', { ...service.config('local').settings, name: 'Intervening selected name' }, ['name'])
  const beforeModelRetry = await sdk.adapter.get(key)
  check('intervening real name selection is current before model retry', beforeModelRetry.settings.name, 'Intervening selected name')
  await service.foregroundModel({ mode: 'local', commandId: 'hot-model', model: route('front-new') })
  const afterModel = await sdk.adapter.get(key)
  check('same Service/SDK model retry selects requested model', afterModel.settings.foreground, route('front-new'))
  check('same Service/SDK model retry preserves intervening name and other fields', without(afterModel.settings, 'foreground'), without(beforeModelRetry.settings, 'foreground'))
  check('same Service/SDK and disk agree on model after retry', service.config('local'), afterModel)
  check('disk agrees on model and revision after retry', await onDisk(), afterModel)
  check('model retry uses one current revision, not prior cached revision', afterModel.revision === beforeModel.revision, false)
  check('model retry revision follows a fresh successful publish', afterModel.revision === modelAtFailure.revision, false)

  const beforeDirectSettings = await sdk.adapter.get(key)
  const directSettings = { ...beforeDirectSettings.settings, name: 'Direct hot retry name' }
  const directSettingsAtFailure = await rejectInsideSdk(() => configure(service, 'direct-hot-settings', directSettings, ['name']))
  check('direct settings failure leaves live adapter at previous revision', await sdk.adapter.get(key), beforeDirectSettings)
  await configure(service, 'direct-hot-settings', directSettings, ['name'])
  const afterDirectSettings = await sdk.adapter.get(key)
  check('direct same-choice settings retry selects the requested name', afterDirectSettings.settings.name, directSettings.name)
  check('direct settings retry preserves all unrelated fields', without(afterDirectSettings.settings, 'name'), without(beforeDirectSettings.settings, 'name'))
  check('direct settings retry creates one successful current revision', afterDirectSettings.revision === directSettingsAtFailure.revision, false)
  check('direct settings retry aligns Service, SDK and disk', [service.config('local'), await onDisk()], [afterDirectSettings, afterDirectSettings])

  const beforeDirectModel = await sdk.adapter.get(key)
  const directModelAtFailure = await rejectInsideSdk(() => service.foregroundModel({ mode: 'local', commandId: 'direct-hot-model', model: route('direct-model') }))
  check('direct model failure leaves live adapter at previous revision', await sdk.adapter.get(key), beforeDirectModel)
  await service.foregroundModel({ mode: 'local', commandId: 'direct-hot-model', model: route('direct-model') })
  const afterDirectModel = await sdk.adapter.get(key)
  check('direct same-choice model retry selects the requested model', afterDirectModel.settings.foreground, route('direct-model'))
  check('direct model retry preserves all unrelated fields', without(afterDirectModel.settings, 'foreground'), without(beforeDirectModel.settings, 'foreground'))
  check('direct model retry creates one successful current revision', afterDirectModel.revision === directModelAtFailure.revision, false)
  check('direct model retry aligns Service, SDK and disk', [service.config('local'), await onDisk()], [afterDirectModel, afterDirectModel])
  check('hot retries did not create unrelated SDK records', (await sdk.adapter.list('')).map(row => row.key).sort(), ['framework-participation/local', key])
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, ...evidence(), limits: 'Actual Service, DSH adapter and native JSON SDK on Linux; controlled fsync failure inside post-rename native path. Same live Service/SDK retries. No real disk failure, power-loss, Windows, model, UI or remote Git test. Separate cold-open and visible-disk validation remains in validate-settings-post-rename-window.mjs.' }, null, 2))
} finally {
  try { await Promise.all(fixtures.map(fixture => fixture.close())) }
  finally { await fs.rm(root, { recursive: true, force: true }); supplemental.deregister(); hooks.deregister() }
}
