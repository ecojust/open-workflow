/** Keep dots visible on screen while retaining a grid aligned to world coordinates. */
export function canvasGrid(zoom: number, background: string) {
  const scale = Math.max(0.1, Math.min(4, Number.isFinite(zoom) ? zoom : 1))
  const step = 20 * 2 ** Math.ceil(Math.log2(1 / scale))
  const hex = background.replace(/^#/, '')
  const rgb = /^[\da-f]{6}$/i.test(hex) ? [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))
    : /^[\da-f]{3}$/i.test(hex) ? [...hex].map(c => parseInt(c + c, 16))
      : background.match(/^rgba?\(/i) ? (background.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
        : background.toLowerCase() === 'black' ? [0, 0, 0] : [255, 255, 255]
  const light = (rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722) > 140
  return { step, radius: 1.05 / scale, color: light ? '#8290a6' : '#a7b6cf', opacity: light ? .6 : .55 }
}
