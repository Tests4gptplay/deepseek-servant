import { disposeResources } from './framework/dispose-resources.js';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { join } from 'node:path';
import { DshStorageAdapter } from './adapters/dsh/storage.js';
import { FrameworkService } from './framework/service.js';
import { installFrameworkTransport } from './framework/transport.js';
import { ModelRouteSchema } from './contracts/schemas.js';
export const name = 'deepseek-servant';
export const inject = ['storage', 'storageDomain', 'agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'workingDirectory', 'agentPresets', 'jobs', 'agentDefaultModel', 'fs'];
export const Config = z.object({ workerSeats: z.number().int().nonnegative().default(2), presetId: z.string().default('standard'),
    foreground: ModelRouteSchema.default({}), background: ModelRouteSchema.default({}) });
export type Config = z.infer<typeof Config>;
export interface ServantHost {
    service: FrameworkService;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        deepseekServant: ServantHost;
    }
}
/** Host lifetime owns execution; switching or closing the client page never stops it. */
export async function apply(ctx: Context, config: Config): Promise<void> {
    const storage = await DshStorageAdapter.open(ctx);
    const model = (route: Config['foreground']) => route.provider && route.model ? { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) } : undefined;
    const service = new FrameworkService(ctx, storage, { name: 'DeepSeek Servant', userName: '', localDirectory: join(storage.storageView().directory, 'deepseek_servant', 'framework'),
        ownerRepo: '', repositoryDirectory: '/', collaborationId: 'default', workerSeats: config.workerSeats, workspace: '', presetId: config.presetId,
        foreground: model(config.foreground), background: model(config.background) });
    ctx.provide('deepseekServant', { service });
    const closeTransport = installFrameworkTransport(ctx, service);
    ctx.effect(() => () => disposeResources([closeTransport, () => service.dispose(), () => storage.close()]), 'dss.framework');
    // Registration readiness is not completion of an owned repository migration.
    // The service retains, reports and drains its per-mode startup work.
    await service.initialize();
}
