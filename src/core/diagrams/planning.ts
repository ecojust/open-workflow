import type { SceneElement, ShapeElement } from '../types.ts'
import {
  DiagramSyntaxError, DiagramSourceMap, diagramEdge, diagramNode, diagramStroke, diagramText, finishDiagram, sourceLines,
  type DiagramResult, type DiagramTemplate, type SourceLine,
} from './common.ts'

const COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#cffafe']
const INKS = ['#2563eb', '#15803d', '#b45309', '#be185d', '#7c3aed', '#0e7490']
const ID = '[\\p{L}\\p{N}_-]+'
function fail(message: string, line: number): never { throw new DiagramSyntaxError(message, line) }

function content(line: SourceLine): string {
  let quote = ''; let escaped = false
  for (let index = 0; index < line.text.length; index++) {
    const char = line.text[index]!
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || (char === "'" && !/[\p{L}\p{N}]/u.test(line.text[index - 1] ?? ''))) { quote = char; continue }
    if (line.text.slice(index, index + 3) === '%%{') return line.text
    if (line.text.slice(index, index + 2) === '%%') {
      const parsed = line.text.slice(0, index).trimEnd()
      line.end = line.start + parsed.length
      return parsed
    }
  }
  return line.text
}

function label(value: string, line: number): string {
  let result = value.trim()
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) {
    result = result.slice(1, -1).replace(/\\(["'\\])/g, '$1')
  } else if (/^["']/.test(result)) fail('标签的引号必须成对。', line)
  result = result.replace(/<br\s*\/?\s*>/gi, '\n').replace(/\\n/g, '\n')
  if (!result.trim()) fail('标签不能为空。', line)
  if (result.length > 2000) fail('单个标签不能超过 2,000 个字符。', line)
  if (result.startsWith('`') || result.endsWith('`')) fail('暂不支持 Markdown 标签，请使用普通文本及 <br> 换行。', line)
  return result
}

function splitQuoted(value: string, separator: string, line: number): string[] {
  const parts: string[] = []; let current = ''; let quote = ''; let escaped = false
  for (const char of value) {
    if (escaped) { current += char; escaped = false; continue }
    if (char === '\\') { current += char; escaped = true; continue }
    if (quote) { current += char; if (char === quote) quote = ''; continue }
    if (char === '"' || (char === "'" && !/[\p{L}\p{N}]/u.test(current.at(-1) ?? ''))) { quote = char; current += char; continue }
    if (char === separator) { parts.push(current.trim()); current = ''; continue }
    current += char
  }
  if (quote) fail('引号没有闭合。', line)
  parts.push(current.trim()); return parts
}

function indent(line: SourceLine): number {
  if (/^[ \t]*\t/.test(line.text)) fail('缩进请使用空格，暂不支持制表符。', line.line)
  return line.text.length - line.text.trimStart().length
}

function rejectDirective(text: string, line: number): void {
  if (/^(?:%%\{|---$|::|classDef\b|class\s|style\s|click\s|linkStyle\b|direction\b|accTitle\b|accDescr\b)/.test(text)) {
    fail('暂不支持此配置或样式指令；请使用图表的数据语法。', line)
  }
}

function textHeight(text: string, width: number, minimum = 56): number {
  const chars = Math.max(6, Math.floor((width - 28) / 15))
  return Math.max(minimum, text.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / chars)), 0) * 21 + 24)
}

interface Descriptor { explicit?: string; text: string; shape: ShapeElement['shape']; approximate?: boolean }
function descriptor(value: string, line: number, bare = true): Descriptor {
  const forms: [RegExp, ShapeElement['shape']][] = [
    [new RegExp(`^(${ID})?\\(\\((.*)\\)\\)$`, 'u'), 'ellipse'],
    [new RegExp(`^(${ID})?\\{\\{(.*)\\}\\}$`, 'u'), 'hexagon'],
    [new RegExp(`^(${ID})?\\[\\((.*)\\)\\]$`, 'u'), 'cylinder'],
    [new RegExp(`^(${ID})?\\[\\[(.*)\\]\\]$`, 'u'), 'rectangle'],
    [new RegExp(`^(${ID})?\\(\\[(.*)\\]\\)$`, 'u'), 'rectangle'],
    [new RegExp(`^(${ID})?\\[(.*)\\]$`, 'u'), 'rectangle'],
    [new RegExp(`^(${ID})?\\((.*)\\)$`, 'u'), 'rectangle'],
    [new RegExp(`^(${ID})?\\{(.*)\\}$`, 'u'), 'diamond'],
    [new RegExp(`^(${ID})?\\)([^()]*)\\($`, 'u'), 'cloud'],
  ]
  for (const [pattern, shape] of forms) {
    const match = value.match(pattern)
    if (match) {
      const inner = match[2]!.trim()
      if (!/^["']/.test(inner)) {
        const stack: string[] = []; const pairs: Record<string, string> = { ']': '[', ')': '(', '}': '{' }
        for (const char of inner) {
          if ('[({'.includes(char)) stack.push(char)
          else if ('])}'.includes(char) && stack.pop() !== pairs[char]) fail('节点括号未匹配；包含特殊括号的标签可以加引号。', line)
        }
        if (stack.length) fail('节点括号未闭合。', line)
      }
      return { explicit: match[1], text: label(inner, line), shape, approximate: /\[\[|\(\[/.test(value) }
    }
  }
  if (!bare || /[\[\](){}]|:::|::icon/.test(value)) fail('节点语法不受支持或括号未闭合。', line)
  return { text: label(value, line), shape: 'rectangle' }
}

interface TreeNode extends Descriptor { id: string; line: number; indent: number; children: TreeNode[]; weight: number; width: number; height: number; x: number; y: number; color: number }
function mindmap(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const nodes: TreeNode[] = []; const stack: TreeNode[] = []; const explicit = new Set<string>(); const warnings: string[] = []
  for (const entry of lines.slice(1)) {
    const raw = content(entry); if (!raw.trim()) continue
    rejectDirective(raw.trim(), entry.line)
    const level = indent(entry); const data = descriptor(raw.trim(), entry.line)
    if (data.explicit && explicit.has(data.explicit)) fail(`节点 ID「${data.explicit}」重复。`, entry.line)
    if (data.explicit) explicit.add(data.explicit)
    const height = textHeight(data.text, 190)
    const node: TreeNode = { ...data, id: `mindmap-${nodes.length}`, line: entry.line, indent: level, children: [], weight: height + 30, width: 190, height, x: 0, y: 0, color: 0 }
    if (!nodes.length) stack.push(node)
    else {
      if (level <= nodes[0]!.indent) fail('思维导图只能有一个根节点；子节点需要增加缩进。', entry.line)
      if (level <= stack[stack.length - 1]!.indent && !stack.some(parent => parent.indent === level)) fail('减少缩进时必须对齐已有层级。', entry.line)
      while (stack.length && stack[stack.length - 1]!.indent >= level) stack.pop()
      stack[stack.length - 1]!.children.push(node); stack.push(node)
    }
    if (stack.length > 20) fail('思维导图最多支持 20 层。', entry.line)
    sources.add(entry.line, node.id)
    nodes.push(node)
    if (nodes.length > 200) fail('思维导图最多支持 200 个节点。', entry.line)
    if (data.approximate) warnings.push('双边框和体育场形节点显示为矩形，标签及树关系保留。')
  }
  if (!nodes.length) fail('思维导图需要一个根节点。', lines[0]!.line)
  const root = nodes[0]!
  function measure(node: TreeNode): number { node.weight = Math.max(node.height + 30, node.children.reduce((sum, child) => sum + measure(child), 0)); return node.weight }
  measure(root)
  const left: TreeNode[] = []; const right: TreeNode[] = []; let leftWeight = 0; let rightWeight = 0
  root.children.forEach((child, index) => { child.color = index % COLORS.length; if (rightWeight <= leftWeight) { right.push(child); rightWeight += child.weight } else { left.push(child); leftWeight += child.weight } })
  const depth = (node: TreeNode): number => 1 + Math.max(0, ...node.children.map(depth))
  const leftDepth = Math.max(0, ...left.map(depth)); const centerX = 80 + leftDepth * 260 + root.width / 2
  const centerY = 100 + Math.max(root.height, leftWeight, rightWeight) / 2
  root.x = centerX - root.width / 2; root.y = centerY - root.height / 2
  function layout(children: TreeNode[], xDepth: number, side: number, center: number, color?: number): void {
    let cursor = center - children.reduce((sum, child) => sum + child.weight, 0) / 2
    for (const node of children) {
      node.color = color ?? node.color; node.x = centerX + side * xDepth * 260 - node.width / 2; node.y = cursor + node.weight / 2 - node.height / 2
      layout(node.children, xDepth + 1, side, cursor + node.weight / 2, node.color); cursor += node.weight
    }
  }
  layout(left, 1, -1, centerY); layout(right, 1, 1, centerY)
  const elements: SceneElement[] = []
  for (const node of nodes) for (const child of node.children) elements.push(diagramEdge(`mindmap-edge-${child.id}`, { x: node.x + node.width / 2, y: node.y + node.height / 2, nodeId: node.id }, { x: child.x + child.width / 2, y: child.y + child.height / 2, nodeId: child.id }, '', { arrow: 'none', route: 'orthogonal', style: { stroke: INKS[child.color]! } }))
  for (const node of nodes) elements.push(diagramNode(node.id, node.text, node.x, node.y, node.width, node.height, node.shape, { fill: node === root ? '#1e3a8a' : COLORS[node.color]!, stroke: node === root ? '#ffffff' : INKS[node.color]!, strokeWidth: node === root ? 0 : 2, fontSize: node === root ? 20 : 16 }))
  return finishDiagram('mindmap', elements, warnings, sources)
}

interface Period { text: string; events: string[]; eventLines: number[]; section: string; group: number; line: number }
function timeline(lines: SourceLine[], vertical: boolean): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const periods: Period[] = []; let title = ''; let section = ''; let group = 0; let current: Period | undefined; let sectionUsed = true
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue; rejectDirective(raw, entry.line)
    if (/^title\s+/.test(raw)) { if (title || periods.length || section) fail('标题只能在时间轴数据之前声明一次。', entry.line); title = label(raw.slice(6), entry.line); sources.add(entry.line, 'timeline-title'); continue }
    if (/^section\s+/.test(raw)) { if (!sectionUsed) fail('上一个 section 没有时间段。', entry.line); section = label(raw.slice(8), entry.line); sources.add(entry.line, `timeline-section-${periods.length}`); group++; current = undefined; sectionUsed = false; continue }
    const parts = splitQuoted(raw, ':', entry.line)
    if (parts.length < 2) fail('时间轴需要「时间段 : 事件」；续行事件以冒号开头。', entry.line)
    const events = parts.slice(1).map(part => label(part, entry.line))
    if (!parts[0]) { if (!current) fail('续行事件之前需要一个时间段。', entry.line); current.events.push(...events); current.eventLines.push(...events.map(() => entry.line)) }
    else { current = { text: label(parts[0], entry.line), events, eventLines: events.map(() => entry.line), section, group, line: entry.line }; periods.push(current); sectionUsed = true }
    if (periods.length > 80 || periods.reduce((sum, period) => sum + period.events.length, 0) > 240) fail('时间轴最多支持 80 个时间段、240 个事件。', entry.line)
  }
  if (!periods.length || !sectionUsed) fail('时间轴的每个分区至少需要一个时间段。', lines.at(-1)!.line)
  const elements: SceneElement[] = []; const top = title ? 100 : 48
  if (title) elements.push(diagramText('timeline-title', title, 60, 24, vertical ? 900 : Math.max(400, periods.length * 250), 54, { fontSize: 25, textAlign: 'left' }))
  if (vertical) {
    let y = top; let previousGroup: number | undefined
    for (let index = 0; index < periods.length; index++) {
      const period = periods[index]!; const color = period.group % COLORS.length
      if (period.group !== previousGroup && period.section) { elements.push(diagramNode(`timeline-section-${index}`, period.section, 60, y, 900, 44, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 19 })); y += 64 }
      previousGroup = period.group
      const heights = period.events.map(event => textHeight(event, 540)); const height = Math.max(textHeight(period.text, 200), heights.reduce((sum, value) => sum + value + 12, 0))
      elements.push(diagramStroke(`timeline-axis-${index}`, [{ x: 310, y }, { x: 310, y: y + height + 32 }], { stroke: INKS[color]!, strokeWidth: 3 }))
      elements.push(diagramNode(`timeline-period-${index}`, period.text, 60, y, 210, textHeight(period.text, 210), 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]! }))
      elements.push(diagramNode(`timeline-dot-${index}`, '', 303, y + 22, 14, 14, 'ellipse', { fill: INKS[color]!, strokeWidth: 0 }))
      let eventY = y
      period.events.forEach((event, eventIndex) => { elements.push(diagramNode(`timeline-event-${index}-${eventIndex}`, event, 360, eventY, 540, heights[eventIndex]!, 'rectangle', { fill: '#f8fafc', stroke: INKS[color]!, textAlign: 'left' })); eventY += heights[eventIndex]! + 12 })
      y += height + 32
    }
  } else {
    elements.push(diagramEdge('timeline-axis', { x: 70, y: top + 144 }, { x: 70 + periods.length * 250, y: top + 144 }, '', { style: { stroke: '#64748b', strokeWidth: 3 } }))
    for (let index = 0; index < periods.length; index++) {
      const period = periods[index]!; const color = period.group % COLORS.length; const x = 60 + index * 250
      if (index === 0 || periods[index - 1]!.group !== period.group) {
        let end = index + 1; while (end < periods.length && periods[end]!.group === period.group) end++
        if (period.section) elements.push(diagramNode(`timeline-section-${index}`, period.section, x, top, (end - index) * 250 - 20, 44, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 19 }))
      }
      elements.push(diagramNode(`timeline-period-${index}`, period.text, x, top + 62, 230, 62, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]! }))
      elements.push(diagramNode(`timeline-dot-${index}`, '', x + 108, top + 137, 14, 14, 'ellipse', { fill: INKS[color]!, strokeWidth: 0 }))
      let y = top + 174
      period.events.forEach((event, eventIndex) => { const height = textHeight(event, 230); elements.push(diagramNode(`timeline-event-${index}-${eventIndex}`, event, x, y, 230, height, 'rectangle', { fill: '#f8fafc', stroke: INKS[color]!, textAlign: 'left' })); y += height + 14 })
    }
  }
  periods.forEach((period, index) => {
    sources.add(period.line, `timeline-period-${index}`, `timeline-dot-${index}`, `timeline-axis-${index}`)
    period.eventLines.forEach((line, eventIndex) => sources.add(line, `timeline-event-${index}-${eventIndex}`))
  })
  return finishDiagram('timeline', elements, [], sources)
}

