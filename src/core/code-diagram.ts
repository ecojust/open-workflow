import { DiagramSyntaxError, type DiagramResult } from './diagrams/common.ts'
import { compileStructureDiagram } from './diagrams/structure.ts'
import { compileChartDiagram } from './diagrams/charts.ts'
import { compilePlanningDiagram } from './diagrams/planning.ts'
import { DEFAULT_STYLE, type EdgeElement, type ElementStyle, type Scene, type SceneElement, type ShapeElement } from './types.ts'
import { layoutScene } from './layout.ts'

/** Compile the supported diagram language into our editable scene model. */
export type CodeDiagramResult = DiagramResult
export { DiagramSyntaxError } from './diagrams/common.ts'
interface Statement { text: string; line: number }
const MAX_NODES = 400, MAX_EDGES = 800
const ID = '[A-Za-z0-9_\\u0080-\\uFFFF]+(?:[-.][A-Za-z0-9_\\u0080-\\uFFFF]+)*'
const idAtStart = new RegExp(`^${ID}`)
const fail = (message: string, statement: Statement, column = 1): never => { throw new DiagramSyntaxError(message, statement.line, column) }
const style = (changes: Partial<ElementStyle> = {}): ElementStyle => ({ ...DEFAULT_STYLE, ...changes, strokePattern: changes.strokePattern ?? (changes.dashed ? 'dashed' : 'solid') })

/** Semicolons/comments are separators only outside labels, preserving their original line numbers. */
function statements(source: string): Statement[] {
  const result: Statement[] = []
  let text = '', line = 1, startLine = 1, quote = '', escaped = false, hasContent = false
  const brackets: string[] = []
  const flush = () => { const value = text.trim(); if (value) result.push({ text: value, line: startLine }); text = ''; startLine = line; hasContent = false }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (!hasContent && !/\s/.test(c)) { startLine = line; hasContent = true }
    if (quote) {
      text += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = ''
      if (c === '\n') line++
      continue
    }
    if (c === '"') { quote = c; text += c; continue }
    if (c === '%' && source[i + 1] === '%' && !brackets.length) {
      if (source[i + 2] === '{') throw new DiagramSyntaxError('暂不支持图表初始化指令。', line)
      while (i < source.length && source[i] !== '\n') i++
      flush(); line++; startLine = line; continue
    }
    if (c === '\n') {
      if (brackets.length) throw new DiagramSyntaxError('节点标签未闭合；换行请写为 <br/> 或 \\n。', startLine)
      flush(); line++; startLine = line; continue
    }
    if (c === ';' && !brackets.length) { flush(); continue }
    if ('[({'.includes(c)) brackets.push(c)
    else if ('])}'.includes(c)) {
      const open = brackets.pop()
      if (open !== ({ ']': '[', ')': '(', '}': '{' } as Record<string, string>)[c]) {
        throw new DiagramSyntaxError(`不匹配的括号“${c}”。`, line)
      }
    }
    text += c
  }
  if (quote) throw new DiagramSyntaxError('字符串缺少结束引号。', startLine)
  if (brackets.length) throw new DiagramSyntaxError('节点标签缺少结束括号。', startLine)
  flush()
  return result
}

