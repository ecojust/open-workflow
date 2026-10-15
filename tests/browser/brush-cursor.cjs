/* Browser acceptance for drawing brushes, temporary pointers and source location.
 * Run: node tests/browser/brush-cursor.cjs
 * BASE_URL, TEST_FILTER, CHROMIUM_EXECUTABLE and BROWSER_ARTIFACTS are optional.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5199'
const output = process.env.BROWSER_ARTIFACTS || '/tmp/open-workflow-brush-cursor'
const results = []
const kinds = ['pen', 'pencil', 'marker', 'brush', 'highlighter', 'rainbow']
const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true }
const source = 'flowchart LR\n  A[同名节点] --> B[同名节点]; C[最后节点]\n  B --> C\n  %% 此处为注释\n\n'
let browser, server

async function available() { try { return (await fetch(baseURL, { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }
async function ensureServer() {
  if (await available()) return
  if (process.env.BASE_URL) throw Error(`Cannot reach ${baseURL}`)
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', data => { log += data }); server.stderr.on('data', data => { log += data })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await available()) return
    if (server.exitCode !== null) throw Error(`Development server exited: ${log}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw Error(`Development server did not become ready: ${log}`)
}
async function test(name, run, viewport = contextOptions.viewport) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return
  const context = await browser.newContext({ ...contextOptions, viewport }), page = await context.newPage(), errors = []
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(baseURL); await page.getByTestId('create-canvas').waitFor(); await run(page, context)
    assert.deepEqual(errors, [], 'No uncaught browser errors')
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
    results.push({ name, pass: true }); process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true, animations: 'disabled' }).catch(() => {})
    results.push({ name, pass: false, error: error.stack || String(error) }); process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`)
  } finally { await context.close() }
}
function elements(page, type = 'stroke') { return page.locator(`g[data-element-id][data-element-type="${type}"]`) }
async function stagePoint(page, x, y) { const box = await page.getByTestId('canvas-stage').boundingBox(); assert.ok(box && box.width > 100); return { x: box.x + box.width * x, y: box.y + box.height * y } }
async function stroke(page, y = .45) {
  const start = await stagePoint(page, .24, y)
  await page.mouse.move(start.x, start.y); await page.mouse.down()
  for (let index = 1; index <= 24; index++) { const point = await stagePoint(page, .24 + index * .018, y + Math.sin(index / 24 * Math.PI * 2) * .055); await page.mouse.move(point.x, point.y) }
  await page.mouse.up()
}
async function rectangle(page) {
  await page.getByTestId('tool-rectangle').click(); const a = await stagePoint(page, .12, .16), b = await stagePoint(page, .30, .28)
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up()
}
async function openBrushes(page) { if (!await page.getByTestId('brush-settings-panel').isVisible()) await page.getByTestId('brush-settings-toggle').click(); await expect(page.getByTestId('brush-settings-panel')).toBeVisible() }
async function chooseBrush(page, kind, configure) {
  await openBrushes(page); await page.getByTestId(`brush-${kind}`).click(); await expect(page.getByTestId(`brush-${kind}`)).toHaveAttribute('aria-pressed', 'true')
  if (configure) await configure()
  await page.getByTestId('brush-start').click(); await expect(page.getByTestId('brush-settings-panel')).toHaveCount(0)
}
async function range(page, id, value) { await page.getByTestId(id).fill(String(value)) }
async function download(page, trigger) { const pending = page.waitForEvent('download'); await trigger(); const item = await pending; assert.equal(await item.failure(), null); return { name: item.suggestedFilename(), bytes: await fs.readFile(await item.path()) } }
async function save(page) { const file = await download(page, () => page.getByTitle('保存 (Ctrl+S)', { exact: true }).click()); assert.match(file.name, /\.owflow$/); return { ...file, document: JSON.parse(file.bytes.toString('utf8')) } }
async function exportFile(page, format = 'svg') { await page.getByTitle('导出', { exact: true }).click(); return download(page, () => page.getByRole('menuitem', { name: format === 'svg' ? 'SVG 矢量图' : 'PNG 图片', exact: true }).click()) }
async function undo(page) { await page.getByRole('button', { name: '撤销', exact: true }).click() }
async function redo(page) { await page.getByRole('button', { name: '重做', exact: true }).click() }
async function reopen(file, check) {
  const context = await browser.newContext(contextOptions), page = await context.newPage()
  try { await page.goto(baseURL); await page.getByTestId('create-canvas').waitFor(); await page.locator('#file-input').setInputFiles({ name: file.name, mimeType: 'application/json', buffer: file.bytes }); await check(page) } finally { await context.close() }
}
async function drafts(page) { return page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.open('open-workflow-v1', 1); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const query = db.transaction('drafts', 'readonly').objectStore('drafts').getAll(); query.onsuccess = () => { db.close(); resolve(query.result) }; query.onerror = () => { db.close(); reject(query.error) } } })) }
async function penStroke(page, y, force = true) {
  const session = await page.context().newCDPSession(page), start = await stagePoint(page, .24, y)
  try {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: force ? .15 : .5 })
    for (let index = 1; index <= 14; index++) { const point = await stagePoint(page, .24 + index * .027, y + (index % 2 ? .018 : -.018)); await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1, pointerType: 'pen', force: force ? .15 + index / 14 * .8 : .5 }) }
    const end = await stagePoint(page, .67, y)
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 })
    return end
  } finally { await session.detach() }
}
async function pngHasDrawing(page, bytes) {
  const result = await page.evaluate(async data => { const image = new Image(); await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = data }); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 20 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 220) ink++; return { width: canvas.width, height: canvas.height, ink } }, `data:image/png;base64,${bytes.toString('base64')}`)
  assert.ok(result.width > 100 && result.height > 20 && result.ink > 100, `PNG contains visible drawing: ${JSON.stringify(result)}`)
}
async function createDiagram(page, text = source) { await page.getByTestId('create-diagram').click(); await page.getByTestId('diagram-source').fill(text); await expect(page.getByTestId('diagram-error')).toHaveCount(0); await expect(page.locator('.diagram-preview-art > svg')).toBeVisible(); await expect(page.locator('.diagram-preview-scroll')).toHaveAttribute('aria-busy', 'false') }
function highlights(page) { return page.locator('[data-testid="diagram-source-overlay"] [data-source-element-id]') }
async function highlightedIds(page) { return highlights(page).evaluateAll(groups => groups.map(group => group.getAttribute('data-source-element-id')).sort()) }
async function highlightedLabels(page) { return page.evaluate(() => { const boxes = [...document.querySelectorAll('[data-testid="diagram-source-overlay"] [data-source-element-id]')].map(group => group.getBoundingClientRect()); return [...document.querySelectorAll('.diagram-preview-art > svg text')].filter(text => { const box = text.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2; return boxes.some(highlight => x >= highlight.left && x <= highlight.right && y >= highlight.top && y <= highlight.bottom) }).map(text => text.textContent) }) }
async function caret(page, offset, end = offset) { await page.getByTestId('diagram-source').evaluate((input, range) => { input.focus(); input.setSelectionRange(range[0], range[1]); input.dispatchEvent(new Event('select', { bubbles: true })) }, [offset, end]) }
async function locateToken(page, token, text = source) { const index = text.indexOf(token); assert.ok(index >= 0, `Missing source token: ${token}`); await caret(page, index + Math.min(1, token.length - 1)); await expect.poll(() => highlights(page).count()).toBeGreaterThan(0); return highlightedIds(page) }
async function clickSourceToken(page, token, text = source) {
  const index = text.indexOf(token); assert.ok(index >= 0)
  const position = await page.getByTestId('diagram-source').evaluate((input, offset) => {
    const before = input.value.slice(0, offset), lines = before.split('\n'), style = getComputedStyle(input), canvas = document.createElement('canvas'), context = canvas.getContext('2d')
    context.font = style.font
    return { x: parseFloat(style.paddingLeft) + context.measureText(lines.at(-1)).width + 3 - input.scrollLeft, y: parseFloat(style.paddingTop) + (lines.length - .5) * parseFloat(style.lineHeight) - input.scrollTop }
  }, index)
  await page.getByTestId('diagram-source').click({ position })
  await expect.poll(() => highlights(page).count()).toBeGreaterThan(0)
  return highlightedIds(page)
}
async function chooseTemplate(page, kind) { await page.getByTestId('diagram-template-toggle').click(); await page.locator(`[data-diagram-kind="${kind}"]`).first().click(); if (await page.getByTestId('diagram-confirm-template').isVisible()) await page.getByTestId('diagram-confirm-template').click(); await expect(page.getByTestId('diagram-template-library')).toHaveCount(0); await expect(page.getByTestId('diagram-error')).toHaveCount(0); await expect(page.locator('.diagram-preview-scroll')).toHaveAttribute('aria-busy', 'false') }
async function assertFits(page, locator) { const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth); assert.ok(overflow <= 1, `Page overflow: ${overflow}`); if (locator) { const box = await locator.boundingBox(), view = page.viewportSize(); assert.ok(box && box.x >= 0 && box.x + box.width <= view.width + 1 && box.y >= 0 && box.y + box.height <= view.height + 1, `Panel outside viewport: ${JSON.stringify(box)}`) } }

async function main() {
  await fs.mkdir(output, { recursive: true }); await ensureServer()
  const executablePath = process.env.CHROMIUM_EXECUTABLE || (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  for (const kind of kinds) await test(`brush-${kind}-draw-svg-native-roundtrip`, async page => {
    await page.getByTestId('create-canvas').click(); await chooseBrush(page, kind); await stroke(page)
    await expect(elements(page)).toHaveCount(1); await expect(elements(page).locator(`[data-brush="${kind}"]`)).toHaveCount(1)
    const file = await save(page), ink = file.document.scene.elements[0]
    assert.equal(ink.type, 'stroke'); assert.equal(ink.brush, kind); assert.ok(ink.points.length >= 10)
    const svg = (await exportFile(page)).bytes.toString('utf8'); assert.match(svg, new RegExp(`data-brush="${kind}"`))
    if (kind === 'pencil') assert.ok((svg.match(/data-pencil-pass=/g) || []).length >= 2)
    if (kind === 'rainbow') assert.ok(new Set(svg.match(/hsl\([^)]*\)/g)).size > 4, 'Rainbow follows a sequence of distinct colors')
    if (kind === 'brush' || kind === 'pen' || kind === 'marker') assert.match(svg, /<path[^>]*d="[^"]*[zZ]"/, 'The brush renders a filled width outline')
    if (kind === 'highlighter') assert.match(svg, /opacity="0?\.32"/, 'Highlight ink remains translucent')
    await reopen(file, async fresh => { await expect(elements(fresh).locator(`[data-brush="${kind}"]`)).toHaveCount(1); assert.deepEqual((await save(fresh)).document.scene, file.document.scene, 'Native reopening preserves the stroke and its drawing parameters') })
  })

  await test('brush-parameters-pressure-smoothing-and-final-pointer-sample', async page => {
    await page.getByTestId('create-canvas').click(); await rectangle(page)
    const shape = (await save(page)).document.scene.elements[0]
    await chooseBrush(page, 'brush', async () => { await page.getByTestId('brush-width').fill('18'); await page.getByTestId('brush-width').press('Tab'); await range(page, 'brush-opacity', .65); await range(page, 'brush-smoothing', 0); await page.getByTestId('brush-color-e05263').click(); if (await page.getByTestId('brush-pressure').getAttribute('aria-checked') !== 'true') await page.getByTestId('brush-pressure').click() })
    const end = await penStroke(page, .45)
    const first = (await save(page)).document.scene.elements[1]
    assert.equal(first.style.strokeWidth, 18); assert.equal(first.style.opacity, .65); assert.equal(first.style.stroke, '#e05263')
    assert.equal(first.pressures.length, first.points.length); assert.ok(Math.max(...first.pressures) - Math.min(...first.pressures) > .5, 'Stylus pressure is captured as meaningful varying samples')
    const last = first.points.at(-1), start = await stagePoint(page, .24, .45)
    assert.ok(Math.abs((last.x - first.points[0].x) - (end.x - start.x)) < 2, 'A fast final pointer-up sample reaches the actual endpoint')
    await chooseBrush(page, 'brush', async () => { await range(page, 'brush-smoothing', 1); if (await page.getByTestId('brush-pressure').getAttribute('aria-checked') === 'true') await page.getByTestId('brush-pressure').click() })
    await penStroke(page, .65)
    const saved = await save(page), second = saved.document.scene.elements[2]
    assert.deepEqual(saved.document.scene.elements[0], shape, 'Brush defaults never restyle an unrelated selected shape')
    assert.ok(!second.pressures || new Set(second.pressures).size <= 1, 'Turning pressure off produces stable width')
    const variations = item => item.points.slice(1).reduce((total, point, index) => total + Math.abs(point.y - item.points[index].y), 0)
    assert.ok(variations(second) < variations(first) * .9, 'Smoothing reduces a deliberately zigzagging pointer trajectory')
    await pngHasDrawing(page, (await exportFile(page, 'png')).bytes)
  })

  await test('brush-selected-restyle-history-and-defaults-isolation', async page => {
    await page.getByTestId('create-canvas').click(); await rectangle(page); await chooseBrush(page, 'pen'); await stroke(page)
    const original = (await save(page)).document.scene
    await page.getByTestId('selected-brush').selectOption('rainbow'); await expect(elements(page).locator('[data-brush="rainbow"]')).toHaveCount(1)
    const changed = (await save(page)).document.scene
    assert.deepEqual(changed.elements[0], original.elements[0]); assert.deepEqual(changed.elements[1].points, original.elements[1].points)
    await undo(page); assert.deepEqual((await save(page)).document.scene, original)
    await redo(page); assert.deepEqual((await save(page)).document.scene, changed)
    await openBrushes(page); await page.getByTestId('brush-pencil').click(); await page.getByRole('button', { name: '关闭笔触设置', exact: true }).click()
    assert.deepEqual((await save(page)).document.scene, changed, 'Changing the next brush does not modify a selected drawing')
    await pngHasDrawing(page, (await exportFile(page, 'png')).bytes)
  })

  await test('laser-trail-expires-without-draft-or-history-or-export', async page => {
    await page.getByTestId('create-canvas').click(); await rectangle(page); const before = await save(page)
    await expect.poll(async () => (await drafts(page))[0]?.document.scene.elements.length).toBe(1)
    const stored = await drafts(page), svg = (await exportFile(page)).bytes.toString('utf8')
    await page.getByTestId('tool-laser').click(); const point = await stagePoint(page, .45, .5)
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 130, point.y + 50, { steps: 10 })
    await expect(page.getByTestId('laser-trail').first()).toBeVisible(); await expect(elements(page)).toHaveCount(0)
    await page.mouse.up(); await expect(page.getByTestId('laser-trail')).toHaveCount(0, { timeout: 2500 })
    assert.deepEqual(await drafts(page), stored, 'A temporary pointer never updates the automatic draft')
    assert.equal((await exportFile(page)).bytes.toString('utf8'), svg, 'Temporary trails are absent from SVG export')
    assert.deepEqual((await save(page)).document.scene, before.document.scene)
    await undo(page); await expect(elements(page, 'shape')).toHaveCount(0)
    await redo(page); await expect(elements(page, 'shape')).toHaveCount(1)
  })

  await test('brush-mobile-panel-svg-controls-and-drawing', async page => {
    await page.getByTestId('create-canvas').click(); await openBrushes(page); await assertFits(page, page.getByTestId('brush-settings-panel'))
    for (const kind of kinds) { const button = page.getByTestId(`brush-${kind}`); await expect(button).toBeVisible(); await expect(button.locator('svg')).toHaveCount(1) }
    await expect(page.getByTestId('brush-pressure').locator('svg')).toHaveCount(1)
    await page.getByTestId('brush-rainbow').click(); await page.getByTestId('brush-start').click(); await stroke(page)
    await expect(elements(page)).toHaveCount(1); await assertFits(page)
    await page.getByTestId('tool-laser').scrollIntoViewIfNeeded(); await expect(page.getByTestId('tool-laser').locator('svg')).toHaveCount(1)
  }, { width: 320, height: 740 })

  await test('diagram-caret-exact-chinese-node-edge-selection-and-keyboard', async page => {
    await createDiagram(page)
    const a = await locateToken(page, 'A[同名节点]'), b = await locateToken(page, 'B[同名节点]'), c = await locateToken(page, 'C[最后节点]')
    assert.equal(a.length, 1); assert.equal(b.length, 1); assert.equal(c.length, 1); assert.notDeepEqual(a, b, 'Identical Chinese labels keep distinct source identities'); assert.notDeepEqual(b, c, 'Semicolon-separated declarations locate independently')
    assert.deepEqual(await highlightedLabels(page), ['最后节点'], 'The highlighted preview geometry encloses the node described by the source')
    assert.deepEqual(await clickSourceToken(page, 'A[同名节点]'), a, 'Clicking the source positions the actual caret and locates its node')
    assert.deepEqual(await highlightedLabels(page), ['同名节点'])
    const edge = await locateToken(page, '-->'); assert.equal(edge.length, 1); assert.ok(![...a, ...b, ...c].includes(edge[0]))
    await caret(page, source.indexOf('A['), source.indexOf(';')); await expect.poll(() => highlights(page).count()).toBe(3)
    await caret(page, source.indexOf('B[同名节点]')); await page.getByTestId('diagram-source').press('ArrowLeft'); await page.getByTestId('diagram-source').press('ArrowLeft')
    assert.deepEqual(await highlightedIds(page), edge, 'Keyboard cursor movement updates the highlighted connector')
    await page.getByTestId('diagram-source').press('Home'); await page.getByTestId('diagram-source').press('ArrowDown'); await page.getByTestId('diagram-source').press('End')
    await expect(page.getByTestId('diagram-source-location')).toContainText('第 3 行')
    await expect.poll(() => highlights(page).count()).toBeGreaterThan(0)
  })

  await test('diagram-location-clears-comments-errors-and-pending-source', async page => {
    await createDiagram(page); await locateToken(page, 'A[同名节点]')
    await caret(page, source.indexOf('此处为注释') + 2); await expect(highlights(page)).toHaveCount(0)
    await caret(page, source.length - 1); await expect(highlights(page)).toHaveCount(0)
    await locateToken(page, 'B[同名节点]')
    await page.getByTestId('diagram-source').fill('flowchart LR\n  New[新节点] --> End[结束]')
    await expect(highlights(page)).toHaveCount(0)
    await expect(page.locator('.diagram-preview-art > svg')).toContainText('新节点')
    await locateToken(page, 'New[新节点]', await page.getByTestId('diagram-source').inputValue())
    await page.getByTestId('diagram-source').fill('unrecognizedDiagram\n  invalid')
    await expect(page.getByTestId('diagram-error')).toBeVisible(); await expect(highlights(page)).toHaveCount(0)
    const invalid = await save(page); assert.equal(invalid.document.source, 'unrecognizedDiagram\n  invalid')
    await page.getByTestId('diagram-source').fill(source); await expect(page.locator('.diagram-preview-art > svg')).toContainText('同名节点')
    await locateToken(page, 'C[最后节点]'); await expect(page.getByTestId('diagram-error')).toHaveCount(0)
  })

  await test('diagram-location-style-zoom-export-and-native-cleanliness', async page => {
    await createDiagram(page); const a = await locateToken(page, 'A[同名节点]'), before = await save(page)
    const exported = await exportFile(page), markup = exported.bytes.toString('utf8')
    assert.ok(!/data-source-element-id|diagram-source-overlay/.test(markup), 'Source focus is excluded from exported drawing content')
    await locateToken(page, 'C[最后节点]'); assert.equal((await exportFile(page)).bytes.toString('utf8'), markup, 'Moving the cursor does not alter exported SVG bytes')
    assert.deepEqual((await save(page)).document.scene, before.document.scene, 'Location is not a document edit')
    await page.getByTestId('diagram-style-toggle').click(); await page.locator('[data-diagram-style="midnight"]').click(); await page.keyboard.press('Escape')
    assert.deepEqual(await locateToken(page, 'A[同名节点]'), a, 'Style changes preserve source identities')
    await page.getByRole('button', { name: '放大预览', exact: true }).click(); await page.getByRole('button', { name: '放大预览', exact: true }).click(); await page.getByTestId('diagram-locate-current').click()
    await expect(page.getByTestId('diagram-source-overlay')).toBeVisible(); assert.deepEqual(await highlightedIds(page), a)
    const alignment = await page.evaluate(() => { const art = document.querySelector('.diagram-preview-art > svg'), overlay = document.querySelector('[data-testid="diagram-source-overlay"]'); const first = art.getBoundingClientRect(), second = overlay.getBoundingClientRect(); return { x: Math.abs(first.x - second.x), y: Math.abs(first.y - second.y), width: Math.abs(first.width - second.width), height: Math.abs(first.height - second.height), viewBox: art.getAttribute('viewBox') === overlay.getAttribute('viewBox') } })
    assert.ok(alignment.viewBox && Object.entries(alignment).filter(([key]) => key !== 'viewBox').every(([, difference]) => difference <= 2), `Highlight stays aligned with the zoomed diagram: ${JSON.stringify(alignment)}`)
    const file = await save(page); assert.equal(file.document.source, source); assert.equal(file.document.diagramStyle, 'midnight'); assert.ok(!/sourceMap|source-element|source-overlay/.test(file.bytes.toString('utf8')))
    await pngHasDrawing(page, (await exportFile(page, 'png')).bytes)
    await reopen(file, async fresh => { await expect(fresh.getByTestId('diagram-source')).toHaveValue(source); await locateToken(fresh, 'B[同名节点]') })
  })

  for (const [label, newline] of [['crlf', '\r\n'], ['cr', '\r']]) await test(`diagram-source-location-${label}-native-line-endings`, async page => {
    await createDiagram(page); const original = await save(page), normalized = source.replace('; C[最后节点]', '').replace('  B --> C\n', '  B --> C[最后节点]\n'), raw = normalized.replaceAll('\n', newline)
    const file = { name: `source-${label}.owflow`, bytes: Buffer.from(JSON.stringify({ ...original.document, source: raw })) }
    await reopen(file, async fresh => {
      await expect(fresh.getByTestId('diagram-source')).toHaveValue(normalized)
      const a = await locateToken(fresh, 'A[同名节点]', normalized), arrow = await locateToken(fresh, '-->', normalized), b = await locateToken(fresh, 'B[同名节点]', normalized)
      assert.equal(a.length, 1); assert.equal(arrow.length, 1); assert.equal(b.length, 1); assert.notDeepEqual(a, b); assert.notDeepEqual(a, arrow)
      const c = await locateToken(fresh, 'C[最后节点]', normalized); assert.equal(c.length, 1); assert.notDeepEqual(c, b); await expect(fresh.getByTestId('diagram-source-location')).toContainText('第 3 行')
      await caret(fresh, normalized.indexOf('  B --> C') + 2); await expect(fresh.getByTestId('diagram-source-location')).toContainText('第 3 行')
      assert.deepEqual(await highlightedIds(fresh), b, 'A reference on a later normalized textarea line locates its node')
      await caret(fresh, normalized.indexOf('  B --> C') + 3); await expect(highlights(fresh)).toHaveCount(0)
      assert.equal((await save(fresh)).document.source, raw, 'Moving the caret and saving preserve original file line endings')
    })
    const invalidSource = ['flowchart LR', '  A[正常]', '  Broken[未闭合'].join(newline)
    const invalid = { name: `source-${label}-invalid.owflow`, bytes: Buffer.from(JSON.stringify({ ...original.document, source: invalidSource })) }
    await reopen(invalid, async fresh => {
      await expect(fresh.getByTestId('diagram-error')).toBeVisible(); await fresh.getByRole('button', { name: '定位到第 3 行', exact: true }).click()
      const selected = await fresh.getByTestId('diagram-source').evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd))
      assert.equal(selected, '  Broken[未闭合'); await expect(fresh.getByTestId('diagram-source-location')).toContainText('第 3 行')
      assert.equal((await save(fresh)).document.source, invalidSource)
    })
  })

  await test('diagram-source-location-all-22-template-types', async page => {
    await createDiagram(page)
    const tokens = { flowchart: 'start([', sequence: 'User->>App', class: '+String id', state: 'Pending --> Paying', er: 'string id PK', gitgraph: 'commit id:', requirement: 'text: 系统应', c4: 'Person(customer', architecture: 'service frontend', pie: '"产品设计"', gantt: '需求梳理 :done', xychart: 'bar [35', quadrant: '搜索优化:', sankey: '预算,产品研发', radar: 'curve current', treemap: '"产品设计":', mindmap: 'goals[目标]', timeline: '第 1 周', journey: '了解产品:', kanban: 'research[', block: 'gateway[', packet: '0-15:' }
    assert.equal(Object.keys(tokens).length, 22)
    for (const [kind, token] of Object.entries(tokens)) {
      await chooseTemplate(page, kind); const text = await page.getByTestId('diagram-source').inputValue()
      const ids = await locateToken(page, token, text); assert.ok(ids.length, `${kind} maps the selected source content to generated elements`)
      assert.ok(await highlights(page).first().isVisible(), `${kind} shows the location on its preview`)
      await caret(page, 0); await expect(highlights(page)).toHaveCount(0)
    }
  })

  await fs.writeFile(path.join(output, 'results-brush-cursor.json'), JSON.stringify(results, null, 2))
  assert.ok(results.length, 'No matching cases'); assert.ok(results.every(result => result.pass), `${results.filter(result => !result.pass).length} brush or source-location case(s) failed; see ${output}`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }).finally(async () => { if (browser) await browser.close(); if (server) server.kill('SIGTERM') })