interface JourneyTask { line: number; text: string; score: number; actors: string[]; section: string; group: number }
function journey(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const tasks: JourneyTask[] = []; const actors: string[] = []; let title = ''; let section = ''; let group = 0; let sectionUsed = true
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue; rejectDirective(raw, entry.line)
    if (/^title\s+/.test(raw)) { if (title || tasks.length || section) fail('标题只能在旅程数据之前声明一次。', entry.line); title = label(raw.slice(6), entry.line); sources.add(entry.line, 'journey-title'); continue }
    if (/^section\s+/.test(raw)) { if (!sectionUsed) fail('上一个 section 没有任务。', entry.line); section = label(raw.slice(8), entry.line); sources.add(entry.line, `journey-section-${tasks.length}`); group++; sectionUsed = false; continue }
    const parts = splitQuoted(raw, ':', entry.line)
    if (parts.length !== 3 || !/^[0-5]$/.test(parts[1]!)) fail('旅程任务需要「任务 : 0 到 5 的整数评分 : 参与者, 参与者」。', entry.line)
    const members = splitQuoted(parts[2]!, ',', entry.line).map(value => label(value, entry.line))
    if (new Set(members).size !== members.length) fail('同一任务的参与者不能重复。', entry.line)
    for (const actor of members) if (!actors.includes(actor)) actors.push(actor)
    tasks.push({ line: entry.line, text: label(parts[0]!, entry.line), score: Number(parts[1]), actors: members, section, group }); sectionUsed = true
    if (tasks.length > 80 || actors.length > 16) fail('旅程图最多支持 80 个任务和 16 位参与者。', entry.line)
  }
  if (!tasks.length || !sectionUsed) fail('旅程图的每个分区至少需要一个任务。', lines.at(-1)!.line)
  const elements: SceneElement[] = []; const startX = 210; const step = 210; const width = tasks.length * step; const top = title ? 104 : 48
  if (title) elements.push(diagramText('journey-title', title, 60, 24, Math.max(width, 500), 54, { fontSize: 25, textAlign: 'left' }))
  const taskHeight = Math.max(...tasks.map(task => textHeight(task.text, 186))); const scoreTop = top + 66 + taskHeight + 50; const actorTop = scoreTop + 320
  for (let score = 0; score <= 5; score++) {
    const y = scoreTop + (5 - score) * 48
    elements.push(diagramText(`journey-score-${score}`, `${score}`, 150, y - 14, 40, 28, { fontSize: 14 }))
    elements.push(diagramStroke(`journey-grid-${score}`, [{ x: startX, y }, { x: startX + width, y }], { stroke: '#e2e8f0', strokeWidth: 1 }))
  }
  elements.push(diagramText('journey-score-label', '体验评分', 55, scoreTop + 84, 90, 50))
  actors.forEach((actor, index) => { const y = actorTop + index * 52; elements.push(diagramNode(`journey-lane-${index}`, '', startX, y, width, 46, 'rectangle', { fill: index % 2 ? '#f8fafc' : '#f1f5f9', strokeWidth: 0 })); elements.push(diagramText(`journey-actor-${index}`, actor, 40, y, 160, 46, { textAlign: 'right' })) })
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]!; const x = startX + index * step; const color = task.group % COLORS.length
    if (index === 0 || tasks[index - 1]!.group !== task.group) { let end = index + 1; while (end < tasks.length && tasks[end]!.group === task.group) end++; if (task.section) elements.push(diagramNode(`journey-section-${index}`, task.section, x, top, (end - index) * step - 16, 44, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 19 })) }
    elements.push(diagramNode(`journey-task-${index}`, task.text, x, top + 60, 186, taskHeight, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]! }))
    const cx = x + 93; const cy = scoreTop + (5 - task.score) * 48
    if (index) { const previous = tasks[index - 1]!; elements.push(diagramEdge(`journey-link-${index}`, { nodeId: `journey-rating-${index - 1}`, x: cx - step, y: scoreTop + (5 - previous.score) * 48 }, { nodeId: `journey-rating-${index}`, x: cx, y: cy }, '', { arrow: 'none', style: { stroke: '#64748b' } })) }
    elements.push(diagramNode(`journey-rating-${index}`, `${task.score}/5`, cx - 24, cy - 24, 48, 48, 'ellipse', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 14 }))
    for (const actor of task.actors) { const actorIndex = actors.indexOf(actor); elements.push(diagramNode(`journey-member-${index}-${actorIndex}`, '●', cx - 16, actorTop + actorIndex * 52 + 7, 32, 32, 'ellipse', { fill: COLORS[actorIndex % COLORS.length]!, stroke: INKS[actorIndex % INKS.length]!, fontSize: 16, strokeWidth: 1 })) }
  }
  tasks.forEach((task, index) => sources.add(task.line, `journey-task-${index}`, `journey-rating-${index}`, `journey-link-${index}`, ...task.actors.map(actor => `journey-member-${index}-${actors.indexOf(actor)}`)))
  return finishDiagram('journey', elements, [], sources)
}