function labelText(value: string, warnings: Set<string>, statement?: Statement): string {
  let label = value.trim()
  if (label.startsWith('"') && label.endsWith('"')) label = label.slice(1, -1)
  label = label.replace(/\\([n"\\])/g, (_, character: string) => character === 'n' ? '\n' : character)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/&quot;|#quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  if (/<[^>]+>/.test(label)) warnings.add('HTML 标签按纯文本显示；不执行 HTML 或脚本。')
  if (label.length > 2_000) throw new DiagramSyntaxError('单个标签不能超过 2,000 个字符。', statement?.line ?? 1)
  return label
}
function shape(id: string, text: string, kind: ShapeElement['shape'], x = 0, y = 0, width?: number, height?: number): ShapeElement {
  const lines = text.split('\n'), length = Math.max(1, ...lines.map(line => [...line].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : .58), 0)))
  const nodeWidth = width ?? Math.min(340, Math.max(kind === 'diamond' ? 180 : 150, length * 16 + 44))
  const contentWidth = kind === 'diamond' ? nodeWidth * .58 : nodeWidth - 30
  const contentLines = lines.reduce((n, line) => n + Math.max(1, Math.ceil([...line].reduce((sum, c) => sum + (c.charCodeAt(0) > 255 ? 1 : .58), 0) * 16 / contentWidth)), 0)
  return { id, type: 'shape', shape: kind, x, y, width: nodeWidth, height: height ?? Math.max(kind === 'diamond' ? 100 : 64, contentLines * 24 + 28), text, locked: false,
    style: style({ fill: kind === 'diamond' ? '#fff7dc' : kind === 'ellipse' ? '#e8f7ef' : kind === 'note' ? '#fff3b0' : '#eff6ff' }) }
}

interface NodeToken { id: string; text?: string; shape?: ShapeElement['shape']; end: number }
function readNode(statement: Statement, offset: number, warnings: Set<string>): NodeToken {
  const text = statement.text
  let cursor = offset
  while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++
  const match = text.slice(cursor).match(idAtStart)
  if (!match) fail('这里需要节点标识，例如 A[开始]。', statement, cursor + 1)
  const id = match![0]; cursor += id.length
  while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++
  const forms: [string, string, ShapeElement['shape'], string?][] = [
    ['((', '))', 'ellipse'], ['([', '])', 'ellipse', '体育场形节点以椭圆表示。'],
    ['[[', ']]', 'rectangle', '子流程节点以普通矩形表示。'], ['{{', '}}', 'diamond', '六边形节点以菱形表示。'],
    ['[', ']', 'rectangle'], ['(', ')', 'rectangle'], ['{', '}', 'diamond'],
  ]
  const form = forms.find(([open]) => text.startsWith(open, cursor))
  if (!form) return { id, end: cursor }
  const [open, close, kind, warning] = form
  const start = cursor + open.length
  cursor = start
  let quoted = false, escaped = false
  while (cursor < text.length) {
    const c = text[cursor]!
    if (!quoted && text.startsWith(close, cursor)) {
      const value = text.slice(start, cursor)
      if (!value.trim()) fail('节点标签不能为空。', statement, start + 1)
      if (warning) warnings.add(warning)
      return { id, shape: kind, text: labelText(value, warnings, statement), end: cursor + close.length }
    }
    if (escaped) escaped = false
    else if (c === '\\' && quoted) escaped = true
    else if (c === '"') quoted = !quoted
    else if (!quoted && /[\[\]{}()]/.test(c)) fail('标签含括号时请用双引号包围。', statement, cursor + 1)
    cursor++
  }
  return fail(`节点标签缺少“${close}”。`, statement, start + 1)
}

interface ArrowToken { end: number; arrow: EdgeElement['arrow']; dashed: boolean; thick: boolean; label: string }
function readArrow(statement: Statement, offset: number, warnings: Set<string>): ArrowToken {
  const rest = statement.text.slice(offset).trimStart(), start = statement.text.length - rest.length
  const direct = rest.match(/^(<-->|<==>|<-.->|-->|---|==>|===|-\.->|-\.-)/)
  let token: string, label = '', end: number
  if (direct) { token = direct[0]; end = start + token.length }
  else {
    const labelled = rest.match(/^(--|==|-\.)\s+(.+?)\s+(-->|---|==>|===|\.->|\.-)/)
    if (!labelled) return fail('不支持此连线或语法。支持 -->、---、-.->、==>、<--> 与带标签连线。', statement, start + 1)
    const head = labelled[1]!, tail = labelled[3]!
    if ((head === '--' && !tail.startsWith('--')) || (head === '==' && !tail.startsWith('==')) || (head === '-.' && !tail.startsWith('.'))) {
      return fail('连线两端的线型必须一致。', statement, start + 1)
    }
    token = head + tail; label = labelText(labelled[2]!, warnings, statement); end = start + labelled[0].length
  }
  while (/\s/.test(statement.text[end] || '') && end < statement.text.length) end++
  if (statement.text[end] === '|') {
    if (label) fail('一条连线只能使用一个标签。', statement, end + 1)
    let cursor = end + 1, quoted = false, escaped = false
    for (; cursor < statement.text.length; cursor++) {
      const c = statement.text[cursor]!
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c === '"') quoted = !quoted
      if (c === '|' && !quoted) break
    }
    if (cursor === statement.text.length) fail('连线标签缺少结束的 |。', statement, end + 1)
    label = labelText(statement.text.slice(end + 1, cursor), warnings, statement); end = cursor + 1
  }
  return { end, label, arrow: token.startsWith('<') ? 'both' : token.endsWith('>') ? 'end' : 'none', dashed: token.includes('.'), thick: token.includes('=') }
}

