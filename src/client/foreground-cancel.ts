import type { FrameworkClientApi, FrameworkClientView } from '../framework/client-contracts.js'

/** Stop targets the serving Host's current native binding, not display history. */
export async function cancelForeground(api: FrameworkClientApi, view: FrameworkClientView): Promise<void> {
  if (view.storageScope === undefined) return
  await api.cancelForeground({ mode: view.activeMode, storageScope: view.storageScope })
}
