/* Acceptance for the unified canvas, open braces and automatic local drafts.
 * Run: node tests/browser/canvas-workspace.cjs
 * BASE_URL, TEST_FILTER, CHROMIUM_EXECUTABLE and BROWSER_ARTIFACTS are optional.
 * Every case owns a fresh browser context.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5199'
const output = process.env.BROWSER_ARTIFACTS || '/tmp/open-workflow-canvas-workspace'
const results = []
const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true }
const braces = { left: '左大括弧', right: '右大括弧', top: '上大括弧', bottom: '下大括弧' }
let browser, server

async function available() {
  try { return (await fetch(baseURL, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
}
async function ensureServer() {
  if (await available()) return
  if (process.env.BASE_URL) throw new Error(`Cannot reach ${baseURL}`)
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', data => { log += data })
  server.stderr.on('data', data => { log += data })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await available()) return
    if (server.exitCode !== null) throw new Error(`Vite exited: ${log}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Vite did not become ready: ${log}`)
}

async function test(name, run, viewport = contextOptions.viewport) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return
  const context = await browser.newContext({ ...contextOptions, viewport })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(baseURL)
    await page.getByTestId('create-canvas').waitFor()
    await run(page, context)
    assert.deepEqual(errors, [], 'No uncaught browser errors')
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
    results.push({ name, pass: true }); process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true, animations: 'disabled' }).catch(() => {})
    results.push({ name, pass: false, error: error.stack || String(error) }); process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`)
  } finally { await context.close() }
}
function elements(page, type = 'shape') { return page.locator(`g[data-element-id][data-element-type="${type}"]`) }
async function stagePoint(page, x, y) {
  const stage = await page.getByTestId('canvas-stage').boundingBox()
  assert.ok(stage && stage.width > 150 && stage.height > 200)
  return { x: stage.x + stage.width * x, y: stage.y + stage.height * y }
}
async function gesture(page, start, end) {
  await page.mouse.move(start.x, start.y); await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 16 }); await page.mouse.up()
}
async function draw(page, tool, from, to) {
  await page.getByTestId(`tool-${tool}`).click()
  await gesture(page, await stagePoint(page, ...from), await stagePoint(page, ...to))
}
async function download(page, trigger) {
  const pending = page.waitForEvent('download'); await trigger(); const item = await pending
  assert.equal(await item.failure(), null)
  return { name: item.suggestedFilename(), bytes: await fs.readFile(await item.path()) }
}
async function save(page) {
  const file = await download(page, () => page.getByTitle('保存 (Ctrl+S)', { exact: true }).click())
  assert.match(file.name, /\.owflow$/)
  return { ...file, document: JSON.parse(file.bytes.toString('utf8')) }
}
async function svg(page) {
  await page.getByTitle('导出', { exact: true }).click()
  return download(page, () => page.getByRole('menuitem', { name: 'SVG 矢量图', exact: true }).click())
}
async function undo(page) { await page.getByRole('button', { name: '撤销', exact: true }).click() }
async function redo(page) { await page.getByRole('button', { name: '重做', exact: true }).click() }
async function drafts(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('open-workflow-v1', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('drafts')) { database.close(); resolve([]); return }
      const query = database.transaction('drafts', 'readonly').objectStore('drafts').getAll()
      query.onsuccess = () => { database.close(); resolve(query.result) }
      query.onerror = () => { database.close(); reject(query.error) }
    }
  }))
}
async function noDelayedDraftChange(page, expected) {
  // The product's automatic write debounce is 300 ms. Observe beyond two
  // debounce windows before asserting that a disabled write never started.
  await page.waitForTimeout(700)
  assert.deepEqual(await drafts(page), expected)
}
async function openLibrary(page) {
  const toggle = page.getByRole('button', { name: '图形素材面板', exact: true })
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
}
async function drawBrace(page, direction) {
  await openLibrary(page)
  await page.getByTestId(`shape-brace-${direction}`).click()
  await gesture(page, await stagePoint(page, .30, .30), await stagePoint(page, .63, .70))
  await page.getByRole('button', { name: '图形素材面板', exact: true }).click()
  await expect(elements(page)).toHaveCount(1)
  return elements(page).first()
}
async function pathPoint(locator, fraction = .5) {
  return locator.evaluate((group, fraction) => {
    const outline = [...group.querySelectorAll('path')].find(path => path.getAttribute('stroke') !== 'transparent' && path.getAttribute('stroke') !== 'none')
    if (!outline) throw Error('Shape has no real stroked outline')
    const local = outline.getPointAtLength(outline.getTotalLength() * fraction)
    const point = new DOMPoint(local.x, local.y).matrixTransform(outline.getScreenCTM())
    return { x: point.x, y: point.y }
  }, fraction)
}
async function assertFits(page) {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)
  assert.ok(overflow <= 1, `Horizontal page overflow: ${overflow}`)
}
async function reopen(file, check) {
  const context = await browser.newContext(contextOptions), page = await context.newPage()
  try {
    await page.goto(baseURL); await page.getByTestId('create-canvas').waitFor()
    await page.locator('#file-input').setInputFiles({ name: file.name, mimeType: 'application/json', buffer: file.bytes })
    await expect(page.getByTestId('canvas-stage')).toBeVisible(); await check(page)
  } finally { await context.close() }
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await ensureServer()
  const executablePath = process.env.CHROMIUM_EXECUTABLE || (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  await test('canvas-unified-entry-and-both-starting-templates', async page => {
    await expect(page.locator('.create-card')).toHaveCount(2)
    await expect(page.getByTestId('create-canvas')).toContainText('画布')
    await page.getByTestId('create-canvas').click()
    await expect(elements(page)).toHaveCount(0)
    assert.equal((await save(page)).document.kind, 'flow')
    for (const tool of ['rectangle', 'edge', 'note', 'pen', 'highlighter', 'eraser', 'frame']) await expect(page.getByTestId(`tool-${tool}`)).toBeVisible()
    await expect(page.getByTestId('board-template-toggle')).toBeVisible()
    await expect(page.getByTestId('canvas-auto-layout')).toBeVisible()
    for (const template of ['flow', 'board']) {
      await page.getByTestId('board-template-toggle').click()
      await page.locator(`[data-board-template="${template}"]`).click()
      await expect.poll(() => elements(page).count()).toBeGreaterThan(2)
      if (template === 'flow') await expect.poll(() => elements(page, 'edge').count()).toBeGreaterThan(0)
      await undo(page); await expect(elements(page)).toHaveCount(0)
    }
    await page.locator('.tab-home').click()
    await page.getByRole('button', { name: '项目审批流程', exact: true }).click()
    assert.ok(await elements(page).count() >= 4)
    await expect(page.getByTestId('tool-pen')).toBeVisible()
    await expect(page.getByTestId('board-template-toggle')).toBeVisible()
    await page.locator('.tab-home').click()
    await page.getByRole('button', { name: '灵感收集板', exact: true }).click()
    const board = await save(page)
    assert.equal(board.document.kind, 'board', 'Existing board protocol remains compatible')
    assert.ok(board.document.scene.elements.some(element => element.shape === 'note'))
    await expect(page.getByTestId('tool-edge')).toBeVisible()
    await page.getByTestId('board-template-toggle').click()
    await page.locator('[data-board-template="brainstorm"]').click()
    await expect.poll(() => elements(page).count()).toBeGreaterThan(board.document.scene.elements.filter(element => element.type === 'shape').length)
    await undo(page)
    assert.deepEqual((await save(page)).document.scene, board.document.scene, 'Template insertion is undoable in an existing board document')
  })

  await test('canvas-autosave-off-manual-save-and-reenable-current-state', async page => {
    let downloads = 0; page.on('download', () => downloads++)
    const toggle = page.getByTestId('autosave-toggle')
    await expect(toggle).toHaveAttribute('role', 'switch')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('create-canvas').click()
    await draw(page, 'rectangle', [.15, .32], [.33, .50])
    await expect.poll(async () => (await drafts(page))[0]?.document.scene.elements.length).toBe(1)
    const original = await drafts(page)
    assert.equal(downloads, 0)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await draw(page, 'ellipse', [.55, .32], [.73, .50])
    await noDelayedDraftChange(page, original)
    await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('beforeunload', { cancelable: true })) })
    await noDelayedDraftChange(page, original)
    const manual = await save(page)
    assert.equal(manual.document.scene.elements.length, 2)
    await expect.poll(async () => (await drafts(page))[0]?.document.scene.elements.length).toBe(2)
    assert.equal(downloads, 1)
    await draw(page, 'diamond', [.35, .62], [.53, .80])
    const beforeEnable = await drafts(page)
    await noDelayedDraftChange(page, beforeEnable)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => (await drafts(page))[0]?.document.scene.elements.length).toBe(3)
    assert.equal(downloads, 1, 'The switch controls local drafts and never downloads a file')
  })

  await test('canvas-autosave-preference-reload-and-unsaved-close-protection', async page => {
    await page.getByTestId('autosave-toggle').click()
    await page.reload()
    await expect(page.getByTestId('autosave-toggle')).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('create-canvas').click()
    await draw(page, 'rectangle', [.23, .32], [.48, .56])
    await noDelayedDraftChange(page, [])
    await page.locator('.tab-close').last().click()
    await expect(page.getByRole('dialog')).toContainText('尚未保存')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(elements(page)).toHaveCount(1)
    await page.locator('.tab-close').last().click()
    const file = await download(page, () => page.getByRole('button', { name: '保存并关闭', exact: true }).click())
    assert.equal(JSON.parse(file.bytes).scene.elements.length, 1)
    await expect(page.getByTestId('create-canvas')).toBeVisible()
    assert.equal((await drafts(page))[0].document.scene.elements.length, 1)
    await page.reload()
    await expect(page.getByTestId('autosave-toggle')).toHaveAttribute('aria-checked', 'false')
    await page.locator('.recent-open').first().click()
    await expect(elements(page)).toHaveCount(1)
  })

  for (const [direction, label] of Object.entries(braces)) await test(`canvas-brace-${direction}-outline-text-erase-save-svg`, async page => {
    await page.getByTestId('create-canvas').click()
    const brace = await drawBrace(page, direction)
    const outline = await brace.evaluate(group => [...group.querySelectorAll('path')].find(path => path.getAttribute('stroke') !== 'transparent')?.getAttribute('d'))
    assert.ok(outline && /[CQ]/i.test(outline) && !/z/i.test(outline), 'A brace is an open curved outline, not a closed rectangle')
    const box = await page.locator('.selection-overlay > rect').first().boundingBox()
    const blank = { x: box.x + box.width * (direction === 'left' ? .8 : .2), y: box.y + box.height * (direction === 'top' ? .8 : .2) }
    await page.getByTestId('tool-eraser').click()
    await gesture(page, blank, { x: blank.x + 2, y: blank.y + 2 })
    await expect(elements(page)).toHaveCount(1)
    const curve = await pathPoint(brace, .35)
    await gesture(page, curve, { x: curve.x + 2, y: curve.y + 2 })
    await expect(elements(page)).toHaveCount(0)
    await undo(page)
    await expect(elements(page)).toHaveCount(1)
    await page.getByTestId('tool-select').click()
    const editPoint = await pathPoint(brace)
    await page.mouse.dblclick(editPoint.x, editPoint.y)
    await expect(page.locator('.inline-text-editor')).toBeFocused()
    await page.locator('.inline-text-editor').fill(`${label}的说明文字`)
    await page.locator('.inline-text-editor').press('Control+Enter')
    await expect(brace).toContainText(`${label}的说明文字`)
    await page.getByRole('button', { name: '缩小', exact: true }).click()
    await expect(brace).toContainText(`${label}的说明文字`)
    const native = await save(page), shape = native.document.scene.elements[0]
    assert.equal(shape.shape, `brace-${direction}`)
    assert.equal(shape.text, `${label}的说明文字`)
    const exported = await svg(page)
    const result = await page.evaluate(markup => {
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
      return { error: doc.querySelector('parsererror')?.textContent, text: [...doc.querySelectorAll('text')].map(node => node.textContent).join(''), paths: [...doc.querySelectorAll('path')].map(node => node.getAttribute('d')) }
    }, exported.bytes.toString('utf8'))
    assert.equal(result.error, undefined)
    assert.ok(result.text.includes(`${label}的说明文字`))
    assert.ok(result.paths.includes(outline), 'SVG export preserves the real open brace geometry')
    await reopen(native, async fresh => {
      await expect(elements(fresh)).toHaveCount(1)
      await expect(elements(fresh)).toContainText(`${label}的说明文字`)
      assert.deepEqual((await save(fresh)).document.scene, native.document.scene)
    })
  })

  for (const zoom of [50, 200]) await test(`canvas-brace-real-outline-binding-at-${zoom}-percent`, async page => {
    await page.getByTestId('create-canvas').click()
    const brace = await drawBrace(page, 'left')
    await draw(page, 'rectangle', [.49, .35], [.59, .45])
    const rectangle = elements(page).last(), braceId = await brace.getAttribute('data-element-id'), rectangleId = await rectangle.getAttribute('data-element-id')
    const point = await pathPoint(brace)
    await page.mouse.move(point.x, point.y); await page.keyboard.down('Control')
    await page.mouse.wheel(0, zoom === 50 ? Math.log(2) / .002 : -Math.log(2) / .002); await page.keyboard.up('Control')
    await expect.poll(async () => Number((await page.getByTitle('重置为 100%', { exact: true }).innerText()).replace('%', ''))).toBe(zoom)
    await page.getByTestId('tool-edge').click()
    const box = await brace.boundingBox(), blank = { x: box.x + box.width * 2, y: box.y + box.height * .75 }
    await page.mouse.move(blank.x, blank.y)
    await expect(page.getByTestId('binding-preview')).toHaveCount(0)
    const outlinePoint = await pathPoint(brace, .35)
    await page.mouse.move(outlinePoint.x + 4, outlinePoint.y)
    await expect(page.getByTestId('binding-preview')).toHaveAttribute('data-binding-target', braceId)
    await page.mouse.down()
    const target = await rectangle.boundingBox()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
    await expect(page.getByTestId('binding-preview')).toHaveAttribute('data-binding-target', rectangleId)
    await page.mouse.up()
    const document = (await save(page)).document, edge = document.scene.elements.find(element => element.type === 'edge')
    assert.equal(edge.from.nodeId, braceId)
    assert.equal(edge.to.nodeId, rectangleId)
    const endpointDistance = await page.evaluate(({ braceId, edgeId }) => {
      const outline = [...document.querySelector(`[data-element-id="${braceId}"]`).querySelectorAll('path')].find(path => path.getAttribute('stroke') !== 'transparent')
      const line = [...document.querySelector(`[data-element-id="${edgeId}"]`).querySelectorAll('path')].find(path => path.getAttribute('stroke') !== 'transparent')
      const start = line.getPointAtLength(0), length = outline.getTotalLength()
      let distance = Infinity
      for (let index = 0; index <= 1000; index++) { const point = outline.getPointAtLength(length * index / 1000); distance = Math.min(distance, Math.hypot(start.x - point.x, start.y - point.y)) }
      return distance
    }, { braceId, edgeId: edge.id })
    assert.ok(endpointDistance < 1, `Bound edge must terminate on the actual brace curve: ${endpointDistance}`)
  })

  await test('canvas-tool-lock-continuous-shapes-strokes-and-escape', async page => {
    await page.getByTestId('create-canvas').click()
    const lock = page.getByTestId('tool-lock')
    await expect(lock).toHaveAttribute('aria-pressed', 'false')
    await draw(page, 'rectangle', [.10, .27], [.26, .42])
    await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
    await lock.click()
    await draw(page, 'rectangle', [.38, .27], [.54, .42])
    await expect(page.getByTestId('tool-rectangle')).toHaveAttribute('aria-pressed', 'true')
    await gesture(page, await stagePoint(page, .67, .27), await stagePoint(page, .83, .42))
    await expect(elements(page)).toHaveCount(3)
    await draw(page, 'pen', [.15, .63], [.38, .73])
    await expect(page.getByTestId('tool-pen')).toHaveAttribute('aria-pressed', 'true')
    await gesture(page, await stagePoint(page, .53, .63), await stagePoint(page, .77, .73))
    await expect(elements(page, 'stroke')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(lock).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
    await draw(page, 'pen', [.15, .82], [.38, .88])
    await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
    assert.equal((await save(page)).document.scene.elements.length, 6)
    await undo(page); await expect(elements(page, 'stroke')).toHaveCount(2)
    await redo(page); await expect(elements(page, 'stroke')).toHaveCount(3)
  })

  await test('canvas-default-line-settings-only-affect-future-lines', async page => {
    await page.getByTestId('create-canvas').click()
    async function defaults(route, arrow) {
      await page.getByTestId('edge-defaults-toggle').click()
      await page.getByTestId(`default-route-${route}`).click()
      await page.getByTestId(`default-arrow-${arrow}`).click()
      await page.getByTestId('edge-defaults-toggle').click()
    }
    await draw(page, 'edge', [.18, .28], [.76, .42])
    const first = (await save(page)).document.scene.elements[0]
    assert.equal(first.route, 'orthogonal'); assert.equal(first.arrow, 'end')
    await defaults('straight', 'both')
    await page.getByTestId('tool-lock').click()
    await draw(page, 'edge', [.18, .51], [.76, .59])
    await expect(page.getByTestId('tool-edge')).toHaveAttribute('aria-pressed', 'true')
    await gesture(page, await stagePoint(page, .18, .68), await stagePoint(page, .76, .76))
    const next = (await save(page)).document
    assert.deepEqual(next.scene.elements[0], first, 'Setting defaults must not rewrite an existing line')
    for (const edge of next.scene.elements.slice(1)) { assert.equal(edge.route, 'straight'); assert.equal(edge.arrow, 'both') }
    await defaults('orthogonal', 'none')
    await draw(page, 'edge', [.18, .85], [.76, .88])
    const final = await save(page)
    assert.equal(final.document.scene.elements[3].route, 'orthogonal'); assert.equal(final.document.scene.elements[3].arrow, 'none')
    assert.deepEqual(final.document.scene.elements.slice(0, 3), next.scene.elements)
    await reopen(final, async fresh => assert.deepEqual((await save(fresh)).document.scene, final.document.scene))
  })

  await test('canvas-mobile-switch-lock-defaults-and-brace-controls', async page => {
    const toggle = page.getByTestId('autosave-toggle')
    await expect(toggle).toBeVisible(); await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('create-canvas').click()
    await assertFits(page)
    await expect(page.getByTestId('tool-lock')).toBeVisible()
    await page.getByTestId('tool-lock').click()
    await expect(page.getByTestId('tool-lock')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('edge-defaults-toggle').click()
    await expect(page.getByTestId('edge-defaults-panel')).toBeVisible()
    await page.getByTestId('default-route-straight').click()
    await page.getByTestId('default-arrow-both').click()
    await assertFits(page)
    await page.getByTestId('edge-defaults-toggle').click()
    await openLibrary(page)
    for (const direction of Object.keys(braces)) {
      const button = page.getByTestId(`shape-brace-${direction}`)
      await button.scrollIntoViewIfNeeded(); await expect(button).toBeVisible(); await expect(button.locator('svg')).toHaveCount(1)
    }
    await page.getByTestId('shape-brace-left').click()
    await gesture(page, await stagePoint(page, .20, .33), await stagePoint(page, .70, .69))
    await expect(elements(page)).toHaveCount(1)
    await assertFits(page)
  }, { width: 320, height: 740 })

  await fs.writeFile(path.join(output, 'results-canvas-workspace.json'), JSON.stringify(results, null, 2))
  assert.ok(results.length, 'No matching cases')
  assert.ok(results.every(result => result.pass), `${results.filter(result => !result.pass).length} canvas workspace case(s) failed; see ${output}`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  if (server) server.kill('SIGTERM')
})
