import test from 'node:test'
import assert from 'node:assert/strict'
import { findBindingTarget } from '../src/core/binding.ts'
import { selectionScene, reorderElements } from '../src/core/selection.ts'
import { edgePoints } from '../src/core/geometry.ts'
import { DEFAULT_STYLE } from '../src/core/types.ts'

function node(id, shape = 'rectangle', x = 0, y = 0, width = 100, height = 100) { return { id, type: 'shape', shape, x, y, width, height, text: id, style: { ...DEFAULT_STYLE }, locked: false } }
function scene(...elements) { return { elements, background: '#f8fafc', grid: true } }
function edge(id, from, to, route = 'straight') { return { id, type: 'edge', from, to, route, arrow: 'end', label: id, style: { ...DEFAULT_STYLE }, locked: false } }
const order = value => value.elements.map(element => element.id)

test('rectangle, note and image snap within fourteen screen pixels, including at corners', () => {
  for (const kind of ['rectangle', 'note', 'image']) {
    const shape = node(kind, kind), document = scene(shape)
    assert.equal(findBindingTarget(document, { x: 50, y: 50 }, 1), shape)
    assert.equal(findBindingTarget(document, { x: 114, y: 50 }, 1), shape)
    assert.equal(findBindingTarget(document, { x: 114.01, y: 50 }, 1), undefined)
    assert.equal(findBindingTarget(document, { x: 109, y: 109 }, 1), shape)
    assert.equal(findBindingTarget(document, { x: 110, y: 110 }, 1), undefined)
  }
})

test('the binding attraction radius is stable from ten-percent to four-hundred-percent zoom', () => {
  for (const zoom of [0.1, 0.25, 0.5, 1, 2, 4]) {
    for (const kind of ['rectangle', 'ellipse', 'diamond']) {
      const shape = node(kind, kind), document = scene(shape)
      assert.equal(findBindingTarget(document, { x: 100 + 13.9 / zoom, y: 50 }, zoom), shape, `${kind} at ${zoom}`)
      assert.equal(findBindingTarget(document, { x: 100 + 14.1 / zoom, y: 50 }, zoom), undefined, `${kind} at ${zoom}`)
    }
  }
})

test('ellipse and diamond bounding-box corners are not mistaken for filled interiors', () => {
  for (const kind of ['ellipse', 'diamond']) {
    const document = scene(node(kind, kind, 0, 0, 200, 120))
    assert.equal(findBindingTarget(document, { x: 2, y: 2 }, 1), undefined, kind)
    assert.equal(findBindingTarget(document, { x: 198, y: 118 }, 1), undefined, kind)
    assert.equal(findBindingTarget(document, { x: 100, y: 60 }, 4)?.id, kind)
  }
})

test('ellipse attraction measures perpendicular distance from its curved outline', () => {
  const ellipse = node('ellipse', 'ellipse', -100, -40, 200, 80), document = scene(ellipse)
  const angle = Math.PI / 4
  const boundary = { x: 100 * Math.cos(angle), y: 40 * Math.sin(angle) }
  const normal = { x: Math.cos(angle) / 100, y: Math.sin(angle) / 40 }
  const length = Math.hypot(normal.x, normal.y)
  for (const distance of [13.9, 14.1]) {
    const point = { x: boundary.x + distance * normal.x / length, y: boundary.y + distance * normal.y / length }
    assert.equal(findBindingTarget(document, point, 1), distance < 14 ? ellipse : undefined)
  }
})

test('diamond attraction measures distance to a sloping edge, not its center ray', () => {
  const diamond = node('diamond', 'diamond', -100, -40, 200, 80), document = scene(diamond)
  const boundary = { x: 50, y: 20 }, normal = { x: 0.4, y: 1 }, length = Math.hypot(0.4, 1)
  assert.equal(findBindingTarget(document, { x: boundary.x + 13.9 * normal.x / length, y: boundary.y + 13.9 * normal.y / length }, 1), diamond)
  assert.equal(findBindingTarget(document, { x: boundary.x + 14.1 * normal.x / length, y: boundary.y + 14.1 * normal.y / length }, 1), undefined)
})

test('actual interiors beat nearby outlines and overlapping interiors prefer the topmost node', () => {
  const lower = node('inside', 'rectangle', 0, 0, 100, 100), upper = node('nearby', 'rectangle', 105, 0, 100, 100)
  assert.equal(findBindingTarget(scene(lower, upper), { x: 99, y: 50 }, 1), lower)
  const overlap = node('top', 'ellipse', 10, 10, 80, 80)
  assert.equal(findBindingTarget(scene(lower, overlap), { x: 50, y: 50 }, 1), overlap)
})