interface KanbanCard { text: string; meta: Record<string, string>; line: number }
interface KanbanColumn { line: number; text: string; cards: KanbanCard[] }
function kanban(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const columns: KanbanColumn[] = []; const ids = new Set<string>(); let base: number | undefined; let cardIndent: number | undefined; let cardCount = 0
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue; rejectDirective(raw, entry.line)
    const level = indent(entry); if (base === undefined) base = level
    const metaIndex = raw.indexOf('@{'); let nodeText = raw; const meta: Record<string, string> = {}
    if (metaIndex >= 0) {
      if (!raw.endsWith('}')) fail('卡片 metadata 必须使用 @{ ... }。', entry.line)
      nodeText = raw.slice(0, metaIndex).trim()
      for (const field of splitQuoted(raw.slice(metaIndex + 2, -1), ',', entry.line)) {
        const parts = splitQuoted(field, ':', entry.line)
        if (parts.length !== 2 || !['assigned', 'ticket', 'priority'].includes(parts[0]!)) fail('卡片 metadata 仅支持 assigned、ticket 和 priority。', entry.line)
        const key = parts[0]!; if (Object.hasOwn(meta, key)) fail(`metadata「${key}」重复。`, entry.line)
        meta[key] = label(parts[1]!, entry.line)
        if (key === 'priority' && !['Very High', 'High', 'Low', 'Very Low'].includes(meta[key]!)) fail('priority 仅支持 Very High、High、Low、Very Low。', entry.line)
      }
    }
    const data = descriptor(nodeText, entry.line)
    if (data.shape !== 'rectangle' || data.approximate || new RegExp(`^(?:${ID})?\\(`, 'u').test(nodeText)) fail('看板列与卡片使用普通文本或 id[标签]。', entry.line)
    if (data.explicit) { if (ids.has(data.explicit)) fail(`ID「${data.explicit}」重复。`, entry.line); ids.add(data.explicit) }
    if (level === base) { if (metaIndex >= 0) fail('metadata 只适用于卡片。', entry.line); columns.push({ line: entry.line, text: data.text, cards: [] }) }
    else {
      if (level < base || !columns.length) fail('卡片必须缩进在列下面。', entry.line)
      if (cardIndent === undefined) cardIndent = level
      if (level !== cardIndent) fail('看板只支持列和卡片两层，请对齐卡片缩进。', entry.line)
      columns.at(-1)!.cards.push({ text: data.text, meta, line: entry.line }); cardCount++
    }
    if (columns.length > 12 || cardCount > 120) fail('看板最多支持 12 列和 120 张卡片。', entry.line)
  }
  if (!columns.length) fail('看板至少需要一列。', lines[0]!.line)
  const elements: SceneElement[] = []
  const cardLabel = (card: KanbanCard): string => [card.text, card.meta.assigned && `负责人：${card.meta.assigned}`, card.meta.ticket && `工单：${card.meta.ticket}`, card.meta.priority && `优先级：${card.meta.priority}`].filter(Boolean).join('\n')
  const columnHeight = Math.max(220, ...columns.map(column => 94 + column.cards.reduce((sum, card) => sum + textHeight(cardLabel(card), 248, 84) + 16, 0)))
  columns.forEach((column, index) => {
    const x = 50 + index * 296; const color = index % COLORS.length
    elements.push(diagramNode(`kanban-column-${index}`, '', x, 48, 280, columnHeight, 'rectangle', { fill: '#f1f5f9', stroke: '#e2e8f0', strokeWidth: 1 }))
    elements.push(diagramNode(`kanban-title-${index}`, `${column.text} (${column.cards.length})`, x, 48, 280, 60, 'rectangle', { fill: COLORS[color]!, stroke: INKS[color]!, fontSize: 19 }))
    let y = 128
    column.cards.forEach((card, cardIndex) => { const text = cardLabel(card); const height = textHeight(text, 248, 84); const high = card.meta.priority === 'High' || card.meta.priority === 'Very High'; elements.push(diagramNode(`kanban-card-${index}-${cardIndex}`, text, x + 16, y, 248, height, 'rectangle', { fill: '#ffffff', stroke: high ? '#be123c' : '#475569', strokeWidth: high ? 2 : 1, textAlign: 'left', fontSize: 15 })); y += height + 16 })
  })
  columns.forEach((column, index) => {
    sources.add(column.line, `kanban-column-${index}`, `kanban-title-${index}`)
    column.cards.forEach((card, cardIndex) => sources.add(card.line, `kanban-card-${index}-${cardIndex}`))
  })
  return finishDiagram('kanban', elements, [], sources)
}

