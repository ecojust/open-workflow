import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { compileChartDiagram, CHART_TEMPLATES } from '../src/core/diagrams/charts.ts'
import { MermaidSyntaxError } from '../src/core/diagrams/common.ts'
import { createDocument, serializeDocument, parseDocument } from '../src/core/documents.ts'
import { sceneToSvg } from '../src/core/svg.ts'

const element = (result, id) => {
  const found = result.scene.elements.find(item => item.id === id)
  assert.ok(found, `Missing ${id}`)
  return found
}
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
const invalid = (source, pattern, line) => assert.throws(() => compileChartDiagram(source), error => {
  assert.ok(error instanceof MermaidSyntaxError, error.stack)
  assert.match(error.message, pattern)
  if (line) assert.equal(error.line, line)
  return true
})

test('all chart templates create deterministic editable scenes, valid SVG and reopenable native documents', () => {
  assert.equal(new Set(CHART_TEMPLATES.map(template => template.id)).size, CHART_TEMPLATES.length)
  for (const template of CHART_TEMPLATES) {
    const result = compileChartDiagram(template.source)
    assert.ok(result?.scene.elements.length > 10, template.id)
    assert.deepEqual(compileChartDiagram(template.source), result)
    assert.ok(result.scene.elements.every(item => item.type !== 'shape' || item.shape !== 'image'))
    const document = createDocument('flow')
    document.scene = result.scene
    assert.deepEqual(parseDocument(serializeDocument(document)).scene, result.scene)
    const errors = []
    const xml = new DOMParser({ onError: (level, message) => errors.push(message) }).parseFromString(sceneToSvg(result.scene), 'image/svg+xml')
    assert.equal(xml.documentElement.tagName, 'svg')
    assert.deepEqual(errors, [], template.id)
  }
})

test('pie uses proportional closed filled sectors and supports inline title and zero categories', () => {
  const result = compileChartDiagram('pie showData title 分配\n"A": 1\n"B": 3\n"空": 0')
  assert.equal(result.kind, 'pie')
  assert.equal(element(result, 'chart-title').text, '分配')
  const first = element(result, 'pie-sector-0'), second = element(result, 'pie-sector-1')
  assert.equal(first.type, 'stroke')
  assert.equal(first.closed, true)
  assert.notEqual(first.style.fill, 'none')
  near(first.points[1].x, 320); near(first.points[1].y, 120)
  near(first.points.at(-1).x, 540); near(first.points.at(-1).y, 340)
  near(second.points[1].x, first.points.at(-1).x)
  assert.ok(!result.scene.elements.some(item => item.id === 'pie-sector-2'))
  assert.match(element(result, 'pie-label-2').text, /空.*0/)
  assert.match(sceneToSvg(result.scene), /fill="#6389e7"/)
})

test('pie rejects missing totals, negative values, duplicate labels and unknown instructions with real line numbers', () => {
  invalid('%% comment\n\npie\n"A": -1', /负数/, 4)
  invalid('pie\n"A": 0', /大于零/, 1)
  invalid('pie\n"A": 2\n"A": 3', /重复/, 3)
  invalid('pie\n"A": 1e309', /有限/, 2)
  invalid('pie\nstyle A fill:red', /格式/, 2)
  invalid(`pie\n${Array.from({ length: 65 }, (_, i) => `"${i}": 1`).join('\n')}`, /64/, 66)
})

test('gantt strictly resolves UTC calendar dates, leap days, multiple dependencies and milestones', () => {
  const result = compileChartDiagram(`gantt
dateFormat YYYY-MM-DD
axisFormat %Y-%m-%d
section 准备
任务A :done, a, 2024-02-28, 2d
任务B :b, 2024-02-29, 1w
section 后续
任务C :crit, c, after a b, 2024-03-09
交付 :milestone, m, after c, 0d`)
  assert.equal(result.kind, 'gantt')
  const a = element(result, 'gantt-task-a'), b = element(result, 'gantt-task-b'), c = element(result, 'gantt-task-c'), m = element(result, 'gantt-task-m')
  near(b.width / a.width, 3.5)
  near(c.x, b.x + b.width)
  near(m.x + m.width / 2, c.x + c.width)
  assert.equal(m.shape, 'diamond')
  assert.match(element(result, 'gantt-detail-a').text, /2024-02-28 · 2 天/)
  assert.match(element(result, 'gantt-detail-c').text, /2024-03-07 · 2 天/)
  assert.equal(result.scene.elements.filter(item => item.type === 'edge').length, 3)
})

