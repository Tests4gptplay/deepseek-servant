import { execFile as probePythonProcess } from 'node:child_process'
import { access as accessWindowsPython } from 'node:fs/promises'
import { homedir as pythonUserHome } from 'node:os'
import { isAbsolute as isPythonPathAbsolute, join as joinPythonPath } from 'node:path'
import { gitRuntimeEnvironment } from './git-runtime-environment.js'

// DSH Desktop documents this installed payload location. Do not install the
// payload, scan users' folders, or change PATH to find an interpreter.
export function installedDshPython(env: NodeJS.ProcessEnv, home = pythonUserHome()): string | undefined {
  const root = env.DSH_HOME || joinPythonPath(home, '.dsh')
  return isPythonPathAbsolute(root) ? joinPythonPath(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe') : undefined
}
export interface PythonCandidate { executable: string; args: string[] }
export async function probePython(candidate: PythonCandidate, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise(resolve => {
    probePythonProcess(candidate.executable, [...candidate.args, '-I', '-B', '-c', 'import sys,json; print(json.dumps({"version":sys.version_info[0],"executable":sys.executable}))'],
      { env: gitRuntimeEnvironment(env), windowsHide: true, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
        if (error) return resolve(undefined)
        try {
          const value = JSON.parse(stdout.trim())
          resolve(value.version === 3 && typeof value.executable === 'string' && isPythonPathAbsolute(value.executable) ? value.executable : undefined)
        } catch { resolve(undefined) }
      })
  })
}
export async function findWindowsPython(env = process.env, probe = probePython): Promise<string> {
  const runtime = installedDshPython(env)
  const candidates: PythonCandidate[] = []
  if (runtime && await accessWindowsPython(runtime).then(() => true, () => false)) candidates.push({ executable: runtime, args: [] })
  candidates.push({ executable: 'py', args: ['-3'] }, { executable: 'python3', args: [] })
  for (const candidate of candidates) {
    const executable = await probe(candidate, env)
    if (executable) return executable
  }
  throw new Error('Memory Git could not find a working Python 3 interpreter after the default python command was unavailable (including WindowsApps alias exit 9009). No dependencies were installed and PATH was not changed.')
}
// Only consulted after Windows' default python failed to launch. Cache success
// for this host lifetime, not a probe before every Git operation. A failed
// discovery is shared only while in flight; a later new helper may retry after
// the environment has been repaired.
let resolvedWindowsPythonExecutable: string | undefined
let fallback: Promise<string> | undefined
export function windowsDefaultPython(): string { return resolvedWindowsPythonExecutable ?? 'python' }
export function windowsPythonFallback(): Promise<string> {
  return fallback ??= findWindowsPython().then(executable => resolvedWindowsPythonExecutable = executable).catch(error => {
    fallback = undefined
    throw error
  })
}
