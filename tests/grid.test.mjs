import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasGrid } from '../src/core/grid.ts'
import { safeColor } from '../src/core/documents.ts'

const hexRgb = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16))
function luminance(rgb) {
  const linear = rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return linear.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
}
function dotContrast(grid, background) {
  const foreground = hexRgb(grid.color).map((value, index) => value * grid.opacity + background[index] * (1 - grid.opacity))
  const dot = luminance(foreground), backdrop = luminance(background)
  return (Math.max(dot, backdrop) + .05) / (Math.min(dot, backdrop) + .05)
}

test('dot radius stays at 1.25 screen pixels and spacing at 20–40 pixels across the entire zoom range', () => {
  const zooms = Array.from({ length: 3901 }, (_, index) => .1 + index / 1000)
  zooms.push(...[.125, .25, .5, 1, 2].flatMap(value => [value - 1e-10, value, value + 1e-10]))
  for (const zoom of zooms) {
    const grid = canvasGrid(zoom, '#ffffff')
    assert.ok(grid.step * zoom >= 20 && grid.step * zoom < 40)
    assert.ok(Math.abs(grid.radius * zoom - 1.25) < 1e-10)
  }
  for (const invalid of [NaN, Infinity, -Infinity]) assert.deepEqual(canvasGrid(invalid, '#fff'), canvasGrid(1, '#fff'))
  assert.deepEqual(canvasGrid(0, '#fff'), canvasGrid(.1, '#fff'))
  assert.deepEqual(canvasGrid(8, '#fff'), canvasGrid(4, '#fff'))
})
test('white and dark canvases retain moderate dot colors with visibly stronger composited contrast', () => {
  const white = canvasGrid(1, '#fff'), dark = canvasGrid(1, '#182030')
  assert.equal(white.color, '#64748b')
  assert.equal(white.opacity, .8)
  assert.equal(dark.color, '#cbd5e1')
  assert.equal(dark.opacity, .75)
  assert.ok(dotContrast(white, [255, 255, 255]) >= 3)
  assert.ok(dotContrast(dark, [24, 32, 48]) >= 3)
  assert.ok(dotContrast(white, [255, 255, 255]) > dotContrast({ color: '#8290a6', opacity: .6 }, [255, 255, 255]))
})
test('actual composited dot contrast remains at least 3 on midgray and saturated backgrounds', () => {
  // Includes the old dot color itself, on which the previous grid disappeared.
  const samples = [[130, 144, 166], [144, 144, 144], [128, 128, 128], [0, 165, 230], [255, 0, 0]]
  for (let value = 0; value <= 255; value++) samples.push([value, value, value])
  for (const rgb of samples) {
    const grid = canvasGrid(1, `rgb(${rgb.join(',')})`)
    assert.ok(dotContrast(grid, rgb) >= 3, `${rgb}: ${dotContrast(grid, rgb)}`)
  }
})
test('equivalent hex, percentage RGB, HSL, and named backgrounds choose the same visible grid', () => {
  const groups = [
    ['#ffffff', '#fff', '#ffff', '#ffffffff', 'white', 'rgb(100%,100%,100%)', 'rgb(255 100% 255)', 'rgba(255 255 255 / 100%)', 'hsl(0,0%,100%)', 'HSL(720 0 100)'],
    ['#000000', '#000', '#000f', '#000000ff', 'black', 'rgb(0% 0% 0%)', 'rgba(0,0,0)', 'hsl(720 100% 0%)', 'hsl(0 0 0)', 'rgb(.0 .0 .0)', 'hsl(.0 .0% .0%)'],
    ['#000080', 'navy', 'rgb(0,0,128)', 'rgb(0% 0% 50.19607843137255%)', 'hsl(240,100%,25.098039215686275%)'],
    ['#ff0000', 'red', 'rgb(100%,0%,0%)', 'hsl(0 100 50)', 'hsl(360,100%,50%)', 'hsl(720 100% 50%)'],
  ]
  for (const colors of groups) for (const color of colors) {
    assert.equal(safeColor(color), color)
    assert.deepEqual(canvasGrid(.75, color), canvasGrid(.75, colors[0]), color)
  }
})
test('all safeColor named colors and aliases match their RGB values', () => {
  const named = { black: '000000', white: 'ffffff', red: 'ff0000', blue: '0000ff', green: '008000', yellow: 'ffff00', orange: 'ffa500', purple: '800080', gray: '808080', grey: '808080', pink: 'ffc0cb', cyan: '00ffff', magenta: 'ff00ff', navy: '000080', teal: '008080', lime: '00ff00', maroon: '800000', olive: '808000', silver: 'c0c0c0', aqua: '00ffff', fuchsia: 'ff00ff', rebeccapurple: '663399' }
  for (const [name, hex] of Object.entries(named)) {
    assert.equal(safeColor(name), name)
    assert.deepEqual(canvasGrid(1, name), canvasGrid(1, `#${hex}`), name)
    assert.deepEqual(canvasGrid(1, name.toUpperCase()), canvasGrid(1, `#${hex}`), name)
  }
})
test('transparent and partial-alpha backgrounds use their actual underlay before selecting dots', () => {
  for (const underlay of ['#ffffff', '#141922', '#909090', 'navy']) {
    for (const color of ['transparent', 'none', '#1230', '#00000000', 'rgba(0,0,0,0)', 'rgba(255 0 0 / 0%)', 'hsla(240,100%,50%,0)']) {
      assert.deepEqual(canvasGrid(1, color, underlay), canvasGrid(1, underlay), `${color} on ${underlay}`)
    }
  }
  assert.deepEqual(canvasGrid(1, '#0008'), canvasGrid(1, '#777777'))
  assert.deepEqual(canvasGrid(1, '#00000080'), canvasGrid(1, '#7f7f7f'))
  assert.deepEqual(canvasGrid(1, 'rgba(0 0 0 / 50%)'), canvasGrid(1, 'rgb(127.5 127.5 127.5)'))
  assert.deepEqual(canvasGrid(1, 'rgba(255,0,0,.5)', 'navy'), canvasGrid(1, 'rgb(127.5 0 64)'))
  assert.deepEqual(canvasGrid(1, 'hsl(240 100% 50% / 50%)', '#fff'), canvasGrid(1, 'rgb(127.5 127.5 255)'))
  // A partially transparent underlay itself is first composited over the default white.
  assert.deepEqual(canvasGrid(1, 'rgba(255 255 255 / 50%)', 'rgba(0 0 0 / 50%)'), canvasGrid(1, 'rgb(191.25 191.25 191.25)'))
  assert.notDeepEqual(canvasGrid(1, 'rgba(0 0 0 / 0%)'), canvasGrid(1, 'black'))
})
test('malformed CSS falls through to the underlay without inventing a dark canvas', () => {
  for (const color of ['rgb(1,,2)', 'rgb(0 0 0 .5)', 'rgb(255,0,0 / .5)', 'rgb(0%,0,0)', 'hsl(0,100,50)', 'hsl(0% 100% 50%)', 'rgb(0. 0. 0.)', 'rgb(0.,0.,0.)', 'hsl(0. 0% 0%)', 'rgb(0 0 0 / 1.)', 'rgb(0.% 0% 0%)', 'hsl(0 0.% 0%)', 'constructor', '__proto__']) {
    for (const underlay of ['white', 'navy']) assert.deepEqual(canvasGrid(1, color, underlay), canvasGrid(1, underlay), `${color} on ${underlay}`)
  }
  assert.deepEqual(canvasGrid(1, 'rgb(300 300 300 / 500%)'), canvasGrid(1, '#fff'))
})
