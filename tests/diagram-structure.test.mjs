import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { compileStructureDiagram as compile, STRUCTURAL_TEMPLATES } from '../src/core/diagrams/structure.ts'
import { MermaidSyntaxError } from '../src/core/diagrams/common.ts'
import { sceneToSvg, elementToSvg } from '../src/core/svg.ts'
import { createDocument, serializeDocument, parseDocument, validateScene } from '../src/core/documents.ts'
import { edgePoints } from '../src/core/geometry.ts'
const shapes = result => result.scene.elements.filter(element => element.type === 'shape')
const edges = result => result.scene.elements.filter(element => element.type === 'edge')
const texts = result => shapes(result).map(node => node.text)
const invalid = (source, line, message) => assert.throws(() => compile(source), error => error instanceof MermaidSyntaxError && error.line === line && (!message || error.message.includes(message)))

test('all seven rich templates deterministically compile, export valid SVG and round trip through native documents', () => {
  assert.equal(STRUCTURAL_TEMPLATES.length, 7)
  for (const template of STRUCTURAL_TEMPLATES) {
    const result = compile(template.source)
    assert.equal(result.kind, template.kind)
    assert.deepEqual(compile(template.source), result)
    assert.doesNotThrow(() => validateScene(result.scene))
    const doc = createDocument('mermaid'); doc.source = template.source; doc.scene = result.scene
    const restored = parseDocument(serializeDocument(doc))
    assert.deepEqual(restored.scene, result.scene)
    assert.equal(restored.source, template.source)
    const xmlErrors = []
    const xml = new DOMParser({ onError: (level, message) => xmlErrors.push(`${level}: ${message}`) }).parseFromString(sceneToSvg(result.scene), 'image/svg+xml')
    assert.equal(xml.documentElement.nodeName, 'svg')
    assert.deepEqual(xmlErrors, [], template.id)
    assert.ok(edges(result).length > 0)
    for (const edge of edges(result)) for (const endpoint of [edge.from, edge.to]) if (endpoint.nodeId) assert.ok(shapes(result).some(node => node.id === endpoint.nodeId))
  }
})

test('class cards partition fields and methods and preserve editable card grouping', () => {
  const result = compile(`classDiagram
class Base {
  +String id
  +save() bool
}
class Child["具体实现"] {
  +String name
}
Base <|-- Child : 继承
Base "1" *-- "*" Part : 包含`)
  assert.ok(texts(result).includes('+String id'))
  assert.ok(texts(result).includes('+save() bool'))
  assert.ok(texts(result).includes('具体实现'))
  const base = shapes(result).find(node => node.id === 'class-0')
  assert.ok(result.scene.elements.filter(element => element.groupId === base.groupId).length >= 6)
  assert.equal(edges(result)[0].to.nodeId, base.id)
  assert.equal(edges(result)[0].arrow, 'none')
  assert.ok(result.scene.elements.some(element => element.id.endsWith('-inheritance') && element.closed))
  assert.ok(result.scene.elements.some(element => element.id.endsWith('-composition') && element.style.fill === '#334155'))
  assert.ok(texts(result).includes('1') && texts(result).includes('*'))
})

test('class forward references and four layout directions preserve direction semantics', () => {
  for (const direction of ['LR', 'RL', 'TB', 'BT']) {
    const result = compile(`classDiagram\ndirection ${direction}\nA --> B\nclass B["目标"]\nA : +run()`)
    const a = shapes(result).find(node => node.id === 'class-0'), b = shapes(result).find(node => node.id === 'class-1')
    assert.ok(texts(result).includes('目标'))
    if (direction === 'LR') assert.ok(a.x < b.x)
    if (direction === 'RL') assert.ok(a.x > b.x)
    if (direction === 'TB') assert.ok(a.y < b.y)
    if (direction === 'BT') assert.ok(a.y > b.y)
  }
})

test('states have real initial/final circles, choice diamonds and labelled retry transitions', () => {
  const result = compile(`stateDiagram-v2
direction LR
state "等待" as Idle
state Decision <<choice>>
[*] --> Idle
Idle --> Decision : 检查
Decision --> Idle : 重试
Decision --> [*] : 完成`)
  assert.ok(shapes(result).some(node => node.shape === 'ellipse' && node.style.fill === '#334155'))
  assert.ok(shapes(result).some(node => node.id.endsWith('-inner')))
  assert.ok(shapes(result).some(node => node.shape === 'diamond' && node.text === 'Decision'))
  assert.deepEqual(edges(result).map(edge => edge.label), ['', '检查', '重试', '完成'])
  assert.ok(edges(result).every(edge => edgePoints(edge, result.scene).length >= 2))
})