test('gantt resolves forward references and implicit sequential starts but rejects cycles and invalid dates', () => {
  const result = compileChartDiagram('gantt\n后续 :b, after a, 1d\n准备 :a, 2026-01-01, 1d\n接续 :2d')
  near(element(result, 'gantt-task-b').x, element(result, 'gantt-task-a').x + element(result, 'gantt-task-a').width)
  assert.match(element(result, 'gantt-detail-task-3').text, /2026-01-02/)
  invalid('gantt\nA:a,2025-02-29,1d', /无效日期/, 2)
  invalid('gantt\nA:a,2024-04-31,1d', /无效日期/, 2)
  invalid('gantt\nA:a,2026-01-01,1h', /时长/, 2)
  invalid('gantt\nA:a,after b,1d\nB:b,after a,1d', /循环依赖/)
  invalid('gantt\nA:a,after missing,1d', /找不到依赖/, 2)
  invalid('gantt\nA:2d', /首个任务/, 2)
  invalid('gantt\nexcludes weekends', /排除日期/, 2)
  invalid('gantt\ndateFormat DD-MM-YYYY', /仅支持/, 2)
  invalid('gantt\nA:a,2026-01-02,2026-01-01', /结束时间/, 2)
})

test('XY chart renders grouped bars and line series against a shared numerical scale', () => {
  const result = compileChartDiagram('xychart-beta\nx-axis "季度" ["一", "二", "三"]\ny-axis "产出" 0 --> 100\nbar [20,40,80]\nbar [40,50,70]\nline [10,60,90]')
  assert.equal(result.kind, 'xychart')
  const bar0 = element(result, 'xy-bar-0-0'), bar1 = element(result, 'xy-bar-0-1'), other = element(result, 'xy-bar-1-0')
  near(bar1.height, bar0.height * 2)
  assert.ok(other.x > bar0.x)
  near(other.y + other.height, bar0.y + bar0.height)
  const line = element(result, 'xy-line-2')
  assert.equal(line.points.length, 3)
  assert.ok(line.points[2].y < line.points[1].y)
  assert.equal(element(result, 'xy-x-title').text, '季度')
})

test('horizontal XY plots retain signed values and invalid series never get silently clipped', () => {
  const result = compileChartDiagram('xychart-beta horizontal\nx-axis [A,B,C]\ny-axis -10 --> 10\nbar [-5,0,10]\nline [-10,2,8]')
  const negative = element(result, 'xy-bar-0-0'), positive = element(result, 'xy-bar-0-2')
  near(positive.width, negative.width * 2)
  near(negative.x + negative.width, positive.x)
  invalid('xychart-beta\nx-axis [A,B]\nbar [1]', /分类数量/, 2)
  invalid('xychart-beta\nbar [1,2]\nline [1]', /长度必须相同/, 3)
  invalid('xychart-beta\ny-axis 0 --> 10\nbar [11]', /超出了/, 3)
  invalid('xychart-beta\ny-axis 10 --> 10\nbar [1]', /结束值/, 2)
  invalid('xychart-beta\nline [NaN]', /有效数值/, 2)
  invalid('xychart-beta\nline [1,,2]', /空项/, 2)
  invalid('xychart-beta\nstyle A fill:red', /支持/, 2)
})

test('quadrant positions follow normalized coordinates and conventional quadrant ordering', () => {
  const result = compileChartDiagram('quadrantChart\nx-axis 小 --> 大\ny-axis 低 --> 高\nquadrant-1 高价值\nA: [0,0]\nB: [1,1]\nC: [0.5,0.5]')
  const a = element(result, 'quadrant-point-0'), b = element(result, 'quadrant-point-1'), c = element(result, 'quadrant-point-2')
  assert.ok(a.x < b.x && a.y > b.y)
  near(c.x, (a.x + b.x) / 2); near(c.y, (a.y + b.y) / 2)
  assert.equal(element(result, 'quadrant-title-1').text, '高价值')
  assert.ok(element(result, 'quadrant-area-1').x > element(result, 'quadrant-area-2').x)
  invalid('quadrantChart\nA: [1.01,0.5]', /0 到 1/, 2)
  invalid('quadrantChart\nA: [0.2]', /数据格式/, 2)
  invalid('quadrantChart\nx-axis low', /坐标轴格式/, 2)
  invalid('quadrantChart\nclassDef red fill:red', /样式指令/, 2)
})

