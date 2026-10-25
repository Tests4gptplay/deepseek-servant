import { readFileSync } from 'node:fs'

export type SemanticRole = 'foreground' | 'planner' | 'worker'

declare const __SERVANT_ROLE_TEXTS__: Record<SemanticRole, string> | undefined

const sourcePaths: Record<SemanticRole, URL> = {
  foreground: new URL('./foreground.md', import.meta.url),
  planner: new URL('./planner.md', import.meta.url),
  worker: new URL('./worker.md', import.meta.url),
}

/** Bundle embeds exactly the checked-in role contracts; source tests read the same files. */
export function rolePrompt(role: SemanticRole): string {
  if (typeof __SERVANT_ROLE_TEXTS__ !== 'undefined') return __SERVANT_ROLE_TEXTS__![role]
  return readFileSync(sourcePaths[role], 'utf8')
}

/** Bindings are supplied separately by the host; prompts never grant themselves authority. */
export function roleInput(_role: SemanticRole, input: unknown): string {
  // The role contract is already installed in the native system prompt.
  return `## Current bound input\n\n${JSON.stringify(input, null, 2)}`
}
