import { createHash } from 'node:crypto'
import { filePath } from './transactions.js'

const daily = /^debug\/(\d{4}-\d{2}-\d{2})\.md$/
const record = /^debug\/\d{4}-\d{2}-\d{2}_Host_Recovery_[0-9a-f]{64}\.md$/
/** Host-owned recovery evidence remains a real, retained file under the same
 * debug category. Its original accepted command and date determine its name. */
export function hostRecoveryDebugPath(dailyPath: string, commandId: string): string {
  const date = daily.exec(dailyPath)?.[1]
  if (!date || !commandId) throw new Error('A Host recovery record requires its original dated input and command.')
  return 'debug/' + date + '_Host_Recovery_' + createHash('sha256').update(commandId).digest('hex') + '.md'
}
export function isHostRecoveryDebugPath(path: string): boolean { return record.test(path) }
/** Old accepted publications keep their exact dated signal. New publications
 * name the complete real file, without an index or a signal body to reread. */
export function hostRecoverySignalPath(originalSignal: string, debugPath: string): string {
  filePath(originalSignal)
  if (daily.test(debugPath)) return originalSignal
  if (!isHostRecoveryDebugPath(debugPath) || !/^Planner_Recovery_\d{4}-\d{2}-\d{2}_[^/]+$/.test(originalSignal.slice(originalSignal.lastIndexOf('/') + 1)))
    throw new Error('A Host recovery notice requires its original Planner signal and exact recovery record.')
  return originalSignal.slice(0, originalSignal.lastIndexOf('/') + 1) + 'Planner_Recovery_Report_' + debugPath.slice('debug/'.length)
}
