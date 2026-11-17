import { isHelperDatedRecord, isHelperDebugRecord } from './helper-debug-path.js'
import { createHash } from 'node:crypto'
import { filePath } from './transactions.js'

const daily = /^debug\/(\d{4}-\d{2}-\d{2})\.md$/
const record = /^debug\/\d{4}-\d{2}-\d{2}_Host_Recovery_[0-9a-f]{64}\.md$/
/** Host-owned recovery evidence remains a real, retained file under the same
 * debug category. Its original accepted command and date determine its name. */
export function hostRecoveryDebugPath(dailyPath: string, commandId: string): string {
  const date = isHelperDatedRecord(dailyPath) ? dailyPath.slice(-13, -3) : undefined
  if (!date || !commandId) throw new Error('A Host recovery record requires its original dated input and command.')
  return dailyPath.slice(0, dailyPath.lastIndexOf('/') + 1) + date + '_Host_Recovery_' + createHash('sha256').update(commandId).digest('hex') + '.md'
}
export function isHostRecoveryDebugPath(path: string): boolean { return record.test(path) || isHelperDebugRecord(path) && /\/\d{4}-\d{2}-\d{2}_Host_Recovery_[0-9a-f]{64}\.md$/.test(path) }
/** Old accepted publications keep their exact dated signal. New publications
 * name the complete real file, without an index or a signal body to reread. */
export function hostRecoverySignalPath(originalSignal: string, debugPath: string): string {
  filePath(originalSignal)
  if (daily.test(debugPath)) return originalSignal
  if (!(isHostRecoveryDebugPath(debugPath) || isHelperDatedRecord(debugPath)) || !/^Planner_Recovery_\d{4}-\d{2}-\d{2}_[^/]+$/.test(originalSignal.slice(originalSignal.lastIndexOf('/') + 1)))
    throw new Error('A Host recovery notice requires its original Planner signal and exact recovery record.')
  const suffix = isHelperDebugRecord(debugPath) ? encodeURIComponent(debugPath).replaceAll('_', '%5F')
    // A shared dated Git log still has distinct original command notifications.
    + (isHelperDatedRecord(debugPath) ? '_' + originalSignal.slice(originalSignal.lastIndexOf('_') + 1) : '') : debugPath.slice('debug/'.length)
  return originalSignal.slice(0, originalSignal.lastIndexOf('/') + 1) + 'Planner_Recovery_Report_' + suffix
}

export function hostRecoverySignalRecordPath(signalPath: string): string | undefined {
  const name = signalPath.slice(signalPath.lastIndexOf('/') + 1)
  if (!name.startsWith('Planner_Recovery_Report_')) return
  const suffix = name.slice('Planner_Recovery_Report_'.length)
  let path: string
  try { path = suffix.startsWith('debug%2F') ? decodeURIComponent(suffix.includes('_') ? suffix.slice(0, suffix.lastIndexOf('_')) : suffix) : 'debug/' + suffix } catch { return }
  return isHostRecoveryDebugPath(path) || isHelperDebugRecord(path) && isHelperDatedRecord(path) ? path : undefined
}
