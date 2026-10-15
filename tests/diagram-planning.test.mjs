import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { compilePlanningDiagram, PLANNING_TEMPLATES } from '../src/core/diagrams/planning.ts'
import { DiagramSyntaxError } from '../src/core/diagrams/common.ts'
import { sceneToSvg } from '../src/core/svg.ts'

const shapes = result => result.scene.elements.filter(element => element.type === 'shape')
const edges = result => result.scene.elements.filter(element => element.type === 'edge')
const byText = (result, text) => shapes(result).find(element => element.text === text)
const visibleText = result => shapes(result).map(element => element.text).join('\n')
const compile = source => {
  const result = compilePlanningDiagram(source)
  assert.ok(result, `planning compiler must recognize ${source.split('\n')[0]}`)
  return result
}
const syntaxError = (source, line) => assert.throws(() => compilePlanningDiagram(source), error => {
  assert.ok(error instanceof DiagramSyntaxError, error?.stack)
  assert.ok(error.line > 0)
  if (line !== undefined) assert.equal(error.line, line)
  return true
}, source)

test('planning dispatcher leaves unrelated diagram kinds to the other compilers', () => {
  assert.equal(compilePlanningDiagram('flowchart LR\nA --> B'), undefined)
  assert.equal(compilePlanningDiagram('sequenceDiagram\nA->>B: hello'), undefined)
})

test('mindmap renders a real bound tree with Chinese labels and multiline content', () => {
  const result = compile(`mindmap
  root((产品规划))
    discovery[需求调研]
      用户访谈
    delivery(迭代交付)
      detail[第一行<br/>第二行\\n第三行]`)
  assert.equal(result.kind, 'mindmap')
  assert.equal(byText(result, '产品规划').shape, 'ellipse')
  for (const text of ['需求调研', '用户访谈', '迭代交付', '第一行\n第二行\n第三行']) assert.ok(byText(result, text), text)
  assert.equal(edges(result).length, 4)
  const ids = new Set(shapes(result).map(node => node.id))
  for (const edge of edges(result)) {
    assert.ok(ids.has(edge.from.nodeId))
    assert.ok(ids.has(edge.to.nodeId))
  }
  assert.notEqual(byText(result, '需求调研').x, byText(result, '用户访谈').x)
  assert.notEqual(byText(result, '产品规划').x, byText(result, '迭代交付').x)
})

test('mindmap rejects duplicate identifiers, ambiguous indentation and unsupported decorators', () => {
  syntaxError('mindmap\nroot[根]\n  same[甲]\n  same[乙]', 4)
  syntaxError('mindmap\nroot\n\tchild', 3)
  syntaxError('mindmap\nroot\n  child\n next', 4)
  syntaxError('mindmap\nroot\nsecond root', 3)
  syntaxError('mindmap\nroot\n  ::icon(fa fa-book)', 3)
  syntaxError('mindmap\nroot\n  child:::red', 3)
  syntaxError('mindmap\nroot((根)', 2)
  syntaxError('mindmap\nroot[[根]', 2)
  syntaxError('mindmap\nroot[甲] other[乙]', 2)
})

test('timeline retains sections, multiple events and continuation events in source order', () => {
  const result = compile(`timeline
title 发布计划
section 第一季度
一月 : 调研 : 设计
     : 审查
二月 : 实现<br>验收
section 第二季度
四月 : 正式发布`)
  assert.equal(result.kind, 'timeline')
  for (const text of ['发布计划', '第一季度', '第二季度', '一月', '二月', '四月', '调研', '设计', '审查', '实现\n验收', '正式发布']) assert.ok(visibleText(result).includes(text), text)
  assert.ok(byText(result, '一月').x < byText(result, '二月').x)
  assert.ok(byText(result, '二月').x < byText(result, '四月').x)
})

test('timeline TD changes the time axis to vertical ordering', () => {
  const result = compile('timeline TD\n2024 : 开始\n2025 : 发展\n2026 : 发布')
  assert.ok(byText(result, '2024').y < byText(result, '2025').y)
  assert.ok(byText(result, '2025').y < byText(result, '2026').y)
  syntaxError('timeline\n: 没有对应的时期', 2)
  syntaxError('timeline\n2024 开始', 2)
  syntaxError('timeline\n2024 :', 2)
  syntaxError('timeline RL\n2024 : 开始', 1)
})

test('journey exposes all six score levels, sections, tasks and actor lanes', () => {
  const result = compile(`journey
title 用户旅程
section 了解
找到产品: 0: 用户, 客服
注册试用: 3: 用户
section 使用
完成目标: 5: 用户, 顾问`)
  assert.equal(result.kind, 'journey')
  for (const text of ['用户旅程', '了解', '使用', '找到产品', '注册试用', '完成目标', '用户', '客服', '顾问']) assert.ok(visibleText(result).includes(text), text)
  assert.ok(byText(result, '找到产品').x < byText(result, '注册试用').x)
  assert.ok(byText(result, '注册试用').x < byText(result, '完成目标').x)
  const actorRows = ['用户', '客服', '顾问'].map(actor => byText(result, actor))
  assert.ok(actorRows.every(Boolean))
  assert.equal(new Set(actorRows.map(actor => actor.y)).size, 3)
})

