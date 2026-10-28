import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoopSettingsSchema, type CoopSettings, type PendingDraft, type RepoConnection } from '../src/experimental/private-git/contracts.js'
import type { CoopStore } from '../src/experimental/private-git/cache.js'
import type { CoopCredentials } from '../src/experimental/private-git/credentials.js'
import { GitHubClient } from '../src/experimental/private-git/github.js'
import { GitHubRepository } from '../src/experimental/private-git/git-repository.js'
import { CoopService } from '../src/experimental/private-git/service.js'
import { runGit } from '../src/experimental/private-git/vendor/git-runner.js'
import { CoopFinalizer } from '../src/experimental/private-git/finalizer.js'
import { GitJournal, json, textChanges } from '../src/experimental/private-git/journal.js'
import { CoopReadSchema, readCoopRecord } from '../src/experimental/private-git/record-access.js'
import { toRepositoryPath, toRecordPath } from '../src/experimental/private-git/repository-paths.js'
import type { RootTask } from '../src/experimental/private-git/protocol.js'

class Store implements CoopStore {
  readonly instanceId = 'fixture'
  readonly values = new Map<string, unknown>()
  settings: CoopSettings
  constructor(directory: string) { this.settings = CoopSettingsSchema.parse({ ownerRepo: 'example/private', repositoryDirectory: directory }) }
  async configure(settings: CoopSettings) { this.settings = settings }
  get<T>(key: string) { return this.values.get(key) as T | undefined }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)) }
  async remove(key: string) { this.values.delete(key) }
  entries<T>(prefix: string) { return [...this.values].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]> }
  connection() { return this.get<RepoConnection>('connection') }
  drafts() { return this.entries<PendingDraft>('draft/').map(([, value]) => value) }
  async close() {}
}

test('Git directory settings accept root aliases and ordinary subdirectory paths', () => {
  for (const input of ['', ' ', '.', './', '/', '\\']) assert.equal(CoopSettingsSchema.parse({ repositoryDirectory: input }).repositoryDirectory, '', input)
  for (const input of ['Maid', './Maid', '/Maid/', 'Maid//', 'Maid/./']) assert.equal(CoopSettingsSchema.parse({ repositoryDirectory: input }).repositoryDirectory, 'Maid', input)
  for (const input of ['Maid/Notes', './Maid/Notes/', 'Maid\\Notes']) assert.equal(CoopSettingsSchema.parse({ repositoryDirectory: input }).repositoryDirectory, 'Maid/Notes', input)
  assert.equal(CoopSettingsSchema.parse({}).repositoryDirectory, 'dss-coop')
  for (const directory of ['', 'dss-coop', 'Maid/Notes', 'dss-coop/Notes']) {
    const ref = 'dss-coop/records/task one/manifest.json'
    assert.equal(toRecordPath(directory, toRepositoryPath(directory, ref)), ref)
  }
})

