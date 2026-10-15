import test from 'node:test'
import assert from 'node:assert/strict'
import { compileChartDiagram, CHART_TEMPLATES } from '../src/core/diagrams/charts.ts'
import { DiagramSyntaxError, lookupDiagramSource } from '../src/core/diagrams/common.ts'
import { sceneToSvg } from '../src/core/svg.ts'

const compile = source => {
  const result = compileChartDiagram(source)
  assert.ok(result)
  return result
}
const element = (result, id) => {
  const item = result.scene.elements.find(item => item.id === id)
  assert.ok(item, `Missing ${id}`)
  return item
}
const items = (result, prefix) => result.scene.elements.filter(item => item.id.startsWith(prefix))
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`)
const invalid = (source, pattern, line) => assert.throws(() => compile(source), error => {
  assert.ok(error instanceof DiagramSyntaxError)
  assert.match(error.message, pattern)
  if (line) assert.equal(error.line, line)
  return true
})
const mapped = (source, statement) => {
  const result = compile(source)
  return lookupDiagramSource(result.sourceMap, source.indexOf(statement) + 1)
}

test('chart catalog preserves base IDs, has complementary rich business templates and real source mappings', () => {
  assert.deepEqual(CHART_TEMPLATES.slice(0, 7).map(item => item.id), ['pie', 'gantt', 'xychart', 'quadrant', 'sankey', 'radar', 'treemap'])
  for (const kind of ['pie', 'gantt', 'xychart', 'quadrant', 'sankey', 'radar', 'treemap']) {
    const templates = CHART_TEMPLATES.filter(item => item.kind === kind)
    assert.ok(templates.length >= 2, kind)
    for (const template of templates) {
      const result = compile(template.source), ids = new Set(result.scene.elements.map(item => item.id))
      assert.ok(template.source.includes('%%'), template.id)
      assert.ok(result.scene.elements.length > 10, template.id)
      assert.ok(result.sourceMap.length >= 5, template.id)
      for (const range of result.sourceMap) {
        assert.ok(!template.source.slice(range.start, range.end).startsWith('%%'))
        assert.ok(range.elementIds.every(id => ids.has(id)))
      }
      assert.deepEqual(compile(template.source), result, template.id)
    }
  }
})

test('pie inner radius creates true annular sectors and hidden legends remove their shapes', () => {
  const source = 'pie showData title 容量\ninnerRadius 0.5\nshowLegend false\n"A":3\n"B":1'
  const result = compile(source), sector = element(result, 'pie-sector-0')
  assert.equal(sector.closed, true)
  const radii = sector.points.map(point => Math.hypot(point.x - 320, point.y - 340))
  assert.ok(radii.every(radius => Math.abs(radius - 110) < 1e-7 || Math.abs(radius - 220) < 1e-7))
  assert.equal(items(result, 'pie-label-').length, 0)
  assert.equal(items(result, 'pie-key-').length, 0)
  assert.ok(mapped(source, 'innerRadius').includes('pie-sector-0'))
  assert.ok(sceneToSvg(result.scene).includes('75%'))
  invalid('pie\ninnerRadius 0.81\n"A":1', /0 到 0.8/, 2)
  invalid('pie\nshowLegend yes\n"A":1', /true 或 false/, 2)
  invalid('pie\ninnerRadius .5\ninnerRadius .3\n"A":1', /重复/, 3)
})

test('gantt work durations exclude holidays, allow included weekends and shift dependency starts', () => {
  const source = `gantt
excludes weekends, 2026-10-12
includes 2026-10-10
tickInterval 1d
A :a, 2026-10-09, 2d
B :b, after a, 2d
交接 :milestone, m, after b, 0d`
  const result = compile(source), a = element(result, 'gantt-task-a'), b = element(result, 'gantt-task-b')
  near(a.width, 860 * 2 / 6)
  near(b.x - a.x, 860 * 4 / 6)
  near(b.width, 860 * 2 / 6)
  assert.match(element(result, 'gantt-detail-b').text, /2026-10-13 · 2 日历天/)
  assert.equal(items(result, 'gantt-excluded-').length, 1)
  near(element(result, 'gantt-excluded-0').width, 860 * 2 / 6)
  assert.equal(items(result, 'gantt-tick-').length, 7)
  assert.match(element(result, 'gantt-calendar-note').text, /工作日历/)
  assert.ok(mapped(source, 'includes').includes('gantt-task-b'))
  assert.ok(mapped(source, 'tickInterval').includes('gantt-grid-0'))
})

test('gantt fixed ends, milestones and until use exact exclusive UTC boundaries', () => {
  const result = compile(`gantt