test('journey rejects out-of-range scores, missing actors and unknown statements', () => {
  for (const line of ['任务: -1: 用户', '任务: 6: 用户', '任务: 1.5: 用户', '任务: five: 用户', '任务: 3:', '任务: 3: 用户,,客服', 'click A "https://example.com"']) syntaxError(`journey\n${line}`, 2)
})

test('kanban columns, cards and bounded metadata become visible editable content', () => {
  const result = compile(`kanban
  todo[待办]
    research[研究需求]@{ ticket: MC-2038, assigned: '张三', priority: 'Very High' }
    [整理文档]
  [进行中]
    build[实现编辑器]@{ assigned: "李四", priority: 'Low' }
  已完成
    发布初版`)
  assert.equal(result.kind, 'kanban')
  for (const text of ['待办', '进行中', '已完成', '研究需求', '整理文档', '实现编辑器', '发布初版', 'MC-2038', '张三', '李四', 'Very High', 'Low']) assert.ok(visibleText(result).includes(text), text)
  const containing = text => shapes(result).find(node => node.text.includes(text))
  assert.ok(containing('研究需求').x < containing('实现编辑器').x)
  assert.ok(containing('实现编辑器').x < containing('发布初版').x)
  assert.ok(containing('研究需求').y < containing('整理文档').y)
})

test('kanban rejects unknown, duplicate or invalid metadata and nested cards', () => {
  for (const metadata of ["url: 'https://example.com'", "assigned: 'A', assigned: 'B'", "priority: 'Urgent'", "priority: 'High', garbage"]) syntaxError(`kanban\n  todo[待办]\n    task[任务]@{ ${metadata} }`, 3)
  syntaxError('kanban\n  todo[待办]\n    task[任务]\n      nested[嵌套]', 4)
  syntaxError('kanban\n  todo[待办]\n    task[甲]\n    task[乙]', 4)
  syntaxError('kanban\n\ttodo[待办]', 2)
})

test('block diagrams allocate columns, spanning cells, spaces and connected nodes', () => {
  const result = compile(`block-beta
columns 4
start[开始]:2 next[继续] final[完成]
space:2 other[其他]:2
start --> next
next -->|交付| final`)
  assert.equal(result.kind, 'block')
  const start = byText(result, '开始'), next = byText(result, '继续'), final = byText(result, '完成'), other = byText(result, '其他')
  assert.ok(start.width > next.width)
  assert.ok(start.x < next.x && next.x < final.x)
  assert.equal(start.y, next.y)
  assert.ok(other.y > start.y)
  assert.ok(other.x > start.x)
  assert.equal(edges(result).length, 2)
  assert.ok(edges(result).some(edge => edge.label === '交付'))
  assert.equal(compile('block\ncolumns 2\na[A] b[B]\na --> b').kind, 'block')
})

test('block parser refuses unresolved references, duplicate ids, bad spans and malformed nesting', () => {
  syntaxError('block-beta\ncolumns 2\na[A]\na --> missing', 4)
  syntaxError('block-beta\na[A] a[B]', 2)
  syntaxError('block-beta\ncolumns 2\na[A]:3', 3)
  syntaxError('block-beta\ncolumns 13\na[A]', 2)
  syntaxError('block-beta\ncolumns 0\na[A]', 2)
  syntaxError('block-beta\nblock:group\na[A]', 2)
  syntaxError('block-beta\na[A]\nstyle a filter:url(x)', 3)
})

test('packet fields use true bit widths and split exactly at a 32-bit boundary', () => {
  const result = compile(`packet-beta
title 数据包
0-15: "来源端口"
16-23: "类型"
24-39: "跨行字段"
+8: "后续字段"`)
  assert.equal(result.kind, 'packet')
  assert.ok(byText(result, '数据包'))
  const source = byText(result, '来源端口'), type = byText(result, '类型')
  assert.equal(source.width, type.width * 2)
  assert.equal(source.y, type.y)
  assert.ok(source.x < type.x)
  const split = shapes(result).filter(node => node.text.includes('跨行字段'))
  assert.equal(split.length, 2)
  assert.equal(split[0].width, type.width)
  assert.equal(split[1].width, type.width)
  assert.ok(split[0].y !== split[1].y)
  const next = byText(result, '后续字段')
  assert.ok(next.y > source.y)
  assert.equal(next.width, type.width)
  assert.equal(compile('packet\n0: "标志"\n+31: "数据"').kind, 'packet')
})

