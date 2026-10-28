import { z } from 'zod'
import type { CoopSettings, GitRepository, GitSnapshot } from './contracts.js'
import { readJson, readText } from './journal.js'
import { childDirectories, loadPaths, repositoryUrl, toRecordPath, toRepositoryPath } from './repository-paths.js'

export const CoopReadSchema = z.object({
  path: z.string().default('dss-coop/').describe('Exact record reference or repository path. History: dss-coop/history/<taskId>.json; archive: dss-coop/records/<taskId>/manifest.json. Files, chunked text and directories are detected automatically.'),
  pathKind: z.enum(['record', 'repository']).default('record').describe('record for dss-coop/... references and all role-context paths; repository for the repositoryPath returned by this tool.'),
  revision: z.string().optional().describe('Read this exact commit. Omit to resolve archived task references automatically.'),
  offset: z.int().nonnegative().default(0),
  limit: z.int().min(1).max(65536).default(12000),
  textRecord: z.boolean().default(false).describe('Read a chunked text record by its directory, using its manifest.'),
})
type LocationSettings = Pick<CoopSettings, 'ownerRepo' | 'repositoryDirectory'>

/** Read-only record navigation; scheduling still observes only the current Git tree. */
export async function readCoopRecord(repo: GitRepository, settings: LocationSettings, input: z.infer<typeof CoopReadSchema>) {
  let path = input.pathKind === 'repository' ? toRecordPath(settings.repositoryDirectory, input.path) : input.path
  let snapshot = input.revision && repo.at ? await repo.at(input.revision) : await repo.snapshot()
  let textRecord = input.textRecord, directory = path.endsWith('/') && !textRecord
  const textPath = path.replace(/\/$/, '')
  const exists = async (at: GitSnapshot) => {
    if (directory) {
      if (path === 'dss-coop/') return true
      await loadPaths(repo, at, path)
      return [...at.files.keys()].some(key => key.startsWith(path))
    }
    if (!path.endsWith('/') && await repo.read(at, path) !== undefined) { textRecord = false; return true }
    const manifest = await readJson<{ chunks?: unknown }>(repo, at, textPath + '/manifest.json')
    if (Array.isArray(manifest?.chunks)) { textRecord = true; return true }
    if (textRecord) return false
    const prefix = textPath + '/'
    await loadPaths(repo, at, prefix)
    if ([...at.files.keys()].some(key => key.startsWith(prefix))) { path = prefix; directory = true; return true }
    return false
  }
  let archived = false
  if (!await exists(snapshot) && !input.revision && repo.at) {
    const taskId = /^dss-coop\/(?:tasks|status\/tasks)\/([^/]+)(?:\/|$)/.exec(path)?.[1]
    if (taskId) {
      const history = await readJson<{ sourceHead: string }>(repo, snapshot, 'dss-coop/history/' + taskId + '.json')
      if (history?.sourceHead) {
        snapshot = await repo.at(history.sourceHead)
        archived = true
        await exists(snapshot)
      }
    }
  }
  const repositoryPath = toRepositoryPath(settings.repositoryDirectory, path)
  const location = { path, repositoryPath, commit: snapshot.head, archived,
    url: repositoryUrl(settings.ownerRepo, snapshot.head, repositoryPath) }
  if (directory) {
    if (path === 'dss-coop/') {
      const directories = await childDirectories(repo, snapshot, path)
      return { ...location, directories, repositoryDirectories: directories.map(item => toRepositoryPath(settings.repositoryDirectory, item)) }
    }
    await loadPaths(repo, snapshot, path)
    const paths = [...snapshot.files.keys()].filter(item => item.startsWith(path)).sort()
    const pageSize = Math.min(input.limit, 100), page = paths.slice(input.offset, input.offset + pageSize)
    return { ...location, paths: page, repositoryPaths: page.map(item => toRepositoryPath(settings.repositoryDirectory, item)),
      nextOffset: input.offset + pageSize < paths.length ? input.offset + pageSize : null }
  }
  const text = textRecord ? await readText(repo, snapshot, textPath) : await repo.read(snapshot, path)
  if (text === undefined) throw new Error('No record at that path.')
  const end = input.offset + input.limit
  return { ...location, text: text.slice(input.offset, end), nextOffset: end < text.length ? end : null, characters: text.length }
}
