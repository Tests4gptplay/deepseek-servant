// Synthetic browser fixture for the actual React page/controller; not a Host acceptance claim.
import { createRoot } from 'react-dom/client'
import { FrameworkPage } from '../../src/framework/client-page.js'
import { getFrameworkClientController, type FrameworkClientApi, type FrameworkClientView } from '../../src/framework/client-contracts.js'
const rows = Array.from({ length: 240 }, (_, i) => ({ id: `qa-${String(i).padStart(4, '0')}`, participantId: 'synthetic', role: 'user' as const,
  createdAt: `2026-10-${29 + Math.floor(i / 80)}T00:${String(i % 60).padStart(2, '0')}:00Z`, text: `Synthetic original ${i}\n` + 'Variable height history row. '.repeat(1 + i % 7) }))
let directory = 'A', notify = () => {}, hold = false, release: (() => void) | undefined
const calls: unknown[] = []
const view = (mode: 'local' | 'git' = 'local'): FrameworkClientView => ({ revision: 'R', activeMode: mode, collaborationId: mode, storageScope: directory,
  settings: { name: 'History QA', userName: '', localDirectory: directory, ownerRepo: '', repositoryDirectory: '', collaborationId: mode, workerSeats: 0, workspace: '' },
  connection: { status: 'connected', participating: true }, messages: mode === 'local' && directory === 'A' ? rows.slice(-50) : [],
  pageBefore: mode === 'local' && directory === 'A' ? rows.at(-50)?.id : undefined, tasks: [], legacyTasks: [], archives: [], resources: [] })
const api = { view: async input => view(input.mode), selectMode: async input => view(input.mode), subscribeChanged: listener => { notify = listener; return () => { notify = () => {} } },
  history: async input => {
    calls.push(input)
    const selected = input.date ? rows.filter(row => row.createdAt.startsWith(input.date!)) : [...rows]
    const end = input.beforeId ? selected.findIndex(row => row.id === input.beforeId) : selected.length
    const start = input.afterId ? selected.findIndex(row => row.id === input.afterId) + 1
      : input.beforeId ? Math.max(0, end - input.limit) : input.date ? 0 : Math.max(0, end - input.limit)
    const messages = selected.slice(start, Math.min(end, start + input.limit))
    const moreBefore = start > 0 ? messages[0]?.id : undefined
    const moreAfter = start + messages.length < selected.length ? messages.at(-1)?.id : undefined
    if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve }) }
    return { revision: 'H', messages, moreBefore, moreAfter }
  }, configure: async input => view(input.mode),
} as FrameworkClientApi
;(window as any).qa = { calls, hold: () => { hold = true }, release: () => { release?.(); release = undefined },
  append: () => { const i = rows.length; rows.push({ ...rows.at(-1)!, id: `qa-${String(i).padStart(4, '0')}`, text: 'Synthetic new reply ' + i }); notify() },
  directory: () => { directory = 'B'; notify() }, controller: getFrameworkClientController(api) }
createRoot(document.getElementById('root')!).render(<FrameworkPage api={api} language="en" />)
