import type { CoopStore } from './cache.js'
import { loadPaths } from './repository-paths.js'
import type { GitChange, GitRepository, GitSnapshot } from './contracts.js'
import { digest, GitJournal, json, readJson, readText, textChanges } from './journal.js'
import { taskPath, type RoleAction, type RootTask } from './protocol.js'

interface ArchiveManifest {
  version: 1; taskId: string; sourceHead: string; recordsPath: string; recordsSha256: string
  sources: Array<{ path: string; sha: string; sha256: string }>
  status: string; title: string; coordinator: string
}
/** Sealing and cleanup are separate commits, separated by a confirmed immutable read. */
export class CoopFinalizer {
  constructor(private readonly repo: GitRepository, private readonly journal: GitJournal, private readonly cache: CoopStore) {}
  async finalize(snapshot: GitSnapshot, task: RootTask): Promise<boolean> {
    const prefix = taskPath(task.id) + '/'
    await loadPaths(this.repo, snapshot, prefix)
    for (const path of snapshot.files.keys()) {
      if (path.startsWith(prefix) && path.includes('/actions/') && path.endsWith('.json')) {
        const action = await readJson<RoleAction>(this.repo, snapshot, path)
        if (action?.state === 'active') return false
      }
    }
    const manifestPath = 'dss-coop/records/' + task.id + '/manifest.json'
    const manifest = await readJson<ArchiveManifest>(this.repo, snapshot, manifestPath)
    const paths = [...snapshot.files.keys()].filter(path => path.startsWith(prefix)).sort()
    const current = paths.map(path => [path, snapshot.files.get(path)!])
    const fingerprint = digest(json(current))
    const matches = manifest?.sources.length === paths.length && manifest.sources.every(source => snapshot.files.get(source.path) === source.sha)
    if (!manifest || !matches) {
      const recordsPath = 'dss-coop/records/' + task.id + '/versions/' + fingerprint + '/records'
      const sources: ArchiveManifest['sources'] = [], sections = ['# ' + task.title, '', '## Original request', await readText(this.repo, snapshot, task.originPath), '', '## Accepted goal', await readText(this.repo, snapshot, task.goalPath)]
      for (const path of paths) {
        const text = (await this.repo.read(snapshot, path))!
        sources.push({ path, sha: snapshot.files.get(path)!, sha256: digest(text) })
        if (path.includes('/parts/')) continue
        if (path.endsWith('/manifest.json')) sections.push('', '## ' + path.slice(0, -'/manifest.json'.length), '', await readText(this.repo, snapshot, path.slice(0, -'/manifest.json'.length)))
        else sections.push('', '## ' + path, '', text)
      }
      const records = sections.join('\n')
      const sealed: ArchiveManifest = { version: 1, taskId: task.id, sourceHead: snapshot.head, recordsPath, recordsSha256: digest(records),
        sources, status: task.status, title: task.title, coordinator: task.coordinatorParticipantId }
      await this.journal.transact('seal-' + task.id + '-' + fingerprint.slice(0, 12), { taskId: task.id, fingerprint }, async head => {
        for (const [path, sha] of current) if (head.files.get(path) !== sha) throw new Error('Task records changed while sealing; read the new snapshot.')
        const changes: GitChange[] = [...textChanges(recordsPath, records), { path: manifestPath, content: json(sealed) }]
        if (Buffer.byteLength(records) <= 4 * 1024 * 1024) changes.push({ path: 'dss-coop/records/' + task.id + '/records.md', content: records })
        else changes.push({ path: 'dss-coop/records/' + task.id + '/records.md', content: '# ' + task.title + '\n\nFull text is stored in the lossless chunks identified by manifest.json.\n' })
        return changes
      })
      return true
    }
    const records = await readText(this.repo, snapshot, manifest.recordsPath)
    if (digest(records) !== manifest.recordsSha256) throw new Error('The sealed task records do not match their manifest.')
    for (const source of manifest.sources) if (digest((await this.repo.read(snapshot, source.path))!) !== source.sha256) throw new Error('The task changed after sealing: ' + source.path)
    await this.journal.transact('cleanup-' + task.id + '-' + fingerprint.slice(0, 12), { taskId: task.id, fingerprint }, async head => {
      if (head.files.get(manifestPath) !== snapshot.files.get(manifestPath)
        || [...head.files.keys()].filter(path => path.startsWith(prefix)).length !== paths.length
        || paths.some(path => head.files.get(path) !== snapshot.files.get(path))) throw new Error('Task records changed after sealing; reseal the updated snapshot.')
      return [...paths.map(path => ({ path, content: null })), { path: 'dss-coop/history/' + task.id + '.json',
        content: json({ id: task.id, title: task.title, status: task.status, coordinator: task.coordinatorParticipantId, manifestPath, sourceHead: manifest.sourceHead, recordsPath: manifest.recordsPath }) }]
    })
    return true
  }
}
