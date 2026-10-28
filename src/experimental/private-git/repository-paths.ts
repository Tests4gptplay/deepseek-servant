import type { GitRepository, GitSnapshot } from './contracts.js'

/** Convert a DSS record reference to its real path in the configured repository. */
export function toRepositoryPath(directory: string, path: string): string {
  if (!path.startsWith('dss-coop/')) throw new Error('Expected a DSS record reference.')
  return (directory ? directory + '/' : '') + path.slice('dss-coop/'.length)
}
export function toRecordPath(directory: string, path: string): string {
  const prefix = directory ? directory + '/' : ''
  if (prefix && !path.startsWith(prefix)) throw new Error('The repository path is outside the configured collaboration directory.')
  return 'dss-coop/' + path.slice(prefix.length)
}
export function repositoryUrl(ownerRepo: string, revision: string, path: string): string {
  return 'https://github.com/' + ownerRepo + '/tree/' + encodeURIComponent(revision) + '/' +
    path.split('/').map(encodeURIComponent).join('/')
}
export function archiveRepositoryPaths(directory: string, taskId: string, recordsPath: string) {
  return {
    manifest: toRepositoryPath(directory, 'dss-coop/records/' + taskId + '/manifest.json'),
    summary: toRepositoryPath(directory, 'dss-coop/records/' + taskId + '/records.md'),
    text: toRepositoryPath(directory, recordsPath),
  }
}

/** Metadata is loaded only for a requested task or one page's history directory. */
export async function loadPaths(repo: GitRepository, snapshot: GitSnapshot, prefix: string): Promise<void> {
  await repo.list?.(snapshot, prefix)
}
export async function childDirectories(repo: GitRepository, snapshot: GitSnapshot, prefix: string): Promise<string[]> {
  if (repo.directories) return repo.directories(snapshot, prefix)
  return [...new Set([...snapshot.files.keys()].filter(path => path.startsWith(prefix))
    .map(path => prefix + path.slice(prefix.length).split('/')[0] + '/'))].sort()
}
