import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameworkClientController, getFrameworkClientController, type FrameworkClientApi, type FrameworkClientView, type FrameworkSendInput } from '../src/framework/client-contracts.js'
const view = (mode: 'local' | 'git'): FrameworkClientView => ({ revision: mode + '-1', activeMode: mode, collaborationId: mode + '-team', storageScope: mode + '-storage', settings: { name: 'DSS', userName: '', localDirectory: '/test', ownerRepo: 'owner/repo', repositoryDirectory: '', collaborationId: mode + '-team', workerSeats: 0, workspace: '/test' }, connection: { status: 'unknown', participating: false }, messages: [], tasks: [], legacyTasks: [], archives: [], resources: [{ name: 'offline member', status: 'offline' }] })
function api(extra: Partial<FrameworkClientApi> = {}): FrameworkClientApi {
  return { knowledgeList: async () => ({ revision: 'H', items: [] }), knowledgeRead: async input => ({ revision: 'H', path: input.path, text: undefined }), knowledgeEdit: async () => ({ revision: 'H' } as any), knowledgeStatus: async () => ({ revision: 'H' } as any), gitMembers: async () => ({ invitations: [], collaborators: [] }), gitMemberAction: async () => {}, taskControl: async input => view(input.mode), stopExecution: async input => view(input.mode), invite: async () => ({ status: 'pending' }), view: async input => view(input.mode ?? 'local'), history: async () => ({ messages: [], revision: 'H' }), send: async () => ({ revision: 'H' }), configure: async input => ({ ...view(input.mode), settings: input.settings }), legacyControl: async input => view(input.mode), participation: async input => ({ ...view(input.mode), connection: { status: 'unknown', participating: input.enabled } }), selectMode: async input => view(input.mode), readFile: async input => ({ path: input.path, text: 'actual response seam', revision: 'H' }), subscribeChanged: () => () => {}, ...extra }
}
const draft: FrameworkSendInput = { mode: 'git', collaborationId: 'git-team', storageScope: 'git-storage', id: 'message-1', createdAt: '2026-10-31T00:00:00.000Z', text: '  exact original\n😀', recipient: 'ai', device: 'browser', timezoneOffsetMinutes: 540 }
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }

const savedDraftView = (): FrameworkClientView => ({ ...view('git'), messages: [{ id: draft.id, participantId: 'A', createdAt: draft.createdAt, role: 'user', text: draft.text }] })

test('authoritative message readback displays before held panels; older view cannot erase it and dirty still advances', async () => {
  const held = deferred<FrameworkClientView>(), entered = deferred<void>()
  let armed = false, reads = 0
  const controller = new FrameworkClientController(api({
    sentMessage: async () => ({ message: savedDraftView().messages[0], order: [draft.id], revision: 'opaque-commit' }),
    view: async input => {
      if (!armed || input.headerOnly) return view('git')
      if (++reads === 1) { entered.resolve(); return held.promise }
      return { ...savedDraftView(), resources: [{ name: 'fresh peer', status: 'online' }] }
    },
  }))
  await controller.selectMode('git'); armed = true
  const old = controller.refresh(); await entered.promise
  await controller.send(draft)
  assert.deepEqual(controller.snapshot().value?.messages.map(message => message.id), [draft.id])
  const dirty = controller.refresh()
  held.resolve(view('git')); await Promise.all([old, dirty])
  assert.equal(reads, 2); assert.equal(controller.snapshot().value?.messages[0].text, draft.text)
  assert.equal(controller.snapshot().value?.resources[0].name, 'fresh peer')
  assert.equal(controller.snapshot().value?.revision, 'git-1', 'settings revision is never a commit clock')
})

test('an old view may finish after readback without erasure; a later authoritative cleanup can remove it', async () => {
  const held = deferred<FrameworkClientView>(), entered = deferred<void>(); let armed = false, reads = 0
  const controller = new FrameworkClientController(api({ sentMessage: async () => ({ message: savedDraftView().messages[0], order: [draft.id], revision: 'H' }),
    view: async input => { if (!armed || input.headerOnly) return view('git'); if (++reads === 1) { entered.resolve(); return held.promise } return view('git') },
  }))
  await controller.selectMode('git'); armed = true
  const old = controller.refresh(); await entered.promise; await controller.send(draft)
  held.resolve(view('git')); await old
  assert.equal(controller.snapshot().value?.messages[0].id, draft.id)
  await controller.refresh(); assert.deepEqual(controller.snapshot().value?.messages, [])
})

for (const later of ['fresh-view', 'mode-change', 'history-navigation'] as const) test('late single-message readback cannot replace newer ' + later, async () => {
  const response = deferred<Awaited<ReturnType<NonNullable<FrameworkClientApi['sentMessage']>>>>(), entered = deferred<void>()
  const controller = new FrameworkClientController(api({ sentMessage: () => { entered.resolve(); return response.promise } }))
  await controller.selectMode('git')
  const sending = controller.send(draft); await entered.promise
  if (later === 'fresh-view') await controller.refresh()
  else if (later === 'mode-change') await controller.selectMode('local')
  else await controller.navigateHistory({ date: '2026-10-30', limit: 20 })
  response.resolve({ message: savedDraftView().messages[0], order: [draft.id], revision: 'old' }); await sending
  assert.deepEqual(controller.snapshot().value?.messages, [])
  assert.equal(controller.snapshot().drafts[0].state, 'confirmed')
})

test('readback failure preserves confirmed receipt, exposes error, and does not manufacture draft text', async () => {
  let writes = 0
  const controller = new FrameworkClientController(api({ send: async () => { writes++; return { revision: 'H' } }, sentMessage: async () => { throw new Error('permission denied on read') } }))
  await controller.selectMode('git'); await assert.rejects(controller.send(draft), /permission/)
  assert.equal(controller.snapshot().drafts[0].state, 'confirmed'); assert.match(controller.snapshot().error!, /permission/)
  assert.deepEqual(controller.snapshot().value?.messages, []); await controller.send(draft); assert.equal(writes, 1)
})

test('out-of-order readback inserts by committed index and preserves newer messages without duplication', async () => {
  const second = { ...draft, id: 'second', text: 'second' }, late = deferred<Awaited<ReturnType<NonNullable<FrameworkClientApi['sentMessage']>>>>(), entered = deferred<void>()
  const controller = new FrameworkClientController(api({ sentMessage: async input => {
    if (input.id === draft.id) { entered.resolve(); return late.promise }
    return { message: { ...savedDraftView().messages[0], id: second.id, text: second.text }, order: [draft.id, second.id], revision: 'H2' }
  } }))
  await controller.selectMode('git'); const first = controller.send(draft); await entered.promise; await controller.send(second)
  late.resolve({ message: savedDraftView().messages[0], order: [draft.id], revision: 'H1' }); await first
  assert.deepEqual(controller.snapshot().value?.messages.map(message => message.id), [draft.id, second.id])
})

