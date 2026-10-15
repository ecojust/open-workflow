import type { ElementStyle, Point, Scene, SceneElement, ShapeElement } from './types.ts'
import { edgePoints, pathMidpoint, pointsPath, sceneBounds } from './geometry.ts'

export function escapeXml(value: unknown): string { return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '\uFFFD').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!) }
export function safeImageData(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 16_000_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/\r\n]+={0,2}$/.test(value)
}
function color(value: string): string { return /^(?:#[\da-f]{3,8}|[a-z]{1,24}|(?:rgba?|hsla?)\([\d.,%\s/]+\))$/i.test(value) ? escapeXml(value) : '#334155' }
function styleAttrs(style: ElementStyle, fill = style.fill): string {
  return `fill="${color(fill)}" stroke="${color(style.stroke)}" stroke-width="${Math.max(0, Math.min(100, style.strokeWidth))}" opacity="${Math.max(0, Math.min(1, style.opacity))}"${style.dashed ? ' stroke-dasharray="8 5"' : ''} stroke-linejoin="round" stroke-linecap="round"`
}
export function wrapText(text: string, width: number, fontSize: number): string[] {
  const max = Math.max(1, width / Math.max(1, fontSize)), lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = '', used = 0
    for (const character of paragraph) { const size = /[\u0000-\u007f]/.test(character) ? 0.57 : 1; if (used + size > max && line) { lines.push(line); line = ''; used = 0 }; line += character; used += size }
    lines.push(line)
  }
  return lines
}
function textMarkup(node: ShapeElement): string {
  if (!node.text || node.shape === 'image') return ''
  const fontSize = Math.max(1, Math.min(500, node.style.fontSize)), lineHeight = fontSize * 1.35
  const innerWidth = node.shape === 'diamond' ? node.width * 0.58 : node.width - 20
  const maxLines = Math.max(1, Math.floor((node.height - 12) / lineHeight))
  const wrapped = wrapText(node.text, innerWidth, fontSize), lines = wrapped.slice(0, maxLines)
  if (wrapped.length > maxLines) lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, -1)}…`
  const align = node.style.textAlign, x = align === 'left' ? node.x + 10 : align === 'right' ? node.x + node.width - 10 : node.x + node.width / 2
  const y = node.y + node.height / 2 - (lines.length - 1) * lineHeight / 2
  const textColor = ['transparent', 'none'].includes(node.style.stroke.toLowerCase()) ? '#334155' : node.style.stroke
  return `<text fill="${color(textColor)}" opacity="${node.style.opacity}" font-family="Inter, 'Noto Sans SC', system-ui, sans-serif" font-size="${fontSize}" text-anchor="${align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'}" dominant-baseline="central" pointer-events="none">${lines.map((line, i) => `<tspan x="${x}" y="${y + i * lineHeight}">${escapeXml(line)}</tspan>`).join('')}</text>`
}
function arrowMarkup(at: Point, previous: Point, style: ElementStyle): string {
  const angle = Math.atan2(at.y - previous.y, at.x - previous.x), size = Math.max(8, style.strokeWidth * 3.5)
  const a = { x: at.x - Math.cos(angle - 0.45) * size, y: at.y - Math.sin(angle - 0.45) * size }, b = { x: at.x - Math.cos(angle + 0.45) * size, y: at.y - Math.sin(angle + 0.45) * size }
  return `<path d="M${a.x} ${a.y} L${at.x} ${at.y} L${b.x} ${b.y}" ${styleAttrs(style, 'none')}/>`
}
export function elementToSvg(element: SceneElement, scene: Scene, hitTargets = false): string {
  if (element.type === 'stroke') {
    const points = element.points.length === 1 ? [element.points[0]!, { x: element.points[0]!.x + 0.01, y: element.points[0]!.y + 0.01 }] : element.points
    return `${hitTargets ? `<path d="${pointsPath(points)}" fill="none" stroke="transparent" stroke-width="16"/>` : ''}<path d="${pointsPath(points)}" ${styleAttrs(element.style, 'none')}/>`
  }
  if (element.type === 'edge') {
    const points = edgePoints(element, scene), d = pointsPath(points), middle = pathMidpoint(points)
    const start = points[0]!, end = points[points.length - 1]!
    const before = [...points].reverse().find(p => p.x !== end.x || p.y !== end.y) || start
    const after = points.find(p => p.x !== start.x || p.y !== start.y) || end
    const arrows = `${element.arrow !== 'none' ? arrowMarkup(end, before, element.style) : ''}${element.arrow === 'both' ? arrowMarkup(start, after, element.style) : ''}`
    const label = element.label ? `<text x="${middle.x}" y="${middle.y - 9}" font-size="${element.style.fontSize}" font-family="system-ui, sans-serif" text-anchor="middle" fill="${color(element.style.stroke)}" stroke="${color(scene.background)}" stroke-width="5" paint-order="stroke" stroke-linejoin="round">${escapeXml(element.label)}</text>` : ''
    return `${hitTargets ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="18"/>` : ''}<path d="${d}" ${styleAttrs(element.style, 'none')}/>${arrows}${label}`
  }
  const { x, y, width: w, height: h, shape } = element, attrs = styleAttrs(element.style)
  let markup = ''
  if (shape === 'ellipse') markup = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${attrs}/>`
  else if (shape === 'diamond') markup = `<path d="M${x + w / 2} ${y} L${x + w} ${y + h / 2} L${x + w / 2} ${y + h} L${x} ${y + h / 2} Z" ${attrs}/>`
  else if (shape === 'image' && safeImageData(element.imageData)) markup = `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${escapeXml(element.imageData)}" preserveAspectRatio="xMidYMid meet" opacity="${element.style.opacity}"/>`
  else if (shape === 'text') markup = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent"/>`
  else markup = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${shape === 'note' ? 2 : 9}" ${attrs}/>${shape === 'note' ? `<path d="M${x + w - 18} ${y + h} L${x + w - 18} ${y + h - 18} L${x + w} ${y + h - 18}" fill="#0000000b" stroke="${color(element.style.stroke)}" stroke-opacity=".2"/>` : ''}`
  return markup + textMarkup(element)
}
export function sceneToSvg(scene: Scene, options: { background?: boolean } = {}): string {
  const bounds = sceneBounds(scene), pad = Math.max(32, ...scene.elements.map(e => e.style.strokeWidth / 2 + 12)), x = bounds.x - pad, y = bounds.y - pad, width = Math.max(64, bounds.width + pad * 2), height = Math.max(64, bounds.height + pad * 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="${x} ${y} ${width} ${height}" role="img" aria-label="Open Workflow diagram">${options.background === false ? '' : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color(scene.background)}"/>`}${scene.elements.map(element => `<g>${elementToSvg(element, scene)}</g>`).join('')}</svg>`
}
