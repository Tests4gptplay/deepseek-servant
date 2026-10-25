import type { CommandSource } from './task.js'

export type RecordKind = 'planner-memory' | 'planner-note' | 'worker-reply' | 'task-origin' | 'recovery' | 'execution' | 'conversation'
export interface RecordScope {
  kind: RecordKind
  taskId?: string
  childId?: string
  assistantId?: string
  date?: string
}
export interface RecordPart { key: string; characters: number; bytes: number; sha256: string }
export interface RecordEntry {
  schemaVersion: 1
  kind: 'servant-record-entry'
  ref: string
  scope: RecordScope
  sequence: number
  commandId: string
  fingerprint: string
  createdAt: string
  source: CommandSource
  characters: number
  bytes: number
  sha256: string
  parts: RecordPart[]
  metadata: Record<string, unknown>
}
export interface RecordAppend {
  scope: RecordScope
  commandId: string
  text: string
  source: CommandSource
  createdAt?: string
  expectedRevision?: number
  metadata?: Record<string, unknown>
}
export interface RecordSummary extends Omit<RecordEntry, 'parts' | 'fingerprint'> {}
export interface RecordPage {
  entries: RecordSummary[]
  nextCursor?: number
  revision: number
}
export interface RecordRead {
  entry: RecordSummary
  text: string
  cursor: number
  nextCursor?: number
}
