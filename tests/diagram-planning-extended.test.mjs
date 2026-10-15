import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { compilePlanningDiagram, PLANNING_TEMPLATES } from '../src/core/diagrams/planning.ts'
import { DiagramSyntaxError, lookupDiagramSource } from '../src/core/diagrams/common.ts'
import { edgePoints, pathMidpoint, sceneBounds } from '../src/core/geometry.ts'
import { sceneToSvg } from '../src/core/svg.ts'
import { validateScene } from '../src/core/documents.ts'

const compile = source => { const result = compilePlanningDiagram(source); assert.ok(result); return result }
const element = (result, id) => { const item = result.scene.elements.find(item => item.id === id); assert.ok(item, id); return item }
const locate = (result, source, token) => { const offset = source.indexOf(token); assert.ok(offset >= 0); return lookupDiagramSource(result.sourceMap, offset) }
const reject = (source, line) => assert.throws(() => compile(source), error => error instanceof DiagramSyntaxError && (line === undefined || error.line === line), source)

// Check layout and retained bindings, rather than comparing implementation snapshots.
test('nested block groups contain their children and retain bound cross-group connections', () => {
  const source = `block
columns 2
block:left[入口组]
  columns 2
  a[接收] b{检查}
  block:inner[处理组]:2
    columns 1
    c[[处理步骤]]
    d[(存储)]
  end
end
block:right[交付组]
  columns 1
  e[/交付数据/]
end
b --> c
d -->|提交| e`
  const result = compile(source)
  for (const [parentId, childIds] of [['left', ['a', 'b', 'inner']], ['inner', ['c', 'd']], ['right', ['e']]]) {
    const parent = element(result, `block-${parentId}`)
    for (const id of childIds) {
      const child = element(result, `block-${id}`)
      assert.ok(child.x >= parent.x + 12 && child.y >= parent.y + 40)
      assert.ok(child.x + child.width <= parent.x + parent.width - 12)
      assert.ok(child.y + child.height <= parent.y + parent.height - 12)
    }
  }
  assert.ok(element(result, 'block-right').x >= element(result, 'block-left').x + element(result, 'block-left').width + 20)
  const edges = result.scene.elements.filter(item => item.type === 'edge')
  assert.equal(edges.length, 2)
  for (const edge of edges) {
    assert.ok(result.scene.elements.some(item => item.id === edge.from.nodeId))
    assert.ok(result.scene.elements.some(item => item.id === edge.to.nodeId))
    assert.ok(edgePoints(edge, result.scene).every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))
  }
  assert.deepEqual(locate(result, source, 'block:inner'), ['block-inner', 'block-inner:title'])
  assert.deepEqual(locate(result, source, 'b --> c'), ['block-edge-0'])
  assert.deepEqual(locate(result, source, 'c[[处理步骤]]'), ['block-c', 'block-c:side:0', 'block-c:side:1'])
  assert.deepEqual(validateScene(result.scene), result.scene)
})

test('each block group independently places nodes in all four directions without rotating labels', () => {
  for (const direction of ['LR', 'RL', 'TB', 'BT']) {
    const result = compile(`block\ncolumns 1\nblock:g[分组]\ncolumns 2\ndirection ${direction}\na[甲] b[乙]\nend`)
    const a = element(result, 'block-a'), b = element(result, 'block-b')
    if (direction === 'LR') assert.ok(a.x < b.x && a.y === b.y)
    if (direction === 'RL') assert.ok(a.x > b.x && a.y === b.y)
    if (direction === 'TB') assert.ok(a.y < b.y && a.x === b.x)
    if (direction === 'BT') assert.ok(a.y > b.y && a.x === b.x)
    assert.equal(a.shape, 'rectangle'); assert.equal(a.text, '甲')
  }
  const anonymous = compile('block\nblock\na[A] b[B]\nend')
  assert.ok(anonymous.scene.elements.some(item => item.type === 'shape' && item.text === '分组 1'))
})

