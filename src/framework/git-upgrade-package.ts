import type { Context } from '@deepseek-ai/cordis'
import type { PluginPackages, ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalRecordFiles } from './local-record-files.js'

export const gitUpgradePackagePath = 'upgrades/g09-skills-once.json'
export interface GitUpgradePackageFacts {
  packageDirectory: string
  packageVersion: string | undefined
  hostModulePath: string
  profile: { directory: string; installAnchor: string } | undefined
  resolution: { scope: 'installation' | 'profile'; declarer: string } | undefined
  profileLocal: boolean | undefined
  linkedRoot: string | undefined
  startup: { state: 'absent' } | { state: 'present'; sha256: string; version: string }
}
export type GitUpgradePackageObservation =
  | { state: 'observed'; facts: GitUpgradePackageFacts }
  | { state: 'unavailable'; reason: 'package-service-absent' | 'package-unresolved' | 'host-package-mismatch' }

/** Exact package facts only. Profile scope is not a claim of exclusive ownership.
 * No profile scan, source discovery, write, removal, model call or business gate.
 * The eventual Host caller supplies its own built module URL, not a Git path. */
export async function observeGitUpgradePackage(ctx: Context, hostModuleURL: string): Promise<GitUpgradePackageObservation> {
  const packages: PluginPackages | undefined = ctx.get('pluginPackages')
  if (!packages) return { state: 'unavailable', reason: 'package-service-absent' }
  const selected = packages.packageOf('deepseek-servant', hostModuleURL)
  if (!selected || selected.name !== 'deepseek-servant') return { state: 'unavailable', reason: 'package-unresolved' }
  const packageDirectory = await realpath(selected.dir)
  const hostModulePath = await realpath(fileURLToPath(hostModuleURL))
  if (hostModulePath !== await realpath(join(packageDirectory, 'lib/host.js'))) {
    return { state: 'unavailable', reason: 'host-package-mismatch' }
  }
  const profile: ProfileContext | undefined = ctx.get('profileContext')
  const entry = packages.resolution?.entries.find(row => row.name === selected.name && row.packageDir === selected.dir)
  const linkedRoot = packages.resolution?.linkedRoots.find(row => row.name === selected.name && row.realPath === packageDirectory)?.realPath
  const files = new LocalRecordFiles(packageDirectory), observed = await files.fileInfo(gitUpgradePackagePath)
  const bytes = await files.readBytes(gitUpgradePackagePath)
  let startup: GitUpgradePackageFacts['startup'] = { state: 'absent' }
  if (bytes !== undefined) {
    if (!observed || (await files.fileInfo(gitUpgradePackagePath))?.version !== observed.version) throw new Error('Package startup file changed while reading.')
    const marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (marker?.kind !== 'dss-g09-git-skills-bootstrap' || marker.version !== 1) {
      throw new Error('Unrecognized DSS Git upgrade startup file.')
    }
    startup = { state: 'present', version: observed.version, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  return { state: 'observed', facts: { packageDirectory, packageVersion: selected.version, hostModulePath,
    profile: profile ? { directory: profile.dir, installAnchor: profile.installAnchor } : undefined,
    resolution: entry ? { scope: entry.scope, declarer: entry.declarer } : undefined,
    profileLocal: packages.resolution?.localPackageNames.includes(selected.name), linkedRoot, startup } }
}
