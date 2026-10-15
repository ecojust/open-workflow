import type { SceneElement, ShapeElement, Point, EdgeElement } from '../types.ts'
import { center, edgePoints } from '../geometry.ts'
import { wrapText } from '../svg.ts'
import { DiagramSyntaxError, DiagramSourceMap, sourceLines, diagramNode, diagramText, diagramEdge, diagramStroke, finishDiagram, type DiagramResult, type DiagramTemplate, type SourceLine } from './common.ts'

type Direction = 'LR' | 'RL' | 'TB' | 'TD' | 'BT'
interface Box { key: string; title: string; fields: string[]; methods: string[]; stereotype: string; width: number; height: number; x: number; y: number; shape?: ShapeElement['shape']; group?: string; line: number; sourceLines: number[] }
interface Link { a: string; b: string; label: string; line: number; op?: string; left?: string; right?: string }
const ID = '[\\p{L}_][\\p{L}\\p{N}_-]*'
const ident = new RegExp(`^${ID}$`, 'u')
const PALETTE = ['#2563eb', '#059669', '#9333ea', '#d97706', '#dc2626', '#0891b2']
function fail(message: string, line: number): never { throw new DiagramSyntaxError(message, line) }
function value(text: string, line: number): string {
  text = text.trim()
  if (text.length > 2000) fail('单项文本不能超过 2,000 个字符。', line)
  if (text.startsWith('"')) {
    try { const decoded: unknown = JSON.parse(text); if (typeof decoded === 'string') return decoded } catch { /* diagnostic below */ }
    fail('字符串引号或转义不完整。', line)
  }
  return text
}
function addBox(boxes: Map<string, Box>, key: string, line: number): Box {
  let box = boxes.get(key)
  if (!box) {
    if (boxes.size >= 100) fail('此类图表最多支持 100 个节点。', line)
    box = { key, title: key, fields: [], methods: [], stereotype: '', width: 200, height: 72, x: 0, y: 0, line, sourceLines: [] }
    boxes.set(key, box)
  }
  box.sourceLines.push(line)
  return box
}
function addLink(links: Link[], link: Link): void {
  if (links.length >= 240) fail('此类图表最多支持 240 条关系。', link.line)
  links.push(link)
}
function member(box: Box, text: string, line: number): void {
  box.sourceLines.push(line)
  if (box.fields.length + box.methods.length >= 40) fail('每个节点最多支持 40 个成员或字段。', line)
  if (/^<<[^<>]+>>$/.test(text)) { box.stereotype = text; return }
  if (!text || /[{}]/.test(text)) fail('成员语法不完整；不支持嵌套块。', line)
  const label = value(text, line)
  ;(label.includes('(') ? box.methods : box.fields).push(label)
}
function cardSections(box: Box): { header: number; fields: number; methods: number } {
  return {
    header: Math.max(44, wrapText([box.stereotype, box.title].filter(Boolean).join('\n'), box.width - 36, 15).length * 22 + 24),
    fields: Math.max(1, wrapText(box.fields.join('\n'), box.width - 44, 14).length) * 22 + 16,
    methods: box.methods.length ? wrapText(box.methods.join('\n'), box.width - 44, 14).length * 22 + 16 : 0,
  }
}
function sizeCard(box: Box): void {
  const labels = [box.title, box.stereotype, ...box.fields, ...box.methods]
  box.width = Math.min(680, Math.max(230, ...labels.map(label => Array.from(label).reduce((sum, char) => sum + (/[^\x00-\x7F]/.test(char) ? 14 : 8), 64))))
  const section = cardSections(box)
  box.height = section.header + section.fields + section.methods
}
/** Layering uses first-visit ranks so cycles cannot inflate the layout. */
function layout(boxes: Map<string, Box>, links: Link[], direction: Direction): void {
  const all = [...boxes.values()]
  const rank = new Map<string, number>()
  const incoming = new Set(links.filter(link => link.a !== link.b).map(link => link.b))
  const queue = all.filter(box => !incoming.has(box.key)).map(box => box.key)
  for (const key of queue) rank.set(key, 0)
  function walk(): void {
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i]!
      for (const link of links) if (link.a === key && !rank.has(link.b)) { rank.set(link.b, rank.get(key)! + 1); queue.push(link.b) }
    }
  }
  walk()
  for (const box of all) if (!rank.has(box.key)) { rank.set(box.key, 0); queue.push(box.key); walk() }
  const horizontal = direction === 'LR' || direction === 'RL'
  const layers: Box[][] = []
  for (const box of all) (layers[rank.get(box.key)!] ??= []).push(box)
  const cross = Math.max(0, ...layers.map(layer => layer.reduce((n, box) => n + (horizontal ? box.height : box.width) + 60, -60)))
  let along = 80
  for (const layer of layers) {
    const span = layer.reduce((n, box) => n + (horizontal ? box.height : box.width) + 60, -60)
    let across = 80 + (cross - span) / 2
    for (const box of layer) {
      box.x = horizontal ? along : across; box.y = horizontal ? across : along
      across += (horizontal ? box.height : box.width) + 60
    }
    along += Math.max(...layer.map(box => horizontal ? box.width : box.height)) + 130
  }
  if (direction === 'RL') for (const box of all) box.x = along - box.x - box.width + 80
  if (direction === 'BT') for (const box of all) box.y = along - box.y - box.height + 80
}
function card(box: Box, id: string, elements: SceneElement[], fill = '#eff6ff'): ShapeElement {
  const startIndex = elements.length
  const node = diagramNode(id, '', box.x, box.y, box.width, box.height, box.shape ?? 'rectangle', { fill, stroke: '#64748b' })
  elements.push(node)
  const section = cardSections(box), header = section.header
  elements.push(diagramText(`${id}-title`, [box.stereotype, box.title].filter(Boolean).join('\n'), box.x + 8, box.y + 5, box.width - 16, header - 8, { fontSize: 15 }))
  elements.push(diagramStroke(`${id}-separator`, [{ x: box.x, y: box.y + header }, { x: box.x + box.width, y: box.y + header }], { stroke: '#94a3b8', strokeWidth: 1 }))
  elements.push(diagramText(`${id}-fields`, box.fields.join('\n'), box.x + 12, box.y + header + 2, box.width - 24, section.fields - 4, { textAlign: 'left' }))
  if (box.methods.length) {
    const y = box.y + header + section.fields
    elements.push(diagramStroke(`${id}-methods-separator`, [{ x: box.x, y }, { x: box.x + box.width, y }], { stroke: '#94a3b8', strokeWidth: 1 }))
    elements.push(diagramText(`${id}-methods`, box.methods.join('\n'), box.x + 12, y + 2, box.width - 24, section.methods - 4, { textAlign: 'left' }))
  }
  for (const element of elements.slice(startIndex)) element.groupId = `${id}-card`
  return node
}
function endpoint(node: ShapeElement) { return { ...center(node), nodeId: node.id } }
function relation(edge: EdgeElement, elements: SceneElement[], prefix: string, left = '', right = ''): void {
  const points = edgePoints(edge, { elements, background: '#ffffff', grid: false })
  for (const [index, label] of [[0, left], [1, right]] as const) if (label) {
    const p = points[index ? points.length - 1 : 0]!, q = points[index ? points.length - 2 : 1]!
    const length = Math.hypot(q.x - p.x, q.y - p.y) || 1
    elements.push(diagramText(`${prefix}-multiplicity-${index}`, label, p.x + (q.x - p.x) / length * 28 - 32, p.y + (q.y - p.y) / length * 28 - 24, 64, 22, { fontSize: 12 }))
  }
}
function marker(edge: EdgeElement, elements: SceneElement[], side: 'start' | 'end', kind: 'diamond' | 'hollow' | 'triangle', id: string): void {
  const points = edgePoints(edge, { elements, background: '#ffffff', grid: false })
  const p = points[side === 'start' ? 0 : points.length - 1]!, q = points[side === 'start' ? 1 : points.length - 2]!
  const length = Math.hypot(q.x - p.x, q.y - p.y) || 1, ux = (q.x - p.x) / length, uy = (q.y - p.y) / length
  const at = (d: number, cross: number): Point => ({ x: p.x + ux * d - uy * cross, y: p.y + uy * d + ux * cross })
  const points2 = kind === 'triangle' ? [p, at(18, 9), at(18, -9)] : [p, at(10, 6), at(20, 0), at(10, -6)]
  elements.push(diagramStroke(id, points2, { fill: kind === 'diamond' ? '#334155' : '#ffffff', strokeWidth: 1.5 }, true))
}
function mapStructureSources(sources: DiagramSourceMap, boxes: Map<string, Box>, nodes: Map<string, ShapeElement>, elements: SceneElement[], links: Link[], prefix: string, groups?: Map<string, Group>): void {
  const members = new Map<string, string[]>()
  for (const element of elements) if (element.groupId) members.set(element.groupId, [...(members.get(element.groupId) ?? []), element.id])
  for (const box of boxes.values()) {
    const node = nodes.get(box.key)!
    for (const line of box.sourceLines) sources.add(line, ...(node.groupId ? members.get(node.groupId)! : [node.id]))
  }
  links.forEach((link, i) => { const id = `${prefix}-edge-${i}`; sources.set(link.line, ...elements.filter(element => element.id === id || element.id.startsWith(`${id}-`)).map(element => element.id)) })
  if (groups) [...groups.values()].forEach((group, i) => sources.add(group.line, `${prefix}-group-${i}`))
}
function compileClass(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), links: Link[] = []; let active: Box | undefined, opening = 1, direction: Direction = 'TB'
  const relationRE = new RegExp(`^(${ID})(?:\\s+"([^"\\n]*)")?\\s*(<\\|--|--\\|>|<\\|\\.\\.|\\.\\.\\|>|\\*--|--\\*|o--|--o|<-->|<\\.\\.>|-->|<--|\\.\\.>|<\\.\\.|--|\\.\\.)\\s*(?:"([^"\\n]*)"\\s+)?(${ID})(?:\\s*:\\s*(.+))?$`, 'u')
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line
    if (active) { if (text === '}') { active = undefined; continue }; member(active, text, line); continue }
    let m: RegExpMatchArray | null
    if ((m = text.match(/^direction\s+(LR|RL|TB|TD|BT)$/))) { direction = m[1] as Direction; continue }
    if ((m = text.match(new RegExp(`^class\\s+(${ID})(?:\\s*\\[\\s*("(?:[^"\\\\]|\\\\.)*")\\s*\\])?\\s*(?:\\{(.*))?$`, 'u')))) {
      const box = addBox(boxes, m[1]!, line); if (m[2]) box.title = value(m[2], line)
      if (m[3] !== undefined) {
        if (m[3].trim().endsWith('}')) { const body = m[3].trim().slice(0, -1); for (const item of body.split(';').map(item => item.trim()).filter(Boolean)) member(box, item, line) }
        else if (m[3].trim()) fail('类定义的首行请仅保留左花括号。', line)
        else { active = box; opening = line }
      }
      continue
    }
    if ((m = text.match(new RegExp(`^(${ID})\\s*:\\s*(.+)$`, 'u')))) { member(addBox(boxes, m[1]!, line), m[2]!, line); continue }
    if ((m = text.match(new RegExp(`^(<<[^<>]+>>)\\s+(${ID})$`, 'u')))) { addBox(boxes, m[2]!, line).stereotype = m[1]!; continue }
    if ((m = text.match(relationRE))) {
      addBox(boxes, m[1]!, line); addBox(boxes, m[5]!, line)
      addLink(links, { a: m[1]!, b: m[5]!, left: m[2] ?? '', right: m[4] ?? '', op: m[3]!, label: value(m[6] ?? '', line), line }); continue
    }
    fail('不支持此类图语法。支持 class、成员、direction 和基本关系；命名空间、样式及交互指令暂不支持。', line)
  }
  if (active) fail('类定义缺少右花括号。', opening)
  if (!boxes.size) fail('类图至少需要一个类。', lines[0]!.line)
  for (const box of boxes.values()) sizeCard(box)
  layout(boxes, links, direction)
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) nodes.set(box.key, card(box, `class-${nodes.size}`, elements))
  links.forEach((link, i) => {
    const op = link.op!, reverse = op.startsWith('<') && !op.endsWith('>'), inheritance = op.includes('|'), diamond = op.includes('*') || op.includes('o')
    const a = nodes.get(reverse ? link.b : link.a)!, b = nodes.get(reverse ? link.a : link.b)!
    const edge = diagramEdge(`class-edge-${i}`, endpoint(a), endpoint(b), link.label, { arrow: inheritance || diamond || op === '--' || op === '..' ? 'none' : op.startsWith('<') && op.endsWith('>') ? 'both' : 'end', style: { dashed: op.includes('..') } })
    elements.push(edge); relation(edge, elements, edge.id, reverse ? link.right : link.left, reverse ? link.left : link.right)
    if (inheritance) marker(edge, elements, 'end', 'triangle', `${edge.id}-inheritance`)
    if (diamond) marker(edge, elements, op.startsWith('*') || op.startsWith('o') ? 'start' : 'end', op.includes('*') ? 'diamond' : 'hollow', `${edge.id}-composition`)
  })
  mapStructureSources(sources, boxes, nodes, elements, links, 'class')
  return finishDiagram('class', elements, links.some(link => /[|*o]/.test(link.op ?? '')) ? ['继承、组合和聚合端标为静态装饰；创建可编辑副本后，移动类卡片不会自动重算这些端标。'] : [], sources)
}
function compileState(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), links: Link[] = []; let direction: Direction = 'TB'
  const token = `(?:${ID}|\\[\\*\\])`
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if ((m = text.match(/^direction\s+(LR|RL|TB|TD|BT)$/))) { direction = m[1] as Direction; continue }
    if ((m = text.match(new RegExp(`^(${token})\\s*-->\\s*(${token})(?:\\s*:\\s*(.+))?$`, 'u')))) {
      const a = m[1] === '[*]' ? '$start' : m[1]!, b = m[2] === '[*]' ? '$end' : m[2]!
      if (a === '$start' && b === '$end') fail('起点与终点之间至少需要一个状态。', line)
      addBox(boxes, a, line); addBox(boxes, b, line); addLink(links, { a, b, label: value(m[3] ?? '', line), line }); continue
    }
    if ((m = text.match(new RegExp(`^state\\s+("(?:[^"\\\\]|\\\\.)*")\\s+as\\s+(${ID})$`, 'u')))) { addBox(boxes, m[2]!, line).title = value(m[1]!, line); continue }
    if ((m = text.match(new RegExp(`^state\\s+(${ID})(?:\\s+(<<choice>>))?$`, 'u')))) { const box = addBox(boxes, m[1]!, line); if (m[2]) box.shape = 'diamond'; continue }
    if ((m = text.match(new RegExp(`^(${ID})\\s*:\\s*(.+)$`, 'u')))) { const box = addBox(boxes, m[1]!, line); if (box.fields.length >= 20) fail('单个状态描述过多。', line); box.fields.push(value(m[2]!, line)); continue }
    if (ident.test(text)) { addBox(boxes, text, line); continue }
    fail('不支持此状态图语法。支持普通状态、choice、起终点和转移；复合状态、并行区域、note、fork/join 暂不支持。', line)
  }
  if (!boxes.size) fail('状态图至少需要一个状态。', lines[0]!.line)
  for (const box of boxes.values()) {
    box.width = box.key.startsWith('$') ? 30 : box.shape === 'diamond' ? 160 : 220
    box.height = box.key.startsWith('$') ? 30 : box.shape === 'diamond' ? 100 : 64 + box.fields.length * 22
  }
  layout(boxes, links, direction)
  const final = boxes.get('$end'), otherStates = [...boxes.values()].filter(box => box !== final)
  if (final && otherStates.length) {
    if (direction === 'LR') final.x = Math.max(...otherStates.map(box => box.x + box.width)) + 130
    if (direction === 'RL') final.x = Math.min(...otherStates.map(box => box.x)) - 160
    if (direction === 'TB' || direction === 'TD') final.y = Math.max(...otherStates.map(box => box.y + box.height)) + 130
    if (direction === 'BT') final.y = Math.min(...otherStates.map(box => box.y)) - 160
  }
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) {
    const pseudo = box.key.startsWith('$'), id = `state-${nodes.size}`
    const node = diagramNode(id, pseudo ? '' : [box.title, ...box.fields].join('\n'), box.x, box.y, box.width, box.height, pseudo ? 'ellipse' : box.shape ?? 'rectangle', { fill: box.key === '$start' ? '#334155' : '#f0fdfa' })
    elements.push(node); nodes.set(box.key, node)
    if (box.key === '$end') {
      node.groupId = `${id}-symbol`
      elements.push({ ...diagramNode(`${id}-inner`, '', box.x + 6, box.y + 6, 18, 18, 'ellipse', { fill: '#334155' }), groupId: node.groupId })
    }
  }
  links.forEach((link, i) => elements.push(diagramEdge(`state-edge-${i}`, endpoint(nodes.get(link.a)!), endpoint(nodes.get(link.b)!), link.label, { route: 'orthogonal' })))
  mapStructureSources(sources, boxes, nodes, elements, links, 'state')
  return finishDiagram('state', elements, [], sources)
}
function crowfoot(edge: EdgeElement, elements: SceneElement[], side: 'start' | 'end', symbol: string, id: string): void {
  const points = edgePoints(edge, { elements, background: '#ffffff', grid: false })
  const p = points[side === 'start' ? 0 : points.length - 1]!, q = points[side === 'start' ? 1 : points.length - 2]!
  const length = Math.hypot(q.x - p.x, q.y - p.y) || 1, ux = (q.x - p.x) / length, uy = (q.y - p.y) / length
  const at = (d: number, cross: number): Point => ({ x: p.x + ux * d - uy * cross, y: p.y + uy * d + ux * cross })
  if (/[{}]/.test(symbol)) for (const cross of [-8, 0, 8]) elements.push(diagramStroke(`${id}-fan-${cross}`, [at(2, cross), at(17, 0)], { strokeWidth: 1.5 }))
  else elements.push(diagramStroke(`${id}-one`, [at(7, -8), at(7, 8)], { strokeWidth: 1.5 }))
  if (symbol.includes('o')) { const c = at(25, 0); elements.push(diagramNode(`${id}-optional`, '', c.x - 5, c.y - 5, 10, 10, 'ellipse', { fill: '#ffffff', strokeWidth: 1.5 })) }
  else elements.push(diagramStroke(`${id}-required`, [at(24, -8), at(24, 8)], { strokeWidth: 1.5 }))
}
function compileER(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), links: Link[] = []; let active: Box | undefined, opening = 1, direction: Direction = 'LR'
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if (active) {
      if (text === '}') { active = undefined; continue }
      if (!(m = text.match(/^([\p{L}_][\p{L}\p{N}_()[\]-]*)\s+([\p{L}_][\p{L}\p{N}_-]*)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+("(?:[^"\\]|\\.)*"))?$/u))) fail('实体属性格式应为：类型 名称 [PK, FK, UK] ["说明"]。', line)
      const label = `${m[1]}    ${m[2]}${m[3] ? `    [${m[3].replace(/\s/g, '')}]` : ''}${m[4] ? `  ${value(m[4], line)}` : ''}`
      if (active.fields.length >= 40) fail('每个实体最多支持 40 个属性。', line)
      active.sourceLines.push(line); active.fields.push(label); continue
    }
    if ((m = text.match(/^direction\s+(LR|RL|TB|TD|BT)$/))) { direction = m[1] as Direction; continue }
    if ((m = text.match(new RegExp(`^(${ID})(?:\\s*\\[\\s*("(?:[^"\\\\]|\\\\.)*")\\s*\\])?\\s*\\{$`, 'u')))) { active = addBox(boxes, m[1]!, line); if (m[2]) active.title = value(m[2], line); opening = line; continue }
    if ((m = text.match(new RegExp(`^(${ID})\\s+(\\|\\||\\|o|o\\||\\}\\||\\}o)(--|\\.\\.)(\\|\\||o\\||\\|o|\\|\\{|o\\{)\\s+(${ID})\\s*:\\s*(.+)$`, 'u')))) {
      addBox(boxes, m[1]!, line); addBox(boxes, m[5]!, line); addLink(links, { a: m[1]!, b: m[5]!, left: m[2]!, right: m[4]!, op: m[3]!, label: value(m[6]!, line), line }); continue
    }
    if (ident.test(text)) { addBox(boxes, text, line); continue }
    fail('不支持此 ER 图语法。请使用实体属性块及 ||--o{ 等基数关系。', line)
  }
  if (active) fail('实体定义缺少右花括号。', opening)
  if (!boxes.size) fail('ER 图至少需要一个实体。', lines[0]!.line)
  for (const box of boxes.values()) sizeCard(box)
  layout(boxes, links, direction)
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) nodes.set(box.key, card(box, `er-${nodes.size}`, elements, '#f0fdf4'))
  links.forEach((link, i) => {
    const edge = diagramEdge(`er-edge-${i}`, endpoint(nodes.get(link.a)!), endpoint(nodes.get(link.b)!), link.label, { arrow: 'none', style: { dashed: link.op === '..' } }); elements.push(edge)
    crowfoot(edge, elements, 'start', link.left!, `${edge.id}-left`); crowfoot(edge, elements, 'end', link.right!, `${edge.id}-right`)
  })
  mapStructureSources(sources, boxes, nodes, elements, links, 'er')
  return finishDiagram('er', elements, links.length ? ['ER 基数端标为静态装饰；创建可编辑副本后，移动实体卡片不会自动重算这些端标。'] : [], sources)
}
interface Commit { id: string; branch: string; parents: string[]; tag: string; type: string; line: number }
function gitOptions(text: string, line: number): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  while (text.trim()) {
    const m = text.trim().match(/^(id|tag|type)\s*:\s*("(?:[^"\\]|\\.)*"|[\w.-]+)(?:\s+|$)/)
    if (!m) fail('提交选项支持 id: "标识"、tag: "标签"、type: NORMAL/REVERSE/HIGHLIGHT。', line)
    if (result[m[1]!] !== undefined) fail(`重复的 ${m[1]} 选项。`, line)
    result[m[1]!] = value(m[2]!, line); text = text.trim().slice(m[0].length)
  }
  if (result.type && !['NORMAL', 'REVERSE', 'HIGHLIGHT'].includes(result.type)) fail('未知提交类型。', line)
  return result
}
function compileGit(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const header = lines[0]!, hm = header.text.trim().match(/^gitGraph(?:\s+(LR|RL|TB|BT))?\s*:?$/)
  if (!hm) fail('gitGraph 标题支持 LR、RL、TB、BT 方向。', header.line)
  const direction = (hm[1] ?? 'LR') as Direction
  const branches = new Map<string, { head?: string; order: number; index: number; lines: number[] }>([['main', { order: 0, index: 0, lines: [] }]])
  const commits: Commit[] = [], ids = new Set<string>(); let current = 'main'
  const commit = (options: Record<string, string>, line: number, extra?: string): void => {
    if (commits.length >= 150) fail('gitGraph 最多支持 150 次提交。', line)
    let id = options.id
    if (id !== undefined && !id.trim()) fail('提交标识不能为空。', line)
    if (id === undefined) { let n = commits.length + 1; while (ids.has(`c${n}`)) n++; id = `c${n}` }
    if (ids.has(id)) fail(`重复的提交标识：${id}。`, line)
    const branch = branches.get(current)!, parents = [branch.head, extra].filter((parent): parent is string => !!parent)
    commits.push({ id, branch: current, parents, tag: options.tag ?? '', type: options.type ?? 'NORMAL', line }); ids.add(id); branch.head = id
  }
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if ((m = text.match(/^commit(?:\s+(.*))?$/))) { commit(gitOptions(m[1] ?? '', line), line); continue }
    if ((m = text.match(new RegExp(`^branch\\s+(${ID})(?:\\s+order\\s*:\\s*(\\d+))?$`, 'u')))) {
      if (branches.size >= 20) fail('最多支持 20 个分支。', line)
      if (branches.has(m[1]!)) fail(`分支 ${m[1]} 已存在。`, line)
      const order = m[2] ? Number(m[2]) : branches.size
      if (!Number.isSafeInteger(order) || order > 10000) fail('分支 order 必须是 0–10000 的整数。', line)
      branches.set(m[1]!, { head: branches.get(current)!.head, order, index: branches.size, lines: [line] }); current = m[1]!; continue
    }
    if ((m = text.match(new RegExp(`^(?:checkout|switch)\\s+(${ID})$`, 'u')))) { if (!branches.has(m[1]!)) fail(`分支 ${m[1]} 不存在。`, line); current = m[1]!; branches.get(current)!.lines.push(line); continue }
    if ((m = text.match(new RegExp(`^merge\\s+(${ID})(?:\\s+(.*))?$`, 'u')))) {
      const other = branches.get(m[1]!)
      if (!other) fail(`合并分支 ${m[1]} 不存在。`, line)
      if (m[1] === current) fail('不能将分支合并到自身。', line)
      if (!other.head || !branches.get(current)!.head) fail('合并双方都需要已有提交。', line)
      if (other.head === branches.get(current)!.head) fail('两个分支指向相同提交，无需合并。', line)
      commit(gitOptions(m[2] ?? '', line), line, other.head); continue
    }
    fail('不支持此 gitGraph 语法。支持 commit、branch、checkout/switch、merge；cherry-pick 和配置指令暂不支持。', line)
  }
  if (!commits.length) fail('gitGraph 至少需要一次提交。', header.line)
  const lanes = [...branches.entries()].sort((a, b) => a[1].order - b[1].order || a[1].index - b[1].index)
  const position = (time: number, lane: number): Point => {
    let x = 180 + time * 150, y = 100 + lane * 130
    if (direction === 'RL') x = 180 + (commits.length - 1 - time) * 150
    if (direction === 'TB' || direction === 'BT') { const nextX = y; y = direction === 'BT' ? 180 + (commits.length - 1 - time) * 150 : x; x = nextX }
    return { x, y }
  }
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>()
  lanes.forEach(([name, branch], index) => {
    for (const line of branch.lines) sources.add(line, `git-lane-${index}`, `git-branch-${index}`)
    const start = position(-0.5, index), end = position(commits.length - 0.5, index), color = PALETTE[index % PALETTE.length]!
    elements.push(diagramStroke(`git-lane-${index}`, [start, end], { stroke: color, opacity: 0.28, strokeWidth: 2 }))
    const p = position(direction === 'RL' || direction === 'BT' ? commits.length - 0.4 : -0.6, index)
    elements.push(diagramText(`git-branch-${index}`, name, p.x - 55, p.y - 40, 110, 30, { stroke: color }))
  })
  commits.forEach((item, i) => {
    const first = elements.length
    const lane = lanes.findIndex(([name]) => name === item.branch), p = position(i, lane), color = PALETTE[lane % PALETTE.length]!, id = `git-commit-${i}`
    const node = diagramNode(id, '', p.x - 13, p.y - 13, 26, 26, 'ellipse', { fill: color, stroke: color }); nodes.set(item.id, node); elements.push(node)
    if (item.type === 'HIGHLIGHT') elements.push(diagramNode(`${id}-highlight`, '', p.x - 19, p.y - 19, 38, 38, 'ellipse', { fill: 'none', stroke: color }))
    if (item.type === 'REVERSE') for (const sign of [-1, 1]) elements.push(diagramStroke(`${id}-reverse-${sign}`, [{ x: p.x - 6, y: p.y - sign * 6 }, { x: p.x + 6, y: p.y + sign * 6 }], { stroke: '#ffffff', strokeWidth: 2 }))
    elements.push(diagramText(`${id}-label`, item.id, p.x - 65, p.y + 23, 130, 28, { fontSize: 12 }))
    if (item.tag) elements.push(diagramNode(`${id}-tag`, item.tag, p.x - 65, p.y - 53, 130, 26, 'rectangle', { fill: '#fef3c7', stroke: '#d97706', fontSize: 12 }))
    for (const element of elements.slice(first)) element.groupId = `${id}-symbol`
    sources.capture(item.line, elements, first)
    sources.add(item.line, ...item.parents.map((_, index) => `git-edge-${i}-${index}`))
  })
  const edges: SceneElement[] = []
  commits.forEach((item, i) => item.parents.forEach((parent, index) => edges.push(diagramEdge(`git-edge-${i}-${index}`, endpoint(nodes.get(parent)!), endpoint(nodes.get(item.id)!), '', { route: index ? 'orthogonal' : 'straight', style: { stroke: nodes.get(item.id)!.style.stroke, strokeWidth: 2 } }))))
  // Tracks first, ancestry second, commits last keep dots and labels legible.
  const tracks = lanes.length * 2
  elements.splice(tracks, 0, ...edges)
  return finishDiagram('gitgraph', elements, [], sources)
}
function compileRequirement(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), links: Link[] = [], fields = new Map<string, Map<string, string>>()
  let active: Box | undefined, opening = 1
  const allowedTypes = 'requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint|element'
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if (active) {
      if (text === '}') { active = undefined; continue }
      if (!(m = text.match(/^(id|text|risk|verifymethod|type|docref)\s*:\s*(.+)$/))) fail('需求字段支持 id、text、risk、verifymethod；element 支持 type、docref。', line)
      const key = m[1]!, data = value(m[2]!, line), isElement = active.stereotype === '«element»'
      if (isElement ? !['type', 'docref'].includes(key) : !['id', 'text', 'risk', 'verifymethod'].includes(key)) fail(`此节点不支持 ${key} 字段。`, line)
      if (key === 'risk' && !['low', 'medium', 'high'].includes(data.toLowerCase())) fail('risk 应为 low、medium 或 high。', line)
      if (key === 'verifymethod' && !['analysis', 'inspection', 'test', 'demonstration'].includes(data.toLowerCase())) fail('verifymethod 应为 analysis、inspection、test 或 demonstration。', line)
      const map = fields.get(active.key)!
      if (map.has(key)) fail(`重复的 ${key} 字段。`, line)
      active.sourceLines.push(line); map.set(key, data); continue
    }
    if ((m = text.match(new RegExp(`^(${allowedTypes})\\s+(${ID})\\s*\\{$`, 'u')))) {
      if (boxes.has(m[2]!)) fail(`重复的需求节点：${m[2]}。`, line)
      active = addBox(boxes, m[2]!, line); active.stereotype = `«${m[1]}»`; fields.set(active.key, new Map()); opening = line; continue
    }
    if ((m = text.match(new RegExp(`^(${ID})\\s+(-|<-)\\s*(contains|copies|derives|satisfies|verifies|refines|traces)\\s*(->|-)\\s+(${ID})$`, 'u')))) {
      if (!(m[2] === '-' && m[4] === '->') && !(m[2] === '<-' && m[4] === '-')) fail('需求关系应为 A - 关系 -> B 或 A <- 关系 - B。', line)
      addLink(links, { a: m[2] === '<-' ? m[5]! : m[1]!, b: m[2] === '<-' ? m[1]! : m[5]!, label: m[3]!, line }); continue
    }
    fail('不支持此需求图语法。请使用需求/element 字段块和有向关系。', line)
  }
  if (active) fail('需求定义缺少右花括号。', opening)
  if (!boxes.size) fail('需求图至少需要一个节点。', lines[0]!.line)
  for (const link of links) if (!boxes.has(link.a) || !boxes.has(link.b)) fail('需求关系引用了未定义节点。', link.line)
  for (const box of boxes.values()) { box.fields = [...fields.get(box.key)!].flatMap(([key, data]) => wrap(`${key}: ${data}`, 45)); sizeCard(box) }
  layout(boxes, links, 'TB')
  const elements: SceneElement[] = [], nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) nodes.set(box.key, card(box, `requirement-${nodes.size}`, elements, '#fefce8'))
  links.forEach((link, i) => elements.push(diagramEdge(`requirement-edge-${i}`, endpoint(nodes.get(link.a)!), endpoint(nodes.get(link.b)!), `«${link.label}»`, { style: { dashed: link.label !== 'contains' } })))
  mapStructureSources(sources, boxes, nodes, elements, links, 'requirement')
  return finishDiagram('requirement', elements, [], sources)
}
function wrap(text: string, width: number): string[] {
  const chars = Array.from(text), lines: string[] = []
  for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''))
  return lines.length ? lines : ['']
}
function args(text: string, line: number): string[] {
  const result: string[] = []; let current = '', quoted = false, escaped = false
  for (const char of text) {
    if (escaped) { current += char; escaped = false; continue }
    if (quoted && char === '\\') { current += char; escaped = true; continue }
    if (char === '"') quoted = !quoted
    if (char === ',' && !quoted) { result.push(value(current, line)); current = '' } else current += char
  }
  if (quoted) fail('函数参数的引号未闭合。', line)
  result.push(value(current, line)); return result
}
interface Group { key: string; title: string; parent?: string; line: number }
function groupedLayout(boxes: Map<string, Box>, groups: Map<string, Group>): Map<string, { x: number; y: number; width: number; height: number }> {
  // Recursive groups retain visual membership, with a deterministic grid inside each boundary.
  let count = 0
  function place(groupKey: string | undefined, x: number, y: number, depth: number): { width: number; height: number } {
    if (depth > 8) fail('分组嵌套不能超过 8 层。', groups.get(groupKey ?? '')?.line ?? 1)
    const direct = [...boxes.values()].filter(box => box.group === groupKey), children = [...groups.values()].filter(group => group.parent === groupKey)
    let bottom = y + 55, maxRight = x + 320
    for (let i = 0; i < direct.length; i += 3) {
      const row = direct.slice(i, i + 3), rowY = bottom
      row.forEach((box, j) => { box.x = x + 30 + j * 390; box.y = rowY; maxRight = Math.max(maxRight, box.x + box.width + 30) })
      bottom += Math.max(...row.map(box => box.height)) + 60
    }
    for (const child of children) {
      if (++count > 100) fail('分组结构包含循环或节点过多。', child.line)
      const size = place(child.key, x + 25, bottom + 20, depth + 1)
      bounds.set(child.key, { x: x + 25, y: bottom + 20, width: size.width, height: size.height })
      bottom += size.height + 45; maxRight = Math.max(maxRight, x + 25 + size.width + 25)
    }
    return { width: maxRight - x, height: Math.max(130, bottom - y) }
  }
  const bounds = new Map<string, { x: number; y: number; width: number; height: number }>()
  place(undefined, 50, 70, 0)
  return bounds
}
function groupElements(groups: Map<string, Group>, prefix: string, groupBounds: Map<string, { x: number; y: number; width: number; height: number }>): SceneElement[] {
  return [...groups.values()].map((group, i) => {
    const bounds = groupBounds.get(group.key)!
    return diagramNode(`${prefix}-group-${i}`, group.title, bounds.x, bounds.y, bounds.width, bounds.height, 'frame', { fill: '#f8fafc', stroke: '#94a3b8', dashed: true, textAlign: 'left', fontSize: 14 })
  })
}
function compileC4(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), groups = new Map<string, Group>(), links: Link[] = [], kinds = new Map<string, string>(), stack: string[] = []
  let title = ''
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if ((m = text.match(/^title\s+(.+)$/))) { if (title) fail('title 只能声明一次。', line); title = value(m[1]!, line); sources.add(line, 'c4-title'); continue }
    if (text === '}') { if (!stack.pop()) fail('出现了多余的右花括号。', line); continue }
    if (!(m = text.match(/^([A-Za-z_]+)\s*\((.*)\)\s*(\{)?$/))) fail('不支持此 C4 语法。请使用 Person、System、边界和 Rel 函数。', line)
    const name = m[1]!, list = args(m[2]!, line), key = list[0]!
    if (['Enterprise_Boundary', 'System_Boundary', 'Boundary'].includes(name)) {
      if (!m[3] || list.length !== 2 || !ident.test(key)) fail('边界格式应为 System_Boundary(id, "名称") {。', line)
      if (groups.has(key) || boxes.has(key)) fail(`重复的 C4 标识：${key}。`, line)
      if (groups.size >= 30 || stack.length >= 8) fail('C4 分组过多或嵌套超过 8 层。', line)
      groups.set(key, { key, title: list[1]!, parent: stack.at(-1), line }); stack.push(key); continue
    }
    if (m[3]) fail('仅边界函数允许定义块。', line)
    if (['Person', 'Person_Ext', 'System', 'System_Ext', 'SystemDb', 'SystemDb_Ext', 'SystemQueue', 'SystemQueue_Ext'].includes(name)) {
      if (list.length < 2 || list.length > 3 || !ident.test(key)) fail('C4 节点格式应为 Person/System(id, "名称", "描述")。', line)
      if (boxes.has(key) || groups.has(key)) fail(`重复的 C4 标识：${key}。`, line)
      const box = addBox(boxes, key, line); box.title = list[1]!; box.fields = wrap(list[2] ?? '', 28); box.stereotype = name; box.group = stack.at(-1); box.width = 250; box.height = 100 + box.fields.length * 18; kinds.set(key, name); continue
    }
    if (['Rel', 'Rel_Back', 'BiRel', 'Rel_U', 'Rel_D', 'Rel_L', 'Rel_R'].includes(name)) {
      if (list.length < 3 || list.length > 4 || !ident.test(key) || !ident.test(list[1]!)) fail('关系格式应为 Rel(起点, 终点, "说明", ["协议"])。', line)
      addLink(links, { a: name === 'Rel_Back' ? list[1]! : key, b: name === 'Rel_Back' ? key : list[1]!, label: list[2]! + (list[3] ? `\n[${list[3]}]` : ''), op: name, line }); continue
    }
    fail(`暂不支持 C4 函数 ${name}。支持上下文人物、系统、边界和关系。`, line)
  }
  if (stack.length) fail('C4 边界缺少右花括号。', groups.get(stack.at(-1)!)!.line)
  if (!boxes.size) fail('C4 图至少需要一个人物或系统。', lines[0]!.line)
  for (const link of links) if (!boxes.has(link.a) || !boxes.has(link.b)) fail('C4 关系引用了未定义节点。', link.line)
  const bounds = groups.size ? groupedLayout(boxes, groups) : new Map()
  if (!groups.size) layout(boxes, links, 'LR')
  const elements: SceneElement[] = groups.size ? groupElements(groups, 'c4', bounds) : [], nodes = new Map<string, ShapeElement>()
  if (title) elements.push(diagramText('c4-title', title, 60, 10, 700, 40, { fontSize: 23, textAlign: 'left' }))
  for (const box of boxes.values()) {
    const kind = kinds.get(box.key)!, external = kind.endsWith('_Ext'), person = kind.startsWith('Person'), id = `c4-${nodes.size}`
    const node = diagramNode(id, `${box.title}\n[${person ? 'Person' : 'Software System'}]\n${box.fields.join('\n')}`, box.x, box.y, box.width, box.height, kind.includes('Db') ? 'cylinder' : 'rectangle', { fill: external ? '#64748b' : person ? '#1e3a8a' : '#2563eb', stroke: '#ffffff', fontSize: 14 })
    elements.push(node); nodes.set(box.key, node)
    if (person) {
      node.groupId = `${id}-symbol`
      elements.push({ ...diagramNode(`${id}-person`, '', box.x + box.width / 2 - 15, box.y - 25, 30, 30, 'ellipse', { fill: external ? '#64748b' : '#1e3a8a', stroke: '#ffffff' }), groupId: node.groupId })
    }
  }
  links.forEach((link, i) => elements.push(diagramEdge(`c4-edge-${i}`, endpoint(nodes.get(link.a)!), endpoint(nodes.get(link.b)!), link.label, { arrow: link.op === 'BiRel' ? 'both' : 'end', style: { dashed: true } })))
  const warnings = ['C4Context 使用本地简化人物/系统符号与自动布局；边界保留分组，未实现 C4 官方样式配置。']
  if (links.some(link => /^Rel_[UDLR]$/.test(link.op ?? ''))) warnings.push('Rel_U/D/L/R 的方向提示由自动布局统一处理；关系起点、终点及标签保持不变。')
  mapStructureSources(sources, boxes, nodes, elements, links, 'c4', groups)
  return finishDiagram('c4', elements, warnings, sources)
}
type Port = 'L' | 'R' | 'T' | 'B'
function port(node: ShapeElement, side: Port): Point {
  return { x: node.x + (side === 'L' ? 0 : side === 'R' ? node.width : node.width / 2), y: node.y + (side === 'T' ? 0 : side === 'B' ? node.height : node.height / 2) }
}
function compileArchitecture(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const boxes = new Map<string, Box>(), groups = new Map<string, Group>(), icons = new Map<string, string>()
  const links: (Link & { fromPort: Port; toPort: Port })[] = []
  for (const entry of lines.slice(1)) {
    const text = entry.text.trim(), line = entry.line; let m: RegExpMatchArray | null
    if ((m = text.match(new RegExp(`^(group|service)\\s+(${ID})(?:\\(([\\w:.-]+)\\))?\\[([^\\[\\]]+)\\](?:\\s+in\\s+(${ID}))?$`, 'u')))) {
      const key = m[2]!
      if (boxes.has(key) || groups.has(key)) fail(`重复的架构标识：${key}。`, line)
      if (m[1] === 'group') { if (groups.size >= 30) fail('架构图最多支持 30 个分组。', line); groups.set(key, { key, title: value(m[4]!, line), parent: m[5], line }) }
      else { const box = addBox(boxes, key, line); box.title = value(m[4]!, line); box.group = m[5]; box.width = 220; box.height = 110; icons.set(key, m[3] ?? 'server') }
      continue
    }
    if ((m = text.match(new RegExp(`^(${ID}):([LRTB])\\s*(<-->|-->|<--|--)\\s*([LRTB]):(${ID})$`, 'u')))) {
      if (links.length >= 240) fail('架构图最多支持 240 条连接。', line)
      links.push({ a: m[1]!, fromPort: m[2] as Port, op: m[3]!, toPort: m[4] as Port, b: m[5]!, label: '', line }); continue
    }
    fail('不支持此架构语法。支持 group/service id(icon)[名称] in group 和 A:R --> L:B；junction、边界端口暂不支持。', line)
  }
  if (!boxes.size) fail('架构图至少需要一个 service。', lines[0]!.line)
  for (const group of groups.values()) {
    const visited = new Set<string>([group.key]); let parent = group.parent
    while (parent) {
      if (!groups.has(parent)) fail(`架构分组 ${parent} 未定义。`, group.line)
      if (visited.has(parent)) fail('架构分组不能循环包含。', group.line)
      visited.add(parent); parent = groups.get(parent)!.parent
    }
  }
  for (const box of boxes.values()) if (box.group && !groups.has(box.group)) fail(`服务 ${box.key} 的分组 ${box.group} 未定义。`, box.line)
  for (const link of links) if (!boxes.has(link.a) || !boxes.has(link.b)) fail('架构连接引用了未定义的 service。', link.line)
  const bounds = groupedLayout(boxes, groups)
  const elements: SceneElement[] = groupElements(groups, 'architecture', bounds), nodes = new Map<string, ShapeElement>()
  for (const box of boxes.values()) {
    const icon = icons.get(box.key)!, local = /database|postgres|mysql|redis|disk/i.test(icon) ? 'cylinder' : /cloud/i.test(icon) ? 'cloud' : 'rectangle', id = `architecture-${nodes.size}`
    const node = diagramNode(id, `${box.title}\n[${icon}]`, box.x, box.y, box.width, box.height, local, { fill: '#eff6ff', stroke: '#1e40af', fontSize: 14 })
    elements.push(node); nodes.set(box.key, node)
  }
  links.forEach((link, i) => {
    const reverse = link.op === '<--', a = nodes.get(reverse ? link.b : link.a)!, b = nodes.get(reverse ? link.a : link.b)!
    // Explicit unbound endpoints preserve the requested L/R/T/B ports exactly.
    elements.push(diagramEdge(`architecture-edge-${i}`, port(a, reverse ? link.toPort : link.fromPort), port(b, reverse ? link.fromPort : link.toPort), '', { arrow: link.op === '--' ? 'none' : link.op === '<-->' ? 'both' : 'end', route: 'orthogonal' }))
  })
  mapStructureSources(sources, boxes, nodes, elements, links, 'architecture', groups)
  return finishDiagram('architecture', elements, ['架构图标使用本地基础图形与图标名称，不下载远程 logos；端口连接保留精确 L/R/T/B 坐标，转换为画布后为自由端点。'], sources)
}
export function compileStructureDiagram(source: string): DiagramResult | undefined {
  const lines = sourceLines(source), header = lines[0]?.text.trim() ?? ''
  const kind = header.split(/\s/)[0]
  if (!['classDiagram', 'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'gitGraph', 'gitGraph:', 'requirementDiagram', 'C4Context', 'architecture-beta'].includes(kind!)) return undefined
  if (lines.length > 1200) fail('此类图表最多支持 1,200 行有效语句。', lines[1200]!.line)
  if (kind === 'gitGraph' || kind === 'gitGraph:') return compileGit(lines)
  if (header !== kind) fail('图表标题后不支持额外参数，请把指令另起一行。', lines[0]!.line)
  if (kind === 'classDiagram') return compileClass(lines)
  if (kind === 'stateDiagram' || kind === 'stateDiagram-v2') return compileState(lines)
  if (kind === 'erDiagram') return compileER(lines)
  if (kind === 'requirementDiagram') return compileRequirement(lines)
  if (kind === 'C4Context') return compileC4(lines)
  return compileArchitecture(lines)
}
export const STRUCTURAL_TEMPLATES: DiagramTemplate[] = [
  { kind: 'class', id: 'class-order-domain', title: '订单领域类图', description: '属性、方法、接口、继承与组合关系', category: '软件建模', source: `classDiagram
direction LR
class Customer["客户"] {
  +String id
  +String name
  +placeOrder() Order
}
class Order["订单"] {
  +String id
  +Decimal total
  +pay() bool
}
class Payment {
  <<interface>>
  +pay(amount) bool
}
class CardPayment {
  +String token
  +pay(amount) bool
}
class LineItem {
  +String product
  +int quantity
}
Customer "1" --> "*" Order : 下单
Order "1" *-- "1..*" LineItem : 包含
Order ..> Payment : 调用
Payment <|.. CardPayment : 实现` },
  { kind: 'state', id: 'state-order-lifecycle', title: '订单状态机', description: '起终点、条件分支与重试转移', category: '软件建模', source: `stateDiagram-v2
direction LR
state "待支付" as Pending
state "支付中" as Paying
state Decision <<choice>>
state "已完成" as Done
state "已取消" as Cancelled
[*] --> Pending
Pending --> Paying : 支付
Pending --> Cancelled : 取消
Paying --> Decision : 返回结果
Decision --> Done : 成功
Decision --> Pending : 失败重试
Done --> [*]
Cancelled --> [*]` },
  { kind: 'er', id: 'er-commerce', title: '电商实体关系', description: '实体属性、主外键与零到多基数', category: '数据建模', source: `erDiagram
direction LR
CUSTOMER {
  string id PK
  string name "姓名"
  string email UK
}
ORDER {
  string id PK
  string customer_id FK
  decimal total
}
ORDER_ITEM {
  string order_id PK, FK
  string product_id PK, FK
  int quantity
}
PRODUCT {
  string id PK
  string name
  decimal price
}
CUSTOMER ||--o{ ORDER : places
ORDER ||--|{ ORDER_ITEM : contains
PRODUCT ||..o{ ORDER_ITEM : appears_in` },
  { kind: 'gitgraph', id: 'git-feature-release', title: '分支开发与发布', description: '提交、功能分支、双亲合并与版本标签', category: '软件建模', source: `gitGraph LR:
commit id: "init"
branch develop
commit id: "setup"
branch feature
commit id: "feature-ui" type: HIGHLIGHT
checkout develop
commit id: "fix"
merge feature id: "merge-feature"
checkout main
merge develop id: "release" tag: "v1.0"
commit id: "revert" type: REVERSE` },
  { kind: 'requirement', id: 'requirement-account', title: '账户需求追踪', description: '需求字段、分解关系与测试验证', category: '软件建模', source: `requirementDiagram
requirement account {
  id: R-1
  text: 系统应提供完整的账户管理能力
  risk: high
  verifymethod: test
}
functionalRequirement login {
  id: R-1.1
  text: 用户可通过邮箱和密码登录
  risk: medium
  verifymethod: test
}
functionalRequirement registration {
  id: R-1.2
  text: 用户可以注册并验证邮箱
  risk: medium
  verifymethod: demonstration
}
element test_suite {
  type: automated test
  docref: tests/account
}
account - contains -> login
account - contains -> registration
test_suite - verifies -> login` },
  { kind: 'c4', id: 'c4-shop-context', title: '商城系统上下文', description: '人物、系统、外部依赖和系统边界', category: '系统架构', source: `C4Context
title 商城系统上下文
Person(customer, "顾客", "浏览商品并下单")
Person(admin, "运营人员", "维护商品与处理订单")
System_Boundary(shop, "商城边界") {
  System(web, "商城系统", "提供商品、购物车和订单服务")
  SystemDb(database, "业务数据库", "存储订单与商品")
}
System_Ext(payment, "支付平台", "处理第三方支付")
Rel(customer, web, "浏览、下单", "HTTPS")
Rel(admin, web, "管理商品")
Rel(web, database, "读写数据")
Rel(web, payment, "创建支付")` },
  { kind: 'architecture', id: 'architecture-services', title: '服务分层架构', description: '真实分组与 L/R/T/B 端口连接', category: '系统架构', source: `architecture-beta
group api(cloud)[应用服务]
group data(database)[数据服务]
service frontend(server)[前端应用] in api
service backend(server)[业务服务] in api
service auth(server)[身份认证] in api
service storage(database)[业务数据] in data
service cache(disk)[缓存服务] in data
frontend:R --> L:backend
backend:R --> L:auth
backend:B --> T:storage
backend:B --> T:cache` },
]
