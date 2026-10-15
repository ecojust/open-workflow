import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasGrid } from '../src/core/grid.ts'

test('grid remains legible from 10% through 400% and follows canvas contrast', () => {
  for (const zoom of [.1, .2, .5, .75, 1, 1.5, 2, 4]) {
    const grid = canvasGrid(zoom, '#ffffff')
    assert.ok(grid.step * zoom >= 20 && grid.step * zoom < 40)
    assert.ok(Math.abs(grid.radius * zoom - 1.05) < 1e-10)
  }
  assert.notEqual(canvasGrid(1, '#fff').color, canvasGrid(1, '#182030').color)
  assert.equal(canvasGrid(1, '#fff').color, canvasGrid(1, 'rgb(255,255,255)').color)
})