test('ER preserves type parameters, keys, comments and true zero-to-many markers', () => {
  const result = compile(`erDiagram
CUSTOMER {
  varchar(50) name "显示姓名"
  string id PK
}
ORDER {
  string id PK
  string customer_id FK, UK
}
CUSTOMER ||..o{ ORDER : "places orders"`)
  assert.ok(texts(result).some(text => text.includes('varchar(50)') && text.includes('显示姓名')))
  assert.ok(!result.scene.elements.some(element => element.id.endsWith('-methods')))
  assert.ok(texts(result).some(text => text.includes('[FK,UK]')))
  assert.equal(edges(result)[0].label, 'places orders')
  assert.equal(edges(result)[0].arrow, 'none')
  assert.equal(edges(result)[0].style.dashed, true)
  assert.equal(result.scene.elements.filter(element => element.id.includes('-fan-')).length, 3)
  assert.ok(shapes(result).some(node => node.id.endsWith('-optional') && node.shape === 'ellipse'))
})

test('gitGraph branch checks out the new branch and merge preserves two parents, tags and commit types', () => {
  const result = compile(`gitGraph LR:
commit id: "initial"
branch feature
commit id: "feature" type: HIGHLIGHT
checkout main
commit id: "main-fix"
merge feature id: "merge" tag: "v1"
commit id: "revert" type: REVERSE`)
  const dots = shapes(result).filter(node => /^git-commit-\d+$/.test(node.id))
  assert.equal(dots.length, 5)
  assert.ok(dots[1].y > dots[0].y)
  assert.equal(dots[2].y, dots[0].y)
  const parents = edges(result).filter(edge => edge.to.nodeId === dots[3].id)
  assert.deepEqual(new Set(parents.map(edge => edge.from.nodeId)), new Set([dots[1].id, dots[2].id]))
  assert.ok(texts(result).includes('v1'))
  assert.ok(shapes(result).some(node => node.id.endsWith('-highlight')))
  assert.equal(result.scene.elements.filter(element => element.id.includes('-reverse-')).length, 2)
})

test('gitGraph directions alter the chronological axis and reject impossible histories with exact source lines', () => {
  for (const direction of ['LR', 'RL', 'TB', 'BT']) {
    const result = compile(`gitGraph ${direction}:\ncommit\ncommit`)
    const [a, b] = shapes(result).filter(node => /^git-commit-\d+$/.test(node.id))
    if (direction === 'LR') assert.ok(a.x < b.x)
    if (direction === 'RL') assert.ok(a.x > b.x)
    if (direction === 'TB') assert.ok(a.y < b.y)
    if (direction === 'BT') assert.ok(a.y > b.y)
  }
  invalid('gitGraph\ncommit\ncheckout missing', 3, '不存在')
  invalid('gitGraph\ncommit id: "one"\ncommit id: "one"', 3, '重复')
  invalid('gitGraph\ncommit\nmerge main', 3, '自身')
  invalid('gitGraph\ncommit\nbranch empty\ncheckout main\nmerge empty', 5, '相同提交')
})

test('requirements render fields and verification links, preserving reverse-arrow semantics', () => {
  const result = compile(`requirementDiagram
requirement security {
 id: R-1
 text: 登录数据须受到保护
 risk: high
 verifymethod: inspection
}
element audit {
 type: test suite
 docref: security/audit
}
security <- verifies - audit`)
  assert.ok(texts(result).some(text => text.includes('risk: high') && text.includes('verifymethod: inspection')))
  assert.equal(edges(result)[0].label, '«verifies»')
  assert.equal(edges(result)[0].from.nodeId, 'requirement-1')
  invalid('requirementDiagram\nrequirement A {\n risk: impossible\n}', 3)
  invalid('requirementDiagram\nrequirement A {\n risk: low\n risk: high\n}', 4, '重复')
  invalid('requirementDiagram\nrequirement A {\n}\nA - satisfies -> missing', 4, '未定义')
})

test('C4 quoted commas remain text and nested boundaries contain their systems', () => {
  const result = compile(`C4Context
title 系统上下文
Person(user, "User, Admin", "Uses the app")
System_Boundary(outer, "外层") {
 System_Boundary(inner, "内层") {
  System(app, "Application", "Business logic")
 }
}
Rel(user, app, "Browse, edit", "HTTPS")`)
  assert.ok(texts(result).some(text => text.includes('User, Admin')))
  assert.equal(edges(result)[0].label, 'Browse, edit\n[HTTPS]')
  const frames = shapes(result).filter(node => node.shape === 'frame')
  assert.equal(frames.length, 2)
  const app = shapes(result).find(node => node.text.startsWith('Application'))
  for (const frame of frames) assert.ok(app.x >= frame.x && app.y >= frame.y && app.x + app.width <= frame.x + frame.width && app.y + app.height <= frame.y + frame.height)
  assert.ok(result.warnings.some(warning => warning.includes('简化')))
})