interface BlockEntry { id?: string; descriptor?: Descriptor; span: number; line: number }
interface BlockLink { from: string; to: string; label: string; arrow: 'end' | 'both' | 'none'; line: number }
function blockTokens(raw: string, line: number): string[] {
  const tokens: string[] = []; let current = ''; let quote = ''; let escaped = false; const brackets: string[] = []
  const closes: Record<string, string> = { ']': '[', ')': '(', '}': '{' }
  for (const char of raw) {
    if (escaped) { current += char; escaped = false; continue }
    if (char === '\\') { current += char; escaped = true; continue }
    if (quote) { current += char; if (char === quote) quote = ''; continue }
    if (char === '"' || (char === "'" && !/[\p{L}\p{N}]/u.test(current.at(-1) ?? ''))) { current += char; quote = char; continue }
    if ('[({'.includes(char)) brackets.push(char)
    if ('])}'.includes(char) && brackets.pop() !== closes[char]) fail('节点括号未匹配。', line)
    if (/\s/.test(char) && !brackets.length) { if (current) tokens.push(current); current = '' } else current += char
  }
  if (quote || brackets.length) fail('节点的引号或括号未闭合。', line)
  if (current) tokens.push(current); return tokens
}

function block(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const entries: BlockEntry[] = []; const links: BlockLink[] = []; const ids = new Set<string>(); const warnings: string[] = []; let columns: number | undefined; let declaredColumns = false
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue; rejectDirective(raw, entry.line)
    if (/^columns\b/.test(raw)) { if (declaredColumns || entries.length) fail('columns 必须在节点前声明一次。', entry.line); const match = raw.match(/^columns\s+(auto|\d+)$/); if (!match) fail('columns 需要 1 到 12 的整数或 auto。', entry.line); columns = match[1] === 'auto' ? undefined : Number(match[1]); if (columns !== undefined && (columns < 1 || columns > 12)) fail('columns 需要 1 到 12 的整数。', entry.line); declaredColumns = true; continue }
    if (/^(?:block(?::|\s|$)|end$)/.test(raw)) fail('暂不支持嵌套 block；请使用 columns 与跨度排列节点。', entry.line)
    const connection = raw.match(new RegExp(`^(${ID})\\s*(<-->|-->|---)(?:\\|([^|]+)\\|)?\\s*(${ID})$`, 'u'))
    const labeled = raw.match(new RegExp(`^(${ID})\\s*--\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')\\s*-->\\s*(${ID})$`, 'u'))
    if (connection || labeled) {
      links.push(connection ? { from: connection[1]!, to: connection[4]!, label: connection[3] ? label(connection[3], entry.line) : '', arrow: connection[2] === '---' ? 'none' : connection[2] === '<-->' ? 'both' : 'end', line: entry.line } : { from: labeled![1]!, to: labeled![3]!, label: label(labeled![2]!, entry.line), arrow: 'end', line: entry.line }); continue
    }
    let sourceCursor = 0
    const sourceStart = entry.start + entry.text.length - entry.text.trimStart().length
    for (const token of blockTokens(raw, entry.line)) {
      const tokenStart = raw.indexOf(token, sourceCursor); sourceCursor = tokenStart + token.length
      const spanMatch = token.match(/:(\d+)$/); const span = spanMatch ? Number(spanMatch[1]) : 1; const nodeValue = spanMatch ? token.slice(0, spanMatch.index) : token
      if (span < 1 || span > 12 || (columns !== undefined && span > columns)) fail('节点跨度必须在 1 到列数之间，且不超过 12。', entry.line)
      if (nodeValue === 'space') entries.push({ span, line: entry.line })
      else {
        const data = descriptor(nodeValue, entry.line); const id = data.explicit ?? nodeValue
        if (!new RegExp(`^${ID}$`, 'u').test(id)) fail('block 节点必须有 ID，例如 item[标签]。', entry.line)
        if (ids.has(id)) fail(`节点 ID「${id}」重复。`, entry.line); ids.add(id)
        if (data.approximate) warnings.push('双边框和体育场形节点显示为矩形，标签及跨度保留。')
        sources.range(sourceStart + tokenStart, sourceStart + sourceCursor, `block-${id}`)
        entries.push({ id, descriptor: data, span, line: entry.line })
      }
      if (ids.size > 200 || entries.length > 240) fail('block 最多支持 200 个节点和 240 个网格项目。', entry.line)
    }
  }
  if (!ids.size) fail('block 至少需要一个节点。', lines[0]!.line)
  if (links.length > 400) fail('block 最多支持 400 条连线。', lines.at(-1)!.line)
  if (columns === undefined && entries.reduce((sum, entry) => sum + entry.span, 0) > 12) warnings.push('自动列布局每行最多 12 列；可显式设置 columns。')
  columns ??= Math.min(12, entries.reduce((sum, entry) => sum + entry.span, 0))
  const nodes = new Map<string, ShapeElement>(); let col = 0; let row = 0
  const rowHeight = Math.max(110, ...entries.filter(entry => entry.descriptor).map(entry => textHeight(entry.descriptor!.text, entry.span * 184 - 24) + 28))
  for (const entry of entries) {
    if (entry.span > columns) fail('节点跨度不能超过 columns。', entry.line)
    if (col + entry.span > columns) { row++; col = 0 }
    if (entry.id && entry.descriptor) nodes.set(entry.id, diagramNode(`block-${entry.id}`, entry.descriptor.text, 60 + col * 184, 60 + row * rowHeight, entry.span * 184 - 24, rowHeight - 28, entry.descriptor.shape, { fill: COLORS[row % COLORS.length]!, stroke: INKS[row % INKS.length]! }))
    col += entry.span; if (col === columns) { row++; col = 0 }
  }
  const elements: SceneElement[] = []
  links.forEach((link, index) => { const from = nodes.get(link.from); const to = nodes.get(link.to); if (!from || !to) fail('连线引用了未声明的 block 节点。', link.line); elements.push(diagramEdge(`block-edge-${index}`, { nodeId: from.id, x: from.x + from.width / 2, y: from.y + from.height / 2 }, { nodeId: to.id, x: to.x + to.width / 2, y: to.y + to.height / 2 }, link.label, { arrow: link.arrow, route: 'orthogonal' })) })
  links.forEach((link, index) => sources.add(link.line, `block-edge-${index}`))
  elements.push(...nodes.values()); return finishDiagram('block', elements, warnings, sources)
}

