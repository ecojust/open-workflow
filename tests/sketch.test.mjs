import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { DEFAULT_STYLE } from '../src/core/types.ts'
import { edgePoints } from '../src/core/geometry.ts'
import { elementToSvg, sceneToSvg } from '../src/core/svg.ts'
import { sketchPolyline } from '../src/core/sketch.ts'

const style = patch => ({ ...DEFAULT_STYLE, roughness: 'sketch', strokePattern: 'solid', ...patch })
const shape = (kind = 'rectangle', id = 'stable-node') => ({ id, type: 'shape', shape: kind, x: 30, y: 40, width: 180, height: 100, text: '文字保持清晰', style: style({ fill: '#ffeeaa' }), locked: false })
const scene = elements => ({ elements, grid: true, background: '#ffffff' })
const edge = (from, to, patch = {}) => ({ id: 'bound-edge', type: 'edge', from, to, arrow: 'both', route: 'orthogonal', label: '连接说明', style: style(), locked: false, ...patch })
function parse(svg) {
  const errors = []
  const document = new DOMParser({ onError: (level, message) => { if (!(level === 'warning' && message.includes('Unicode replacement character'))) errors.push([level, message]) } }).parseFromString(svg, 'image/svg+xml')
  assert.deepEqual(errors, [])
  assert.equal(document.documentElement.localName, 'svg')
  return document
}
function sketchPaths(markup) { return [...markup.matchAll(/<path data-sketch-pass="\d" d="([^"]+)"/g)].map(match => match[1]) }
function endpoints(path) { return [...path.matchAll(/[MC]([^MCZ]+)/g)].map(match => match[1].trim().split(/[ ,]+/).map(Number).slice(-2)) }
function containsPoint(points, point) { return points.some(([x, y]) => Math.abs(x - point.x) < 1e-8 && Math.abs(y - point.y) < 1e-8) }

test('sketch output is deterministic per element ID, independent of random global state', () => {
  const node = shape(), drawing = scene([node]), first = sceneToSvg(drawing), oldRandom = Math.random
  try { Math.random = () => { throw new Error('global random must not be used') }; assert.equal(sceneToSvg(drawing), first) } finally { Math.random = oldRandom }
  assert.notEqual(sceneToSvg(scene([{ ...node, id: 'other-seed' }])), first)
  assert.equal(sketchPaths(first).length, 2)
  assert.ok(sketchPaths(first).every(path => path.includes(' C')))
})
test('clean rectangles keep their rounded geometry and plain fill; sketch leaves typography unchanged', () => {
  const clean = shape(); clean.style.roughness = 'clean'
  const cleanMarkup = elementToSvg(clean, scene([clean])), rough = elementToSvg(shape(), scene([shape()]))
  assert.ok(cleanMarkup.includes('<rect x="30" y="40" width="180" height="100" rx="9"'))
  assert.equal(sketchPaths(cleanMarkup).length, 0)
  assert.equal(cleanMarkup.match(/<text[\s\S]+<\/text>/)[0], rough.match(/<text[\s\S]+<\/text>/)[0])
  assert.ok(rough.includes('fill="#ffeeaa" stroke="none"'))
  assert.ok(!rough.includes('fill="url('))
})
test('rectangle, ellipse, and diamond sketch passes meet attached edge endpoints exactly', () => {
  for (const kind of ['rectangle', 'ellipse', 'diamond']) {
    const node = shape(kind), link = edge({ x: 0, y: 0, nodeId: node.id }, { x: 430, y: 92 }, { route: 'straight' }), drawing = scene([node, link]), anchor = edgePoints(link, drawing)[0]
    const paths = sketchPaths(elementToSvg(node, drawing))
    assert.equal(paths.length, 2)
    for (const path of paths) assert.ok(containsPoint(endpoints(path), anchor), `${kind} sketch must pass through the binding anchor`)
    parse(sceneToSvg(drawing))
  }
})
test('sketch edge shafts and arrow tips preserve exact geometric anchor vertices', () => {
  const a = shape('ellipse', 'start'), b = { ...shape('diamond', 'end'), x: 500, y: 280 }
  const link = edge({ x: 0, y: 0, nodeId: a.id }, { x: 0, y: 0, nodeId: b.id }), drawing = scene([a, b, link]), points = edgePoints(link, drawing), markup = elementToSvg(link, drawing), paths = sketchPaths(markup)
  assert.equal(paths.length, 6)
  for (const path of paths.slice(0, 2)) for (const point of points) assert.ok(containsPoint(endpoints(path), point))
  for (const path of paths.slice(2, 4)) assert.ok(containsPoint(endpoints(path), points.at(-1)))
  for (const path of paths.slice(4)) assert.ok(containsPoint(endpoints(path), points[0]))
  b.x += 90
  const moved = edgePoints(link, drawing)
  for (const path of sketchPaths(elementToSvg(link, drawing)).slice(0, 2)) assert.ok(containsPoint(endpoints(path), moved.at(-1)))
})
test('interaction uses stable exact geometry while sketch rendering is identical to export', () => {
  const node = shape('diamond'), link = edge({ x: 0, y: 0, nodeId: node.id }, { x: 440, y: 310 }), drawing = scene([node, link])
  const screenNode = elementToSvg(node, drawing, true), exportNode = elementToSvg(node, drawing, false)
  assert.deepEqual(sketchPaths(screenNode), sketchPaths(exportNode))
  assert.ok(screenNode.includes('fill="transparent" stroke="transparent" stroke-width="16" pointer-events="all"'))
  const screenLink = elementToSvg(link, drawing, true)
  assert.ok(screenLink.includes(`d="${edgePoints(link, drawing).map((point, i) => `${i ? 'L' : 'M'}${point.x} ${point.y}`).join(' ')}" fill="none" stroke="transparent" stroke-width="18"`))
  assert.deepEqual(sketchPaths(screenLink), sketchPaths(elementToSvg(link, drawing)))
})
test('solid, dashed, and round dotted lines honor explicit pattern before legacy dashed', () => {
  for (const roughness of ['clean', 'sketch']) for (const pattern of ['solid', 'dashed', 'dotted']) {
    const node = shape(); node.style = style({ roughness, strokePattern: pattern, dashed: true })
    const svg = sceneToSvg(scene([node]))
    if (pattern === 'solid') assert.ok(!svg.includes('stroke-dasharray='))
    if (pattern === 'dashed') assert.ok(svg.includes('stroke-dasharray="8 5"'))
    if (pattern === 'dotted') assert.ok(svg.includes('stroke-dasharray="0.01 5"') && svg.includes('stroke-linecap="round"'))
    parse(svg)
  }
  const legacy = shape(); delete legacy.style.strokePattern; legacy.style.dashed = true
  assert.ok(sceneToSvg(scene([legacy])).includes('stroke-dasharray="8 5"'))
})
test('dotted and dashed shafts retain solid arrowheads in both clean and sketch modes', () => {
  for (const roughness of ['clean', 'sketch']) for (const strokePattern of ['dotted', 'dashed']) {
    const link = edge({ x: 10, y: 40 }, { x: 260, y: 40 }, { label: '', style: style({ roughness, strokePattern, dashed: true }) })
    const document = parse(sceneToSvg(scene([link]))), paths = Array.from(document.getElementsByTagName('path'))
    const passes = roughness === 'sketch' ? 2 : 1
    assert.equal(paths.length, passes * 3)
    for (const shaft of paths.slice(0, passes)) assert.equal(shaft.getAttribute('stroke-dasharray'), strokePattern === 'dotted' ? '0.01 5' : '8 5')
    for (const head of paths.slice(passes)) assert.equal(head.hasAttribute('stroke-dasharray'), false)
    if (roughness === 'sketch') assert.ok(paths.every(path => path.hasAttribute('data-sketch-pass')))
    assert.equal(link.style.strokePattern, strokePattern, 'rendering must not mutate the saved edge style')
  }
})
test('zero-width notes and transparent outlines gain no extra sketch border; text elements stay unframed', () => {
  const note = shape('note'); note.style.strokeWidth = 0
  const transparent = shape('ellipse'); transparent.style.stroke = 'transparent'
  const text = shape('text')
  for (const node of [note, transparent, text]) assert.equal(sketchPaths(elementToSvg(node, scene([node]))).length, 0)
  const markup = elementToSvg(text, scene([text]))
  assert.ok(markup.startsWith('<rect x="30" y="40" width="180" height="100" fill="transparent"/>'))
  assert.ok(!markup.includes('stroke-width='))
})
test('sketch exports remain valid XML with untrusted labels and IDs and never import external resources', () => {
  const node = shape('ellipse', 'id"/><script>bad</script>'); node.text = '<script>& "中文" \u0000 😊'
  const svg = sceneToSvg(scene([node]))
  const document = parse(svg)
  assert.equal(document.getElementsByTagName('script').length, 0)
  assert.ok(!svg.includes('id"/><script>'))
  assert.ok(svg.includes('&lt;script&gt;') && svg.includes('😊'))
})
test('sketch deviation stays bounded for huge coordinates and thick arrows fit the export viewport', () => {
  const link = edge({ x: 999900, y: -999900 }, { x: 1000000, y: -999850 }, { route: 'straight', label: '', style: style({ strokeWidth: 100 }) }), svg = sceneToSvg(scene([link]))
  assert.ok(!/NaN|Infinity/.test(svg))
  const doc = parse(svg), [x, y, width, height] = doc.documentElement.getAttribute('viewBox').split(' ').map(Number)
  for (const path of sketchPaths(svg)) {
    const values = path.replace(/[MCZ]/g, ' ').trim().split(/\s+/).map(Number)
    for (let i = 0; i < values.length; i += 2) assert.ok(values[i] >= x && values[i] <= x + width && values[i + 1] >= y && values[i + 1] <= y + height)
  }
  const paths = sketchPolyline([{ x: 0, y: 0 }, { x: 1000000, y: 0 }], 'huge', 100)
  for (const path of paths) { const values = path.replace(/[MCZ]/g, ' ').trim().split(/\s+/).map(Number); for (let i = 1; i < values.length; i += 2) assert.ok(Math.abs(values[i]) <= 3.5) }
  const hitMarkup = elementToSvg(link, scene([link]), true)
  assert.equal([...hitMarkup.matchAll(/stroke="transparent" stroke-width="100"/g)].length, 3, 'shaft and both wide arrow tips keep exact, wide hit areas')
})
test('large existing freehand gestures preserve every original point without quadratic expansion', () => {
  const points = Array.from({ length: 100000 }, (_, i) => ({ x: i, y: i % 100 }))
  const ink = { id: 'large-ink', type: 'stroke', points, locked: false, style: style({ strokePattern: 'dotted' }) }
  const markup = elementToSvg(ink, scene([ink]))
  assert.equal(sketchPaths(markup).length, 0)
  assert.ok(markup.includes('L99999 99'))
  assert.ok(markup.length < 1600000)
  assert.ok(markup.includes('stroke-dasharray="0.01 5"'))
})
