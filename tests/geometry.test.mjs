import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STYLE } from '../src/core/types.ts'
import { edgePoints, sceneBounds, shapeAnchor, pathMidpoint, elementBounds } from '../src/core/geometry.ts'
import { layoutScene } from '../src/core/layout.ts'
import { escapeXml, safeImageData, sceneToSvg, wrapText } from '../src/core/svg.ts'
import { createDocument, MERMAID_SAMPLE } from '../src/core/documents.ts'
import { compileMermaid } from '../src/core/mermaid.ts'

const shape = (id, x = 0, y = 0, kind = 'rectangle') => ({ id, type: 'shape', shape: kind, x, y, width: 160, height: 80, text: id, style: { ...DEFAULT_STYLE }, locked: false })
const edge = (id, from, to, route = 'straight') => ({ id, type: 'edge', from: { x: 0, y: 0, nodeId: from }, to: { x: 0, y: 0, nodeId: to }, label: '', arrow: 'end', route, style: { ...DEFAULT_STYLE }, locked: false })
const scene = elements => ({ elements, grid: true, background: '#fff' })

test('rectangular anchor follows horizontal and vertical rays without division by zero', () => {
  const node = shape('a')
  assert.deepEqual(shapeAnchor(node, { x: 300, y: 40 }), { x: 160, y: 40 })
  assert.deepEqual(shapeAnchor(node, { x: 80, y: -30 }), { x: 80, y: 0 })
  assert.deepEqual(shapeAnchor(node, { x: 80, y: 40 }), { x: 80, y: 80 })
})
test('ellipse and diamond anchors intersect the actual outline', () => {
  const target = { x: 240, y: 120 }, ellipse = shapeAnchor(shape('a', 0, 0, 'ellipse'), target), diamond = shapeAnchor(shape('b', 0, 0, 'diamond'), target)
  assert.ok(Math.abs((ellipse.x - 80) ** 2 / 80 ** 2 + (ellipse.y - 40) ** 2 / 40 ** 2 - 1) < 1e-8)
  assert.ok(Math.abs(Math.abs(diamond.x - 80) / 80 + Math.abs(diamond.y - 40) / 40 - 1) < 1e-8)
})
test('bound edges recompute both endpoints when a node moves, leaving persisted coordinates untouched', () => {
  const a = shape('a'), b = shape('b', 320), link = edge('e', 'a', 'b'), document = scene([a, b, link])
  assert.deepEqual(edgePoints(link, document), [{ x: 160, y: 40 }, { x: 320, y: 40 }])
  b.x = 400
  assert.deepEqual(edgePoints(link, document), [{ x: 160, y: 40 }, { x: 400, y: 40 }])
  assert.equal(link.to.x, 0)
})
test('orthogonal routes contain only horizontal or vertical segments and use node sides', () => {
  const link = edge('e', 'a', 'b', 'orthogonal'), points = edgePoints(link, scene([shape('a'), shape('b', 380, 220), link]))
  assert.equal(points[0].x, 160)
  assert.equal(points.at(-1).x, 380)
  for (let i = 1; i < points.length; i++) assert.ok(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y)
})
test('self loops have a visible route outside the node and contribute to export bounds', () => {
  const link = edge('loop', 'a', 'a'), document = scene([shape('a'), link])
  assert.equal(edgePoints(link, document).length, 5)
  assert.equal(sceneBounds(document).y, -32)
  assert.equal(sceneBounds(document).width, 204)
})
test('free endpoints, negative coordinates, and pencil strokes remain in drawing bounds', () => {
  const document = scene([{ ...edge('e'), from: { x: -200, y: -70 }, to: { x: -100, y: 30 } }, { id: 'ink', type: 'stroke', points: [{ x: 20, y: 80 }, { x: 70, y: 100 }], locked: false, style: { ...DEFAULT_STYLE } }])
  assert.deepEqual(sceneBounds(document), { x: -200, y: -70, width: 270, height: 170 })
  assert.deepEqual(pathMidpoint([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }]), { x: 70, y: 0 })
})
test('large pen strokes do not spread points as function arguments', () => {
  const points = Array.from({ length: 180000 }, (_, i) => ({ x: i, y: -i }))
  assert.deepEqual(elementBounds({ id: 's', type: 'stroke', points, style: DEFAULT_STYLE, locked: false }), { x: 0, y: -179999, width: 179999, height: 179999 })
})
test('layered layout handles branching without overlap and leaves its input unchanged', () => {
  const original = scene([shape('a'), shape('b'), shape('c'), edge('ab', 'a', 'b'), edge('ac', 'a', 'c')]), before = JSON.stringify(original)
  const output = layoutScene(original, 'TB'), [a, b, c] = output.elements
  assert.equal(JSON.stringify(original), before)
  assert.ok(b.y > a.y && c.y > a.y)
  assert.equal(b.y, c.y)
  assert.ok(c.x >= b.x + b.width)
})
test('left-right and reverse layouts preserve edge direction while changing rank positions', () => {
  const original = scene([shape('a'), shape('b'), edge('ab', 'a', 'b')])
  for (const [direction, axis, compare] of [['LR', 'x', 1], ['RL', 'x', -1], ['TB', 'y', 1], ['BT', 'y', -1]]) {
    const [a, b] = layoutScene(original, direction).elements
    assert.ok((b[axis] - a[axis]) * compare > 0)
  }
})
test('layout terminates on cycles and respects locked node locations', () => {
  const locked = { ...shape('a', -900, -800), locked: true }, result = layoutScene(scene([locked, shape('b'), edge('a-b', 'a', 'b'), edge('b-a', 'b', 'a')]))
  assert.deepEqual(result.elements[0], locked)
  assert.ok(Number.isFinite(result.elements[1].x))
})
test('SVG serialization escapes labels and text, forbids external image resources and color injection', () => {
  const a = shape('<img>'); a.text = '<script>alert("x")</script>'; a.width = 900; a.height = 150; a.style.stroke = 'red" onload="alert(1)'
  const image = { ...shape('image'), shape: 'image', imageData: 'https://attacker.test/pixel.png' }
  const link = { ...edge('edge'), from: { x: 0, y: 0 }, to: { x: 200, y: 30 }, label: 'x & <y>' }
  const svg = sceneToSvg(scene([a, image, link]))
  assert.ok(svg.includes('&lt;script&gt;'))
  assert.ok(svg.includes('x &amp; &lt;y&gt;'))
  assert.ok(!svg.includes('<script') && !svg.includes('onload=') && !svg.includes('attacker.test'))
  assert.ok(svg.includes('stroke="#334155"'))
})
test('SVG supports embedded raster images only and keeps stroke and edge styles', () => {
  assert.equal(safeImageData('data:image/svg+xml;base64,PHN2Zz4='), false)
  assert.equal(safeImageData('data:image/png;base64,AAAA'), true)
  assert.equal(safeImageData('data:image/jpeg;base64,AAAA" onload="evil'), false)
  const ink = { id: 'ink', type: 'stroke', points: [{ x: 10, y: 20 }, { x: 70, y: 80 }], style: { ...DEFAULT_STYLE, stroke: '#aa2233', strokeWidth: 5, strokePattern: 'dashed', dashed: true, opacity: 0.5 }, locked: false }
  const image = { ...shape('image'), shape: 'image', imageData: 'data:image/png;base64,AAAA' }
  const svg = sceneToSvg(scene([ink, image]), { background: false })
  assert.ok(svg.includes('stroke="#aa2233"') && svg.includes('stroke-width="5"') && svg.includes('stroke-dasharray="8 5"') && svg.includes('opacity="0.5"'))
  assert.ok(svg.includes('href="data:image/png;base64,AAAA"'))
  assert.ok(!svg.includes('fill="#fff"'))
})
test('text wraps by rendered character width and preserves explicit line breaks', () => {
  assert.deepEqual(wrapText('测试中文\nABC', 32, 16), ['测试', '中文', 'ABC'])
  assert.deepEqual(wrapText('', 100, 16), [''])
})
test('accepted HSL styles and larger imported type sizes are preserved in rendering', () => {
  const node = shape('large'); node.width = 900; node.height = 500; node.style = { ...DEFAULT_STYLE, fill: 'hsl(120,100%,50%)', stroke: 'rgb(0 0 0 / 50%)', strokeWidth: 50, fontSize: 120 }
  const svg = sceneToSvg(scene([node]))
  assert.ok(svg.includes('fill="hsl(120,100%,50%)"'))
  assert.ok(svg.includes('stroke="rgb(0 0 0 / 50%)"'))
  assert.ok(svg.includes('stroke-width="50"') && svg.includes('font-size="120"'))
})
test('notes with no outline still have readable text, and single-point ink is visible', () => {
  const note = shape('remember', 0, 0, 'note'); note.style.stroke = 'transparent'
  const ink = { id: 'dot', type: 'stroke', points: [{ x: 20, y: 20 }], style: DEFAULT_STYLE, locked: false }
  const svg = sceneToSvg(scene([note, ink]))
  assert.ok(svg.includes('<text fill="#334155"'))
  assert.ok(svg.includes('M20 20 L20.01 20.01'))
})
test('fit and export bounds include long edge labels', () => {
  const link = { ...edge('wide'), from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, label: '这是一个很长的连线说明文字，导出时不应被截断' }
  const bounds = sceneBounds(scene([link]))
  assert.ok(bounds.width > 300 && bounds.y < -20)
})
test('XML export replaces illegal control codes and lone surrogates while preserving emoji', () => {
  assert.equal(escapeXml('中文\u0000\u001b\ud800\uffff😊\n\t'), '中文����😊\n\t')
})
test('real approval template return leaves branch top and enters earlier step from the right', () => {
  const document = createDocument('flow', true).scene
  const returning = document.elements.find(e => e.type === 'edge' && e.from.nodeId === 'revise' && e.to.nodeId === 'plan')
  const incoming = document.elements.find(e => e.type === 'edge' && e.from.nodeId === 'review' && e.to.nodeId === 'revise')
  const revise = document.elements.find(e => e.id === 'revise'), plan = document.elements.find(e => e.id === 'plan')
  const points = edgePoints(returning, document), incomingPoints = edgePoints(incoming, document)
  assert.deepEqual(points[0], { x: revise.x + revise.width / 2, y: revise.y })
  assert.deepEqual(points.at(-1), { x: plan.x + plan.width, y: plan.y + plan.height / 2 })
  assert.notDeepEqual(points[0], incomingPoints.at(-1))
  for (let i = 1; i < points.length; i++) assert.ok(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y)
  const bounds = sceneBounds(document)
  for (const p of points) assert.ok(p.x >= bounds.x && p.y >= bounds.y && p.x <= bounds.x + bounds.width && p.y <= bounds.y + bounds.height)
})
test('default Mermaid reciprocal edges use distinct orthogonal routes and export includes return lane', () => {
  const document = compileMermaid(MERMAID_SAMPLE).scene
  const idea = document.elements.find(e => e.type === 'shape' && e.text === '整理想法'), review = document.elements.find(e => e.type === 'shape' && e.text === '准备好了吗？')
  const forward = document.elements.find(e => e.type === 'edge' && e.from.nodeId === idea.id && e.to.nodeId === review.id)
  const backward = document.elements.find(e => e.type === 'edge' && e.from.nodeId === review.id && e.to.nodeId === idea.id)
  const first = edgePoints(forward, document), second = edgePoints(backward, document)
  assert.notDeepEqual(first, [...second].reverse())
  assert.ok(second.some(p => p.y < Math.min(idea.y, review.y)))
  assert.notDeepEqual(first[0], second.at(-1))
  for (const points of [first, second]) for (let i = 1; i < points.length; i++) assert.ok(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y)
  const bounds = sceneBounds(document)
  for (const p of second) assert.ok(p.x >= bounds.x && p.y >= bounds.y && p.x <= bounds.x + bounds.width && p.y <= bounds.y + bounds.height)
  // Moving a bound node recalculates the separated lane without mutating persisted endpoints.
  review.x += 120
  assert.notDeepEqual(edgePoints(backward, document), second)
})
