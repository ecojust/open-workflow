/* Browser acceptance for the complete diagram example library.
 * Run: node tests/browser/diagram-rich-templates.cjs
 * BASE_URL, TEST_FILTER, CHROMIUM_EXECUTABLE and BROWSER_ARTIFACTS are optional.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5199'
const output = process.env.BROWSER_ARTIFACTS || '/tmp/open-workflow-rich-templates'
const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true }
const results = []
let browser, server

function catalog() {
  // Read the same checked-out catalog as the stable build. Node compilation
  // supplies reference source identities for the browser integration checks.
  const script = `
    import { DIAGRAM_TEMPLATES, DIAGRAM_KIND_LABELS } from './src/core/diagrams/catalog.ts';
    import { compileCodeDiagram, lookupDiagramSource } from './src/core/code-diagram.ts';
    const templates = DIAGRAM_TEMPLATES.map(template => {
      try {
        const compiled = compileCodeDiagram(template.source);
        const ranges = compiled.sourceMap.filter(range => range.end > range.start);
        const offsets = [...new Set([0, Math.floor(ranges.length / 2), ranges.length - 1].filter(index => index >= 0).map(index => ranges[index]).filter(Boolean).map(range => range.start + Math.min(1, range.end - range.start - 1)))];
        return { ...template, elementCount: compiled.scene.elements.length, locations: offsets.map(offset => ({ offset, ids: lookupDiagramSource(compiled.sourceMap, offset).sort() })) };
      } catch (error) { return { ...template, compileError: error.message, locations: [] }; }
    });
    console.log(JSON.stringify({ templates, kinds: DIAGRAM_KIND_LABELS }));
  `
  return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
}
async function available() { try { return (await fetch(baseURL, { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }
async function ensureServer() {
  if (await available()) return
  if (process.env.BASE_URL) throw Error(`Cannot reach ${baseURL}`)
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; server.stdout.on('data', data => { log += data }); server.stderr.on('data', data => { log += data })
  for (let attempt = 0; attempt < 80; attempt++) { if (await available()) return; if (server.exitCode !== null) throw Error(`Development server exited: ${log}`); await new Promise(resolve => setTimeout(resolve, 250)) }
  throw Error(`Development server did not become ready: ${log}`)
}
async function test(name, run, viewport = contextOptions.viewport) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return
  const context = await browser.newContext({ ...contextOptions, viewport }), page = await context.newPage(), errors = []
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(baseURL); await page.getByTestId('create-diagram').waitFor(); await run(page)
    assert.deepEqual(errors, [], 'No uncaught browser errors')
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
    results.push({ name, pass: true }); process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true, animations: 'disabled' }).catch(() => {})
    results.push({ name, pass: false, error: error.stack || String(error) }); process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`)
  } finally { await context.close() }
}
async function download(page, trigger) { const pending = page.waitForEvent('download'); await trigger(); const file = await pending; assert.equal(await file.failure(), null); return { name: file.suggestedFilename(), bytes: await fs.readFile(await file.path()) } }
async function save(page) { const file = await download(page, () => page.getByTitle('保存 (Ctrl+S)', { exact: true }).click()); assert.match(file.name, /\.owflow$/); return { ...file, document: JSON.parse(file.bytes.toString('utf8')) } }
async function exportFile(page, format) { await page.getByTitle('导出', { exact: true }).click(); const file = await download(page, () => page.getByRole('menuitem', { name: format === 'svg' ? 'SVG 矢量图' : 'PNG 图片', exact: true }).click()); assert.ok(file.name.endsWith(`.${format}`)); return file }
async function openLibrary(page) { if (!await page.getByTestId('diagram-template-library').isVisible()) await page.getByTestId('diagram-template-toggle').click(); await expect(page.getByTestId('diagram-template-library')).toBeVisible(); await page.getByLabel('搜索图表模板', { exact: true }).fill('') }
async function chooseTemplate(page, template) {
  await openLibrary(page); await page.locator(`[data-template-id="${template.id}"]`).click()
  if (await page.getByTestId('diagram-confirm-template').isVisible()) await page.getByTestId('diagram-confirm-template').click()
  await expect(page.getByTestId('diagram-template-library')).toHaveCount(0)
  await expect(page.getByTestId('diagram-source')).toHaveValue(template.source)
  await expect(page.locator('.diagram-parsing')).toHaveCount(0)
  await expect(page.getByTestId('diagram-error')).toHaveCount(0)
  await expect(page.getByTestId('diagram-preview').locator('svg')).toBeVisible()
}
async function preview(page) { return page.getByTestId('diagram-preview').locator('svg').evaluate(svg => svg.outerHTML) }
async function describeSvg(page, markup) {
  return page.evaluate(markup => {
    const document = new DOMParser().parseFromString(markup, 'image/svg+xml'), svg = document.documentElement
    const numericAttributes = ['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'stroke-width', 'font-size', 'opacity']
    return {
      error: document.querySelector('parsererror')?.textContent,
      dimensions: (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number),
      labels: [...svg.querySelectorAll('text')].map(text => text.textContent),
      primitives: svg.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon').length,
      invalidNumbers: [...svg.querySelectorAll('*')].flatMap(element => numericAttributes.filter(name => element.hasAttribute(name) && !Number.isFinite(Number(element.getAttribute(name)))).map(name => `${element.localName}:${name}=${element.getAttribute(name)}`)),
      invalidGeometry: [...svg.querySelectorAll('[d],[points],[transform]')].some(element => ['d', 'points', 'transform'].some(name => /NaN|Infinity|undefined/.test(element.getAttribute(name) || ''))),
    }
  }, markup)
}
async function assertDrawing(page, label) {
  const drawing = await describeSvg(page, await preview(page))
  assert.equal(drawing.error, undefined, label); assert.deepEqual(drawing.invalidNumbers, [], label); assert.equal(drawing.invalidGeometry, false, label)
  assert.equal(drawing.dimensions.length, 4); assert.ok(drawing.dimensions.every(Number.isFinite) && drawing.dimensions[2] > 0 && drawing.dimensions[3] > 0, label)
  assert.ok(drawing.labels.some(text => text.trim()) && drawing.primitives >= 3, `${label}: real labels and vector geometry are rendered`)
  return drawing
}
function highlights(page) { return page.locator('[data-testid="diagram-source-overlay"] [data-source-element-id]') }
async function assertLocations(page, template) {
  assert.ok(template.locations.length >= 2, `${template.id}: the example has multiple independently locatable declarations`)
  for (const location of template.locations) {
    await page.getByTestId('diagram-source').evaluate((input, offset) => { input.focus(); input.setSelectionRange(offset, offset); input.dispatchEvent(new Event('select', { bubbles: true })) }, location.offset)
    await expect.poll(() => highlights(page).evaluateAll(groups => groups.map(group => group.getAttribute('data-source-element-id')).sort())).toEqual(location.ids)
    assert.ok(location.ids.length > 0); await expect(page.getByTestId('diagram-source-location')).toContainText(`已定位 ${location.ids.length} 个图形`)
    await page.getByTestId('diagram-locate-current').click(); await expect(page.getByTestId('diagram-source-overlay')).toBeVisible()
    const painted = await highlights(page).evaluateAll(groups => groups.every(group => [...group.querySelectorAll('path,rect')].some(shape => {
      const style = getComputedStyle(shape), geometry = shape.localName === 'path' ? shape.getTotalLength() > 0 : Number(shape.getAttribute('width')) > 0 && Number(shape.getAttribute('height')) > 0
      return geometry && style.stroke !== 'none' && Number.parseFloat(style.strokeWidth) > 0 && Number(style.opacity) > 0
    })))
    assert.ok(painted, 'Located nodes and axis-aligned connectors have visible highlight geometry')
  }
}
async function assertFits(page, locator) {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)
  assert.ok(overflow <= 1, `Horizontal page overflow: ${overflow}`)
  if (locator) { const box = await locator.boundingBox(), viewport = page.viewportSize(); assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `Panel outside viewport: ${JSON.stringify(box)}`) }
}
async function pngMatchesSvg(page, markup, png) {
  const result = await page.evaluate(async ({ markup, png }) => {
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
    async function load(src) { const image = new Image(); await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = src }); return image }
    try {
      const [reference, actual] = await Promise.all([load(url), load(png)]), canvas = document.createElement('canvas'); canvas.width = actual.naturalWidth; canvas.height = actual.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(reference, 0, 0, canvas.width, canvas.height); const expected = context.getImageData(0, 0, canvas.width, canvas.height).data
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(actual, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let error = 0, different = 0; for (let index = 0; index < pixels.length; index++) { const delta = Math.abs(expected[index] - pixels[index]); error += delta; if (delta > 2) different++ }
      return { width: canvas.width, height: canvas.height, meanError: error / pixels.length, changed: different / pixels.length }
    } finally { URL.revokeObjectURL(url) }
  }, { markup, png: `data:image/png;base64,${png.toString('base64')}` })
  assert.ok(result.width >= 100 && result.height >= 50)
  assert.ok(result.meanError < .2 && result.changed < .002, `PNG matches the complete SVG including complex structures: ${JSON.stringify(result)}`)
}
async function reopen(file, check) { const context = await browser.newContext(contextOptions), page = await context.newPage(); try { await page.goto(baseURL); await page.getByTestId('create-diagram').waitFor(); await page.locator('#file-input').setInputFiles({ name: file.name, mimeType: 'application/json', buffer: file.bytes }); await expect(page.getByTestId('diagram-source')).toBeVisible(); await check(page) } finally { await context.close() } }

async function main() {
  const { templates, kinds } = catalog()
  assert.equal(new Set(templates.map(template => template.id)).size, templates.length, 'Template identifiers remain unique')
  assert.deepEqual(new Set(templates.map(template => template.kind)), new Set(Object.keys(kinds)))
  for (const kind of Object.keys(kinds)) assert.ok(templates.filter(template => template.kind === kind).length >= 2, `${kind}: multiple comprehensive examples are available`)
  // Choose examples by their syntax and size; stable identifiers can retain
  // their place while their contents grow into comprehensive examples.
  const complex = kind => {
    const family = templates.filter(template => template.kind === kind).sort((a, b) => b.source.length - a.source.length)
    const preferred = { flowchart: 'flowchart-basic', sequence: 'sequence-basic', class: 'class-order-domain', state: 'state-order-lifecycle', gantt: 'gantt', block: 'block' }[kind]
    return family.find(template => template.id === preferred) || family[0]
  }
  await fs.mkdir(output, { recursive: true }); await ensureServer()
  const executablePath = process.env.CHROMIUM_EXECUTABLE || (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  for (const template of templates) await test(`rich-template-${template.id}-render-save-locate`, async page => {
    assert.equal(template.compileError, undefined, template.compileError)
    await page.getByTestId('create-diagram').click(); await chooseTemplate(page, template)
    await expect(page.locator('.diagram-preview-kind')).toContainText(kinds[template.kind])
    await assertDrawing(page, template.title)
    const saved = await save(page); assert.equal(saved.document.kind, 'mermaid'); assert.equal(saved.document.source, template.source)
    assert.ok(!('sourceMap' in saved.document), 'Editor source locations are excluded from saved documents')
    await assertLocations(page, template)
  })

  for (const kind of ['flowchart', 'sequence', 'class', 'state', 'gantt', 'block']) await test(`rich-${kind}-svg-png-native-and-editable-copy`, async page => {
    const template = complex(kind)
    await page.getByTestId('create-diagram').click(); await chooseTemplate(page, template); await assertLocations(page, template)
    const markup = await preview(page), reference = await assertDrawing(page, template.title), svg = (await exportFile(page, 'svg')).bytes.toString('utf8')
    assert.deepEqual(await describeSvg(page, svg), reference, 'SVG exports every visible label and vector element')
    assert.ok(!/data-source-element-id|diagram-source-overlay/.test(svg), 'Source focus is excluded from drawing exports')
    const png = (await exportFile(page, 'png')).bytes
    await pngMatchesSvg(page, markup, png)
    await fs.writeFile(path.join(output, `complex-${kind}.svg`), svg); await fs.writeFile(path.join(output, `complex-${kind}.png`), png)
    const native = await save(page)
    await reopen(native, async fresh => { await expect(fresh.getByTestId('diagram-source')).toHaveValue(template.source); assert.deepEqual(await assertDrawing(fresh, template.title), reference); await assertLocations(fresh, template) })
    await page.getByTestId('diagram-create-copy').click(); await expect(page.getByTestId('scene-editor')).toBeVisible()
    const copied = await save(page); assert.equal(copied.document.kind, 'flow'); assert.equal(copied.document.source, ''); assert.equal(copied.document.scene.elements.length, template.elementCount)
    const copySvg = (await exportFile(page, 'svg')).bytes.toString('utf8'); assert.deepEqual(await describeSvg(page, copySvg), reference, 'The editable canvas copy retains complete complex diagram geometry')
    const editable = copied.document.scene.elements.find(element => element.type === 'shape' && element.shape !== 'frame' && element.text.trim())
    assert.ok(editable, 'The copied diagram contains editable text')
    await page.getByRole('button', { name: '适应画布', exact: true }).click(); await page.locator(`[data-element-id="${editable.id}"]`).dblclick()
    await page.locator('.inline-text-editor').fill('复杂图形仍可独立编辑'); await page.locator('.inline-text-editor').press('Control+Enter')
    assert.equal((await save(page)).document.scene.elements.find(element => element.id === editable.id).text, '复杂图形仍可独立编辑')
    await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.deepEqual((await save(page)).document.scene, copied.document.scene)
  })

  await test('rich-template-library-discovers-all-examples-and-source-keywords', async page => {
    await page.getByTestId('create-diagram').click(); await openLibrary(page)
    const all = await page.locator('[data-template-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-template-id')).sort())
    assert.deepEqual(all, templates.map(template => template.id).sort(), 'Every registered example is discoverable in the library')
    const missingIcons = await page.locator('[data-template-id]').evaluateAll(cards => cards.filter(card => !card.querySelector('svg')).map(card => card.getAttribute('data-template-id')))
    assert.deepEqual(missingIcons, [], 'Every example uses an SVG icon')
    const keyword = ['subgraph', 'namespace', 'weekends', 'activate'].find(word => templates.some(template => template.source.includes(word) && !`${template.title} ${template.description}`.includes(word)))
    assert.ok(keyword, 'Expanded examples contain searchable syntax beyond display titles')
    await page.getByLabel('搜索图表模板', { exact: true }).fill(keyword)
    const matches = await page.locator('[data-template-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-template-id')))
    for (const template of templates.filter(template => template.source.toLowerCase().includes(keyword))) assert.ok(matches.includes(template.id), `${template.id}: source keywords are searchable`)
    await page.getByLabel('搜索图表模板', { exact: true }).fill('没有这个复杂模板_928174'); await expect(page.locator('[data-template-id]')).toHaveCount(0); await expect(page.locator('.diagram-no-templates')).toBeVisible()
    await page.getByLabel('搜索图表模板', { exact: true }).fill(complex('flowchart').title); await page.locator(`[data-template-id="${complex('flowchart').id}"]`).click()
    await expect(page.getByTestId('diagram-confirm-template')).toBeVisible(); await page.locator('[data-template-cancel]').click(); await expect(page.getByTestId('diagram-confirm-template')).toHaveCount(0)
    await page.keyboard.press('Escape'); await expect(page.getByTestId('diagram-template-toggle')).toBeFocused()
  })

  await test('rich-template-library-mobile-search-preview-and-location', async page => {
    const template = complex('packet')
    await page.getByTestId('create-diagram').click(); await openLibrary(page); await assertFits(page, page.getByTestId('diagram-template-library'))
    await expect(page.getByLabel('搜索图表模板', { exact: true })).toBeFocused(); await page.getByLabel('搜索图表模板', { exact: true }).fill(template.title)
    await page.locator(`[data-template-id="${template.id}"]`).click(); await assertFits(page, page.getByTestId('diagram-template-library')); await page.getByTestId('diagram-confirm-template').click()
    await expect(page.getByTestId('diagram-source')).toHaveValue(template.source); await expect(page.getByTestId('diagram-error')).toHaveCount(0); await assertDrawing(page, template.title)
    await assertLocations(page, template); await assertFits(page)
    const saved = await save(page); assert.equal(saved.document.source, template.source)
  }, { width: 320, height: 740 })

  await fs.writeFile(path.join(output, 'results-rich-templates.json'), JSON.stringify({ examples: templates.length, kinds: Object.keys(kinds).length, results }, null, 2))
  assert.ok(results.length, 'No matching acceptance cases'); assert.ok(results.every(result => result.pass), `${results.filter(result => !result.pass).length} rich-template case(s) failed; see ${output}`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }).finally(async () => { if (browser) await browser.close(); if (server) server.kill('SIGTERM') })
