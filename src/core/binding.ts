import type { Point, Scene, ShapeElement } from './types.ts'

/** The attraction area remains fourteen screen pixels at every canvas zoom. */
export const BINDING_DISTANCE_PX = 14

function segmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x, dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  const amount = lengthSquared ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)) : 0
  return Math.hypot(point.x - from.x - amount * dx, point.y - from.y - amount * dy)
}

/** Euclidean distance to an ellipse, rather than distance along a center ray. */
function ellipseDistance(x: number, y: number, radiusX: number, radiusY: number): number {
  const squaredX = radiusX * radiusX, squaredY = radiusY * radiusY
  const equation = (parameter: number): number => (radiusX * x / (parameter + squaredX)) ** 2 + (radiusY * y / (parameter + squaredY)) ** 2
  let lower = 0, upper = Math.max(radiusX * x, radiusY * y, 1)
  while (equation(upper) > 1) upper *= 2
  // The closest exterior point satisfies the ellipse's Lagrange-multiplier
  // equation. Bisection is monotonic even for very thin ellipses and axis hits.
  for (let iteration = 0; iteration < 52; iteration++) {
    const middle = (lower + upper) / 2
    if (equation(middle) > 1) lower = middle
    else upper = middle
  }
  const parameter = (lower + upper) / 2
  return Math.hypot(x - squaredX * x / (parameter + squaredX), y - squaredY * y / (parameter + squaredY))
}

function outlineDistance(node: ShapeElement, point: Point): number {
  const radiusX = node.width / 2, radiusY = node.height / 2
  const x = Math.abs(point.x - node.x - radiusX), y = Math.abs(point.y - node.y - radiusY)
  if (node.shape === 'ellipse') {
    if ((x / radiusX) ** 2 + (y / radiusY) ** 2 <= 1) return 0
    return ellipseDistance(x, y, radiusX, radiusY)
  }
  if (node.shape === 'diamond') {
    if (x / radiusX + y / radiusY <= 1) return 0
    // By symmetry the nearest edge is on the point's own quadrant.
    return segmentDistance({ x, y }, { x: radiusX, y: 0 }, { x: 0, y: radiusY })
  }
  return Math.hypot(Math.max(0, x - radiusX), Math.max(0, y - radiusY))
}

/**
 * Prefer the topmost actual interior hit; otherwise select the closest outline.
 * Equal exterior distances use reverse z-order. Locking protects edits, not
 * whether other elements may connect to a node. Standalone text is not a node.
 */
export function findBindingTarget(scene: Scene, point: Point, zoom: number, excludeIds: readonly string[] = []): ShapeElement | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const maximum = BINDING_DISTANCE_PX / scale
  const excluded = new Set(excludeIds)
  let closest: ShapeElement | undefined, distance = Infinity
  for (let index = scene.elements.length - 1; index >= 0; index--) {
    const node = scene.elements[index]!
    if (node.type !== 'shape' || node.shape === 'text' || excluded.has(node.id) || !(node.width > 0) || !(node.height > 0)) continue
    if (point.x < node.x - maximum || point.x > node.x + node.width + maximum || point.y < node.y - maximum || point.y > node.y + node.height + maximum) continue
    const candidate = outlineDistance(node, point)
    if (candidate === 0) return node
    if (candidate <= maximum + 1e-9 && candidate < distance - 1e-9) { closest = node; distance = candidate }
  }
  return closest
}