test('block parser rejects malformed groups, misplaced settings and excessive nested dimensions', () => {
  reject('block\nblock:a[组]\nx[X]', 2)
  reject('block\nend', 2)
  reject('block\nblock:a\nend', 3)
  reject('block\nblock:a\nspace\nend', 4)
  reject('block\na[A]\ndirection RL', 3)
  reject('block\ndirection DOWN\na[A]', 2)
  reject('block\nblock:a\nx[X]\nend\na[Y]', 5)
  reject('block\ncolumns 2\nblock:a:3\nx[X]\nend', 3)
  reject('block\n' + Array.from({ length: 11 }, (_, i) => `block:g${i}`).join('\n') + '\na[A]\n' + 'end\n'.repeat(11), 12)
  reject('block\n' + Array.from({ length: 6 }, (_, i) => `columns 12\nblock:g${i}`).join('\n') + '\na[A]\n' + 'end\n'.repeat(6))
})

test('native shapes and subroutine side strokes render without fallback warnings', () => {
  for (const source of ['block\ncolumns 3\na[[子过程]] b[/输入输出/] c)云端(', 'mindmap\nroot[主题]\n  a[[子过程]]\n  b[/输入输出/]\n  c)云端(']) {
    const result = compile(source)
    assert.deepEqual(result.warnings, [])
    const sub = result.scene.elements.find(item => item.type === 'shape' && item.text === '子过程')
    const sides = result.scene.elements.filter(item => item.type === 'stroke' && item.id.startsWith(`${sub.id}:side:`))
    assert.equal(sides.length, 2)
    assert.ok(sub.groupId && sides.every(item => item.groupId === sub.groupId), 'Editable copies move the label and double side borders together')
    assert.ok(sides.every(item => item.points[0].x === item.points[1].x && item.points[0].y === sub.y && item.points[1].y === sub.y + sub.height))
    assert.equal(result.scene.elements.find(item => item.text === '输入输出').shape, 'parallelogram')
    assert.equal(result.scene.elements.find(item => item.text === '云端').shape, 'cloud')
    assert.ok(sceneToSvg(result.scene).includes('子过程'))
  }
})

test('mindmap and block styles resolve forward references and expose only their affected nodes', () => {
  for (const [header, body, firstId, secondId] of [
    ['block', 'a[A]:::focus b[B]', 'block-a', 'block-b'],
    ['mindmap', 'root[根]\n  a[A]:::focus\n  b[B]', 'mindmap-1', 'mindmap-2'],
  ]) {
    const source = `${header}\n${body}\nclassDef focus fill:#fff7dc,stroke:#a16207,stroke-width:3\nclass b focus\nstyle a fill:#ecfeff,opacity:0.8,stroke-dasharray:dotted`
    const result = compile(source), a = element(result, firstId), b = element(result, secondId)
    assert.equal(a.style.fill, '#ecfeff'); assert.equal(a.style.stroke, '#a16207'); assert.equal(a.style.strokeWidth, 3)
    assert.equal(a.style.opacity, .8); assert.equal(a.style.strokePattern, 'dotted')
    assert.equal(b.style.fill, '#fff7dc'); assert.equal(b.style.strokeWidth, 3)
    assert.deepEqual(new Set(locate(result, source, 'classDef focus')), new Set([a.id, b.id]))
    assert.deepEqual(locate(result, source, 'class b'), [b.id]); assert.deepEqual(locate(result, source, 'style a'), [a.id])
    assert.ok(!sceneToSvg(result.scene).includes('classDef'))
  }
})

test('planning styles reject scripts, resource URLs, unknown names and unsupported properties', () => {
  for (const rule of ['style a fill:url(https://invalid.test/a)', 'style a filter:blur(2px)', 'style a onclick:run()', 'style a stroke-width:-2', 'style a stroke-width:13', 'style a opacity:2', 'style a fill:red,fill:blue', 'style a stroke-dasharray:5 2', 'style missing fill:red', 'class a missing']) reject(`block\na[A]\n${rule}`, 3)
  reject('block\na[A]:::missing', 2)
  reject('mindmap\nroot[根]\n  a[A]:::missing', 3)
  reject('block\na[A]\nclassDef same fill:red\nclassDef same fill:blue', 4)
})

