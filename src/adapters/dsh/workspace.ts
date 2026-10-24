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

  async resolve(selectedId?: string): Promise<WorkspaceBinding> {
    const registry = this.ctx.workspaceRegistry
    if (selectedId !== undefined && selectedId.length > 0) {
      const selected = registry.get(WorkspaceId(selectedId))
      if (selected === undefined) throw new Error(`The selected Servant workspace no longer exists: ${selectedId}`)
      return { id: selected.id, directory: selected.path }
    }
    const directory = this.ctx.get('workingDirectory')?.defaultDirectory
    const existingDefault = await registry.initializeDefault(async () => {
      if (directory === undefined) throw new Error('DSH has no default workspace or default working directory. Select a Servant workspace.')
      return directory
    })
    if (existingDefault !== undefined) return { id: existingDefault.id, directory: existingDefault.path }
    if (directory === undefined) throw new Error('DSH has no default workspace or default working directory. Select a Servant workspace.')
    const fallback = await registry.resolveByPath(directory) ?? await registry.create(directory)
    return { id: fallback.id, directory: fallback.path }
  }
}
