import { execFile } from 'node:child_process'
import { GitHubError, GITHUB_CLI_SETUP_REQUIRED, type ResolvedToken } from './github.js'

export function ghToken(): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined)
    })
  })
}

/** Use the current GitHub CLI login for each operation. */
export class CoopCredentials {
  constructor(private readonly cli: () => Promise<string | undefined> = ghToken) {}
  async resolve(): Promise<ResolvedToken> {
    const value = await this.cli()
    if (!value) throw new GitHubError(401, GITHUB_CLI_SETUP_REQUIRED)
    return { value, source: 'GitHub CLI' }
  }
}