test('mindmap icon decorators generate visible editable vectors with exact source ownership', () => {
  const names = ['check', 'star', 'circle', 'square', 'diamond', 'cloud']
  const source = 'mindmap\nroot[主题]\n' + names.map((name, index) => `  n${index}[事项${index}]\n    ::icon(${name})`).join('\n')
  const result = compile(source)
  names.forEach((name, index) => {
    const icon = element(result, `mindmap-${index + 1}-icon`)
    assert.equal(icon.type, 'shape'); assert.equal(icon.text, '')
    assert.equal(icon.groupId, element(result, `mindmap-${index + 1}`).groupId)
    assert.ok(locate(result, source, `::icon(${name})`).includes(icon.id))
    assert.ok(locate(result, source, `n${index}[`).includes(`mindmap-${index + 1}`))
  })
  assert.equal(element(result, 'mindmap-1-icon-mark').type, 'stroke')
  reject('mindmap\n::icon(check)\nroot', 2)
  reject('mindmap\nroot\n::icon(check)\n::icon(star)', 4)
  reject('mindmap\nroot\n::icon(external-icon)', 3)
})

test('kanban limits, deadlines, tags and progress become visible content and accurate bars', () => {
  const source = `kanban
  work[进行中]@{ limit: 1 }
    a[甲]@{ assigned:'小林',ticket:'WORK-1',priority:'Medium',due:'2028-02-29',tags:'界面,质量',progress:25 }
    b[乙]@{ progress:0 }
  done[完成]
    c[丙]@{ progress:100 }`
  const result = compile(source), title = element(result, 'kanban-title-0'), card = element(result, 'kanban-card-0-0')
  assert.match(title.text, /2\/1/); assert.match(title.text, /超出/); assert.equal(title.style.stroke, '#be123c')
  for (const value of ['2028-02-29', '界面,质量', '25%', 'Medium', 'WORK-1', '小林']) assert.ok(card.text.includes(value))
  const track = element(result, 'kanban-card-0-0-progress-track'), value = element(result, 'kanban-card-0-0-progress-value')
  assert.equal(value.width / track.width, .25); assert.equal(value.x, track.x)
  assert.ok(track.y > card.y && track.y + track.height < card.y + card.height)
  assert.ok(!result.scene.elements.some(item => item.id === 'kanban-card-0-1-progress-value'))
  assert.equal(element(result, 'kanban-card-1-0-progress-value').width, element(result, 'kanban-card-1-0-progress-track').width)
  assert.deepEqual(locate(result, source, 'a[甲]'), ['kanban-card-0-0', 'kanban-card-0-0-progress-track', 'kanban-card-0-0-progress-value'])
})

test('kanban rejects impossible calendar dates, invalid progress and metadata in the wrong scope', () => {
  for (const meta of ["due:'2026-02-29'", "due:'2026-13-01'", "due:'tomorrow'", 'progress:-1', 'progress:101', 'progress:1.5', 'limit:2', "tags:'x',tags:'y'"]) reject(`kanban\n  todo[待办]\n    a[A]@{ ${meta} }`, 3)
  for (const meta of ['limit:0', 'limit:121', "assigned:'A'", 'progress:20']) reject(`kanban\n  todo[待办]@{ ${meta} }`, 2)
})

