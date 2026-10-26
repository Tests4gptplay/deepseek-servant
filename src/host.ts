import type { Context } from '@deepseek-ai/cordis'
import { installModeHost } from './mode-router/host.js'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { z } from 'zod'
import { DshStorageAdapter } from './adapters/dsh/storage.ts'
import { DshAgentGateway } from './adapters/dsh/agents.ts'
import { DshSessionReader } from './adapters/dsh/sessions.ts'
import { DshWorkspaceAdapter } from './adapters/dsh/workspace.ts'
import { installRemoteTransport } from './adapters/dsh/remote.ts'
import { ServantStore } from './application/servant-store.ts'
import { TaskService } from './application/task-service.ts'
import { RuntimeSettingsService } from './application/runtime-settings.js'
import { AssistantService, deliveryMessageText } from './application/assistant-service.ts'
import { KnowledgeService } from './application/knowledge-service.ts'
import { QueryService } from './application/query-service.ts'
import { RetentionService } from './application/retention-service.ts'
import { ServantApi } from './application/api.ts'
import { AgentSupervisor } from './runtime/agent-supervisor.ts'
import { RuntimeCoordinator } from './runtime/coordinator.ts'
import { queryTaskMemory } from './runtime/context-assembler.ts'
import { installRoleTools } from './roles/tools.ts'
import { ModelRouteSchema } from './contracts/schemas.ts'
import type { Assistant } from './contracts/assistant.ts'
import type { RuntimeProfile } from './contracts/task.ts'

