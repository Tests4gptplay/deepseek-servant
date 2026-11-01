import { execFile } from 'node:child_process'
import { GitHubError, GITHUB_CLI_SETUP_REQUIRED, type ResolvedToken } from './github.js'

export async function ghToken(signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    // AbortSignal terminates only this execFile child, not other CLI instances.
    execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { signal, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // Native AbortError carries its real cause. A later owner abort must not
      // replace an independent CLI failure with this owner's reason.
      if (error?.name === 'AbortError') { reject(error); return }
      if (signal?.aborted) { reject(signal.reason); return }
      resolve(error ? undefined : stdout.trim() || undefined)
    })
  })
}

/** Use the current GitHub CLI login for each operation. */
export class CoopCredentials {
  constructor(private readonly cli: (signal?: AbortSignal) => Promise<string | undefined> = ghToken) {}
  async resolve(signal?: AbortSignal): Promise<ResolvedToken> {
    signal?.throwIfAborted()
    const value = await this.cli(signal)
    signal?.throwIfAborted()
    if (!value) throw new GitHubError(401, GITHUB_CLI_SETUP_REQUIRED)
    return { value, source: 'GitHub CLI' }
  }
}
