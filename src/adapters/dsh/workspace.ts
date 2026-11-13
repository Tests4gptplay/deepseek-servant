import { ensureWriteDirectory } from '../../framework/write-directories.js'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { WorkspaceBinding } from '../../contracts/task.js'

/** Servant resolves its selection independently of the currently open ordinary chat. */
export class DshWorkspaceAdapter {
  constructor(private readonly ctx: Context) {}

  list(): Array<WorkspaceBinding & { title: string }> {
    return this.ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, directory: workspace.path, title: workspace.title }))
  }

  async resolve(selectedId?: string, customDirectory?: string): Promise<WorkspaceBinding> {
    const registry = this.ctx.workspaceRegistry
    if (customDirectory !== undefined) {
      if (selectedId !== undefined) throw new Error('Select a registered workspace or a custom directory, not both.')
      // Prepare the selected directory, then native creation validates and reuses its
      // canonical identity. It does not select it or change the host default.
      const selected = await registry.create(await ensureWriteDirectory(customDirectory.trim()))
      return { id: selected.id, directory: selected.path }
    }
    if (selectedId !== undefined && selectedId.length > 0) {
      const selected = registry.get(WorkspaceId(selectedId))
      if (selected === undefined) throw new Error(`The selected Servant workspace no longer exists: ${selectedId}`)
      await ensureWriteDirectory(selected.path)
      return { id: selected.id, directory: selected.path }
    }
    const directory = this.ctx.get('workingDirectory')?.defaultDirectory
    let initialized = false
    const existingDefault = await registry.initializeDefault(async () => {
      if (directory === undefined) throw new Error('DSH has no default workspace or default working directory. Select a Servant workspace.')
      initialized = true
      return directory
    })
    if (existingDefault !== undefined) {
      // Native creation already prepared this directory. Existing registrations
      // still need repair when their directory has since been removed.
      if (!initialized) await ensureWriteDirectory(existingDefault.path)
      return { id: existingDefault.id, directory: existingDefault.path }
    }
    if (directory === undefined) throw new Error('DSH has no default workspace or default working directory. Select a Servant workspace.')
    const prepared = await ensureWriteDirectory(directory)
    const fallback = await registry.resolveByPath(prepared) ?? await registry.create(prepared)
    return { id: fallback.id, directory: fallback.path }
  }
}
