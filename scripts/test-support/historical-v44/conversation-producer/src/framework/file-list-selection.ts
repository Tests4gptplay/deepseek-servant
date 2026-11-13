/** Serializable predicates for the metadata the caller actually consumes.
 * Lists retain absent/new matching members, not merely their current entries. */
export interface FileListSelection {
  /** Parent archive enumeration excludes existing direct child Task namespaces. */
  archiveScope?: { root: string; childTaskIds: readonly string[] }
  paths?: readonly string[]
  namePrefix?: string
  nameSuffix?: string
  names?: readonly string[]
  excludeNames?: readonly string[]
  /** Existing Worker notification grammar, including legacy URI spellings. */
  workerId?: string
  /** Instance publication consumes only valid registration membership. */
  instanceRegistration?: true
}
/** Self-contained because the package-owned SQLite worker uses this exact
 * function too. Keep it free of captured values and runtime imports. */
export function matchesFileSelection(path: string, selected?: FileListSelection): boolean {
  if (!selected) return true
  if (selected.archiveScope) {
    const { root, childTaskIds } = selected.archiveScope
    if (path !== root && !path.startsWith(root + '/')) return false
    const first = path.slice(root.length + 1).split('/')[0]!.toLowerCase()
    if (childTaskIds.some(id => first === id.toLowerCase() || first.endsWith('_' + id.toLowerCase()))) return false
  }
  if (selected.instanceRegistration) {
    const match = /^instances\/([^/]+)_Workers(\d+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i.exec(path)
    if (!match || /[\\\0\r\n]/.test(match[1]!) || match[1] === '.' || match[1] === '..' || !Number.isSafeInteger(Number(match[2]))) return false
  }
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (selected.paths && !selected.paths.includes(path)) return false
  if (selected.excludeNames?.includes(name)) return false
  if (selected.nameSuffix !== undefined && !name.endsWith(selected.nameSuffix)) return false
  if ((selected.namePrefix !== undefined || selected.names !== undefined)
    && !(selected.namePrefix !== undefined && name.startsWith(selected.namePrefix)) && !selected.names?.includes(name)) return false
  if (selected.workerId !== undefined) {
    const match = /^Worker_(.+)_Planner$/.exec(name) ?? /^Worker_(.+)$/.exec(name)
    if (!match) return false
    try {
      const child = decodeURIComponent(match[1]!)
      if (!child || /[\\/\0\r\n]/.test(child) || child === '.' || child === '..' || child !== selected.workerId) return false
    } catch { return false }
  }
  return true
}
export const fileSelectionKey = (selected?: FileListSelection): string => selected ? ':' + JSON.stringify(selected) : ''
