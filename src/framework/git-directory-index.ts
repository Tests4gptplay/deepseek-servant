/** Rebuildable, process-local Git metadata. No snapshots, bodies, transports,
 * authorization objects or business predicates are retained by this index. */
export interface GitDirectoryEntry {
  readonly path: string
  readonly sha: string
  readonly type: 'blob' | 'tree' | 'commit'
  readonly mode: string
}
export interface GitDirectoryIndexOptions { recursive?: boolean }
export interface GitDirectoryTreeMetadata {
  readonly sha: string
  /** Names relative to this tree, rather than repository paths. */
  readonly children: readonly GitDirectoryEntry[]
}
export interface GitDirectoryIndexNode {
  readonly path: string
  readonly sha: string
  readonly entries: readonly GitDirectoryEntry[]
  readonly directories: readonly GitDirectoryIndexNode[]
}
export interface GitDirectoryIndex {
  readonly prefix: string
  readonly physicalPrefix: string
  readonly recursive: boolean
  readonly rootTree: string
  readonly entries: readonly GitDirectoryEntry[]
  readonly ancestry: readonly GitDirectoryTreeMetadata[]
  readonly directory?: GitDirectoryIndexNode
}

/** Reads tree metadata only. An unchanged subtree reuses its immutable local
 * node, including flattened membership, without visiting its descendants.
 * Previous views remain usable by concurrent callers; only the returned view
 * belongs to the requested root. Losing it simply causes a complete rebuild. */
export async function rebuildGitDirectoryIndex(
  rootTree: string,
  prefix: string,
  physicalPrefix: string,
  readTree: (sha: string) => Promise<readonly GitDirectoryEntry[]>,
  previous?: GitDirectoryIndex,
  options: GitDirectoryIndexOptions = {},
): Promise<GitDirectoryIndex> {
  const recursive = options.recursive !== false
  const prior = previous?.prefix === prefix && previous.physicalPrefix === physicalPrefix && previous.recursive === recursive ? previous : undefined
  if (prior?.rootTree === rootTree) return prior
  const ancestry: GitDirectoryTreeMetadata[] = []
  let current = rootTree
  // Keep only metadata on the current prefix's ancestor chain. In particular,
  // this is not an ever-growing cache of old roots or an old Git object store.
  for (const name of physicalPrefix ? physicalPrefix.split('/') : []) {
    if (!current) break
    const known = prior?.ancestry.find(tree => tree.sha === current)
    const metadata: GitDirectoryTreeMetadata = known ?? Object.freeze({ sha: current, children: Object.freeze((await readTree(current)).map(entry => Object.freeze({ path: entry.path, sha: entry.sha, type: entry.type, mode: entry.mode }))) })
    ancestry.push(metadata)
    const child = metadata.children.find(entry => entry.path === name)
    current = child?.type === 'tree' ? child.sha : ''
  }
  const visit = async (sha: string, path: string, old?: GitDirectoryIndexNode): Promise<GitDirectoryIndexNode> => {
    if (old?.sha === sha && old.path === path) return old
    const entries: GitDirectoryEntry[] = [], directories: GitDirectoryIndexNode[] = []
    const oldChildren = new Map(old?.directories.map(directory => [directory.path, directory]))
    for (const child of await readTree(sha)) {
      const childPath = path + '/' + child.path
      entries.push(Object.freeze({ path: childPath, sha: child.sha, type: child.type, mode: child.mode }))
      if (recursive && child.type === 'tree') {
        const directory = await visit(child.sha, childPath, oldChildren.get(childPath))
        directories.push(directory)
        for (const entry of directory.entries) entries.push(entry)
      }
    }
    return Object.freeze({ path, sha, entries: Object.freeze(entries), directories: Object.freeze(directories) })
  }
  const directory = current ? await visit(current, prefix, prior?.directory) : undefined
  return Object.freeze({ prefix, physicalPrefix, recursive, rootTree,
    entries: directory?.entries ?? Object.freeze([]), ancestry: Object.freeze(ancestry), directory })
}