test('packet ranges reject overlap, reversal, negative widths, overflow and unquoted labels', () => {
  syntaxError('packet-beta\n0-15: "A"\n8-23: "B"', 3)
  syntaxError('packet-beta\n15-0: "倒序"', 2)
  syntaxError('packet-beta\n32-40: "A"\n0-10: "B"', 3)
  syntaxError('packet-beta\n+0: "空"', 2)
  syntaxError('packet-beta\n0-1024: "过长"', 2)
  syntaxError('packet-beta\n0-31: 没有引号', 2)
})

test('planning errors preserve source line numbers across comments and CRLF', () => {
  syntaxError('%% 文档注释\r\nmindmap\r\n  root\r\n\r\n    child\r\n    ::icon(fa fa-book)', 6)
  syntaxError('%% 注释\r\npacket-beta\r\n  0-7: "有效"\r\n  4-8: "重叠"', 4)
})

test('initialization directives are rejected instead of being mistaken for comments', () => {
  for (const kind of ['mindmap', 'timeline', 'journey', 'kanban', 'block-beta', 'packet-beta']) {
    syntaxError(`${kind}\n%%{init: {}}%%\nignored`, 2)
  }
})

test('quoted node labels retain arrow-looking text and block auto layout reports its row cap', () => {
  const result = compile('block-beta\ncolumns 2\na["A --> B"] b["C -- D"]\na --> b')
  assert.ok(byText(result, 'A --> B'))
  assert.ok(byText(result, 'C -- D'))
  const auto = compile('block-beta\ncolumns auto\n' + Array.from({ length: 13 }, (_, i) => `n${i}`).join(' '))
  assert.ok(auto.warnings.some(message => message.includes('12')))
  assert.ok(visibleText(compile('kanban\n  todo[待办]\n    task[计划(讨论)]')).includes('计划(讨论)'))
  assert.ok(byText(compile("timeline\n2026: User's feedback"), "User's feedback"))
  assert.ok(byText(compile("block\na[User's feedback]"), "User's feedback"))
})

test('each planning kind supplies a reproducible rich template made of editable elements', () => {
  const kinds = ['mindmap', 'timeline', 'journey', 'kanban', 'block', 'packet']
  assert.equal(new Set(PLANNING_TEMPLATES.map(template => template.id)).size, PLANNING_TEMPLATES.length)
  for (const kind of kinds) {
    const template = PLANNING_TEMPLATES.find(item => item.kind === kind)
    assert.ok(template, `missing ${kind} template`)
    assert.ok(template.title && template.description && template.category)
    const result = compile(template.source)
    assert.equal(result.kind, kind)
    assert.ok(result.scene.elements.length >= 5, `${kind} template should contain meaningful data`)
    assert.deepEqual(compile(template.source), result)
    assert.equal(new Set(result.scene.elements.map(element => element.id)).size, result.scene.elements.length)
    assert.ok(result.scene.elements.every(element => ['shape', 'edge', 'stroke'].includes(element.type)))
  }
})

test('planning XML output keeps malicious-looking labels as inert escaped text', () => {
  const payload = '<script>alert(1)</script> & "value"'
  const result = compile(`mindmap\nroot[${payload}]\n  child[<img src=x onerror=alert(2)>]`)
  const svg = sceneToSvg(result.scene)
  const errors = []
  const doc = new DOMParser({ onError: (level, message) => errors.push([level, message]) }).parseFromString(svg, 'image/svg+xml')
  assert.deepEqual(errors, [])
  assert.equal(doc.getElementsByTagName('script').length, 0)
  assert.equal(doc.getElementsByTagName('img').length, 0)
  assert.equal(doc.getElementsByTagName('foreignObject').length, 0)
  assert.ok(svg.includes('&lt;script&gt;'))
  assert.ok(svg.includes('&amp;'))
  assert.ok(visibleText(result).includes(payload))
})

test('planning parsers enforce bounded document sizes and per-diagram capacity', () => {
  syntaxError('mindmap\n' + 'a'.repeat(200_000))
  syntaxError('mindmap\nroot\n' + Array.from({ length: 200 }, (_, i) => `  n${i}[节点${i}]`).join('\n'))
  syntaxError('mindmap\n' + Array.from({ length: 22 }, (_, i) => `${' '.repeat(i * 2)}n${i}[深度${i}]`).join('\n'))
  syntaxError('timeline\n' + Array.from({ length: 81 }, (_, i) => `${i} : 事件`).join('\n'))
  syntaxError('journey\n' + Array.from({ length: 81 }, (_, i) => `任务${i}: 3: 用户`).join('\n'))
  syntaxError('journey\n任务: 3: ' + Array.from({ length: 17 }, (_, i) => `成员${i}`).join(','))
  syntaxError('kanban\n' + Array.from({ length: 13 }, (_, i) => `  c${i}[列${i}]\n    n${i}[卡片]`).join('\n'))
  syntaxError('kanban\n  todo[待办]\n' + Array.from({ length: 121 }, (_, i) => `    n${i}[卡片${i}]`).join('\n'))
  syntaxError('block-beta\ncolumns 12\n' + Array.from({ length: 201 }, (_, i) => `n${i}[节点${i}]`).join(' '))
})
