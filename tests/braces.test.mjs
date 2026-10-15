import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { DEFAULT_STYLE } from '../src/core/types.ts'
import { bracePath, braceTextBounds, isBraceShape, shapeOutline, shapeContainsPoint, outlineDistance, shapeAnchor, edgePoints, sceneBounds } from '../src/core/geometry.ts'
import { findBindingTarget } from '../src/core/binding.ts'
import { hitTestElement } from '../src/core/board-tools.ts'
import { elementToSvg, sceneToSvg } from '../src/core/svg.ts'
import { createDocument, validateScene, parseDocument, serializeDocument, contentKey } from '../src/core/documents.ts'
import { exportGraphXml, importGraphXml } from '../src/formats/graph-xml.ts'
import { exportBoardJson, importBoardJson } from '../src/formats/board-json.ts'

globalThis.DOMParser ??= DOMParser
const shapes = ['brace-left', 'brace-right', 'brace-top', 'brace-bottom']
function brace(shape, overrides = {}) {
  const vertical = shape === 'brace-left' || shape === 'brace-right'
  return { id: shape, type: 'shape', shape, x: 20, y: 30, width: vertical ? 160 : 240, height: vertical ? 180 : 110, text: '', locked: false, style: { ...DEFAULT_STYLE, fill: 'none' }, ...overrides }
}
const sceneOf = (...elements) => ({ elements, background: '#ffffff', grid: false })
const xml = markup => new DOMParser().parseFromString(markup, 'image/svg+xml')
const tip = node => node.shape === 'brace-left' ? { x: node.x, y: node.y + node.height / 2 } : node.shape === 'brace-right' ? { x: node.x + node.width, y: node.y + node.height / 2 } : node.shape === 'brace-top' ? { x: node.x + node.width / 2, y: node.y } : { x: node.x + node.width / 2, y: node.y + node.height }

test('four brace shapes are genuine open cubic curves and keep empty interiors unfilled', () => {
  for (const shape of shapes) {
    assert.equal(isBraceShape(shape), true)
    const node = brace(shape), path = bracePath(node), points = shapeOutline(node)
    assert.equal((path.match(/ C/g) ?? []).length, 4)
    assert.ok(!/Z/i.test(path))
    assert.ok(points.length > 12)
    assert.notDeepEqual(points[0], points.at(-1))
    assert.equal(outlineDistance(node, tip(node)), 0)
    assert.equal(shapeContainsPoint(node, tip(node)), true)
    const label = braceTextBounds(node), blank = { x: label.x + label.width / 2, y: label.y + label.height / 2 }
    assert.equal(shapeContainsPoint(node, blank), false)
    assert.ok(outlineDistance(node, blank) > 14)
    assert.equal(findBindingTarget(sceneOf(node), blank, 1), undefined)
    assert.equal(hitTestElement(sceneOf(node), blank, 1), undefined)
    const markup = xml(`<svg>${elementToSvg(node, sceneOf(node), true)}</svg>`)
    for (const path of [...markup.getElementsByTagName('path')]) { assert.equal(path.getAttribute('fill'), 'none'); assert.ok(!/Z/i.test(path.getAttribute('d'))) }
    assert.equal(markup.getElementsByTagName('rect').length, 0)
  }
  for (const shape of ['rectangle', 'brace-up', '__proto__', null]) assert.equal(isBraceShape(shape), false)
})

test('the imaginary line between brace endpoints is not a hit target or attachment outline', () => {
  const node = brace('brace-left'), point = { x: node.x + node.width * .25, y: node.y + node.height / 2 }
  assert.ok(outlineDistance(node, point) > 20)
  assert.equal(shapeContainsPoint(node, point), false)
  assert.equal(hitTestElement(sceneOf(node), point, 1), undefined)
})

test('fourteen screen pixel attraction remains stable at 0.1x through 4x zoom', () => {
  const node = brace('brace-left'), scene = sceneOf(node), point = tip(node)
  for (const zoom of [.1, .25, .5, 1, 2, 4]) {
    assert.equal(findBindingTarget(scene, { x: point.x - 13 / zoom, y: point.y }, zoom)?.id, node.id)
    assert.equal(findBindingTarget(scene, { x: point.x - 15 / zoom, y: point.y }, zoom), undefined)
  }
})

