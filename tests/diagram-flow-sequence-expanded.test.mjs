import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCodeDiagram, lookupDiagramSource, DiagramSyntaxError } from '../src/core/code-diagram.ts'
import { BASIC_TEMPLATES } from '../src/core/diagrams/basic-templates.ts'
import { validateScene, createDocument, serializeDocument, parseDocument } from '../src/core/documents.ts'
import { sceneToSvg } from '../src/core/svg.ts'

const shape = (result, id) => result.scene.elements.find(element => element.type === 'shape' && element.id === id)
const edges = result => result.scene.elements.filter(element => element.type === 'edge')
const at = (result, source, token) => lookupDiagramSource(result.sourceMap, source.indexOf(token))
const contains = (outer, inner, padding = 0) => inner.x >= outer.x + padding && inner.y >= outer.y + padding && inner.x + inner.width <= outer.x + outer.width - padding && inner.y + inner.height <= outer.y + outer.height - padding
const invalid = (source, line, message) => assert.throws(() => compileCodeDiagram(source), error => error instanceof DiagramSyntaxError && error.line === line && (!message || error.message.includes(message)), source)

test('four complementary comprehensive templates compile deterministically, map semantic tokens and round trip', () => {
  assert.equal(BASIC_TEMPLATES.filter(template => template.kind === 'flowchart').length, 2)
  assert.equal(BASIC_TEMPLATES.filter(template => template.kind === 'sequence').length, 2)
  for (const template of BASIC_TEMPLATES) {
    const result = compileCodeDiagram(template.source)
    assert.deepEqual(result, compileCodeDiagram(template.source))
    assert.ok(result.scene.elements.length > 20)
    assert.doesNotThrow(() => validateScene(result.scene))
    assert.ok(result.sourceMap.length > 10)
    const ids = new Set(result.scene.elements.map(element => element.id))
    for (const range of result.sourceMap) assert.ok(range.start < range.end && range.elementIds.every(id => ids.has(id)))
    const doc = createDocument('mermaid'); doc.source = template.source; doc.scene = result.scene
    const restored = parseDocument(serializeDocument(doc))
    assert.deepEqual(restored.scene, validateScene(result.scene))
    assert.equal(restored.source, template.source)
    const svg = sceneToSvg(result.scene)
    assert.ok(svg.includes('<svg') && !svg.includes('NaN') && !svg.includes('undefined'))
  }
})

test('nested flow subgraphs enclose children, respect local directions and connect through real frame nodes', () => {
  const source = `flowchart LR
subgraph outer[外层]
direction TB
subgraph inner[内层]
direction LR
A[准备] --> B[执行]
end
B --> C[验收]
end
outer --> D[发布]`
  const result = compileCodeDiagram(source), outer = shape(result, 'm-node-outer'), inner = shape(result, 'm-node-inner')
  const a = shape(result, 'm-node-A'), b = shape(result, 'm-node-B'), c = shape(result, 'm-node-C'), d = shape(result, 'm-node-D')
  assert.equal(outer.shape, 'frame')
  assert.ok(contains(outer, inner, 25) && contains(inner, a, 25) && contains(inner, b, 25) && contains(outer, c, 25))
  assert.ok(a.x < b.x && c.y > inner.y + inner.height && d.x > outer.x + outer.width)
  assert.ok(edges(result).some(edge => edge.from.nodeId === outer.id && edge.to.nodeId === d.id))
  assert.deepEqual(at(result, source, 'subgraph inner'), [inner.id])
  assert.deepEqual(at(result, source, 'direction LR'), [])
  assert.ok(result.scene.elements.some(element => element.id === 'm-group-background-inner' && element.type === 'stroke' && element.closed && element.style.fill === '#f8fafc'))
})

test('flow branch products and chains produce all edges and retain independent token locations', () => {
  const source = '\uFEFFflowchart LR\r\nA[同名] & B[同名] -->|并行| C[同名] & D[同名] --> E[合并]; E --> A'
  const result = compileCodeDiagram(source)
  assert.equal(edges(result).length, 7)
  assert.deepEqual(at(result, source, 'A[同名]'), ['m-node-A'])
  assert.deepEqual(at(result, source, 'B[同名]'), ['m-node-B'])
  assert.deepEqual(at(result, source, '并行'), ['m-edge-0', 'm-edge-1', 'm-edge-2', 'm-edge-3'])
  assert.ok(edges(result).slice(0, 4).every(edge => edge.label === '并行'))
  assert.deepEqual(at(result, source, '& B'), [])
})