function compileFlow(statements: Statement[], direction: 'TB' | 'LR' | 'RL' | 'BT'): CodeDiagramResult {
  const nodes = new Map<string, ShapeElement>(), edges: EdgeElement[] = [], warnings = new Set<string>()
  const addNode = (token: NodeToken, statement: Statement) => {
    const old = nodes.get(token.id)
    if (token.shape || !old) nodes.set(token.id, shape(`m-node-${token.id}`, token.text ?? token.id, token.shape ?? 'rectangle'))
    if (nodes.size > MAX_NODES) fail(`节点不能超过 ${MAX_NODES} 个。`, statement)
  }
  for (const statement of statements) {
    if (/^(?:subgraph|end|direction|style|classDef|class|click|linkStyle)\b/.test(statement.text)) {
      fail('当前版本不支持分组、样式指令或交互指令；请使用节点和连线语法。', statement)
    }
    let node = readNode(statement, 0, warnings); addNode(node, statement)
    let cursor = node.end
    while (statement.text.slice(cursor).trim()) {
      const arrow = readArrow(statement, cursor, warnings), next = readNode(statement, arrow.end, warnings)
      addNode(next, statement)
      edges.push({ id: `m-edge-${edges.length}`, type: 'edge', from: { nodeId: `m-node-${node.id}`, x: 0, y: 0 }, to: { nodeId: `m-node-${next.id}`, x: 0, y: 0 },
        label: arrow.label, arrow: arrow.arrow, route: 'orthogonal', style: style({ dashed: arrow.dashed, strokeWidth: arrow.thick ? 4 : 2 }), locked: false })
      if (edges.length > MAX_EDGES) fail(`连线不能超过 ${MAX_EDGES} 条。`, statement)
      node = next; cursor = next.end
    }
  }
  if (!nodes.size) throw new DiagramSyntaxError('请至少添加一个节点，例如 A[开始] --> B[结束]。', 2)
  return { kind: 'flowchart', scene: layoutScene({ elements: [...edges, ...nodes.values()], background: '#ffffff', grid: true }, direction), warnings: [...warnings] }
}

interface Participant { id: string; name: string; actor: boolean }
type SequenceItem = { type: 'message'; from: string; to: string; text: string; dashed: boolean; arrow: EdgeElement['arrow']; number?: number }
  | { type: 'note'; side: 'left of' | 'right of' | 'over'; ids: string[]; text: string }