test('anchors and bound edges always terminate on the actual open curve after move and resize', () => {
  for (const shape of shapes) {
    const node = brace(shape)
    for (const toward of [{ x: -500, y: 100 }, { x: 900, y: 130 }, { x: 130, y: -400 }, { x: 90, y: 800 }, { x: node.x + node.width / 2, y: node.y + node.height / 2 }]) {
      const anchor = shapeAnchor(node, toward)
      assert.ok(outlineDistance(node, anchor) < 1e-7)
      const edge = { id: 'edge', type: 'edge', from: { x: 0, y: 0, nodeId: node.id }, to: toward, label: '', route: 'straight', arrow: 'end', style: { ...DEFAULT_STYLE }, locked: false }
      assert.ok(outlineDistance(node, edgePoints(edge, sceneOf(node, edge))[0]) < 1e-7)
      const resized = { ...node, x: node.x + 120, y: node.y - 80, width: node.width * 2, height: node.height * .5 }
      assert.ok(outlineDistance(resized, edgePoints(edge, sceneOf(resized, edge))[0]) < 1e-7)
    }
  }
})

test('curve approximation stays bounded and stable for tiny and very large native dimensions', () => {
  for (const size of [1, 10, 1000, 100000]) for (const shape of shapes) {
    const node = brace(shape, { width: size, height: size }), points = shapeOutline(node)
    assert.ok(points.length < 5000)
    assert.ok(points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= node.x && point.x <= node.x + size && point.y >= node.y && point.y <= node.y + size))
    assert.ok(outlineDistance(node, shapeAnchor(node, { x: -1000, y: 1000 })) < 1e-7)
  }
})

test('solid, dashed and dotted hand-drawn braces retain open paths and exact attachment vertices', () => {
  for (const pattern of ['solid', 'dashed', 'dotted']) {
    const node = brace('brace-left', { style: { ...DEFAULT_STYLE, fill: '#ff0000', roughness: 'sketch', strokePattern: pattern, dashed: pattern !== 'solid' } })
    const edge = { id: 'edge', type: 'edge', from: { x: 0, y: 0, nodeId: node.id }, to: { x: -250, y: 95 }, label: '', route: 'straight', arrow: 'end', style: { ...DEFAULT_STYLE }, locked: false }
    const scene = sceneOf(node, edge), markup = elementToSvg(node, scene, true), paths = [...xml(`<svg>${markup}</svg>`).getElementsByTagName('path')]
    assert.equal(paths.filter(path => path.hasAttribute('data-sketch-pass')).length, 2)
    assert.equal(elementToSvg(node, scene, true), markup)
    const point = edgePoints(edge, scene)[0]
    for (const path of paths.filter(path => path.hasAttribute('data-sketch-pass'))) {
      assert.equal(path.getAttribute('fill'), 'none')
      assert.ok(!/Z/i.test(path.getAttribute('d')))
      assert.ok(path.getAttribute('d').includes(`${point.x} ${point.y}`))
      assert.equal(path.hasAttribute('stroke-dasharray'), pattern !== 'solid')
    }
  }
})

test('labels stay in a dedicated interior area, render completely and only their visible area receives text hits', () => {
  for (const shape of shapes) {
    const node = brace(shape, { text: '成员分组\n第一阶段' }), area = braceTextBounds(node), scene = sceneOf(node)
    assert.ok(area.x >= node.x && area.y >= node.y && area.x + area.width <= node.x + node.width + 1e-9 && area.y + area.height <= node.y + node.height + 1e-9)
    const markup = xml(`<svg>${elementToSvg(node, scene, true)}</svg>`), text = markup.getElementsByTagName('text')[0]
    assert.equal(text.textContent, '成员分组第一阶段')
    for (const span of [...markup.getElementsByTagName('tspan')]) { assert.ok(Number(span.getAttribute('x')) >= area.x && Number(span.getAttribute('x')) <= area.x + area.width); assert.ok(Number(span.getAttribute('y')) >= area.y && Number(span.getAttribute('y')) <= area.y + area.height) }
    const hit = [...markup.getElementsByTagName('rect')].find(rect => rect.getAttribute('data-brace-label-hit') === 'true')
    assert.ok(hit)
    assert.ok(Number(hit.getAttribute('height')) <= node.style.fontSize * 1.35 * 2)
    const bounds = sceneBounds(scene), output = xml(sceneToSvg(scene)), viewbox = output.documentElement.getAttribute('viewBox').split(' ').map(Number)
    assert.ok(viewbox[0] <= bounds.x && viewbox[1] <= bounds.y && viewbox[0] + viewbox[2] >= bounds.x + bounds.width && viewbox[1] + viewbox[3] >= bounds.y + bounds.height)
  }
})

