import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STYLE } from '../src/core/types.ts'
import { edgePoints } from '../src/core/geometry.ts'
import { alignElements, distributeElements, expandedSelection, frameContents, groupElements, hitTestElement, ungroupElements } from '../src/core/board-tools.ts'

const shape = (id, x = 0, y = 0, width = 100, height = 80, extra = {}) => ({ id, type: 'shape', shape: 'rectangle', x, y, width, height, text: id, style: { ...DEFAULT_STYLE }, locked: false, ...extra })
const edge = (id, from, to, extra = {}) => ({ id, type: 'edge', from, to, label: '', arrow: 'end', route: 'straight', style: { ...DEFAULT_STYLE }, locked: false, ...extra })
const ink = (id, points, extra = {}) => ({ id, type: 'stroke', points, style: { ...DEFAULT_STYLE, fill: 'none' }, locked: false, ...extra })
const scene = elements => ({ elements, background: '#fff', grid: true })
const byId = (document, id) => document.elements.find(element => element.id === id)

test('selecting one group member expands in layer order without stale IDs or duplicate IDs', () => {
  const document = scene([shape('a', 0, 0, 100, 80, { groupId: 'g' }), shape('other'), shape('b', 120, 0, 100, 80, { groupId: 'g', locked: true })])
  assert.deepEqual(expandedSelection(document, ['missing', 'b', 'b']), ['a', 'b'])
  assert.deepEqual(expandedSelection(document, ['other', 'a']), ['a', 'other', 'b'])
})

test('grouping merges existing groups into one flat group, preserving locked members and input', () => {
  const document = scene([shape('a', 0, 0, 100, 80, { groupId: 'first' }), shape('b', 120, 0, 100, 80, { groupId: 'first' }), shape('c', 240, 0, 100, 80, { groupId: 'second' }), shape('lock', 360, 0, 100, 80, { groupId: 'second', locked: true }), shape('outside')])
  const before = JSON.stringify(document)
  const result = groupElements(document, ['a', 'c'])
  const group = byId(result, 'a').groupId
  assert.match(group, /^group-/)
  assert.equal(byId(result, 'b').groupId, group)
  assert.equal(byId(result, 'c').groupId, group)
  assert.deepEqual(byId(result, 'lock'), byId(document, 'lock'))
  assert.equal(byId(result, 'outside').groupId, undefined)
  assert.equal(JSON.stringify(document), before)
  assert.equal(groupElements(result, ['a']), result)
})

test('grouping requires two unlocked members and ungrouping expands the selected group only', () => {
  const only = scene([shape('a'), shape('locked', 120, 0, 100, 80, { locked: true })])
  assert.equal(groupElements(only, ['a', 'locked']), only)
  const document = scene([shape('a', 0, 0, 100, 80, { groupId: 'g' }), shape('b', 120, 0, 100, 80, { groupId: 'g' }), shape('lock', 240, 0, 100, 80, { groupId: 'g', locked: true }), shape('other', 0, 0, 100, 80, { groupId: 'other' })])
  const result = ungroupElements(document, ['b'])
  for (const id of ['a', 'b']) assert.equal(Object.hasOwn(byId(result, id), 'groupId'), false)
  assert.deepEqual(byId(result, 'lock'), byId(document, 'lock'))
  assert.equal(byId(result, 'other').groupId, 'other')
  assert.equal(byId(document, 'a').groupId, 'g')
})

test('all six alignment modes use visual bounds and preserve unselected elements', () => {
  const document = scene([shape('a', 10, 30, 40, 20), shape('b', 150, 100, 80, 60), shape('outside', -1000, -1000)])
  const expected = { left: [[10, 30], [10, 100]], center: [[100, 30], [80, 100]], right: [[190, 30], [150, 100]], top: [[10, 30], [150, 30]], middle: [[10, 85], [150, 65]], bottom: [[10, 140], [150, 100]] }
  for (const [mode, positions] of Object.entries(expected)) {
    const result = alignElements(document, ['a', 'b'], mode)
    assert.deepEqual(result.elements.slice(0, 2).map(element => [element.x, element.y]), positions, mode)
    assert.deepEqual(byId(result, 'outside'), byId(document, 'outside'))
  }
  assert.equal(byId(document, 'a').x, 10)
})

test('alignment uses a locked reference without moving or changing it', () => {
  const locked = shape('reference', 200, 100, 120, 80, { locked: true })
  const document = scene([shape('moving', 0, -100, 40, 20), locked])
  const horizontal = alignElements(document, ['moving', 'reference'], 'center')
  assert.equal(byId(horizontal, 'moving').x, 240)
  const vertical = alignElements(document, ['moving', 'reference'], 'middle')
  assert.equal(byId(vertical, 'moving').y, 130)
  assert.deepEqual(byId(horizontal, 'reference'), locked)
  assert.deepEqual(byId(vertical, 'reference'), locked)
})

