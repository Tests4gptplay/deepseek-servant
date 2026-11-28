// Actual FrameworkService and DSH storage on an owned temporary root.
// Connection/native model ports are controlled; no network, UI render or user data.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const supplemental = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'mdast-util-from-markdown') return { url: 'data:text/javascript,export function fromMarkdown(){throw Error("Markdown is outside settings validation")}', shortCircuit: true }
  return next(specifier, context)
} })
const { FrameworkService } = await import('../src/framework/service.ts')
const { recordCategory } = await import('../src/adapters/dsh/record-files.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-settings-current-'))
const checks = [], fixtures = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const rejects = async (name, run, pattern) => { await assert.rejects(run, pattern); checks.push(name) }
const defaults = { name: 'Fixture', userName: 'Fixture', localDirectory: '/selected-local', ownerRepo: 'fixture/project', repositoryDirectory: '/', collaborationId: 'fixture', workerSeats: 1, workspace: '/workspace' }
const route = name => ({ provider: 'fixture', model: name })
// Direct Service calls state the edited fields, just as the current form does.
const configure = (service, input, changedFields = Object.keys(input.settings)) => service.configure({ ...input, changedFields })
function serviceFor(storage) {
  const service = new FrameworkService({}, storage, defaults)
  service.saved.set('local', { revision: 'initial-local', settings: { ...defaults } })
  service.saved.set('git', { revision: 'initial-git', settings: { ...defaults } })
  service.settingsView = async mode => ({ activeMode: mode, ...structuredClone(service.config(mode)) })
  service.changed = () => {}
  service.prepareGit = () => {}
  service.report = () => 'controlled-connection-failure'
  service.clearResolvedErrors = mode => service.configurationErrors.delete(mode)
  let connections = 0, failure
  service.connect = async (_mode, signal) => { signal.throwIfAborted(); connections++; if (failure) throw failure }
  return { service, get connections() { return connections }, fail(error) { failure = error } }
}
async function names(directory, prefix = '') {
  const out = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...await names(path.join(directory, entry.name), relative))
    else out.push(relative)
  }
  return out.sort()
}
try {
  const sdk = await openDshStorageFixture(path.join(root, 'records'), path.join(root, 'locator')); fixtures.push(sdk)
  const storage = sdk.adapter, f = serviceFor(storage), s = f.service
  const writes = [], nativeSet = storage.set.bind(storage)
  storage.set = async (key, value) => { writes.push(key); return nativeSet(key, value) }
  await configure(s, { mode: 'local', commandId: 'initial', settings: defaults })
  check('An unchanged first selection still persists its fixed configuration', (await storage.get('framework-settings/local')).settings, defaults)
  let previous = s.config('local')
  for (let index = 0; index < 25; index++) {
    await configure(s, { mode: 'local', commandId: 'change-' + index, settings: { ...defaults, name: 'Selection ' + index } })
    previous = s.config('local')
  }
  check('All settings writes use only fixed current/participation keys', [...new Set(writes)].sort(), ['framework-participation/local', 'framework-settings/local'])
  const localFiles = await names(path.join(root, 'records'))
  check('25 new UI operation identities leave two current physical record.json files', localFiles.filter(name => name.endsWith('record.json')).length, 2)
  check('No settings-command directory is produced', localFiles.some(name => name.includes('settings-commands')), false)
  check('No settings-command category remains', recordCategory('framework-settings-commands/' + 'a'.repeat(64)), undefined)
  check('No retained command-signature history exists', Object.hasOwn(s, 'configurationSignatures'), false)
  const revision = previous.revision, before = writes.filter(key => key === 'framework-settings/local').length
  await configure(s, { mode: 'local', commandId: 'same-current-values', settings: previous.settings })
  check('Same current values retry without revision churn', s.config('local').revision, revision)
  check('Same current values do not rewrite settings', writes.filter(key => key === 'framework-settings/local').length, before)
  // A later explicit choice of the name is admitted despite the old view;
  // unrelated fields are not part of this settings command.
  await configure(s, { mode: 'local', commandId: 'later-name-selection', settings: defaults }, ['name'])
  check('Later explicit name restoration is current', s.config('local').settings.name, defaults.name)
  await configure(s, { mode: 'local', commandId: 'reused-ui-id', settings: { ...defaults, name: 'New current' } })
  await configure(s, { mode: 'local', commandId: 'reused-ui-id', settings: { ...defaults, name: 'Later current' } })
  check('Reused ID has no historical payload gate', s.config('local').settings.name, 'Later current')
  const pendingTarget = { ...defaults, name: 'Saved before connection failure' }
  f.fail(new Error('Controlled connection unavailable'))
  await rejects('Connection failure remains an actual failure', () => configure(s, { mode: 'local', commandId: 'connect-failure', settings: pendingTarget }), /Controlled connection unavailable/)
  const savedAfterFailure = await storage.get('framework-settings/local'), openedBeforeRetry = f.connections
  check('Configuration saved before connection failure remains current', savedAfterFailure.settings, pendingTarget)
  f.fail(undefined)
  await configure(s, { mode: 'local', commandId: 'connect-failure', settings: pendingTarget })
  check('Retry actually continues connection', f.connections, openedBeforeRetry + 1)
  check('Retry uses saved current revision after connection failure', s.config('local').revision, savedAfterFailure.revision)
  const foreground = serviceFor(storage), fg = foreground.service
  await fg.foregroundModel({ mode: 'local', commandId: 'model-a', model: route('a') })
  const modelA = await storage.get('framework-settings/local')
  await fg.foregroundModel({ mode: 'local', commandId: 'model-a', model: route('a') })
  check('Current foreground model retries without revision churn', fg.config('local').revision, modelA.revision)
  await fg.foregroundModel({ mode: 'local', commandId: 'stale-model', model: route('b') })
  check('Later explicit model selection is current', fg.config('local').settings.foreground, route('b'))
  await fg.foregroundModel({ mode: 'local', commandId: 'model-a', model: route('a') })
  check('Foreground reused ID has no retained history gate', fg.config('local').settings.foreground, route('a'))
  check('Latest normal foreground model is durable in SDK storage', (await storage.get('framework-settings/local')).settings.foreground, route('a'))
  const git = serviceFor(storage), gs = git.service, gitWriteStart = writes.length
  await configure(gs, { mode: 'git', commandId: 'shared-ui-id', settings: defaults })
  for (let index = 0; index < 10; index++) {
    await configure(gs, { mode: 'git', commandId: 'git-' + index, settings: { ...defaults, name: 'Git ' + index } })
  }
  await gs.foregroundModel({ mode: 'git', commandId: 'git-model', model: route('git-model') })
  check('Repeated Git settings/model selections use only fixed Git keys', [...new Set(writes.slice(gitWriteStart))].sort(), ['framework-git-enabled', 'framework-participation/git', 'framework-settings/git'])
  check('Fixed Git configuration retains the latest selected model', (await storage.get('framework-settings/git')).settings.foreground, route('git-model'))
  const currentLocal = await storage.get('framework-settings/local')
  await configure(gs, { mode: 'local', commandId: 'shared-ui-id', settings: currentLocal.settings })
  check('Same UI ID in another mode has no retained cross-mode signature', gs.config('local').settings, currentLocal.settings)
  await new Promise(resolve => setImmediate(resolve))
  check('Actual pending command queue retires after completion', gs.settingsCommands.size, 0)
  check('Actual configuration owner set retires after completion', gs.configurationOwners.size, 0)
  check('Both modes retain only 5 fixed physical records', (await names(path.join(root, 'records'))).filter(name => name.endsWith('record.json')).length, 5)
  check('Shared durable storage contains only fixed current records', (await storage.list('')).map(row => row.key).sort(), ['framework-git-enabled', 'framework-participation/git', 'framework-participation/local', 'framework-settings/git', 'framework-settings/local'])
  await sdk.close()
  const reopened = await openDshStorageFixture(path.join(root, 'records'), path.join(root, 'locator')); fixtures.push(reopened)
  const cold = serviceFor(reopened.adapter), coldCurrent = await reopened.adapter.get('framework-settings/local')
  await configure(cold.service, { mode: 'local', commandId: 'after-sdk-reopen', settings: coldCurrent.settings })
  check('Actual SDK close/reopen retains current configuration with no command history', cold.service.config('local'), coldCurrent)
  check('Cold SDK storage has the same 5 fixed records', (await reopened.adapter.list('')).length, 5)
  check('Cold same-value retry does not create extra physical files', (await names(path.join(root, 'records'))).filter(name => name.endsWith('record.json')).length, 5)
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, checks, ...evidence(), limits: 'Real current Service methods and native DSH JSON storage on Linux. Connection/model/UI presentation are explicit controlled ports. Actual file-write response-loss injection happens after successful native write; no remote Git/native UI/Windows/model run. No old on-disk receipts are removed.' }, null, 2))
} finally {
  try { await Promise.all(fixtures.map(fixture => fixture.close())) }
  finally { try { await fs.rm(root, { recursive: true, force: true }) } finally { supplemental.deregister(); hooks.deregister() } }
}
