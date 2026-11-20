import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { build, stop } from 'esbuild'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
const require = createRequire(import.meta.url)
const React = require('react'), { createRoot } = require('react-dom/client')
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/framework/client-page.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external',
  loader: { '.css': 'local-css' }, outdir: 'unused',
  define: {
    __SERVANT_ICON_DATA_URI__: '"data:image/svg+xml,%3Csvg/%3E"', __SERVANT_WELCOME_CHARACTER_DATA_URI__: '"data:image/svg+xml,%3Csvg/%3E"', __SERVANT_TASK_EMPTY_CHARACTER_DATA_URI__: '"data:image/svg+xml,%3Csvg/%3E"',
  },
})
const primitives = new Proxy({}, { get(target, key) {
  return target[key] ??= primitive(key)
} })
function primitive(key) {
  if (key === 'Button') return React.forwardRef((props, ref) => React.createElement('button', { ...props, ref }))
  if (key === 'Input') return React.forwardRef(({ icon, ...props }, ref) => React.createElement('input', { ...props, ref }))
  if (key === 'SegmentedControl') return ({ options, onChange }) => options.map(option => React.createElement('button', { key: option.value, onClick: () => onChange(option.value) }, option.label))
  if (key === 'Menu') return ({ anchor }) => anchor
  return () => null
}
const mod = { exports: {} }
new Function('require', 'module', 'exports', outputFiles.find(file => file.path.endsWith('.js')).text)(
  name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : name.startsWith('@deepseek-ai/dsh-client-ui-attachment/src/') ? {} : require(name), mod, mod.exports)
const root = createRoot(document.querySelector('#root'))
const task = (taskId, title, createdAt, status = 'complete') => ({ taskId, title, createdAt, route: 'P', owner: 'fixture', status, members: [], executions: [], resultPaths: [] })
const view = {
  revision: 'r1', activeMode: 'local', collaborationId: 'fixture', storageScope: 'fixture',
  settings: { name: 'DSS', workspace: '' }, connection: { status: 'connected', participating: true },
  messages: [], resources: [], legacyTasks: [], executions: [],
  tasks: [task('task-Aa01', '中文 Alpha 审阅'), task('task-bb02', '中文 Beta'), task('task-cc03', 'Third'), task('task-cc02', 'Fourth', NaN)],
  archives: [
    { taskId: 'task-bb02', title: '归档 Zeta', path: 'archives/Zeta/records.md' },
    { taskId: 'task-Aa01', title: 'First archive', path: 'archives/first/records.md' },
    { title: '独立归档', path: 'archives/legacy/records.md' },
  ],
}
const calls = []
const api = new Proxy({
  view: async input => { calls.push(['view', input]); return { ...view, archives: input?.includeArchives ? view.archives : [] } },
  history: async input => { calls.push(['history', input]); return { messages: [] } },
  subscribeChanged: () => () => {},
}, { get(target, key) { return target[key] } })
const { act } = React
const button = (text, attr = 'textContent') => [...document.querySelectorAll('button')].find(el => (attr === 'textContent' ? el.textContent : el.getAttribute(attr)) === text)
const click = async el => { assert.ok(el); await act(async () => el.click()) }
const input = () => document.querySelector('[role="search"] input')
const write = async value => {
  assert.ok(input())
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input(), value)
    input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const tasks = () => [...document.querySelectorAll('button[class*="taskRow"] > span[class*="taskRowTitle"]')].map(el => el.textContent)
const archives = () => [...document.querySelectorAll('section[class*="knowledgeCard"] h3')].map(el => el.textContent)
try {
  await act(async () => root.render(React.createElement(mod.exports.FrameworkPage, { api, language: 'zh' })))
  await click(button('任务'))
  assert.equal(input().getAttribute('aria-label'), '搜索任务标题或 ID')
  const taskOrder = view.tasks.map(x => x.title), archiveOrder = view.archives.map(x => x.title)
  assert.deepEqual(tasks(), taskOrder)
  const taskStart = calls.length
  await write('  中文 aLPHa '); assert.deepEqual(tasks(), [taskOrder[0]])
  await write('AA01'); assert.deepEqual(tasks(), [taskOrder[0]])
  await write('未命中'); assert.deepEqual(tasks(), []); assert.match(document.body.textContent, /没有匹配的任务/)
  await click(button('清除搜索', 'aria-label')); assert.deepEqual(tasks(), taskOrder); assert.ok(document.activeElement === input(), 'clear keeps focus in the search box')
  await write('中文'); assert.deepEqual(tasks(), taskOrder.slice(0, 2))
  assert.equal(calls.length, taskStart, 'task keystrokes and clear must not call the API')
  await click(button('成果档案'))
  assert.equal(input().value, '中文', 'shared query carries to archive tab')
  assert.ok(calls.slice(taskStart).some(([, p]) => p?.includeArchives), 'existing archive refresh must run')
  assert.deepEqual(archives(), archiveOrder.slice(0, 2), 'match task titles and retain archive ordering')
  const archiveStart = calls.length
  await write('aA01'); assert.deepEqual(archives(), [archiveOrder[1]])
  await write('独立归'); assert.deepEqual(archives(), [archiveOrder[2]], 'archives without task IDs can match by title')
  await write('未命中'); assert.deepEqual(archives(), []); assert.match(document.body.textContent, /没有匹配的档案/)
  await click(button('清除搜索', 'aria-label')); assert.deepEqual(archives(), archiveOrder)
  await write('归档 zETA'); assert.deepEqual(archives(), [archiveOrder[0]])
  assert.equal(calls.length, archiveStart, 'archive keystrokes and clear must not call the API')
  await click(button('当前任务'))
  assert.equal(input().value, '归档 zETA')
  assert.deepEqual(tasks(), [taskOrder[1]], 'archive title can match a related task by its loaded ID')
  await write(''); assert.deepEqual(tasks(), taskOrder)
  view.tasks = [task('z', 'Newest tie Z', 40, 'cancelled'), task('old-2', 'Old formerly first'),
    task('a', 'Newest tie A', 40, 'running'), task('old-1', 'Old formerly second'),
    task('middle', 'Known earlier', 20, 'complete')]
  await click(button('刷新'))
  const expected = ['Newest tie A', 'Newest tie Z', 'Known earlier', 'Old formerly first', 'Old formerly second']
  assert.deepEqual(tasks(), expected, 'creation sequence ignores status, ties use exact IDs, undated order remains stable')
  view.tasks = [view.tasks[1], { ...view.tasks[2], status: 'complete', archived: true }, view.tasks[4], view.tasks[3], view.tasks[0]]
  await click(button('刷新'))
  assert.deepEqual(tasks(), expected, 'reloaded runtime/archive task keeps its position')
  await click(button('成果档案')); assert.deepEqual(archives(), archiveOrder, 'archive display order is unchanged')
  console.log('PASS: FrameworkPage shared task/archive search; Chinese/mixed case, partial task ID, bidirectional exact-ID relation, absent IDs, no matches, clear/focus, newest-first and deterministic ties, undated order, completed/reloaded position, unchanged archive order, archive activation refresh, no search RPCs.')
} finally {
  await act(() => root.unmount())
  dom.window.close()
  stop()
}
