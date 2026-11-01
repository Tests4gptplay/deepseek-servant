import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, type Message } from '@deepseek-ai/dsh-llm'
import type { FilesStore } from './transactions.js'
import { withSnapshot } from './transactions.js'

/** Structural read face of the native tokenMeter service. Kept optional so a
 * missing estimator does not become an installation or task-admission gate.
 */
interface NativeMeter {
  measure?(session: Agent['session']): { totalTokens: number; baseline: { kind: string } }
  estimateMessage?(message: Message): number
}
interface NativeProjections {
  snapshot(session: Agent['session'], keys: readonly string[]): { values: Record<string, unknown> }
}
interface Pressure { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }
interface Usage { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface MaterialCapacity {
  path: string
  status: 'text' | 'binary' | 'missing'
  bytes: number | null
  estimatedTokens: number | null
}
export interface RecorderCapacity {
  revision: string
  materials: MaterialCapacity[]
  textEstimateTotal: number | null
  containsUnestimatedMaterials: boolean
  estimateBasis: 'native-token-meter-per-message' | 'unavailable'
  session: {
    measuredTokens: number | null
    measurementBasis: string | null
    pressureTokens: number | null
    projectedTokens: number | null
    contextWindow: number | null
    cumulativeUsage: Usage | null
  }
}

/** Read-only capacity reference, not a quota, truncation rule, or completion gate.
 * measure/estimateMessage are native token-meter APIs; projection pressure and
 * cumulative usage remain distinct and never get substituted for one another.
 */
export function createRecorderCapacity(files: FilesStore) {
  return async (agent: Agent, input: { taskId: string; paths: string[] }): Promise<RecorderCapacity> => {
    const services = agent.ctx as unknown as { get(name: string): unknown }
    const meter = services.get('tokenMeter') as NativeMeter | undefined
    const projections = services.get('sessionProjections') as NativeProjections | undefined
    const measurement = typeof meter?.measure === 'function' ? meter.measure(agent.session) : undefined
    const estimate = typeof meter?.estimateMessage === 'function' ? meter.estimateMessage.bind(meter) : undefined
    const values = projections?.snapshot(agent.session, ['contextPressure', 'tokenUsage']).values
    const pressure = values?.contextPressure as Pressure | undefined
    const usage = values?.tokenUsage as Usage | undefined
    const contextWindow = agent.session.requestContext()?.contextWindow ?? pressure?.contextWindow ?? null
    return withSnapshot(files, async snapshot => {
      const materials: MaterialCapacity[] = []
      for (const path of new Set(input.paths)) {
        const bytes = await files.readBytes(snapshot, path)
        if (bytes === undefined) { materials.push({ path, status: 'missing', bytes: null, estimatedTokens: null }); continue }
        let text: string | undefined
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) text = undefined } catch { /* Binary content has no text-only token estimate. */ }
        const estimatedTokens = text === undefined || !estimate ? null : estimate({
          id: MessageId('dss-capacity:' + input.taskId + ':' + path), role: 'user',
          source: { kind: 'deepseek-servant' }, content: [{ type: 'text', text }],
        })
        materials.push({ path, status: text === undefined ? 'binary' : 'text', bytes: bytes.byteLength, estimatedTokens })
      }
      return {
        revision: snapshot.revision, materials,
        textEstimateTotal: estimate ? materials.reduce((total, item) => total + (item.estimatedTokens ?? 0), 0) : null,
        containsUnestimatedMaterials: materials.some(item => item.estimatedTokens === null),
        estimateBasis: estimate ? 'native-token-meter-per-message' : 'unavailable',
        session: { measuredTokens: measurement?.totalTokens ?? null, measurementBasis: measurement?.baseline.kind ?? null,
          pressureTokens: pressure?.pressureTokens ?? null, projectedTokens: pressure?.projectedTokens ?? null,
          contextWindow, cumulativeUsage: usage ?? null },
      }
    })
  }
}