export const name = 'deepseek-servant'
export const inject = ['storage', 'storageDomain', 'agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'workingDirectory', 'agentPresets', 'jobs']
export const Config = z.object({ workerSeats: z.int().min(1).max(32).default(2), reviewEvery: z.int().min(1).max(100).default(5),
  presetId: z.string().min(1).default('standard'), foreground: ModelRouteSchema.default({}), background: ModelRouteSchema.default({}) })
export type Config = z.infer<typeof Config>

export interface ServantHost {
  api: ServantApi
  tasks: TaskService
  assistants: AssistantService
  knowledge: KnowledgeService
  coordinator: RuntimeCoordinator
  retention: RetentionService
}
declare module '@deepseek-ai/cordis' { interface Context { deepseekServant: ServantHost } }

/** One backend-owned modular bundle. Client unload has no execution ownership. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const store = await DshStorageAdapter.open(ctx)
  const gateway = new DshAgentGateway(ctx)
  const sessions = new DshSessionReader(ctx)
  const workspace = new DshWorkspaceAdapter(ctx)
  const listeners = new Set<() => void>()
  let coordinator: RuntimeCoordinator | undefined
  const changed = () => { for (const listener of listeners) { try { listener() } catch (error) { console.error('deepseek-servant view listener', error) } } }
  const runtimeChanged = () => { changed(); coordinator?.wake() }
  const reportError = (error: unknown) => { console.error('deepseek-servant', error); changed() }
  const runtimeSettings = await RuntimeSettingsService.open(store, config.workerSeats, settings => { coordinator?.setWorkerSeats(settings.workerSeats); changed() })
  const tasks = new TaskService(new ServantStore(store), { reviewEvery: config.reviewEvery, onNotificationError: reportError })
  const defaults: RuntimeProfile = { version: 'host-1', presetId: config.presetId, foreground: config.foreground, background: config.background }
  let assistants!: AssistantService
  const knowledge = new KnowledgeService({ store, onChanged: changed, evidence: {
    resolveResult: async resultId => {
      const matches = [...new Map([...await tasks.history(true), ...await tasks.list()].map(task => [task.id, task])).values()].flatMap(task => {
        const report = Object.hasOwn(task.reports, resultId) ? task.reports[resultId] : undefined
        return report ? [{ task, report }] : []
      })
      if (matches.length !== 1) return undefined
      const { task, report } = matches[0]!
      return { resultId, taskId: task.id, executionId: report.executionId,
        assistantId: task.assistantId, workspaceId: task.workspace.id,
        status: report.disposition === 'accepted' ? 'accepted' : report.disposition === 'rework' || report.outcome === 'failed' ? 'failed' : 'pending',
        summary: report.summary, artifactRefs: report.artifacts.map(artifact => artifact.id) }
    },
    resolveUserSource: async sourceRef => {
      const separator = sourceRef.indexOf('/')
      if (separator < 0) return undefined
      const sessionId = sourceRef.slice(0, separator), messageId = sourceRef.slice(separator + 1)
      for (const { value: assistant } of await store.list<Assistant>('assistant/')) {
        const message = await assistants.userInput(assistant.id, messageId)
        if (message?.sessionId === sessionId) return { assistantId: assistant.id, workspaceId: message.workspaceId ?? assistant.workspace.id }
      }
      return undefined
    },
  } })
  const supervisor: AgentSupervisor = new AgentSupervisor({ gateway, tasks, knowledge, defaults, onChanged: runtimeChanged,
    recentExchanges: id => assistants.conversations.seed(id),
    onForegroundChanged: (id, sessionId) => { void assistants.advance(id, sessionId).catch(reportError) },
    workerCapacity: () => coordinator!.capacity(),
    onError: error => { coordinator?.reportError(error); reportError(error) },
    setupRole: (scope, agent, binding) => installRoleTools(scope, agent, binding, { assistants, tasks, knowledge,
      memoryQuery: async (taskId, input, executionId) => {
        const task = await tasks.get(taskId)
        if (!task) throw new Error('Task memory does not exist')
        if (executionId && !Object.hasOwn(task.executions, executionId)) throw new Error('Bound execution no longer owns task memory')
        return queryTaskMemory(task, executionId ? task.executions[executionId] : undefined, input)
      },
    }),
  })
  assistants = new AssistantService({ store, defaults: { name: 'DeepSeek Servant', presetId: config.presetId,
    foreground: config.foreground, background: config.background }, resolveWorkspace: (id, directory) => workspace.resolve(id, directory), onChanged: changed,
    runtime: {
      prepareConfiguration: previous => supervisor.releaseForegroundIfIdle(previous),
      capture: sessionId => sessions.capture(sessionId),
      retire: assistant => supervisor.retireForeground(assistant),
      cancel: assistant => supervisor.cancelForeground(assistant),
      resume: (assistant, messageId) => supervisor.resumeForeground(assistant, messageId),
      send: async (assistant, text, messageId, source = 'user') => (await supervisor.ensureForeground(assistant)).send(text, messageId, 'followup', source),
      hasInput: (sessionId, messageId) => sessions.hasMessage(sessionId, messageId),
      inputs: sessionId => sessions.inputs(sessionId),
      conversation: sessionId => sessions.conversation(sessionId),
      deliver: async (assistant, delivery, messageId) => (await supervisor.ensureForeground(assistant)).send(
        deliveryMessageText(delivery),
        messageId, 'followup', 'deepseek-servant'),
    },
  })
  coordinator = new RuntimeCoordinator({ tasks, assistants, knowledge, supervisor, sessions, workerSeats: runtimeSettings.get().workerSeats,
    afterCleanup: async () => { await retention.sweep() }, onChanged: changed, onError: reportError })
  const retention = new RetentionService({ store, tasks, knowledge, nativeSessions: sessions, onChanged: changed, completedTasks: tasks })
  const query = new QueryService({ assistants, tasks, knowledge, workspaces: () => workspace.list(), runtime: () => coordinator!.status(), runtimeSettings: () => runtimeSettings.get(), recordStorage: () => store.storageView() })
  const api = new ServantApi({ assistants, tasks, knowledge, query, coordinator, retention, runtimeSettings,
    recordsDirectory: () => store.ensureRecordsDirectory(),
    moveRecords: async (directory, expectedDirectory, signal) => {
      const result = await store.moveRecords(directory, expectedDirectory, signal)
      changed()
      return result
    },
    openPath: async (target, signal) => {
      const controller = ctx.get('sessionController')
      if (!controller?.canOpenWorkspacePath()) throw new Error(`当前宿主没有本地打开文件能力。路径：${target}`)
      return controller.openWorkspacePath({ path: target }, signal)
    },
  })
  ctx.provide('deepseekServant', { api, tasks, assistants, knowledge, coordinator, retention })
  installRemoteTransport(ctx, { call: (method, params, signal) => api.call(method, params, signal), subscribe: listener => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } })

  // The coordinator seals records and cleans ended Tasks on native completion events.
  const stopTaskNotifications = tasks.subscribe(() => changed())
  ctx.effect(() => async () => {
    stopTaskNotifications()
    await coordinator!.dispose()
    await supervisor.dispose()
    await assistants.flush(); await tasks.flush(); await runtimeSettings.flush()
    await store.close()
    listeners.clear()
  }, 'servant.host.ownership')
  await installModeHost(ctx, { call: (method, params, signal) => api.call(method, params, signal ?? new AbortController().signal) })
  await coordinator.start()
  const admissions = await assistants.recoverInputs()
  if (admissions.failed.length) coordinator.reportError(new Error(`${admissions.failed.length} 条前台消息等待修复后重新接纳。`))
}
