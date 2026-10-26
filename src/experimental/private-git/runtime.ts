import type { Context } from '@deepseek-ai/cordis'
import { CoopConsumer } from './consumer.js'
import { CoopNativeAgents } from './native-agents.js'
import { CoopSync } from './sync.js'
import type { CoopService } from './service.js'

export function installCoopRuntime(ctx: Context, service: CoopService): void {
  let sync: CoopSync
  const consumer = new CoopConsumer({ repo: service.repository, cache: service.cache, journal: () => service.getJournal(),
    agents: new CoopNativeAgents(ctx, service.cache), wake: () => sync.request() })
  sync = new CoopSync(service, consumer)
  service.attach(consumer)
  service.setWake(sync.request, () => sync.dispose())
  if (service.cache.connection()) sync.request()
}
