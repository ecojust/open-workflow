import type { EdgeElement, Point, Scene, SceneElement, ShapeElement } from './types.ts'

export interface Bounds { x: number; y: number; width: number; height: number }
export function elementBounds(element: SceneElement): Bounds {
  if (element.type === 'shape') return { x: element.x, y: element.y, width: element.width, height: element.height }
  const points = element.type === 'stroke' ? element.points : [element.from, element.to]
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const point of points) { x = Math.min(x, point.x); y = Math.min(y, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y) }
  return { x, y, width: right - x, height: bottom - y }
}
export function combineBounds(bounds: Bounds[]): Bounds {
  if (!bounds.length) return { x: 0, y: 0, width: 800, height: 600 }
  const x = Math.min(...bounds.map(b => b.x)), y = Math.min(...bounds.map(b => b.y))
  return { x, y, width: Math.max(...bounds.map(b => b.x + b.width)) - x, height: Math.max(...bounds.map(b => b.y + b.height)) - y }
}
export function center(node: ShapeElement): Point { return { x: node.x + node.width / 2, y: node.y + node.height / 2 } }
/** Ray/shape intersection makes an edge follow its node without storing stale anchors. */
export function shapeAnchor(node: ShapeElement, toward: Point): Point {
  const c = center(node), dx = toward.x - c.x, dy = toward.y - c.y
  if (!dx && !dy) return { x: c.x, y: node.y + node.height }
  const rx = Math.max(1, node.width / 2), ry = Math.max(1, node.height / 2)
  const t = node.shape === 'ellipse' ? 1 / Math.sqrt(dx * dx / (rx * rx) + dy * dy / (ry * ry))
    : node.shape === 'diamond' ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
    : Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity)
  return { x: c.x + dx * t, y: c.y + dy * t }
}
export function edgePoints(edge: EdgeElement, scene: Scene): Point[] {
  const shapes = scene.elements.filter((item): item is ShapeElement => item.type === 'shape')
  const fromNode = shapes.find(n => n.id === edge.from.nodeId), toNode = shapes.find(n => n.id === edge.to.nodeId)
  const fromCenter = fromNode ? center(fromNode) : edge.from, toCenter = toNode ? center(toNode) : edge.to
  if (fromNode && fromNode === toNode) {
    return [{ x: fromNode.x + fromNode.width, y: fromCenter.y }, { x: fromNode.x + fromNode.width + 44, y: fromCenter.y }, { x: fromNode.x + fromNode.width + 44, y: fromNode.y - 32 }, { x: fromCenter.x, y: fromNode.y - 32 }, { x: fromCenter.x, y: fromNode.y }]
  }
  if (edge.route === 'orthogonal') {
    const horizontal = Math.abs(toCenter.x - fromCenter.x) > Math.abs(toCenter.y - fromCenter.y)
    if (fromNode && toNode) {
      const reverse = scene.elements.some(other => other.type === 'edge' && other.id !== edge.id && other.from.nodeId === toNode.id && other.to.nodeId === fromNode.id)
      const returning = horizontal ? fromCenter.x > toCenter.x : fromCenter.y > toCenter.y
      // Keep the forward route direct and put its reciprocal on a separate outside lane.
      // Cardinal anchors remain on the real outline for rectangles, diamonds, and ellipses.
      if (reverse && returning) {
        if (horizontal) {
          const y = Math.min(fromNode.y, toNode.y) - 44
          const from = shapeAnchor(fromNode, { x: fromCenter.x, y }), to = shapeAnchor(toNode, { x: toCenter.x, y })
          return [from, { x: from.x, y }, { x: to.x, y }, to]
        }
        const x = Math.max(fromNode.x + fromNode.width, toNode.x + toNode.width) + 44
        const from = shapeAnchor(fromNode, { x, y: fromCenter.y }), to = shapeAnchor(toNode, { x, y: toCenter.y })
        return [from, { x, y: from.y }, { x, y: to.y }, to]
      }
      // A return from the lower-right branch leaves its top and enters the earlier
      // step on the right, rather than retracing the branch's left-side incoming line.
      if (fromCenter.x > toNode.x + toNode.width && fromNode.y > toCenter.y) {
        const from = shapeAnchor(fromNode, { x: fromCenter.x, y: toCenter.y }), to = shapeAnchor(toNode, { x: fromCenter.x, y: toCenter.y })
        return [from, { x: from.x, y: to.y }, to]
      }
    }
    const from = fromNode ? shapeAnchor(fromNode, horizontal ? { x: toCenter.x, y: fromCenter.y } : { x: fromCenter.x, y: toCenter.y }) : fromCenter
    const to = toNode ? shapeAnchor(toNode, horizontal ? { x: fromCenter.x, y: toCenter.y } : { x: toCenter.x, y: fromCenter.y }) : toCenter
    if (horizontal) { const x = (from.x + to.x) / 2; return [from, { x, y: from.y }, { x, y: to.y }, to] }
    const y = (from.y + to.y) / 2; return [from, { x: from.x, y }, { x: to.x, y }, to]
  }
  return [fromNode ? shapeAnchor(fromNode, toCenter) : fromCenter, toNode ? shapeAnchor(toNode, fromCenter) : toCenter]
}
export function sceneBounds(scene: Scene): Bounds {
  return combineBounds(scene.elements.map(element => {
    if (element.type !== 'edge') return elementBounds(element)
    const points = edgePoints(element, scene), bounds = elementBounds({ ...element, type: 'stroke', points })
    if (!element.label) return bounds
    const midpoint = pathMidpoint(points), width = [...element.label].reduce((total, character) => total + (/[\u0000-\u007f]/.test(character) ? 0.65 : 1.05) * element.style.fontSize, 0)
    return combineBounds([bounds, { x: midpoint.x - width / 2 - 4, y: midpoint.y - 12 - element.style.fontSize, width: width + 8, height: element.style.fontSize * 1.4 + 6 }])
  }))
}
export function pointInside(point: Point, bounds: Bounds): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height
}
export function snap(value: number, enabled: boolean, step = 20): number { return enabled ? Math.round(value / step) * step : value }
export function pointsPath(points: Point[]): string { return points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ') }
export function pathMidpoint(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 }
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y))
  let remainder = lengths.reduce((a, b) => a + b, 0) / 2
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!
    if (length && remainder <= length) { const a = points[i]!, b = points[i + 1]!; return { x: a.x + (b.x - a.x) * remainder / length, y: a.y + (b.y - a.y) * remainder / length } }
    remainder -= length
  }
  return points[0]!
}
