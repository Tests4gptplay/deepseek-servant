import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

interface SidebarSession {
  readonly id: string
  readonly origin?: string
  readonly blank?: boolean
  readonly retainedBy: Readonly<Record<string, number | undefined>>
}
export interface SidebarSessions {
  readonly phase: string
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SidebarSession | undefined>>
}
export interface SidebarWorkspaces {
  readonly phase: string
  readonly items: readonly { readonly sessionIds: readonly string[] }[]
}

const roles = ['foreground', 'planner', 'worker', 'helper'] as const
const servantRowSelector = roles.map(role => `[role="treeitem"][data-row-key^="session:servant-${role}-"]`).join(', ')
export const servantSessionRowsCss = servantRowSelector + ' { display: none !important; }'
const emptyUngroupedCss = 'div:has(> [role="treeitem"][data-row-key="workspace:"]) { display: none !important; }'
// The native archive filter can leave only Servant rows visible while the full
// membership still contains ordinary history. Match an expanded, fully rendered
// group only; a real row or a Show more control keeps that group accessible.
export const emptyVisibleServantGroupCss =
  'div:has(> [role="treeitem"][data-row-key="workspace:"][aria-expanded="true"])'
  + ':has(' + servantRowSelector + ')'
  + ':not(:has([role="treeitem"][data-row-key^="session:"]:not(:is(' + servantRowSelector + '))))'
  + ':not(:has([data-row-key="overflow:"])) { display: none !important; }'

/** Only the reserved physical Session identities minted by Servant. */
export function isServantSession(id: string): boolean {
  return roles.some(role => id.startsWith('servant-' + role + '-'))
}

/** Use complete native membership, not the first five rendered rows or expansion state. */
export function servantOnlyUngrouped(sessions: SidebarSessions, workspaces: SidebarWorkspaces): boolean {
  if (sessions.phase !== 'ready' || workspaces.phase !== 'ready') return false
  const assigned = new Set(workspaces.items.flatMap(workspace => workspace.sessionIds))
  let servant = false
  for (const id of sessions.ids) {
    const session = sessions.byId[id]
    if (!session || assigned.has(id) || session.origin === 'subagent'
      || (session.blank && !session.retainedBy.mainView)) continue
    // Include ordinary archives too: switching the native archive filter must
    // never hide a user's actual Ungrouped conversations.
    if (!isServantSession(id)) return false
    servant = true
  }
  return servant
}

/** Display only: no Session mutation, archiving, cancellation, or extra history reads. */
export function observeServantSidebarVisibility(
  sessions: HostObservable<SidebarSessions>, workspaces: HostObservable<SidebarWorkspaces>, publish: (css: string) => void,
): () => void {
  let previous: string | undefined
  const sync = () => {
    const css = servantSessionRowsCss + '\n' + emptyVisibleServantGroupCss + (servantOnlyUngrouped(sessions.getSnapshot(), workspaces.getSnapshot()) ? '\n' + emptyUngroupedCss : '')
    if (css !== previous) { previous = css; publish(css) }
  }
  const stopSessions = sessions.subscribe(sync), stopWorkspaces = workspaces.subscribe(sync)
  sync()
  return () => { stopSessions(); stopWorkspaces() }
}
