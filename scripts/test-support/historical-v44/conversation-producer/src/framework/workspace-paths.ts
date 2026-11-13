// Reconstructed from the 55fe host bundle's workspace-paths runtime module.
// Runtime behavior is retained; TypeScript types/exports are reconstructed.
export interface PhysicalWorkspaceReference {
  path: string
  /** Optional record association; never required to open the physical address. */
  taskId?: string
  owner: string
  instanceUUID: string
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function taskWorkspaceFolder(name: string, taskId: string): string {
  if (!uuid.test(taskId)) throw new Error('A task workspace requires a UUID.')
  let title = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').replace(/[ .]+$/u, '').trim()
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(title)) title = '_' + title
  title = Array.from(title || 'Task').reduce((result, char) => result.length + char.length <= 100 ? result + char : result, '')
  title = title.replace(/[ .]+$/u, '') || 'Task'
  return title + '_' + taskId.toLowerCase()
}

export function taskSourceName(sourcePath: string): string {
  return sourcePath.split('/').at(-1)?.replace(/_(?:P|O)\.md$/u, '') || 'Task'
}

export function isAbsoluteNativePath(value: unknown): value is string {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/u.test(value)
    && (value.startsWith('/') || /^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(value))
    && !value.split(/[\\/]/u).some(part => part === '.' || part === '..')
}

export function isPhysicalWorkspaceReference(value: unknown): value is PhysicalWorkspaceReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<PhysicalWorkspaceReference>
  return isAbsoluteNativePath(ref.path)
    && typeof ref.owner === 'string' && !!ref.owner && !/[\\/\u0000-\u001f\u007f]/u.test(ref.owner)
    && typeof ref.instanceUUID === 'string' && uuid.test(ref.instanceUUID)
}

export function sameWorkspaceReference(a: unknown, b: unknown): boolean {
  return isPhysicalWorkspaceReference(a) && isPhysicalWorkspaceReference(b)
    && a.path === b.path && a.owner === b.owner && a.instanceUUID === b.instanceUUID
}

/** Standard Markdown title, carried with the real destination, not a task lookup. */
export function physicalWorkspaceTitle(source: Pick<PhysicalWorkspaceReference, 'owner' | 'instanceUUID'>): string {
  if (!isPhysicalWorkspaceReference({ ...source, path: '/' })) throw new Error('A physical link requires its producing Host identity.')
  return 'DSS source: owner=' + encodeURIComponent(source.owner) + '; instanceUUID=' + source.instanceUUID
}

export function physicalWorkspaceLink(reference: PhysicalWorkspaceReference, label = reference.path.split(/[\\/]/u).at(-1) || reference.path): string {
  if (!isPhysicalWorkspaceReference(reference)) throw new Error('A physical link requires an absolute address and its producing Host identity.')
  const destination = reference.path.replace(/[%&<>|\s\\#?]/gu, character => encodeURIComponent(character))
  const text = label.replace(/[&\\`*_[\]{}()#+.!<>|~-]/gu, '\\$&')
  return '[' + text + '](<' + destination + '> "' + physicalWorkspaceTitle(reference) + '")'
}

/** Only the link's explicit source is used. No current-Host or Task inference. */
export function physicalWorkspaceLinkSource(path: string, title: string | null | undefined): PhysicalWorkspaceReference | undefined {
  const match = /^DSS source: owner=([^;]+); instanceUUID=([^;]+)$/u.exec(title ?? '')
  if (!match) return undefined
  try {
    const reference = { path, owner: decodeURIComponent(match[1]), instanceUUID: match[2] }
    return isPhysicalWorkspaceReference(reference) ? reference : undefined
  } catch { return undefined }
}