test('alignment moves a whole group without collapsing the relative member positions', () => {
  const document = scene([shape('a', 100, 50, 40, 20, { groupId: 'g' }), shape('b', 170, 90, 30, 20, { groupId: 'g' }), shape('reference', 0, 0, 30, 30)])
  const result = alignElements(document, ['a', 'reference'], 'left')
  assert.equal(byId(result, 'a').x, 0)
  assert.equal(byId(result, 'b').x, 70)
  assert.equal(byId(result, 'b').y - byId(result, 'a').y, 40)
})

test('a group containing a locked member is a rigid fixed reference', () => {
  const document = scene([shape('a', 100, 50, 40, 20, { groupId: 'g' }), shape('b', 170, 90, 30, 20, { groupId: 'g', locked: true }), shape('moving', 0, 0, 30, 30)])
  const result = alignElements(document, ['a', 'moving'], 'right')
  assert.deepEqual(byId(result, 'a'), byId(document, 'a'))
  assert.deepEqual(byId(result, 'b'), byId(document, 'b'))
  assert.equal(byId(result, 'moving').x, 170)
})

test('bound connectors follow moved shapes once and cannot distort alignment using stored coordinates', () => {
  const link = edge('link', { x: -999, y: -999, nodeId: 'a' }, { x: -999, y: -999, nodeId: 'b' })
  const document = scene([shape('a', 0, 0), shape('b', 300, 200), link])
  const result = alignElements(document, ['a', 'b', 'link'], 'top')
  assert.equal(byId(result, 'a').y, 0)
  assert.equal(byId(result, 'b').y, 0)
  assert.deepEqual(byId(result, 'link'), link)
  assert.deepEqual(edgePoints(byId(result, 'link'), result), [{ x: 100, y: 40 }, { x: 300, y: 40 }])
})

test('a grouped half-bound connector moves its free end once and leaves bound endpoint coordinates intact', () => {
  const link = edge('link', { x: 50, y: 40, nodeId: 'a' }, { x: 250, y: 40 }, { groupId: 'g' })
  const document = scene([shape('a', 0, 0, 100, 80, { groupId: 'g' }), link, shape('reference', 500, 0, 100, 80, { locked: true })])
  const result = alignElements(document, ['a', 'reference'], 'left')
  assert.equal(byId(result, 'a').x, 500)
  assert.deepEqual(byId(result, 'link').from, link.from)
  assert.deepEqual(byId(result, 'link').to, { x: 750, y: 40 })
  assert.deepEqual(edgePoints(byId(result, 'link'), result), [{ x: 600, y: 40 }, { x: 750, y: 40 }])
})

test('horizontal distribution equalizes visible gaps for differently sized objects', () => {
  const document = scene([shape('left', 0, 20, 40, 30), shape('middle', 60, 80, 80, 30), shape('right', 300, -20, 50, 30)])
  const result = distributeElements(document, ['left', 'middle', 'right'], 'horizontal')
  assert.equal(byId(result, 'middle').x, 130)
  assert.equal(byId(result, 'middle').y, 80)
  assert.deepEqual(byId(result, 'left'), byId(document, 'left'))
  assert.deepEqual(byId(result, 'right'), byId(document, 'right'))
  assert.equal(byId(document, 'middle').x, 60)
})

test('distribution respects interior locked anchors and equalizes each available interval', () => {
  const document = scene([shape('first', 0, 0, 20, 20), shape('before', 50, 40, 20, 20), shape('lock', 160, 10, 20, 20, { locked: true }), shape('after', 250, 70, 40, 20), shape('last', 420, 0, 20, 20)])
  const result = distributeElements(document, document.elements.map(element => element.id), 'horizontal')
  assert.equal(byId(result, 'before').x, 80)
  assert.equal(byId(result, 'after').x, 280)
  assert.deepEqual(byId(result, 'lock'), byId(document, 'lock'))
})

test('vertical distribution treats a group as one item and translates stroke points', () => {
  const document = scene([shape('first', 0, 0, 20, 20), shape('a', 50, 30, 20, 20, { groupId: 'g' }), ink('ink', [{ x: 40, y: 60 }, { x: 100, y: 80 }], { groupId: 'g' }), shape('last', 0, 300, 20, 20)])
  const result = distributeElements(document, ['first', 'a', 'last'], 'vertical')
  assert.equal(byId(result, 'a').y, 135)
  assert.deepEqual(byId(result, 'ink').points, [{ x: 40, y: 165 }, { x: 100, y: 185 }])
})

test('hit testing returns the highest actual shape, including locked shapes', () => {
  const document = scene([shape('back'), shape('front', 20, 20, 100, 80, { locked: true })])
  assert.equal(hitTestElement(document, { x: 30, y: 30 }, 1).id, 'front')
  assert.equal(hitTestElement(document, { x: 10, y: 10 }, 1).id, 'back')
  assert.equal(hitTestElement(document, { x: NaN, y: 20 }, 1), undefined)
})

test('diamond, ellipse, and triangle empty bounding-box corners do not hit', () => {
  for (const kind of ['diamond', 'ellipse', 'triangle']) {
    const document = scene([shape(kind, 0, 0, 100, 100, { shape: kind })])
    assert.equal(hitTestElement(document, { x: 1, y: 1 }, 1), undefined, kind)
    assert.equal(hitTestElement(document, { x: 50, y: 50 }, 1).id, kind)
  }
})

