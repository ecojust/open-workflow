import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STYLE, emptyScene } from '../src/core/types.ts'
import { applyGlobalLineStyle, resolveStrokePattern, sceneDefaultStyle } from '../src/core/appearance.ts'
import { contentKey, createDocument, DocumentHistory, parseDocument, serializeDocument, validateScene } from '../src/core/documents.ts'

test('explicit line patterns take priority and legacy dashed styles retain their meaning', () => {
  assert.equal(resolveStrokePattern({ dashed: true }), 'dashed')
  assert.equal(resolveStrokePattern({ dashed: false }), 'solid')
  assert.equal(resolveStrokePattern({ dashed: true, strokePattern: 'solid' }), 'solid')
  assert.equal(resolveStrokePattern({ dashed: false, strokePattern: 'dotted' }), 'dotted')
  const doc = createDocument('flow', true)
  delete doc.scene.defaultStyle
  for (const element of doc.scene.elements) {
    delete element.style.roughness
    delete element.style.strokePattern
    element.style.dashed = true
  }
  const oldKey = contentKey(doc)
  const restored = parseDocument(JSON.stringify(doc))
  assert.equal(restored.version, 1)
  assert.deepEqual(restored.scene.defaultStyle, DEFAULT_STYLE)
  for (const element of restored.scene.elements) {
    assert.equal(element.style.strokePattern, 'dashed')
    assert.equal(element.style.dashed, true)
    assert.equal(element.style.roughness, 'clean')
  }
  assert.equal(contentKey(restored), oldKey)
  assert.deepEqual(parseDocument(serializeDocument(restored)), restored)
})

test('scene defaults are detached, persisted, and normalize legacy dashed defaults', () => {
  const scene = emptyScene()
  const defaults = sceneDefaultStyle(scene)
  defaults.stroke = '#ff0000'
  assert.equal(scene.defaultStyle.stroke, DEFAULT_STYLE.stroke)
  const legacy = { ...DEFAULT_STYLE, dashed: true }
  delete legacy.strokePattern
  const normalized = sceneDefaultStyle({ ...scene, defaultStyle: legacy })
  assert.equal(normalized.strokePattern, 'dashed')
  assert.equal(normalized.dashed, true)
  const doc = createDocument('board')
  doc.scene.defaultStyle = { ...DEFAULT_STYLE, roughness: 'sketch', strokePattern: 'dotted', dashed: false, strokeWidth: 5 }
  const restored = parseDocument(serializeDocument(doc))
  assert.equal(restored.scene.defaultStyle.roughness, 'sketch')
  assert.equal(restored.scene.defaultStyle.strokePattern, 'dotted')
  assert.equal(restored.scene.defaultStyle.dashed, true)
  assert.equal(contentKey(restored), contentKey(doc))
})

test('global line style updates locked shapes, edges, pen strokes and future defaults without touching other properties', () => {
  const doc = createDocument('flow', true)
  doc.scene.elements[0].locked = true
  doc.scene.elements[0].style.fill = '#abcdef'
  doc.scene.elements[0].style.opacity = 0.4
  doc.scene.elements.push({ id: 'ink', type: 'stroke', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], style: { ...DEFAULT_STYLE, fontSize: 28, textAlign: 'left' }, locked: true })
  const original = structuredClone(doc.scene)
  const result = applyGlobalLineStyle(doc.scene, { roughness: 'sketch', strokePattern: 'dotted', strokeWidth: 4, stroke: '#345678' })
  assert.deepEqual(doc.scene, original)
  for (const element of result.elements) {
    const before = original.elements.find(item => item.id === element.id)
    assert.deepEqual({ ...element, style: before.style }, before)
    assert.deepEqual(element.style, { ...before.style, roughness: 'sketch', strokePattern: 'dotted', dashed: true, strokeWidth: 4, stroke: '#345678' })
  }
  assert.deepEqual(result.defaultStyle, { ...DEFAULT_STYLE, roughness: 'sketch', strokePattern: 'dotted', dashed: true, strokeWidth: 4, stroke: '#345678' })
  result.elements[0].style.fill = '#000000'
  result.elements.at(-1).points[0].x = 99
  assert.deepEqual(doc.scene, original)
  const solid = applyGlobalLineStyle(result, { strokePattern: 'solid' })
  assert.ok(solid.elements.every(element => !element.style.dashed && element.style.strokePattern === 'solid' && element.style.roughness === 'sketch'))
  assert.equal(solid.defaultStyle.dashed, false)
})

test('default-only changes on an empty canvas participate in saved identity and undo', () => {
  const doc = createDocument('board'), initial = contentKey(doc), history = new DocumentHistory(doc)
  doc.scene = applyGlobalLineStyle(doc.scene, { roughness: 'sketch', strokePattern: 'dashed' })
  assert.notEqual(contentKey(doc), initial)
  history.commit(doc)
  assert.equal(contentKey(history.undo()), initial)
  const redone = history.redo()
  assert.equal(redone.scene.defaultStyle.roughness, 'sketch')
  assert.equal(redone.scene.defaultStyle.strokePattern, 'dashed')
  assert.equal(contentKey(parseDocument(serializeDocument(redone))), contentKey(redone))
})

test('invalid new styles are rejected and undefined global patch fields do not erase existing appearance', () => {
  const doc = createDocument('flow', true)
  doc.scene.elements[0].style.roughness = 'extreme'
  assert.throws(() => validateScene(doc.scene), /线条外观/)
  doc.scene.elements[0].style.roughness = 'clean'
  doc.scene.defaultStyle.strokePattern = 'zigzag'
  assert.throws(() => validateScene(doc.scene), /线型/)
  assert.throws(() => applyGlobalLineStyle(emptyScene(), { strokeWidth: Infinity }), /线宽/)
  assert.throws(() => applyGlobalLineStyle(emptyScene(), { roughness: 'extreme' }), /线条外观/)
  const original = applyGlobalLineStyle(emptyScene(), { roughness: 'sketch', strokePattern: 'dotted' })
  assert.deepEqual(applyGlobalLineStyle(original, { roughness: undefined, strokePattern: undefined }), original)
})