function compileSequence(statements: Statement[]): CodeDiagramResult {
  const participants = new Map<string, Participant>(), items: SequenceItem[] = [], warnings = new Set<string>()
  let number: number | undefined, increment = 1
  const ensure = (id: string, statement: Statement) => {
    if (!participants.has(id)) participants.set(id, { id, name: id, actor: false })
    if (participants.size > 40) fail('时序图最多支持 40 个参与者。', statement)
  }
  for (const statement of statements) {
    const declaration = statement.text.match(new RegExp(`^(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`))
    if (declaration) {
      ensure(declaration[2]!, statement)
      participants.set(declaration[2]!, { id: declaration[2]!, name: labelText(declaration[3] ?? declaration[2]!, warnings, statement), actor: declaration[1] === 'actor' })
      continue
    }
    const auto = statement.text.match(/^autonumber(?:\s+(\d+)(?:\s+(\d+))?)?$/)
    if (auto) { number = Number(auto[1] ?? 1); increment = Number(auto[2] ?? 1); if (!increment || number > 1_000_000 || increment > 1_000_000) fail('编号和步长必须在 1,000,000 以内，步长必须大于 0。', statement); continue }
    const note = statement.text.match(new RegExp(`^Note\\s+(left of|right of|over)\\s+(${ID})(?:\\s*,\\s*(${ID}))?\\s*:\\s*(.+)$`, 'i'))
    if (note) {
      const side = note[1]!.toLowerCase() as 'left of' | 'right of' | 'over'
      if (side !== 'over' && note[3]) fail('left of / right of 注释只能指定一个参与者。', statement)
      const ids = [note[2]!, ...(note[3] ? [note[3]] : [])]; ids.forEach(id => ensure(id, statement))
      items.push({ type: 'note', side, ids, text: labelText(note[4]!, warnings, statement) })
      if (items.length > MAX_EDGES) fail(`时序图最多支持 ${MAX_EDGES} 个事件。`, statement)
      continue
    }
    const message = statement.text.match(new RegExp(`^(${ID})\\s*(<<-->>|<<->>|-->>|->>|-->|->)\\s*(${ID})\\s*:\\s*(.*)$`))
    if (message) {
      ensure(message[1]!, statement); ensure(message[3]!, statement)
      items.push({ type: 'message', from: message[1]!, to: message[3]!, dashed: message[2]!.includes('--'), arrow: message[2]!.startsWith('<') ? 'both' : 'end', text: labelText(message[4]!, warnings, statement), number })
      if (message[2]!.includes('>>')) warnings.add('时序图消息箭头统一显示为开放式箭头。')
      if (number !== undefined) number += increment
      if (items.length > MAX_EDGES) fail(`时序图最多支持 ${MAX_EDGES} 个事件。`, statement)
      continue
    }
    fail('暂不支持此时序语法。支持 participant、actor、消息箭头、Note 和 autonumber；暂不支持激活区、循环和条件分组。', statement)
  }
  if (!participants.size) throw new DiagramSyntaxError('请添加参与者或消息，例如 Alice->>Bob: 你好。', 2)
  const elements: SceneElement[] = [], list = [...participants.values()], centers = new Map(list.map((person, i) => [person.id, 160 + i * 260]))
  let y = 150, counter = 0
  const edge = (x1: number, y1: number, x2: number, y2: number, dashed: boolean, arrow: EdgeElement['arrow']) => {
    elements.push({ id: `m-seq-edge-${counter++}`, type: 'edge', from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, label: '', arrow, route: 'straight', style: style({ dashed }), locked: false })
  }
  for (const item of items) {
    if (item.type === 'note') {
      const first = centers.get(item.ids[0]!)!, last = centers.get(item.ids[1] ?? item.ids[0]!)!, width = item.ids.length === 2 ? Math.abs(last - first) + 160 : 190
      const note = shape(`m-seq-note-${counter++}`, item.text, 'note', item.side === 'left of' ? first - width - 16 : item.side === 'right of' ? first + 16 : Math.min(first, last) - width / 2 + Math.abs(last - first) / 2, y - 12, width)
      elements.push(note); y += note.height + 35; continue
    }
    const from = centers.get(item.from)!, to = centers.get(item.to)!, self = from === to
    const label = shape(`m-seq-label-${counter++}`, `${item.number === undefined ? '' : `${item.number}. `}${item.text}`, 'text', Math.min(from, to) + (self ? 18 : 8), y - 16, self ? 190 : Math.max(180, Math.abs(to - from) - 16))
    label.height = Math.max(36, item.text.split('\n').length * 24 + Math.ceil(item.text.length * 10 / label.width) * 22)
    label.style = style({ fill: 'none', strokeWidth: 0, textAlign: self ? 'left' : 'center' })
    const messageY = y + label.height - 10
    elements.push(label)
    if (self) {
      edge(from, messageY, from + 76, messageY, item.dashed, 'none')
      edge(from + 76, messageY, from + 76, messageY + 32, item.dashed, 'none')
      edge(from + 76, messageY + 32, from, messageY + 32, item.dashed, item.arrow)
      y = messageY + 82
    } else { edge(from, messageY, to, messageY, item.dashed, item.arrow); y = messageY + 58 }
  }
  const headers: SceneElement[] = [], lifelines: SceneElement[] = []
  for (const person of list) {
    const center = centers.get(person.id)!
    lifelines.push({ id: `m-seq-life-${person.id}`, type: 'edge', from: { x: center, y: 112 }, to: { x: center, y: y + 16 }, label: '', arrow: 'none', route: 'straight', style: style({ dashed: true, stroke: '#94a3b8', strokeWidth: 1 }), locked: false })
    if (person.actor) {
      const head = shape(`m-seq-head-${person.id}`, '', 'ellipse', center - 12, 16, 24, 24); head.style = style({ fill: '#ffffff' }); headers.push(head)
      for (const [index, points] of [ [{ x: center, y: 40 }, { x: center, y: 69 }], [{ x: center - 23, y: 51 }, { x: center + 23, y: 51 }], [{ x: center - 19, y: 88 }, { x: center, y: 69 }, { x: center + 19, y: 88 }] ].entries()) headers.push({ id: `m-seq-actor-${person.id}-${index}`, type: 'stroke', points, style: style({ fill: 'none' }), locked: false })
      const name = shape(`m-seq-name-${person.id}`, person.name, 'text', center - 100, 88, 200, 28); name.style = style({ fill: 'none' }); headers.push(name)
    } else headers.push(shape(`m-seq-participant-${person.id}`, person.name, 'rectangle', center - 90, 40, 180, 64))
    headers.push(shape(`m-seq-footer-${person.id}`, person.name, 'rectangle', center - 90, y + 16, 180, 56))
  }
  return { kind: 'sequence', scene: { elements: [...lifelines, ...elements, ...headers], background: '#ffffff', grid: false }, warnings: [...warnings] }
}

