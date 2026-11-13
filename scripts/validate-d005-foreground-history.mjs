import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

// Production Foreground text/upgrade, actual role dss_read and physical FilesStore.
// No model behavior, native DSH, Windows or remote Git is simulated.
const sourceRoot = new URL('../src/', import.meta.url)
const require = createRequire(import.meta.url), zodPath = require.resolve('zod')
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'zod') return { url: pathToFileURL(zodPath).href, shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data('export function fromMarkdown(){return {type:"root",children:[]}}'), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (url.href === new URL('framework/skills.ts', sourceRoot).href)
        return { url: data('export const frameworkSkillIndexPath="skills/index.md";export function isFrameworkSkillDefinitionPath(){throw Error("Unrelated skill path")}export function prepareFrameworkSkillIndex(){throw Error("Unrelated skill path")}'), shortCircuit: true }
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts'))
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    return next(url, context)
  },
})
const { foregroundCorePrompt } = await import('../src/framework/foreground-prompt.ts')
const { foregroundFullGuide } = await import('../src/framework/role-prompts.ts')
const { upgradeForegroundGuide } = await import('../src/framework/foreground-guide-upgrade.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { taskHistoryChange, taskHistoryPath } = await import('../src/framework/task-history.ts')
const { paths } = await import('../src/framework/task-files.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const oldIntro = 'Task-completion feedback has a required response order: first use the received taskId and supplied taskMetadataPath or context.taskPath to look up the existing task title in its sourcePath filename and read its actual status; then send the task-specific short response; only afterwards inspect results and acceptance details and report them.'
const newIntro = 'Task-completion feedback has a required response order: first use the received taskId and supplied taskMetadataPath or context.taskPath (otherwise tasks/<taskId>.json) to read the existing task title in its sourcePath filename and its actual status. If current metadata is absent, read the existing archived Task identity at context.taskHistoryPath when supplied, otherwise archives/task-identities/<taskId>.json, for its sourcePath, status and resultPaths. Use that identity only for historical feedback, never to restart the Task. Then send the task-specific short response; only afterwards inspect results and acceptance details and report them.'
const oldResults = "Use current tasks/<taskId>.json resultPaths and the selected Task's archiveRecordsPath and archiveDirectory returned by dss_snapshot or dss_claim."
const newResults = "Use the selected Task's current metadata resultPaths and returned archiveRecordsPath and archiveDirectory; if current metadata was removed, use the existing archived Task identity's resultPaths and select that taskId in dss_snapshot for its exact historical archiveDirectory and archiveRecordsPath."
let assertions = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
let directory
try {
  const full = foregroundFullGuide(), core = foregroundCorePrompt
  check(full.includes(newIntro), true)
  check(full.includes(newResults), true)
  check(core.includes('If that current metadata is absent, read the existing archived Task identity at context.taskHistoryPath when supplied, otherwise archives/task-identities/<taskId>.json'), true)
  check(core.includes('Use that identity only for historical feedback, never to restart the Task.'), true)
  check(full.includes('sourcePath filename'), true)
  const prior = full.replace(newIntro, oldIntro).replace(newResults, oldResults)
  check(prior !== full, true)
  check(upgradeForegroundGuide(prior).text, full)
  check(upgradeForegroundGuide(prior).changedRules, 2)
  const olderResults = 'Use current tasks/<taskId>.json resultPaths, archives/<taskId>/records.md, and the exact outputs, retainedPaths and relocatedReferences in archives/<taskId>/retention.json to find and read preserved material.'
  const older = prior.replace(oldResults, olderResults)
  check(upgradeForegroundGuide(older).text, full)
  check(upgradeForegroundGuide(older).changedRules, 2)
  const customized = '\uFEFF' + prior.replaceAll('\n', '\r\n') + '\r\n我的自定义段落保持原样。\r\n'
  check(upgradeForegroundGuide(customized).text, '\uFEFF' + full.replaceAll('\n', '\r\n') + '\r\n我的自定义段落保持原样。\r\n')
  check(upgradeForegroundGuide(upgradeForegroundGuide(customized).text).changedRules, 0)
  const customRule = prior.replace(oldIntro, 'My custom task response rule.')
  check(upgradeForegroundGuide(customRule).text.includes('My custom task response rule.'), true)
  check(upgradeForegroundGuide('Entirely custom guide. ' + oldIntro).text, 'Entirely custom guide. ' + oldIntro)
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-d005-history-'))
  const files = new PhysicalLocalFiles(directory), taskId = '10000000-0000-4000-8000-000000000005'
  const task = { version: 1, taskId, route: 'P', owner: 'A', status: 'complete', sourcePath: 'tasks/Customer Report_P.md', archiveFolder: 'Customer Report_' + taskId, resultPaths: ['archives/Customer Report_' + taskId + '/answer.md'] }
  await files.replace(paths.task(taskId), JSON.stringify(task))
  await files.replace(taskHistoryPath(taskId), taskHistoryChange(task).content)
  await files.replace(task.resultPaths[0], 'Customer report completed')
  await files.delete(paths.task(taskId)) // Host cleanup's relevant final condition.
  const tools = new Map(), agent = { id: 'foreground', session: {} }
  installFrameworkRoleTools({ on: () => () => {}, effect() {}, systemPrompt: { section() {} }, tools: { register: tool => tools.set(tool.name, tool) } },
    agent, { role: 'Foreground', owner: 'A', member: 'A', workId: 'Foreground', executionId: 'foreground-execution' },
    { files, notifications: async () => [], claimNotifications: async () => ({ signals: [] }), onError(error) { throw error } })
  let serial = 0
  const call = (name, input) => tools.get(name).execute(input, { agent, callId: String(++serial), signal: new AbortController().signal, concludeTurn() {} })
  const view = await call('dss_snapshot', { taskId })
  check(view.archiveDirectory, paths.archive(task))
  const current = await call('dss_read', { snapshotId: view.snapshotId, path: paths.task(taskId) })
  check(current.exists, false)
  const archived = await call('dss_read', { snapshotId: view.snapshotId, path: taskHistoryPath(taskId) })
  check(archived.exists, true)
  const identity = JSON.parse(archived.text)
  check(identity.sourcePath, task.sourcePath)
  check(identity.status, 'complete')
  check(identity.resultPaths, task.resultPaths)
  check('title' in identity, false)
  const output = await call('dss_read', { snapshotId: view.snapshotId, path: identity.resultPaths[0] })
  check(output.text, 'Customer report completed')
  console.log(JSON.stringify({ status: 'passed', assertions, scope: 'Generated Foreground core/full guide, exact old-template migration preserving customization, actual physical dss_snapshot/dss_read of archived identity after current metadata removal; not model/Windows/remote-Git acceptance' }, null, 2))
} finally {
  hooks.deregister()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
}
