import { GitHubError, type GitHubSession } from './github.js'

/** Explicit, operation-local demand. Directories never imply recursive bodies. */
export interface GitReadPlan { files?: readonly string[]; directories?: readonly string[]; signal?: AbortSignal; isolatePathErrors?: boolean }
export interface PlannedEntry { oid: string; type: 'blob' | 'tree' | 'commit'; object?: {
  oid: string; byteSize?: number; isBinary?: boolean | null; isTruncated?: boolean; text?: string | null;
  entries?: Array<{ name: string; type: 'blob' | 'tree' | 'commit'; oid: string; object?: { byteSize?: number } | null }>;
} | null }
export interface PathDemand { path: string; body: boolean }
const oid = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
export class GitRefNotResolvedError extends Error {}

/** All paths are children of ONE resolved Commit, including absent paths. */
export async function readPlan(session: GitHubSession, repository: string, branch: string, revision: string | undefined,
  demands: readonly PathDemand[], isolatePathErrors = false): Promise<{ head: string; tree: string; entries: Array<PlannedEntry | null | GitHubError> }> {
  const [owner, name] = repository.split('/')
  const variables: Record<string, string> = { owner, name, ref: revision ?? 'refs/heads/' + branch }
  const declarations = ['$owner:String!', '$name:String!', revision ? '$ref:GitObjectID!' : '$ref:String!']
  const fields = demands.map((demand, i) => {
    variables['p' + i] = demand.path; declarations.push('$p' + i + ':String!')
    const selection = demand.body ? '... on Blob { oid byteSize isBinary isTruncated text }'
      : '... on Tree { oid entries { name type oid object { ... on Blob { byteSize } } } }'
    return `p${i}:file(path:$p${i}) { oid type object { ${selection} } }`
  }).join(' ')
  const commit = `... on Commit { oid tree { oid } ${fields} }`
  const target = revision ? `object(oid:$ref) { ${commit} }` : `ref(qualifiedName:$ref) { target { ${commit} } }`
  const query = `query DSSReadPlan(${declarations.join(',')}) { repository(owner:$owner,name:$name) { ${target} } rateLimit { cost remaining resetAt } }`
  type Commit = { oid?: string; tree?: { oid?: string }; [key: string]: unknown }
  const result = await session.request<{ data?: { repository?: { object?: Commit | null; ref?: { target?: Commit | null } | null } | null };
    errors?: Array<{ type?: string; message: string; path?: Array<string | number> }> }>('POST', '/graphql', { query, variables })
  const value = revision ? result.data?.repository?.object : result.data?.repository?.ref?.target
  const parent = revision ? ['repository', 'object'] : ['repository', 'ref', 'target']
  // Only exact Commit.file NOT_FOUND/null denotes absence. A named field's
  // ordinary failure can retain its consumer boundary; root/authority errors
  // still reject the whole query and never trigger another transport route.
  const failures = new Map<number, string[]>()
  for (const error of result.errors ?? []) {
    const alias = error.path?.[parent.length], index = typeof alias === 'string' && /^p\d+$/.test(alias) ? Number(alias.slice(1)) : -1
    const located = index >= 0 && index < demands.length && alias === 'p' + index && value && Object.hasOwn(value, alias)
      && JSON.stringify(error.path?.slice(0, parent.length)) === JSON.stringify(parent)
    if (located && error.type === 'NOT_FOUND' && error.path?.length === parent.length + 1 && value[alias as string] === null) continue
    if (!isolatePathErrors || !located) throw new GitHubError(200, 'GitHub GraphQL read failed: ' + error.message)
    failures.set(index, [...(failures.get(index) ?? []), error.message])
  }
  if (revision === undefined && result.data?.repository?.ref === null && !result.errors?.length) throw new GitRefNotResolvedError('GitHub did not resolve this branch.')
  if (!oid(value?.oid) || !oid(value?.tree?.oid) || revision !== undefined && value.oid !== revision)
    throw new GitHubError(502, 'GitHub did not return the requested commit and tree.')
  const entries = demands.map((_, i) => {
    if (failures.has(i)) return new GitHubError(200, 'GitHub GraphQL read failed: ' + failures.get(i)!.join('; '))
    const entry = value['p' + i] as PlannedEntry | null | undefined
    if (entry === null) return null
    if (!entry || !oid(entry.oid) || !['blob', 'tree', 'commit'].includes(entry.type)) {
      const error = new GitHubError(502, 'GitHub returned an incomplete file entry.')
      if (isolatePathErrors) return error
      throw error
    }
    return entry
  })
  return { head: value.oid, tree: value.tree.oid, entries }
}
