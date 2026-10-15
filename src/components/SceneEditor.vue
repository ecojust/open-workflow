<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import BoardTemplatePanel from './BoardTemplatePanel.vue'
import BrushPanel, { type BrushSettings } from './BrushPanel.vue'
import { BRUSH_PRESETS, brushPreset, normalizedPressure } from '../core/brushes'
import { createBoardTemplate } from '../core/board-templates'
import CanvasContextMenu from './CanvasContextMenu.vue'
import { canvasGrid } from '../core/grid'
import { applyGlobalLineStyle, sceneDefaultStyle, resolveStrokePattern } from '../core/appearance'
import { findBindingTarget } from '../core/binding'
import { expandedSelection, groupElements, ungroupElements, alignElements, distributeElements, hitTestElement, frameContents } from '../core/board-tools'
import { selectionScene, reorderElements } from '../core/selection'
import { clone, newId, type EdgeElement, type ElementStyle, type Point, type Scene, type SceneElement, type ShapeElement, type BrushKind, type StrokeElement } from '../core/types'
import { braceTextBounds, isBraceShape, center, combineBounds, edgePoints, elementBounds, pathMidpoint, sceneBounds, shapeAnchor, snap, type Bounds } from '../core/geometry'
import { elementToSvg, safeImageData } from '../core/svg'
import { layoutScene } from '../core/layout'
import { createDocument, validateScene } from '../core/documents'