interface PacketField { start: number; end: number; text: string; line: number }
function packet(lines: SourceLine[]): DiagramResult {
  const sources = new DiagramSourceMap(lines)
  const fields: PacketField[] = []; let title = ''; let next = 0
  for (const entry of lines.slice(1)) {
    const raw = content(entry).trim(); if (!raw) continue; rejectDirective(raw, entry.line)
    if (/^title\s+/.test(raw)) { if (title || fields.length) fail('标题只能在数据字段之前声明一次。', entry.line); title = label(raw.slice(6), entry.line); sources.add(entry.line, 'packet-title'); continue }
    const match = raw.match(/^(?:(\d+)(?:\s*-\s*(\d+))?|\+(\d+))\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/)
    if (!match) fail('数据字段需要 0-15: "标签"、16: "标签" 或 +8: "标签"。', entry.line)
    const start = match[3] ? next : Number(match[1]); const end = match[3] ? start + Number(match[3]) - 1 : Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > 1023) fail('位范围必须递增，且位于 0 到 1023 之间。', entry.line)
    if (start < next) fail('数据字段不能重叠或倒序。', entry.line)
    fields.push({ start, end, text: label(match[4]!, entry.line), line: entry.line }); next = end + 1
    if (fields.length > 200) fail('packet 最多支持 200 个字段。', entry.line)
  }
  if (!fields.length) fail('packet 至少需要一个位字段。', lines[0]!.line)
  const elements: SceneElement[] = []; const bitWidth = 32; const left = 100; const top = title ? 112 : 56; const rows = Math.ceil(next / 32)
  if (title) elements.push(diagramText('packet-title', title, left, 24, bitWidth * 32, 56, { fontSize: 25, textAlign: 'left' }))
  for (let row = 0; row < rows; row++) {
    const y = top + row * 110
    elements.push(diagramText(`packet-offset-${row}`, `${row * 32}`, 30, y + 30, 60, 56, { textAlign: 'right', fontSize: 13 }))
    elements.push(diagramNode(`packet-row-${row}`, '', left, y + 28, bitWidth * 32, 64, 'rectangle', { fill: '#f8fafc', stroke: '#cbd5e1', strokeWidth: 1 }))
    for (let bit = 0; bit < 32; bit++) elements.push(diagramText(`packet-bit-${row}-${bit}`, `${bit}`, left + bit * bitWidth, y, bitWidth, 24, { fontSize: 10 }))
  }
  fields.forEach((field, index) => {
    const firstElement = elements.length
    for (let row = Math.floor(field.start / 32); row <= Math.floor(field.end / 32); row++) {
      const start = Math.max(field.start, row * 32); const end = Math.min(field.end, row * 32 + 31); const width = (end - start + 1) * bitWidth
      elements.push(diagramNode(`packet-field-${index}-${row}`, field.text, left + (start % 32) * bitWidth, top + row * 110 + 28, width, 64, 'rectangle', { fill: COLORS[index % COLORS.length]!, stroke: INKS[index % INKS.length]!, strokeWidth: 1, fontSize: width < 78 ? 10 : 14 }))
    }
    sources.capture(field.line, elements, firstElement)
  })
  return finishDiagram('packet', elements, [], sources)
}

