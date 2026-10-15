import test from 'node:test'
import assert from 'node:assert/strict'
import { compileStructureDiagram as compile, STRUCTURAL_TEMPLATES } from '../src/core/diagrams/structure.ts'
import { DiagramSyntaxError, lookupDiagramSource } from '../src/core/diagrams/common.ts'
import { edgePoints } from '../src/core/geometry.ts'
import { sceneToSvg } from '../src/core/svg.ts'

const nodes = result => result.scene.elements.filter(element => element.type === 'shape')
const edges = result => result.scene.elements.filter(element => element.type === 'edge')
const contains = (parent, child) => child.x >= parent.x && child.y >= parent.y + 28 && child.x + child.width <= parent.x + parent.width && child.y + child.height <= parent.y + parent.height
const invalid = (source, line, text) => assert.throws(() => compile(source), error => error instanceof DiagramSyntaxError && error.line === line && (!text || error.message.includes(text)))
const locate = (source, token, after = 0) => { const result = compile(source); return lookupDiagramSource(result.sourceMap, source.indexOf(token, after)) }

test('old structural template identities stay ordered and each family has complementary documented examples', () => {
  assert.deepEqual(STRUCTURAL_TEMPLATES.slice(0, 7).map(template => template.id), ['class-order-domain', 'state-order-lifecycle', 'er-commerce', 'git-feature-release', 'requirement-account', 'c4-shop-context', 'architecture-services'])
  assert.equal(new Set(STRUCTURAL_TEMPLATES.map(template => template.id)).size, STRUCTURAL_TEMPLATES.length)
  for (const kind of ['class', 'state', 'er', 'gitgraph', 'requirement', 'c4', 'architecture']) {
    const templates = STRUCTURAL_TEMPLATES.filter(template => template.kind === kind)
    assert.ok(templates.length >= 2)
    for (const template of templates) {
      assert.match(template.source, /%%.*[\p{Script=Han}]/u)
      const result = compile(template.source)
      assert.ok(edges(result).length >= 7, template.id)
      assert.ok(result.scene.elements.length >= 15, template.id)
      const known = new Set(result.scene.elements.map(element => element.id))
      for (const range of result.sourceMap) { assert.ok(range.start >= 0 && range.end <= template.source.length); assert.ok(range.elementIds.every(id => known.has(id))) }
    }
  }
})

test('nested class namespaces contain full cards and notes have independent source ownership', () => {
  const source = `classDiagram
direction LR
namespace domain["业务域"] {
  class Customer { +String name }
  namespace aggregate["订单聚合"] {
    class Order { +String id; +submit() bool }
    class Item { +int quantity }
    Order *-- Item : owns
  }
  Customer --> Order : places
}
note for Order "订单说明"
note "总体说明"`
  const result = compile(source), frames = nodes(result).filter(node => node.shape === 'frame')
  const outer = frames.find(node => node.text === '业务域'), inner = frames.find(node => node.text === '订单聚合')
  assert.ok(contains(outer, inner))
  for (const title of ['Order', 'Item']) {
    const label = nodes(result).find(node => node.text === title), card = nodes(result).find(node => node.id === label.id.replace('-title', ''))
    assert.ok(contains(inner, card)); assert.ok(contains(outer, card))
  }
  assert.deepEqual(locate(source, 'namespace aggregate'), ['class-group-1'])
  assert.deepEqual(locate(source, '订单说明'), ['class-note-0', 'class-note-0-link'])
  assert.deepEqual(locate(source, '总体说明'), ['class-note-1'])
  assert.ok(locate(source, '+submit').every(id => id.startsWith('class-1')))
  assert.ok(locate(source, 'owns').every(id => id.startsWith('class-edge-0')))
})

