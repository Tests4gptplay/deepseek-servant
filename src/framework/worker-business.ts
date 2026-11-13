import { createHash } from 'node:crypto'
import type { WorkIdentity } from './recovery.js'
import { readJson } from './task-files.js'
import type { FilesSnapshot, FilesStore } from './transactions.js'

// The committed transition ends this execution's business ownership. Native
// disposal is separate and may still be draining; no recipient acknowledgement.
export interface WorkerBusinessTransfer<R = { identity: WorkIdentity; sessionId: string; generation: number }> {
  version: 1
  record: R
  /** Worker identity by default; member identity for a Planner checkpoint. */
  successorId: string
  successorRole?: 'Worker' | 'Planner'
}
export const workerTransferRoot = (scope: string) => 'technical/worker-transfers/' + createHash('sha256').update(scope).digest('hex') + '/'
export const workerTransferPath = (scope: string, executionId: string) => workerTransferRoot(scope) + encodeURIComponent(executionId) + '.json'
export async function assertWorkerBusiness(files: FilesStore, snapshot: FilesSnapshot, scope: string, identity: WorkIdentity): Promise<void> {
  if (identity.role !== 'Worker') return
  if (await readJson(files, snapshot, workerTransferPath(scope, identity.executionId)))
    throw new Error('This Worker execution has transferred its business responsibility.')
}
