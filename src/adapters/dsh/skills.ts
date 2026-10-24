import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillCandidate, SkillDefinition, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type { KnowledgeService } from '../../application/knowledge-service.js'
import type { ServantSkillDescriptor, KnowledgeScope } from '../../contracts/knowledge.js'

export interface ServantSkillBinding extends KnowledgeScope {
  taskId?: string
  executionId?: string
}

interface ObservedLoad { callId: string; loaded: ServantSkillDescriptor[] }

/** One native provider in this Agent scope; DSH owns catalog merging and body loading. */
export function installSkillProvider(
  agentCtx: Context,
  agent: Agent,
  knowledge: KnowledgeService,
  binding: ServantSkillBinding,
): () => void {
  const nativeSkills = agentCtx.get('skills')
  if (nativeSkills === undefined) throw new Error('The selected Servant preset has no DSH skill registry.')
  const loads = new AsyncLocalStorage<ObservedLoad>()
  let providerControl: SkillProviderControl | undefined
  const scope: KnowledgeScope = { assistantId: binding.assistantId, workspaceId: binding.workspaceId }
  const descriptor = (candidate: SkillCandidate): ServantSkillDescriptor | undefined => {
    const value = candidate.locator
    if (typeof value !== 'object' || value === null) return undefined
    if (!('skillId' in value) || typeof value.skillId !== 'string' || !('version' in value) || typeof value.version !== 'number'
      || !('contentHash' in value) || typeof value.contentHash !== 'string' || !('title' in value) || typeof value.title !== 'string') return undefined
    return { name: candidate.name, skillId: value.skillId, version: value.version, contentHash: value.contentHash, title: value.title, description: candidate.description }
  }
  const unregister = nativeSkills.registerProvider(control => {
    providerControl = control
    return {
      name: 'deepseek-servant',
      list: async options => {
        options.signal?.throwIfAborted()
        return (await knowledge.catalog(scope)).map(skill => ({
          name: skill.name, description: skill.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'runtime', provider: 'deepseek-servant', rank: 250,
          resourceBase: { kind: 'opaque' as const, description: `Servant skill ${skill.skillId} version ${skill.version}` },
          locator: { skillId: skill.skillId, version: skill.version, contentHash: skill.contentHash, title: skill.title },
        }))
      },
      get: async (candidate, options): Promise<SkillDefinition | undefined> => {
        options.signal?.throwIfAborted()
        const skill = descriptor(candidate)
        if (skill === undefined) return undefined
        const body = await knowledge.getSkillBody(candidate.name, scope, skill.version)
        if (body === undefined) return undefined
        options.signal?.throwIfAborted()
        loads.getStore()?.loaded.push(skill)
        return {
          name: candidate.name, description: candidate.description, invocation: candidate.invocation,
          source: candidate.source, provider: candidate.provider, content: body,
          ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
        }
      },
    }
  })
  const unsubscribe = knowledge.subscribe(() => providerControl?.invalidate())
  // A catalog preview or failed tool does not claim that a model received a skill.
  const stopObservation = agentCtx.on('tools/execute', async (exec, next) => {
    if (exec.agent !== agent) return next()
    return loads.run({ callId: exec.callId, loaded: [] }, async () => {
      const result = await next()
      const observed = loads.getStore()
      if (!result.isError && observed !== undefined && binding.taskId !== undefined && binding.executionId !== undefined) {
        for (const skill of observed.loaded) {
          await knowledge.recordUse({
            ...scope,
            observationId: `${observed.callId}:${skill.skillId}:${skill.version}`,
            skillId: skill.skillId, version: skill.version, contentHash: skill.contentHash,
            taskId: binding.taskId, executionId: binding.executionId,
          })
        }
      }
      return result
    })
  })
  const dispose = () => { stopObservation(); unsubscribe(); unregister(); loads.disable() }
  agentCtx.effect(() => dispose, 'servant.skillProviderNotifications')
  return dispose
}
