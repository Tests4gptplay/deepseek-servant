import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Real installed role tools, real Zod, Local files and controlled Git transport.
// Route values below are explicit model-tool inputs, not a simulated classifier.
// These checks do not establish how a live model would choose a route.
export async function verifyForegroundTaskRouting({ PhysicalLocalFiles, GitFiles, withSnapshot,
 FrameworkTransactions, SessionGitOperations, Repository, head, FrameworkHostLoop, installFrameworkRoleTools,
 foregroundCorePrompt, foregroundTaskRouteInstruction, foregroundFullGuide,
 upgradeForegroundGuide, initializeRoleGuides, foregroundGuidePath }) {
 const { GitAuthorityStore } = await import('../../src/framework/git-authority.ts')
 const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-foreground-routing-'))
 let assertions = 0
 const outcomes = [], check = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name); assertions++; outcomes.push(name)
 }
 const current = foregroundFullGuide()
 const priorSentences = [
  'A complex single objective remains a P task: its Planner decomposes work among Workers.',
  'Choose O only when the task package already specifies multiple independent objectives that can run in parallel; Organizer assigns individual objectives to Planners or bundles independent objectives for child Organizers.',
  'Complexity, step count and Worker count alone never justify O.',
 ]
 const routeParagraph = foregroundTaskRouteInstruction + " A P task's Planner decomposes work among Workers. Organizer assigns individual objectives to Planners or bundles independent objectives for child Organizers."
 const previous = current.replace(routeParagraph, priorSentences.join(' '))
 check('prior official guide differs from current', previous !== current, true)
 for (const [name, text] of [['core', foregroundCorePrompt], ['generated MD', current]]) {
  check(name + ': shared decision instruction', text.includes(foregroundTaskRouteInstruction), true)
  for (const sentence of [
   'choose and set the initial route yourself in dss_submit_task',
   'Do not require the user to label a request as O or P',
   'If the user explicitly specifies O or P, follow that choice.',
   'Otherwise, choose P for a single objective even when complex',
   'Keep short tasks that you can complete directly in Foreground unless the user requests delegation.',
  ]) check(name + ': ' + sentence, text.includes(sentence), true)
 }
 check('preceding official route paragraph migrates exactly', upgradeForegroundGuide(previous).text, current)
 check('three obsolete sentences replaced', upgradeForegroundGuide(previous).changedRules, 3)
 check('current guide is idempotent', upgradeForegroundGuide(current).changedRules, 0)
 const custom = '\uFEFF' + previous.replace(/\n/g, '\r\n') + '\r\n用户自定义段落 原样保留\r\n'
 const expected = '\uFEFF' + current.replace(/\n/g, '\r\n') + '\r\n用户自定义段落 原样保留\r\n'
 check('migration preserves BOM, CRLF and appended custom text', upgradeForegroundGuide(custom).text, expected)
 const inline = previous.replace(priorSentences.join(' '), priorSentences.join(' ') + ' Preserve this user-specific custom sentence.')
 check('migration preserves inline custom text', upgradeForegroundGuide(inline).text,
  current.replace(routeParagraph, routeParagraph + ' Preserve this user-specific custom sentence.'))
 const verbatim = '用户完整自定义指南\r\n' + priorSentences.join(' ')
 check('unrecognized custom guide remains untouched', upgradeForegroundGuide(verbatim).text, verbatim)
 for (const wrapped of ['```\n' + priorSentences.join(' ') + '\n```', '<!--\n' + priorSentences.join(' ') + '\n-->']) {
  const text = current + '\n' + wrapped
  check('quoted/commented historical text remains untouched', upgradeForegroundGuide(text).text, text)
 }
 try {
  for (const mode of ['local', 'git']) {
   const repo = mode === 'git' ? new Repository() : undefined
   if (repo) head(repo)
   const files = repo ? new GitFiles(repo, new SessionGitOperations()) : new PhysicalLocalFiles(path.join(scratch, mode))
   const records = new Map(), storage = repo ? new GitAuthorityStore(files, 'routing-git') : { get: async key => records.get(key), set: async (key, value) => records.set(key, value) }
   const tx = new FrameworkTransactions(files, storage, 'routing-' + mode)
   const read = target => withSnapshot(files, snapshot => files.read(snapshot, target))
   check(mode + ': missing authoritative guide initialized', (await initializeRoleGuides(files, tx)).status, 'created')
   check(mode + ': generated authoritative guide contains rule', await read(foregroundGuidePath), current)
   if (mode === 'local') await files.replace(foregroundGuidePath, previous)
   else await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: foregroundGuidePath, content: previous }], 'Prior official guide fixture'))
   check(mode + ': existing official guide migrated', (await initializeRoleGuides(files, tx)).status, 'migrated')
   check(mode + ': authoritative migrated guide matches', await read(foregroundGuidePath), current)
   check(mode + ': repeat initialization does not write a migration', (await initializeRoleGuides(files, tx)).status, 'unchanged')
   const tools = new Map(), sections = [], agent = { id: 'routing-' + mode, session: {} }
   const ctx = { on: () => () => {}, effect() {}, systemPrompt: { section: section => sections.push(section) }, tools: { register: tool => tools.set(tool.name, tool) } }
   installFrameworkRoleTools(ctx, agent, { role: 'Foreground', owner: 'A', workId: 'foreground', executionId: 'routing-' + mode }, {
    files, transact: (...args) => tx.run(...args).then(() => {}), notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError: error => { throw error },
   })
   check(mode + ': installed system prompt includes route rule', sections.find(section => section.name === 'deepseek-servant:framework-role').text.includes(foregroundTaskRouteInstruction), true)
   const submit = tools.get('dss_submit_task')
   for (const phrase of ['you, the Foreground, choose', 'Do not require the user', 'Honor an explicit user choice of O or P', 'Complete suitable short tasks directly'])
    check(mode + ': installed tool describes ' + phrase, submit.description.includes(phrase), true)
   let callIndex = 0
   const call = (name, input) => tools.get(name).execute(input, { agent, callId: 'routing-' + (++callIndex), signal: new AbortController().signal, concludeTurn() { throw Error('Submission must not conclude this turn') } })
   // Natural-language originals contain no O/P label; the Foreground supplies
   // route at tool invocation. Explicit user choice uses the same tool path.
   const submissions = [
    { name: 'Single objective', route: 'P', text: 'Build the requested report with its several research steps.' },
    { name: 'Independent objectives', route: 'O', text: 'Prepare the trip itinerary and independently update the project website.' },
    { name: 'User selected P', route: 'P', text: '按 P 任务处理这个需求。' },
    { name: 'User selected O', route: 'O', text: '按 O 任务处理这个需求。' },
   ]
   for (const item of submissions) {
    const view = await call('dss_snapshot', {})
    await call('dss_submit_task', { snapshotId: view.snapshotId, ...item })
    check(mode + ': actual submission preserves ' + item.name, await read('tasks/' + item.name + '_' + item.route + '.md'), item.text)
   }
   check(mode + ': no early Task ID or metadata created by Foreground',
    (await withSnapshot(files, snapshot => files.list(snapshot, 'tasks/'))).map(item => item.path).filter(target => target.endsWith('.json')), [])
   check(mode + ': no new route-confirmation signal', await withSnapshot(files, snapshot => files.list(snapshot, 'state/')), [])
   const wakes = [], errors = [], host = new FrameworkHostLoop(files, tx, storage,
    { member: 'A', primary: true, scope: 'routing-' + mode, instanceUUID: '10000000-0000-4000-8000-000000000001' }, () => ['A'], {
     startup: async () => {}, observe: async () => {}, observeLocal: async () => {}, executing: () => false,
     discoverTask: async () => {}, wake: async wake => { wakes.push(wake); return false }, error: error => errors.push(String(error)),
     sealBusiness: async () => {}, clean: async () => false, releaseTask: async () => {},
    })
   await host.poll(); await host.poll()
   check(mode + ': actual Host accepts all submissions without user route input', errors, [])
   const metadata = await withSnapshot(files, async snapshot => {
    const entries = await files.list(snapshot, 'tasks/')
    return Promise.all(entries.filter(item => item.path.endsWith('.json')).map(async item => JSON.parse(await files.read(snapshot, item.path))))
   })
   check(mode + ': Host creates four independent task identities', new Set(metadata.map(item => item.taskId)).size, 4)
   for (const item of submissions) {
    const task = metadata.find(task => task.sourcePath === 'tasks/' + item.name + '_' + item.route + '.md')
    check(mode + ': Host retains Foreground route for ' + item.name, task?.route, item.route)
    check(mode + ': Host emits corresponding P/O wake for ' + item.name,
     wakes.some(wake => wake.taskId === task?.taskId && wake.role === (item.route === 'P' ? 'Planner' : 'Organizer')), true)
   }
   await host.stop()
   await files.close?.()
  }
  return { assertions, outcomes, limits: 'Prompt/MD contracts, actual Local/Git submission and Host route initialization/wake; model choices supplied explicitly, controlled Git transport, no live model or full DSH/Windows acceptance.' }
 } finally { await fs.rm(scratch, { recursive: true, force: true }) }
}
