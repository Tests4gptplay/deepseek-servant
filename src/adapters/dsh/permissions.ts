import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-commands'

/** DSS-owned role permissions. No command observers or independent permission history. */
export class DshRolePermissions {
  private readonly agents = new Map<Agent, string>()
  constructor(private readonly ctx: Context, private readonly selected: () => string | undefined) {}

  /** Native synchronous initialization: no extra command/request or wait before dispatch. */
  attach(scope: Context, agent: Agent, role: string = agent.session.id): void {
    const preset = this.selected()
    if (preset !== undefined) this.ctx.get('permissionPresets', true)!.set(agent.session, preset)
    this.agents.set(agent, role)
    scope.effect(() => () => { this.agents.delete(agent) })
  }

  /** Called only by the DSS settings UI action; native commands notify live models. */
  async select(preset: string): Promise<void> {
    const native = this.ctx.get('permissionPresets', true)!
    const commands = this.ctx.get('commands', true)
    if (!commands) throw new Error('Native permission commands are unavailable.')
    native.resolve(preset)
    const results = await Promise.allSettled([...this.agents.keys()].filter(agent => native.current(agent.session) !== preset).map(async agent => {
      try {
        const result = await commands.execute(agent, '/permission ' + preset, [], new AbortController().signal)
        if (result === undefined) throw new Error('Native /permission command is unavailable.')
        if (result.result.kind !== 'success') throw new Error(result.result.text)
      } catch (error) { throw new Error(this.agents.get(agent) + ' (' + agent.session.id + '): ' + (error instanceof Error ? error.message : String(error))) }
    }))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Some DSS role permissions could not be applied: ' + failures.map(result => result.reason instanceof Error ? result.reason.message : String(result.reason)).join('; '))
  }
}
