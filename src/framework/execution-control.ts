import { createHash } from 'node:crypto'
import type { StoragePort } from '../contracts/ports.js'

export type TaskControlIntent = 'running' | 'paused' | 'cancelled'
export interface TaskControl {
  taskId: string
  intent: TaskControlIntent
  commandId: string
  requestedAt: string
}
export interface ExecutionStopRequest {
  workId: string
  executionId: string
  taskId?: string
}
export interface ExecutionStopResult {
  state: 'stopped' | 'unconfirmed' | 'superseded'
  detail?: string
  jobs?: string[]
}
export interface ExecutionStopControl extends ExecutionStopRequest {
  commandId: string
  requestedAt: string
  result?: ExecutionStopResult
}
interface Controls {
  version: 1
  tasks: Record<string, TaskControl>
  executions: Record<string, ExecutionStopControl>
  commands: Record<string, { signature: string; value: TaskControl | ExecutionStopControl }>
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Explicit local user-control intentions. This layer neither starts/stops an
 * Agent nor edits Task business completion, remote signals or recovery markers.
 * Runtime ownership and actual native stop confirmation remain their own duties.
 */
export class ExecutionControls {
  private readonly key: string
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly storage: StoragePort, scope: string, private readonly now = () => new Date().toISOString()) {
    this.key = 'framework-user-controls/' + hash(scope)
  }
  private async load(): Promise<Controls> {
    const saved = await this.storage.get<Controls>(this.key)
    return saved ? structuredClone(saved) : { version: 1, tasks: {}, executions: {}, commands: {} }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }
  /** Use only for the authenticated user's explicit action. Caller checks scope. */
  setTask(commandId: string, taskId: string, intent: TaskControlIntent): Promise<TaskControl> {
    return this.serial(async () => {
      const state = await this.load(), key = hash(commandId), signature = JSON.stringify(['task', taskId, intent])
      const old = state.commands[key]
      if (old) {
        if (old.signature !== signature) throw new Error('Control command identity has different arguments.')
        return old.value as TaskControl
      }
      const value: TaskControl = { taskId, intent, commandId, requestedAt: this.now() }
      state.tasks[hash(taskId)] = value
      state.commands[key] = { signature, value }
      // One durable record stores the intent and replay receipt atomically.
      await this.storage.set(this.key, state)
      return value
    })
  }
  requestExecutionStop(commandId: string, target: ExecutionStopRequest): Promise<ExecutionStopControl> {
    return this.serial(async () => {
      const state = await this.load(), key = hash(commandId)
      const signature = JSON.stringify(['execution-stop', target.workId, target.executionId, target.taskId ?? null])
      const old = state.commands[key]
      if (old) {
        if (old.signature !== signature) throw new Error('Control command identity has different arguments.')
        return old.value as ExecutionStopControl
      }
      const value: ExecutionStopControl = { ...target, commandId, requestedAt: this.now() }
      state.executions[hash(target.executionId)] = value
      state.commands[key] = { signature, value }
      await this.storage.set(this.key, state)
      return value
    })
  }
  /** Records the real native outcome; requesting a stop is never proof it stopped. */
  settleExecution(commandId: string, executionId: string, result: ExecutionStopResult): Promise<ExecutionStopControl | undefined> {
    return this.serial(async () => {
      const state = await this.load(), key = hash(executionId), current = state.executions[key]
      if (!current || current.commandId !== commandId) return current
      const value: ExecutionStopControl = { ...current, result: structuredClone(result) }
      state.executions[key] = value
      const receipt = state.commands[hash(commandId)]
      if (receipt) receipt.value = value
      await this.storage.set(this.key, state)
      return value
    })
  }
  task(taskId: string): Promise<TaskControl | undefined> {
    return this.serial(async () => (await this.load()).tasks[hash(taskId)])
  }
  execution(executionId: string): Promise<ExecutionStopControl | undefined> {
    return this.serial(async () => (await this.load()).executions[hash(executionId)])
  }
  /** Only undispatched requests; unconfirmed results stay visible for diagnosis. */
  pendingStops(): Promise<ExecutionStopControl[]> {
    return this.serial(async () => Object.values((await this.load()).executions).filter(value => value.result === undefined))
  }
  async taskHeld(taskId?: string): Promise<boolean> {
    if (!taskId) return false
    const value = await this.task(taskId)
    return value?.intent === 'paused' || value?.intent === 'cancelled'
  }
  /** Cleanup removes active associations; old command receipts cannot reopen work. */
  releaseTask(taskId: string): Promise<void> {
    return this.serial(async () => {
      const state = await this.load()
      delete state.tasks[hash(taskId)]
      for (const [key, value] of Object.entries(state.executions)) if (value.taskId === taskId) delete state.executions[key]
      await this.storage.set(this.key, state)
    })
  }
}