test('packet width changes split boundaries and high-bit-first mirrors fields as well as labels', () => {
  for (const bits of [8, 16, 64]) {
    const source = `packet\nbitsPerRow ${bits}\n0-${bits - 3}: "首字段"\n+6: "跨行字段"`
    const result = compile(source), parts = result.scene.elements.filter(item => item.text === '跨行字段')
    assert.equal(parts.length, 2); assert.equal(parts[0].width, 64); assert.equal(parts[1].width, 128)
    assert.equal(element(result, 'packet-row-0').width, bits * 32)
    assert.equal(locate(result, source, '+6:').length, 2)
    const reversed = compile(`packet\nbitsPerRow ${bits}\nbitOrder msb\n0-${bits - 3}: "首字段"\n+6: "跨行字段"`)
    for (const part of parts) {
      const mirrored = element(reversed, part.id), row = element(result, `packet-row-${part.id.split('-').at(-1)}`)
      assert.equal(mirrored.width, part.width)
      assert.equal(part.x + mirrored.x + part.width, row.x * 2 + row.width)
    }
    assert.equal(element(reversed, 'packet-bit-0-0').text, String(bits - 1))
    assert.equal(element(reversed, `packet-bit-0-${bits - 1}`).text, '0')
  }
})

test('packet hidden bit labels produce compact rows while startBit only changes display offsets', () => {
  const source = 'packet\nbitsPerRow 16\nshowBits false\nstartBit 128\n0-31: "内容"'
  const hidden = compile(source), shown = compile('packet\nbitsPerRow 16\n0-31: "内容"')
  assert.ok(!hidden.scene.elements.some(item => item.id.startsWith('packet-bit-')))
  assert.equal(element(hidden, 'packet-offset-0').text, '128'); assert.equal(element(hidden, 'packet-offset-1').text, '144')
  assert.equal(element(hidden, 'packet-field-0-0').width, element(shown, 'packet-field-0-0').width)
  assert.ok(element(hidden, 'packet-row-1').y - element(hidden, 'packet-row-0').y < element(shown, 'packet-row-1').y - element(shown, 'packet-row-0').y)
  assert.deepEqual(locate(hidden, source, 'showBits'), [])
  assert.deepEqual(locate(hidden, source, '0-31:'), ['packet-field-0-0', 'packet-field-0-1'])
  for (const setting of ['bitsPerRow 7', 'bitsPerRow 65', 'bitsPerRow 8.5', 'showBits yes', 'bitOrder reversed', 'startBit -1', 'startBit 65536']) reject(`packet\n${setting}\n0: "A"`, 2)
  reject('packet\nshowBits true\nshowBits false\n0:"A"', 3)
  reject('packet\n0:"A"\nbitsPerRow 8', 3)
})

test('timeline direction directives match header layout and reject ambiguous overrides', () => {
  const data = '\ntitle 时间记录\nsection 开始\n"09:00": 第一步 : 第二步\n : 后续说明\nsection 结束\n"10:00": 完成'
  const directive = compile('timeline\ndirection TD' + data), header = compile('timeline TD' + data)
  assert.deepEqual(directive.scene, header.scene)
  assert.ok(element(directive, 'timeline-period-1').y > element(directive, 'timeline-period-0').y)
  reject('timeline TD\ndirection LR\n一月: 事件', 2)
  reject('timeline\n一月: 事件\ndirection TD', 3)
  reject('timeline\ndirection DOWN\n一月: 事件', 2)
})

test('journey actor colors style name, lane and participation marks without changing scores', () => {
  const source = 'journey\nactorColor "顾问,专员": #0e7490\nactorColor 客户: #2563eb\nsection 初次接触\n"确认: 范围": 0: 客户,"顾问,专员"\nsection 交付\n完成: 5: 客户'
  const result = compile(source)
  for (const id of ['journey-actor-1', 'journey-lane-1', 'journey-member-0-1']) assert.equal(element(result, id).style.stroke, '#0e7490')
  assert.equal(element(result, 'journey-member-0-1').style.fill, '#0e7490')
  assert.deepEqual(new Set(locate(result, source, 'actorColor "顾问,专员"')), new Set(['journey-lane-1', 'journey-actor-1', 'journey-member-0-1']))
  assert.equal(element(result, 'journey-rating-0').text, '0/5'); assert.equal(element(result, 'journey-rating-1').text, '5/5')
  reject('journey\nactorColor 未参加: red\n任务:3:用户', 2)
  reject('journey\nactorColor 用户: red\nactorColor 用户:blue\n任务:3:用户', 3)
  reject('journey\nactorColor 用户:url(x)\n任务:3:用户', 2)
})

