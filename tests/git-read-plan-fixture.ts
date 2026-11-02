import { buildSchema, graphql, GraphQLError } from 'graphql'

// Minimal official schema subset, executed by GraphQL's parser/validator. This
// is a transport fixture, never part of the published plugin.
const schema = buildSchema(`
  scalar GitObjectID
  interface GitObject { oid: GitObjectID! }
  type Blob implements GitObject { oid: GitObjectID!, byteSize: Int!, isBinary: Boolean, isTruncated: Boolean!, text: String }
  type TreeEntry { oid: GitObjectID!, type: String!, name: String!, object: GitObject }
  type Tree implements GitObject { oid: GitObjectID!, entries: [TreeEntry!]! }
  type Commit implements GitObject { oid: GitObjectID!, tree: Tree!, file(path: String!): TreeEntry }
  type Ref { target: GitObject }
  type Repository { ref(qualifiedName: String!): Ref, object(oid: GitObjectID!): GitObject }
  type RateLimit { cost: Int!, remaining: Int!, resetAt: String! }
  type Query { repository(owner:String!,name:String!): Repository, rateLimit: RateLimit! }
`)
interface Remote {
  head: string; branch: string;
  commits: Map<string, { tree: { sha: string } }>;
  trees: Map<string, Array<{ path: string; type: string; sha: string }>>;
  blobs: Map<string, string | Uint8Array>;
}
export async function readPlanResponse(remote: Remote, body: { query: string; variables: Record<string, string> }): Promise<Response> {
  const object = (sha: string): any => {
    const commit = remote.commits.get(sha)
    if (commit) return { __typename: 'Commit', oid: sha, tree: () => object(commit.tree.sha), file: ({ path }: { path: string }) => {
      let tree = commit.tree.sha, found: { path: string; type: string; sha: string } | undefined
      const parts = path.split('/')
      for (let i = 0; i < parts.length; i++) {
        found = remote.trees.get(tree)?.find(entry => entry.path === parts[i])
        if (!found || i < parts.length - 1 && found.type !== 'tree') throw new GraphQLError('Could not resolve file for path ' + path, { extensions: { type: 'NOT_FOUND' } })
        tree = found.sha
      }
      return { oid: found!.sha, name: found!.path, type: found!.type, object: () => object(found!.sha) }
    } }
    const children = remote.trees.get(sha)
    if (children) return { __typename: 'Tree', oid: sha, entries: () => children.map(entry => ({ oid: entry.sha, name: entry.path, type: entry.type, object: () => object(entry.sha) })) }
    const bytes = remote.blobs.get(sha)
    if (bytes !== undefined) {
      let text: string | null = null
      try { text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) text = null } catch {}
      return { __typename: 'Blob', oid: sha, byteSize: Buffer.byteLength(bytes), isBinary: text === null, isTruncated: false, text }
    }
    return null
  }
  const result = await graphql({ schema, source: body.query, variableValues: body.variables, rootValue: {
    repository: () => ({ ref: ({ qualifiedName }: { qualifiedName: string }) => qualifiedName === 'refs/heads/' + remote.branch && remote.head ? { target: () => object(remote.head) } : null,
      object: ({ oid }: { oid: string }) => object(oid) }),
    rateLimit: () => ({ cost: 1, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() }),
  } })
  return Response.json({ ...result, ...(result.errors ? { errors: result.errors.map(error => ({ ...error.toJSON(), type: error.extensions.type })) } : {}) })
}