test('flow native shape declarations and attribute labels retain safe text and real geometry kinds', () => {
  const source = `flowchart TB
A[(存储)] --> B{{判断}} --> C[/输入/]
D@{ shape: cloud, label: "同名; \\"引号\\"" }
E@{ shape: triangle, label: "警告" }
F@{ shape: star, label: "重点" }
G@{ shape: note, label: "<script>纯文本</script>" }
H@{ shape: text, label: "说明\\n第二行" }`
  const result = compileCodeDiagram(source)
  for (const [id, kind] of Object.entries({ A: 'cylinder', B: 'hexagon', C: 'parallelogram', D: 'cloud', E: 'triangle', F: 'star', G: 'note', H: 'text' })) assert.equal(shape(result, `m-node-${id}`).shape, kind)
  assert.equal(shape(result, 'm-node-H').text, '说明\n第二行')
  assert.equal(shape(result, 'm-node-D').text, '同名; "引号"')
  assert.ok(!sceneToSvg(result.scene).includes('<script>'))
  invalid('flowchart LR\nA@{shape: image, label: "不能加载"}', 2, '形状')
  invalid('flowchart LR\nA@{shape: toString}', 2, '形状')
  invalid('flowchart LR\nA@{shape: rect, href: "x"}', 2, '属性')
})

test('flow classes, default class, inline class and direct edge styles obey safe bounded properties', () => {
  const source = `flowchart LR
A[甲]:::emphasis --> B[乙]
classDef default fill:#eff6ff,font-size:18
classDef emphasis stroke:#c2410c,stroke-width:3
class B emphasis
style A fill:rgb(230,240,250),opacity:0.5,text-align:left
linkStyle default stroke:#15803d,stroke-dasharray:2 3
linkStyle 0 stroke-width:4`
  const result = compileCodeDiagram(source), a = shape(result, 'm-node-A'), b = shape(result, 'm-node-B')
  assert.equal(a.style.fill, 'rgb(230,240,250)')
  assert.equal(a.style.stroke, '#c2410c')
  assert.equal(b.style.fill, '#eff6ff')
  assert.equal(b.style.strokeWidth, 3)
  assert.equal(a.style.fontSize, 18)
  assert.equal(a.style.opacity, .5)
  assert.equal(edges(result)[0].style.strokePattern, 'dotted')
  assert.equal(edges(result)[0].style.strokeWidth, 4)
  assert.deepEqual(at(result, source, ':::emphasis'), ['m-node-A'])
  for (const bad of ['fill:url(https://example.test/x)', 'stroke:expression(alert(1))', 'opacity:2', 'font-size:1000', 'unknown:yes', 'stroke-dasharray:0 5', 'fill:#12345']) invalid(`flowchart LR\nA\nstyle A ${bad}`, 3)
  invalid('flowchart LR\nA:::missing', 2, '样式类')
  invalid('flowchart LR\nA\nstyle B fill:red', 3, '未定义')
  invalid('flowchart LR\nA\nlinkStyle 8 stroke:red', 3, '编号')
  invalid('flowchart LR\nsubgraph group\nA\nend\nstyle group font-size:72', 5, '32')
})

test('reverse edges, circle and cross endpoints and invisible layout links render intentionally', () => {
  const result = compileCodeDiagram('flowchart LR\nA <-- B\nA --o C\nB x--x C\nA ~~~ D')
  assert.equal(edges(result)[0].from.nodeId, 'm-node-B')
  assert.equal(edges(result)[0].to.nodeId, 'm-node-A')
  assert.equal(shape(result, 'm-edge-1-end-marker').shape, 'ellipse')
  assert.equal(result.scene.elements.filter(element => element.id.startsWith('m-edge-2-') && element.type === 'stroke').length, 4)
  assert.equal(edges(result)[3].style.opacity, 0)
  assert.ok(result.warnings.some(warning => warning.includes('静态')))
})

test('flow nesting, empty groups, node collisions and expansion limits produce exact diagnostics', () => {
  invalid('flowchart LR\nsubgraph outer\nA', 2, 'end')
  invalid('flowchart LR\nend\nA', 2, 'end')
  invalid('flowchart LR\nsubgraph outer\nend\nA', 2, '至少')
  invalid('flowchart LR\nA[节点]\nsubgraph A\nB\nend', 3, '重复')
  invalid(`flowchart LR\n${Array.from({ length: 9 }, (_, index) => `subgraph g${index}`).join('\n')}\nA\n${'end\n'.repeat(9)}`, 10, '8 层')
  const from = Array.from({ length: 30 }, (_, index) => `A${index}`).join(' & '), to = Array.from({ length: 30 }, (_, index) => `B${index}`).join(' & ')
  invalid(`flowchart LR\n${from} --> ${to}`, 2, '800')
})