test('class annotations and quoted note data remain inert, and invalid namespace syntax fails precisely', () => {
  const result = compile('classDiagram\nclass A\n<<interface>> A\nnote for A "<script>noop</script>"')
  assert.ok(nodes(result).some(node => node.text.includes('<<interface>>')))
  assert.ok(!sceneToSvg(result.scene).includes('<script>'))
  invalid('classDiagram\nnamespace n {\nclass A', 2, '右花括号')
  invalid('classDiagram\nclass A\nnote for missing "bad"', 3, '未定义')
  invalid('classDiagram\nnamespace n {\n}\nnamespace n {', 4, '重复')
  invalid('classDiagram\nclass A\nstyle A fill:red', 3, '不支持')
  invalid(`classDiagram\n${Array.from({ length: 9 }, (_, i) => `namespace n${i} {`).join('\n')}\nclass A`, 10, '8')
})

test('class endpoint markers are placed against the final scene including notes and all relationships', () => {
  const result = compile(STRUCTURAL_TEMPLATES.find(template => template.id === 'class-order-domain').source)
  for (const decoration of result.scene.elements.filter(element => element.type === 'stroke' && /-(inheritance|composition)$/.test(element.id))) {
    const edge = edges(result).find(edge => decoration.id.startsWith(`${edge.id}-`)), points = edgePoints(edge, result.scene)
    const first = decoration.points[0]
    assert.ok([points[0], points.at(-1)].some(point => Math.hypot(point.x - first.x, point.y - first.y) < 1e-7), decoration.id)
    assert.equal(edge.route, 'orthogonal')
  }
})

test('composite states retain independently scoped start/end nodes and repeated local state names', () => {
  const source = `stateDiagram-v2
direction LR
state First {
  direction TB
  [*] --> Idle
  Idle --> Done
  Done --> [*]
}
state Second {
  direction TB
  [*] --> Idle
  Idle --> Done
  Done --> [*]
}
[*] --> First
First --> Second
Second --> [*]`
  const result = compile(source), frames = nodes(result).filter(node => node.shape === 'frame'), idle = nodes(result).filter(node => node.text === 'Idle')
  assert.equal(frames.length, 2); assert.equal(idle.length, 2)
  assert.ok(contains(frames[0], idle[0])); assert.ok(contains(frames[1], idle[1]))
  assert.ok(frames[1].x > frames[0].x)
  const firstDone = nodes(result).filter(node => node.text === 'Done')[0]
  assert.ok(firstDone.y > idle[0].y)
  const starts = nodes(result).filter(node => node.shape === 'ellipse' && node.width === 30 && node.style.fill === '#334155')
  assert.equal(starts.length, 3)
  assert.equal(nodes(result).filter(node => node.id.endsWith('-inner')).length, 3)
  const firstIdleIds = locate(source, 'Idle'), secondIdleIds = locate(source, 'Idle', source.indexOf('state Second'))
  assert.ok(!firstIdleIds.some(id => secondIdleIds.includes(id)))
  assert.deepEqual(locate(source, 'state First'), ['state-0'])
})

test('nested composite directions and fork/join symbols create actual bounded geometry', () => {
  const template = STRUCTURAL_TEMPLATES.find(template => template.id === 'state-order-lifecycle')
  const result = compile(template.source), frames = nodes(result).filter(node => node.shape === 'frame')
  const fulfillment = frames.find(node => node.text === '履约处理中'), delivery = frames.find(node => node.text === '配送过程')
  assert.ok(contains(fulfillment, delivery))
  const shipping = nodes(result).find(node => node.text === '运输中'), received = nodes(result).find(node => node.text === '客户签收')
  assert.ok(contains(delivery, shipping) && contains(delivery, received)); assert.ok(received.y > shipping.y)
  for (const direction of ['LR', 'TB']) {
    const fork = compile(`stateDiagram-v2\ndirection ${direction}\nstate Fork <<fork>>\nstate Join <<join>>\nstate Choice <<choice>>\nFork --> A\nFork --> B\nA --> Join\nB --> Join\nJoin --> Choice`)
    const bars = nodes(fork).filter(node => node.shape === 'rectangle' && node.style.fill === '#334155')
    assert.equal(bars.length, 2)
    assert.ok(bars.every(node => direction === 'LR' ? node.height > node.width * 5 : node.width > node.height * 5))
    assert.equal(nodes(fork).filter(node => node.shape === 'diamond').length, 1)
  }
})

test('state multiline notes map each content line and reject unclosed or unsupported constructs', () => {
  const source = 'stateDiagram-v2\nstate A\nnote right of A\n第一行说明\n第二行说明\nend note\nA --> B'
  const result = compile(source)
  assert.ok(nodes(result).some(node => node.text === '第一行说明\n第二行说明'))
  assert.deepEqual(locate(source, '第一行'), ['state-note-0', 'state-note-0-link'])
  assert.deepEqual(locate(source, '第二行'), ['state-note-0', 'state-note-0-link'])
  assert.deepEqual(locate(source, 'A -->'), ['state-edge-0'])
  invalid('stateDiagram-v2\nstate A {\nA --> B', 2, '右花括号')
  invalid('stateDiagram-v2\nstate A\nnote right of A\nunfinished', 3, 'end note')
  invalid('stateDiagram-v2\nstate A\n--', 3, '并行区域')
  invalid('stateDiagram-v2\nstate A <<history>>', 2, '不支持')
  invalid(`stateDiagram-v2\n${Array.from({ length: 9 }, (_, i) => `state S${i} {`).join('\n')}`, 10, '8')
})

test('cherry-pick makes a distinct commit with one actual parent and a separate source relation', () => {
  const source = `gitGraph LR:
commit id: "base"
branch fix
commit id: "patch"
checkout main
commit id: "release"
cherry-pick id: "patch" tag: "hotfix"
cherry-pick id: "patch"`
  const result = compile(source), labels = nodes(result).filter(node => /^git-commit-\d+-label$/.test(node.id))
  assert.deepEqual(labels.map(node => node.text), ['base', 'patch', 'release', 'patch-pick', 'patch-pick-2'])
  const parent = edges(result).filter(edge => edge.id.startsWith('git-edge-3-'))
  assert.equal(parent.length, 1); assert.equal(parent[0].from.nodeId, 'git-commit-2')
  const association = edges(result).find(edge => edge.id === 'git-pick-3')
  assert.equal(association.from.nodeId, 'git-commit-1'); assert.equal(association.to.nodeId, 'git-commit-3'); assert.equal(association.style.dashed, true)
  const mapped = locate(source, 'cherry-pick')
  assert.ok(mapped.includes('git-commit-3') && mapped.includes('git-pick-3') && mapped.includes('git-edge-3-0'))
  assert.ok(!mapped.includes('git-commit-1'))
})

test('cherry-pick validates merge parent selection and never silently accepts unknown options', () => {
  const base = 'gitGraph\ncommit id: "base"\nbranch dev\ncommit id: "dev1"\ncheckout main\ncommit id: "main1"\nmerge dev id: "merged"\ncheckout dev'
  invalid(`${base}\ncherry-pick id: "merged"`, 9, 'parent')
  invalid(`${base}\ncherry-pick id: "merged" parent: "missing"`, 9, '实际父提交')
  invalid(`${base}\ncherry-pick id: "missing"`, 9, '已有提交')
  invalid(`${base}\ncherry-pick id: "merged" unknown: 1`, 9, '选项')
  const result = compile(`${base}\ncherry-pick id: "merged" parent: "main1"`)
  assert.ok(edges(result).some(edge => edge.label === '摘取 · 基于 main1'))
  invalid('gitGraph\ncommit id: "base"\ncherry-pick id: "base"', 3, '其他分支')
})

test('C4 levels preserve container/component technologies, nested membership and relationships', () => {
  for (const header of ['C4Context', 'C4Container', 'C4Component']) {
    const source = `${header}\nContainer_Boundary(api, "接口边界") {\nContainer(app, "应用", "HTTP", "处理请求")\nBoundary(inner, "内部") {\nComponentDb(repo, "数据访问", "SQL", "保存数据")\nComponentQueue(events, "事件组件", "事件协议", "异步通知")\n}\n}\nComponent_Ext(remote, "外部适配器", "HTTPS", "外部交互")\nRel(app, repo, "读写")\nBiRel(events, remote, "回调")`
    const result = compile(source)
    assert.equal(result.kind, 'c4')
    const app = nodes(result).find(node => node.text.startsWith('应用\n')), repo = nodes(result).find(node => node.text.startsWith('数据访问\n'))
    assert.ok(app.text.includes('技术：HTTP')); assert.ok(repo.text.includes('技术：SQL')); assert.equal(repo.shape, 'cylinder')
    assert.ok(contains(nodes(result).find(node => node.text === '内部'), repo))
    assert.equal(edges(result)[1].arrow, 'both')
    assert.deepEqual(locate(source, 'ComponentDb'), [repo.id])
  }
  invalid('C4Container\nContainer(a, "A")', 2, '技术')
  invalid('C4Component\nComponent(a, "A", "HTTP")\nUpdateElementStyle(a)', 3, '不支持')
})

test('architecture junctions and group ports retain exact geometry and source identities', () => {
  const source = `architecture-beta
group a(cloud)[应用域]
group b(database)[数据域]
service app(server)[业务接口] in a
junction split in a
service db(database)[数据存储] in b
app:R --> L:split : 分流
split{group}:B --> T:db{group} : 跨域
a:R <--> L:b : 控制面
app:L <-- R:db : 回执`
  const result = compile(source), groupA = nodes(result).find(node => node.text === '应用域'), groupB = nodes(result).find(node => node.text === '数据域')
  const junction = nodes(result).find(node => node.shape === 'ellipse' && node.width === 14)
  assert.ok(junction && contains(groupA, junction))
  assert.deepEqual(edges(result)[1].from, { x: groupA.x + groupA.width / 2, y: groupA.y + groupA.height })
  assert.deepEqual(edges(result)[1].to, { x: groupB.x + groupB.width / 2, y: groupB.y })
  assert.equal(edges(result)[1].label, '跨域'); assert.equal(edges(result)[2].arrow, 'both')
  assert.deepEqual(locate(source, 'junction split'), [junction.id])
  assert.deepEqual(locate(source, '跨域'), ['architecture-edge-1'])
  assert.ok(edges(result).every(edge => edgePoints(edge, result.scene).every(point => Number.isFinite(point.x) && Number.isFinite(point.y))))
})

test('architecture validates missing memberships, duplicate junctions and invalid boundary ports', () => {
  invalid('architecture-beta\nservice a(server)[A]\nservice b(server)[B]\na{group}:R --> L:b', 4, '分组')
  invalid('architecture-beta\njunction p in missing', 2, '未定义')
  invalid('architecture-beta\njunction p\njunction p', 3, '重复')
  invalid('architecture-beta\njunction p\np:X --> L:p', 3, '不支持')
  invalid('architecture-beta\ngroup g(cloud)[G]\nservice a(server)[A] in g\ng{group}:R --> L:a', 4, '分组')
})

test('requirement direction affects geometry and comprehensive examples cover every node and relationship category', () => {
  for (const direction of ['LR', 'RL', 'TB', 'BT']) {
    const result = compile(`requirementDiagram\ndirection ${direction}\nrequirement a {\ntext: A\n}\nfunctionalRequirement b {\ntext: B\n}\na - contains -> b`)
    const a = nodes(result).find(node => node.id === 'requirement-0'), b = nodes(result).find(node => node.id === 'requirement-1')
    assert.ok(direction === 'LR' ? a.x < b.x : direction === 'RL' ? a.x > b.x : direction === 'TB' ? a.y < b.y : a.y > b.y)
  }
  const combined = STRUCTURAL_TEMPLATES.filter(template => template.kind === 'requirement').map(template => template.source).join('\n')
  for (const type of ['requirement', 'functionalRequirement', 'interfaceRequirement', 'performanceRequirement', 'physicalRequirement', 'designConstraint', 'element']) assert.ok(combined.includes(`${type} `))
  for (const relation of ['contains', 'copies', 'derives', 'satisfies', 'verifies', 'refines', 'traces']) assert.ok(combined.includes(` ${relation} `))
  for (const method of ['analysis', 'inspection', 'test', 'demonstration']) assert.ok(combined.includes(`verifymethod: ${method}`))
})
