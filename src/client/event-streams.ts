import type { ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'

/** SSE performs its own ordinary network reconnection, but a non-200 response
 * or invalid content type permanently closes an EventSource. A new official
 * Connection generation must therefore replace the previous streams as well as
 * reread state. Errors alone never start an extra retry loop or replay a write. */
export function subscribeEventStreams<T = unknown>(
  paths: readonly string[], listener: (change?: T) => void, subscribeReset: (listener: () => void) => () => void,
  create: (url: URL) => EventSource = url => new EventSource(url),
  availability?: (available: boolean) => void,
  connectionState?: ConnectionStateSource,
): () => void {
  let disposed = false, generation = 0, carrierAvailable = false
  const reportAvailability = (value?: boolean) => {
    if (value !== undefined) carrierAvailable = value
    availability?.(carrierAvailable && (!connectionState || connectionState.getSnapshot() === 'connected'))
  }
  let streams: Array<{ source: EventSource; changed: EventListener; opened: () => void; failed: () => void; available: boolean }> = []
  const close = () => {
    generation++
    reportAvailability(false)
    for (const { source, changed, opened, failed } of streams) {
      source.removeEventListener('changed', changed)
      source.removeEventListener('open', opened)
      source.removeEventListener('error', failed)
      source.close()
    }
    streams = []
  }
  const open = () => {
    close()
    const current = generation
    try {
      for (const path of paths) {
        const source = create(new URL(path, document.baseURI))
        const changed: EventListener = event => {
          if (disposed || generation !== current) return
          let change: T | undefined
          try { change = JSON.parse((event as MessageEvent).data) as T } catch {}
          listener(change)
        }
        const item = { source, changed, opened: () => {}, failed: () => {}, available: false }
        item.opened = () => { if (disposed || generation !== current) return; item.available = true; reportAvailability(streams.every(value => value.available)); listener() }
        item.failed = () => { if (disposed || generation !== current) return; item.available = false; reportAvailability(false) }
        streams.push(item)
        source.addEventListener('changed', changed)
        source.addEventListener('open', item.opened)
        source.addEventListener('error', item.failed)
      }
    } catch (error) { close(); throw error }
  }
  open()
  const stopState = connectionState?.subscribe(() => { if (!disposed) reportAvailability() })
  const stopReset = subscribeReset(() => {
    if (disposed) return
    open()
    listener()
  })
  return () => {
    if (disposed) return
    disposed = true
    stopReset()
    stopState?.()
    close()
  }
}