for (const error of [new DOMException('This operation was aborted', 'AbortError'), new Error('readback permission denied')]) test('withdrawn readback rejection never bubbles into the new page: ' + error.name, async () => {
  const response = deferred<never>(), entered = deferred<void>()
  const controller = new FrameworkClientController(api({ sentMessage: () => { entered.resolve(); return response.promise } }))
  await controller.selectMode('git'); const sending = controller.send(draft); await entered.promise
  await controller.selectMode('local'); response.reject(error); await assert.doesNotReject(sending)
  assert.equal(controller.snapshot().error, undefined); assert.equal(controller.snapshot().value?.activeMode, 'local')
  assert.equal(controller.snapshot().drafts[0].state, 'confirmed')
})

for (const destination of ['git-storage', 'different-storage']) test('cold unbound input uses confirmed destination without treating undefined as wildcard: ' + destination, async () => {
  const receipt = deferred<{ revision: string; storageScope: string }>(); let seen: FrameworkSendInput | undefined
  const controller = new FrameworkClientController(api({ send: () => receipt.promise,
    sentMessage: async input => { seen = input; return { message: savedDraftView().messages[0], order: [draft.id], revision: 'H' } },
  }))
  await controller.selectMode('git')
  const original = { ...draft, storageScope: undefined }, sending = controller.send(original)
  receipt.resolve({ revision: 'H', storageScope: destination }); await sending
  assert.equal(seen?.storageScope, destination === 'git-storage' ? destination : undefined)
  assert.deepEqual(controller.snapshot().drafts[0].input, original, 'original write identity remains unchanged')
  assert.equal(controller.snapshot().value?.messages.length, destination === 'git-storage' ? 1 : 0)
})

for (const action of ['stopExecution', 'taskControl', 'legacyControl', 'participation'] as const) test('every full action response preserves a later authoritative message: ' + action, async () => {
  const response = deferred<FrameworkClientView>(), entered = deferred<void>()
  const controller = new FrameworkClientController(api({ [action]: () => { entered.resolve(); return response.promise },
    sentMessage: async () => ({ message: savedDraftView().messages[0], order: [draft.id], revision: 'new-commit' }),
  }))
  await controller.selectMode('git')
  const input = { mode: 'git', storageScope: 'git-storage', commandId: 'control', taskId: 'T', intent: 'paused', workId: 'W', executionId: 'E', migrationId: 'M', oldTaskId: 'Old', action: 'resume' } as any
  const control = action === 'participation' ? controller.participation(true) : controller[action](input)
  await entered.promise; await controller.send(draft)
  assert.equal(controller.snapshot().value?.messages[0].id, draft.id)
  response.resolve({ ...view('git'), connection: { status: 'changed by control', participating: true } }); await control
  assert.equal(controller.snapshot().value?.messages[0].id, draft.id)
  assert.equal(controller.snapshot().value?.connection.status, 'changed by control')
})
test('confirmed send does not refresh a view which already contains the exact saved original', async () => {
  let reads = 0
  const controller = new FrameworkClientController(api({ view: async () => { reads++; return savedDraftView() } }))
  await controller.selectMode('git'); reads = 0
  await controller.send(draft)
  assert.equal(reads, 0); assert.equal(controller.snapshot().drafts[0].state, 'confirmed')
})
for (const scenario of ['includes-input', 'older-snapshot', 'independent-dirty'] as const) test('send receipt joins changed-owned read: ' + scenario, async () => {
  const response = deferred<FrameworkClientView>(), entered = deferred<void>(), ack = deferred<{ revision: string }>()
  let armed = false, reads = 0
  const controller = new FrameworkClientController(api({ send: () => ack.promise, view: async input => {
    if (!armed || input.headerOnly) return view('git')
    reads++; if (reads === 1) { entered.resolve(); return response.promise }
    return { ...savedDraftView(), resources: [{ name: 'new peer', status: 'online' }] }
  } }))
  await controller.selectMode('git'); armed = true
  const sending = controller.send(draft), changedRead = controller.refresh()
  await entered.promise; ack.resolve({ revision: 'newCommit' })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1)
  const independent = scenario === 'independent-dirty' ? controller.refresh() : Promise.resolve()
  response.resolve(scenario === 'older-snapshot' ? view('git') : savedDraftView())
  await Promise.all([sending, changedRead, independent])
  assert.equal(reads, scenario === 'includes-input' ? 1 : 2)
  assert.equal(controller.snapshot().value?.messages[0].text, draft.text)
  if (scenario === 'independent-dirty') assert.equal(controller.snapshot().value?.resources[0].name, 'new peer')
})

test('late Local refresh cannot replace a subsequently selected Git conversation', async () => {
  const local = deferred<FrameworkClientView>(), controller = new FrameworkClientController(api({ view: input => input.mode === 'git' ? Promise.resolve(view('git')) : local.promise }))
  const first = controller.refresh()
  await controller.selectMode('git')
  local.resolve(view('local')); await first
  assert.equal(controller.snapshot().value?.activeMode, 'git')
})
test('unknown/offline projection does not gate sends; retry preserves exact original identity and body', async () => {
  const calls: FrameworkSendInput[] = []
  const controller = new FrameworkClientController(api({ send: async input => { calls.push({ ...input }); if (calls.length === 1) throw new Error('acknowledgement unknown'); return { revision: 'H' } } }))
  await controller.selectMode('git')
  await assert.rejects(controller.send(draft), /unknown/)
  assert.equal(controller.snapshot().drafts[0].state, 'unknown')
  await controller.send(draft)
  assert.deepEqual(calls, [draft, draft])
  assert.equal(controller.snapshot().drafts[0].state, 'confirmed')
  assert.equal(controller.snapshot().value?.resources[0].status, 'offline')
})
test('view unsubscribe and mode switch do not revoke accepted send; duplicate submit joins same request', async () => {
  const sending = deferred<{ revision: string }>(); let calls = 0
  const controller = new FrameworkClientController(api({ send: () => { calls++; return sending.promise } }))
  await controller.selectMode('git')
  const stop = controller.subscribe(() => {}), first = controller.send(draft), second = controller.send(draft)
  assert.equal(first, second); stop()
  await controller.selectMode('local')
  sending.resolve({ revision: 'H' }); await first
  assert.equal(calls, 1)
  assert.equal(controller.snapshot().value?.activeMode, 'local')
  assert.equal(controller.snapshot().drafts[0].state, 'confirmed')
})
test('reusing a retained message ID with changed body is rejected rather than silently resent', async () => {
  const controller = new FrameworkClientController(api())
  controller.retain(draft)
  assert.throws(() => controller.send({ ...draft, text: 'changed' }), /different content/)
})
test('history pagination preserves confirmed order and deduplicates IDs, without mode leakage', async () => {
  const old = deferred<Awaited<ReturnType<FrameworkClientApi['history']>>>()
  const controller = new FrameworkClientController(api({ view: async () => ({ ...view('local'), pageBefore: 'latest' }), history: () => old.promise }))
  await controller.refresh()
  const loading = controller.older(50)
  await controller.selectMode('git')
  old.resolve({ revision: 'oldH', messages: [{ id: 'old', participantId: 'A', createdAt: '', role: 'user', text: 'Local private text' }] }); await loading
  assert.deepEqual(controller.snapshot().value?.messages, [])
})
test('configure carries explicit mode and read-back view; failed saves keep original view visible', async () => {
  let saved: Parameters<FrameworkClientApi['configure']>[0] | undefined
  const controller = new FrameworkClientController(api({ configure: async input => { saved = input; throw new Error('registration read-back failed') } }))
  await controller.selectMode('git')
  const input = { mode: 'git' as const, commandId: 'config-1', expectedRevision: 'git-1', settings: view('git').settings }
  await assert.rejects(controller.configure(input), /read-back/)
  assert.deepEqual(saved, input)
  assert.equal(controller.snapshot().value?.activeMode, 'git')
  assert.match(controller.snapshot().error!, /read-back/)
})

