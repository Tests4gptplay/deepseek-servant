import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'

export const servantRemoteMethods = ['view', 'send', 'configure', 'control', 'priority', 'answer', 'revise', 'knowledge', 'readDelivery', 'task', 'openArtifact', 'openRecords', 'retention', 'reconcile'] as const
export type ServantRemoteMethod = typeof servantRemoteMethods[number]

export interface ServantRemoteApi {
  /** Application boundary must validate the method-specific shape and derive command authority. */
  call(method: ServantRemoteMethod, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  /** Only committed state invalidations; opening a page must never drive execution. */
  subscribe(listener: () => void): () => void
}

const paramsSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.json())
const encoder = new TextEncoder()

/** Native authenticated Connection routes, mounted in the existing DSH web server. */
export function installRemoteTransport(ctx: Context, api: ServantRemoteApi, onError: (error: unknown) => void = error => console.error('deepseek-servant transport registration', error)): () => Promise<void> {
  // Optional native services may appear later during concurrent Loader startup.
  // Injection owns the routes without turning the SDK's absent GUI into a hard dependency.
  const fiber = ctx.inject(['connection'], scope => {
    try { installRoutes(scope, api) } catch (error) { onError(error); throw error }
  })
  return () => fiber.dispose()
}

function installRoutes(ctx: Context, api: ServantRemoteApi): () => Promise<void> {
  const connection = ctx.connection
  let revision = 0
  let disposed = false
  const subscribers = new Set<() => void>()
  const closeStreams = new Set<() => void>()
  const stopInvalidations = api.subscribe(() => {
    revision += 1
    for (const listener of [...subscribers]) listener()
  })
  ctx.effect(() => stopInvalidations, 'servant.remoteInvalidations')
  // Register on the existing authenticated /api carrier. rc.2's generic
  // rpc.handle() reads webServer through its service's own injection context;
  // exact Fetch routes are the supported native extension used by shipped UI.
  // The Client still sends the native Connection RPC envelope and correlation id.
  const removeRpcs = servantRemoteMethods.map(method => connection.fetch.register({
    path: `/api/deepseek-servant/${method}`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) return new Response('invalid native client-request envelope', { status: 400 })
      const message = envelope.data
      const respond = (result: unknown) => Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      const params = paramsSchema.safeParse(message.payload)
      if (message.method !== `deepseek-servant/${method}` || !params.success) {
        return respond({ ok: false, error: { code: 'servant/invalid-request', message: 'Invalid Servant endpoint or JSON object parameters.', details: {} } })
      }
      try {
        request.signal.throwIfAborted()
        return respond({ ok: true, value: await api.call(method, params.data, request.signal) })
      } catch (error) {
        return respond({ ok: false, error: { code: 'servant/request-failed', message: error instanceof Error ? error.message : 'Servant request failed.', details: {} } })
      }
    },
  }))
  const removeEvents = connection.fetch.register({
    path: '/api/deepseek-servant/events', methods: ['GET'], requestBody: 'buffered',
    fetch: async request => {
      if (disposed) return new Response('Servant is stopping.', { status: 503 })
      let cleanup = () => {}
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false
          const close = () => {
            if (closed) return
            closed = true
            cleanup()
            controller.close()
          }
          const changed = () => {
            if (!closed) controller.enqueue(encoder.encode(`event: changed\ndata: ${JSON.stringify({ revision })}\n\n`))
          }
          // This is transport keepalive only; it neither queries tasks nor wakes Agents.
          const heartbeat = setInterval(() => {
            if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n'))
          }, 25_000)
          heartbeat.unref()
          cleanup = () => {
            clearInterval(heartbeat)
            subscribers.delete(changed)
            closeStreams.delete(close)
            request.signal.removeEventListener('abort', close)
          }
          subscribers.add(changed)
          closeStreams.add(close)
          request.signal.addEventListener('abort', close, { once: true })
          if (request.signal.aborted) close()
          else changed()
        },
        cancel() { cleanup() },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        },
      })
    },
  })
  const dispose = async () => {
    if (disposed) return
    disposed = true
    stopInvalidations()
    for (const close of [...closeStreams]) close()
    await removeEvents()
    for (const removeRpc of removeRpcs) await removeRpc()
  }
  ctx.effect(() => dispose, 'servant.remoteTransport')
  return dispose
}
