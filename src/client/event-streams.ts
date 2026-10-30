/** SSE performs its own ordinary network reconnection, but a non-200 response
 * or invalid content type permanently closes an EventSource. A new official
 * Connection generation must therefore replace the previous streams as well as
 * reread state. Errors alone never start an extra retry loop or replay a write. */
export function subscribeEventStreams(
  paths: readonly string[], listener: () => void, subscribeReset: (listener: () => void) => () => void,
  create: (url: URL) => EventSource = url => new EventSource(url),
): () => void {
  let disposed = false, generation = 0
  let streams: Array<{ source: EventSource; changed: () => void }> = []
  const close = () => {
    generation++
    for (const { source, changed } of streams) {
      source.removeEventListener('changed', changed)
      source.removeEventListener('open', changed)
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
        const changed = () => { if (!disposed && generation === current) listener() }
        streams.push({ source, changed })
        source.addEventListener('changed', changed)
        source.addEventListener('open', changed)
      }
    } catch (error) { close(); throw error }
  }
  open()
  const stopReset = subscribeReset(() => {
    if (disposed) return
    open()
    listener()
  })
  return () => {
    if (disposed) return
    disposed = true
    stopReset()
    close()
  }
}
