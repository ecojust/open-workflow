import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { DEFAULT_STYLE } from '../src/core/types.ts'
import { center, distanceToSegment, edgePoints, outlineDistance, shapeAnchor, shapeContainsPoint, shapeOutline } from '../src/core/geometry.ts'
import { findBindingTarget } from '../src/core/binding.ts'
import { elementToSvg, sceneToSvg } from '../src/core/svg.ts'

const kinds = ['triangle', 'hexagon', 'star', 'parallelogram', 'cylinder', 'cloud', 'frame']
const node = (shape, patch = {}) => ({ id: shape, type: 'shape', shape, x: 40, y: 50, width: 180, height: 120, text: '分组标题', style: { ...DEFAULT_STYLE, fill: '#dbeafe' }, locked: false, ...patch })
const scene = elements => ({ elements, background: '#fff', grid: true })
const bound = (shape, to = { x: 400, y: 78 }) => ({ id: `edge-${shape.id}`, type: 'edge', from: { x: 0, y: 0, nodeId: shape.id }, to, label: '', route: 'straight', arrow: 'end', style: { ...DEFAULT_STYLE }, locked: false })
function borderDistance(shape, point) { const points = shapeOutline(shape); return Math.min(...points.map((p, i) => distanceToSegment(point, p, points[(i + 1) % points.length]))) }

test('new board shapes have distinct actual outlines and visible SVG geometry', () => {
  const geometry = new Set()
  for (const kind of kinds) {
    const shape = node(kind), points = shapeOutline(shape), markup = elementToSvg(shape, scene([shape]))
    assert.ok(points.length >= 3)
    assert.ok(points.every(p => p.x >= shape.x - 1e-8 && p.x <= shape.x + shape.width + 1e-8 && p.y >= shape.y - 1e-8 && p.y <= shape.y + shape.height + 1e-8))
    assert.equal(shapeContainsPoint(shape, center(shape)), true, `${kind} contains its central label`)
    geometry.add(JSON.stringify(points))
    if (kind === 'frame') assert.ok(markup.includes('fill="none"'))
    else assert.ok(markup.includes('<path d="') && markup.includes('fill="#dbeafe"'))
    const errors = []
    new DOMParser({ onError: (level, message) => errors.push([level, message]) }).parseFromString(sceneToSvg(scene([shape])), 'image/svg+xml')
    assert.deepEqual(errors, [])
  }
  assert.equal(geometry.size, kinds.length)
})
test('all new shape anchors intersect their rendered boundary in cardinal and diagonal directions', () => {
  for (const kind of kinds) for (const [dx, dy] of [[500, 0], [-500, 0], [0, 500], [0, -500], [400, 210], [-340, -95]]) {
    const shape = node(kind), c = center(shape), anchor = shapeAnchor(shape, { x: c.x + dx, y: c.y + dy })
    assert.ok(borderDistance(shape, anchor) < 1e-6, `${kind} anchor must lie on its actual outline`)
    assert.ok(Number.isFinite(anchor.x) && Number.isFinite(anchor.y))
    assert.ok(Math.abs((anchor.x - c.x) * dy - (anchor.y - c.y) * dx) < 1e-5)
  }
})
test('attachment respects triangle and star cutouts instead of the rectangular selection box', () => {
  for (const kind of ['triangle', 'star', 'hexagon', 'parallelogram', 'cloud']) {
    const shape = node(kind), corner = { x: shape.x + 1, y: shape.y + 1 }
    assert.equal(shapeContainsPoint(shape, corner), false)
    assert.equal(findBindingTarget(scene([shape]), corner, 4), undefined)
    const anchor = shapeAnchor(shape, { x: 600, y: 110 })
    assert.equal(findBindingTarget(scene([shape]), anchor, 4)?.id, shape.id)
    assert.ok(outlineDistance(shape, anchor) < 1e-6)
  }
})
test('sketch silhouettes pass through exact connection anchors for every new shape', () => {
  for (const kind of kinds) {
    const shape = node(kind, { style: { ...DEFAULT_STYLE, roughness: 'sketch' } }), link = bound(shape), drawing = scene([shape, link]), anchor = edgePoints(link, drawing)[0]
    const paths = [...elementToSvg(shape, drawing).matchAll(/data-sketch-pass="\d" d="([^"]+)"/g)].slice(0, 2)
    assert.equal(paths.length, 2)
    for (const [, path] of paths) {
      const vertices = [...path.matchAll(/[MC]([^MCZ]+)/g)].map(match => match[1].trim().split(/[ ,]+/).map(Number).slice(-2))
      assert.ok(vertices.some(([x, y]) => Math.abs(x - anchor.x) < 1e-7 && Math.abs(y - anchor.y) < 1e-7), `${kind} sketch joins its edge`)
    }
  }
})
test('new-shape self loops start and end on the true outline', () => {
  for (const kind of kinds) {
    const shape = node(kind), link = bound(shape, { x: 0, y: 0, nodeId: shape.id }), points = edgePoints(link, scene([shape, link]))
    assert.ok(borderDistance(shape, points[0]) < 1e-6)
    assert.ok(borderDistance(shape, points.at(-1)) < 1e-6)
    for (let i = 1; i < points.length; i++) assert.ok(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y)
  }
})
test('frames have transparent interiors, top captions, and no full interior interaction overlay', () => {
  const frame = node('frame', { width: 600, height: 400 }), drawing = scene([frame])
  for (const roughness of ['clean', 'sketch']) {
    frame.style.roughness = roughness
    const markup = elementToSvg(frame, drawing, true)
    assert.ok(!markup.includes('fill="#dbeafe"'))
    assert.ok(markup.includes('x="52" y="68"'))
    assert.ok(markup.includes('height="36" fill="transparent" pointer-events="all"'))
    assert.ok(!markup.includes('height="400" fill="transparent"'))
  }
  assert.equal(findBindingTarget(drawing, center(frame), 1), undefined)
  assert.equal(findBindingTarget(drawing, { x: frame.x, y: frame.y + 100 }, 1)?.id, frame.id)
})
test('closed strokes preserve polygon fills and closing segments in clean and sketch export', () => {
  const points = [{ x: 100, y: 100 }, { x: 180, y: 100 }, { x: 150, y: 160 }]
  for (const roughness of ['clean', 'sketch']) {
    const polygon = { id: 'pie-slice', type: 'stroke', closed: true, points, style: { ...DEFAULT_STYLE, fill: '#fdba74', roughness, opacity: .7 }, locked: false, groupId: 'chart' }
    const markup = elementToSvg(polygon, scene([polygon])), svg = sceneToSvg(scene([polygon]))
    assert.ok(markup.includes('d="M100 100 L180 100 L150 160 Z" fill="#fdba74" stroke="none" opacity="0.7"'))
    assert.ok(svg.includes('fill="#fdba74"'))
    if (roughness === 'sketch') assert.equal([...markup.matchAll(/data-sketch-pass="\d" d="[^\"]+ Z"/g)].length, 2)
    const open = elementToSvg({ ...polygon, closed: false }, scene([polygon]))
    assert.ok(!open.includes('fill="#fdba74"'), 'open freehand strokes must remain unfilled')
  }
})
