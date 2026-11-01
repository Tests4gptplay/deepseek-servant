import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import { ModeEvents } from '../mode-router/events.js';
import { FilesConflictError, FilesOutcomeUnknownError } from './transactions.js';
import type { FrameworkService } from './service.js';
const methods = ['knowledgeList', 'knowledgeRead', 'knowledgeEdit', 'knowledgeStatus', 'view', 'history', 'send', 'configure', 'legacyControl', 'invite', 'gitMembers', 'gitMemberAction', 'taskControl', 'stopExecution', 'participation', 'selectMode', 'readFile'] as const;
/** Uses the Host's authenticated connection carrier, not an independent web server. */
export function installFrameworkTransport(ctx: Context, service: FrameworkService): () => Promise<void> {
    const events = new ModeEvents(), off = service.subscribeChanged(events.changed);
    const fiber = ctx.inject(['connection'], scope => {
        scope.effect(() => scope.connection.fetch.register({ path: '/api/deepseek-servant-framework/events', methods: ['GET'], requestBody: 'buffered', fetch: async (request) => events.response(request) }), 'dss.framework.events');
        for (const method of methods)
            scope.effect(() => scope.connection.fetch.register({ path: '/api/deepseek-servant-framework/' + method, methods: ['POST'], requestBody: 'buffered', fetch: async (request) => {
                    const envelope = clientRequestSchema.safeParse(await request.json().catch(() => undefined));
                    if (!envelope.success)
                        return new Response('Invalid native request envelope.', { status: 400 });
                    const message = envelope.data, respond = (result: unknown) => Response.json({ type: 'server-response', rpcId: message.rpcId, result });
                    if (message.method !== 'deepseek-servant-framework/' + method)
                        return respond({ ok: false, error: { code: 'dss/invalid-method', message: 'Invalid method.', details: {} } });
                    try {
                        const value = await (service[method] as (input: any) => Promise<unknown>).call(service, message.payload);
                        return respond({ ok: true, value });
                    }
                    catch (error) {
                        const details = error instanceof FilesOutcomeUnknownError ? { operationId: error.operationId, ...(error.confirmed ? { confirmed: error.confirmed } : {}) }
                          : error instanceof FilesConflictError ? { expectedRevision: error.expectedRevision } : {};
                        return respond({ ok: false, error: { code: error instanceof FilesOutcomeUnknownError ? 'dss/outcome-unknown' : error instanceof FilesConflictError ? 'dss/conflict' : 'dss/request-failed', message: error instanceof Error ? error.message : String(error), details } });
                    }
                } }), 'dss.framework.' + method);
        scope.effect(() => scope.connection.fetch.register({ path: '/api/deepseek-servant-framework/download', methods: ['GET'], requestBody: 'buffered', fetch: async (request) => {
                try {
                    const url = new URL(request.url), mode = z.enum(['local', 'git']).parse(url.searchParams.get('mode')), path = z.string().min(1).parse(url.searchParams.get('path'));
                    const data = await service.download(mode, path, url.searchParams.get('storageScope') ?? undefined), name = path.split('/').at(-1)!;
                    return new Response(new Uint8Array(data), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name), 'cache-control': 'no-store' } });
                }
                catch (error) {
                    return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
                }
            } }), 'dss.framework.download');
    });
    return async () => { off(); events.dispose(); await fiber.dispose(); };
}