test('every planning kind offers two complex commented native templates with bounded export and locations', () => {
  const kinds = ['mindmap', 'timeline', 'journey', 'kanban', 'block', 'packet']
  assert.equal(PLANNING_TEMPLATES.length, kinds.length * 2)
  for (const kind of kinds) assert.equal(PLANNING_TEMPLATES.filter(item => item.kind === kind).length, 2)
  for (const template of PLANNING_TEMPLATES) {
    assert.ok(template.source.includes('%%'), `${template.id} explains its syntax`)
    const result = compile(template.source), bounds = sceneBounds(result.scene)
    assert.deepEqual(result.warnings, [], template.id)
    assert.ok(result.scene.elements.length >= 10, template.id)
    assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.width < 90000 && bounds.height < 90000)
    assert.deepEqual(compile(template.source), result)
    assert.deepEqual(validateScene(result.scene), result.scene)
    const ids = new Set(result.scene.elements.map(item => item.id)); assert.equal(ids.size, result.scene.elements.length)
    for (const range of result.sourceMap) {
      assert.ok(range.start >= 0 && range.end <= template.source.length && range.end > range.start)
      assert.ok(range.elementIds.length && range.elementIds.every(id => ids.has(id)))
    }
    const messages = [], document = new DOMParser({ onError: (level, message) => messages.push([level, message]) }).parseFromString(sceneToSvg(result.scene), 'image/svg+xml')
    assert.deepEqual(messages, []); assert.equal(document.documentElement.localName, 'svg')
    assert.equal(document.getElementsByTagName('script').length, 0)
    assert.ok(!sceneToSvg(result.scene).includes('sourceMap'))
  }
})


test('generated block decorations cannot collide with valid explicit node identifiers', () => {
  const source = 'block\ncolumns 2\nblock:g[组]\na[[步骤]]\nend\ng-title[标题同名] a-side-0[侧线同名] edge-0[连线同名]\na --> edge-0'
  const result = compile(source), ids = result.scene.elements.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(element(result, 'block-edge-0').type, 'shape')
  assert.equal(element(result, 'block-edge:0').type, 'edge')
  assert.deepEqual(locate(result, source, 'a --> edge-0'), ['block-edge:0'])
})

test('block template connector labels remain clear of opaque node bodies', () => {
  let checked = 0
  for (const template of PLANNING_TEMPLATES.filter(item => item.kind === 'block')) {
    const result = compile(template.source)
    const bodies = result.scene.elements.filter(node => node.type === 'shape' && node.text && node.shape !== 'text' && !['none', 'transparent'].includes(node.style.fill))
    for (const edge of result.scene.elements.filter(item => item.type === 'edge' && item.label)) {
      // Estimate the rendered text envelope independently of the grid spacing policy.
      const middle = pathMidpoint(edgePoints(edge, result.scene))
      const width = [...edge.label].reduce((sum, character) => sum + (/[\u0000-\u007f]/.test(character) ? .65 : 1.05) * edge.style.fontSize, 0) + 8
      const label = { x: middle.x - width / 2, y: middle.y - 9 - edge.style.fontSize, width, height: edge.style.fontSize * 1.4 }
      const overlapping = bodies.filter(node => label.x < node.x + node.width && label.x + label.width > node.x && label.y < node.y + node.height && label.y + label.height > node.y)
      assert.deepEqual(overlapping.map(node => node.id), [], `${template.id}: connector label ${edge.label} is obscured by a node`)
      checked++
    }
  }
  assert.ok(checked >= 3, 'The comprehensive templates retain their labeled connections')
})