for (const directory of ['Maid/Notes', '']) for (const populated of [false, true]) {
  test('connecting initializes ' + (directory || 'repository root') + ' in ' + (populated ? 'an existing repository' : 'an empty repository'), async t => {
    const root = await mkdtemp(join(tmpdir(), 'dss-git-initialize-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const remote = join(root, 'remote.git'), seed = join(root, 'seed'), caches = join(root, 'cache')
    await mkdir(remote); await mkdir(seed)
    const git = async (cwd: string, args: string[]) => (await runGit('git', args, { cwd })).stdout.trim()
    await git(remote, ['init', '--bare', '--initial-branch=main', '.'])
    if (populated) {
      await git(seed, ['init', '--initial-branch=main', '.'])
      await writeFile(join(seed, 'README.md'), '# Existing owner notes\n\nKeep this content.\n')
      await git(seed, ['add', 'README.md'])
      await git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Existing content'])
      await git(seed, ['push', remote, 'HEAD:refs/heads/main'])
    }
    const store = new Store(directory)
    const scope = store.settings.ownerRepo + '/' + directory + '/' + store.instanceId
    const cache = join(caches, createHash('sha256').update(scope).digest('hex').slice(0, 24))
    await mkdir(cache, { recursive: true })
    await git(cache, ['init', '--bare', '.'])
    await git(cache, ['remote', 'add', 'origin', remote])
    const tokens = async () => ({ value: 'local-fixture', source: 'fixture' })
    const client = new GitHubClient(tokens, async url => {
      const path = new URL(url).pathname
      if (path === '/user') return Response.json({ id: 1, login: 'fixture' })
      if (path === '/repos/example/private') return Response.json({ id: 77, full_name: 'example/private', private: true, default_branch: 'main', permissions: { pull: true, push: true, admin: true } })
      throw new Error('Unexpected network route: ' + path)
    })
    const repository = new GitHubRepository(client, () => ({ ownerRepo: store.settings.ownerRepo, repositoryDirectory: store.settings.repositoryDirectory, instanceId: store.instanceId }), tokens, caches)
    const credentials = { describe: async () => ({ configured: true, writable: false }) } as unknown as CoopCredentials
    const service = new CoopService(store, credentials, client)
    Object.defineProperty(service, 'repository', { value: repository })
    await service.connect()
    const snapshot = await repository.snapshot()
    assert.ok(snapshot.head)
    const readme = (await repository.read(snapshot, 'dss-coop/README.md'))!
    assert.match(readme, /DSS-cah/)
    assert.ok(readme.includes('`' + (directory ? directory + '/' : '') + 'inbox/`'))
    const status = JSON.parse((await repository.read(snapshot, 'dss-coop/instances/fixture/status.json'))!)
    assert.equal(status.workerSeats, 2)
    assert.equal(status.instanceId, 'fixture')
    if (populated) assert.match(await git(remote, ['show', 'main:README.md']), /Keep this content/)
    await repository.list(snapshot, 'dss-coop/')
    assert.ok(snapshot.files.has('dss-coop/README.md'))
    assert.ok((await repository.directories(snapshot, 'dss-coop/')).includes('dss-coop/instances/'))
    await service.connect()
    assert.equal((await repository.snapshot()).head, snapshot.head, 'reconnecting does not duplicate initialization')
    await repository.commit(snapshot, [{ path: 'dss-coop/inbox/task.md', content: 'A normal task.' }], 'Submit task')
    const next = await repository.snapshot()
    assert.equal(await repository.read(next, 'dss-coop/inbox/task.md'), 'A normal task.')
    assert.deepEqual((await repository.changes(next, snapshot.head)).map(change => ({ path: change.path, status: change.status })), [{ path: 'dss-coop/inbox/task.md', status: 'A' }])
    assert.ok((await repository.changes(next, '')).some(change => change.path === 'dss-coop/inbox/task.md'))
    const task = { id: 'archive-path', title: 'Archived path fixture', status: 'accepted', coordinatorParticipantId: '1',
      originPath: 'dss-coop/origins/archive-path/request', goalPath: 'dss-coop/origins/archive-path/goal/1' } as RootTask
    const acceptance = 'dss-coop/tasks/archive-path/acceptance.json', memory = 'dss-coop/tasks/archive-path/executions/planner/memory'
    await repository.commit(next, [
      ...textChanges(task.originPath, 'Original request'), ...textChanges(task.goalPath, 'Accepted goal'),
      { path: 'dss-coop/tasks/archive-path/contract.json', content: json(task) },
      { path: acceptance, content: json({ accepted: true }) }, ...textChanges(memory, 'Complete planner evidence'),
    ], 'Record accepted task')
    const finalizer = new CoopFinalizer(repository, new GitJournal(repository, '1'), store)
    await finalizer.finalize(await repository.snapshot(), task)
    await finalizer.finalize(await repository.snapshot(), task)
    const cleaned = await repository.snapshot()
    assert.equal(await repository.read(cleaned, acceptance), undefined, 'the runtime still sees the cleaned task tree')
    const history = JSON.parse((await repository.read(cleaned, 'dss-coop/history/archive-path.json'))!)
    const archive = JSON.parse(await git(remote, ['show', 'main:' + history.repositoryPaths.manifest]))
    assert.equal(archive.recordsPath, history.recordsPath)
    assert.match(await git(remote, ['show', 'main:' + history.repositoryPaths.summary]), /Complete planner evidence/)
    assert.ok(await git(remote, ['show', 'main:' + history.repositoryPaths.text + '/manifest.json']))
    assert.ok(readme.includes('repositoryPaths'))
    for (const pathKind of ['record', 'repository'] as const) {
      const path = pathKind === 'record' ? acceptance : toRepositoryPath(directory, acceptance)
      const read = await readCoopRecord(repository, store.settings, CoopReadSchema.parse({ path, pathKind }))
      assert.equal(read.archived, true)
      assert.equal(read.commit, archive.sourceHead)
      assert.equal(read.repositoryPath, toRepositoryPath(directory, acceptance))
      assert.equal(JSON.parse(read.text!).accepted, true)
      assert.ok(await git(remote, ['show', read.commit + ':' + read.repositoryPath]))
    }
    const text = await readCoopRecord(repository, store.settings, CoopReadSchema.parse({ path: memory, textRecord: true, offset: 9, limit: 7 }))
    assert.equal(text.text, 'planner')
    assert.equal(text.nextOffset, 16)
    const automaticText = await readCoopRecord(repository, store.settings, CoopReadSchema.parse({ path: memory }))
    assert.equal(automaticText.text, 'Complete planner evidence')
    const directPart = await readCoopRecord(repository, store.settings, CoopReadSchema.parse({ path: memory + '/parts/000000.txt', textRecord: true }))
    assert.equal(directPart.text, 'Complete planner evidence')
    const automaticDirectory = await readCoopRecord(repository, store.settings, CoopReadSchema.parse({ path: 'dss-coop/tasks/archive-path' }))
    assert.ok(automaticDirectory.paths?.includes(acceptance))
    const archiveDirectory = await readCoopRecord(repository, store.settings, CoopReadSchema.parse({ path: 'dss-coop/records/archive-path' }))
    assert.ok(archiveDirectory.paths?.includes('dss-coop/records/archive-path/manifest.json'))
    const listing = await readCoopRecord(repository, store.settings, CoopReadSchema.parse({ path: 'dss-coop/tasks/archive-path/' }))
    assert.ok(listing.paths?.includes(acceptance))
    assert.ok(listing.repositoryPaths?.includes(toRepositoryPath(directory, acceptance)))
    await assert.rejects(readCoopRecord(repository, store.settings, CoopReadSchema.parse({ path: acceptance, revision: cleaned.head })), /No record/)
  })
}
