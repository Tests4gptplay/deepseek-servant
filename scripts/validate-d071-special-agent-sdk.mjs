import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { hooks as sdkHooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const { publishLegacyNativeSkill } = await import('../src/framework/local-upgrade-skill.ts')
const { localSkillUpgradeKey } = await import('../src/framework/local-upgrade-mapping.ts')
const { readLocalUpgradeCompleted } = await import('../src/framework/local-upgrade-completion.ts')
const { localUpgradeView } = await import('../src/framework/local-upgrade-view.ts')
const skillText = '---\n' + JSON.stringify({ name: 'old-method', description: 'Original old method' }) + '\n---\nPreserve original method.\n'

if (process.argv[2] === '--stop-sdk') {
  const dir = process.argv[3], business = path.join(dir, 'business'), skillPath = process.argv[4]
  const sdk = await openDshStorageFixture(path.join(dir, 'storage'), path.join(dir, 'locator'))
  await publishLegacyNativeSkill(business, skillPath, skillText, sdk.adapter, { onProgress: ({ step }) => {
    if (step === 'created') process.kill(process.pid, 'SIGKILL')
  } })
  throw Error('Current specialist publisher did not reach actual created boundary')
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-d071-sdk-'))
process.env.DSS_PO_NATIVE_ROOT = root
const { fixture, until, trace, checks: hostChecks } = await import('./helper-service-sdk.mjs')
let f, assertions = 0, bodyFailure
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++ }
try {
  const dir = path.join(root, 'special'), business = path.join(dir, 'business')
  const seeded = spawnSync(process.execPath, [fileURLToPath(new URL('./validate-d071-special-stage-choice.mjs', import.meta.url)), '--seed-skill', dir],
    { encoding: 'utf8', timeout: 30000, env: process.env })
  check(seeded.status, 0, 'frozen 55fe skill producer and frozen v44 SQLite writer seed actual old source: ' + seeded.stderr)
  const skillPath = JSON.parse(seeded.stdout.trim()).skillPath
  const originalSql = await fs.readFile(path.join(business, 'dss-files.sqlite'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop-sdk', dir, skillPath],
    { encoding: 'utf8', timeout: 30000, env: process.env })
  check(child.signal, 'SIGKILL', 'actual SDK StoragePort persisted created-stage interruption: ' + child.stderr)
  f = await fixture('special')
  const upgrade = await until('actual native upgrade model turn', () => f.model.calls.find(call => call.tools.some(tool => tool.name === 'dss_upgrade_local_files')))
  const sessionId = upgrade.sessionId
  const owner = f.service.localUpgrades.get(business)
  assert.ok(owner); assertions++
  const resultEvents = () => trace.filter(item => item.event === 'tool' && item.id === sessionId && item.type === 'tool/result')
  const command = async (action, fields = {}) => {
    await until('native model ready for ' + action, () => f.model.waiting.has(sessionId))
    const before = resultEvents().length
    f.model.command(sessionId, { name: 'dss_upgrade_local_files', input: { action, ...fields } })
    const event = await until('native tool result ' + action, () => resultEvents()[before])
    check(event.data.message.isError, false, 'actual SDK tool ' + action + ' succeeded')
    return event
  }
  await command('publish_skill', { path: skillPath, content: skillText })
  await command('materialize')
  await command('finish')
  await until('native model ready to end first turn', () => f.model.waiting.has(sessionId))
  f.model.command(sessionId, 'idle')
  const first = await owner.work
  check(first.status, 'pending', 'real SDK Agent finish leaves exact retained stage pending')
  const key = localSkillUpgradeKey(business, skillPath), specialist = await f.sdk.adapter.get(key)
  check(specialist.status, 'complete', 'real SDK Agent completed original skill owner')
  const choice = first.specialStageChoices?.find(item => item.owner.kind === 'skill' && item.owner.id === skillPath)
  assert.ok(choice); assertions++
  check(choice.operationId, specialist.operationId, 'actual Agent result offers same specialist operation')
  check(choice.path, specialist.retainedStages[0].path, 'actual Agent result offers same actual stage')
  const stage = path.join(business, choice.path), stageBytes = await fs.readFile(stage)
  check((await f.service.keepCurrentLocalUpgradeTarget({ mode: 'local', storageScope: f.active.connection.scope,
    operationId: choice.operationId, path: choice.path, stageOwner: choice.owner, confirmation: 'keep-retained-stage-without-cleanup' })).saved,
    true, 'actual Service saves user choice and restarts same Agent')
  await command('finish')
  await until('native model ready to end second turn', () => f.model.waiting.has(sessionId))
  f.model.command(sessionId, 'idle')
  const final = await owner.work
  check(final.status, 'complete', 'real SDK Agent finish and disposal complete after exact selection')
  const completed = await readLocalUpgradeCompleted(business, f.sdk.adapter)
  check(completed?.retainedSpecialStages?.[0]?.path, choice.path, 'completed record keeps stage choice')
  check(await f.sdk.adapter.get(key), undefined, 'actual Agent retirement removes exact temporary specialist operation')
  check((await localUpgradeView(business, f.sdk.adapter))?.keptRetainedStages?.[0]?.path, choice.path,
    'cold-style completed UI read retains choice')
  check(await fs.readFile(stage), stageBytes, 'real SDK Agent does not delete or change chosen stage')
  check(await fs.readFile(path.join(business, 'dss-files.sqlite')), originalSql, 'real SDK Agent preserves old SQLite')
  console.log(JSON.stringify({ status: 'passed', assertions, hostChecks: hostChecks.length, nativeSessionId: sessionId,
    ...evidence(), limits: 'Frozen v44 old writer; actual SDK StoragePort, Agent/Session/tool runtime and FrameworkService, with a controlled model driving named tool calls. Linux SIGKILL at actual specialist created step. Not installed DSH Host/model reasoning, Windows or a real user incident.' }, null, 2))
} catch (error) { bodyFailure = error; throw error }
finally {
  await f?.close().catch(error => { console.error('HOST-CLOSE-FAILURE', error); if (!bodyFailure) bodyFailure = error })
  sdkHooks.deregister()
  try { await fs.rm(root, { recursive: true, force: true }) }
  catch (error) { console.error('CLEANUP-FAILURE', error, 'BODY-FAILURE', bodyFailure); if (!bodyFailure) throw error }
}
