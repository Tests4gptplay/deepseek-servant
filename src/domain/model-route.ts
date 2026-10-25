import type { Assistant } from '../contracts/assistant.ts'
import type { ModelRoute, RuntimeProfile } from '../contracts/task.ts'

/** An empty route is Auto, following the main DSH composer's current selection. */
export function isAutoModel(route: ModelRoute): boolean { return !route.provider && !route.model }
export function resolveModelRoute(route: ModelRoute, current?: ModelRoute): ModelRoute {
  return { ...(isAutoModel(route) ? current ?? {} : route) }
}
export function assistantRuntimeProfile(assistant: Assistant): RuntimeProfile {
  return { version: String(assistant.revision), presetId: assistant.settings.presetId,
    foreground: resolveModelRoute(assistant.settings.foreground, assistant.autoModel),
    background: resolveModelRoute(assistant.settings.background, assistant.autoModel) }
}