test('native save restores four directions, grouping, locks, text and styles without extra orientation fields', () => {
  const doc = createDocument('flow'); doc.scene = validateScene(sceneOf(...shapes.map((shape, index) => brace(shape, { text: '范围<&>', groupId: 'group', locked: true, x: index * 300, style: { ...DEFAULT_STYLE, fill: '#ff0000', roughness: 'sketch', strokePattern: 'dotted', dashed: true } }))))
  const reopened = parseDocument(serializeDocument(doc))
  assert.equal(contentKey(reopened), contentKey(doc))
  assert.deepEqual(reopened.scene, doc.scene)
  for (const node of reopened.scene.elements) { assert.equal(node.style.fill, 'none'); assert.equal('orientation' in node, false) }
  for (const kind of ['flow', 'board']) assert.equal(createDocument(kind).title, '未命名画布')
  assert.equal(createDocument('flow', true).title, '项目审批流程')
  assert.equal(createDocument('board', true).title, '灵感收集板')
})

test('graph XML and board JSON show real external curves and restore native brace semantics with explicit warnings', () => {
  const nodes = shapes.map((shape, index) => brace(shape, { x: index * 300, text: `范围 ${index} <&>`, groupId: 'g', locked: true, style: { ...DEFAULT_STYLE, fill: 'none', roughness: 'sketch', strokePattern: 'dotted', dashed: true, textAlign: 'left' } }))
  const edge = { id: 'connection', type: 'edge', from: { x: 0, y: 0, nodeId: nodes[0].id }, to: { x: 0, y: 0, nodeId: nodes[1].id }, label: '连接', arrow: 'end', route: 'orthogonal', style: { ...DEFAULT_STYLE }, locked: false }
  const scene = sceneOf(...nodes, edge), graph = exportGraphXml(scene, '大括弧'), board = exportBoardJson(scene)
  const graphXml = new DOMParser().parseFromString(graph, 'application/xml')
  for (const cell of [...graphXml.getElementsByTagName('mxCell')].filter(cell => cell.hasAttribute('openWorkflowShape'))) {
    assert.equal(cell.getAttribute('edge'), '1')
    assert.ok(cell.getElementsByTagName('mxPoint').length > 12)
    assert.ok(cell.getAttribute('openWorkflowCompatibility').includes('开放线条'))
    assert.ok(cell.getAttribute('style').includes('fillColor=none'))
  }
  const json = JSON.parse(board)
  for (const item of json.elements.filter(item => item.customData?.openWorkflow?.type === 'brace')) { assert.equal(item.type, 'freedraw'); assert.ok(item.points.length > 12); assert.equal(item.backgroundColor, 'transparent'); assert.notDeepEqual(item.points[0], item.points.at(-1)); assert.ok(item.customData.openWorkflow.compatibility) }
  for (const imported of [importGraphXml(graph)[0], importBoardJson(board)]) {
    assert.ok(imported.warnings.some(warning => warning.includes('大括弧') && warning.includes('外部软件')))
    assert.equal(imported.scene.elements.length, scene.elements.length)
    for (const node of nodes) assert.deepEqual(imported.scene.elements.find(element => element.id === node.id), node)
    const connection = imported.scene.elements.find(element => element.id === 'connection')
    assert.equal(connection.from.nodeId, nodes[0].id); assert.equal(connection.to.nodeId, nodes[1].id)
    assert.doesNotThrow(() => validateScene(imported.scene))
  }
})

test('malformed brace metadata is rejected, and independently edited exported labels are recovered', () => {
  const node = brace('brace-right', { text: '旧文本' }), exported = JSON.parse(exportBoardJson(sceneOf(node)))
  exported.elements.find(element => element.type === 'text').text = '外部修改后的文本'
  assert.equal(importBoardJson(JSON.stringify(exported)).scene.elements[0].text, '外部修改后的文本')
  exported.elements[0].customData.openWorkflow.bounds.width = 'unsafe'
  assert.throws(() => importBoardJson(JSON.stringify(exported)), /坐标/)
  const graph = exportGraphXml(sceneOf(node), 'test').replace('openWorkflowWidth="160"', 'openWorkflowWidth="NaN"')
  assert.throws(() => importGraphXml(graph), /坐标/)
})
