/** Native authenticated SSE invalidations and small state projections; no periodic keepalive. */
export class ModeEvents<T = unknown> {
  private listeners = new Set<(change?: T) => void>()
  private streams = new Set<() => void>()
  private disposed = false
  changed = (change?: T): void => { for (const listener of this.listeners) listener(change) }
  response(request: Request): Response {
    if (this.disposed) return new Response('DSS modes are stopping.', { status: 503 })
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false
        const close = () => { if (!closed) { closed = true; cleanup(); controller.close() } }
        const changed = (change?: T) => { if (!closed) controller.enqueue(new TextEncoder().encode('event: changed\ndata: ' + JSON.stringify(change ?? {}) + '\n\n')) }
        cleanup = () => { this.listeners.delete(changed); this.streams.delete(close); request.signal.removeEventListener('abort', close) }
        this.listeners.add(changed); this.streams.add(close)
        request.signal.addEventListener('abort', close, { once: true })
        if (request.signal.aborted) close(); else changed()
      },
      cancel() { cleanup() },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  }
  dispose(): void { this.disposed = true; for (const close of [...this.streams]) close() }
}
