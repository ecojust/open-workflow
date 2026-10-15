import { contentKey, parseDocument, serializeDocument } from './documents.ts'
import { normalizeDiagramStyle } from './diagram-appearance.ts'
import type { WorkflowDocument } from './types.ts'

export interface DraftRecord { id: string; document: WorkflowDocument; savedKey: string | null; lastOpened: number }

/** Upgrade only a provably unchanged pre-appearance saved snapshot. */
function migrateSavedKey(document: WorkflowDocument, savedKey: unknown): string | null {
  if (typeof savedKey !== 'string') return null
  const currentKey = contentKey(document)
  if (savedKey === currentKey) return savedKey
  if (normalizeDiagramStyle(document.diagramStyle) !== 'classic') return savedKey
  if (document.scene.elements.some(element => element.type === 'stroke' && (element.brush !== undefined || element.pressures !== undefined))) return savedKey
  const elements = document.scene.elements.map(element => {
    const s = element.style
    const base = [element.id, element.type, element.locked, [s.stroke, s.fill, s.strokeWidth, s.fontSize, s.textAlign, s.opacity, s.dashed]]
    if (element.type === 'shape') return [...base, element.shape, element.x, element.y, element.width, element.height, element.text, element.imageData ?? null]
    if (element.type === 'edge') return [...base, [element.from.x, element.from.y, element.from.nodeId ?? null], [element.to.x, element.to.y, element.to.nodeId ?? null], element.label, element.arrow, element.route]
    return [...base, element.points.map(point => [point.x, point.y])]
  })
  const legacyKey = JSON.stringify([document.title, document.kind, document.scene.background, document.scene.grid, elements, document.source])
  if (savedKey !== legacyKey) return savedKey
  // The old key did not cover appearance, grouping or closed strokes. A draft
  // modified with those features must remain dirty even if its old fields match.
  const legacyScene = {
    background: document.scene.background, grid: document.scene.grid,
    elements: document.scene.elements.map(element => {
      const { roughness: _roughness, strokePattern: _strokePattern, ...style } = element.style
      const legacyElement = { ...element }; delete legacyElement.groupId
      if (legacyElement.type === 'stroke') delete legacyElement.closed
      return { ...legacyElement, style }
    }),
  }
  return contentKey({ ...document, scene: legacyScene }) === currentKey ? currentKey : savedKey
}

const database = 'open-workflow-v1'
let connection: Promise<IDBDatabase> | undefined
function openDatabase(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' })
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); connection = undefined }
      db.onclose = () => { connection = undefined }
      resolve(db)
    }
    request.onerror = () => { connection = undefined; reject(request.error || new Error('无法打开本地草稿库。')) }
    request.onblocked = () => { connection = undefined; reject(new Error('本地草稿库被其他窗口占用，请关闭其他窗口后重试。')) }
  })
  return connection
}
export async function putDraft(record: DraftRecord): Promise<void> {
  // Serialize now so a later edit cannot change the payload while the DB opens.
  const snapshot = { ...record, document: JSON.parse(serializeDocument(record.document)) }
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite')
    transaction.objectStore('drafts').put(snapshot)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('本地草稿写入失败。'))
    transaction.onabort = () => reject(transaction.error || new Error('本地草稿写入中断。'))
  })
}
export async function readDrafts(): Promise<{ records: DraftRecord[]; skipped: number }> {
  const db = await openDatabase()
  const raw = await new Promise<any[]>((resolve, reject) => {
    const request = db.transaction('drafts', 'readonly').objectStore('drafts').getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const records: DraftRecord[] = []
  let skipped = 0
  for (const entry of raw) {
    try {
      const document = parseDocument(JSON.stringify(entry.document))
      records.push({ id: document.id, document, savedKey: migrateSavedKey(document, entry.savedKey), lastOpened: Number(entry.lastOpened) || 0 })
    } catch { skipped++ }
  }
  return { records: records.sort((a, b) => b.lastOpened - a.lastOpened), skipped }
}
export async function deleteDraft(id: string): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite')
    transaction.objectStore('drafts').delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('本地草稿删除中断。'))
  })
}