test('chart text is XML escaped and non-chart families remain available to other parsers', () => {
  const result = compileChartDiagram(`pie\n${JSON.stringify('<script>alert(1)</script> & "quoted"')}: 1`)
  const svg = sceneToSvg(result.scene)
  assert.ok(!svg.includes('<script>'))
  assert.match(svg, /&lt;script&gt;/)
  assert.equal(compileChartDiagram('flowchart TD\nA-->B'), undefined)
  assert.equal(compileChartDiagram('sequenceDiagram\nA->>B: hi'), undefined)
})

test('sankey CSV supports quoted names and renders true flow bands with proportional widths', () => {
  const result = compileChartDiagram('sankey-beta\n"预算,来源",实施,30\n"预算,来源","支持""服务",10\n实施,交付,30\n"支持""服务",交付,10')
  assert.equal(result.kind, 'sankey')
  const first = element(result, 'sankey-flow-0'), second = element(result, 'sankey-flow-1')
  assert.equal(first.closed, true)
  assert.notEqual(first.style.fill, 'none')
  const width = flow => flow.points.at(-1).y - flow.points[0].y
  near(width(first), width(second) * 3)
  assert.ok(element(result, 'sankey-node-0').x < element(result, 'sankey-node-1').x)
  assert.ok(element(result, 'sankey-node-1').x < element(result, 'sankey-node-3').x)
  assert.match(element(result, 'sankey-label-0').text, /预算,来源/)
  assert.match(element(result, 'sankey-label-2').text, /支持"服务/)
})

test('sankey refuses cyclic, nonpositive, malformed or excessive flows without dropping rows', () => {
  invalid('sankey-beta\nA,B,5\nB,A,5', /循环流向/)
  invalid('sankey-beta\nA,A,5', /自身回流/, 2)
  invalid('sankey-beta\nA,B,0', /大于零/, 2)
  invalid('sankey-beta\nA,B,-3', /大于零/, 2)
  invalid('sankey-beta\nA,B', /三个 CSV 字段/, 2)
  invalid('sankey-beta\n"A,B,C', /双引号未闭合/, 2)
  invalid('sankey-beta\n"A"x,B,2', /引号后/, 2)
  invalid('sankey-beta\nA,B,1,', /空字段/, 2)
  invalid(`sankey-beta\n${Array.from({ length: 61 }, (_, i) => `A,B${i},1`).join('\n')}`, /60 个节点/)
})

test('radar parses official axis and curve declarations, keyed values and proportional radial geometry', () => {
  const result = compileChartDiagram(`radar-beta
axis a["规划"], b["开发,交付"], c["验证"]
curve current["当前"]{5, 5, 5}, target["目标"]{c: 10, a: 10, b: 10}
min 0
max 10
ticks 4
graticule polygon
showLegend true`)
  assert.equal(result.kind, 'radar')
  const a = element(result, 'radar-curve-current'), b = element(result, 'radar-curve-target')
  assert.equal(a.closed, true)
  const radius = point => Math.hypot(point.x - 420, point.y - 390)
  a.points.forEach((point, i) => near(radius(point), radius(b.points[i]) / 2))
  assert.equal(element(result, 'radar-grid-1').closed, true)
  assert.equal(element(result, 'radar-label-b').text, '开发,交付')
  assert.equal(element(result, 'radar-legend-target').text, '目标')
  const circle = compileChartDiagram('radar-beta\naxis a,b,c\ncurve one{1,2,3}\ngraticule circle\nshowLegend false')
  assert.equal(element(circle, 'radar-grid-1').shape, 'ellipse')
  assert.ok(!circle.scene.elements.some(item => item.id.startsWith('radar-legend-')))
})

test('radar reports incomplete axes, mismatched data, invalid ranges and unsupported directives', () => {
  invalid('radar-beta\naxis a,b\ncurve one{1,2}', /至少 3 个轴/)
  invalid('radar-beta\naxis a,b,a\ncurve one{1,2,3}', /ID 不能重复/, 2)
  invalid('radar-beta\naxis a,b,c\ncurve one{1,2}', /数量必须/, 3)
  invalid('radar-beta\naxis a,b,c\ncurve one{a:1,b:2,d:3}', /未知的轴/, 3)
  invalid('radar-beta\naxis a,b,c\ncurve one{a:1,b:2}', /全部轴/, 3)
  invalid('radar-beta\naxis a,b,c\ncurve one{1,2,3}\nmax 2', /超出了/, 3)
  invalid('radar-beta\naxis a,b,c\ncurve one{1,2,3}\nticks 0', /ticks/, 4)
  invalid('radar-beta\naxis a,b,c\ncurve one{1,2,3}\ngraticule star', /circle 或 polygon/, 4)
  invalid('radar-beta\naxis a,b,c\ncurve one{1,2,3}\nshowLegend yes', /true 或 false/, 4)
  invalid('radar-beta\nclassDef active fill:red', /支持/, 2)
})

test('treemap keeps hierarchy, exact proportional leaf areas and a complete readable legend', () => {
  const result = compileChartDiagram('treemap-beta\n"Root"\n  "Group A"\n    "One": 10\n    "Two": 30\n  "Group B"\n    "Three": 60')
  assert.equal(result.kind, 'treemap')
  const leaves = result.scene.elements.filter(item => item.id.startsWith('treemap-leaf-'))
  assert.equal(leaves.length, 3)
  const area = leaf => Math.abs((leaf.points[1].x - leaf.points[0].x) * (leaf.points[2].y - leaf.points[1].y))
  near(area(leaves[1]) / area(leaves[0]), 3)
  near(area(leaves[2]) / area(leaves[0]), 6)
  near(leaves.reduce((sum, item) => sum + area(item), 0), 980 * 580)
  assert.equal(element(result, 'chart-title').text, 'Root')
  assert.equal(result.scene.elements.filter(item => item.id.startsWith('treemap-group-')).length, 3)
  assert.match(element(result, 'treemap-detail-2').text, /Root \/ Group A \/ One.*10%/)
  const tiny = compileChartDiagram('treemap-beta\n"small": 0.00001\n"large": 10000')
  assert.equal(tiny.scene.elements.filter(item => item.id.startsWith('treemap-leaf-')).length, 2)
  assert.ok(tiny.warnings.some(message => /较小/.test(message)))
  assert.match(element(tiny, 'treemap-detail-0').text, /small/)
})

test('treemap rejects empty groups, nonpositive leaves, inconsistent indentation and unsupported classes', () => {
  invalid('treemap-beta\n"A"', /没有叶子/, 2)
  invalid('treemap-beta\n"A": 0', /大于零/, 2)
  invalid('treemap-beta\n"A": -1', /大于零/, 2)
  invalid('treemap-beta\n"A": 1\n  "B": 2', /叶子不能/, 3)
  invalid('treemap-beta\n"A"\n    "B": 1\n  "C": 2', /一致缩进/, 4)
  invalid('treemap-beta\n"A"\n\t"B": 1', /制表符/, 3)
  invalid('treemap-beta\n"A": 2:::myclass', /样式类/, 2)
  invalid(`treemap-beta\n${Array.from({ length: 201 }, (_, i) => `"${i}": 1`).join('\n')}`, /200 个条目/)
})

test('dense and tiny XY values keep proportions without violating the native schema', () => {
  const series = `bar [${Array.from({ length: 100 }, (_, i) => (i + 1) / 1000).join(',')}]`
  const result = compileChartDiagram(`xychart-beta horizontal\ny-axis 0 --> 1000\n${Array(8).fill(series).join('\n')}`)
  const first = element(result, 'xy-bar-0-0'), second = element(result, 'xy-bar-0-1')
  assert.equal(first.type, 'stroke')
  assert.equal(first.closed, true)
  near(second.points[1].x - second.points[0].x, (first.points[1].x - first.points[0].x) * 2)
  const document = createDocument('flow'); document.scene = result.scene
  assert.deepEqual(parseDocument(serializeDocument(document)).scene, result.scene)
})
