import { createHash } from 'node:crypto'
import { filePath } from './transactions.js'

/** Permanent Helper records, separate from Task work directories and claim state. */
export const helperDebugRoot = 'debug/helper-debug/'
const legacyDaily = /^debug\/\d{4}-\d{2}-\d{2}\.md$/
const legacyReport = /^debug\/helper-reports\/([^/\\\0\r\n:*?"<>|]+\.md)$/
const currentRecord = /^debug\/helper-debug\/(?:tasks\/[^/\\\0\r\n:*?"<>|]+|host)\/[^/\\\0\r\n:*?"<>|]+\.md$/
export function helperDebugPath(taskId: string | undefined, date: string): string {
  const path = helperDebugRoot + (taskId ? 'tasks/' + taskId : 'host') + '/' + date + '.md'
  filePath(path)
  if (!currentRecord.test(path) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A Helper record needs its actual Task identity or Host scope and date.')
  return path
}
export function isHelperDebugRecord(path: string): boolean { return currentRecord.test(path) }
export function isHelperDatedRecord(path: string): boolean {
  return legacyDaily.test(path) || currentRecord.test(path) && /\/\d{4}-\d{2}-\d{2}\.md$/.test(path)
}
export function isHelperWritableRecord(path: string): boolean {
  return currentRecord.test(path) || legacyDaily.test(path) || legacyReport.test(path)
}
/** New notices name the complete retained path. Accepted old calls keep their
 * original filename/date signal; no index, signal body or extra read is used. */
export function helperReportSignalPath(path: string, commandId: string): string {
  filePath(path)
  const oldReport = legacyReport.exec(path)
  const name = currentRecord.test(path) ? 'Foreground_Helper_Report_' + encodeURIComponent(path).replaceAll('_', '%5F') + '_' + createHash('sha256').update(commandId).digest('hex')
    : oldReport ? 'Foreground_Helper_Report_' + oldReport[1]
      : legacyDaily.test(path) ? 'Foreground_Helper_' + path.slice(6, 16) + '_' + createHash('sha256').update(commandId).digest('hex')
        : undefined
  if (!name) throw new Error('A Helper report must name its actual retained record.')
  return 'state/' + name
}

export function helperReportRecordPath(signalPath: string): string | undefined {
  const name = signalPath.slice(signalPath.lastIndexOf('/') + 1)
  const prefix = 'Foreground_Helper_Report_'
  if (name.startsWith(prefix + 'debug%2Fhelper-debug%2F')) {
    const encoded = name.slice(prefix.length, name.lastIndexOf('_'))
    let path: string
    try { path = decodeURIComponent(encoded) } catch { return }
    return isHelperDebugRecord(path) ? path : undefined
  }
  if (name.startsWith(prefix)) {
    const path = 'debug/helper-reports/' + name.slice(prefix.length)
    return legacyReport.test(path) ? path : undefined
  }
  const date = /^Foreground_Helper_(\d{4}-\d{2}-\d{2})_/.exec(name)?.[1]
  return date ? 'debug/' + date + '.md' : undefined
}