const props = defineProps<{ scene: Scene; mode: 'flow' | 'board'; theme: 'light' | 'dark' }>()
const emit = defineEmits<{ change: [scene: Scene, label: string]; status: [message: string]; export: [format: 'svg' | 'png', selection?: Scene] }>()
type Tool = 'select' | 'hand' | ShapeElement['shape'] | 'pen' | 'highlighter' | 'eraser' | 'edge' | 'laser'
const draft = ref<Scene>(clone(props.scene)), selected = ref<string[]>([]), tool = ref<Tool>('select')
const stage = ref<HTMLDivElement>(), editor = ref<HTMLElement>(), imageInput = ref<HTMLInputElement>(), textInput = ref<HTMLTextAreaElement>(), propertyTextInput = ref<HTMLTextAreaElement>()
const viewport = ref({ x: 0, y: 0, zoom: 1, width: 900, height: 600 }), spaceHeld = ref(false), editingId = ref<string>(), editText = ref('')
const propertiesOpen = ref(typeof window === 'undefined' || window.innerWidth > 1000), activeStyle = ref<ElementStyle>(sceneDefaultStyle(props.scene)), snapEnabled = ref(false)
const boardTemplatesOpen = ref(false), brushSettingsOpen = ref(false)
const firstBrush = brushPreset('pen')
const brushSettings = ref<BrushSettings>({ kind: 'pen', color: activeStyle.value.stroke, width: firstBrush.width, opacity: firstBrush.opacity, smoothing: .4, pressure: true })
const rememberedBrushes = new Map<BrushKind, BrushSettings>()
let lastInkBrush: BrushKind = 'pen'
const laserTrails = ref<{ id: string; points: Point[]; updatedAt: number; opacity: number }[]>([])
let laserFrame: number | undefined
const brushName = computed(() => brushPreset(brushSettings.value.kind).label)
const toolLocked = ref(false), edgeDefaultsOpen = ref(false)
const defaultEdgeRoute = ref<EdgeElement['route']>('orthogonal'), defaultEdgeArrow = ref<EdgeElement['arrow']>('end')
const edgeRouteOptions = [{ value: 'straight', label: '直线', icon: 'edge-straight' }, { value: 'orthogonal', label: '折线', icon: 'edge-orthogonal' }] as const
const edgeArrowOptions = [{ value: 'none', label: '无箭头', icon: 'arrow-none' }, { value: 'end', label: '单箭头', icon: 'arrow-end' }, { value: 'both', label: '双箭头', icon: 'arrow-both' }] as const
const libraryOpen = ref(false), globalStyleOpen = ref(false), bindingTarget = ref<ShapeElement>(), contextMenu = ref<{ x: number; y: number }>()
const gridId = newId('grid'), grid = computed(() => canvasGrid(viewport.value.zoom, draft.value.background, props.theme === 'dark' ? '#141922' : '#f5f7fb'))
const bindingAnchors = computed(() => {
  const node = bindingTarget.value
  if (!node) return []
  const point = center(node)
  return [{ x: point.x, y: node.y - 1 }, { x: node.x + node.width + 1, y: point.y }, { x: point.x, y: node.y + node.height + 1 }, { x: node.x - 1, y: point.y }].map(toward => shapeAnchor(node, toward))
})
const globalStyle = computed(() => sceneDefaultStyle(draft.value))
let flushing = false, captureTarget: Element | undefined
const pendingControls = new WeakSet<Element>()
let observer: ResizeObserver | undefined, clipboard: SceneElement[] = [], initialFit = false, activePointerId: number | undefined, penPointBudget = 0
let gesture: { type: 'move' | 'pan' | 'draw' | 'pen' | 'edge' | 'endpoint' | 'resize' | 'marquee' | 'erase' | 'laser'; movingIds?: string[]; endpoint?: 'from' | 'to'; start: Point; last: Point; original: Scene; id?: string; originalView?: { x: number; y: number }; additive?: boolean; moved?: boolean } | undefined
const marquee = ref<Bounds>()
const noteColors = ['#fff4ad', '#ffd7dc', '#d8f4df', '#dceafe', '#eadfff', '#ffffff']
const alignmentOptions = [{ id: 'left', label: '左对齐' }, { id: 'center', label: '水平居中' }, { id: 'right', label: '右对齐' }, { id: 'top', label: '顶端对齐' }, { id: 'middle', label: '垂直居中' }, { id: 'bottom', label: '底端对齐' }] as const
watch(() => props.scene, value => { if (!gesture && !editingId.value) { draft.value = clone(value); activeStyle.value = sceneDefaultStyle(value); selected.value = selected.value.filter(id => value.elements.some(e => e.id === id)) } }, { deep: true })
const selectedElements = computed(() => draft.value.elements.filter(e => selected.value.includes(e.id)))
const hasBrushSelection = computed(() => selectedElements.value.some(element => element.type === 'stroke' && element.brush))
const hasLineStyleSelection = computed(() => selectedElements.value.some(element => element.type !== 'stroke' || !element.brush))
const primary = computed(() => selectedElements.value.length === 1 ? selectedElements.value[0] : undefined)
const selectedBounds = computed(() => selectedElements.value.length ? combineBounds(selectedElements.value.map(e => e.type === 'edge' ? elementBounds({ ...e, type: 'stroke', points: edgePoints(e, draft.value) }) : elementBounds(e))) : undefined)
const editingNode = computed(() => draft.value.elements.find((e): e is ShapeElement | EdgeElement => e.id === editingId.value && (e.type === 'shape' || e.type === 'edge')))
const editPosition = computed(() => {
  const node = editingNode.value; if (!node) return {}
  const v = viewport.value, bounds = node.type === 'shape' ? isBraceShape(node.shape) ? braceTextBounds(node) : node : (() => { const p = pathMidpoint(edgePoints(node, draft.value)); return { x: p.x - 100, y: p.y - 32, width: 200, height: 64 } })()
  return { left: `${(bounds.x - v.x) * v.zoom}px`, top: `${(bounds.y - v.y) * v.zoom}px`, width: `${Math.max(80, bounds.width * v.zoom)}px`, height: `${Math.max(44, (node.type === 'shape' && node.shape === 'frame' ? Math.min(node.height, Math.max(28, node.style.fontSize * 1.5 + 12)) : bounds.height) * v.zoom)}px`, fontSize: `${Math.max(10, node.style.fontSize * v.zoom)}px`, color: ['transparent', 'none'].includes(node.style.stroke.toLowerCase()) ? '#334155' : node.style.stroke, textAlign: node.style.textAlign }
})
const edgeHandles = computed(() => {
  if (tool.value !== 'select' || primary.value?.type !== 'edge' || primary.value.locked) return []
  const points = edgePoints(primary.value, draft.value)
  return [{ endpoint: 'from' as const, ...points[0]! }, { endpoint: 'to' as const, ...points[points.length - 1]! }]
})
const viewBox = computed(() => `${viewport.value.x} ${viewport.value.y} ${viewport.value.width / viewport.value.zoom} ${viewport.value.height / viewport.value.zoom}`)
const zoomLabel = computed(() => `${Math.round(viewport.value.zoom * 100)}%`)
const tools: { id: Tool; label: string; icon: string; shortcut?: string }[] = [
  { id: 'select', label: '选择', icon: 'cursor', shortcut: 'V' }, { id: 'hand', label: '移动画布', icon: 'hand', shortcut: 'H' },
  { id: 'rectangle', label: '矩形', icon: 'rectangle', shortcut: 'R' }, { id: 'ellipse', label: '圆形', icon: 'ellipse', shortcut: 'O' },
  { id: 'diamond', label: '判断', icon: 'diamond', shortcut: 'D' }, { id: 'edge', label: '连线', icon: 'connector', shortcut: 'L' },
  { id: 'text', label: '文字', icon: 'text', shortcut: 'T' }, { id: 'note', label: '便签', icon: 'note', shortcut: 'N' }, { id: 'pen', label: '画笔', icon: 'pen', shortcut: 'P' }, { id: 'highlighter', label: '荧光笔', icon: 'highlighter', shortcut: 'M' }, { id: 'laser', label: '激光指示', icon: 'laser', shortcut: 'K' }, { id: 'eraser', label: '橡皮擦', icon: 'eraser', shortcut: 'E' }, { id: 'frame', label: '分区框架', icon: 'frame', shortcut: 'F' },
]
const shapePalette: { shape: ShapeElement['shape']; text: string; icon: string }[] = [
  { shape: 'rectangle', text: '矩形', icon: 'rectangle' }, { shape: 'ellipse', text: '椭圆', icon: 'ellipse' }, { shape: 'diamond', text: '菱形', icon: 'diamond' },
  { shape: 'triangle', text: '三角形', icon: 'triangle' }, { shape: 'hexagon', text: '六边形', icon: 'hexagon' }, { shape: 'star', text: '星形', icon: 'star' },
  { shape: 'parallelogram', text: '平行四边形', icon: 'parallelogram' }, { shape: 'cylinder', text: '圆柱', icon: 'cylinder' }, { shape: 'cloud', text: '云形', icon: 'cloud' },
  { shape: 'note', text: '便签', icon: 'note' }, { shape: 'text', text: '文本', icon: 'text' }, { shape: 'frame', text: '分区框架', icon: 'frame' },
  { shape: 'brace-left', text: '左大括弧', icon: 'brace-left' }, { shape: 'brace-right', text: '右大括弧', icon: 'brace-right' },
  { shape: 'brace-top', text: '上大括弧', icon: 'brace-top' }, { shape: 'brace-bottom', text: '下大括弧', icon: 'brace-bottom' },
]
function commit(label: string): boolean {
  try {
    const candidate = validateScene(draft.value)
    draft.value = candidate
    emit('change', clone(candidate), label)
    // Parent may reject an otherwise valid scene because the whole document is too large.
    nextTick(() => { if (!gesture) { draft.value = clone(props.scene); selected.value = selected.value.filter(id => draft.value.elements.some(e => e.id === id)); if (editingId.value && !draft.value.elements.some(e => e.id === editingId.value)) editingId.value = undefined } })
    return true
  } catch (error) { draft.value = clone(props.scene); selected.value = selected.value.filter(id => draft.value.elements.some(e => e.id === id)); emit('status', error instanceof Error ? error.message : '本次编辑超出画布限制，已恢复原内容'); return false }
}
function canAdd(elements = 1, points = 0): boolean {
  if (draft.value.elements.length + elements > 5000) { emit('status', '画布最多支持 5000 个元素，请删除部分元素或新建文档'); return false }
  const currentPoints = draft.value.elements.reduce((count, e) => count + (e.type === 'stroke' ? e.points.length : 0), 0)
  if (currentPoints + points > 100000) { emit('status', '画布笔迹总点数最多为 100000，请删除部分笔迹或新建文档'); return false }
  return true
}
function releaseCapture() { if (activePointerId !== undefined && captureTarget?.hasPointerCapture(activePointerId)) captureTarget.releasePointerCapture(activePointerId); activePointerId = undefined; captureTarget = undefined }
function localPoint(event: MouseEvent | PointerEvent | WheelEvent): Point { const rect = stage.value!.getBoundingClientRect(), v = viewport.value; return { x: v.x + (event.clientX - rect.left) / v.zoom, y: v.y + (event.clientY - rect.top) / v.zoom } }
function snapped(point: Point): Point { return { x: snap(point.x, snapEnabled.value), y: snap(point.y, snapEnabled.value) } }
function focusStage() { nextTick(() => stage.value?.focus({ preventScroll: true })) }
function setTool(value: Tool) {
  flush(); bindingTarget.value = undefined; contextMenu.value = undefined; globalStyleOpen.value = false; boardTemplatesOpen.value = false; edgeDefaultsOpen.value = false; brushSettingsOpen.value = false
  if (value === 'highlighter') chooseBrush('highlighter', false)
  else if (value === 'pen' && brushSettings.value.kind === 'highlighter') chooseBrush(lastInkBrush, false)
  tool.value = value
  if (window.innerWidth <= 800) libraryOpen.value = false
  focusStage()
}
function chooseBrush(kind: BrushKind, activate = true) {
  flush()
  rememberedBrushes.set(brushSettings.value.kind, { ...brushSettings.value })
  const preset = brushPreset(kind)
  brushSettings.value = rememberedBrushes.get(kind) || { ...brushSettings.value, kind, width: preset.width, opacity: preset.opacity, color: preset.color || (brushSettings.value.kind === 'highlighter' ? activeStyle.value.stroke : brushSettings.value.color) }
  if (kind !== 'highlighter') lastInkBrush = kind
  if (activate) tool.value = kind === 'highlighter' ? 'highlighter' : 'pen'
}
function toggleBrushSettings() {
  flush(); globalStyleOpen.value = false; boardTemplatesOpen.value = false; edgeDefaultsOpen.value = false; contextMenu.value = undefined
  brushSettingsOpen.value = !brushSettingsOpen.value
  if (brushSettingsOpen.value) nextTick(() => editor.value?.querySelector<HTMLButtonElement>('[data-testid="brush-settings-panel"] button[aria-pressed="true"]')?.focus({ preventScroll: true }))
  else focusStage()
}
function updateBrushSettings(patch: Partial<BrushSettings>) { brushSettings.value = { ...brushSettings.value, ...patch } }
function updateSelectedBrush(value: string) {
  if (!BRUSH_PRESETS.some(preset => preset.id === value)) return
  const stroke = primary.value
  if (stroke?.type !== 'stroke' || stroke.locked) return
  stroke.brush = value as BrushKind
  stroke.pressures ||= stroke.points.map(() => .5)
  commit('修改笔触')
}
function pointerPressure(event: PointerEvent, fallback = .5) { return brushSettings.value.pressure && event.pointerType === 'pen' ? normalizedPressure(event.pressure > 0 ? event.pressure : fallback) : .5 }
function advanceLaser() {
  const now = performance.now(), activeId = gesture?.type === 'laser' ? gesture.id : undefined
  laserTrails.value = laserTrails.value.filter(trail => trail.id === activeId || now - trail.updatedAt < 900)
  for (const trail of laserTrails.value) trail.opacity = trail.id === activeId ? 1 : Math.max(0, 1 - (now - trail.updatedAt) / 900)
  laserFrame = laserTrails.value.length ? requestAnimationFrame(advanceLaser) : undefined
}
function laserPath(points: Point[]) { return points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ') }
function toggleToolLock() { flush(); toolLocked.value = !toolLocked.value; emit('status', toolLocked.value ? '连续绘制已开启，按 Esc 返回选择工具' : '连续绘制已关闭，绘制完成后返回选择工具'); focusStage() }
function toggleEdgeDefaults() {
  flush(); globalStyleOpen.value = false; boardTemplatesOpen.value = false; brushSettingsOpen.value = false; contextMenu.value = undefined
  edgeDefaultsOpen.value = !edgeDefaultsOpen.value
  if (edgeDefaultsOpen.value) nextTick(() => editor.value?.querySelector<HTMLButtonElement>('[data-testid="edge-defaults-panel"] button[aria-pressed="true"]')?.focus({ preventScroll: true }))
  else focusStage()
}
function makeShape(shape: ShapeElement['shape'], point: Point): ShapeElement {
  const style = { ...activeStyle.value }
  if (shape === 'note') { style.fill = '#fff4ad'; style.textAlign = 'left' }
  const brace = isBraceShape(shape), verticalBrace = shape === 'brace-left' || shape === 'brace-right'
  if (shape === 'text' || shape === 'frame' || brace) style.fill = 'transparent'
  return { id: newId(), type: 'shape', shape, x: point.x, y: point.y, width: brace ? verticalBrace ? 160 : 240 : shape === 'frame' ? 480 : shape === 'diamond' ? 160 : 180, height: brace ? verticalBrace ? 180 : 110 : shape === 'frame' ? 320 : shape === 'note' ? 150 : shape === 'text' ? 54 : 86, text: shape === 'frame' ? '分区标题' : shape === 'text' ? '输入文字' : shape === 'note' ? '写下你的想法' : '', style, locked: false }
}
function addShape(shape: ShapeElement['shape']) { flush(); if (!canAdd()) return; const v = viewport.value, node = makeShape(shape, snapped({ x: v.x + v.width / v.zoom / 2 - 90, y: v.y + v.height / v.zoom / 2 - 43 })); while (draft.value.elements.some(e => e.type === 'shape' && Math.abs(e.x - node.x) < 12 && Math.abs(e.y - node.y) < 12)) { node.x += 24; node.y += 24 }; draft.value.elements.push(node); selected.value = [node.id]; commit('添加图形'); focusStage() }
function findNode(point: Point) { return findBindingTarget(draft.value, point, viewport.value.zoom) }
function startEdit(node: SceneElement | undefined) {
  if (!node || node.locked || node.type === 'stroke' || (node.type === 'shape' && node.shape === 'image')) return
  flush(); selected.value = [node.id]; tool.value = 'select'; editingId.value = node.id; editText.value = node.type === 'shape' ? node.text : node.label
  nextTick(() => { textInput.value?.focus(); textInput.value?.select() })
}
function backgroundDoubleClick(event: MouseEvent) {
  if (tool.value !== 'select' || spaceHeld.value || (event.target instanceof Element && event.target.closest('[data-element-id],.canvas-bottom,.inline-text-editor'))) return
  flush(); if (!canAdd()) return
  const node = makeShape('text', snapped(localPoint(event))); node.text = ''; draft.value.elements.push(node); selected.value = [node.id]
  if (commit('添加文字')) startEdit(node)
}
function elementMarkup(element: SceneElement) {
  if (element.id !== editingId.value) return elementToSvg(element, draft.value, true)
  return elementToSvg(element.type === 'shape' ? { ...element, text: '' } : element.type === 'edge' ? { ...element, label: '' } : element, draft.value, true)
}
function markControlDirty(event: Event) { const control = event.target; if ((control instanceof HTMLInputElement || control instanceof HTMLSelectElement) && control.closest('.properties-panel,.global-style-panel,.brush-panel')) pendingControls.add(control) }
function clearControlDirty(event: Event) { if (event.target instanceof Element) pendingControls.delete(event.target) }
function flush() {
  if (flushing) return
  flushing = true
  try {
    finishGesture(false)
    if (propertyTextInput.value && document.activeElement === propertyTextInput.value) {
      const e = primary.value, text = propertyTextInput.value.value
      if (e && ((e.type === 'shape' && e.text !== text) || (e.type === 'edge' && e.label !== text))) updateText(text)
    }
    const control = document.activeElement
    if ((control instanceof HTMLInputElement || control instanceof HTMLSelectElement) && editor.value?.contains(control) && pendingControls.has(control)) control.dispatchEvent(new Event('change', { bubbles: true }))
    if (!editingId.value) return
    const node = editingNode.value; editingId.value = undefined
    if (node && (node.type === 'shape' ? node.text : node.label) !== editText.value) { if (node.type === 'shape') node.text = editText.value.slice(0, 100000); else node.label = editText.value.slice(0, 100000); commit('修改文字') }
  } finally { flushing = false }
}
defineExpose({ flush, fitCanvas })
function pointerDown(event: PointerEvent, element?: SceneElement, resize = false) {
  if (event.button !== 0 && event.button !== 1) return
  if (event.target instanceof Element && event.target.closest('.inline-text-editor')) return
  flush(); contextMenu.value = undefined; globalStyleOpen.value = false; boardTemplatesOpen.value = false; edgeDefaultsOpen.value = false; brushSettingsOpen.value = false; event.preventDefault(); event.stopPropagation(); stage.value?.focus({ preventScroll: true })
  captureTarget = event.currentTarget instanceof Element ? event.currentTarget : stage.value; captureTarget?.setPointerCapture(event.pointerId)
  activePointerId = event.pointerId
  const point = localPoint(event), original = clone(draft.value)
  if (spaceHeld.value || event.button === 1 || tool.value === 'hand') { gesture = { type: 'pan', start: { x: event.clientX, y: event.clientY }, last: point, original, originalView: { x: viewport.value.x, y: viewport.value.y } }; return }
  if (tool.value === 'laser') {
    const id = newId('laser'); laserTrails.value = [...laserTrails.value.slice(-11), { id, points: [point], updatedAt: performance.now(), opacity: 1 }]
    selected.value = []; gesture = { type: 'laser', start: point, last: point, original, id }
    if (laserFrame === undefined) laserFrame = requestAnimationFrame(advanceLaser)
    return
  }
  if (resize && element?.type === 'shape' && !element.locked) { gesture = { type: 'resize', start: point, last: point, original, id: element.id }; return }
  if (!['select', 'hand', 'eraser'].includes(tool.value) && !canAdd(1, ['pen', 'highlighter'].includes(tool.value) ? 1 : 0)) { releaseCapture(); return }
  if (tool.value === 'eraser') {
    captureTarget = stage.value; captureTarget?.setPointerCapture(event.pointerId)
    gesture = { type: 'erase', start: point, last: point, original }; selected.value = []; eraseAt(point); return
  }
  if (tool.value === 'edge') {
    const node = findNode(point), from = node ? { ...center(node), nodeId: node.id } : snapped(point)
    const edge: EdgeElement = { id: newId(), type: 'edge', from, to: { ...point }, label: '', arrow: defaultEdgeArrow.value, route: defaultEdgeRoute.value, style: { ...activeStyle.value, fill: 'none' }, locked: false }
    bindingTarget.value = node; draft.value.elements.push(edge); selected.value = [edge.id]; gesture = { type: 'edge', start: point, last: point, original, id: edge.id }; return
  }
  if (tool.value === 'pen' || tool.value === 'highlighter') {
    const id = newId(), settings = brushSettings.value
    penPointBudget = 100000 - draft.value.elements.reduce((count, e) => count + (e.type === 'stroke' ? e.points.length : 0), 0) - 1
    draft.value.elements.push({ id, type: 'stroke', brush: settings.kind, points: [point], pressures: [pointerPressure(event)], style: { ...activeStyle.value, fill: 'none', stroke: settings.color, strokeWidth: settings.width, opacity: settings.opacity, roughness: 'clean', strokePattern: 'solid', dashed: false }, locked: false })
    selected.value = [id]; gesture = { type: 'pen', start: point, last: point, original, id }; return
  }
  if (!['select', 'hand'].includes(tool.value)) {
    const node = makeShape(tool.value as ShapeElement['shape'], snapped(point)); if (node.shape === 'frame') draft.value.elements.unshift(node); else draft.value.elements.push(node); selected.value = [node.id]; gesture = { type: 'draw', start: snapped(point), last: point, original, id: node.id }; return
  }
  if (element) {
    const ids = event.altKey ? [element.id] : expandedSelection(draft.value, [element.id])
    if (event.shiftKey) { const allSelected = ids.every(id => selected.value.includes(id)); selected.value = allSelected ? selected.value.filter(id => !ids.includes(id)) : [...new Set([...selected.value, ...ids])] }
    else if (event.altKey || !selected.value.includes(element.id)) selected.value = ids
    if (!element.locked && selected.value.includes(element.id)) {
      const movingIds = movableSelection(draft.value)
      gesture = { type: 'move', start: point, last: point, original, movingIds }
    }
  } else { if (!event.shiftKey) selected.value = []; gesture = { type: 'marquee', start: point, last: point, original, additive: event.shiftKey }; marquee.value = { x: point.x, y: point.y, width: 0, height: 0 } }
}
function removeElements(ids: Set<string>) {
  const original = draft.value
  draft.value.elements = original.elements.flatMap(element => {
    if (ids.has(element.id)) return []
    if (element.type !== 'edge' || !((element.from.nodeId && ids.has(element.from.nodeId)) || (element.to.nodeId && ids.has(element.to.nodeId)))) return [element]
    if (!element.locked) return []
    const points = edgePoints(element, original), edge = clone(element)
    if (edge.from.nodeId && ids.has(edge.from.nodeId)) edge.from = { ...points[0]! }
    if (edge.to.nodeId && ids.has(edge.to.nodeId)) edge.to = { ...points[points.length - 1]! }
    return [edge]
  })
  selected.value = selected.value.filter(id => !ids.has(id))
}
function eraseAt(point: Point) { const element = hitTestElement(draft.value, point, viewport.value.zoom); if (element && !element.locked) removeElements(new Set([element.id])) }

function startEndpointDrag(event: PointerEvent, endpoint: 'from' | 'to') {
  const edge = primary.value; if (event.button !== 0 || edge?.type !== 'edge' || edge.locked) return
  flush(); event.preventDefault(); event.stopPropagation(); contextMenu.value = undefined; globalStyleOpen.value = false; boardTemplatesOpen.value = false; edgeDefaultsOpen.value = false; stage.value?.focus({ preventScroll: true })
  captureTarget = event.currentTarget instanceof Element ? event.currentTarget : stage.value; captureTarget?.setPointerCapture(event.pointerId); activePointerId = event.pointerId
  const point = localPoint(event); gesture = { type: 'endpoint', endpoint, start: point, last: point, original: clone(draft.value), id: edge.id }
}
function translateElement(element: SceneElement, dx: number, dy: number) {
  if (element.type === 'shape') { element.x += dx; element.y += dy }
  else if (element.type === 'stroke') element.points = element.points.map(p => ({ x: p.x + dx, y: p.y + dy }))
  else { if (!element.from.nodeId) { element.from.x += dx; element.from.y += dy }; if (!element.to.nodeId) { element.to.x += dx; element.to.y += dy } }
}
function movableSelection(scene: Scene) {
  const lockedGroups = new Set(scene.elements.filter(element => element.locked && element.groupId).map(element => element.groupId))
  const contents = scene.elements.flatMap(element => selected.value.includes(element.id) && !element.locked && !(element.groupId && lockedGroups.has(element.groupId)) && element.type === 'shape' && element.shape === 'frame' ? expandedSelection(scene, frameContents(scene, element.id)) : [])
  const ids = new Set([...selected.value, ...contents])
  return scene.elements.filter(element => ids.has(element.id) && !element.locked && !(element.groupId && lockedGroups.has(element.groupId))).map(element => element.id)
}
function pointerMove(event: PointerEvent) {
  if (!gesture) { bindingTarget.value = tool.value === 'edge' ? findNode(localPoint(event)) : undefined; return }
  const point = localPoint(event), dx = point.x - gesture.start.x, dy = point.y - gesture.start.y
  if (Math.hypot(dx, dy) * viewport.value.zoom > 3) gesture.moved = true
  if (gesture.type === 'pan') { viewport.value.x = gesture.originalView!.x - (event.clientX - gesture.start.x) / viewport.value.zoom; viewport.value.y = gesture.originalView!.y - (event.clientY - gesture.start.y) / viewport.value.zoom; return }
  if (gesture.type === 'laser') {
    const trail = laserTrails.value.find(item => item.id === gesture!.id)
    if (trail && Math.hypot(point.x - gesture.last.x, point.y - gesture.last.y) * viewport.value.zoom > 1) { trail.points.push(point); if (trail.points.length > 1024) trail.points.shift(); trail.updatedAt = performance.now(); gesture.last = point }
    return
  }
  if (gesture.type === 'erase') {
    const distance = Math.hypot(point.x - gesture.last.x, point.y - gesture.last.y), steps = Math.min(128, Math.max(1, Math.ceil(distance * viewport.value.zoom / 6)))
    for (let index = 1; index <= steps; index++) eraseAt({ x: gesture.last.x + (point.x - gesture.last.x) * index / steps, y: gesture.last.y + (point.y - gesture.last.y) * index / steps })
    gesture.last = point; return
  }
  if (gesture.type === 'move') {
    const movingIds = gesture.movingIds || movableSelection(gesture.original)
    const anchor = gesture.original.elements.find(e => movingIds.includes(e.id) && !e.locked)
    const origin = anchor ? elementBounds(anchor) : { x: 0, y: 0 }
    const x = snap(origin.x + dx, snapEnabled.value) - origin.x, y = snap(origin.y + dy, snapEnabled.value) - origin.y
    draft.value.elements = gesture.original.elements.map(original => { const e = clone(original); if (movingIds.includes(e.id) && !e.locked) translateElement(e, x, y); return e })
  } else if (gesture.type === 'draw' || gesture.type === 'resize') {
    const node = draft.value.elements.find((e): e is ShapeElement => e.id === gesture!.id && e.type === 'shape')!
    let p = snapped(point)
    if (gesture.type === 'draw' && event.shiftKey && ['rectangle', 'ellipse', 'diamond', 'triangle', 'hexagon', 'star'].includes(node.shape)) {
      const side = Math.max(24, Math.abs(p.x - gesture.start.x), Math.abs(p.y - gesture.start.y))
      p = { x: gesture.start.x + (p.x < gesture.start.x ? -side : side), y: gesture.start.y + (p.y < gesture.start.y ? -side : side) }
    }
    if (gesture.type === 'draw' && gesture.moved) { node.x = Math.min(gesture.start.x, p.x); node.y = Math.min(gesture.start.y, p.y); node.width = Math.max(24, Math.abs(p.x - gesture.start.x)); node.height = Math.max(24, Math.abs(p.y - gesture.start.y)) }
    if (gesture.type === 'resize') { node.width = Math.max(24, p.x - node.x); node.height = Math.max(24, p.y - node.y); if (event.shiftKey) { const old = gesture.original.elements.find(e => e.id === node.id) as ShapeElement; node.height = node.width * old.height / old.width } }
  } else if (gesture.type === 'pen') {
    const samples = event.getCoalescedEvents?.() || []
    for (const sample of samples.length ? samples : [event]) appendPenPoint(sample)
  }
  else if (gesture.type === 'edge' || gesture.type === 'endpoint') { const edge = draft.value.elements.find(e => e.id === gesture!.id) as EdgeElement, target = findNode(point); bindingTarget.value = target; edge[gesture.endpoint || 'to'] = target ? { ...center(target), nodeId: target.id } : snapped(point) }
  else if (gesture.type === 'marquee') marquee.value = { x: Math.min(point.x, gesture.start.x), y: Math.min(point.y, gesture.start.y), width: Math.abs(dx), height: Math.abs(dy) }
}
function appendPenPoint(event: PointerEvent, final = false) {
  if (gesture?.type !== 'pen') return
  const stroke = draft.value.elements.find((element): element is StrokeElement => element.id === gesture!.id && element.type === 'stroke')
  if (!stroke) return
  const raw = localPoint(event), blend = final ? 1 : 1 - brushSettings.value.smoothing * .75
  const point = { x: gesture.last.x + (raw.x - gesture.last.x) * blend, y: gesture.last.y + (raw.y - gesture.last.y) * blend }
  if (Math.hypot(point.x - gesture.last.x, point.y - gesture.last.y) * viewport.value.zoom <= (final ? .1 : 1.5)) return
  if (!penPointBudget) { finishGesture(false); emit('status', '已达到 100000 个笔迹点，本次笔迹已保存'); return }
  stroke.points.push(point); stroke.pressures!.push(pointerPressure(event, stroke.pressures!.at(-1))); penPointBudget--; gesture.last = point
}
function pointerUp(event: PointerEvent) { if (gesture?.type === 'pen') appendPenPoint(event, true); finishGesture(true) }
function finishGesture(openText: boolean) {
  if (!gesture) { releaseCapture(); return }
  const done = gesture; gesture = undefined; bindingTarget.value = undefined
  releaseCapture()
  if (done.type === 'marquee') {
    const box = marquee.value!; const ids = draft.value.elements.filter(e => { const b = e.type === 'edge' ? elementBounds({ ...e, type: 'stroke', points: edgePoints(e, draft.value) }) : elementBounds(e); return b.x >= box.x && b.y >= box.y && b.x + b.width <= box.x + box.width && b.y + b.height <= box.y + box.height }).map(e => e.id)
    selected.value = expandedSelection(draft.value, [...new Set([...(done.additive ? selected.value : []), ...ids])]); marquee.value = undefined; return
  }
  if (done.type === 'laser') { const trail = laserTrails.value.find(item => item.id === done.id); if (trail) trail.updatedAt = performance.now(); return }
  if (done.type === 'pan') return
  if (done.type === 'endpoint' && !done.moved) { draft.value = done.original; return }
  if (done.type === 'edge' && !done.moved) { draft.value = done.original; selected.value = []; return }
  if (JSON.stringify(done.original) !== JSON.stringify(draft.value)) commit(({ move: '移动图形', resize: '调整大小', draw: '添加图形', pen: '自由绘制', edge: '添加连线', endpoint: '调整连线连接', erase: '擦除元素' } as Record<string, string>)[done.type] || '编辑画布')
  if (['draw', 'pen', 'edge'].includes(done.type) && !toolLocked.value) tool.value = 'select'
  if (done.type === 'draw' && !toolLocked.value) { const added = draft.value.elements.find(e => e.id === done.id); if (openText && added?.type === 'shape' && ['text', 'note'].includes(added.shape)) startEdit(added) }
}
function cancelGesture() { if (gesture?.type === 'laser') laserTrails.value = laserTrails.value.filter(trail => trail.id !== gesture!.id); else if (gesture) draft.value = gesture.original; gesture = undefined; marquee.value = undefined; bindingTarget.value = undefined; releaseCapture() }
function fitCanvas() {
  if (!stage.value) return
  if (!draft.value.elements.length) { viewport.value.zoom = 1; viewport.value.x = 0; viewport.value.y = 0; return }
  const b = sceneBounds(draft.value), v = viewport.value, top = (editor.value?.querySelector('.canvas-commandbar')?.getBoundingClientRect().height ?? 48) + 36, bottom = 66
  const availableHeight = Math.max(100, v.height - top - bottom), zoom = Math.max(0.1, Math.min(1.5, (v.width - 100) / Math.max(200, b.width), availableHeight / Math.max(180, b.height)))
  v.zoom = zoom; v.x = b.x + b.width / 2 - v.width / zoom / 2; v.y = b.y + b.height / 2 - (top + availableHeight / 2) / zoom
}
function zoomTo(next: number, anchor?: Point) { const v = viewport.value, point = anchor || { x: v.x + v.width / v.zoom / 2, y: v.y + v.height / v.zoom / 2 }, ratio = v.zoom / Math.max(0.1, Math.min(4, next)); v.x = point.x - (point.x - v.x) * ratio; v.y = point.y - (point.y - v.y) * ratio; v.zoom = Math.max(0.1, Math.min(4, next)) }
function wheel(event: WheelEvent) { if (event.ctrlKey || event.metaKey) zoomTo(viewport.value.zoom * Math.exp(-event.deltaY * 0.002), localPoint(event)); else { viewport.value.x += event.deltaX / viewport.value.zoom; viewport.value.y += event.deltaY / viewport.value.zoom } }
function deleteSelected() { flush(); const removable = new Set(selectedElements.value.filter(e => !e.locked).map(e => e.id)); if (!removable.size) return; removeElements(removable); selected.value = []; commit('删除图形') }
function copySelected() {
  flush(); clipboard = clone(selectedElements.value)
  for (const e of clipboard) if (e.type === 'edge') { const points = edgePoints(e, draft.value); e.from = { ...e.from, ...points[0] }; e.to = { ...e.to, ...points[points.length - 1] } }
  if (clipboard.length) emit('status', `已复制 ${clipboard.length} 个元素`)
}
function pasteSelected() {
  if (!clipboard.length) return
  flush(); if (!canAdd(clipboard.length, clipboard.reduce((count, e) => count + (e.type === 'stroke' ? e.points.length : 0), 0))) return
  const groups = new Map([...new Set(clipboard.flatMap(e => e.groupId ? [e.groupId] : []))].map(id => [id, newId('group')]))
  const ids = new Map(clipboard.map(e => [e.id, newId()])), shapeIds = new Set(draft.value.elements.filter(e => e.type === 'shape').map(e => e.id)), elements = clone(clipboard)
  for (const e of elements) {
    e.id = ids.get(e.id)!; e.locked = false; if (e.groupId) e.groupId = groups.get(e.groupId)
    if (e.type === 'edge') for (const endpoint of [e.from, e.to]) if (endpoint.nodeId) { if (ids.has(endpoint.nodeId)) endpoint.nodeId = ids.get(endpoint.nodeId); else if (!shapeIds.has(endpoint.nodeId)) delete endpoint.nodeId }
    translateElement(e, 24, 24)
  }
  draft.value.elements.push(...elements); selected.value = elements.map(e => e.id)
  if (commit('粘贴图形')) clipboard = clone(elements)
  focusStage()
}
function duplicateSelected() { copySelected(); pasteSelected() }
function updateStyle(key: keyof ElementStyle, value: string | number | boolean) {
  if (key === 'strokeWidth' || key === 'fontSize' || key === 'opacity') { const number = typeof value === 'string' && !value.trim() ? NaN : Number(value); value = Number.isFinite(number) ? Math.max(key === 'fontSize' ? 1 : 0, Math.min(key === 'fontSize' ? 500 : key === 'strokeWidth' ? 100 : 1, number)) : (primary.value?.style[key] ?? activeStyle.value[key]) }
  const patch = { [key]: value, ...(key === 'strokePattern' ? { dashed: value !== 'solid' } : key === 'dashed' ? { strokePattern: value ? 'dashed' : 'solid' } : {}) }; activeStyle.value = { ...activeStyle.value, ...patch } as ElementStyle; for (const e of selectedElements.value) if (!e.locked) e.style = { ...e.style, ...patch } as ElementStyle; if (selectedElements.value.some(e => !e.locked)) commit('修改样式')
}
function updateText(value: string) { const e = primary.value; if (!e || e.locked) return; if (e.type === 'shape') e.text = value.slice(0, 100000); else if (e.type === 'edge') e.label = value.slice(0, 100000); commit('修改文字') }
function updateEdge(key: 'route' | 'arrow', value: string) { const e = primary.value; if (e?.type === 'edge' && !e.locked) { if (key === 'route') e.route = value as EdgeElement['route']; else e.arrow = value as EdgeElement['arrow']; commit('修改连线') } }
function insertBoardTemplate(id: string) {
  flush()
  const preset = id === 'flow' || id === 'board' ? createDocument(id, true).scene : createBoardTemplate(id), defaults = globalStyle.value
  const scene = applyGlobalLineStyle(preset, { roughness: defaults.roughness, strokePattern: resolveStrokePattern(defaults), strokeWidth: defaults.strokeWidth, stroke: defaults.stroke })
  if (!canAdd(scene.elements.length, scene.elements.reduce((count, element) => count + (element.type === 'stroke' ? element.points.length : 0), 0))) return
  const ids = new Map(scene.elements.map(element => [element.id, newId()])), groups = new Map(scene.elements.flatMap(element => element.groupId ? [[element.groupId, newId('group')] as const] : []))
  for (const element of scene.elements) {
    element.id = ids.get(element.id)!
    if (element.groupId) element.groupId = groups.get(element.groupId)
    if (element.type === 'edge') for (const endpoint of [element.from, element.to]) if (endpoint.nodeId) endpoint.nodeId = ids.get(endpoint.nodeId)
  }
  const bounds = sceneBounds(scene), v = viewport.value, dx = v.x + v.width / v.zoom / 2 - bounds.x - bounds.width / 2, dy = v.y + v.height / v.zoom / 2 - bounds.y - bounds.height / 2
  for (const element of scene.elements) translateElement(element, dx, dy)
  draft.value.elements.push(...scene.elements); selected.value = scene.elements.map(element => element.id); boardTemplatesOpen.value = false
  if (commit('插入画布模板')) nextTick(fitCanvas)
  focusStage()
}
function updateGlobalStyle(key: 'roughness' | 'strokePattern' | 'strokeWidth' | 'stroke', value: string | number) {
  flush()
  if (key === 'strokeWidth') { const width = typeof value === 'string' && !value.trim() ? NaN : Number(value); if (!Number.isFinite(width)) { const input = editor.value?.querySelector<HTMLInputElement>('#global-width'); if (input) input.value = String(globalStyle.value.strokeWidth); return }; value = Math.max(0, Math.min(100, width)) }
  draft.value = applyGlobalLineStyle(draft.value, { [key]: value }); activeStyle.value = sceneDefaultStyle(draft.value); commit('修改全局线条风格')
}
function reorder(operation: 'front' | 'back' | 'forward' | 'backward') { flush(); draft.value = reorderElements(draft.value, selected.value, operation); commit(({ front: '移到顶层', back: '移到底层', forward: '上移一层', backward: '下移一层' })[operation]) }
function openContextMenu(event: MouseEvent) {
  event.preventDefault(); flush(); globalStyleOpen.value = false; boardTemplatesOpen.value = false; edgeDefaultsOpen.value = false; brushSettingsOpen.value = false; bindingTarget.value = undefined
  const target = event.target instanceof Element ? event.target.closest('[data-element-id]')?.getAttribute('data-element-id') : undefined
  if (target && !selected.value.includes(target)) selected.value = expandedSelection(draft.value, [target])
  if (!target && !(event.shiftKey)) selected.value = []
  contextMenu.value = { x: event.clientX, y: event.clientY }
}
function closeContextMenu() { contextMenu.value = undefined; nextTick(() => { if (!editingId.value && document.activeElement === document.body) stage.value?.focus({ preventScroll: true }) }) }
function contextAction(action: string) {
  contextMenu.value = undefined
  if (action === 'edit-text') startEdit(primary.value)
  else if (action === 'copy') copySelected()
  else if (action === 'duplicate') duplicateSelected()
  else if (action === 'paste') pasteSelected()
  else if (action === 'select-all') selected.value = draft.value.elements.map(e => e.id)
  else if (action === 'lock') toggleLock()
  else if (action === 'group') groupSelection()
  else if (action === 'ungroup') groupSelection(true)
  else if (action === 'delete') deleteSelected()
  else if (['front', 'back', 'forward', 'backward'].includes(action)) reorder(action as 'front' | 'back' | 'forward' | 'backward')
  else if (action.startsWith('export-')) { flush(); emit('export', action.endsWith('png') ? 'png' : 'svg', action.includes('selection') ? selectionScene(draft.value, selected.value) : undefined) }
}
function groupSelection(ungroup = false) { flush(); draft.value = ungroup ? ungroupElements(draft.value, selected.value) : groupElements(draft.value, selected.value); selected.value = expandedSelection(draft.value, selected.value); commit(ungroup ? '取消组合' : '组合元素'); focusStage() }
function alignSelection(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') { flush(); draft.value = alignElements(draft.value, selected.value, mode); commit('对齐元素'); focusStage() }
function distributeSelection(axis: 'horizontal' | 'vertical') { flush(); draft.value = distributeElements(draft.value, selected.value, axis); commit('均匀分布元素'); focusStage() }
function toggleLock() { const lock = !selectedElements.value.every(e => e.locked); for (const e of selectedElements.value) e.locked = lock; commit(lock ? '锁定图形' : '解锁图形') }
function toggleGrid() { flush(); draft.value.grid = !draft.value.grid; commit('切换网格') }
function autoLayout() { flush(); edgeDefaultsOpen.value = false; brushSettingsOpen.value = false; globalStyleOpen.value = false; boardTemplatesOpen.value = false; draft.value = layoutScene(draft.value); commit('自动布局'); nextTick(fitCanvas) }
async function importImage(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (!file) return; flush(); if (!canAdd()) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { emit('status', '请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片'); return }
  try { const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file) }); if (!safeImageData(data)) throw Error('格式无效'); const image = new Image(); await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = reject; image.src = data }); const v = viewport.value, width = Math.min(420, image.naturalWidth), height = width * image.naturalHeight / image.naturalWidth, node = makeShape('image', { x: v.x + v.width / v.zoom / 2 - width / 2, y: v.y + v.height / v.zoom / 2 - height / 2 }); node.width = width; node.height = height; node.imageData = data; node.text = file.name; draft.value.elements.push(node); selected.value = [node.id]; commit('添加图片') } catch { emit('status', '图片无法读取，请选择有效的本地图片文件') }
}
function keyDown(event: KeyboardEvent) {
  if (event.target instanceof HTMLElement && (event.target.closest('input,textarea,select,button,a') || event.target.isContentEditable)) return
  const command = event.ctrlKey || event.metaKey
  if (command && ['z', 'y', 's'].includes(event.key.toLowerCase())) return
  if (event.code === 'Space') { event.preventDefault(); spaceHeld.value = true; return }
  if (event.key === 'Escape') { contextMenu.value = undefined; globalStyleOpen.value = false; boardTemplatesOpen.value = false; edgeDefaultsOpen.value = false; brushSettingsOpen.value = false; laserTrails.value = []; cancelGesture(); selected.value = []; tool.value = 'select'; toolLocked.value = false; return }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); return }
  if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); selected.value = draft.value.elements.map(e => e.id); return }
  if (command && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected(); return }
  if (command && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteSelected(); return }
  if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); return }
  if (command && event.key.toLowerCase() === 'g') { event.preventDefault(); groupSelection(event.shiftKey); return }
  if (command) return
  if (event.key.startsWith('Arrow') && selected.value.length) { event.preventDefault(); const delta = event.shiftKey ? 10 : 1, dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0, dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0; const movingIds = new Set(movableSelection(draft.value)); for (const e of draft.value.elements) if (movingIds.has(e.id)) translateElement(e, dx, dy); commit('移动图形'); return }
  if (event.key === 'Enter') { event.preventDefault(); startEdit(primary.value); return }
  const shortcut = tools.find(t => t.shortcut?.toLowerCase() === event.key.toLowerCase()); if (shortcut) { event.preventDefault(); setTool(shortcut.id) }
  if (event.key === '0') fitCanvas()
}
function releaseSpace(event: KeyboardEvent) { if (event.code === 'Space') spaceHeld.value = false }
function windowBlur() { spaceHeld.value = false; finishGesture(false) }
onMounted(() => { observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (!rect) return; viewport.value.width = rect.width; viewport.value.height = rect.height; if (!initialFit && rect.width && rect.height) { initialFit = true; fitCanvas() } }); if (stage.value) observer.observe(stage.value); window.addEventListener('keyup', releaseSpace); window.addEventListener('blur', windowBlur); focusStage() })
onBeforeUnmount(() => { if (laserFrame !== undefined) cancelAnimationFrame(laserFrame); releaseCapture(); observer?.disconnect(); window.removeEventListener('keyup', releaseSpace); window.removeEventListener('blur', windowBlur) })
</script>