excludes weekends
准备 :a, 2026-10-10, 2026-10-15
观察 :b, after a, until cutover
切换 :milestone, cutover, 2026-10-17, 0d`)
  assert.match(element(result, 'gantt-detail-a').text, /2026-10-12 · 3 日历天/)
  near(element(result, 'gantt-task-b').x + element(result, 'gantt-task-b').width, element(result, 'gantt-task-cutover').x + 11)
  near(element(result, 'gantt-task-a').width, 860 * 3 / 5)
  invalid('gantt\nA:a,2026-01-01,until missing', /未知任务/, 2)
  invalid('gantt\nA:a,2026-01-01,until b\nB:b,after a,1d', /循环依赖/)
  invalid('gantt\nA:milestone,a,2026-01-01,until b\nB:b,2026-01-02,1d', /里程碑不支持/, 2)
})

test('gantt work calendars and custom ticks reject impossible or excessive schedules', () => {
  invalid('gantt\nexcludes monday,tuesday,wednesday,thursday,friday,saturday,sunday\nA:a,2026-01-01,1d', /没有可用日期/, 3)
  invalid('gantt\nincludes weekends\nA:a,2026-01-01,1d', /日期必须/, 2)
  invalid('gantt\nexcludes 2026-02-30\nA:a,2026-01-01,1d', /无效日期/, 2)
  invalid('gantt\ntickInterval 0d\nA:a,2026-01-01,1d', /时长/, 2)
  invalid('gantt\ntickInterval 1d\nA:a,2026-01-01,300d', /刻度超过 200/, 2)
  invalid('gantt\nexcludes weekends\nA:a,2026-01-01,36525d', /跨度超过/, 3)
  invalid('gantt\nexcludes weekends\nexcludes monday\nA:a,2026-01-01,1d', /重复/, 3)
  const result = compile('gantt\nexcludes weekends\nA:a,2026-01-05,1w')
  assert.match(element(result, 'gantt-detail-a').text, /9 日历天/)
})

test('XY named series create semantic legends with explicit numeric ticks and unchanged grouped geometry', () => {
  const source = 'xychart-beta\nx-axis [一,二,三]\ny-axis -10 --> 20\ny-ticks 3\nbar "实际" [2,5,9]\nbar "计划" [3,6,10]\nline "预警" [-5,0,15]'
  const result = compile(source)
  assert.equal(element(result, 'xy-legend-0').text, '实际')
  assert.equal(element(result, 'xy-legend-2').text, '预警')
  assert.deepEqual(items(result, 'xy-y-tick-').map(item => item.text), ['-10', '0', '10', '20'])
  assert.ok(element(result, 'xy-bar-0-0').x < element(result, 'xy-bar-1-0').x)
  assert.ok(mapped(source, 'line "预警"').includes('xy-legend-2'))
  assert.ok(mapped(source, 'y-ticks').includes('xy-grid-3'))
  const hidden = compile('xychart-beta horizontal\nx-axis 0 --> 24\nshowLegend false\nline "偏差" [-3,2,8]')
  assert.equal(items(hidden, 'xy-legend-').length, 0)
  assert.equal(element(hidden, 'xy-x-tick-2').text, '24')
  invalid('xychart-beta\nbar "同名" [1]\nline "同名" [2]', /名称不能重复/, 3)
  invalid('xychart-beta\ny-ticks 2.5\nbar [1]', /整数/, 2)
  invalid('xychart-beta\nshowLegend on\nbar [1]', /true 或 false/, 2)
})

test('quadrant class styles and per-point overrides change real radius, fill and outline geometry', () => {
  const source = `quadrantChart
A:::urgent: [0.5,0.5] radius:12,color:#090
B:::urgent: [0.2,0.8]
classDef urgent color:#aabbcc,radius:9,stroke-color:#112233,stroke-width:3`
  const result = compile(source), a = element(result, 'quadrant-point-0'), b = element(result, 'quadrant-point-1')
  assert.equal(a.width, 24); assert.equal(b.width, 18)
  assert.equal(a.style.fill, '#090'); assert.equal(b.style.fill, '#aabbcc')
  assert.equal(a.style.stroke, '#112233'); assert.equal(a.style.strokeWidth, 3)
  near(a.x + 12, 560); near(a.y + 12, 380)
  assert.ok(mapped(source, 'classDef').includes('quadrant-point-0'))
  assert.ok(mapped(source, 'classDef').includes('quadrant-label-1'))
  invalid('quadrantChart\nA:::missing: [0.5,0.5]', /找不到样式类/, 2)
  invalid('quadrantChart\nA: [0.5,0.5] radius:31', /2 到 30/, 2)
  invalid('quadrantChart\nclassDef a color:url(https://example.test/a)\nA:::a:[0,0]', /颜色使用/, 2)
  invalid('quadrantChart\nclassDef a radius:5,radius:6\nA:::a:[0,0]', /不能重复/, 2)
  invalid('quadrantChart\nA:[0,0] cursor:pointer', /不支持样式属性/, 2)
})