test('sequence nested fragments contain messages and branch separators with individual source locations', () => {
  const source = `sequenceDiagram
participant A
participant B
loop 重试
alt 成功
A->>B: 内容
else 失败
opt 记录
B-->>A: 错误
end
end
end`
  const result = compileCodeDiagram(source), outer = shape(result, 'm-seq-fragment-0'), inner = shape(result, 'm-seq-fragment-1'), optional = shape(result, 'm-seq-fragment-2')
  assert.ok(contains(outer, inner) && contains(inner, optional))
  const message = result.scene.elements.find(element => element.type === 'shape' && element.text === '内容')
  assert.ok(contains(inner, message))
  assert.ok(at(result, source, 'else 失败').some(id => id.startsWith('m-seq-branch')))
  assert.deepEqual(at(result, source, 'loop 重试'), ['m-seq-fragment-0', 'm-seq-fragment-0-title'])
  assert.ok(at(result, source, 'A->>B: 内容').every(id => !id.includes('fragment')))
})

test('sequence activation shorthands and explicit nested activation draw true bounded lifetimes', () => {
  const source = `sequenceDiagram
A->>+B: 开始
activate B #bfdbfe
B->>B: 嵌套调用
deactivate B
B-->>-A: 完成`
  const result = compileCodeDiagram(source), activations = result.scene.elements.filter(element => element.id.startsWith('m-seq-activation-'))
  assert.equal(activations.length, 2)
  assert.ok(activations[0].height > activations[1].height && activations[1].y > activations[0].y)
  assert.ok(activations[1].x > activations[0].x)
  assert.equal(activations[1].style.fill, '#bfdbfe')
  assert.ok(at(result, source, 'B-->>-A').includes(activations[0].id))
  assert.deepEqual(at(result, source, 'deactivate B'), [activations[1].id])
  assert.doesNotThrow(() => validateScene(result.scene))
})

test('sequence parallel and critical alternatives, cancellation and automatic numbering resume preserve meaning', () => {
  const source = `sequenceDiagram
title 并行任务
autonumber 2 3
par 校验
A->>B: 第一项
and 查询
A-)C: 第二项
end
autonumber off
B-xA: 取消
critical 更新
A->>C: 未编号
option 冲突
C-->>A: 冲突结果
end
autonumber resume
break 终止
A<<-->>B: 最后一项
end`
  const result = compileCodeDiagram(source), texts = result.scene.elements.filter(element => element.type === 'shape').map(element => element.text)
  assert.ok(texts.includes('2. 第一项') && texts.includes('5. 第二项') && texts.includes('8. 最后一项'))
  assert.ok(texts.includes('取消') && texts.includes('未编号'))
  assert.equal(result.scene.elements.filter(element => element.id.startsWith('m-seq-cross-')).length, 2)
  assert.ok(edges(result).some(edge => edge.arrow === 'both'))
  assert.equal(shape(result, 'm-seq-title').text, '并行任务')
  assert.deepEqual(at(result, source, 'autonumber off'), [])
})

test('sequence rejects unmatched activation, misplaced alternatives, unsafe backgrounds and deep fragment trees', () => {
  invalid('sequenceDiagram\nactivate A\nA->>B: 工作', 2, '未结束')
  invalid('sequenceDiagram\nA->>B: 工作\ndeactivate A', 3, '没有')
  invalid('sequenceDiagram\nA->>B: 工作\nA-->>-B: 完成', 3, '没有')
  invalid('sequenceDiagram\nelse 不在片段内', 2, '必须')
  invalid('sequenceDiagram\nloop 循环\nand 错误分支\nend', 3, '必须')
  invalid('sequenceDiagram\nrect url(https://example.test/x)\nA->>B: 工作\nend', 2, '颜色')
  invalid('sequenceDiagram\nautonumber resume\nA->>B: 工作', 2, '暂停')
  invalid('sequenceDiagram\nopt 可选\nA->>B: 工作', 2, 'end')
  invalid(`sequenceDiagram\n${'loop 嵌套\n'.repeat(9)}A->>B: 工作\n${'end\n'.repeat(9)}`, 10, '8 层')
  invalid('sequenceDiagram\ncreate participant A', 2, '暂不支持')
})
