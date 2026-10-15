import type { DiagramStyleId } from './diagram-appearance.ts'

export type DocumentKind = 'flow' | 'board' | 'mermaid'
export interface Point { x: number; y: number }
export interface ElementStyle {
  stroke: string
  fill: string
  strokeWidth: number
  fontSize: number
  textAlign: 'left' | 'center' | 'right'
  opacity: number
  dashed: boolean
  roughness?: 'clean' | 'sketch'
  strokePattern?: 'solid' | 'dashed' | 'dotted'
}
export interface ShapeElement {
  id: string
  type: 'shape'
  shape: 'rectangle' | 'ellipse' | 'diamond' | 'note' | 'text' | 'image' | 'triangle' | 'hexagon' | 'star' | 'parallelogram' | 'cylinder' | 'cloud' | 'frame' | 'brace-left' | 'brace-right' | 'brace-top' | 'brace-bottom'
  x: number
  y: number
  width: number
  height: number
  text: string
  imageData?: string
  style: ElementStyle
  locked: boolean
  groupId?: string
}
export interface Endpoint extends Point { nodeId?: string }
export interface EdgeElement {
  id: string
  type: 'edge'
  from: Endpoint
  to: Endpoint
  label: string
  arrow: 'end' | 'both' | 'none'
  route: 'straight' | 'orthogonal'
  style: ElementStyle
  locked: boolean
  groupId?: string
}
export interface StrokeElement {
  id: string
  type: 'stroke'
  points: Point[]
  closed?: boolean
  style: ElementStyle
  locked: boolean
  groupId?: string
}
export type SceneElement = ShapeElement | EdgeElement | StrokeElement
export interface Scene { elements: SceneElement[]; background: string; grid: boolean; defaultStyle?: ElementStyle }
export interface WorkflowDocument {
  format: 'open-workflow'
  version: 1
  id: string
  title: string
  kind: DocumentKind
  scene: Scene
  /** Source is authoritative; its generated scene is never edited in place. */
  source: string
  /** Presentation only: source remains authoritative and unchanged. */
  diagramStyle?: DiagramStyleId
  createdAt: string
  updatedAt: string
  importSource?: { name: string; format: string; text: string }
}
export interface ImportedScene { title: string; scene: Scene; warnings: string[] }
export interface EditorHandle { flush: () => void | Promise<void> }
export const DEFAULT_STYLE: ElementStyle = {
  stroke: '#334155', fill: '#ffffff', strokeWidth: 2, fontSize: 16,
  textAlign: 'center', opacity: 1, dashed: false, roughness: 'clean', strokePattern: 'solid',
}
export function newId(prefix = 'e'): string { return `${prefix}-${crypto.randomUUID()}` }
export function emptyScene(): Scene { return { elements: [], background: '#ffffff', grid: true, defaultStyle: { ...DEFAULT_STYLE } } }
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
