import type { Assistant } from '../contracts/assistant.ts'
import type { ModelRoute, RuntimeProfile } from '../contracts/task.ts'

/** An empty background route follows the Servant foreground selection. */
export function isAutoModel(route: ModelRoute): boolean { return !route.provider && !route.model }
export function resolveModelRoute(route: ModelRoute, current?: ModelRoute): ModelRoute {
  return { ...(isAutoModel(route) ? current ?? {} : route) }
}
export function assistantRuntimeProfile(assistant: Assistant): RuntimeProfile {
  const foreground = resolveModelRoute(assistant.settings.foreground, assistant.autoModel)
  return { version: String(assistant.revision), presetId: assistant.settings.presetId,
    foreground, background: resolveModelRoute(assistant.settings.background, foreground) }
}
