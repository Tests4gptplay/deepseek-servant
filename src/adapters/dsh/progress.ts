import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { JobEvent, JobView } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tools'

/** Only event metadata leaves this observer; no model or tool bodies are retained. */
export interface DshProgress {
  kind: 'model-text' | 'reasoning' | 'tool-progress'
  source: 'assistant-stream' | 'tools/result' | 'jobs/output' | 'jobs/progress'
  observedAt: number
  jobId?: string
}

export function streamProgress(frame: AssistantStreamFrame): DshProgress['kind'] | undefined {
  if (frame.type !== 'chunk') return
  const chunk = frame.chunk
  if (chunk.type === 'text-delta' && chunk.text.length) return 'model-text'
  if (chunk.type === 'reasoning-delta' && chunk.text.length) return 'reasoning'
}

/** Keep only live-job counters/progress lines, never the output ring or its payloads. */
export class JobProgressTracker {
  private readonly jobs = new Map<string, { total: number; progress?: string }>()
  constructor(private readonly owner: string, initial: readonly JobView[] = []) {
    for (const job of initial) if (job.owner === owner && (job.status === 'running' || job.status === 'stopping')) {
      this.jobs.set(job.id, { total: job.output.total, progress: job.progress })
    }
  }
  accept(event: JobEvent): Pick<DshProgress, 'source' | 'jobId'> | undefined {
    const owner = event.type === 'output' ? event.owner : event.job.owner
    if (owner !== this.owner) return
    const id = event.type === 'output' ? event.id : event.job.id
    if (event.type === 'removed' || event.type === 'settled') { this.jobs.delete(id); return }
    const previous = this.jobs.get(id)
    if (event.type === 'output') {
      const total = previous?.total ?? 0
      this.jobs.set(id, { ...previous, total: Math.max(total, event.total) })
      return event.total > total ? { source: 'jobs/output', jobId: id } : undefined
    }
    this.jobs.set(id, { total: Math.max(previous?.total ?? 0, event.job.output.total), progress: event.job.progress })
    if (event.type === 'progress' && event.job.progress && event.job.progress !== previous?.progress) {
      return { source: 'jobs/progress', jobId: id }
    }
  }
}

/** Official scoped stream/tool events and exact-owner Jobs events; lifecycle is not progress. */
export function observeDshProgress(agent: Agent, listener: (event: DshProgress) => void, now = Date.now): () => void {
  const registry = agent.ctx.get('jobs')
  const tracker = new JobProgressTracker(agent.id, registry?.list(agent.id))
  const stream = agent.ctx.on('agent/assistant-stream', event => {
    if (event.agent !== agent) return
    const kind = streamProgress(event.frame)
    if (kind) listener({ kind, source: 'assistant-stream', observedAt: now() })
  })
  const tool = agent.ctx.on('tools/result', (exec, result) => {
    if (exec.agent === agent && !result.isError) listener({ kind: 'tool-progress', source: 'tools/result', observedAt: now() })
    return undefined
  })
  const jobs = registry?.events.subscribe({ owner: agent.id }, event => {
    const progress = tracker.accept(event)
    if (progress) listener({ kind: 'tool-progress', ...progress, observedAt: now() })
  })
  return () => { stream(); tool(); jobs?.() }
}
