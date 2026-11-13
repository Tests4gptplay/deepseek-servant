// Audit-only adaptation of source/scripts/w129/real-git-cli-fixture.mjs.
// Explicit create/open preserves existing HEAD on restart. afterPush observes actual successful update-ref CAS.
// Audit transport uses asynchronous real git child processes; no I/O errors or acknowledgments are fabricated.
import assert from 'node:assert/strict'
import {execFileSync,execFile} from 'node:child_process'
import {devNull} from 'node:os'
const src = new URL('../../src/', import.meta.url)
const {GitFiles} = await import(new URL('framework/transactions.ts',src))
const {SessionGitOperations} = await import(new URL('framework/git-authority.ts',src))
const {RemoteGitRepository} = await import(new URL('experimental/private-git/remote-git-repository.ts',src))
const {GitBackendError} = await import(new URL('experimental/private-git/git-object-backend.ts',src))
function gitFixture(directory, objectFormat, {create, beforeExecute=async()=>{}, afterPush=async()=>{}}) {
  if(create) execFileSync('git', ['init', '--bare', '--quiet', '--object-format=' + objectFormat, directory])
  const git = (args, input) => execFileSync('git', ['--git-dir=' + directory, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_AUTHOR_NAME: 'Recovery fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Recovery fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })
  if(create){
    const tree=git(['mktree'],'').toString().trim(),initial=git(['commit-tree',tree],'Initial fixture\n').toString().trim();git(['update-ref','refs/heads/main',initial])
  }else{assert.equal(git(['rev-parse','--is-bare-repository']).toString().trim(),'true');git(['rev-parse','refs/heads/main'])}
  const gitAsync = (args,input) => new Promise((resolve,reject)=>{
    const child=execFile('git',['--git-dir='+directory,...args],{encoding:'buffer',env:{...process.env,
      GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:devNull,GIT_AUTHOR_NAME:'Recovery fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
      GIT_COMMITTER_NAME:'Recovery fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}},(error,stdout)=>error?reject(error):resolve(stdout))
    child.stdin.end(input)
  })
  const events=[]
  class Backend {
    constructor(channel) { this.channel = channel }
    closed = false; ids = new Set()
    async ready() {}
    async release() { this.closed = true }
    async storageBytes() {let bytes=0;for(const id of this.ids)bytes+=Number(await gitAsync(['cat-file','-s',id]));return bytes}
    async metadata(id) {
      this.ids.add(id); const commit = (await gitAsync(['cat-file', 'commit', id])).toString(), root = commit.match(/^tree (\w+)/)[1]
      const visit = async id => { this.ids.add(id); for (const line of (await gitAsync(['ls-tree', '-z', id])).toString().split('\0').filter(Boolean)) {
        const m = line.match(/^\d+ (\w+) (\w+)\t/); if (m[1] === 'tree') await visit(m[2])
      } }; await visit(root)
    }
    async execute(command, { signal, input }) {
      signal.throwIfAborted(); assert.equal(this.closed, false); events.push({ op: command.op, kind: command.kind, id: command.id, channel: this.channel })
      await beforeExecute({ ...command, channel: this.channel }, signal)
      signal.throwIfAborted()
      if (command.op === 'fetchHead') { const id = (await gitAsync(['rev-parse', 'refs/heads/main'])).toString().trim(); await this.metadata(id); return Buffer.from(id) }
      if (command.op === 'fetchMetadata') { await this.metadata(command.revision); return Buffer.alloc(0) }
      if (command.op === 'ensureObjects') { for (const id of command.ids) { (await gitAsync(['cat-file', '-e', id])); this.ids.add(id) } return command.kind === 'commit' ? (await gitAsync(['rev-list', '--max-count=' + String(command.commitDepth ?? 1), ...command.ids])) : Buffer.alloc(0) }
      if (command.op === 'readObject') return (await gitAsync(['cat-file', command.kind, command.id]))
      if (command.op === 'readTree') return (await gitAsync(['ls-tree', '-z', command.id]))
      if (command.op === 'writeBlob' || command.op === 'writeTree') {
        const id = (await gitAsync(command.op === 'writeBlob' ? ['hash-object', '-t', 'blob', '-w', '--stdin'] : ['mktree', '-z'], input)).toString().trim(); this.ids.add(id); return Buffer.from(id)
      }
      if (command.op === 'writeCommit') {
        const message = String(input).replace(/\n?$/, '\n'), id = (await gitAsync(['commit-tree', command.tree, ...(command.parent ? ['-p', command.parent] : [])], message)).toString().trim()
        this.ids.add(id); return Buffer.from(JSON.stringify({ id, tree: command.tree, parents: command.parent ? [command.parent] : [], message, timestamp: command.timestamp }))
      }
      if (command.op === 'push') {
        try { (await gitAsync(['update-ref', command.ref, command.commit, command.expected || '0'.repeat(40)])) }
        catch { throw new GitBackendError('stale', 'Fixture real Git CAS conflict') }
        await afterPush({...command,channel:this.channel},signal)
        return Buffer.alloc(0)
      }
      throw Error('Unhandled real-object fixture command: ' + command.op)
    }
  }
  const repo = new RemoteGitRepository(() => ({ ownerRepo: 'fixture/recovery', branch: 'main', repositoryDirectory: 'dss-coop' }),
    async () => ({ value: 'unused-fixture', source: 'fixture' }), { remoteUrl: () => 'http://127.0.0.1:1/unused.git',
      inspectAuthority: async () => ({ identity: { id: 1, login: 'A' }, repository: { id: 1, fullName: 'fixture/recovery', branch: 'main', private: true, permissions: { pull: true, push: true, admin: false } } }) })
  const cache = repo.newCache.bind(repo); repo.newCache = (channel, transport) => cache(channel, transport ?? new Backend(channel))
  return { repo, files: new GitFiles(repo, new SessionGitOperations()), events, git }
}
export {gitFixture}
