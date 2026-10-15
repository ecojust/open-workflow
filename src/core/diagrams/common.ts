import { DEFAULT_STYLE, type ElementStyle, type Endpoint, type Scene, type SceneElement, type ShapeElement, type EdgeElement, type Point } from '../types.ts'
import { validateScene } from '../documents.ts'

export type DiagramKind = 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'gitgraph' | 'pie' | 'gantt' | 'xychart' | 'quadrant' | 'mindmap' | 'timeline' | 'journey' | 'kanban' | 'requirement' | 'c4' | 'architecture' | 'sankey' | 'radar' | 'treemap' | 'block' | 'packet'
export interface DiagramResult { kind: DiagramKind; scene: Scene; warnings: string[] }
export interface DiagramTemplate { kind?: DiagramKind; id: string; title: string; description: string; category: string; source: string }
export interface SourceLine { text: string; line: number }
export class DiagramSyntaxError extends Error {
  readonly line: number
  readonly column: number
  constructor(message: string, line: number, column = 1) {
    super(`第 ${line} 行${column > 1 ? `，第 ${column} 列` : ''}：${message}`)
    this.name = 'DiagramSyntaxError'; this.line = line; this.column = column
  }
}
export function sourceLines(source: string): SourceLine[] {
  if (source.length > 200_000) throw new DiagramSyntaxError('源码不能超过 200,000 个字符。', 1)
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map((text, index) => ({ text: text.trimEnd(), line: index + 1 })).filter(({ text }) => text.trim() && !/^\s*%%(?!\{)/.test(text))
}
export function diagramStyle(changes: Partial<ElementStyle> = {}): ElementStyle {
  const pattern = changes.strokePattern ?? (changes.dashed ? 'dashed' : 'solid')
  return { ...DEFAULT_STYLE, ...changes, strokePattern: pattern, dashed: pattern !== 'solid' }
}
export function diagramNode(id: string, text: string, x: number, y: number, width: number, height: number, shape: ShapeElement['shape'] = 'rectangle', style: Partial<ElementStyle> = {}): ShapeElement {
  return { id, type: 'shape', shape, x, y, width, height, text, style: diagramStyle(style), locked: false }
}
export function diagramText(id: string, text: string, x: number, y: number, width: number, height: number, style: Partial<ElementStyle> = {}): ShapeElement {
  return diagramNode(id, text, x, y, width, height, 'text', { fill: 'none', fontSize: 14, ...style })
}
export function diagramEdge(id: string, from: Endpoint, to: Endpoint, label = '', options: { arrow?: EdgeElement['arrow']; route?: EdgeElement['route']; style?: Partial<ElementStyle> } = {}): EdgeElement {
  return { id, type: 'edge', from: { ...from }, to: { ...to }, label, arrow: options.arrow ?? 'end', route: options.route ?? 'straight', style: diagramStyle({ fill: 'none', ...options.style }), locked: false }
}
export function diagramStroke(id: string, points: Point[], style: Partial<ElementStyle> = {}, closed = false): SceneElement {
  return { id, type: 'stroke', points: points.map(point => ({ ...point })), style: diagramStyle({ fill: 'none', ...style }), locked: false, ...(closed ? { closed: true } : {}) }
}
export function finishDiagram(kind: DiagramKind, elements: SceneElement[], warnings: string[] = []): DiagramResult {
  if (elements.length > 3500) throw new DiagramSyntaxError('图表过于复杂，请减少节点或数据。', 1)
  return { kind, scene: validateScene({ elements, background: '#ffffff', grid: false }), warnings: [...new Set(warnings)] }
}