test('line hit testing follows diagonal and orthogonal paths instead of their bounding rectangles', () => {
  const diagonal = edge('diagonal', { x: 0, y: 0 }, { x: 100, y: 100 })
  assert.equal(hitTestElement(scene([diagonal]), { x: 0, y: 100 }, 1), undefined)
  assert.equal(hitTestElement(scene([diagonal]), { x: 50, y: 51 }, 1).id, 'diagonal')
  const orthogonal = edge('orthogonal', { x: 0, y: 0 }, { x: 200, y: 100 }, { route: 'orthogonal' })
  assert.equal(hitTestElement(scene([orthogonal]), { x: 100, y: 75 }, 1).id, 'orthogonal')
  assert.equal(hitTestElement(scene([orthogonal]), { x: 30, y: 50 }, 1), undefined)
})

test('line hit tolerance stays in screen pixels and accounts for thick strokes', () => {
  const line = edge('line', { x: 0, y: 0 }, { x: 100, y: 0 })
  assert.equal(hitTestElement(scene([line]), { x: 50, y: 5 }, 1).id, 'line')
  assert.equal(hitTestElement(scene([line]), { x: 50, y: 5 }, 2), undefined)
  const thick = { ...line, style: { ...DEFAULT_STYLE, strokeWidth: 20 } }
  assert.equal(hitTestElement(scene([thick]), { x: 50, y: 12 }, 2).id, 'line')
  assert.equal(hitTestElement(scene([line]), { x: 50, y: 5 }, 0).id, 'line')
})

test('closed ink hits its closing line and only filled polygons hit the interior', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  const open = ink('open', points)
  assert.equal(hitTestElement(scene([open]), { x: 50, y: 50 }, 1), undefined)
  const closed = { ...open, closed: true }
  assert.equal(hitTestElement(scene([closed]), { x: 50, y: 50 }, 1).id, 'open')
  assert.equal(hitTestElement(scene([closed]), { x: 70, y: 30 }, 1), undefined)
  const filled = { ...closed, style: { ...closed.style, fill: '#facc15' } }
  assert.equal(hitTestElement(scene([filled]), { x: 70, y: 30 }, 1).id, 'open')
  assert.equal(hitTestElement(scene([filled]), { x: 20, y: 70 }, 1), undefined)
  assert.equal(hitTestElement(scene([ink('dot', [{ x: 20, y: 20 }])]), { x: 23, y: 23 }, 1).id, 'dot')
})

test('frame border and title hit but empty frame space allows objects below to be hit', () => {
  const frame = shape('frame', 0, 0, 500, 400, { shape: 'frame', style: { ...DEFAULT_STYLE, fill: 'transparent' } })
  const document = scene([shape('inside', 100, 150), frame])
  assert.equal(hitTestElement(document, { x: 150, y: 170 }, 1).id, 'inside')
  assert.equal(hitTestElement(document, { x: 300, y: 200 }, 1), undefined)
  assert.equal(hitTestElement(document, { x: 300, y: 20 }, 1).id, 'frame')
  assert.equal(hitTestElement(document, { x: 498, y: 200 }, 1).id, 'frame')
})

test('frame contents include fully contained shapes, ink, and rendered bound edges only', () => {
  const frame = shape('frame', 0, 0, 500, 400, { shape: 'frame' })
  const a = shape('a', 20, 80, 100, 80), b = shape('b', 300, 80, 100, 80)
  const link = edge('inside-link', { x: -900, y: -900, nodeId: 'a' }, { x: 900, y: 900, nodeId: 'b' })
  const document = scene([frame, a, b, link, shape('partial', 480, 300), shape('outside', 600, 600), shape('nested-frame', 30, 40, 100, 100, { shape: 'frame' }), ink('inside-ink', [{ x: 0, y: 0 }, { x: 500, y: 400 }]), ink('crossing-ink', [{ x: 10, y: 10 }, { x: -1, y: 10 }]), ink('empty-ink', []), edge('crossing-edge', { x: 200, y: 200, nodeId: 'a' }, { x: 700, y: 200 })])
  assert.deepEqual(frameContents(document, 'frame'), ['a', 'b', 'inside-link', 'inside-ink'])
  assert.deepEqual(frameContents(document, 'missing'), [])
  assert.deepEqual(frameContents(document, 'a'), [])
})

test('a reciprocal edge routed outside a frame is excluded even when both nodes are inside', () => {
  const frame = shape('frame', 0, 0, 500, 300, { shape: 'frame' })
  const a = shape('a', 20, 20), b = shape('b', 300, 20)
  const forward = edge('forward', { x: 0, y: 0, nodeId: 'a' }, { x: 0, y: 0, nodeId: 'b' }, { route: 'orthogonal' })
  const reverse = edge('reverse', { x: 0, y: 0, nodeId: 'b' }, { x: 0, y: 0, nodeId: 'a' }, { route: 'orthogonal' })
  const document = scene([frame, a, b, forward, reverse])
  assert.deepEqual(frameContents(document, 'frame'), ['a', 'b', 'forward'])
  assert.ok(edgePoints(reverse, document).some(point => point.y < 0))
})
