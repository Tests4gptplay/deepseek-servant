export const modes = ['LOCAL', 'PRIVATE_GIT_EXPERIMENTAL'] as const
export type ServantMode = typeof modes[number]

export interface ModeEndpoint {
  call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}
export interface ModeSelection {
  read(): ServantMode
  write(mode: ServantMode): Promise<void>
}

/** Selection owns only entry routing; each endpoint owns its tasks and lifecycle. */
export class ModeRouter {
  constructor(private readonly selection: ModeSelection, private readonly endpoints: Record<ServantMode, ModeEndpoint>) {}
  current(): ServantMode { return this.selection.read() }
  async select(mode: ServantMode): Promise<ServantMode> {
    if (!modes.includes(mode)) throw new Error('Unknown DSS mode.')
    await this.selection.write(mode)
    return mode
  }
  call(mode: ServantMode, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!modes.includes(mode)) throw new Error('Unknown DSS mode.')
    if (method === 'send' && mode !== this.current()) throw new Error('The selected DSS mode changed. Your message has not been sent.')
    return this.endpoints[mode].call(method, params, signal)
  }
}
