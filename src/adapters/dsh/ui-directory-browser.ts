import type { Context } from '@deepseek-ai/cordis'
import { listDirectory, createDirectory } from './ui-directory-filesystem.js'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'

/** DSS owns this browser without registering or replacing the Host's native picker. */
export function createUiDirectoryBrowser() {
  return { list: listDirectory, create: createDirectory }
}

/** Existing authenticated connection carrier and client-request envelope. */
export function installUiDirectoryTransport(ctx: Context) {
  const browser = createUiDirectoryBrowser()
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