const flows = 'A,B,10\nB,C,10\nD,C,5\nA,E,5'
test('sankey alignment changes column placement while preserving forward proportional flows', () => {
  const left = compile(`sankey-beta\nnodeAlign left\n${flows}`)
  const right = compile(`sankey-beta\nnodeAlign right\n${flows}`)
  const justify = compile(`sankey-beta\nnodeAlign justify\n${flows}`)
  // D is a short independent source; E is a short terminal branch.
  near(element(left, 'sankey-node-3').x, 100)
  near(element(right, 'sankey-node-3').x, 360)
  near(element(left, 'sankey-node-4').x, 360)
  near(element(justify, 'sankey-node-4').x, 620)
  for (const result of [left, right, justify]) {
    for (const flow of items(result, 'sankey-flow-')) assert.ok(flow.points[24].x > flow.points[0].x)
    const large = element(result, 'sankey-flow-0'), small = element(result, 'sankey-flow-3')
    near(large.points[49].y - large.points[0].y, 2 * (small.points[49].y - small.points[0].y))
  }
})

test('sankey flow colors, labels and title are applied rather than accepted and ignored', () => {
  const source = `sankey-beta\ntitle "业务,转化"\nlinkColor target\nshowValues false\n${flows}`
  const result = compile(source)
  assert.equal(element(result, 'chart-title').text, '业务,转化')
  assert.equal(element(result, 'sankey-flow-0').style.fill, element(result, 'sankey-node-1').style.fill)
  assert.equal(element(result, 'sankey-label-0').text, 'A')
  assert.ok(mapped(source, 'linkColor').includes('sankey-flow-0'))
  assert.ok(mapped(source, 'showValues').includes('sankey-label-0'))
  assert.equal(element(compile(`sankey-beta\nlinkColor #456789\n${flows}`), 'sankey-flow-0').style.fill, '#456789')
  invalid(`sankey-beta\nnodeAlign center\n${flows}`, /支持 left/, 2)
  invalid(`sankey-beta\nlinkColor url(bad)\n${flows}`, /颜色使用/, 2)
  invalid(`sankey-beta\nshowValues 0\n${flows}`, /true 或 false/, 2)
})

test('radar rotation and per-curve styles change axes, polygon fill and legend text', () => {
  const source = `radar-beta
axis a["响应"],b["质量"],c["效率"]
curve actual["当前"]{a:50,b:100,c:75}
min 0
max 100
rotation 0
curveStyle actual fill:#abcded,stroke:#135790,stroke-width:4,opacity:0.6,color:#321654`
  const result = compile(source), axis = element(result, 'radar-axis-a'), curve = element(result, 'radar-curve-actual')
  near(axis.points[1].x, 660); near(axis.points[1].y, 390)
  assert.equal(curve.style.fill, '#abcded'); assert.equal(curve.style.stroke, '#135790')
  assert.equal(curve.style.opacity, .6); assert.equal(curve.style.strokeWidth, 4)
  assert.equal(element(result, 'radar-legend-actual').style.stroke, '#321654')
  assert.ok(mapped(source, 'rotation').includes('radar-axis-a'))
  assert.ok(mapped(source, 'curveStyle').includes('radar-curve-actual'))
  invalid('radar-beta\naxis a,b,c\ncurve c{1,2,3}\ncurveStyle missing fill:#fff', /未知曲线/, 4)
  invalid('radar-beta\naxis a,b,c\ncurve c{1,2,3}\nrotation 361', /-360 到 360/, 4)
  invalid('radar-beta\naxis a,b,c\ncurve c{1,2,3}\ncurveStyle c opacity:2', /0 到 1/, 4)
})

test('treemap class inheritance and leaf override preserve proportional area and readable labels', () => {
  const source = `treemap-beta
title 投入结构
classDef family fill:#337799,stroke:#ffffff,stroke-width:2,color:#ffffff
classDef focus fill:#bb8844,color:#112233,opacity:0.7
"分组":::family
  "A":3
  "B":1:::focus`
  const result = compile(source), a = element(result, 'treemap-leaf-1'), b = element(result, 'treemap-leaf-2')
  assert.equal(element(result, 'chart-title').text, '投入结构')
  assert.equal(a.style.fill, '#337799'); assert.equal(b.style.fill, '#bb8844')
  assert.equal(b.style.strokeWidth, 2); assert.equal(b.style.opacity, .7)
  assert.equal(element(result, 'treemap-label-2').style.stroke, '#112233')
  near(a.points[1].x - a.points[0].x, 3 * (b.points[1].x - b.points[0].x))
  assert.ok(mapped(source, 'classDef family').includes('treemap-leaf-2'))
  assert.ok(mapped(source, 'classDef focus').includes('treemap-label-2'))
  const hidden = compile('treemap-beta\nshowValues false\n"A":3\n"B":1')
  assert.equal(element(hidden, 'treemap-label-0').text, 'A')
  assert.equal(element(hidden, 'treemap-detail-0').text, 'A')
  invalid('treemap-beta\nclassDef a fill:red\n"A":1:::a', /颜色使用/, 2)
  invalid('treemap-beta\nclassDef a stroke-width:13\n"A":1:::a', /0 到 12/, 2)
  invalid('treemap-beta\nshowValues yes\n"A":1', /true 或 false/, 2)
})
