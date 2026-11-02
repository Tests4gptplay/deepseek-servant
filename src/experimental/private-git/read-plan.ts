import { GitHubError, type GitHubSession } from './github.js'

/** Explicit, operation-local demand. Directories never imply recursive bodies. */
export interface GitReadPlan { files?: readonly string[]; directories?: readonly string[] }
export interface PlannedEntry { oid: string; type: 'blob' | 'tree' | 'commit'; object?: {
  oid: string; byteSize?: number; isBinary?: boolean | null; isTruncated?: boolean; text?: string | null;
  entries?: Array<{ name: string; type: 'blob' | 'tree' | 'commit'; oid: string; object?: { byteSize?: number } | null }>;
} | null }
export interface PathDemand { path: string; body: boolean }
const oid = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
export class GitRefNotResolvedError extends Error {}

/** All paths are children of ONE resolved Commit, including absent paths. */
export async function readPlan(session: GitHubSession, repository: string, branch: string, revision: string | undefined,
  demands: readonly PathDemand[]): Promise<{ head: string; tree: string; entries: Array<PlannedEntry | null> }> {
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
  // GitHub returns field-local NOT_FOUND for an absent Commit.file. Neither a
  // null repository/commit nor an untyped/partial/error response means absence.
  for (const error of result.errors ?? []) {
    const alias = error.path?.at(-1), index = typeof alias === 'string' && /^p\d+$/.test(alias) ? Number(alias.slice(1)) : -1
    if (error.type !== 'NOT_FOUND' || index < 0 || index >= demands.length || !value || value[alias as string] !== null
      || JSON.stringify(error.path?.slice(0, -1)) !== JSON.stringify(parent)) {
      throw new GitHubError(200, 'GitHub GraphQL read failed: ' + error.message)
    }
  }
  if (revision === undefined && result.data?.repository?.ref === null && !result.errors?.length) throw new GitRefNotResolvedError('GitHub did not resolve this branch.')
  if (!oid(value?.oid) || !oid(value?.tree?.oid) || revision !== undefined && value.oid !== revision)
    throw new GitHubError(502, 'GitHub did not return the requested commit and tree.')
  const entries = demands.map((_, i) => {
    const entry = value['p' + i] as PlannedEntry | null | undefined
    if (entry === null) return null
    if (!entry || !oid(entry.oid) || !['blob', 'tree', 'commit'].includes(entry.type))
      throw new GitHubError(502, 'GitHub returned an incomplete file entry.')
    return entry
  })
  return { head: value.oid, tree: value.tree.oid, entries }
}