test('exterior candidates use nearest distance, then reverse z-order on a tie', () => {
  const left = node('left', 'rectangle', 0, 0, 100, 100), right = node('right', 'rectangle', 120, 0, 100, 100)
  assert.equal(findBindingTarget(scene(left, right), { x: 108, y: 50 }, 1), left)
  assert.equal(findBindingTarget(scene(left, right), { x: 110, y: 50 }, 1), right)
  assert.equal(findBindingTarget(scene(right, left), { x: 110, y: 50 }, 1), left)
})

test('locked shapes remain bindable, text and excluded nodes do not capture arrows', () => {
  const locked = { ...node('locked'), locked: true }, text = node('text', 'text')
  assert.equal(findBindingTarget(scene(locked, text), { x: 50, y: 50 }, 1), locked)
  assert.equal(findBindingTarget(scene(locked, text), { x: 50, y: 50 }, 1, ['locked']), undefined)
  assert.equal(findBindingTarget(scene(locked), { x: NaN, y: 0 }, 1), undefined)
})

test('selection exports preserve order, detach omitted bindings at visible endpoints, and do not mutate the original', () => {
  const first = node('a', 'ellipse', 20, 40, 120, 80), second = node('b', 'diamond', 300, 100, 160, 100)
  const connection = edge('link', { nodeId: 'a', x: -999, y: -999 }, { nodeId: 'b', x: -999, y: -999 }, 'orthogonal')
  const original = scene(first, connection, second), before = structuredClone(original), points = edgePoints(connection, original)
  const result = selectionScene(original, ['link', 'a'])
  assert.deepEqual(order(result), ['a', 'link'])
  assert.equal(result.elements[1].from.nodeId, 'a')
  assert.deepEqual(result.elements[1].to, points.at(-1))
  assert.equal(result.elements[1].to.nodeId, undefined)
  result.elements[0].style.fill = '#000000'
  assert.deepEqual(original, before)
})

test('exporting only an arrow detaches both ends; selecting its nodes keeps both bindings', () => {
  const first = node('a'), second = node('b', 'rectangle', 300, 0)
  const connection = edge('link', { nodeId: 'a', x: 0, y: 0 }, { nodeId: 'b', x: 0, y: 0 })
  const original = scene(first, connection, second), points = edgePoints(connection, original)
  const alone = selectionScene(original, ['link']).elements[0]
  assert.deepEqual(alone.from, points[0]); assert.deepEqual(alone.to, points.at(-1))
  const together = selectionScene(original, ['a', 'b', 'link']).elements[1]
  assert.equal(together.from.nodeId, 'a'); assert.equal(together.to.nodeId, 'b')
  assert.deepEqual(selectionScene(original, []).elements, [])
})

test('front/back reordering keeps selected elements and all other elements in stable relative order', () => {
  const original = scene(...['a', 'b', 'c', 'd', 'e'].map(id => node(id))), before = structuredClone(original)
  assert.deepEqual(order(reorderElements(original, ['d', 'b'], 'front')), ['a', 'c', 'e', 'b', 'd'])
  assert.deepEqual(order(reorderElements(original, ['d', 'b'], 'back')), ['b', 'd', 'a', 'c', 'e'])
  assert.deepEqual(original, before)
})

test('one-layer steps move contiguous or separated selections without reversing their order', () => {
  const original = scene(...['a', 'b', 'c', 'd', 'e'].map(id => node(id)))
  assert.deepEqual(order(reorderElements(original, ['b', 'c'], 'forward')), ['a', 'd', 'b', 'c', 'e'])
  assert.deepEqual(order(reorderElements(original, ['b', 'c'], 'backward')), ['b', 'c', 'a', 'd', 'e'])
  assert.deepEqual(order(reorderElements(original, ['b', 'd'], 'forward')), ['a', 'c', 'b', 'e', 'd'])
  assert.deepEqual(order(reorderElements(original, ['b', 'd'], 'backward')), ['b', 'a', 'd', 'c', 'e'])
  assert.deepEqual(order(reorderElements(original, ['d', 'e'], 'forward')), order(original))
  assert.deepEqual(order(reorderElements(original, ['a', 'b'], 'backward')), order(original))
})

test('locked selected elements cannot be reordered and the returned scene is detached', () => {
  const original = scene(node('a'), { ...node('locked'), locked: true }, node('c'))
  for (const operation of ['front', 'back', 'forward', 'backward']) assert.deepEqual(order(reorderElements(original, ['locked'], operation)), order(original))
  const result = reorderElements(original, ['a', 'locked'], 'front')
  assert.deepEqual(order(result), ['locked', 'c', 'a'])
  result.elements[0].text = 'changed'
  assert.equal(original.elements[1].text, 'locked')
})
