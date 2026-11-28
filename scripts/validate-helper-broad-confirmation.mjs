// Real production prompt/tool registration and SDK storage. No model-behavior claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { evidence, hash } from './test-support/dsh-sdk-runtime.mjs'
import { localFixture } from './helper-retirement-local-fixture.mjs'
import { gitFixture } from './helper-retirement-git-fixture.mjs'
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { frameworkRolePrompt } = await import('../src/framework/role-prompts.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { paths } = await import('../src/framework/task-files.ts')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-broad-confirmation-'))
const checks = [], results = []
const check = (label, actual, expected) => { assert.deepEqual(actual, expected, label); checks.push(label) }
const scopeRule = 'Before ending, make a responsibility-wide judgment'
try {
  for (const [mode, primary] of [['local', true], ['git', true], ['git', false]]) {
    const start = checks.length, f = mode === 'local' ? await localFixture(path.join(scratch, mode)) : await gitFixture()
    try {
      f.rt.config.primary = primary; f.rt.config.collaborationId = 'existing-scope'; f.rt.workspaces = { hasBinding: () => false }
      const records = f.records ?? f.sdk.adapter
      const write = async (p, text) => mode === 'local' ? f.files.replace(p, text) : withSnapshot(f.files, s => f.files.commit(s, [{ path: p, content: text }], 'fixture source'))
      const taskId = '10000000-0000-4000-8000-000000000001', otherTask = '10000000-0000-4000-8000-000000000002'
      await write(paths.task(taskId), JSON.stringify({ version: 1, taskId, route: 'P', owner: 'A', members: ['A', 'B'], status: 'running', sourcePath: 'tasks/source_P.md' }))
      await write(paths.task(otherTask), JSON.stringify({ version: 1, taskId: otherTask, route: 'O', owner: 'B', status: 'running', sourcePath: 'tasks/other_O.md' }))
      await write(paths.inbox(taskId, 'A'), 'Existing work is progressing. This is not a completion request.')
      await write(paths.memberStatus(taskId, 'A'), JSON.stringify({ state: 'running' }))
      await write(paths.member(taskId, 'A') + '/Plan_Note.md', 'Preserved current progress.')
      await write(paths.run(otherTask) + '/Organizer_Note.md', 'Unrelated task body must not be eagerly read.')
      const recovery = paths.state('A', taskId) + '/recovery', later = 'state/Helper_A_' + hash('later-help'), peer = 'state/Helper_B_' + hash('peer-help')
      await write(recovery, ''); await write(later, ''); await write(peer, '')
      const content = () => withSnapshot(f.files, async snapshot => Object.fromEntries(await Promise.all((await f.files.list(snapshot, '')).map(async row => [row.path, hash(await f.files.readBytes(snapshot, row.path))]))))
      const beforeFiles = await content(), beforeRecords = await records.list(''), reads = []
      const original = {}
      for (const name of ['read', 'readBytes', 'list', 'listDirectory']) {
        original[name] = f.files[name]
        f.files[name] = function(snapshot, p, ...rest) { reads.push({ method: name, path: p }); return original[name].call(this, snapshot, p, ...rest) }
      }
      const tools = new Map(), sections = new Map(), cleanups = []
      const ctx = { on: () => () => {}, effect: fn => cleanups.push(fn()), systemPrompt: { section: value => sections.set(value.name, value.text) }, tools: { register: tool => tools.set(tool.name, tool) } }
      const binding = f.rt.binding(f.record, f.record.delivery.request), services = f.rt.services()
      installFrameworkRoleTools(ctx, f.actual, binding, services)
      check('registration does not read task inventory or bodies', reads, [])
      const prompt = sections.get('deepseek-servant:framework-role')
      check('actual native role section loads broad responsibility rule', prompt.includes(scopeRule), true)
      check('broad rule forbids fixed per-exit full-task scan', prompt.includes('not a fixed scan of every Task, Inbox or business document on every exit'), true)
      check('current facts are reused for specific gaps', prompt.includes('use existing dss_list and dss_read only to resolve a concrete gap'), true)
      check('single recovery check does not end other accepted duties', prompt.includes('This closes that check, not other responsibilities in your current Helper round'), true)
      check('old single-check immediate exit direction is gone', prompt.includes('preserve the actual result and end your turn normally'), false)
      check('healthy tasks are not required to finish', prompt.includes('Healthy long-running work need not finish'), true)
      check('scope facts did not add new binding fields', ['mode', 'primary', 'helperScope'].some(key => Object.hasOwn(binding, key)), false)
      check('existing owner and scope remain available', [binding.owner, binding.collaborationId], ['A', 'existing-scope'])
      check('restore-host tool declares its writing effect', tools.get('dss_restore_host').description.includes('write recovery markers'), true)
      check('restore-host is not offered as exit inspection', tools.get('dss_restore_host').description.includes('not a read-only inspection or an exit check'), true)
      let seq = 0
      const call = (name, args) => tools.get(name).execute(args, { agent: f.actual, callId: 'read-' + ++seq, signal: new AbortController().signal, concludeTurn() { throw new Error('Read-only inspection must not conclude the native turn') } })
      const view = await call('dss_snapshot', {})
      check('snapshot retains this Host actual pending signal', view.notifications, [later])
      check('snapshot does not read all tasks for an exit check', reads.some(row => row.path.startsWith('tasks/')), false)
      const list = await call('dss_list', { snapshotId: view.snapshotId, directory: 'tasks/' })
      check('explicit metadata query returns current Task identities', list.files.map(row => row.path).sort(), [paths.task(taskId), paths.task(otherTask)].sort())
      check('explicit directory list does not read Task bodies', reads.some(row => ['read', 'readBytes'].includes(row.method) && row.path.startsWith('tasks/')), false)
      const status = await call('dss_read', { snapshotId: view.snapshotId, path: paths.memberStatus(taskId, 'A') })
      const inbox = await call('dss_read', { snapshotId: view.snapshotId, path: paths.inbox(taskId, 'A') })
      check('exact existing member status is available', JSON.parse(status.text).state, 'running')
      check('exact existing member Inbox is available', inbox.text.includes('Existing work is progressing.'), true)
      check('reading known facts does not inspect another task body', reads.some(row => ['read', 'readBytes'].includes(row.method) && row.path.startsWith(paths.run(otherTask) + '/')), false)
      await call('dss_snapshot_release', { snapshotId: view.snapshotId })
      for (const name of Object.keys(original)) f.files[name] = original[name]
      check('queries preserve recovery, own/peer pending signals and business files', await content(), beforeFiles)
      check('queries create no restoration request, ACK or completion state', await records.list(''), beforeRecords)
      for (const fn of cleanups) if (typeof fn === 'function') await fn()
      results.push({ mode, primary, checks: checks.length - start })
    } finally { if (mode === 'local') await f.close(); else { await f.rt.transactions.closeGitSession(new Error('Test complete')); await f.files.close?.() } }
  }
  for (const role of ['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder']) check('new Helper rule is not imposed on ' + role, frameworkRolePrompt(role).includes(scopeRule), false)
  console.log(JSON.stringify({ passed: checks.length, checks, results, evidence: evidence(), limits: [
    'Actual installFrameworkRoleTools, Runtime binding/services and installed SDK are loaded. Existing fixtures supply native role identity, not a live model.',
    'Local business files are physical and technical storage is actual SDK; Git uses actual authority/FilesStore with controlled transport.',
    'The test verifies actual loaded instructions, original read tools and absence of new writes/eager scans. It does not prove model compliance or a live Windows Host run.',
    'Active multi-request adoption and recovery-check clocks are separately covered by validate-active-helper-claims and existing helper regression scripts.'
  ] }, null, 2))
} finally { await fs.rm(scratch, { recursive: true, force: true }) }