<template>
  <section ref="editor" class="scene-editor" @keydown="keyDown" @input.capture="markControlDirty" @change.capture="clearControlDirty" data-testid="scene-editor">
    <div class="canvas-commandbar" @pointerdown.stop>
      <div class="toolset" role="toolbar" aria-label="画布工具">
        <button aria-label="图形素材面板" title="图形素材" :aria-pressed="libraryOpen" @click="edgeDefaultsOpen = false; brushSettingsOpen = false; libraryOpen = !libraryOpen"><AppIcon name="shapes" /></button>
        <button v-for="item in tools" :key="item.id" :aria-label="item.label" :title="`${item.label} (${item.shortcut})`" :aria-pressed="tool === item.id" :class="{ active: tool === item.id }" @click="setTool(item.id)" :data-testid="`tool-${item.id}`"><AppIcon :name="item.icon" :size="20" /></button>
        <span class="tool-divider" />
        <button aria-label="插入图片" title="插入本地图片" @click="imageInput?.click()"><AppIcon name="image" :size="20" /></button>
      </div>
      <div class="commandbar-actions">
        <button class="brush-settings-toggle" aria-label="笔触设置" :title="`笔触设置 · ${brushName}`" :aria-expanded="brushSettingsOpen" data-testid="brush-settings-toggle" @click="toggleBrushSettings"><AppIcon name="brushes" /></button>
        <button class="tool-lock-toggle" aria-label="连续绘制" :title="toolLocked ? '连续绘制已开启 · Esc 返回选择' : '开启连续绘制'" :aria-pressed="toolLocked" data-testid="tool-lock" @click="toggleToolLock"><AppIcon :name="toolLocked ? 'lock' : 'unlock'" /></button>
        <button aria-label="新建连线设置" :title="`新建连线 · ${defaultEdgeRoute === 'straight' ? '直线' : '折线'} · ${defaultEdgeArrow === 'none' ? '无箭头' : defaultEdgeArrow === 'both' ? '双箭头' : '单箭头'}`" :aria-expanded="edgeDefaultsOpen" data-testid="edge-defaults-toggle" @click="toggleEdgeDefaults"><AppIcon :name="defaultEdgeRoute === 'straight' ? 'edge-straight' : 'edge-orthogonal'" /></button>
        <button aria-label="画布模板" title="画布模板" :aria-expanded="boardTemplatesOpen" @click="flush(); globalStyleOpen = false; edgeDefaultsOpen = false; brushSettingsOpen = false; boardTemplatesOpen = !boardTemplatesOpen" data-testid="board-template-toggle"><AppIcon name="templates" /></button>
        <button class="style-trigger" aria-label="全局线条风格" :title="`全局线条风格 · ${globalStyle.roughness === 'sketch' ? '手绘' : '整洁'}`" :aria-expanded="globalStyleOpen" @click="flush(); boardTemplatesOpen = false; edgeDefaultsOpen = false; brushSettingsOpen = false; globalStyleOpen = !globalStyleOpen" data-testid="global-style-toggle"><AppIcon name="style" /><span class="style-trigger-label">全局线条<small>{{ globalStyle.roughness === 'sketch' ? '手绘' : '整洁' }}</small></span><AppIcon class="style-trigger-chevron" name="chevron" :size="12" /></button>
        <button class="layout-trigger" @click="autoLayout" title="自动布局" aria-label="自动布局" data-testid="canvas-auto-layout"><AppIcon name="auto-layout" /><span>自动布局</span></button>
        <button :aria-pressed="propertiesOpen" @click="propertiesOpen = !propertiesOpen" title="切换属性面板" aria-label="属性面板"><AppIcon name="sliders" /></button>
      </div>
      <div v-if="brushSettingsOpen" class="brush-settings-popover"><BrushPanel :settings="brushSettings" @choose="chooseBrush" @change="updateBrushSettings" @close="brushSettingsOpen = false; focusStage()" @start="setTool(brushSettings.kind === 'highlighter' ? 'highlighter' : 'pen')" /></div>
      <div v-if="edgeDefaultsOpen" class="edge-defaults-panel" role="region" aria-label="新建连线设置" data-testid="edge-defaults-panel" @keydown.escape.stop="edgeDefaultsOpen = false; focusStage()">
        <div class="panel-heading">新建连线<button aria-label="关闭新建连线设置" @click="edgeDefaultsOpen = false; focusStage()"><AppIcon name="close" :size="15" /></button></div>
        <div class="edge-default-group" role="group" aria-label="新建连线路径"><span>路径</span><div><button v-for="option in edgeRouteOptions" :key="option.value" :aria-pressed="defaultEdgeRoute === option.value" :data-testid="`default-route-${option.value}`" @click="defaultEdgeRoute = option.value"><AppIcon :name="option.icon" :size="21"/><small>{{ option.label }}</small></button></div></div>
        <div class="edge-default-group" role="group" aria-label="新建连线箭头"><span>箭头</span><div><button v-for="option in edgeArrowOptions" :key="option.value" :aria-pressed="defaultEdgeArrow === option.value" :data-testid="`default-arrow-${option.value}`" @click="defaultEdgeArrow = option.value"><AppIcon :name="option.icon" :size="21"/><small>{{ option.label }}</small></button></div></div>
        <p>应用于接下来绘制的连线。选中已有连线后，可在属性中单独调整。</p><button class="start-edge-drawing" @click="setTool('edge')"><AppIcon name="connector" :size="15"/>开始连线</button>
      </div>
      <div v-if="boardTemplatesOpen" class="board-template-popover"><BoardTemplatePanel @insert="insertBoardTemplate" @close="boardTemplatesOpen = false; focusStage()" /></div>
      <div v-if="globalStyleOpen" class="global-style-panel" role="region" aria-label="全局线条风格" @keydown.escape.stop="globalStyleOpen = false; focusStage()">
        <div class="panel-heading">全局线条<button aria-label="关闭全局线条设置" @click="globalStyleOpen = false"><AppIcon name="close" :size="15" /></button></div>
        <div class="line-mode-options"><button :aria-pressed="globalStyle.roughness !== 'sketch'" @click="updateGlobalStyle('roughness', 'clean')" data-testid="global-line-clean"><svg viewBox="0 0 60 24"><path d="M6 17 L24 7 L40 17 L54 7" /></svg><span>整洁</span></button><button :aria-pressed="globalStyle.roughness === 'sketch'" @click="updateGlobalStyle('roughness', 'sketch')" data-testid="global-line-sketch"><svg viewBox="0 0 60 24"><path d="M6 17 Q14 10 24 7 Q33 15 40 17 Q47 9 54 7 M7 18 Q15 11 25 8 Q31 16 41 16 Q48 9 54 6" /></svg><span>手绘</span></button></div>
        <div class="property-row"><label for="global-pattern">线型</label><select id="global-pattern" :value="resolveStrokePattern(globalStyle)" @change="updateGlobalStyle('strokePattern', ($event.target as HTMLSelectElement).value)"><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option></select></div>
        <div class="property-row"><label for="global-width">线宽</label><input id="global-width" type="number" min="0" max="100" :value="globalStyle.strokeWidth" @change="updateGlobalStyle('strokeWidth', ($event.target as HTMLInputElement).value)" /></div>
        <div class="property-row"><label for="global-stroke">线条颜色</label><input id="global-stroke" type="color" :value="globalStyle.stroke" @change="updateGlobalStyle('stroke', ($event.target as HTMLInputElement).value)" /></div>
        <p class="global-style-hint">应用到整张画布，并用于新建图形和连线。<br />已有笔迹可统一粗细和颜色，保留笔尖效果；彩虹笔保持多色。新笔迹使用笔触面板的设置。</p>
      </div>
      <input ref="imageInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="importImage" />
    </div>
    <div class="canvas-workspace" :style="{ background: draft.background }">
      <aside v-if="libraryOpen" class="shape-library" aria-label="图形素材"><div class="panel-heading">图形素材 <button aria-label="关闭图形素材" @click="libraryOpen = false"><AppIcon name="close" :size="15" /></button></div><div class="library-caption">选择形状后在画布上拖动</div><div class="shape-grid"><button v-for="item in shapePalette" :key="item.shape" @click="setTool(item.shape)" :aria-pressed="tool === item.shape" :aria-label="`绘制${item.text}`" :data-testid="`shape-${item.shape}`"><AppIcon :name="item.icon" :size="27" /><small>{{ item.text }}</small></button></div><div class="library-hint">双击图形编辑文字<br />Shift 拖动绘制正形<br />按住空格移动画布</div></aside>
      <div ref="stage" class="canvas-stage" :class="{ 'is-panning': spaceHeld || tool === 'hand', 'is-drawing': !['select', 'hand'].includes(tool) }" tabindex="0" role="application" aria-label="绘图画布" data-testid="canvas-stage" @pointerdown="pointerDown($event)" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="cancelGesture" @wheel.prevent="wheel" @dblclick="backgroundDoubleClick" @contextmenu="openContextMenu" @pointerleave="!gesture && (bindingTarget = undefined)">
        <svg class="scene-svg" :viewBox="viewBox" width="100%" height="100%" aria-label="工作流画布">
          <defs><pattern :id="gridId" patternUnits="userSpaceOnUse" :x="-grid.step / 2" :y="-grid.step / 2" :width="grid.step" :height="grid.step" data-testid="canvas-grid-pattern"><circle :cx="grid.step / 2" :cy="grid.step / 2" :r="grid.radius" :fill="grid.color" :opacity="grid.opacity" /></pattern></defs>
          <rect v-if="draft.grid" :x="viewport.x" :y="viewport.y" :width="viewport.width / viewport.zoom" :height="viewport.height / viewport.zoom" :fill="`url(#${gridId})`" data-testid="canvas-grid" />
          <g v-for="element in draft.elements" :key="element.id" :data-element-id="element.id" :data-element-type="element.type" :class="{ 'canvas-element': true, 'element-locked': element.locked }" @pointerdown="pointerDown($event, element)" @dblclick.stop="startEdit(element)" v-html="elementMarkup(element)" />
          <g v-if="bindingTarget" class="binding-preview" pointer-events="none" :data-binding-target="bindingTarget.id" data-testid="binding-preview"><rect :x="bindingTarget.x - 5 / viewport.zoom" :y="bindingTarget.y - 5 / viewport.zoom" :width="bindingTarget.width + 10 / viewport.zoom" :height="bindingTarget.height + 10 / viewport.zoom" :rx="8 / viewport.zoom" fill="#7c6aee10" stroke="#7c6aee" :stroke-width="2 / viewport.zoom" /><circle v-for="(point, index) in bindingAnchors" :key="index" :cx="point.x" :cy="point.y" :r="3.5 / viewport.zoom" fill="#ffffff" stroke="#7c6aee" :stroke-width="1.5 / viewport.zoom" /></g>
          <g v-if="selectedBounds" class="selection-overlay" pointer-events="none"><rect :x="selectedBounds.x - 5 / viewport.zoom" :y="selectedBounds.y - 5 / viewport.zoom" :width="selectedBounds.width + 10 / viewport.zoom" :height="selectedBounds.height + 10 / viewport.zoom" fill="none" stroke="#7c6aee" :stroke-width="1.5 / viewport.zoom" :stroke-dasharray="selectedElements.length > 1 ? '6 4' : undefined" /><rect v-if="tool === 'select' && primary?.type === 'shape' && !primary.locked" :x="primary.x + primary.width - 5 / viewport.zoom" :y="primary.y + primary.height - 5 / viewport.zoom" :width="10 / viewport.zoom" :height="10 / viewport.zoom" fill="#ffffff" stroke="#7c6aee" :stroke-width="1.5 / viewport.zoom" pointer-events="all" class="resize-handle" data-testid="resize-handle" @pointerdown.stop="pointerDown($event, primary, true)" /></g>
          <g v-if="edgeHandles.length" class="edge-handles"><circle v-for="handle in edgeHandles" :key="handle.endpoint" :cx="handle.x" :cy="handle.y" :r="6 / viewport.zoom" :stroke-width="2 / viewport.zoom" fill="#fff" stroke="#7c6aee" :data-testid="`edge-handle-${handle.endpoint}`" @pointerdown.stop="startEndpointDrag($event, handle.endpoint)" /></g>
          <g v-for="trail in laserTrails" :key="trail.id" data-testid="laser-trail" :opacity="trail.opacity" pointer-events="none" class="laser-trail"><path :d="laserPath(trail.points)" fill="none" stroke="#ff4d65" :stroke-width="4 / viewport.zoom" stroke-linecap="round" stroke-linejoin="round" /><circle v-if="trail.points.length" :cx="trail.points[trail.points.length - 1]!.x" :cy="trail.points[trail.points.length - 1]!.y" :r="5 / viewport.zoom" fill="#ff4d65" /><circle v-if="trail.points.length" :cx="trail.points[trail.points.length - 1]!.x" :cy="trail.points[trail.points.length - 1]!.y" :r="2 / viewport.zoom" fill="#fff" /></g>
          <rect v-if="marquee" v-bind="marquee" fill="#7c6aee18" stroke="#7c6aee" :stroke-width="1 / viewport.zoom" pointer-events="none" />
        </svg>
        <textarea v-if="editingNode" ref="textInput" v-model="editText" maxlength="100000" class="inline-text-editor" :style="editPosition" :aria-label="editingNode.type === 'edge' ? '编辑连线文字' : '编辑图形文字'" @blur="flush" @keydown.escape.stop="editingId = undefined; focusStage()" @keydown.enter.ctrl.prevent="flush(); focusStage()" @keydown.enter.meta.prevent="flush(); focusStage()" @pointerdown.stop />
        <div v-if="!draft.elements.length" class="empty-canvas"><div class="empty-canvas-icon"><AppIcon name="canvas" :size="32" /></div><strong>让想法，在画布上展开</strong><span>画流程、写便签，或从画布模板开始</span><small>拖动箭头自动吸附 · 右键调整图层、导出</small></div>
        <div class="canvas-bottom" @pointerdown.stop><div class="canvas-hint">{{ tool === 'laser' ? '按住拖动进行指示 · 轨迹自动消失，不保存到文档' : selected.length ? `已选 ${selected.length} 个元素${selectedElements.some(e => e.locked) ? ' · 包含锁定元素' : ''}` : tool === 'edge' ? bindingTarget ? '松开即可连接 · 图形移动后连线自动跟随' : '拖到图形附近即可吸附 · 拖动端点可重新连接' : '双击图形写字 · 右键图层与导出 · 空格拖动' }}</div><div class="zoom-controls"><button class="grid-toggle" aria-label="点阵网格" :title="draft.grid ? '隐藏点阵网格' : '显示点阵网格'" :aria-pressed="draft.grid" data-testid="canvas-grid-toggle" @click.stop="toggleGrid"><AppIcon name="grid-dots" :size="18" /></button><span /><button aria-label="缩小" @click.stop="zoomTo(viewport.zoom / 1.2)"><AppIcon name="minus" :size="16" /></button><button class="zoom-value" title="重置为 100%" @click.stop="zoomTo(1)">{{ zoomLabel }}</button><button aria-label="放大" @click.stop="zoomTo(viewport.zoom * 1.2)"><AppIcon name="plus" :size="16" /></button><span /><button aria-label="适应画布" title="适应画布 (0)" @click.stop="fitCanvas"><AppIcon name="fit" :size="16" /></button></div></div>
      </div>
      <aside v-if="propertiesOpen" class="properties-panel" aria-label="属性面板"><div class="panel-heading">{{ selected.length ? '图形属性' : '画布设置' }}<small v-if="selected.length">{{ selected.length }} 个</small><button aria-label="关闭属性面板" @click="propertiesOpen = false"><AppIcon name="close" :size="15" /></button></div>
        <template v-if="selected.length"><div v-if="primary?.type === 'shape' || primary?.type === 'edge'" class="property-section"><label :for="`element-text-${primary.id}`">{{ primary.type === 'edge' ? '连线标签' : '文字内容' }}</label><textarea ref="propertyTextInput" :id="`element-text-${primary.id}`" :value="primary.type === 'shape' ? primary.text : primary.label" :disabled="primary.locked" @change="updateText(($event.target as HTMLTextAreaElement).value)" rows="3" maxlength="100000" data-testid="property-text" /></div>
          <div v-if="primary?.type === 'shape' && primary.shape === 'note'" class="property-section"><h3>便签颜色</h3><div class="note-color-palette"><button v-for="color in noteColors" :key="color" :style="{ background: color }" :aria-label="`便签颜色 ${color}`" :aria-pressed="primary.style.fill === color" :disabled="primary.locked" @click="updateStyle('fill', color)"><AppIcon v-if="primary.style.fill === color" name="check" :size="15" /></button></div></div>
          <div v-if="primary?.type === 'stroke'" class="property-section"><h3>笔迹</h3><div class="property-row"><label for="selected-brush">笔触类型</label><select id="selected-brush" data-testid="selected-brush" :value="primary.brush || ''" :disabled="primary.locked" @change="updateSelectedBrush(($event.target as HTMLSelectElement).value)"><option v-if="!primary.brush" value="" disabled>原始笔迹</option><option v-for="preset in BRUSH_PRESETS" :key="preset.id" :value="preset.id">{{ preset.label }}</option></select></div><p class="group-hint">只修改当前笔迹，可撤销。新笔迹的设置请使用顶部笔触面板。</p></div>
          <div class="property-section"><h3>外观</h3><div class="property-row"><label for="element-fill">填充</label><input id="element-fill" type="color" :value="primary?.style.fill?.startsWith('#') && primary.style.fill.length === 7 ? primary.style.fill : '#ffffff'" @change="updateStyle('fill', ($event.target as HTMLInputElement).value)" /><button class="mini-button" @click="updateStyle('fill', 'none')" title="无填充">无</button></div><div class="property-row"><label for="element-stroke">线条 / 文字</label><input id="element-stroke" type="color" :disabled="primary?.type === 'stroke' && primary.brush === 'rainbow'" :value="primary?.style.stroke?.startsWith('#') && primary.style.stroke.length === 7 ? primary.style.stroke : '#334155'" @change="updateStyle('stroke', ($event.target as HTMLInputElement).value)" /></div><div class="property-row"><label for="element-width">线宽</label><input id="element-width" type="number" min="0" max="100" :value="primary?.style.strokeWidth ?? 2" @change="updateStyle('strokeWidth', ($event.target as HTMLInputElement).value)" /></div><div class="property-row"><label for="element-opacity">透明度</label><input id="element-opacity" type="number" min="0" max="1" step="0.05" :value="primary?.style.opacity ?? 1" @change="updateStyle('opacity', ($event.target as HTMLInputElement).value)" /></div><div class="property-row"><label for="element-font">字号</label><input id="element-font" type="number" min="1" max="500" :value="primary?.style.fontSize ?? 16" @change="updateStyle('fontSize', ($event.target as HTMLInputElement).value)" /></div><div class="property-row"><label for="element-align">对齐</label><select id="element-align" :value="primary?.style.textAlign ?? 'center'" @change="updateStyle('textAlign', ($event.target as HTMLSelectElement).value)"><option value="left">居左</option><option value="center">居中</option><option value="right">居右</option></select></div><div v-if="hasLineStyleSelection" class="property-row"><label for="element-roughness">风格</label><select id="element-roughness" :value="primary?.style.roughness ?? 'clean'" @change="updateStyle('roughness', ($event.target as HTMLSelectElement).value)"><option value="clean">整洁</option><option value="sketch">手绘</option></select></div><div v-if="hasLineStyleSelection" class="property-row"><label for="element-pattern">线型</label><select id="element-pattern" :value="primary ? resolveStrokePattern(primary.style) : 'solid'" @change="updateStyle('strokePattern', ($event.target as HTMLSelectElement).value)"><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option></select></div><p v-if="hasBrushSelection && hasLineStyleSelection" class="group-hint">专用笔触保留笔尖效果，不使用风格与线型设置。</p></div>
          <div v-if="primary?.type === 'edge'" class="property-section"><h3>连接方式</h3><div class="property-row"><label for="edge-route">路径</label><select id="edge-route" :value="primary.route" @change="updateEdge('route', ($event.target as HTMLSelectElement).value)"><option value="orthogonal">直角连线</option><option value="straight">直线</option></select></div><div class="property-row"><label for="edge-arrow">箭头</label><select id="edge-arrow" :value="primary.arrow" @change="updateEdge('arrow', ($event.target as HTMLSelectElement).value)"><option value="end">单向</option><option value="both">双向</option><option value="none">无箭头</option></select></div></div>
          <div v-if="selected.length > 1 || selectedElements.some(e => e.groupId)" class="property-section"><h3>组合与整理</h3><div class="property-buttons"><button :disabled="selectedElements.filter(e => !e.locked).length < 2" @click="groupSelection()" data-testid="group-selection"><AppIcon name="group" :size="14" />组合</button><button :disabled="!selectedElements.some(e => e.groupId && !e.locked)" @click="groupSelection(true)" data-testid="ungroup-selection"><AppIcon name="ungroup" :size="14" />取消组合</button></div><div v-if="selected.length > 1" class="alignment-buttons"><button v-for="item in alignmentOptions" :key="item.id" :aria-label="item.label" :title="item.label" @click="alignSelection(item.id)" :data-testid="`align-${item.id}`"><AppIcon :name="`align-${item.id}`" :size="17" /></button><button aria-label="水平等距分布" title="水平等距分布" :disabled="selected.length < 3" @click="distributeSelection('horizontal')" data-testid="distribute-horizontal"><AppIcon name="distribute-horizontal" :size="17" /></button><button aria-label="垂直等距分布" title="垂直等距分布" :disabled="selected.length < 3" @click="distributeSelection('vertical')" data-testid="distribute-vertical"><AppIcon name="distribute-vertical" :size="17" /></button></div><p class="group-hint">点击组合整体选择 · Alt + 点击选择成员<br />Ctrl / ⌘ + G 组合，添加 Shift 取消组合</p></div>
          <div class="property-section"><h3>排列与操作</h3><div class="property-buttons"><button @click="reorder('front')">移到顶层</button><button @click="reorder('back')">移到底层</button><button @click="reorder('forward')">上移一层</button><button @click="reorder('backward')">下移一层</button><button @click="duplicateSelected">复制一份</button><button @click="toggleLock">{{ selectedElements.every(e => e.locked) ? '解锁' : '锁定' }}</button></div><button class="delete-button" @click="deleteSelected">删除所选</button></div>
        </template>
        <div v-else class="property-section"><h3>显示</h3><label class="check-row"><input type="checkbox" :checked="draft.grid" @change="toggleGrid" />显示点阵网格</label><label class="check-row"><input type="checkbox" v-model="snapEnabled" />吸附到网格</label><div class="property-row"><label for="scene-background">背景颜色</label><input id="scene-background" type="color" :value="draft.background" @change="draft.background = ($event.target as HTMLInputElement).value; commit('修改背景')" /></div><button class="open-global-style" @click="boardTemplatesOpen = false; brushSettingsOpen = false; globalStyleOpen = true">全局线条风格<AppIcon name="style" :size="16" /></button><p class="property-tip">双击图形编辑文字，右键打开操作菜单。<br /><br />Shift + 点击：多选<br />方向键：微调位置<br />Delete：删除所选<br />Ctrl / ⌘ + D：复制</p></div>
      </aside>
    </div>
    <CanvasContextMenu v-if="contextMenu" :x="contextMenu.x" :y="contextMenu.y" :has-selection="!!selected.length" :can-edit-text="!!primary && !primary.locked && (primary.type === 'edge' || (primary.type === 'shape' && primary.shape !== 'image'))" :has-unlocked="selectedElements.some(e => !e.locked)" :all-locked="!!selected.length && selectedElements.every(e => e.locked)" :can-paste="!!clipboard.length" :can-group="selectedElements.filter(e => !e.locked).length > 1" :can-ungroup="selectedElements.some(e => e.groupId && !e.locked)" @action="contextAction" @close="closeContextMenu" />
  </section>