export function compileCodeDiagram(source: string): CodeDiagramResult {
  if (typeof source !== 'string') throw new DiagramSyntaxError('源码必须是文本。', 1)
  if (source.length > 200_000) throw new DiagramSyntaxError('源码不能超过 200,000 个字符。', 1)
  // Sequence message text may contain punctuation/brackets, so only flowcharts use bracket-aware splitting.
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const first = normalized.split('\n').find(line => line.trim() && !/^\s*%%(?!\{)/.test(line))?.trim()
  if (!first) throw new DiagramSyntaxError('请输入图表源码，或从模板库选择一种图表。', 1)
  const extended = compileStructureDiagram(normalized) ?? compileChartDiagram(normalized) ?? compilePlanningDiagram(normalized)
  if (extended) return extended
  if (first === 'sequenceDiagram' || /^sequenceDiagram\s*%%(?!\{)/.test(first)) {
    const lines: Statement[] = []
    normalized.split('\n').forEach((line, index) => {
      if (/^\s*%%\{/.test(line)) throw new DiagramSyntaxError('暂不支持图表初始化指令。', index + 1)
      if (line.trim() && !/^\s*%%/.test(line)) lines.push({ text: line.trim(), line: index + 1 })
    })
    return compileSequence(lines.slice(1))
  }
  const parts = statements(normalized), header = parts.shift()
  if (!header) throw new DiagramSyntaxError('请添加图表类型。', 1)
  const flow = header.text.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)$/)
  if (!flow) fail('不支持此图表声明，请从图表模板库选择支持的类型。', header)
  return compileFlow(parts, flow![1] === 'TD' ? 'TB' : flow![1] as 'TB' | 'LR' | 'RL' | 'BT')
}
