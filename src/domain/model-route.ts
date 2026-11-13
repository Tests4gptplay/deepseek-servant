import type { ModelRoute } from '../contracts/task.ts'

/** An empty background route follows the Servant foreground selection. */
export function isAutoModel(route: ModelRoute): boolean { return !route.provider && !route.model }
