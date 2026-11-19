/** Exact native workspace-account maintenance for an accepted retirement.
 * Mirrors only the installed WorkspaceEntity's durable snapshot update, not
 * detachSession's unrelated stale-candidate pruning. No workspace is deleted.
 */
export async function removeWorkspaceAccount(ctx, life, verify) {
  const registry=ctx.get('workspaceRegistry'),domain=ctx.get('storageDomain')?.get('workspace');
  if(!registry||!domain)return {status:'not-mounted'};
  const table=domain.table('workspaces');
  if(typeof table.update!=='function')throw new Error('Unsupported native workspace table');
  const entities=registry.list();
  for(const workspace of entities){
    const record=table.get(workspace.id);
    if(!record?.sessionIds?.includes(life.id))continue;
    // The installed entity owns this writable snapshot, updated after the same
    // table.update path. Refuse unfamiliar runtimes rather than patch services.
    const descriptor=Object.getOwnPropertyDescriptor(workspace,'record');
    if(!descriptor?.writable||!Array.isArray(descriptor.value?.sessionIds)||descriptor.value.path!==record.path)
      throw new Error('Unsupported native workspace entity snapshot');
    verify();
    const next=await table.update(workspace.id,current=>{
      verify();
      if(registry.get(workspace.id)!==workspace)throw new Error('Native workspace owner changed');
      return {...current,sessionIds:current.sessionIds.filter(id=>id!==life.id),updatedAt:new Date().toISOString()};
    });
    // Native entity mutations use the same queue and post-commit publication.
    // Never recreate a deleted workspace or replace a newer entity.
    if(registry.get(workspace.id)===workspace)workspace.record=next;
  }
  return {status:'removed'};
}
