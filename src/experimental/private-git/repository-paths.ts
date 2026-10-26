import type { GitRepository, GitSnapshot } from './contracts.js'

/** Metadata is loaded only for a requested task or one page's history directory. */
export async function loadPaths(repo: GitRepository, snapshot: GitSnapshot, prefix: string): Promise<void> {
  await repo.list?.(snapshot, prefix)
}
export async function childDirectories(repo: GitRepository, snapshot: GitSnapshot, prefix: string): Promise<string[]> {
  if (repo.directories) return repo.directories(snapshot, prefix)
  return [...new Set([...snapshot.files.keys()].filter(path => path.startsWith(prefix))
    .map(path => prefix + path.slice(prefix.length).split('/')[0] + '/'))].sort()
}