/** A bounded, native scene compiler; unsupported directives fail with a source line. */
export function compilePlanningDiagram(source: string): DiagramResult | undefined {
  const lines = sourceLines(source); const header = lines[0]?.text.trim()
  if (!header) return undefined
  if (header === 'mindmap') return mindmap(lines)
  if (/^timeline(?:\s+(?:LR|TD))?$/.test(header)) return timeline(lines, /\sTD$/.test(header))
  if (header === 'journey') return journey(lines)
  if (header === 'kanban') return kanban(lines)
  if (/^block(?:-beta)?$/.test(header)) return block(lines)
  if (/^packet(?:-beta)?$/.test(header)) return packet(lines)
  if (/^(?:mindmap|timeline|journey|kanban|block(?:-beta)?|packet(?:-beta)?)(?:\s|$)/.test(header)) fail('图表标题行包含不支持的参数。', lines[0]!.line)
  return undefined
}

export const PLANNING_TEMPLATES: DiagramTemplate[] = [
  { id: 'mindmap', kind: 'mindmap', title: '思维导图', description: '从中心主题展开目标、设计、交付和反馈，支持多级缩进与节点形状。', category: '规划与协作', source: `mindmap
  root((开放工作流))
    goals[目标]
      协作效率
      数据自主
    design(设计)
      canvas{{原生画布}}
        节点与连接
        便签与自由绘制
      code[代码图表]
    delivery[交付]
      原生文件与 SVG
      跨工具导入导出
    feedback(反馈)
      用户试用<br>持续改进` },
  { id: 'timeline', kind: 'timeline', title: '时间轴', description: '用分区、时间段与多个事件记录产品演进。', category: '规划与协作', source: `timeline
  title 产品交付时间轴
  section 发现与设计
    第 1 周 : 用户访谈 : 确定核心场景
    第 2 周 : 交互原型
            : 原型评审与调整
  section 开发与交付
    第 3–4 周 : 画布与文件格式 : 自动化测试
    第 5 周 : 小范围试用<br>收集反馈
    第 6 周 : 正式交付 : 复盘与下一阶段规划` },
  { id: 'journey', kind: 'journey', title: '用户旅程', description: '呈现任务体验评分、阶段与参与者泳道。', category: '规划与协作', source: `journey
  title 从首次使用到团队协作
  section 发现
    了解产品: 4: 用户, 产品经理
    尝试创建画布: 5: 用户
  section 使用
    导入历史文件: 2: 用户, 客服
    完成第一张流程图: 5: 用户
  section 协作
    邀请同事评审: 3: 用户, 同事
    整理改进意见: 4: 用户, 同事, 产品经理` },
  { id: 'kanban', kind: 'kanban', title: '看板', description: '按列组织工作卡片，显示负责人、工单号和优先级。', category: '规划与协作', source: `kanban
  backlog[待办]
    research[梳理用户需求]@{ assigned: '小林', ticket: 'OW-101', priority: 'High' }
    tests[补充格式兼容测试]@{ assigned: '小周', priority: 'Low' }
  doing[进行中]
    canvas[实现原生画布]@{ assigned: '小陈', ticket: 'OW-102', priority: 'Very High' }
    docs[编写使用指南]@{ assigned: '小林' }
  review[待评审]
    prototype[交互原型评审]@{ ticket: 'OW-99' }
  done[已完成]
    scope[确认首版范围]` },
  { id: 'block', kind: 'block', title: '分块布局', description: '显式指定列数、跨列宽度和留白，绘制系统分层结构。', category: '结构与系统', source: `block-beta
  columns 3
  gateway[统一入口]:3
  editor[画布编辑器] compiler[代码编译器] files[文件服务]
  space storage[(本地存储)] space
  gateway --> editor
  gateway --> compiler
  gateway --> files
  editor -- "保存" --> storage
  files --> storage` },
  { id: 'packet', kind: 'packet', title: '数据包', description: '以实际位宽绘制字段，超过 32 位的字段自动拆行。', category: '结构与系统', source: `packet-beta
  title UDP 数据包结构
  0-15: "源端口"
  16-31: "目标端口"
  +16: "数据长度"
  +16: "校验和"
  +48: "应用数据（跨行）"
  +16: "扩展字段"` },
]
