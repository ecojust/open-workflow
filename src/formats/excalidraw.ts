import { DEFAULT_STYLE, type ElementStyle, type Endpoint, type ImportedScene, type Scene, type SceneElement, type ShapeElement } from '../core/types.ts'
import { edgePoints } from '../core/geometry.ts'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function safeImage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 14 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/\r\n]+={0,2}$/i.test(value)) return false
  const body = value.slice(value.indexOf(',') + 1).replace(/[\r\n]/g, '')
  const bytes = Math.floor(body.length * 3 / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
  return body.length % 4 === 0 && bytes <= 10 * 1024 * 1024
}
const safeText = (value: unknown): string => typeof value === 'string' ? value.slice(0, 100000) : ''

function finite(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7) throw new Error('Excalidraw 图形包含无效或过大的坐标。')
  return value
}

function color(value: unknown, fallback: string, warnings: Set<string>): string {
  if (value === undefined) return fallback
  if (value === 'transparent' || value === 'none') return 'transparent'
  if (typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value
  const names: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00', gray: '#808080', grey: '#808080' }
  if (typeof value === 'string' && Object.hasOwn(names, value.toLowerCase())) return names[value.toLowerCase()]!
  warnings.add('部分颜色格式不受支持，已使用默认颜色。')
  return fallback
}

function styleOf(element: Json, warnings: Set<string>): ElementStyle {
  if (finite(element.angle) !== 0) warnings.add('旋转图形已转为未旋转的图形，位置可能与原图不同。')
  if (Array.isArray(element.groupIds) && element.groupIds.length) warnings.add('分组关系不保留；图形的世界坐标得到保留。')
  if (element.frameId) warnings.add('框架与裁剪关系不保留。')
  if ((typeof element.roughness === 'number' && element.roughness > 0) || (element.fillStyle && element.fillStyle !== 'solid')) warnings.add('手绘抖动和纹理填充已转换为普通线条与纯色填充。')
  if (element.roundness || element.strokeStyle === 'dotted' || element.fontFamily) warnings.add('圆角、点线和字体外观可能与原图不同。')
  return {
    stroke: color(element.strokeColor, DEFAULT_STYLE.stroke, warnings),
    fill: color(element.backgroundColor, 'transparent', warnings),
    strokeWidth: Math.max(0, Math.min(100, finite(element.strokeWidth, DEFAULT_STYLE.strokeWidth))),
    fontSize: Math.max(1, Math.min(500, finite(element.fontSize, DEFAULT_STYLE.fontSize))),
    textAlign: element.textAlign === 'left' || element.textAlign === 'right' ? element.textAlign : 'center',
    opacity: Math.max(0, Math.min(1, finite(element.opacity, 100) / 100)),
    dashed: element.strokeStyle === 'dashed' || element.strokeStyle === 'dotted',
  }
}

function worldPoints(element: Json, minimum = 2): { x: number; y: number }[] {
  if (!Array.isArray(element.points) || element.points.length < minimum || element.points.length > 100000) throw new Error('Excalidraw 线条缺少有效的 points 数据。')
  const x = finite(element.x); const y = finite(element.y)
  return element.points.map(point => {
    if (!Array.isArray(point) || point.length < 2) throw new Error('Excalidraw 线条坐标格式不正确。')
    return { x: finite(point[0]) + x, y: finite(point[1]) + y }
  })
}

/** Basic structural import, without executing embedded content or loading remote assets. */
export function importExcalidraw(text: string): ImportedScene {
  if (text.length > 20 * 1024 * 1024) throw new Error('Excalidraw 文件过大，最多支持 20 MB。')
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error('Excalidraw JSON 格式不正确。') }
  if (!isObject(data) || data.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('文件不是有效的 Excalidraw 场景。')
  // Bound text is a separate Excalidraw element but merges into its container here.
  if (data.elements.length > 10000) throw new Error('文件元素过多；单页最多支持 5000 个转换后的图形。')
  const warnings = new Set<string>()
  if (data.version !== undefined && data.version !== 1 && data.version !== 2) warnings.add('文件使用较新的 Excalidraw 版本，部分特性可能无法转换。')
  const source = data.elements.filter((element): element is Json => {
    if (!isObject(element)) throw new Error('Excalidraw 元素格式不正确。')
    return element.isDeleted !== true
  })
  const sourceMap = new Map<string, Json>()
  for (const element of source) {
    if (typeof element.id !== 'string' || !element.id || sourceMap.has(element.id)) throw new Error('Excalidraw 元素缺少 ID 或存在重复 ID。')
    sourceMap.set(element.id, element)
  }
  const elements: SceneElement[] = []
  const mapped = new Map<string, SceneElement>()
  const pendingLabels: Json[] = []
  const files = isObject(data.files) ? data.files : {}
  for (const element of source) {
    const id = element.id as string
    const kind = element.type
    const supported = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw', 'image', 'stickynote']
    if (typeof kind !== 'string' || !supported.includes(kind)) { warnings.add(`元素类型“${typeof kind === 'string' ? kind.slice(0, 80) : '未知'}”暂不支持，已跳过。`); continue }
    if (kind === 'text' && typeof element.containerId === 'string') {
      const parent = sourceMap.get(element.containerId)
      if (parent && ['rectangle', 'ellipse', 'diamond', 'stickynote', 'image', 'arrow', 'line'].includes(String(parent.type))) { pendingLabels.push(element); continue }
    }
    const style = styleOf(element, warnings)
    const locked = element.locked === true
    let result: SceneElement
    if (kind === 'freedraw') {
      const pressures = element.pressures
      if (Array.isArray(pressures) && pressures.some(value => value !== pressures[0])) warnings.add('笔迹压感已简化为固定线宽。')
      result = { id, type: 'stroke', points: worldPoints(element, 1), style, locked }
    } else if (kind === 'arrow' || kind === 'line') {
      const points = worldPoints(element)
      if (points.length > 2 && element.elbowed !== true) warnings.add('折线与曲线已简化为两端点连线。')
      let from: Endpoint = points[0]!; let to: Endpoint = points.at(-1)!
      if (isObject(element.startBinding) && typeof element.startBinding.elementId === 'string') from = { ...from, nodeId: element.startBinding.elementId }
      if (isObject(element.endBinding) && typeof element.endBinding.elementId === 'string') to = { ...to, nodeId: element.endBinding.elementId }
      const start = element.startArrowhead != null
      const end = element.endArrowhead != null || (kind === 'arrow' && element.endArrowhead === undefined)
      if ((start && !['arrow', 'triangle'].includes(String(element.startArrowhead))) || (end && element.endArrowhead && !['arrow', 'triangle'].includes(String(element.endArrowhead)))) warnings.add('特殊箭头端点已简化为普通箭头。')
      if (start && !end) [from, to] = [to, from]
      result = { id, type: 'edge', from, to, label: '', arrow: start && end ? 'both' : start || end ? 'end' : 'none', route: element.elbowed === true ? 'orthogonal' : 'straight', style, locked }
    } else {
      let shape: ShapeElement['shape'] = kind === 'stickynote' ? 'note' : kind as ShapeElement['shape']
      let imageData: string | undefined
      if (kind === 'image') {
        const file = typeof element.fileId === 'string' ? files[element.fileId] : undefined
        if (isObject(file) && safeImage(file.dataURL)) imageData = file.dataURL
        else { shape = 'rectangle'; warnings.add('缺失图片、外部图片或 SVG 图片已替换为占位矩形；仅支持内嵌 PNG/JPEG/WebP。') }
        if (element.crop || (Array.isArray(element.scale) && element.scale.some(value => value !== 1))) warnings.add('图片裁剪和翻转效果不保留。')
      }
      if (shape === 'text') { style.fill = 'transparent'; style.stroke = color(element.strokeColor, DEFAULT_STYLE.stroke, warnings) }
      const native = isObject(element.customData) && isObject(element.customData.openWorkflow) ? element.customData.openWorkflow : undefined
      if (kind === 'rectangle' && native?.shape === 'note') shape = 'note'
      result = { id, type: 'shape', shape, x: finite(element.x), y: finite(element.y), width: Math.max(1, finite(element.width, 120)), height: Math.max(1, finite(element.height, 70)), text: shape === 'text' ? safeText(element.text) : '', style, locked, ...(imageData ? { imageData } : {}) }
    }
    elements.push(result); mapped.set(id, result)
  }
  for (const label of pendingLabels) {
    const parent = mapped.get(label.containerId as string)
    if (!parent || parent.type === 'stroke') continue
    styleOf(label, warnings)
    const value = safeText(label.text)
    if (parent.type === 'shape') parent.text = parent.text ? `${parent.text}\n${value}` : value
    else parent.label = parent.label ? `${parent.label}\n${value}` : value
    parent.style.fontSize = Math.max(1, Math.min(500, finite(label.fontSize, DEFAULT_STYLE.fontSize)))
    parent.style.textAlign = label.textAlign === 'left' || label.textAlign === 'right' ? label.textAlign : 'center'
  }
  for (const element of elements) {
    if (element.type !== 'edge') continue
    for (const endpoint of [element.from, element.to]) {
      if (endpoint.nodeId && mapped.get(endpoint.nodeId)?.type !== 'shape') { delete endpoint.nodeId; warnings.add('部分连线绑定的图形不存在或不受支持，已保留为自由端点。') }
    }
  }
  if (elements.length > 5000) throw new Error('单页最多支持 5000 个转换后的图形。')
  const appState = isObject(data.appState) ? data.appState : {}
  return { title: typeof appState.name === 'string' && appState.name ? appState.name : '导入白板', scene: { elements, background: color(appState.viewBackgroundColor, '#ffffff', warnings), grid: typeof appState.gridSize === 'number' && appState.gridSize > 0 }, warnings: [...warnings] }
}

/** Emits ordinary Excalidraw JSON and image files, without bundling its editor. */
export function exportExcalidraw(scene: Scene): string {
  const elements: Json[] = []
  const files: Record<string, Json> = Object.create(null)
  const updated = Date.now()
  const takenIds = new Set(scene.elements.map(element => element.id))
  function labelId(id: string): string { let result = `${id}__label`; while (takenIds.has(result)) result += '_'; takenIds.add(result); return result }
  function base(element: SceneElement): Json {
    return { id: element.id, angle: 0, strokeColor: element.style.stroke, backgroundColor: element.style.fill, fillStyle: 'solid', strokeWidth: element.style.strokeWidth, strokeStyle: element.style.dashed ? 'dashed' : 'solid', roughness: 0, opacity: element.style.opacity * 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 0, isDeleted: false, boundElements: [], updated, link: null, locked: element.locked }
  }
  function textElement(id: string, value: string, x: number, y: number, width: number, height: number, element: SceneElement, containerId: string | null): Json {
    return { ...base(element), id, type: 'text', x, y, width, height, text: value, originalText: value, fontSize: element.style.fontSize, fontFamily: 2, textAlign: element.style.textAlign, verticalAlign: containerId ? 'middle' : 'top', containerId, autoResize: false, lineHeight: 1.25, backgroundColor: 'transparent' }
  }
  const bindings = new Map<string, { id: string; type: string }[]>()
  for (const element of scene.elements) if (element.type === 'edge') for (const endpoint of [element.from, element.to]) if (endpoint.nodeId) { const list = bindings.get(endpoint.nodeId) || []; if (!list.some(item => item.id === element.id)) list.push({ id: element.id, type: 'arrow' }); bindings.set(endpoint.nodeId, list) }
  for (const element of scene.elements) {
    const result = base(element)
    if (element.type === 'shape') {
      if (element.shape === 'text') { elements.push(textElement(element.id, element.text, element.x, element.y, element.width, element.height, element, null)); continue }
      Object.assign(result, { type: element.shape === 'note' ? 'rectangle' : element.shape, x: element.x, y: element.y, width: element.width, height: element.height, boundElements: [...(bindings.get(element.id) || [])] })
      if (element.shape === 'note') result.customData = { openWorkflow: { shape: 'note' } }
      if (element.shape === 'image') {
        if (!safeImage(element.imageData)) throw new Error('导出图片必须为内嵌 PNG/JPEG/WebP。')
        const fileId = `image-${element.id}`
        files[fileId] = { id: fileId, mimeType: element.imageData.slice(5, element.imageData.indexOf(';')), dataURL: element.imageData, created: updated, lastRetrieved: updated }
        Object.assign(result, { fileId, status: 'saved', scale: [1, 1], crop: null })
      }
      elements.push(result)
      if (element.text) {
        const id = labelId(element.id)
        ;(result.boundElements as Json[]).push({ id, type: 'text' })
        elements.push(textElement(id, element.text, element.x + 8, element.y + 8, Math.max(1, element.width - 16), Math.max(1, element.height - 16), element, element.id))
      }
    } else if (element.type === 'stroke') {
      if (!element.points.length) throw new Error('笔迹没有坐标，无法导出。')
      const x = Math.min(...element.points.map(point => point.x)); const y = Math.min(...element.points.map(point => point.y))
      Object.assign(result, { type: 'freedraw', x, y, width: Math.max(...element.points.map(point => point.x)) - x, height: Math.max(...element.points.map(point => point.y)) - y, points: element.points.map(point => [point.x - x, point.y - y]), pressures: [], simulatePressure: true, lastCommittedPoint: null })
      elements.push(result)
    } else {
      const world = edgePoints(element, scene)
      const x = world[0]!.x; const y = world[0]!.y
      const last = world.at(-1)!
      const points = world.map(point => [point.x - x, point.y - y])
      const binding = (endpoint: Endpoint): Json | null => endpoint.nodeId ? { elementId: endpoint.nodeId, focus: 0, gap: 0, fixedPoint: null } : null
      Object.assign(result, { type: 'arrow', x, y, width: Math.max(...world.map(point => point.x)) - Math.min(...world.map(point => point.x)), height: Math.max(...world.map(point => point.y)) - Math.min(...world.map(point => point.y)), points, startBinding: binding(element.from), endBinding: binding(element.to), startArrowhead: element.arrow === 'both' ? 'arrow' : null, endArrowhead: element.arrow === 'none' ? null : 'arrow', elbowed: element.route === 'orthogonal', lastCommittedPoint: null })
      elements.push(result)
      if (element.label) {
        const id = labelId(element.id)
        ;(result.boundElements as Json[]).push({ id, type: 'text' })
        elements.push(textElement(id, element.label, (x + last.x) / 2 - 60, (y + last.y) / 2 - 12, 120, Math.max(24, element.style.fontSize * 1.25), element, element.id))
      }
    }
  }
  return JSON.stringify({ type: 'excalidraw', version: 2, source: 'https://github.com/ecojust/open-workflow', elements, appState: { viewBackgroundColor: scene.background, gridSize: scene.grid ? 20 : null }, files }, null, 2)
}
