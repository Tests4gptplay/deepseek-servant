import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { execFile } from 'node:child_process'
import type { ResolvedToken } from './github.js'

export function ghToken(): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('gh', ['auth', 'token'], { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined)
    })
  })
}

/** Credentials → environment → the user's existing gh login, per operation. */
export class CoopCredentials {
  constructor(private readonly ctx: Context, private readonly reference: () => string, private readonly cli: () => Promise<string | undefined> = ghToken,
    private readonly source: () => 'auto' | 'github-cli' = () => 'auto') {}
  private async fromCli(): Promise<ResolvedToken | undefined> {
    const value = await this.cli()
    return value ? { value, source: 'GitHub CLI' } : undefined
  }
  async resolve(): Promise<ResolvedToken | undefined> {
    if (this.source() === 'github-cli') return this.fromCli()
    const ref = credentialRef(this.reference())
    const credentials = this.ctx.get('credentials')
    const native = await credentials?.resolve(ref)
    if (native) return native
    if (this.reference() !== 'GITHUB_TOKEN') {
      const shared = await credentials?.resolve(credentialRef('GITHUB_TOKEN'))
      if (shared) return shared
    }
    const environment = process.env[this.reference()] || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    if (environment) return { value: environment, source: 'environment' }
    return this.fromCli()
  }
  async describe(): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    if (this.source() === 'github-cli') return { configured: false, source: 'GitHub CLI', writable: false }
    const credentials = this.ctx.get('credentials')
    const info = await credentials?.describe(credentialRef(this.reference()))
    if (info?.configured) return info
    const shared = this.reference() !== 'GITHUB_TOKEN' ? await credentials?.describe(credentialRef('GITHUB_TOKEN')) : undefined
    if (shared?.configured) return shared
    const environment = process.env[this.reference()] || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    // View rendering never launches gh. A successful explicit connection supplies
    // the CLI account state separately from the credential-store status.
    return { configured: Boolean(environment), source: environment ? 'environment' : undefined, writable: info?.writable ?? false }
  }
}
