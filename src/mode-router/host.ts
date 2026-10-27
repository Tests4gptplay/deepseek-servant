import type { Context } from '@deepseek-ai/cordis'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import { ModeRouter, modes, type ModeEndpoint } from './mode-router.js'
import { ModeEvents } from './events.js'
import { SharedForeground } from './shared-foreground.js'
import { installCoopRuntime } from '../experimental/private-git/runtime.js'
import { CoopCache } from '../experimental/private-git/cache.js'
import { CoopCredentials } from '../experimental/private-git/credentials.js'
import { GitHubClient } from '../experimental/private-git/github.js'
import { CoopService } from '../experimental/private-git/service.js'

const selectionSpec = defineDomain({ name: 'deepseek_servant_mode', version: 1,
  global: { schema: z.object({ activeMode: z.enum(modes), coopActivated: z.boolean().default(false) }), initial: { activeMode: 'LOCAL' as const, coopActivated: false } }, tables: {} })
const callSchema = z.object({ mode: z.enum(modes), method: z.string(), params: z.record(z.string(), z.json()).default({}) })
const selectSchema = z.object({ mode: z.enum(modes) })

export interface ServantModes { router: ModeRouter; coop(): Promise<CoopService> }
declare module '@deepseek-ai/cordis' { interface Context { deepseekServantModes: ServantModes } }

/** Only this composition boundary knows both mode endpoints. */
export async function installModeHost(ctx: Context, local: ModeEndpoint): Promise<void> {
  const selection = await ctx.storageDomain.open(selectionSpec)
  const events = new ModeEvents()
  let pendingCoop: Promise<CoopService> | undefined
  const coop = (): Promise<CoopService> => pendingCoop ??= (async () => {
    const cache = await CoopCache.open(ctx)
    const credentials = new CoopCredentials(ctx, () => cache.settings.tokenRef)
    const service = new CoopService(cache, credentials, new GitHubClient(() => credentials.resolve()), () => ctx.get('agentDefaultModel')?.currentSelection())
    service.subscribe(events.changed)
    installCoopRuntime(ctx, service)
    return service
  })().catch(error => { pendingCoop = undefined; throw error })
  if (selection.global.get().coopActivated) void coop().catch(error => { console.error('deepseek-servant Coop startup', error); events.changed() })
  const router = new ModeRouter({
    read: () => selection.global.get().activeMode,
    write: async activeMode => { await selection.global.set({ activeMode, coopActivated: selection.global.get().coopActivated || activeMode === 'PRIVATE_GIT_EXPERIMENTAL' }); events.changed() },
  }, { LOCAL: local, PRIVATE_GIT_EXPERIMENTAL: { call: async (...args) => (await coop()).call(...args) } })
  const shared = new SharedForeground(local, coop, () => router.current(), () => selection.global.get().coopActivated)
  ctx.provide('deepseekServantModes', { router, coop })
  const fiber = ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({ path: '/api/deepseek-servant-mode/events', methods: ['GET'], requestBody: 'buffered', fetch: async request => events.response(request) }), 'servant.modes.events')
    for (const method of ['selection', 'select', 'call', 'shared']) scope.effect(() => scope.connection.fetch.register({
      path: '/api/deepseek-servant-mode/' + method, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        const envelope = clientRequestSchema.safeParse(await request.json().catch(() => undefined))
        if (!envelope.success) return new Response('Invalid native request envelope.', { status: 400 })
        const message = envelope.data
        const respond = (result: unknown) => Response.json({ type: 'server-response', rpcId: message.rpcId, result })
        if (message.method !== 'deepseek-servant-mode/' + method) return respond({ ok: false, error: { code: 'servant-mode/invalid-method', message: 'Invalid mode endpoint.', details: {} } })
        try {
          let value: unknown
          if (method === 'selection') value = { activeMode: router.current() }
          else if (method === 'select') value = { activeMode: await router.select(selectSchema.parse(message.payload).mode) }
          else if (method === 'shared') { const input = callSchema.omit({ mode: true }).parse(message.payload); value = await shared.call(input.method, input.params, request.signal) }
          else { const input = callSchema.parse(message.payload); value = await router.call(input.mode, input.method, input.params, request.signal) }
          return respond({ ok: true, value })
        } catch (error) {
          return respond({ ok: false, error: { code: 'servant-mode/request-failed', message: error instanceof Error ? error.message : 'Mode request failed.', details: {} } })
        }
      },
    }), 'servant.modes.' + method)
  })
  ctx.effect(() => async () => { events.dispose(); await fiber.dispose(); await (await pendingCoop?.catch(() => undefined))?.dispose(); await selection.close() }, 'servant.modes')
}
