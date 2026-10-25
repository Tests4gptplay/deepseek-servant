import test from 'node:test'
import assert from 'node:assert/strict'
import { isServantSession, servantOnlyUngrouped, servantSessionRowsCss, emptyVisibleServantGroupCss, observeServantSidebarVisibility, type SidebarSessions, type SidebarWorkspaces } from '../src/client/session-visibility.js'

test('empty rendered Ungrouped style preserves ordinary, folded and overflow rows', async () => {
  const { transform } = await import('esbuild')
  const parsed = await transform(emptyVisibleServantGroupCss, { loader: 'css' })
  assert.deepEqual(parsed.warnings, [])
  assert.ok(emptyVisibleServantGroupCss.includes('[data-row-key="workspace:"][aria-expanded="true"]'))
  assert.ok(emptyVisibleServantGroupCss.includes(':not(:has([role="treeitem"][data-row-key^="session:"]:not(:is('))
  assert.ok(emptyVisibleServantGroupCss.includes(':not(:has([data-row-key="overflow:"]))'))
})

const foreground = 'servant-foreground-existing'
function sessions(ids: string[]): SidebarSessions {
  return { phase: 'ready', ids, byId: Object.fromEntries(ids.map(id => [id, { id, retainedBy: {} }])) }
}
const workspaces: SidebarWorkspaces = { phase: 'ready', items: [] }

test('existing and future Servant role rows hide without matching ordinary conversation titles', () => {
  for (const role of ['foreground', 'planner', 'worker', 'helper']) {
    assert.equal(isServantSession('servant-' + role + '-123'), true)
    assert.ok(servantSessionRowsCss.includes('data-row-key^="session:servant-' + role + '-"'))
  }
  for (const id of ['ordinary-session', 'DeepSeek Servant', 'servant-project-notes', 'foreground-123']) assert.equal(isServantSession(id), false)
})

test('only the Servant-only Ungrouped bucket hides; complete ordinary membership is preserved', () => {
  assert.equal(servantOnlyUngrouped(sessions([foreground]), workspaces), true)
  assert.equal(servantOnlyUngrouped(sessions([]), workspaces), false)
  const mixed = sessions([...Array.from({ length: 12 }, (_, i) => 'servant-worker-' + i), 'ordinary'])
  const before = structuredClone(mixed)
  assert.equal(servantOnlyUngrouped(mixed, workspaces), false)
  assert.deepEqual(mixed, before)
  assert.equal(servantOnlyUngrouped(mixed, { phase: 'ready', items: [{ sessionIds: ['ordinary'] }] }), true)
  assert.equal(servantOnlyUngrouped(sessions([foreground]), { phase: 'ready', items: [{ sessionIds: [foreground] }] }), false)
})

test('native subagents, blank drafts and incomplete lists follow existing sidebar visibility', () => {
  const native = sessions([foreground, 'child', 'draft'])
  const modified = { ...native, byId: { ...native.byId,
    child: { id: 'child', origin: 'subagent', retainedBy: {} },
    draft: { id: 'draft', blank: true, retainedBy: {} },
  } }
  assert.equal(servantOnlyUngrouped(modified, workspaces), true)
  assert.equal(servantOnlyUngrouped({ ...modified, byId: { ...modified.byId, draft: { ...modified.byId.draft, retainedBy: { mainView: 1 } } } }, workspaces), false)
  assert.equal(servantOnlyUngrouped({ ...native, phase: 'loading' }, workspaces), false)
  assert.equal(servantOnlyUngrouped(sessions([foreground]), { ...workspaces, phase: 'loading' }), false)
})

test('visibility follows native events and releases both subscriptions on plugin unload', () => {
  let state = sessions([foreground])
  const listeners = new Set<() => void>(), workspaceListeners = new Set<() => void>()
  const css: string[] = []
  const stop = observeServantSidebarVisibility({
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }, {
    getSnapshot: () => workspaces,
    subscribe: listener => { workspaceListeners.add(listener); return () => { workspaceListeners.delete(listener) } },
  }, value => { css.push(value) })
  assert.match(css[0], /workspace:/)
  for (const listener of listeners) listener()
  assert.equal(css.length, 1)
  state = sessions([foreground, 'ordinary'])
  for (const listener of listeners) listener()
  assert.equal(css.at(-1), servantSessionRowsCss + '\n' + emptyVisibleServantGroupCss)
  state = sessions([foreground])
  for (const listener of workspaceListeners) listener()
  assert.match(css.at(-1)!, /workspace:/)
  stop()
  assert.equal(listeners.size + workspaceListeners.size, 0)
})
