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
  constructor(private readonly ctx: Context, private readonly reference: () => string, private readonly cli: () => Promise<string | undefined> = ghToken) {}
  async resolve(): Promise<ResolvedToken | undefined> {
    const ref = credentialRef(this.reference())
    const credentials = this.ctx.get('credentials')
    const native = await credentials?.resolve(ref)
    if (native) return native
    const environment = process.env[this.reference()]
    if (environment) return { value: environment, source: 'environment' }
    const value = await this.cli()
    return value ? { value, source: 'GitHub CLI' } : undefined
  }
  async describe(): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    const credentials = this.ctx.get('credentials')
    const info = await credentials?.describe(credentialRef(this.reference()))
    // View rendering never launches gh. A successful explicit connection supplies
    // the CLI account state separately from the credential-store status.
    return info ?? { configured: Boolean(process.env[this.reference()]), source: process.env[this.reference()] ? 'environment' : undefined, writable: false }
  }
}
