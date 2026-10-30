// Adapted from lxj808624/dsh-tool-git v0.1.3; adds bounded operation timeouts.
// MIT, Copyright (c) 2026 dsh-tool-git contributors. See THIRD_PARTY_NOTICES.md.
/**
 * Safe Git subprocess runner.
 *
 * Every command goes through `spawn` with an explicit argument array — no
 * shell, no string interpolation — so model-supplied paths and messages can
 * never inject shell syntax. Machine output is kept deterministic with
 * `-c core.quotepath=false` (non-ASCII paths stay unquoted UTF-8) and
 * `--no-optional-locks` (read-only commands never take advisory locks).
 * @module dsh-tool-git/runner
 */

import { spawn } from 'node:child_process'

/** One completed `git` invocation. */
export interface GitRunResult {
  /** Raw stdout bytes, decoded as UTF-8. */
  stdout: string
  /** Raw stderr bytes, decoded as UTF-8. */
  stderr: string
  /** Process exit code. */
  code: number
}

/** A `git` invocation that exited non-zero. */
export class GitError extends Error {
  /** Process exit code. */
  readonly code: number
  /** Raw stderr from the failed invocation. */
  readonly stderr: string
  /** Raw stdout from the failed invocation. */
  readonly stdout: string

  constructor(message: string, code: number, stderr: string, stdout = '') {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.stderr = stderr
    this.stdout = stdout
  }
}

/** Options for {@link runGit}. */
export interface RunGitOptions {
  /** Working directory the subprocess runs in. */
  cwd: string
  /** Abort the subprocess when this signal fires. */
  signal?: AbortSignal
  /** Maximum duration of one command; defaults to five minutes. */
  timeoutMs?: number
  /** Extra environment variables merged over `process.env`. */
  env?: NodeJS.ProcessEnv
}

/**
 * Run `git` with the given arguments and return its output.
 * @param gitPath - the `git` executable to invoke (defaults to `git`).
 * @param args - argument array; never shell-interpreted.
 * @param opts - run options.
 * @returns the raw result; callers interpret exit codes.
 */
export function runGit(gitPath: string, args: string[], opts: RunGitOptions): Promise<GitRunResult> {
  const fullArgs = ['-c', 'core.quotepath=false', '--no-optional-locks', ...args]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Never block on interactive credential or editor prompts.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    ...opts.env,
  }
  return new Promise<GitRunResult>((resolve, reject) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let settled = false, timedOut = false
    const child = spawn(gitPath, fullArgs, {
      cwd: opts.cwd, env, signal: opts.signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timeoutMs = opts.timeoutMs ?? 300_000
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs) : undefined
    timer?.unref()
    const stop = () => { if (timer) clearTimeout(timer) }
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', error => {
      if (settled) return
      settled = true; stop()
      const errno = (error as NodeJS.ErrnoException).code
      reject(errno === 'ENOENT' ? new Error(`git executable not found: ${gitPath}`) : error)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true; stop()
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: code ?? 128 }
      if (timedOut) {
        reject(new GitError('Git operation timed out after ' + timeoutMs + ' ms.', 124, result.stderr, result.stdout))
      } else if (code !== 0) {
        reject(new GitError(result.stderr.trim() || `git exited with ${signal ? 'signal ' + signal : 'code ' + result.code}`,
          result.code, result.stderr, result.stdout))
      } else resolve(result)
    })
  })
}

/**
 * Run `git` and require a zero exit code.
 * @param gitPath - the `git` executable to invoke.
 * @param args - argument array.
 * @param opts - run options.
 * @returns the raw result of the successful invocation.
 * @throws {@link GitError} when the exit code is non-zero.
 */
export async function runGitChecked(
  gitPath: string,
  args: string[],
  opts: RunGitOptions,
): Promise<GitRunResult> {
  const result = await runGit(gitPath, args, opts)
  if (result.code !== 0) {
    throw new GitError(
      result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} exited with code ${result.code}`,
      result.code,
      result.stderr,
      result.stdout,
    )
  }
  return result
}
