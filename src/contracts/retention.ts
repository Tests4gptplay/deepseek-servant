export interface NativeSessionRetirement {
  sessionId: string
  state: 'pending' | 'archived' | 'absent' | 'blocked'
  /** rc.2 retirement archives the catalog entry; it does not erase its native log. */
  logRetained: boolean
  retainedBytes?: number
  reason?: string
  updatedAt?: string
}
export interface TaskArchive {
  schemaVersion: 1
  archivedAt: string
  purgeId: string
  originalBytes: number
  retainedResultIds: string[]
  sessions: NativeSessionRetirement[]
  memoryState: 'pending' | 'done'
  memoryReason?: string
  unresolvedAtCancellation?: { waits: number; incidents: number }
}
/** Actual owned record-file bytes; native Session logs and artifacts are separate. */
export interface StorageUsageStats {
  totalBytes: number
  permanentBytes: number
  temporaryBytes: number
  recordedAt: string
  permanent: {
    chatBytes: number
    assistantBytes: number
    knowledgeBytes: number
    originBytes: number
    archiveBytes: number
    planningBytes: number
    debugBytes?: number
  }
  temporary: {
    taskBytes: number
    plannerMemoryBytes: number
    plannerNoteBytes: number
    workerReplyBytes: number
    executionBytes: number
    heartbeatBytes: number
    recoveryBytes: number
  }
}
