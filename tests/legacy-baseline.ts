/** Test-only historical producers. No old implementation is imported from the
 * current source tree or emitted into a production package. All relative module
 * resolution is pinned to this immutable Git object, including test fixtures. */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { build } from 'esbuild'
import type { StoragePort } from '../src/contracts/ports.js'
import type { ActionKind, ChildSpec, CommandSource, CommandReceipt, ExecutionBinding, PendingAction, Task, TaskCommand } from '../src/contracts/task.js'
import type { ConversationMessage } from '../src/contracts/assistant.js'
import type { KnowledgeEvidenceResolver, KnowledgeMutationReceipt, KnowledgeScope, Preference, ProjectFact, ProposeSkillInput, SkillRecord, ValidateSkillInput } from '../src/contracts/knowledge.js'
import type { RecordJournal } from '../src/application/record-journal.js'

export const LEGACY_TEST_BASELINE = '0acd3ba39a2ae23d66759279b3c54c4637cd0ad5'
const root = process.cwd(), sourceCache = new Map<string, string>()
export function readBaselineSource(path: string): string {
  if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '..') || path.includes('\\')) throw new Error('Baseline source must use a repository-relative path.')
  let source = sourceCache.get(path)
  if (source === undefined) {
    source = execFileSync('git', ['show', LEGACY_TEST_BASELINE + ':' + path], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    sourceCache.set(path, source)
  }
  return source
}
export async function loadBaselineModule<T>(entryPath: string, sourceOverride?: string): Promise<T> {
  const entry = resolve(root, entryPath)
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', plugins: [{ name: 'immutable-legacy-test-source', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return { path: entry, namespace: 'baseline' }
      if (!args.path.startsWith('.')) return { path: args.path, external: true }
      return { path: resolve(dirname(args.importer), args.path).replace(/\.js$/, '.ts'), namespace: 'baseline' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'baseline' }, args => ({ loader: 'ts', contents: args.path === entry && sourceOverride !== undefined ? sourceOverride : readBaselineSource(relative(root, args.path)) }))
  } }] })
  const module = { exports: {} as T }
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports)
  return module.exports
}
interface BaselineStorage extends StoragePort {
  data: Map<string, unknown>
  writes: Array<{ key: string; value: unknown }>
  fail?: (key: string, value: unknown) => boolean
  delete(key: string): Promise<void>
}
export interface BaselineFixture {
  storage: BaselineStorage
  store: { journal: RecordJournal; getTask(id: string): Promise<Task | undefined>; putTask(task: Task, previous?: Task): Promise<void> }
  get(): Promise<Task>
  execute(command: Omit<TaskCommand, 'commandId' | 'source'> & Record<string, unknown>, source?: CommandSource, commandId?: string): Promise<CommandReceipt>
  bind(kind: ActionKind, childId?: string): Promise<{ source: CommandSource; execution: ExecutionBinding; action: PendingAction }>
  runtime: { kind: 'runtime'; id: string }
}
interface BaselineKnowledge {
  proposeSkill(input: ProposeSkillInput): Promise<KnowledgeMutationReceipt>
  validateSkill(input: ValidateSkillInput): Promise<KnowledgeMutationReceipt>
  getSkill(id: string, scope: KnowledgeScope): Promise<SkillRecord | undefined>
  getSkillBody(name: string, scope: KnowledgeScope, expectedVersion?: number): Promise<string | undefined>
  putProjectFact(input: { id: string; scope: KnowledgeScope; text: string; sourceResultId: string; expectedRevision?: number }): Promise<ProjectFact>
  putPreference(input: { id: string; scope: KnowledgeScope; text: string; applicability: string; userSourceRef: string; expectedRevision?: number }): Promise<Preference>
}
interface BaselineConversationEntry extends ConversationMessage { assistantId: string; sessionId: string; source: string; at: string; date: string; timeZone: string; ref: string; order: number }
interface BaselineConversation {
  append(assistantId: string, sessionId: string, message: ConversationMessage): Promise<BaselineConversationEntry>
  complete(assistantId: string, sessionId: string, turn: number, messages: ConversationMessage[], at: string): Promise<void>
  page(assistantId: string, before?: string, limit?: number, date?: string): Promise<{ messages: BaselineConversationEntry[]; before?: string }>
  seed(assistantId: string): Promise<ConversationMessage[][]>
}
const baseline = await loadBaselineModule<{
  fixture(request?: string): Promise<BaselineFixture>
  childSpec(id?: string, dependsOn?: string[]): ChildSpec
  KnowledgeService: new (options: { store: StoragePort; evidence: KnowledgeEvidenceResolver; now?: () => string; onChanged?: () => void }) => BaselineKnowledge
  ConversationStore: new (storage: StoragePort, timeZone?: string, now?: () => string) => BaselineConversation
}>('tests/legacy-baseline-entry.ts', `
export { fixture, childSpec } from './task-fixture.js'
export { KnowledgeService } from '../src/application/knowledge-service.js'
export { ConversationStore } from '../src/application/conversation-store.js'
`)
export const baselineFixture = baseline.fixture
export const baselineChildSpec = baseline.childSpec
export const BaselineKnowledgeService = baseline.KnowledgeService
export const BaselineConversationStore = baseline.ConversationStore