test('actual React page routes offline send, original-message retry, resources and save to API seam', async () => {
  const { build } = await import('esbuild'), { JSDOM } = await import('jsdom')
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path')
  await build({ entryPoints: ['src/framework/client-page.tsx'], outfile: '.validation/framework-client-view.mjs', bundle: true, platform: 'node', format: 'esm',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' },
    define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
  const put = (key: string, value: unknown) => { savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) put(key, key === 'window' ? dom.window : (dom.window as any)[key])
  put('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); put('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); put('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  put('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); put('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { FrameworkPage } = await import(pathToFileURL(resolve('.validation/framework-client-view.mjs')).href)
  const root = createRoot(document.getElementById('root')!), sends: FrameworkSendInput[] = []
  let saves = 0, picks = 0
  const savedSettings: unknown[] = []
  const participations: boolean[] = []
  let knowledgeReads = 0
  const knowledgeEdits: Array<Parameters<FrameworkClientApi['knowledgeEdit']>[0]> = [], knowledgeStatuses: Array<Parameters<FrameworkClientApi['knowledgeStatus']>[0]> = []
  let memberReads = 0
  const memberActions: Array<Parameters<FrameworkClientApi['gitMemberAction']>[0]> = []
  const invitations: Array<Parameters<FrameworkClientApi['invite']>[0]> = []
  const legacyActions: Array<Parameters<FrameworkClientApi['legacyControl']>[0]> = []
  const legacyTasks = (['paused', 'wait-user', 'complete', 'cancelled', 'unresolved'] as const).map(continuation => ({ migrationId: 'migration', oldTaskId: continuation, taskId: 'new-' + continuation, continuation, recordPath: 'archives/' + continuation + '/legacy/task.json', issues: continuation === 'unresolved' ? ['Original relation needs resolution'] : [], waits: continuation === 'wait-user' ? [{ id: 'specific-wait', question: 'Which exact source?', memberIdentity: 'legacy-member' }] : [] }))
  const timezone = Date.prototype.getTimezoneOffset
  Date.prototype.getTimezoneOffset = () => -540
  const taskActions: Array<Parameters<FrameworkClientApi['taskControl']>[0]> = [], stopActions: Array<Parameters<FrameworkClientApi['stopExecution']>[0]> = []
  const uiTasks: FrameworkClientView['tasks'] = [{ taskId: 'T', title: 'Active task', route: 'P', owner: 'User-1', status: 'running', control: 'running', members: [], resultPaths: [], executions: [{ workId: 'work-T', executionId: 'execution-T', role: 'Worker', state: 'running' }] }, { taskId: 'C', title: 'Completed task', route: 'P', owner: 'User-1', status: 'complete', members: [], resultPaths: [], executions: [] }]
  const seam = api({ knowledgeList: async () => { knowledgeReads++; return { revision: 'knowledge-H-' + knowledgeReads, items: [{ path: 'skills/example/record.json', kind: 'legacy', name: 'Example', description: 'Historical skill', status: 'active', indexed: true, candidates: [] }] } }, knowledgeRead: async input => ({ path: input.path, revision: 'knowledge-H', text: '{raw JSON should not be edited}', edit: { body: 'Exact editable body', title: 'Example', description: 'Historical skill', applicability: 'Test scope' } }), knowledgeEdit: async input => { knowledgeEdits.push({ ...input }); if (knowledgeEdits.length === 1) throw new Error('knowledge outcome unknown'); return { revision: 'candidate-H' } as any }, knowledgeStatus: async input => { knowledgeStatuses.push({ ...input }); if (knowledgeStatuses.length === 1) throw new Error('status outcome unknown'); return { revision: 'disabled-H' } as any }, taskControl: async input => { taskActions.push(input); uiTasks[0].control = input.intent; return { ...view(input.mode), tasks: uiTasks, legacyTasks } }, stopExecution: async input => { stopActions.push(input); uiTasks[0].executions = []; return { ...view(input.mode), tasks: uiTasks, legacyTasks } }, gitMembers: async () => { memberReads++; return { invitations: [{ id: 17, login: 'pending-user', status: 'pending' }], collaborators: [{ id: 23, login: 'accepted-user', status: 'accepted', permissions: { push: true } }] } }, gitMemberAction: async input => { memberActions.push(input) }, invite: async input => { invitations.push(input); if (invitations.length === 1) throw new Error('GitHub permission denied'); return { status: 'pending' } }, view: async input => ({ ...view(input.mode ?? 'local'), messages: [{ id: 'actual-ai', participantId: 'ai-owner', createdAt: '2026-10-31T00:00:00Z', role: 'assistant', text: 'Actual model response', model: 'actual-provider-model', modelVersion: 'actual-model-version' }, { id: 'human', participantId: 'human-owner', createdAt: '2026-10-31T00:00:00Z', role: 'user', text: 'Human original' }], tasks: uiTasks, legacyTasks }), legacyControl: async input => { legacyActions.push(input); return { ...view(input.mode), legacyTasks: legacyTasks.filter(task => task.oldTaskId !== input.oldTaskId) } }, participation: async input => { participations.push(input.enabled); return { ...view(input.mode), connection: { status: 'connected', participating: input.enabled } } }, send: async input => { sends.push({ ...input }); if (sends.length === 1) throw new Error('controlled uncertain receipt'); return { revision: 'saved' } }, configure: async input => { saves++; savedSettings.push(input.settings); return { ...view(input.mode), settings: input.settings } } })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label)
    assert.ok(button, label)
    await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await tick() })
  }
  try {
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { api: seam, language: 'en', onPickDirectory: async () => { picks++; return picks === 1 ? '/chosen/workspace' : null } })); await tick() })
    assert.match(document.body.textContent!, /unknown/)
    assert.equal(document.querySelector('h1')?.textContent, 'DSS', 'the user-configured display name is not expanded')
    const aiArticle = [...document.querySelectorAll('article')].find(article => article.textContent?.includes('Actual model response'))!
    assert.match(aiArticle.textContent!, /actual-provider-model/); assert.match(aiArticle.textContent!, /actual-model-version/)
    const humanArticle = [...document.querySelectorAll('article')].find(article => article.textContent?.includes('Human original'))!
    assert.doesNotMatch(humanArticle.textContent!, /actual-provider-model|actual-model-version/)
    await React.act(() => {
      const input = document.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Exact UI message 😀')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await click('Send')
    assert.equal(sends.length, 1)
    assert.equal(sends[0].timezoneOffsetMinutes, 540)
    Date.prototype.getTimezoneOffset = () => -330
    await click('Resolve and retry original')
    assert.equal(sends.length, 2); assert.equal(sends[0].id, sends[1].id); assert.equal(sends[1].text, 'Exact UI message 😀'); assert.equal(sends[1].timezoneOffsetMinutes, 540)
    await click('Tasks')
    const taskButton = [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Active task'))!
    await React.act(async () => { taskButton.click(); await tick() })
    await click('Pause on this Host'); await click('Confirm Host action')
    assert.equal(taskActions[0].taskId, 'T'); assert.equal(taskActions[0].intent, 'paused')
    await click('Resume on this Host'); await click('Confirm Host action')
    assert.equal(taskActions[1].intent, 'running'); assert.notEqual(taskActions[1].commandId, taskActions[0].commandId)
    await click('Stop this Host execution'); await click('Confirm execution stop')
    assert.equal(stopActions[0].workId, 'work-T'); assert.equal(stopActions[0].executionId, 'execution-T')
    const completed = [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Completed task'))!
    await React.act(async () => { completed.click(); await tick() })
    assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'Resume on this Host' || button.textContent === 'Pause on this Host'), false)
    assert.equal([...document.querySelectorAll('button')].filter(button => button.textContent === 'Resume task').length, 1)
    assert.equal([...document.querySelectorAll('button')].filter(button => button.textContent === 'Send answer').length, 1)
    assert.match(document.body.textContent!, /Original relation needs resolution/)
    await click('Resume task'); assert.equal(legacyActions[0].oldTaskId, 'paused'); assert.equal(legacyActions[0].action, 'resume')
    assert.match(document.body.textContent!, /Which exact source/)
    await click('Send answer'); assert.equal(legacyActions[1].waitId, 'specific-wait'); assert.equal(legacyActions[1].action, 'answer')
    await click('Resources'); assert.match(document.body.textContent!, /offline member/); assert.match(document.body.textContent!, /Helper/)
    await click('Settings'); await click('Close'); assert.equal(saves, 0)
    await click('Settings'); await click('Browse task workspace'); await click('Browse task workspace'); await click('Save and connect')
    assert.equal((savedSettings[0] as any).workspace, '/chosen/workspace'); assert.equal(picks, 2)
    assert.equal(saves, 1)
    assert.match(document.body.textContent!, /registration read back/)
    await click('Start collaboration background'); await click('Leave collaboration background')
    assert.deepEqual(participations, [true, false])
    await click('Close'); await click('DSS-cah'); await click('Settings')
    const username = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('GitHub username'))!.querySelector('input')!
    await React.act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(username, 'teammate')
      username.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await click('Invite write collaborator'); await click('Cancel'); assert.equal(invitations.length, 0)
    await click('Invite write collaborator'); await click('Confirm invitation')
    assert.match(document.body.textContent!, /GitHub permission denied/)
    assert.equal(username.value, 'teammate')
    await click('Confirm invitation')
    assert.deepEqual(invitations, [{ mode: 'git', storageScope: 'git-storage', username: 'teammate' }, { mode: 'git', storageScope: 'git-storage', username: 'teammate' }])
    assert.match(document.body.textContent!, /Invitation pending/)
    assert.equal(saves, 1); assert.deepEqual(participations, [true, false])
    assert.equal(memberReads, 0)
    await click('Refresh repository access'); assert.equal(memberReads, 1)
    await click('Revoke invitation'); await click('Cancel removal'); assert.equal(memberActions.length, 0)
    await click('Revoke invitation'); await click('Confirm access removal')
    await click('Remove collaborator'); await click('Confirm access removal')
    assert.deepEqual(memberActions, [{ mode: 'git', storageScope: 'git-storage', action: 'cancelInvitation', invitationId: 17 }, { mode: 'git', storageScope: 'git-storage', action: 'remove', username: 'accepted-user' }])
    assert.equal(memberReads, 3)
    await click('Close'); assert.equal(knowledgeReads, 0)
    await click('Knowledge'); assert.equal(knowledgeReads, 1)
    await click('Read and edit')
    const body = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('Knowledge body'))!.querySelector('textarea')!
    assert.equal(body.value, 'Exact editable body')
    await React.act(() => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(body, 'Candidate body'); body.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
    await click('Save candidate edit'); assert.match(document.body.textContent!, /knowledge outcome unknown/)
    await click('Reload original record'); await click('Resources'); await click('Knowledge')
    await click('Resolve and retry original knowledge operation'); assert.deepEqual(knowledgeEdits[1], knowledgeEdits[0])
    await click('Read and edit')
    assert.equal(knowledgeEdits[0].storageScope, 'git-storage'); assert.equal(knowledgeEdits[0].body, 'Candidate body')
    assert.equal(knowledgeEdits[1].createdAt, knowledgeEdits[0].createdAt)
    await click('Disable'); await click('Cancel'); assert.equal(knowledgeStatuses.length, 0)
    await click('Disable'); await click('Confirm status change')
    await click('Refresh knowledge'); await click('Confirm status change')
    assert.deepEqual(knowledgeStatuses[1], knowledgeStatuses[0])
    assert.equal(knowledgeStatuses[0].status, 'disabled'); assert.equal(knowledgeStatuses[0].storageScope, 'git-storage')
    assert.match(document.body.textContent!, /original body retained/)

    let seatView: FrameworkClientView = { ...view('git'), settings: { ...view('git').settings, workerSeats: 1 }, connection: { status: 'unknown', participating: true, workerSeats: 4, detail: 'Registration read-back failed; previous applied seats retained.' } }
    const seatsApi = api({ view: async () => seatView, configure: async () => { throw new Error('Registration read-back failed') } })
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { key: 'seats', api: seatsApi, language: 'en' })); await tick() })
    assert.match(document.body.textContent!, /Applied seats: 4/)
    assert.match(document.body.textContent!, /Saved setting: 1/)
    assert.doesNotMatch(document.body.textContent!, /Applied seats: 1/)
    await click('Settings'); await click('Save and connect')
    assert.match(document.body.textContent!, /Registration read-back failed/)
    assert.doesNotMatch(document.body.textContent!, /Settings saved; connection registration read back/)
    assert.match(document.body.textContent!, /Applied seats: 4/)
    await click('Close')
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { key: 'seats', api: seatsApi, language: 'zh' })); await tick() })
    assert.match(document.body.textContent!, /已生效席位: 4/)
    assert.match(document.body.textContent!, /已保存设置: 1/)
    assert.doesNotMatch(document.body.textContent!, /Applied seats|Saved setting/)
    seatView = { ...seatView, connection: { status: 'connected', participating: true, workerSeats: 1 } }
    await click('刷新')
    assert.match(document.body.textContent!, /已生效席位: 1/)
    assert.doesNotMatch(document.body.textContent!, /已保存设置|Registration read-back failed/)
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { key: 'seats', api: seatsApi, language: 'en' })); await tick() })
    assert.match(document.body.textContent!, /Applied seats: 1/)
    assert.doesNotMatch(document.body.textContent!, /Saved setting/)


    const attachmentReads: unknown[] = []
    const attachmentApi = api({
      view: async () => ({ ...view('local'), archives: [{ path: 'archives/T/records.md', title: 'T', taskId: 'T', files: ['archives/T/result.bin', 'archives/T/result.txt'] }] }),
      readFile: async input => { attachmentReads.push(input); return input.path.endsWith('.bin')
        ? { path: input.path, revision: 'H', binary: { bytes: 4, sha256: 'actual-descriptor-seam', downloadUrl: '/download?path=archives%2FT%2Fresult.bin' } }
        : { path: input.path, revision: 'H', text: 'Retained output text', downloadUrl: '/download?path=archives%2FT%2Fresult.txt' } },
    })
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { key: 'attachments', api: attachmentApi, language: 'en' })); await tick() })
    await click('Archives'); await click('archives/T/result.bin')
    assert.match(document.body.textContent!, /4 bytes/)
    assert.equal([...document.querySelectorAll('a')].find(a => a.textContent === 'Download attachment')?.getAttribute('href'), '/download?path=archives%2FT%2Fresult.bin')
    await click('Close'); await click('archives/T/result.txt')
    assert.match(document.body.textContent!, /Retained output text/)
    assert.equal([...document.querySelectorAll('a')].find(a => a.textContent === 'Download original file')?.getAttribute('href'), '/download?path=archives%2FT%2Fresult.txt')
    assert.deepEqual(attachmentReads, [
      { mode: 'local', storageScope: 'local-storage', path: 'archives/T/result.bin' },
      { mode: 'local', storageScope: 'local-storage', path: 'archives/T/result.txt' },
    ])
    await click('Close')

    const oldRead = deferred<Awaited<ReturnType<FrameworkClientApi['readFile']>>>(), newRead = deferred<Awaited<ReturnType<FrameworkClientApi['readFile']>>>(), closedRead = deferred<Awaited<ReturnType<FrameworkClientApi['readFile']>>>()
    let reads = 0
    const documentView = (mode: 'local' | 'git') => ({ ...view(mode), archives: [{ path: 'doc.md', title: 'Scope document' }] })
    const documentApi = api({ view: async input => documentView(input.mode ?? 'local'), selectMode: async input => documentView(input.mode), readFile: () => [oldRead.promise, newRead.promise, closedRead.promise][reads++] })
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { key: 'documents', api: documentApi, language: 'en' })); await tick() })
    await click('Archives'); await click('doc.md')
    assert.match(document.body.textContent!, /Reading document/)
    await click('DSS-cah')
    assert.doesNotMatch(document.body.textContent!, /Reading document/)
    await click('doc.md')
    await React.act(async () => { oldRead.resolve({ path: 'doc.md', text: 'Private Local document', revision: 'old' }); await tick() })
    assert.match(document.body.textContent!, /Reading document/)
    assert.doesNotMatch(document.body.textContent!, /Private Local document/)
    await React.act(async () => { newRead.resolve({ path: 'doc.md', text: 'Current Git document', revision: 'new' }); await tick() })
    assert.match(document.body.textContent!, /Current Git document/)
    await click('Close'); await click('doc.md'); await click('Close')
    await React.act(async () => { closedRead.resolve({ path: 'doc.md', text: 'Closed late document', revision: 'closed' }); await tick() })
    assert.doesNotMatch(document.body.textContent!, /Reading document|Closed late document|Current Git document/)
    for (const language of ['zh', 'en'] as const) {
      const unnamedApi = api({ view: async input => ({ ...view(input.mode ?? 'git'), settings: { ...view(input.mode ?? 'git').settings, name: '' } }) })
      await React.act(async () => { root.render(React.createElement(FrameworkPage, { key: 'unnamed-' + language, api: unnamedApi, language })); await tick() })
      assert.equal(document.querySelector('h1')?.textContent, 'DeepSeek Servant')
      assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'DSS-cah'))
      assert.ok(document.body.textContent?.includes(language === 'zh' ? 'Git 协作模式' : 'Git collaboration mode'))
      await click('Local')
      assert.doesNotMatch(document.body.textContent!, /Git 协作模式|Git collaboration mode/)
    }


  } finally {
    Date.prototype.getTimezoneOffset = timezone
    await React.act(() => root.unmount()); dom.window.close()
    for (const [key, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
})

test('refresh during a pending mode selection requests that selected mode, not the stale visible mode', async () => {
  const selected = deferred<FrameworkClientView>(), requested: unknown[] = []
  const controller = new FrameworkClientController(api({ selectMode: () => selected.promise, view: async input => { if (!input.headerOnly) requested.push(input.mode); return view(input.mode ?? 'local') } }))
  await controller.refresh()
  const switching = controller.selectMode('git')
  await controller.refresh()
  selected.resolve(view('git')); await switching
  assert.deepEqual(requested, ['local', 'git']) // read starts only after the saved target header owns that mode
  assert.equal(controller.snapshot().value?.activeMode, 'git')
})

test('refresh after loading older history retains that visible history and appends confirmed new messages', async () => {
  const msg = (id: string) => ({ id, participantId: 'A', createdAt: id, role: 'user' as const, text: id })
  let fresh = { ...view('local'), pageBefore: 'b', messages: [msg('b')] }
  const controller = new FrameworkClientController(api({ view: async () => fresh, history: async () => ({ messages: [msg('a'), msg('b')], revision: 'H' }) }))
  await controller.refresh(); await controller.older(50)
  fresh = { ...fresh, messages: [msg('b'), msg('c')] }
  await controller.refresh()
  assert.deepEqual(controller.snapshot().value?.messages.map(message => message.id), ['a', 'b', 'c'])
  assert.equal(controller.snapshot().value?.pageBefore, undefined)
})

test('archive discovery is explicitly requested and ordinary refresh keeps the loaded list', async () => {
  const requests: Array<boolean | undefined> = []
  const archive = { path: 'archives/T/records.md', title: 'T' }
  const controller = new FrameworkClientController(api({ view: async input => { if (!input.headerOnly) requests.push(input.includeArchives); return { ...view('local'), archives: input.includeArchives ? [archive] : [] } } }))
  await controller.refresh(); await controller.refresh(true); await controller.refresh()
  assert.deepEqual(requests, [false, true, false])
  assert.deepEqual(controller.snapshot().value?.archives, [archive])
})

test('same mode and collaboration in different storage scopes do not mix pending messages or history', async () => {
  const history = deferred<Awaited<ReturnType<FrameworkClientApi['history']>>>(), sent: FrameworkSendInput[] = []
  let current = { ...view('git'), storageScope: 'repository-A', pageBefore: 'older' }
  const controller = new FrameworkClientController(api({ view: async () => current, history: () => history.promise, send: async input => { sent.push({ ...input }); throw new Error('unknown') } }))
  await controller.refresh()
  const original = { ...draft, storageScope: 'repository-A' }
  await assert.rejects(controller.send(original))
  const reading = controller.older(50)
  current = { ...view('git'), storageScope: 'repository-B', pageBefore: 'older' }
  await controller.refresh()
  history.resolve({ revision: 'A', messages: [{ id: 'A-private', participantId: 'A', role: 'user', createdAt: '', text: 'A only' }] }); await reading
  assert.deepEqual(controller.snapshot().value?.messages, [])
  assert.equal(controller.snapshot().drafts[0].input.storageScope, 'repository-A')
  assert.equal(sent.length, 1, 'changing storage never automatically resends old drafts')
})

test('explicit Host controls retain task and execution identity through API controller', async () => {
  const tasks: unknown[] = [], stops: unknown[] = []
  const controller = new FrameworkClientController(api({ taskControl: async input => { tasks.push(input); return view('git') }, stopExecution: async input => { stops.push(input); return view('git') } }))
  const task = { mode: 'git' as const, storageScope: 'git-storage', commandId: 'pause-1', taskId: 'T', intent: 'paused' as const }
  const stop = { mode: 'git' as const, storageScope: 'git-storage', commandId: 'stop-1', workId: 'W', executionId: 'E' }
  await controller.taskControl(task); await controller.stopExecution(stop)
  assert.deepEqual(tasks, [task]); assert.deepEqual(stops, [stop])
})

test('date/newer history windows remain separate from live refresh and latest resets navigation', async () => {
  const calls: Array<Parameters<FrameworkClientApi['history']>[0]> = []
  const message = (id: string) => ({ id, participantId: 'A', createdAt: '2026-10-31T00:00:00Z', role: 'user' as const, text: id })
  const controller = new FrameworkClientController(api({ view: async () => ({ ...view('local'), messages: [message('latest')] }), history: async input => { calls.push(input); return { messages: [message(input.afterId ? 'newer' : 'dated')], moreAfter: input.afterId ? undefined : 'dated', revision: 'H' } } }))
  await controller.refresh(); await controller.navigateHistory({ date: '2026-10-31', limit: 50 }); await controller.refresh()
  assert.deepEqual(controller.snapshot().value?.messages.map(item => item.id), ['dated'])
  await controller.navigateHistory({ date: '2026-10-31', afterId: 'dated', limit: 50 })
  assert.deepEqual(controller.snapshot().value?.messages.map(item => item.id), ['newer'])
  assert.equal(calls[1].afterId, 'dated'); assert.equal(calls[1].storageScope, 'local-storage')
  await controller.latest()
  assert.deepEqual(controller.snapshot().value?.messages.map(item => item.id), ['latest'])
  assert.equal(controller.snapshot().value?.historyWindow, undefined)
})

test('shared controller retains one changed subscription until final plugin/page reference releases', async () => {
  let subscriptions = 0, unsubscriptions = 0, refreshes = 0, changed: (() => void) | undefined
  const sharedApi = api({ view: async input => { if (!input.headerOnly) refreshes++; return view('local') }, subscribeChanged: listener => { subscriptions++; changed = listener; return () => { unsubscriptions++; changed = undefined } } })
  const plugin = getFrameworkClientController(sharedApi), page = getFrameworkClientController(sharedApi)
  assert.equal(plugin, page)
  const releasePlugin = plugin.retainConnection(), releasePage = page.retainConnection()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subscriptions, 1); assert.equal(refreshes, 1)
  releasePage(); releasePage()
  assert.equal(unsubscriptions, 0)
  changed!(); await new Promise(resolve => setImmediate(resolve)); assert.equal(refreshes, 2)
  releasePlugin(); assert.equal(unsubscriptions, 1); assert.equal(changed, undefined)
  const releaseAgain = page.retainConnection(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(subscriptions, 2); assert.equal(refreshes, 3)
  releaseAgain(); assert.equal(unsubscriptions, 2)
})

test('pending mode navigation wins over old-scope history and controls without cancelling Host actions', async () => {
  const selected = deferred<FrameworkClientView>(), history = deferred<Awaited<ReturnType<FrameworkClientApi['history']>>>(), stopped = deferred<FrameworkClientView>()
  let stopCalls = 0
  const controller = new FrameworkClientController(api({ selectMode: () => selected.promise, history: () => history.promise, stopExecution: () => { stopCalls++; return stopped.promise } }))
  await controller.refresh()
  const switching = controller.selectMode('git')
  const reading = controller.navigateHistory({ date: '2026-10-31', limit: 50 })
  const stopping = controller.stopExecution({ mode: 'local', storageScope: 'local-storage', commandId: 'stop', workId: 'work', executionId: 'execution' })
  history.resolve({ messages: [{ id: 'local-only', participantId: 'A', createdAt: '', role: 'user', text: 'old Local history' }], revision: 'H' }); await reading
  selected.resolve(view('git')); await switching
  stopped.resolve(view('local')); await stopping
  assert.equal(stopCalls, 1)
  assert.equal(controller.snapshot().value?.activeMode, 'git')
  assert.deepEqual(controller.snapshot().value?.messages, [])
})

test('quick mode return invalidates the earlier navigation and its late errors', async () => {
  const git = deferred<FrameworkClientView>(), local = deferred<FrameworkClientView>()
  const controller = new FrameworkClientController(api({ selectMode: input => input.mode === 'git' ? git.promise : local.promise }))
  await controller.refresh()
  const outward = controller.selectMode('git'), returning = controller.selectMode('local')
  local.resolve(view('local')); await returning
  git.reject(new Error('obsolete Git error')); await assert.rejects(outward, /obsolete/)
  assert.equal(controller.snapshot().value?.activeMode, 'local')
  assert.equal(controller.snapshot().loading, false)
  assert.equal(controller.snapshot().error, undefined)
  await controller.navigateHistory({ date: '2026-10-31', limit: 50 })
  assert.equal(controller.snapshot().value?.historyWindow, true)
})

test('repository settings navigation survives old-scope history and refresh and retains drafts', async () => {
  const saved = deferred<FrameworkClientView>(), refreshed = deferred<FrameworkClientView>()
  let views = 0
  const controller = new FrameworkClientController(api({ view: async input => input.headerOnly || ++views === 1 ? view('git') : refreshed.promise, configure: () => saved.promise, history: async () => ({ messages: [], revision: 'H' }) }))
  await controller.refresh(); controller.retain(draft)
  const saving = controller.configure({ mode: 'git', commandId: 'change-repo', expectedRevision: 'git-1', settings: { ...view('git').settings, ownerRepo: 'owner/other' } })
  await controller.navigateHistory({ date: '2026-10-31', limit: 50 })
  const refresh = controller.refresh()
  saved.resolve({ ...view('git'), revision: 'new-config', storageScope: 'other-repo' }); await saving
  refreshed.resolve(view('git')); await refresh
  assert.equal(controller.snapshot().value?.storageScope, 'other-repo')
  assert.equal(controller.snapshot().value?.revision, 'new-config')
  assert.deepEqual(controller.snapshot().drafts[0].input, draft)
})

test('failed navigation releases history and retry while preserving the original view', async () => {
  let attempts = 0
  const controller = new FrameworkClientController(api({ configure: async () => { if (++attempts === 1) throw new Error('save failed'); return { ...view('local'), revision: 'saved' } } }))
  await controller.refresh()
  const input = { mode: 'local' as const, commandId: 'retry-config', settings: view('local').settings }
  await assert.rejects(controller.configure(input), /save failed/)
  await controller.navigateHistory({ date: '2026-10-31', limit: 50 })
  assert.equal(controller.snapshot().value?.historyWindow, true)
  await controller.configure(input)
  assert.equal(controller.snapshot().value?.revision, 'saved')
  assert.equal(controller.snapshot().loading, false)
})

test('quick return keeps the latest selection after an older successful mode response', async () => {
  const git = deferred<FrameworkClientView>()
  const controller = new FrameworkClientController(api({ selectMode: input => input.mode === 'git' ? git.promise : Promise.resolve(view('local')) }))
  await controller.refresh()
  const outward = controller.selectMode('git')
  await controller.selectMode('local')
  git.resolve(view('git')); await outward
  assert.equal(controller.snapshot().value?.activeMode, 'local')
  await controller.selectMode('git')
  assert.equal(controller.snapshot().value?.activeMode, 'git')
})

test('older history requested during navigation cannot merge into the outgoing scope', async () => {
  const selected = deferred<FrameworkClientView>()
  const controller = new FrameworkClientController(api({ view: async () => ({ ...view('local'), pageBefore: 'older' }), selectMode: () => selected.promise, history: async () => ({ messages: [{ id: 'old', participantId: 'A', createdAt: '', role: 'user', text: 'old' }], revision: 'H' }) }))
  await controller.refresh()
  const switching = controller.selectMode('git')
  await controller.older(50)
  assert.deepEqual(controller.snapshot().value?.messages, [])
  selected.resolve(view('git')); await switching
  assert.equal(controller.snapshot().value?.activeMode, 'git')
})

test('old-scope SSE refresh cannot finish a pending settings save and final read-back selects the new repository', async () => {
  const saved = deferred<FrameworkClientView>()
  const controller = new FrameworkClientController(api({ view: async () => view('git'), configure: () => saved.promise }))
  await controller.refresh()
  let settled = false
  const saving = controller.configure({ mode: 'git', commandId: 'save-with-sse', settings: { ...view('git').settings, ownerRepo: 'owner/new-repo' } }).then(() => { settled = true })
  await controller.refresh()
  assert.equal(controller.snapshot().value?.storageScope, 'git-storage')
  assert.equal(settled, false, 'the settings form uses configure settlement, not background snapshot.loading')
  saved.resolve({ ...view('git'), revision: 'new', storageScope: 'new-repo' }); await saving
  assert.equal(settled, true)
  assert.equal(controller.snapshot().value?.storageScope, 'new-repo')
  assert.equal(controller.snapshot().value?.revision, 'new')
})


test('new-install and bilingual public product labels use the full name', async () => {
  const { readFile } = await import('node:fs/promises')
  const { zh, en } = await import('../src/client/locales.js')
  // Check the actual Host constructor default, not the display-only fallback.
  const host = await readFile('src/host.ts', 'utf8')
  assert.match(host, /new FrameworkService\(ctx, storage, \{ name: 'DeepSeek Servant'/)
  for (const messages of [zh, en]) {
    assert.equal(messages.panel, 'DeepSeek Servant')
    assert.equal(messages.title, 'DeepSeek Servant')
    assert.match(messages['retention.conversationWarning'], /DeepSeek Servant/)
  }
})

test('scroll older joins repeated requests and survives an unrelated live refresh without losing rows', async () => {
  const msg = (id: string) => ({ id, participantId: 'qa', role: 'user' as const, createdAt: id, text: id })
  const page = deferred<Awaited<ReturnType<FrameworkClientApi['history']>>>()
  let calls = 0, fresh = { ...view('local'), messages: [msg('b'), msg('c')], pageBefore: 'b' }
  const controller = new FrameworkClientController(api({ view: async () => fresh, history: () => { calls++; return page.promise } }))
  await controller.refresh()
  const first = controller.older(50), repeated = controller.older(50)
  fresh = { ...fresh, messages: [msg('c'), msg('d')], pageBefore: 'c' }
  await controller.refresh()
  page.resolve({ revision: 'H', messages: [msg('a'), msg('b')] })
  await Promise.all([first, repeated])
  assert.equal(calls, 1)
  assert.deepEqual(controller.snapshot().value?.messages.map(x => x.id), ['a', 'b', 'c', 'd'])
})
test('date history prepends multiple pages rather than replacing the readers window', async () => {
  const msg = (id: string) => ({ id, participantId: 'qa', role: 'user' as const, createdAt: id, text: id })
  const controller = new FrameworkClientController(api({ history: async input => ({ revision: 'H', messages: (input.beforeId ? ['a', 'b'] : ['c', 'd']).map(msg), moreBefore: input.beforeId ? undefined : 'c' }) }))
  await controller.refresh(); await controller.navigateHistory({ date: '2026-11-01', limit: 50 }); await controller.older(50)
  assert.deepEqual(controller.snapshot().value?.messages.map(x => x.id), ['a', 'b', 'c', 'd'])
  assert.equal(controller.snapshot().value?.historyDate, '2026-11-01')
})
test('late older response cannot contaminate a newly selected date', async () => {
  const page = deferred<Awaited<ReturnType<FrameworkClientApi['history']>>>()
  const controller = new FrameworkClientController(api({ view: async () => ({ ...view('local'), pageBefore: 'b' }), history: input => input.beforeId ? page.promise : Promise.resolve({ revision: 'H', messages: [] }) }))
  await controller.refresh(); const old = controller.older(50)
  await controller.navigateHistory({ date: '2026-10-01', limit: 50 })
  page.resolve({ revision: 'H', messages: [{ id: 'stale', participantId: 'qa', role: 'user', createdAt: '', text: 'stale' }] }); await old
  assert.deepEqual(controller.snapshot().value?.messages, [])
})
test('a live invalidation does not discard the selected date while its history read is pending', async () => {
  const page = deferred<Awaited<ReturnType<FrameworkClientApi['history']>>>()
  const controller = new FrameworkClientController(api({ history: () => page.promise }))
  await controller.refresh(); const date = controller.navigateHistory({ date: '2026-10-01', limit: 50 })
  await controller.refresh()
  page.resolve({ revision: 'H', messages: [{ id: 'dated', participantId: 'qa', createdAt: '', role: 'user', text: 'dated' }] }); await date
  assert.equal(controller.snapshot().value?.historyDate, '2026-10-01')
  assert.deepEqual(controller.snapshot().value?.messages.map(x => x.id), ['dated'])
})

test('export success stays outside conversation layout and long original path remains readable before sending', async () => {
  const { build } = await import('esbuild'), { JSDOM } = await import('jsdom')
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path')
  await build({ entryPoints: ['src/framework/client-page.tsx'], outfile: '.validation/framework-client-view.mjs', bundle: true, platform: 'node', format: 'esm',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' },
    define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
  const put = (key: string, value: unknown) => { savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) put(key, key === 'window' ? dom.window : (dom.window as any)[key])
  put('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); put('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); put('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  put('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); put('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { FrameworkPage } = await import(pathToFileURL(resolve('.validation/framework-client-view.mjs')).href)
  const root = createRoot(document.getElementById('root')!)
  const exportedPath = '/workspace/' + 'long-project-name-'.repeat(32) + '/records.md'
  let sent = 0
  const seam = api({ view: async () => ({ ...view('local'), archives: [{ taskId: 'T', path: 'archives/T/records.md', title: 'Task T' }] }), exportRecords: async () => ({ path: exportedPath, bytes: 42, sha256: 'test-hash' }), send: async () => { sent++; return { revision: 'sent' } } })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const click = async (text: string) => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === text)!; assert.ok(button, text); await React.act(async () => { button.click(); await tick() }) }
  try {
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { api: seam, language: 'en' })); await tick() })
    await click('Archives'); await click('Export complete records'); await click('Conversation')
    const status = [...document.querySelectorAll('[role="status"]')].find(element => element.textContent?.includes(exportedPath))!
    const page = document.querySelector('section[aria-label="DeepSeek Servant"]')!
    assert.ok(status, 'successful export is still readable without an expiry timer')
    assert.equal(status.parentElement === page, true, 'export notice must be in page column, not beside the conversation in its horizontal content row')
    assert.equal(status.textContent, 'Records exported to: ' + exportedPath)
    assert.equal((status as HTMLElement).style.overflowWrap, 'anywhere', 'unbroken export paths wrap without truncation')
    assert.equal((status as HTMLElement).style.flexShrink, '0', 'the notice retains its own height above the content')
    await React.act(() => { const input = document.querySelector('textarea')!; Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Send after export'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
    await click('Send'); assert.equal(sent, 1)
    assert.ok(status.isConnected, 'sending does not hide the exported path')
  } finally { await React.act(() => root.unmount()); dom.window.close(); for (const [key, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } }
})

test('legacy archives expose archived attachments without records and keep pending external references read-only', async () => {
  const { build } = await import('esbuild'), { JSDOM } = await import('jsdom')
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path')
  await build({ entryPoints: ['src/framework/client-page.tsx'], outfile: '.validation/framework-client-view.mjs', bundle: true, platform: 'node', format: 'esm',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'empty' },
    define: Object.fromEntries(['ICON', 'WELCOME_CHARACTER', 'TASK_EMPTY_CHARACTER'].map(key => ['__SERVANT_' + key + '_DATA_URI__', '""'])) })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
  const put = (key: string, value: unknown) => { savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) put(key, key === 'window' ? dom.window : (dom.window as any)[key])
  put('getComputedStyle', dom.window.getComputedStyle.bind(dom.window)); put('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); put('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  put('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); put('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { FrameworkPage } = await import(pathToFileURL(resolve('.validation/framework-client-view.mjs')).href)
  const root = createRoot(document.getElementById('root')!)
  const archivedPath = 'archives/migrated/attachments/original.bin', externalPath = 'file:///outside-authorized-workspace/' + 'long-original-directory-'.repeat(24) + '/original.bin'
  const hash = 'f'.repeat(64), downloadUrl = '/api/deepseek-servant-framework/download?mode=local&storageScope=local-storage&path=' + encodeURIComponent(archivedPath)
  const reads: Array<Parameters<FrameworkClientApi['readFile']>[0]> = []
  const seam = api({ view: async () => ({ ...view('local'), archives: [], legacyTasks: [{ migrationId: 'migration', oldTaskId: 'old-task', taskId: 'T', continuation: 'complete', recordsAvailable: false,
    artifacts: [{ id: 'archived-binary', sourcePath: '/old-workspace/result.bin', archivedPath, sha256: hash, status: 'archived' }, { id: 'external-pending', sourcePath: externalPath, sha256: hash, status: 'pending', detail: 'Original path is outside the authorized workspace.' }] }] }),
    readFile: async input => { reads.push(input); assert.equal(input.path, archivedPath); return { path: input.path, revision: 'H', binary: { bytes: 42, sha256: hash, downloadUrl } } } })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const click = async (text: string) => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === text || button.getAttribute('aria-label') === text)!; assert.ok(button, text); await React.act(async () => { button.click(); await tick() }) }
  try {
    await React.act(async () => { root.render(React.createElement(FrameworkPage, { api: seam, language: 'en' })); await tick() })
    await click('Archives')
    assert.equal(reads.length, 0, 'listing attachments does not read original files automatically')
    assert.match(document.body.textContent!, /Original attachment: archived-binary/)
    assert.match(document.body.textContent!, /Original attachment reference \(not imported\): external-pending/)
    const originalPath = [...document.querySelectorAll('code')].find(element => element.textContent === externalPath)!
    assert.ok(originalPath, 'full external path remains visible as plain text')
    assert.equal(originalPath.style.overflowWrap, 'anywhere')
    assert.match(document.body.textContent!, /Original path is outside the authorized workspace/)
    assert.ok(document.body.textContent!.includes(hash))
    assert.equal([...document.querySelectorAll('a[href]')].some(anchor => anchor.getAttribute('href')?.includes('outside-authorized-workspace')), false)
    assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'Complete original records'), false)
    await click('Original attachment: archived-binary')
    assert.deepEqual(reads, [{ mode: 'local', storageScope: 'local-storage', path: archivedPath }])
    const download = [...document.querySelectorAll('a')].find(anchor => anchor.textContent === 'Download attachment')!
    assert.ok(download); assert.equal(download.getAttribute('href'), downloadUrl); assert.ok(download.hasAttribute('download'))
    assert.match(document.body.textContent!, /42 bytes/)
    await click('Close'); await click('Conversation'); await click('Archives')
    assert.equal(reads.length, 1, 'reopening the list does not dereference the pending external path')
  } finally { await React.act(() => root.unmount()); dom.window.close(); for (const [key, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } }
})

test('display availability fences offline navigation responses without discarding messages, drafts or accepted operations', async () => {
  let availability!: (value: boolean) => void, calls = 0
  const selected = deferred<FrameworkClientView>(), processing = { executionId: 'native-e', turnId: 'native-turn', startedAt: 1 }
  const current = { ...view('local'), foregroundProcessing: processing, messages: [{ id: 'kept', role: 'user', text: 'Kept original', participantId: 'user', createdAt: '2026-11-01T00:00:00Z' }] as any }
  const controller = new FrameworkClientController(api({ view: async () => { calls++; return current }, selectMode: () => selected.promise,
    subscribeChanged: (_listener, state) => { availability = state!; return () => {} } }))
  const release = controller.retainConnection()
  await controller.refresh(); controller.retain(draft)
  const count = calls
  availability(false)
  assert.equal(controller.snapshot().value?.foregroundProcessing, undefined)
  assert.equal(controller.snapshot().value?.messages[0].text, 'Kept original')
  assert.equal(controller.snapshot().drafts[0].input.text, draft.text)
  assert.equal(calls, count)
  const selecting = controller.selectMode('local')
  availability(true); selected.resolve(current); await selecting
  assert.equal(controller.snapshot().value?.foregroundProcessing, undefined, 'a request begun offline cannot revive processing after reconnect')
  await controller.refresh(); assert.deepEqual(controller.snapshot().value?.foregroundProcessing, processing)
  release()
})
