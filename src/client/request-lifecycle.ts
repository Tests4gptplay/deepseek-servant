/** Forward lifecycle cancellation to the transport and settle the consumer even
 * if a carrier does not honour AbortSignal. Late receipts are observed but do
 * not change current UI state. There is no timeout or automatic replay. */
export function lifecycleRequest<T>(signals: readonly AbortSignal[], run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup: Array<() => void> = []
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return
      settled = true
      for (const stop of cleanup) stop()
      if (ok) resolve(value as T); else reject(value)
    }
    const interrupted = () => finish(false, controller.signal.reason)
    controller.signal.addEventListener('abort', interrupted, { once: true })
    cleanup.push(() => controller.signal.removeEventListener('abort', interrupted))
    for (const signal of signals) {
      const abort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      cleanup.push(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) { controller.abort(signal.reason); return }
    }
    try { Promise.resolve(run(controller.signal)).then(value => finish(true, value), error => finish(false, error)) }
    catch (error) { finish(false, error) }
  })
}

/** One request lifetime for this mounted client, independent of Host tasks. */
export function createRequestLifecycle() {
  let scope = new AbortController()
  let disposed = false
  const listeners = new Set<() => void>()
  const end = () => scope.abort(new Error('The client connection lifecycle ended.'))
  return {
    request<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return lifecycleRequest(signal ? [scope.signal, signal] : [scope.signal], operation)
    },
    reset: () => {
      if (disposed) return
      end()
      scope = new AbortController()
      for (const listener of listeners) listener()
    },
    subscribeReset: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: () => { disposed = true; end(); listeners.clear() },
  }
}
