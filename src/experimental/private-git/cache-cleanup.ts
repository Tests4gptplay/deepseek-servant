import type { CoopStore } from './cache.js'
import type { RoleBinding, UserIntent } from './contracts.js'
import { digest } from './journal.js'
import { actionPath, executionPath, taskPath, type LocalGrant, type RoleAction } from './protocol.js'

export interface CacheCleanupResult { removed: number; failed: Array<{ key: string; message: string }> }
export interface ConsumedInput {
  id: string; participantId: string; instanceId: string; createdAt: string; textHash: string
}

async function removeKeys(cache: CoopStore, keys: Iterable<string>): Promise<CacheCleanupResult> {
  const result: CacheCleanupResult = { removed: 0, failed: [] }
  for (const key of new Set(keys)) {
    try { await cache.remove(key); result.removed++ }
    catch (error) { result.failed.push({ key, message: error instanceof Error ? error.message : String(error) }) }
  }
  return result
}

/** Scope changes release derived copies only. Pending input and consumption progress remain owned by their original scope. */
export async function releaseScopeCaches(cache: CoopStore): Promise<CacheCleanupResult> {
  const prefixes = ['message-header/', 'message-view/', 'read-error/', 'native-error/']
  return removeKeys(cache, cache.entries('').map(([key]) => key).filter(key =>
    key === 'projection' || key === 'settings-confirmed' || key === 'runtime-error' || prefixes.some(prefix => key.startsWith(prefix))))
}

/** Call after a Git snapshot confirms this action. These are transaction retry copies, not authority records. */
export async function releaseConfirmedActionCaches(cache: CoopStore, actions: readonly RoleAction[]): Promise<CacheCleanupResult> {
  const keys = new Set<string>(), executions = new Set(actions.map(action => action.binding.executionId))
  for (const action of actions) {
    const path = actionPath(action.binding)
    if (cache.get('staged/' + path) !== undefined) keys.add('staged/' + path)
    const transition = cache.get<RoleAction>('transition/' + path)
    if (transition?.binding.executionId === action.binding.executionId && transition.state === action.state) keys.add('transition/' + path)
    if (action.state === 'closed') {
      keys.add('native-error/' + action.id)
      keys.add('read-error/' + path)
    }
  }
  for (const [key, replacement] of cache.entries<RoleAction>('replacement/')) {
    if (executions.has(replacement.binding.executionId)) keys.add(key)
  }
  return removeKeys(cache, keys)
}

/** Save the small consumed identity before discarding the potentially large local input body. */
export async function consumeInputCache(cache: CoopStore, input: UserIntent): Promise<void> {
  const previous = cache.get<ConsumedInput>('consumed-input/' + input.id)
  if (!previous) await cache.put('consumed-input/' + input.id, {
    id: input.id, participantId: input.participantId, instanceId: input.instanceId, createdAt: input.createdAt, textHash: digest(input.text),
  } satisfies ConsumedInput)
}

/** Called only for a confirmed closed foreground input after its native owner has settled. */
export async function releaseInputCaches(cache: CoopStore, binding: RoleBinding): Promise<CacheCleanupResult> {
  const id = binding.sourceIntentId
  if (!id) return { removed: 0, failed: [] }
  const input = cache.get<UserIntent>('user-source/' + id)
  if (input) await consumeInputCache(cache, input)
  if (!cache.get<ConsumedInput>('consumed-input/' + id)) return { removed: 0, failed: [] }
  const keys = ['user-confirmed/' + id]
  const referenced = cache.entries<LocalGrant>('grant/').some(([, grant]) => grant.sourceIntentId === id)
  const pending = cache.drafts().some(draft => draft.id === id || (draft.payload as { binding?: RoleBinding })?.binding?.sourceIntentId === id)
  if (!pending) keys.push('user-source/' + id)
  // Remove legacy retry bookkeeping after its Git record has settled.
  if (!referenced && !pending) {
    keys.push('admission/' + actionPath(binding))
    for (const prefix of ['proof/', 'read-error/']) {
      for (const [key] of cache.entries(prefix + executionPath(binding) + '/')) keys.push(key)
    }
  }
  return removeKeys(cache, keys)
}

/** A confirmed archive has replaced exactly this task's hot Git records. Other tasks and shared history stay untouched. */
export async function releaseArchivedTaskCaches(cache: CoopStore, taskId: string): Promise<CacheCleanupResult> {
  const path = taskPath(taskId) + '/', grant = cache.get<LocalGrant>('grant/' + taskId)
  const keys = new Set<string>()
  for (const prefix of ['proof/', 'admission/', 'staged/', 'transition/', 'read-error/']) {
    for (const [key] of cache.entries(prefix + path)) keys.add(key)
  }
  for (const [key, action] of cache.entries<RoleAction>('replacement/')) if (action.binding.taskId === taskId) keys.add(key)
  const result = await removeKeys(cache, keys)
  // Keep the existing task pointer until its deletions finish, so a later normal
  // consume can retry exact leftovers without a new scanner or cleanup queue.
  if (!result.failed.length) {
    const released = await removeKeys(cache, ['grant/' + taskId])
    result.removed += released.removed; result.failed.push(...released.failed)
  }
  if (grant?.sourceIntentId && !cache.get('grant/' + taskId)) {
    const input = cache.get<UserIntent>('user-source/' + grant.sourceIntentId)
    if (input) await consumeInputCache(cache, input)
    const referenced = cache.entries<LocalGrant>('grant/').some(([, other]) => other.sourceIntentId === grant.sourceIntentId)
    const pending = cache.drafts().some(draft => draft.id === grant.sourceIntentId || (draft.payload as { binding?: RoleBinding })?.binding?.sourceIntentId === grant.sourceIntentId)
    if (!referenced && !pending && cache.get('consumed-input/' + grant.sourceIntentId)) {
      const released = await removeKeys(cache, ['user-source/' + grant.sourceIntentId, 'user-confirmed/' + grant.sourceIntentId])
      result.removed += released.removed; result.failed.push(...released.failed)
    }
  }
  return result
}