test('architecture preserves actual groups and exact cardinal-side endpoints without remote assets', () => {
  const result = compile(`architecture-beta
group api(cloud)[API]
group data(database)[Data]
service a(logos:react)[Frontend] in api
service b(server)[Backend] in api
service db(database)[Storage] in data
a:R --> L:b
b:B --> T:db`)
  const a = shapes(result).find(node => node.text.startsWith('Frontend')), b = shapes(result).find(node => node.text.startsWith('Backend')), db = shapes(result).find(node => node.text.startsWith('Storage'))
  assert.deepEqual(edges(result)[0].from, { x: a.x + a.width, y: a.y + a.height / 2 })
  assert.deepEqual(edges(result)[0].to, { x: b.x, y: b.y + b.height / 2 })
  assert.deepEqual(edges(result)[1].from, { x: b.x + b.width / 2, y: b.y + b.height })
  assert.deepEqual(edges(result)[1].to, { x: db.x + db.width / 2, y: db.y })
  assert.ok(db.y > b.y)
  assert.ok(result.warnings.some(warning => warning.includes('本地')))
  assert.ok(!sceneToSvg(result.scene).includes('https://'))
})

test('recognized grammars reject unknown commands, malformed blocks and preserve original line numbers', () => {
  const cases = [
    ['%% comment\n\nclassDiagram\nclass A {\n +id', 4],
    ['classDiagram\nclass A\nnamespace X {', 3],
    ['stateDiagram\nstate Nested {', 2],
    ['erDiagram\nA {\n string id WRONG\n}', 3],
    ['gitGraph\ncommit\ncherry-pick id: "c1"', 3],
    ['C4Context\nSystem(a, "A")\nUpdateLayoutConfig(2, 3)', 3],
    ['C4Context\nSystem_Boundary(x, "X") {\nSystem(a, "A")', 2],
    ['architecture-beta\ngroup a(cloud)[A] in b\ngroup b(cloud)[B] in a\nservice x(server)[X] in a', 2],
    ['architecture-beta\nservice a(server)[A]\na:R --> L:missing', 3],
  ]
  for (const [source, line] of cases) invalid(source, line)
  assert.equal(compile('sequenceDiagram\nA->>B: message'), undefined)
  assert.equal(compile(''), undefined)
})

test('malicious labels remain inert SVG text and parser limits fail safely', () => {
  const result = compile('classDiagram\nclass X["<script>alert(1)</script>"]')
  const svg = sceneToSvg(result.scene)
  assert.ok(svg.includes('&lt;script&gt;'))
  assert.ok(!svg.includes('<script>'))
  invalid(`classDiagram\n${Array.from({ length: 101 }, (_, i) => `class C${i}`).join('\n')}`, 102, '100')
  invalid(`gitGraph\ncommit id: "${'x'.repeat(2001)}"`, 2, '2,000')
  invalid(`classDiagram\n${'x'.repeat(200001)}`, 1, '200,000')
})


test('all template text reaches the real SVG renderer without field, key or verification truncation', () => {
  for (const template of STRUCTURAL_TEMPLATES) {
    const result = compile(template.source)
    for (const node of shapes(result).filter(node => node.text)) {
      const xml = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${elementToSvg(node, result.scene)}</svg>`, 'image/svg+xml')
      const rendered = xml.getElementsByTagName('text')[0]?.textContent ?? ''
      assert.equal(rendered.replace(/\s/g, ''), node.text.replace(/\s/g, ''), `${template.kind}: ${node.id} must show every line`)
    }
  }
})

test('long class fields wrap completely and card compartments remain inside the bound card', () => {
  const longType = 'VeryLongType'.repeat(12)
  const result = compile(`classDiagram\nclass User {\n  +String id\n  +String name\n  +${longType} metadata\n  +save() bool\n}`)
  const card = shapes(result).find(node => node.id === 'class-0')
  for (const text of shapes(result).filter(node => node.groupId === card.groupId && node.shape === 'text')) {
    assert.ok(text.y >= card.y && text.y + text.height <= card.y + card.height)
    const xml = new DOMParser().parseFromString(`<svg>${elementToSvg(text, result.scene)}</svg>`, 'image/svg+xml')
    assert.equal(xml.getElementsByTagName('text')[0]?.textContent.replace(/\s/g, '') ?? '', text.text.replace(/\s/g, ''))
  }
})

test('static class and ER markers disclose editable-copy limitations only when markers are present', () => {
  assert.deepEqual(compile('classDiagram\nclass A').warnings, [])
  assert.deepEqual(compile('classDiagram\nA --> B').warnings, [])
  for (const op of ['<|--', '*--', 'o--']) assert.ok(compile(`classDiagram\nA ${op} B`).warnings.some(warning => warning.includes('静态') && warning.includes('不会自动')))
  assert.deepEqual(compile('erDiagram\nENTITY').warnings, [])
  assert.ok(compile('erDiagram\nA ||--o{ B : owns').warnings.some(warning => warning.includes('基数端标') && warning.includes('不会自动')))
})
