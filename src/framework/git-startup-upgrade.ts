import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, relative } from 'node:path'
import type { DshAgentGateway } from '../adapters/dsh/agents.js'
import type { DshModelRoute } from '../adapters/dsh/host-types.js'
import type { FrameworkTransactions } from './command-transactions.js'
import { withSnapshot, type FilesStore } from './transactions.js'
import { LocalRecordFiles } from './local-record-files.js'
import { GitStartupUpgradeAgent, gitUpgradeWakePath } from './git-startup-upgrade-agent.js'
import { ensureGitUpgradeWake } from './git-upgrade-prepare.js'
import { observeGitUpgradePackage, gitUpgradePackagePath, type GitUpgradePackageFacts } from './git-upgrade-package.js'

/** One existing Git Running owner. A package signal admits preparation; the
 * addressed Git wake admits the independent upgrade Agent and restart cleanup.
 * Neither path creates a normal Task, RoleRecord, timer or recurring discovery. */
export class GitStartupUpgrade {
  private packageFacts?: GitUpgradePackageFacts
  private readonly agent: GitStartupUpgradeAgent
  constructor(private readonly ctx: Context, private readonly files: FilesStore, private readonly transactions: FrameworkTransactions,
    private readonly config: { hostModuleURL?: string; cwd: string; presetId?: string; model?: DshModelRoute; changed?(): void },
    gateway?: Pick<DshAgentGateway, 'create'>) {
    this.agent = new GitStartupUpgradeAgent(ctx, files, transactions, { ...config, beforeWakeRetirement: () => this.retirePackageSignal() }, gateway)
  }
  retryNativeRetirement() { return this.agent.retryNativeRetirement() }
  private async retirePackageSignal(): Promise<void> {
    const facts = this.packageFacts
    if (!facts || facts.startup.state === 'absent') return
    const withinProfile = facts.profile ? relative(facts.profile.directory, facts.packageDirectory) : undefined
    // This candidate implements the documented independent profile installation.
    // Shared-package retirement has no complete owner set in the current API;
    // preserve its signals after conversion instead of deleting another root's wakeup.
    if (!withinProfile || isAbsolute(withinProfile) || withinProfile === '..' || withinProfile.startsWith('../') || withinProfile.startsWith('..\\')
      || facts.linkedRoot || facts.resolution?.scope === 'installation' || facts.profileLocal !== true) {
      throw new Error('Git conversion is retained. Retirement of this shared or unassigned package startup file is not resolved by the current installation facts.')
    }
    const local = new LocalRecordFiles(facts.packageDirectory)
    if (await local.deleteObserved(gitUpgradePackagePath, facts.startup.version)) return
    if (await local.fileInfo(gitUpgradePackagePath) !== undefined) throw new Error('The package startup file changed; preserve that newer signal.')
  }
  async start(signal: AbortSignal): Promise<'not-needed' | 'pending' | 'complete' | 'converted-native-pending'> {
    signal.throwIfAborted()
    // A retained Git wake is still consumed after package unlink. This exact
    // existence read is not a skills scan and is not conditional on the package.
    const existing = await withSnapshot(this.files, snapshot => this.files.read(snapshot, gitUpgradeWakePath), { signal })
    if (this.config.hostModuleURL) {
      const observed = await observeGitUpgradePackage(this.ctx, this.config.hostModuleURL)
      if (observed.state !== 'observed') throw new Error('Package startup observation is unavailable: ' + observed.reason)
      this.packageFacts = observed.facts
    }
    if (existing === undefined) {
      if (this.packageFacts?.startup.state !== 'present') return 'not-needed'
      const prepared = await ensureGitUpgradeWake(this.files, this.transactions, signal)
      if (prepared.status === 'no-originals') { signal.throwIfAborted(); await this.retirePackageSignal(); return 'not-needed' }
    }
    return this.agent.start(signal)
  }
}
