import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STYLE } from '../src/core/types.ts'
import { createDocument, contentKey, serializeDocument, parseDocument, validateScene, DocumentHistory } from '../src/core/documents.ts'
import { importGraphXml, exportGraphXml } from '../src/formats/graph-xml.ts'
import { importBoardJson, exportBoardJson } from '../src/formats/board-json.ts'
import { DOMParser } from '@xmldom/xmldom'
import { compileCodeDiagram } from '../src/core/code-diagram.ts'
globalThis.DOMParser = DOMParser
const shapes = ['triangle', 'hexagon', 'star', 'parallelogram', 'cylinder', 'cloud', 'frame']
function scene() {
  return validateScene({ background: '#ffffff', grid: true, elements: [
    ...shapes.map((shape, index) => ({ id: `shape-${shape}`, type: 'shape', shape, x: index * 200, y: 0, width: 180, height: 120, text: shape, groupId: index < 3 ? 'group-first' : undefined, locked: false, style: { ...DEFAULT_STYLE, fill: shape === 'frame' ? 'none' : '#dceafe' } })),
    { id: 'filled-sector', type: 'stroke', points: [{ x: 0, y: 200 }, { x: 100, y: 200 }, { x: 60, y: 280 }], closed: true, groupId: 'group-first', locked: false, style: { ...DEFAULT_STYLE, fill: '#a7f3d0' } },
  ] })
}
test('new board geometry, groups, closed fills and history survive native save', () => {
  const doc = createDocument('board'); doc.scene = scene()
  const parsed = parseDocument(serializeDocument(doc))
  assert.equal(contentKey(parsed), contentKey(doc))
  assert.deepEqual(parsed.scene, doc.scene)
  const history = new DocumentHistory(doc), before = contentKey(doc)
  doc.scene.elements[0].groupId = 'another-group'; doc.scene.elements.at(-1).closed = false
  assert.notEqual(contentKey(doc), before)
  history.commit(doc)
  assert.equal(contentKey(history.undo()), before)
  assert.equal(contentKey(history.redo()), contentKey(doc))
  assert.throws(() => validateScene({ ...scene(), elements: [{ ...scene().elements.at(-1), points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }] }))
})
test('interchange files keep extended shape metadata, flat groups and filled polygons editable on reimport', () => {
  const expected = scene()
  for (const result of [importGraphXml(exportGraphXml(expected, '白板'))[0].scene, importBoardJson(exportBoardJson(expected)).scene]) {
    assert.equal(result.elements.length, expected.elements.length)
    for (const original of expected.elements) {
      const actual = result.elements.find(element => element.id === original.id)
      assert.ok(actual)
      assert.equal(actual.type, original.type)
      assert.equal(actual.groupId, original.groupId)
      assert.equal(['none', 'transparent'].includes(actual.style.fill) ? 'none' : actual.style.fill, original.style.fill)
      if (original.type === 'shape') { assert.equal(actual.shape, original.shape); assert.equal(actual.text, original.text) }
      else { assert.equal(actual.closed, true); assert.deepEqual(actual.points, original.points) }
    }
    validateScene(result)
  }
})
test('large closed strokes export without function argument overflow and reopen without an extra vertex', () => {
  const points = Array.from({ length: 100000 }, (_, index) => ({ x: index % 400, y: Math.floor(index / 400) }))
  const expected = { background: '#fff', grid: false, elements: [{ id: 'large', type: 'stroke', points, closed: true, locked: false, style: { ...DEFAULT_STYLE, fill: '#fff4ad' } }] }
  const result = importBoardJson(exportBoardJson(expected)).scene
  assert.equal(result.elements[0].points.length, points.length)
  assert.deepEqual(result.elements[0].points, points)
  validateScene(result)
})

test('interchange round trips preserve filled chart polygons below labels and interleaved connectors', () => {
  const expected = compileCodeDiagram('pie showData\n"设计": 40\n"开发": 60').scene
  const ids = expected.elements.map(element => element.id)
  for (const actual of [importGraphXml(exportGraphXml(expected, '比例图'))[0].scene, importBoardJson(exportBoardJson(expected)).scene]) {
    assert.deepEqual(actual.elements.map(element => element.id), ids, 'Import must preserve mixed element layer order')
    const lastPolygon = actual.elements.findLastIndex(element => element.type === 'stroke' && element.closed)
    assert.ok(actual.elements.slice(lastPolygon + 1).some(element => element.type === 'shape' && element.text), 'Labels stay visible above the filled sectors')
  }
})
