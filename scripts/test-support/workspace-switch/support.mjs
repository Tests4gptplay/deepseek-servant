import test from 'node:test'
import { readFileSync } from 'node:fs'
import { sourceRoot, loaded, hash, evidence } from '../dsh-sdk-runtime.mjs'

export function currentSource(name) {
  const relative = 'framework/' + name + '.ts'
  const source = readFileSync(new URL(relative, sourceRoot), 'utf8')
  loaded.set(relative, hash(source))
  return source
}
export function emitEvidence(kind, values) {
  console.log(JSON.stringify({ kind, values }))
}
test.after(() => console.log(JSON.stringify({
  kind: 'workspace-switch-test-provenance', ...evidence(),
  limits: 'Current project methods, Local filesystem, SDK, GitAuthority and controlled Git CAS. Native/service ports are controlled. No historical source implementation, Windows, live remote, complete DSH or full typecheck.',
})))