</template>

<style scoped>
.scene-editor{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--ui-bg,#f7f8fc);color:var(--ui-text,#273044);font-size:13px}.scene-editor button,.scene-editor input,.scene-editor textarea,.scene-editor select{font:inherit}.scene-editor button{cursor:pointer;color:inherit}.canvas-commandbar{height:58px;min-height:58px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--ui-line,#e8eaf1);background:var(--ui-surface,#fff);padding:0 16px;gap:12px}.toolset,.commandbar-actions{display:flex;gap:4px;align-items:center}.toolset button,.commandbar-actions button{width:35px;height:35px;border:1px solid transparent;border-radius:8px;background:transparent;font-size:22px;display:grid;place-items:center;line-height:1}.toolset button:hover,.commandbar-actions button:hover{background:var(--ui-bg,#f4f4fa)}.toolset button.active{color:var(--ui-accent,#7861e9);background:#8670ef14;border-color:#8d76ed30}.tool-divider{width:1px;height:24px;background:var(--ui-line,#e8eaf1);margin:0 6px}.commandbar-actions .text-button{width:auto;font-size:12px;padding:0 10px}.canvas-workspace{display:flex;flex:1;min-height:0;min-width:0}.shape-library{width:172px;flex:0 0 172px;border-right:1px solid var(--ui-line,#e8eaf1);background:var(--ui-surface,#fff);padding:20px 14px;overflow:auto}.panel-heading{font-size:12px;letter-spacing:.03em;font-weight:650;display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.panel-heading>span,.panel-heading>small{color:var(--ui-muted,#8c96a7);font-size:12px;font-weight:400}.library-caption{font-size:11px;color:var(--ui-muted,#8c96a7);margin-bottom:12px}.shape-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.shape-grid button{height:79px;background:var(--ui-surface,#fff);border:1px solid var(--ui-line,#e8eaf1);border-radius:9px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}.shape-grid button:hover{border-color:var(--ui-accent,#7861e9);background:#8670ef07}.shape-grid button>span{font-size:27px;color:#7d879a;line-height:1}.shape-grid small{font-size:10px;color:var(--ui-muted,#8c96a7)}.library-hint{font-size:10px;line-height:2.1;color:var(--ui-muted,#8c96a7);margin-top:30px;padding-top:18px;border-top:1px solid var(--ui-line,#e8eaf1)}.canvas-stage{position:relative;flex:1;min-width:0;overflow:hidden;outline:none;touch-action:none;user-select:none}.canvas-stage:focus-visible{box-shadow:inset 0 0 0 2px #7c6aee55}.scene-svg{display:block;position:absolute;inset:0;overflow:hidden}.canvas-element{cursor:move}.canvas-element.element-locked{cursor:default}.is-panning,.is-panning .canvas-element{cursor:grab}.is-panning:active{cursor:grabbing}.is-drawing,.is-drawing .canvas-element{cursor:crosshair}.resize-handle{cursor:nwse-resize}.inline-text-editor{position:absolute;z-index:5;padding:10px;border:2px solid #7c6aee;background:#fffffff5;border-radius:5px;resize:none;outline:none;box-sizing:border-box;line-height:1.35;user-select:text}.empty-canvas{pointer-events:none;position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;white-space:nowrap;color:#8993a5}.empty-canvas-icon{width:62px;height:62px;display:grid;place-items:center;background:#8670ef0e;color:#a997e9;border:1px solid #8670ef16;border-radius:18px;font-size:36px;margin-bottom:8px}.empty-canvas strong{font-size:15px;font-weight:500;color:#727f93}.empty-canvas span{font-size:11px}.canvas-bottom{position:absolute;left:20px;right:20px;bottom:18px;display:flex;align-items:center;justify-content:space-between;gap:10px;pointer-events:none}.canvas-hint{font-size:10px;color:#8993a5;padding:7px 9px;background:#ffffffd9;border:1px solid #e8eaf180;border-radius:6px;backdrop-filter:blur(8px)}.zoom-controls{display:flex;align-items:center;background:var(--ui-surface,#fff);border:1px solid var(--ui-line,#e8eaf1);border-radius:9px;padding:4px;box-shadow:0 3px 12px #26345b08;pointer-events:auto}.zoom-controls button{background:none;border:0;height:27px;width:28px;border-radius:5px;font-size:17px}.zoom-controls button:hover{background:var(--ui-bg,#f7f8fc)}.zoom-controls .zoom-value{width:48px;font-size:11px}.zoom-controls>span{height:17px;width:1px;background:var(--ui-line,#e8eaf1);margin:0 4px}.properties-panel{width:218px;flex:0 0 218px;box-sizing:border-box;padding:20px 17px;border-left:1px solid var(--ui-line,#e8eaf1);background:var(--ui-surface,#fff);overflow:auto}.property-section{padding:0 0 20px;margin-bottom:18px;border-bottom:1px solid var(--ui-line,#e8eaf1)}.property-section h3{font-size:11px;font-weight:500;color:var(--ui-muted,#8c96a7);margin:0 0 15px}.property-section>label:not(.check-row){display:block;font-size:11px;margin-bottom:9px;color:var(--ui-muted,#8c96a7)}.property-section textarea{box-sizing:border-box;resize:vertical;width:100%;border:1px solid var(--ui-line,#e8eaf1);border-radius:6px;background:var(--ui-bg,#fafafe);color:var(--ui-text,#273044);font-size:12px;padding:8px;line-height:1.6}.property-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:11px 0;font-size:11px}.property-row>label{flex:1;color:var(--ui-muted,#8c96a7)}.property-row input[type=color]{width:32px;height:25px;padding:2px;border:1px solid var(--ui-line,#e8eaf1);border-radius:5px;background:var(--ui-surface,#fff);cursor:pointer}.property-row input[type=number]{width:47px}.property-row input[type=number],.property-row select{border:1px solid var(--ui-line,#e8eaf1);background:var(--ui-bg,#fafafe);border-radius:5px;height:27px;box-sizing:border-box;padding:2px 6px;color:var(--ui-text,#273044);font-size:11px}.property-row select{max-width:103px}.check-row{display:flex;align-items:center;gap:8px;font-size:11px;margin:13px 0;color:var(--ui-muted,#8c96a7)}.check-row input{accent-color:var(--ui-accent,#7861e9)}.mini-button{height:24px;border:1px solid var(--ui-line,#e8eaf1);border-radius:4px;background:transparent;font-size:10px!important}.property-buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px}.property-buttons button,.delete-button{font-size:10px!important;padding:7px 0;background:var(--ui-bg,#fafafe);border:1px solid var(--ui-line,#e8eaf1);border-radius:5px}.property-buttons button:hover{border-color:#9c8ce7}.delete-button{color:#ce5868!important;width:100%;margin-top:9px;background:#ef768609;border-color:#ef768622}.property-tip{font-size:10px;line-height:1.9;color:var(--ui-muted,#8c96a7);margin-top:28px}.board-mode .canvas-commandbar{justify-content:center;position:relative}.board-mode .commandbar-actions{position:absolute;right:16px}.scene-editor :focus-visible{outline:2px solid var(--ui-accent,#7861e9);outline-offset:2px}.scene-editor ::-webkit-scrollbar{width:5px;height:5px}.scene-editor ::-webkit-scrollbar-thumb{background:#bbc1d24f;border-radius:5px}@media(max-width:1100px){.shape-library{width:138px;flex-basis:138px;padding:17px 10px}.properties-panel{width:190px;flex-basis:190px;padding:18px 13px}.canvas-hint{display:none}.canvas-bottom{justify-content:flex-end}}@media(max-width:800px){.shape-library{display:none}.properties-panel{position:absolute;right:0;top:58px;bottom:0;z-index:8;box-shadow:-6px 0 20px #202c4510}.scene-editor{position:relative}.canvas-commandbar{padding:0 8px}.toolset{gap:1px}.toolset button{width:31px}.commandbar-actions .text-button{display:none}.board-mode .canvas-commandbar{justify-content:flex-start}.board-mode .commandbar-actions{right:6px}.tool-divider{margin:0 2px}.empty-canvas strong{font-size:12px}.empty-canvas span{font-size:10px}}@media(max-width:540px){.toolset button{width:27px;font-size:19px}.toolset button[aria-label="判断"],.toolset button[aria-label="移动画布"]{display:none}.properties-panel{width:180px}.canvas-commandbar{gap:3px}.empty-canvas{white-space:normal;width:80%}}
/* The canvas keeps the space; tools live in a compact floating bar. */
.scene-editor{position:relative}
.canvas-commandbar,.board-mode .canvas-commandbar{position:absolute;z-index:10;left:50%;top:14px;transform:translateX(-50%);height:48px;min-height:48px;max-width:calc(100% - 28px);box-sizing:border-box;border:1px solid var(--ui-line);border-radius:12px;padding:5px 8px;gap:8px;box-shadow:0 4px 18px #202c4510;justify-content:space-between}
.toolset{min-width:0;overflow-x:auto;scrollbar-width:none}.toolset::-webkit-scrollbar{display:none}.toolset button{flex-shrink:0}.toolset button,.commandbar-actions button{width:33px;height:34px;font-size:16px}.commandbar-actions{flex-shrink:0}.board-mode .commandbar-actions{position:static}.commandbar-actions .text-button{white-space:nowrap;padding:0 7px}.tool-divider{flex-shrink:0;margin:0 3px;height:21px}
.canvas-workspace{height:100%;position:relative}.shape-library,.properties-panel{align-self:stretch;margin:76px 12px 64px 0;border:1px solid var(--ui-line);border-radius:12px;box-shadow:0 4px 20px #202c450a;padding:16px;box-sizing:border-box}.shape-library{margin-left:12px;margin-right:0;width:158px;flex-basis:158px}.properties-panel{width:216px;flex-basis:216px}.panel-heading{margin-bottom:14px;gap:8px}.panel-heading>small{margin-left:auto}.panel-heading>button{border:0;background:transparent;border-radius:5px;padding:3px;display:grid;place-items:center;color:var(--ui-muted)}.panel-heading>button:hover{background:var(--ui-bg)}.property-section{padding-bottom:14px;margin-bottom:14px}.property-section:last-child{border-bottom:0;margin-bottom:0}.property-section h3{margin-bottom:10px}.property-row{margin:9px 0}.property-tip{margin-top:18px}.shape-grid button{height:68px}.library-hint{margin-top:18px}
.global-style-panel{position:absolute;right:0;top:56px;width:240px;box-sizing:border-box;padding:15px;border:1px solid var(--ui-line);border-radius:12px;background:var(--ui-surface);box-shadow:0 10px 32px #18203922}.line-mode-options{display:flex;gap:8px;margin-bottom:16px}.line-mode-options>button{flex:1;display:flex;flex-direction:column;gap:5px;align-items:center;background:var(--ui-bg);border:1px solid var(--ui-line);border-radius:8px;padding:9px;color:var(--ui-muted);font-size:11px}.line-mode-options>button[aria-pressed=true]{color:var(--ui-accent);border-color:var(--ui-accent);background:#8670ef12}.line-mode-options svg{width:60px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.global-style-hint{font-size:11px;line-height:1.7;margin:14px 0 0;color:var(--ui-muted)}.open-global-style{display:flex;justify-content:space-between;align-items:center;width:100%;margin-top:17px;border:1px solid var(--ui-line);border-radius:7px;background:var(--ui-bg);padding:9px;font-size:11px!important}
.edge-handles circle{cursor:crosshair}.binding-preview{filter:drop-shadow(0 0 3px #7c6aee30)}.inline-text-editor{z-index:6;min-height:44px;box-shadow:0 3px 18px #202c451a}.canvas-bottom{left:16px;right:16px;bottom:16px}.canvas-hint{font-size:10px;max-width:calc(100% - 180px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:1100px){.commandbar-actions .text-button{display:none}.shape-library{width:144px;flex-basis:144px}.properties-panel{width:202px;flex-basis:202px;padding:14px}.canvas-hint{display:none}}
@media(max-width:800px){.canvas-commandbar,.board-mode .canvas-commandbar{left:12px;right:12px;max-width:none;transform:none;justify-content:space-between}.properties-panel{position:absolute;right:0;top:0;bottom:0;z-index:8;width:216px;margin:76px 12px 64px 0}.shape-library{display:block;position:absolute;z-index:8;left:0;top:0;bottom:0;margin-top:76px}.toolset button{width:32px}.board-mode .commandbar-actions{right:auto}.global-style-panel{max-width:calc(100vw - 40px)}}
@media(max-width:540px){.toolset button[aria-label="判断"],.toolset button[aria-label="移动画布"]{display:grid}.toolset button{width:31px}.canvas-commandbar{gap:3px}.commandbar-actions{gap:1px}.commandbar-actions button{width:30px}.empty-canvas{top:46%}}
.alignment-buttons{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:9px}.alignment-buttons button{display:grid;place-items:center;height:30px;border:1px solid var(--ui-line);background:var(--ui-bg);border-radius:5px}.group-hint{font-size:10px;line-height:1.7;color:var(--ui-muted);margin:12px 0 0}.note-color-palette{display:grid;grid-template-columns:repeat(6,1fr);gap:5px}.note-color-palette button{display:grid;place-items:center;height:24px;border:1px solid #33415522;border-radius:5px;color:#334155}.property-buttons button{display:flex;align-items:center;justify-content:center;gap:4px}.scene-editor button:disabled{opacity:.4;cursor:default}.shape-grid button[aria-pressed=true]{border-color:var(--ui-accent);background:#8670ef12}.zoom-controls button{display:grid;place-items:center}
.board-template-popover{position:absolute;right:0;top:56px;width:310px;max-width:calc(100vw - 40px);z-index:11}
.commandbar-actions .layout-trigger{display:flex;align-items:center;justify-content:center;gap:5px;width:auto;padding:0 7px;white-space:nowrap}.layout-trigger>span{font-size:11px}.commandbar-actions .tool-lock-toggle[aria-pressed=true],.commandbar-actions button[aria-expanded=true]{color:var(--ui-accent);background:var(--ui-soft);border-color:var(--ui-line)}
.edge-defaults-panel{position:absolute;right:0;width:240px;max-width:calc(100vw - 40px);box-sizing:border-box;padding:15px;border:1px solid var(--ui-line);border-radius:12px;background:var(--ui-surface);box-shadow:0 10px 32px #18203922}.global-style-panel,.board-template-popover,.edge-defaults-panel{top:calc(100% + 8px)}.edge-default-group{margin:12px 0}.edge-default-group>span{display:block;font-size:11px;color:var(--ui-muted);margin-bottom:7px}.edge-default-group>div{display:flex;gap:7px}.edge-default-group button{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 3px;border:1px solid var(--ui-line);border-radius:6px;background:var(--ui-bg)}.edge-default-group button[aria-pressed=true]{color:var(--ui-accent);border-color:var(--ui-accent);background:var(--ui-soft)}.edge-default-group small{font-size:10px}.edge-defaults-panel>p{font-size:10px;color:var(--ui-muted);line-height:1.7;margin:13px 0}.edge-defaults-panel .start-edge-drawing{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:8px;border:1px solid var(--ui-line);border-radius:6px;background:var(--ui-bg);font-size:11px}
.commandbar-actions .style-trigger{display:flex;width:auto;gap:6px;padding:0 7px;white-space:nowrap}.style-trigger-label{display:flex;align-items:center;gap:6px;font-size:11px}.style-trigger-label small{color:var(--ui-muted);font-size:10px}.commandbar-actions .style-trigger[aria-expanded=true],.zoom-controls .grid-toggle[aria-pressed=true]{color:var(--ui-accent);background:var(--ui-soft);border-color:var(--ui-line)}.empty-canvas small{font-size:10px;line-height:1.6;color:#727f93}.canvas-hint{max-width:calc(100% - 220px)}
@media(max-width:1100px){.commandbar-actions .style-trigger{width:33px;padding:0;justify-content:center}.style-trigger-label,.style-trigger-chevron{display:none}}
@media(max-width:540px){.commandbar-actions .style-trigger{width:30px}.empty-canvas small{font-size:9px}}
@media(max-width:1100px){.commandbar-actions .layout-trigger{width:33px;padding:0}.layout-trigger>span{display:none}}
@media(max-width:540px){.canvas-commandbar{height:auto;min-height:0;flex-direction:column;align-items:stretch;gap:4px}.toolset{width:100%;min-height:34px}.commandbar-actions{justify-content:flex-end;gap:3px}.commandbar-actions .layout-trigger{width:30px}.shape-library,.properties-panel{margin-top:110px}.canvas-commandbar .global-style-panel,.canvas-commandbar .edge-defaults-panel{max-height:calc(100dvh - 220px);overflow:auto}}
.brush-settings-popover{position:absolute;right:0;top:calc(100% + 8px);z-index:12}.laser-trail{filter:drop-shadow(0 0 5px #ff4d6577)}
</style>
