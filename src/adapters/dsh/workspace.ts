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

  async resolve(selectedId?: string, customDirectory?: string): Promise<{ id?: string; directory: string }> {
    const registry = this.ctx.workspaceRegistry
    if (customDirectory !== undefined) {
      if (selectedId !== undefined) throw new Error('Select a registered workspace or a custom directory, not both.')
      // A Servant physical output directory is not a request to add a native
      // front-end Workspace. Preserve existing registrations without creating one.
      const directory = await ensureWriteDirectory(customDirectory.trim())
      const selected = await registry.resolveByPath(directory)
      return selected ? { id: selected.id, directory: selected.path } : { directory }
    }
    if (selectedId !== undefined && selectedId.length > 0) {
      const selected = registry.get(WorkspaceId(selectedId))
      if (selected === undefined) throw new Error(`The selected Servant workspace no longer exists: ${selectedId}`)
      await ensureWriteDirectory(selected.path)
      return { id: selected.id, directory: selected.path }
    }
    // Preserve the host's existing persistent default through its public API.
    // Refuse only the optional creation callback before a new Workspace is registered.
    const noDefaultCreation = {}
    let existingDefault: Awaited<ReturnType<typeof registry.initializeDefault>> = undefined
    try {
      existingDefault = await registry.initializeDefault(async () => { throw noDefaultCreation })
    } catch (error) {
      if (error !== noDefaultCreation) throw error
    }
    if (existingDefault !== undefined) {
      await ensureWriteDirectory(existingDefault.path)
      return { id: existingDefault.id, directory: existingDefault.path }
    }
    const directory = this.ctx.get('workingDirectory')?.defaultDirectory
    if (directory === undefined) throw new Error('DSH has no default working directory. Select a Servant workspace.')
    // Resolving a physical default is read-only with respect to the native list.
    // The host/user owns Workspace creation; Servant only prepares its directory.
    const prepared = await ensureWriteDirectory(directory)
    const selected = await registry.resolveByPath(prepared)
    return selected ? { id: selected.id, directory: selected.path } : { directory: prepared }
  }
}
