import type { Context } from '@deepseek-ai/cordis'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'

/** DSS owns this browse service; the Host's native picker is not replaced. */
export function createUiDirectoryBrowser(ctx: Context) {
  const scope = ctx.isolate('directoryPicker')
  let ready: Promise<void> | undefined
  const capability = async () => {
    ready ??= scope.plugin(BrowseDirectoryPicker).await().then(() => undefined)
    await ready
    const value = scope.get('directoryPicker', true).capability()
    if (value.kind !== 'browse') throw new Error('Directory browsing is unavailable.')
    return value
  }
  return {
    async list(path?: string, signal?: AbortSignal) { return (await capability()).list(path, signal) },
    async create(path: string, name: string) { return (await capability()).createDirectory(path, name) },
  }
}

/** Existing authenticated connection carrier and client-request envelope. */
export function installUiDirectoryTransport(ctx: Context) {
  const browser = createUiDirectoryBrowser(ctx)
  for (const method of ['directoryList', 'directoryCreate'] as const) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/deepseek-servant-framework/' + method, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        const envelope = clientRequestSchema.safeParse(await request.json().catch(() => undefined))
        if (!envelope.success) return new Response('Invalid native request envelope.', { status: 400 })
        const message = envelope.data
        const respond = (result: unknown) => Response.json({ type: 'server-response', rpcId: message.rpcId, result })
        if (message.method !== 'deepseek-servant-framework/' + method)
          return respond({ ok: false, error: { code: 'dss/invalid-method', message: 'Invalid method.', details: {} } })
        try {
          let value: unknown
          if (method === 'directoryList') {
            const input = z.object({ path: z.string().optional() }).parse(message.payload)
            value = await browser.list(input.path, request.signal)
          } else {
            const input = z.object({ path: z.string(), name: z.string() }).parse(message.payload)
            value = await browser.create(input.path, input.name)
          }
          return respond({ ok: true, value })
        } catch (error) {
          return respond({ ok: false, error: { code: 'dss/request-failed', message: error instanceof Error ? error.message : String(error), details: {} } })
        }
      },
    }), 'dss.ui.' + method)
  }
}
