import { isLocalAttachmentError } from './conversation-attachment-reference.js'
import { HistorySelectionChangedError, requiresUserAction, RecordMoveNotStartedError } from './client-error.js'
import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import { ModeEvents } from '../mode-router/events.js';
import { FilesConflictError, FilesOutcomeUnknownError } from './transactions.js';
import type { FrameworkService } from './service.js';
const methods = ['clientFault', 'maintenanceView', 'openMaintenancePath', 'keepCurrentLocalUpgradeTarget', 'openWorkspaceFile', 'exportRecords', 'cleanupPreview', 'cleanupRecords', 'knowledgeList', 'knowledgeRead', 'knowledgeEdit', 'knowledgeStatus', 'view', 'history', 'send', 'foregroundModel', 'configure', 'moveRecords', 'legacyRecords', 'legacyControl', 'invite', 'gitMembers', 'gitMemberAction', 'taskControl', 'stopExecution', 'participation', 'selectMode', 'readFile', 'attachment', 'selectLocalAttachment', 'openLocalAttachment'] as const;

/** One existing error contract for RPC and raw-byte requests. */
function frameworkFailure(service: FrameworkService, method: string, error: unknown) {
    const safetyNet = service.errorPresentation(error);
    const details = { ...(error instanceof FilesOutcomeUnknownError ? { operationId: error.operationId }
      : error instanceof FilesConflictError ? { expectedRevision: error.expectedRevision } : {}), ...(safetyNet ? { safetyNet } : {}), ...(requiresUserAction(error) ? { interaction: (error as any).interaction ?? (error as any).details?.interaction } : {}), ...((error as any)?.status === 401 || (error as any)?.status === 403 ? { status: (error as any).status } : {}) };
    return { ok: false as const, error: { code: method === 'moveRecords' && error instanceof RecordMoveNotStartedError ? RecordMoveNotStartedError.code : isLocalAttachmentError(error) ? 'dss/local-attachment' : method === 'history' && error instanceof HistorySelectionChangedError ? HistorySelectionChangedError.code : error instanceof FilesOutcomeUnknownError ? 'dss/outcome-unknown' : error instanceof FilesConflictError ? 'dss/conflict' : 'dss/request-failed', message: error instanceof Error ? error.message : String(error), details } };
}
/** Uses the Host's authenticated connection carrier, not an independent web server. */
export function installFrameworkTransport(ctx: Context, service: FrameworkService): () => Promise<void> {
    const events = new ModeEvents(), off = service.subscribeChanged(events.changed);
    const fiber = ctx.inject(['connection'], scope => {
        const attachmentDownload = async (request: Request): Promise<Response> => {
            try {
                const query = new URL(request.url).searchParams;
                const input = { mode: z.enum(['local', 'git']).parse(query.get('mode')), collaborationId: z.string().min(1).parse(query.get('collaborationId')),
                    storageScope: query.get('storageScope') ?? undefined, reference: JSON.parse(query.get('reference') ?? 'null') };
                const { reference, stream } = await service.withSafetyOperation('attachmentStream', input, () => service.attachmentStream(input, request.signal), request.signal);
                return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(reference.bytes),
                    'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(reference.name),
                    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
            } catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 400, headers: { 'cache-control': 'no-store' } }); }
        };
        scope.effect(() => scope.connection.fetch.register({ path: '/api/deepseek-servant-framework/events', methods: ['GET'], requestBody: 'buffered', fetch: async (request) => events.response(request) }), 'dss.framework.events');
        for (const method of methods)
            scope.effect(() => scope.connection.fetch.register({ path: '/api/deepseek-servant-framework/' + method, methods: method === 'attachment' ? ['GET', 'POST'] : ['POST'], requestBody: 'buffered', fetch: async (request) => {
                    // The Host owns exact paths, not separate path/method pairs.
                    if (method === 'attachment' && request.method === 'GET') return attachmentDownload(request);
                    const envelope = clientRequestSchema.safeParse(await request.json().catch(() => undefined));
                    if (!envelope.success)
                        return new Response('Invalid native request envelope.', { status: 400 });
                    const message = envelope.data, respond = (result: unknown) => Response.json({ type: 'server-response', rpcId: message.rpcId, result });
                    if (message.method !== 'deepseek-servant-framework/' + method)
                        return respond({ ok: false, error: { code: 'dss/invalid-method', message: 'Invalid method.', details: {} } });
                    try {
                        const value = await service.withSafetyOperation(method, message.payload, async () => method === 'view' ? await service.view(message.payload as Parameters<FrameworkService['view']>[0], request.signal)
                          : method === 'history' ? await service.history(message.payload as Parameters<FrameworkService['history']>[0], request.signal)
                          : method === 'selectLocalAttachment' ? await service.selectLocalAttachment(message.payload as Parameters<FrameworkService['selectLocalAttachment']>[0], request.signal)
                          : method === 'openLocalAttachment' ? await service.openLocalAttachment(message.payload as Parameters<FrameworkService['openLocalAttachment']>[0], request.signal)
                          : method === 'openWorkspaceFile' ? await service.openWorkspaceFile(message.payload as Parameters<FrameworkService['openWorkspaceFile']>[0], request.signal)
                          : method === 'openMaintenancePath' ? await service.openMaintenancePath(message.payload as Parameters<FrameworkService['openMaintenancePath']>[0], request.signal)
                          : await (service[method] as (input: any) => Promise<unknown>).call(service, message.payload), ['view', 'history', 'selectLocalAttachment', 'openLocalAttachment', 'openWorkspaceFile', 'openMaintenancePath'].includes(method) ? request.signal : undefined);
                        return respond({ ok: true, value });
                    }
                    catch (error) {
                        return respond(frameworkFailure(service, method, error));
                    }
                } }), 'dss.framework.' + method);
        scope.effect(() => scope.connection.fetch.register({ path: '/api/deepseek-servant-framework/upload-attachment', methods: ['POST'], requestBody: 'streaming', fetch: async request => {
            try {
                const metadata = JSON.parse(new URL(request.url).searchParams.get('metadata') ?? 'null');
                if (!metadata || typeof metadata !== 'object' || !request.body) throw new Error('Attachment upload needs metadata and a byte stream.');
                const result = await service.withSafetyOperation('uploadAttachment', metadata, () => service.uploadAttachment(metadata, request.body!, request.signal), request.signal);
                return Response.json(result, { headers: { 'cache-control': 'no-store' } });
            } catch (error) { return Response.json(frameworkFailure(service, 'uploadAttachment', error), { status: 400, headers: { 'cache-control': 'no-store' } }); }
        } }), 'dss.framework.upload-attachment');
        scope.effect(() => scope.connection.fetch.register({ path: '/api/deepseek-servant-framework/download', methods: ['GET'], requestBody: 'buffered', fetch: async (request) => {
                try {
                    const url = new URL(request.url), mode = z.enum(['local', 'git']).parse(url.searchParams.get('mode')), path = z.string().min(1).parse(url.searchParams.get('path'));
                    const reference = url.searchParams.has('reference') ? JSON.parse(url.searchParams.get('reference')!) : undefined;
                    const data = await service.withSafetyOperation('download', { mode, storageScope: url.searchParams.get('storageScope') ?? undefined, path, reference }, () => service.download(mode, path, url.searchParams.get('storageScope') ?? undefined, reference, mode === 'local' ? url.searchParams.get('originalTaskId') ?? undefined : undefined)), name = path.split(/[\\/]/u).at(-1)!;
                    return new Response(new Uint8Array(data), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name), 'cache-control': 'no-store' } });
                }
                catch (error) {
                    const presentation = service.errorPresentation(error);
                    return new Response(presentation && presentation.state !== 'visible' ? '' : error instanceof Error ? error.message : String(error), { status: 400 });
                }
            } }), 'dss.framework.download');
    });
    return async () => { off(); events.dispose(); await fiber.dispose(); };
}
