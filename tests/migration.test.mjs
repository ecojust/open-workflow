import test from 'node:test'
import assert from 'node:assert/strict'
import { contentKey, createDocument, parseDocument } from '../src/core/documents.ts'
import { DEFAULT_STYLE } from '../src/core/types.ts'

function legacyDocument() {
  const doc = createDocument('board')
  doc.title = '旧版已保存文档'
  delete doc.scene.defaultStyle
  const style = { stroke: '#334155', fill: '#ffffff', strokeWidth: 2, fontSize: 16, textAlign: 'center', opacity: 1, dashed: true }
  doc.scene.elements = [{ id: 'shape', type: 'shape', shape: 'rectangle', x: 10, y: 20, width: 100, height: 80, text: '已保存内容', locked: false, style }]
  return doc
}
function savedLegacyKey() {
  // Exact canonical value written by the pre-appearance application.
  return JSON.stringify(['旧版已保存文档', 'board', '#ffffff', true, [
    ['shape', 'shape', false, ['#334155', '#ffffff', 2, 16, 'center', 1, true], 'rectangle', 10, 20, 100, 80, '已保存内容', null],
  ], ''])
}

test('legacy saved keys migrate only for unchanged content; dirty and unrecognized keys stay dirty', async () => {
  const previous = globalThis.indexedDB
  const clean = legacyDocument()
  const dirty = legacyDocument(); dirty.id = 'dirty'; dirty.scene.elements[0].text = '尚未保存的修改'
  const unknown = legacyDocument(); unknown.id = 'unknown'
  const unsaved = legacyDocument(); unsaved.id = 'unsaved'
  const records = [
    { id: clean.id, document: clean, savedKey: savedLegacyKey(), lastOpened: 4 },
    { id: dirty.id, document: dirty, savedKey: savedLegacyKey(), lastOpened: 3 },
    { id: unknown.id, document: unknown, savedKey: 'not-a-valid-content-key', lastOpened: 2 },
    { id: unsaved.id, document: unsaved, savedKey: null, lastOpened: 1 },
  ]
  let db
  globalThis.indexedDB = {
    open() {
      db = { close() {}, transaction() { return { objectStore() { return { getAll() { const request = { result: structuredClone(records) }; queueMicrotask(() => request.onsuccess?.()); return request } } } } } }
      const request = { result: db }; queueMicrotask(() => request.onsuccess?.()); return request
    },
  }
  try {
    const { readDrafts } = await import('../src/core/storage.ts?legacy-key-test')
    const result = await readDrafts()
    assert.equal(result.skipped, 0)
    const byId = new Map(result.records.map(record => [record.id, record]))
    const restored = byId.get(clean.id)
    assert.notEqual(restored.savedKey, savedLegacyKey())
    assert.equal(restored.savedKey, contentKey(restored.document))
    assert.equal(restored.document.scene.elements[0].style.strokePattern, 'dashed')
    for (const id of ['dirty', 'unknown', 'unsaved']) assert.notEqual(byId.get(id).savedKey, contentKey(byId.get(id).document), id)
    assert.equal(byId.get('dirty').savedKey, savedLegacyKey())
    assert.equal(byId.get('unknown').savedKey, 'not-a-valid-content-key')
    assert.equal(byId.get('unsaved').savedKey, null)
    assert.deepEqual(records[0].document, clean, 'Reading must not mutate the stored input')
  } finally { db?.onversionchange(); globalThis.indexedDB = previous }
})

test('new appearance changes cannot be marked clean by a matching legacy key', async () => {
  const previous = globalThis.indexedDB
  const cases = []
  for (const mode of ['roughness', 'pattern', 'default-style', 'normalized-clean', 'current-clean']) {
    const doc = parseDocument(JSON.stringify(legacyDocument())); doc.id = mode
    if (mode === 'roughness') doc.scene.elements[0].style.roughness = 'sketch'
    if (mode === 'pattern') doc.scene.elements[0].style.strokePattern = 'dotted'
    if (mode === 'default-style') doc.scene.defaultStyle = { ...DEFAULT_STYLE, strokeWidth: 8 }
    cases.push({ id: mode, document: doc, savedKey: mode === 'current-clean' ? contentKey(doc) : savedLegacyKey(), lastOpened: 0 })
  }
  let db
  globalThis.indexedDB = {
    open() {
      db = { close() {}, transaction() { return { objectStore() { return { getAll() { const request = { result: structuredClone(cases) }; queueMicrotask(() => request.onsuccess?.()); return request } } } } } }
      const request = { result: db }; queueMicrotask(() => request.onsuccess?.()); return request
    },
  }
  try {
    const { readDrafts } = await import('../src/core/storage.ts?appearance-key-test')
    const { records, skipped } = await readDrafts()
    assert.equal(skipped, 0)
    for (const record of records) {
      if (record.id.endsWith('clean')) assert.equal(record.savedKey, contentKey(record.document), record.id)
      else {
        assert.equal(record.savedKey, savedLegacyKey(), record.id)
        assert.notEqual(record.savedKey, contentKey(record.document), record.id)
      }
    }
  } finally { db?.onversionchange(); globalThis.indexedDB = previous }
})
