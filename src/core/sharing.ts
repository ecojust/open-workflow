import { contentKey, validateDocument } from './documents.ts'
import type { WorkflowDocument } from './types.ts'

export interface SharedSnapshot { sessionId: string; revision: number; document: WorkflowDocument }
export interface SharedWriteRequest { sessionId: string; baseRevision: number; document: WorkflowDocument }
export interface SharedWriteResult { accepted: boolean; snapshot: SharedSnapshot }
export interface ServerStatus {
  running: boolean
  sessionId?: string
  port?: number
  urls: string[]
  localUrl?: string
  documentId?: string
  title?: string
}
export interface ServerStartResult { status: ServerStatus; snapshot: SharedSnapshot }

/** Share only the editable document, excluding preserved import data and file locations. */
export function sharedDocument(value: unknown): WorkflowDocument {
  const document = validateDocument(value)
  delete document.importSource
  return document
}
export function sharedContentKey(value: WorkflowDocument): string { return contentKey(sharedDocument(value)) }

export function validateSharedSnapshot(value: unknown): SharedSnapshot {
  if (!value || typeof value !== 'object') throw new Error('共享文档响应无效。')
  const snapshot = value as Partial<SharedSnapshot>
  if (typeof snapshot.sessionId !== 'string' || !snapshot.sessionId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision! < 1) throw new Error('共享文档版本无效。')
  return { sessionId: snapshot.sessionId, revision: snapshot.revision!, document: sharedDocument(snapshot.document) }
}
