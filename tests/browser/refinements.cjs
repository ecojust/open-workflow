/* Browser acceptance for the canvas interaction refinements.
 * Run: node tests/browser/refinements.cjs
 * BASE_URL, TEST_FILTER, CHROMIUM_EXECUTABLE and BROWSER_ARTIFACTS are optional.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5199'
const output = process.env.BROWSER_ARTIFACTS || '/tmp/open-workflow-refinements'
const results = []
let browser
let server
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
async function test(name, run, viewport = { width: 1440, height: 1000 }) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return
  const context = await browser.newContext({ viewport, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(baseURL)
    await page.getByTestId('create-canvas').waitFor()
    await run(page, context)
    assert.deepEqual(errors, [], 'There should be no uncaught browser errors')
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
    results.push({ name, pass: true })
    process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true, animations: 'disabled' }).catch(() => {})
    results.push({ name, pass: false, error: error.stack || String(error) })
    process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`)
  } finally { await context.close() }
}
async function download(page, trigger) {
  const pending = page.waitForEvent('download')
  await trigger()
  const item = await pending
  assert.equal(await item.failure(), null)
  return { name: item.suggestedFilename(), bytes: await fs.readFile(await item.path()) }
}
async function savedDocument(page, trigger) {
  const file = await download(page, trigger || (() => page.getByTitle('保存 (Ctrl+S)', { exact: true }).click()))
  assert.match(file.name, /\.owflow$/)
  return JSON.parse(file.bytes.toString('utf8'))
}
async function gesture(page, start, end) {
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await page.mouse.up()
}
async function stagePoint(page, x, y) {
  const stage = await page.getByTestId('canvas-stage').boundingBox()
  assert.ok(stage && stage.width > 150 && stage.height > 200)
  return { x: stage.x + stage.width * x, y: stage.y + stage.height * y }
}
async function draw(page, shape, start, end) {
  await page.getByTestId(`tool-${shape}`).click()
  await gesture(page, await stagePoint(page, ...start), await stagePoint(page, ...end))
}
function elements(page, type) { return page.locator(`g[data-element-id][data-element-type="${type}"]`) }
async function center(locator) {
  const box = await locator.boundingBox()
  assert.ok(box)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
async function undo(page) {
  await page.getByTestId('canvas-stage').focus()
  await page.keyboard.press('Control+z')
}
async function redo(page) {
  await page.getByTestId('canvas-stage').focus()
  await page.keyboard.press('Control+Shift+z')
}
async function contextAction(page, locator, action) {
  await locator.click({ button: 'right' })
  const menu = page.getByTestId('canvas-context-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: action, exact: true }).click()
}
async function openGlobalStyle(page) {
  if (!await page.locator('#global-pattern').isVisible()) await page.getByTestId('global-style-toggle').click()
}
async function labelShape(page, locator, value) {
  await locator.dblclick()
  await page.locator('.inline-text-editor').fill(value)
  await page.locator('.inline-text-editor').press('Control+Enter')
}
async function assertFits(page) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
  assert.ok(sizes.document <= sizes.viewport + 1, `Document overflow: ${JSON.stringify(sizes)}`)
  assert.ok(sizes.body <= sizes.viewport + 1, `Body overflow: ${JSON.stringify(sizes)}`)
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await ensureServer()
  const executablePath = process.env.CHROMIUM_EXECUTABLE || (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
  await test('inline-edit-shapes-blank-and-edge', async page => {
    await page.getByTestId('create-canvas').click()
    await draw(page, 'rectangle', [0.13, 0.32], [0.34, 0.50])
    const first = elements(page, 'shape').first()
    await first.dblclick()
    const editor = page.locator('.inline-text-editor')
    await expect(editor).toBeFocused()
    const shapeBox = await first.boundingBox()
    const editorBox = await editor.boundingBox()
    assert.ok(Math.abs(shapeBox.x - editorBox.x) < 5, 'Shape text should edit at the shape position')
    assert.ok(Math.abs(shapeBox.y - editorBox.y) < 5)
    await editor.fill('双击原位修改')
    await editor.press('Control+Enter')
    await expect(first).toContainText('双击原位修改')
    await undo(page)
    await expect(first).not.toContainText('双击原位修改')
    await redo(page)
    await expect(first).toContainText('双击原位修改')

    const empty = await stagePoint(page, 0.60, 0.62)
    await page.mouse.dblclick(empty.x, empty.y)
    await expect(editor).toBeFocused()
    const emptyEditor = await editor.boundingBox()
    assert.ok(empty.x >= emptyEditor.x - 12 && empty.x <= emptyEditor.x + emptyEditor.width + 12, 'Blank double click should add text at the click, not canvas center')
    assert.ok(empty.y >= emptyEditor.y - 12 && empty.y <= emptyEditor.y + emptyEditor.height + 12)
    await editor.fill('点击位置的文字')
    await editor.press('Control+Enter')
    await expect(elements(page, 'shape')).toHaveCount(2)
    const saved = await savedDocument(page)
    assert.ok(saved.scene.elements.some(element => element.shape === 'text' && element.text === '点击位置的文字'))

    await draw(page, 'rectangle', [0.63, 0.32], [0.84, 0.50])
    const last = elements(page, 'shape').last()
    await page.getByTestId('tool-edge').click()
    await gesture(page, await center(first), await center(last))
    await page.getByTestId('tool-select').click()
    const edge = elements(page, 'edge')
    await edge.dblclick()
    await expect(editor).toBeFocused()
    await editor.fill('审核通过')
    const labelSave = await savedDocument(page, () => page.keyboard.press('Control+s'))
    assert.equal(labelSave.scene.elements.find(element => element.type === 'edge').label, '审核通过')
    await edge.dblclick()
    await editor.fill('取消这次修改')
    await editor.press('Escape')
    const cancelled = await savedDocument(page)
    assert.equal(cancelled.scene.elements.find(element => element.type === 'edge').label, '审核通过')
  })
  for (const mode of ['flow', 'board']) await test(`adaptive-grid-${mode}-at-all-zoom-levels`, async page => {
    if (mode === 'board') {
      const legacy = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/flow.owflow'), 'utf8'))
      legacy.kind = 'board'; legacy.scene.elements = []
      await page.locator('#file-input').setInputFiles({ name: 'legacy-canvas.owflow', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) })
      await expect(page.getByTestId('canvas-stage')).toBeVisible()
    } else await page.getByTestId('create-canvas').click()
    async function inspectGrid() {
      return page.locator('svg.scene-svg').evaluate(svg => {
        const pattern = svg.querySelector('pattern')
        const dot = pattern?.querySelector('circle')
        const scale = svg.getScreenCTM().a
        return {
          step: Number(pattern?.getAttribute('width')) * scale,
          radius: Number(dot?.getAttribute('r')) * scale,
          opacity: Number(dot?.getAttribute('opacity') ?? 1),
          fill: dot?.getAttribute('fill'),
          visibleGrid: [...svg.querySelectorAll('rect')].some(rect => rect.getAttribute('fill')?.startsWith('url(')),
          scale,
        }
      })
    }
    const checks = []
    for (const delta of [0, 1500, -3000]) {
      if (delta) {
        const point = await stagePoint(page, .5, .5)
        await page.mouse.move(point.x, point.y)
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, delta)
        await page.keyboard.up('Control')
      }
      await expect.poll(async () => {
        const grid = await inspectGrid()
        return grid.visibleGrid && grid.step >= 12 && grid.step <= 41 && grid.radius >= .8 && grid.radius <= 1.4
      }).toBe(true)
      const grid = await inspectGrid()
      assert.ok(grid.opacity >= .45, `Grid opacity is too faint: ${JSON.stringify(grid)}`)
      assert.ok(grid.fill && !['none', 'transparent', '#fff', '#ffffff'].includes(grid.fill))
      checks.push(grid)
    }
    assert.ok(checks[1].scale < checks[0].scale / 2, 'The zoom-out gesture must actually change scale')
    assert.ok(checks[2].scale > checks[0].scale * 2, 'The zoom-in gesture must actually change scale')
    await page.getByTitle('重置为 100%', { exact: true }).click()

    await draw(page, 'rectangle', [.25, .30], [.48, .49])
    await labelShape(page, elements(page, 'shape').first(), '网格不会导出')
    const shapeId = await elements(page, 'shape').first().getAttribute('data-element-id')
    await page.getByRole('button', { name: '关闭属性面板', exact: true }).click()
    await expect(page.locator('.properties-panel')).toHaveCount(0)
    await expect(page.locator('.selection-overlay')).toHaveCount(1)
    const toggle = page.getByTestId('canvas-grid-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('canvas-grid')).toHaveCount(0)
    await expect(page.locator('.selection-overlay')).toHaveCount(1)
    const hidden = await savedDocument(page)
    assert.equal(hidden.scene.grid, false, 'Grid can be hidden and saved while a shape is selected and the inspector is closed')
    assert.equal(hidden.scene.elements[0].id, shapeId)
    await undo(page)
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('canvas-grid')).toBeVisible()
    assert.equal((await savedDocument(page)).scene.grid, true, 'Undo restores the saved grid visibility')
    await redo(page)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    assert.equal((await savedDocument(page)).scene.grid, false)
    await toggle.click()
    await expect(page.getByTestId('canvas-grid')).toBeVisible()
    await page.getByTitle('导出', { exact: true }).click()
    const exported = await download(page, () => page.getByRole('menuitem', { name: 'SVG 矢量图', exact: true }).click())
    const svg = await page.evaluate(markup => {
      const document = new DOMParser().parseFromString(markup, 'image/svg+xml')
      return { error: document.querySelector('parsererror')?.textContent, patterns: document.querySelectorAll('pattern').length, labels: [...document.querySelectorAll('text')].map(text => text.textContent) }
    }, exported.bytes.toString('utf8'))
    assert.equal(svg.error, undefined)
    assert.ok(svg.labels.includes('网格不会导出'), 'SVG exports the selected drawing content')
    assert.equal(svg.patterns, 0, 'Visible editor grid is excluded from the exported SVG')
    await assertFits(page)
  })
  await test('global-line-style-existing-new-and-history', async page => {
    await page.getByTestId('create-canvas').click()
    await draw(page, 'rectangle', [.13, .30], [.34, .48])
    await draw(page, 'note', [.53, .30], [.75, .52])
    await page.locator('.inline-text-editor').fill('原有便签')
    await page.locator('.inline-text-editor').press('Control+Enter')
    await contextAction(page, elements(page, 'shape').first(), '锁定')
    await openGlobalStyle(page)
    await page.getByTestId('global-line-sketch').click()
    await expect(elements(page, 'shape').first().locator('[data-roughness="sketch"]')).toBeVisible()
    for (const pattern of ['dashed', 'dotted', 'solid', 'dotted']) {
      await page.locator('#global-pattern').selectOption(pattern)
      const snapshot = await savedDocument(page)
      assert.equal(snapshot.scene.defaultStyle.strokePattern, pattern)
      assert.ok(snapshot.scene.elements.every(element => element.style.strokePattern === pattern))
      assert.ok(snapshot.scene.elements.every(element => element.style.roughness === 'sketch'))
    }
    await page.locator('#global-width').fill('4')
    const live = await savedDocument(page, () => page.keyboard.press('Control+s'))
    assert.equal(live.scene.defaultStyle.strokeWidth, 4, 'Ctrl+S must flush the focused global width input')
    assert.ok(live.scene.elements.every(element => element.style.strokeWidth === 4), 'Existing and locked elements should receive the canvas-wide width')
    await undo(page)
    const undone = await savedDocument(page)
    assert.equal(undone.scene.defaultStyle.strokeWidth, 2)
    await redo(page)
    const redone = await savedDocument(page)
    assert.equal(redone.scene.defaultStyle.strokeWidth, 4)
    await draw(page, 'note', [.16, .65], [.39, .86])
    await page.locator('.inline-text-editor').fill('新建便签使用全局线条')
    await page.locator('.inline-text-editor').press('Control+Enter')
    const created = await savedDocument(page)
    const note = created.scene.elements.find(element => element.text === '新建便签使用全局线条')
    assert.equal(note.style.roughness, 'sketch')
    assert.equal(note.style.strokePattern, 'dotted')
    assert.equal(note.style.strokeWidth, 4, 'New notes should inherit the configured global line width')
    await page.reload()
    await expect(page.getByTestId('canvas-stage')).toBeVisible()
    const restored = await savedDocument(page)
    assert.equal(restored.scene.defaultStyle.roughness, 'sketch')
    assert.equal(restored.scene.defaultStyle.strokePattern, 'dotted')
    assert.equal(restored.scene.defaultStyle.strokeWidth, 4)
    await openGlobalStyle(page)
    await page.getByTestId('global-line-clean').click()
    await expect(page.locator('[data-roughness="sketch"]')).toHaveCount(0)
    const clean = await savedDocument(page)
    assert.ok(clean.scene.elements.every(element => element.style.roughness === 'clean'))
  })
  await test('save-unedited-global-controls-preserves-mixed-styles', async page => {
    await page.getByTestId('create-canvas').click()
    await draw(page, 'rectangle', [.13, .32], [.34, .52])
    await draw(page, 'rectangle', [.64, .32], [.85, .52])
    await expect(elements(page, 'shape')).toHaveCount(2)
    await elements(page, 'shape').first().click()
    await page.locator('#element-width').fill('5')
    await page.locator('#element-width').press('Tab')
    await page.locator('#element-pattern').selectOption('dashed')
    const mixed = await savedDocument(page)
    assert.equal(mixed.scene.elements[0].style.strokePattern, 'dashed')
    assert.equal(mixed.scene.elements[0].style.strokeWidth, 5)
    assert.equal(mixed.scene.elements[1].style.strokePattern, 'solid')
    assert.equal(mixed.scene.elements[1].style.strokeWidth, 2)
    await openGlobalStyle(page)
    await page.locator('#global-pattern').focus()
    const afterPatternFocus = await savedDocument(page, () => page.keyboard.press('Control+s'))
    assert.deepEqual(afterPatternFocus.scene, mixed.scene, 'Focusing an unchanged global pattern must not flatten per-element overrides')
    await page.locator('#global-width').focus()
    const afterWidthFocus = await savedDocument(page, () => page.keyboard.press('Control+s'))
    assert.deepEqual(afterWidthFocus.scene, mixed.scene, 'Focusing an unchanged global width must not change mixed widths')
    await page.locator('#global-width').fill('')
    const afterEmptyWidth = await savedDocument(page, () => page.keyboard.press('Control+s'))
    assert.deepEqual(afterEmptyWidth.scene, mixed.scene, 'Clearing global width must preserve mixed widths instead of applying zero')
    await expect(page.locator('#global-width')).toHaveValue('2')
  })
  await test('nearby-binding-and-endpoint-reconnect', async page => {
    await page.getByTestId('create-canvas').click()
    await draw(page, 'rectangle', [.10, .28], [.29, .46])
    await draw(page, 'rectangle', [.63, .28], [.82, .46])
    await draw(page, 'ellipse', [.63, .65], [.82, .83])
    const shapes = elements(page, 'shape')
    const first = shapes.nth(0), second = shapes.nth(1), third = shapes.nth(2)
    const firstId = await first.getAttribute('data-element-id')
    const secondId = await second.getAttribute('data-element-id')
    const thirdId = await third.getAttribute('data-element-id')
    const a = await first.boundingBox(), b = await second.boundingBox(), c = await third.boundingBox()
    const start = { x: a.x + a.width + 7, y: a.y + a.height / 2 }
    const end = { x: b.x - 7, y: b.y + b.height / 2 }
    await page.getByTestId('tool-edge').click()
    await page.mouse.move(start.x, start.y)
    await expect(page.getByTestId('binding-preview')).toHaveAttribute('data-binding-target', firstId)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 12 })
    await expect(page.getByTestId('binding-preview')).toHaveAttribute('data-binding-target', secondId)
    await page.mouse.up()
    let snapshot = await savedDocument(page)
    let edge = snapshot.scene.elements.find(element => element.type === 'edge')
    assert.equal(edge.from.nodeId, firstId)
    assert.equal(edge.to.nodeId, secondId)
    await page.getByTestId('tool-select').click()
    await elements(page, 'edge').click()
    const handle = await center(page.getByTestId('edge-handle-to'))
    await page.mouse.move(handle.x, handle.y)
    await page.mouse.down()
    await page.mouse.move(c.x - 7, c.y + c.height / 2, { steps: 12 })
    await expect(page.getByTestId('binding-preview')).toHaveAttribute('data-binding-target', thirdId)
    await page.mouse.up()
    snapshot = await savedDocument(page)
    edge = snapshot.scene.elements.find(element => element.type === 'edge')
    assert.equal(edge.to.nodeId, thirdId)
    await undo(page)
    assert.equal((await savedDocument(page)).scene.elements.find(element => element.type === 'edge').to.nodeId, secondId)
    await redo(page)
    const originalPath = await elements(page, 'edge').locator('path').first().getAttribute('d')
    const from = await center(third)
    await gesture(page, from, { x: from.x - 85, y: from.y - 25 })
    await expect.poll(() => elements(page, 'edge').locator('path').first().getAttribute('d')).not.toBe(originalPath)
    const moved = await savedDocument(page)
    assert.equal(moved.scene.elements.find(element => element.type === 'edge').to.nodeId, thirdId)
  })
  await test('context-menu-layer-edit-lock-copy-delete', async page => {
    await page.getByTestId('create-canvas').click()
    await draw(page, 'rectangle', [.10, .32], [.38, .62])
    await draw(page, 'rectangle', [.30, .32], [.58, .62])
    await draw(page, 'rectangle', [.50, .32], [.78, .62])
    await expect(elements(page, 'shape')).toHaveCount(3)
    let snapshot = await savedDocument(page)
    const ids = snapshot.scene.elements.map(element => element.id)
    const node = id => page.locator(`g[data-element-id="${id}"]`)
    async function order(action, expected) {
      await contextAction(page, node(ids[0]), action)
      assert.deepEqual((await savedDocument(page)).scene.elements.map(element => element.id), expected)
    }
    await order('上移一层', [ids[1], ids[0], ids[2]])
    await order('置于顶层', [ids[1], ids[2], ids[0]])
    await order('下移一层', [ids[1], ids[0], ids[2]])
    await order('置于底层', ids)
    await undo(page)
    assert.deepEqual((await savedDocument(page)).scene.elements.map(element => element.id), [ids[1], ids[0], ids[2]])
    await redo(page)
    await contextAction(page, node(ids[0]), '编辑文字')
    await page.locator('.inline-text-editor').fill('右键编辑成功')
    await page.locator('.inline-text-editor').press('Control+Enter')
    await expect(node(ids[0])).toContainText('右键编辑成功')
    await contextAction(page, node(ids[0]), '锁定')
    snapshot = await savedDocument(page)
    const locked = snapshot.scene.elements.find(element => element.id === ids[0])
    assert.equal(locked.locked, true)
    const point = await center(node(ids[0]))
    await gesture(page, point, { x: point.x + 60, y: point.y + 40 })
    assert.equal((await savedDocument(page)).scene.elements.find(element => element.id === ids[0]).x, locked.x)
    await node(ids[0]).click({ button: 'right' })
    await expect(page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '删除', exact: true })).toBeDisabled()
    await page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '解锁', exact: true }).click()
    await contextAction(page, node(ids[0]), '复制一份')
    await expect(elements(page, 'shape')).toHaveCount(4)
    snapshot = await savedDocument(page)
    const duplicate = snapshot.scene.elements.find(element => !ids.includes(element.id))
    assert.equal(duplicate.text, '右键编辑成功')
    assert.equal(duplicate.locked, false)
    await contextAction(page, node(duplicate.id), '删除')
    await expect(elements(page, 'shape')).toHaveCount(3)
    await undo(page)
    await expect(elements(page, 'shape')).toHaveCount(4)
  })
  await test('context-export-all-selection-and-edge', async page => {
    await page.getByTestId('create-canvas').click()
    await draw(page, 'rectangle', [.12, .32], [.33, .52])
    await labelShape(page, elements(page, 'shape').first(), '只在选区的节点甲')
    await draw(page, 'rectangle', [.64, .32], [.85, .52])
    await labelShape(page, elements(page, 'shape').last(), '全图中的节点乙')
    const first = elements(page, 'shape').first(), last = elements(page, 'shape').last()
    await first.click({ button: 'right' })
    const selection = await download(page, () => page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '导出选区 SVG', exact: true }).click())
    const selectionText = selection.bytes.toString('utf8')
    assert.match(selection.name, /选区.*\.svg$/)
    assert.ok(selectionText.includes('只在选区的节点甲'))
    assert.ok(!selectionText.includes('全图中的节点乙'))
    await first.click({ button: 'right' })
    const whole = await download(page, () => page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '导出全图 SVG', exact: true }).click())
    assert.ok(whole.bytes.toString('utf8').includes('只在选区的节点甲'))
    assert.ok(whole.bytes.toString('utf8').includes('全图中的节点乙'))
    await first.click({ button: 'right' })
    const png = await download(page, () => page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '导出选区 PNG', exact: true }).click())
    assert.equal(png.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    await page.getByTestId('tool-edge').click()
    await gesture(page, await center(first), await center(last))
    await page.getByTestId('tool-select').click()
    const edge = elements(page, 'edge')
    const pathBefore = await edge.locator('path').first().getAttribute('d')
    await edge.click({ button: 'right' })
    const edgeFile = await download(page, () => page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '导出选区 SVG', exact: true }).click())
    const exported = await page.evaluate(text => {
      const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement
      return { paths: [...svg.querySelectorAll('path')].map(path => path.getAttribute('d')), groups: [...svg.children].filter(child => child.tagName === 'g').length, text: svg.textContent }
    }, edgeFile.bytes.toString('utf8'))
    assert.equal(exported.groups, 1)
    assert.ok(exported.paths.includes(pathBefore), 'Exported edge-only selection should keep its visible endpoint coordinates')
    assert.ok(!exported.text.includes('节点甲') && !exported.text.includes('节点乙'))
  })
  await test('compact-mobile-toolbar-and-context-menu', async page => {
    await page.getByTestId('create-canvas').click()
    const stage = await page.getByTestId('canvas-stage').boundingBox()
    assert.ok(stage.width >= 300)
    const toolbar = await page.locator('.canvas-commandbar').boundingBox()
    assert.ok(toolbar.x >= 0 && toolbar.x + toolbar.width <= 321)
    const navigation = page.getByRole('toolbar', { name: '选择与移动', exact: true })
    const shapes = page.getByRole('toolbar', { name: '快捷图形', exact: true })
    const drawing = page.getByRole('toolbar', { name: '自由绘制', exact: true })
    const actions = page.getByRole('toolbar', { name: '画布操作', exact: true })
    const groups = await Promise.all([navigation, shapes, drawing, actions].map(group => group.boundingBox()))
    assert.ok(groups.every(box => box && box.x >= 0 && box.x + box.width <= 321), 'Each named tool group stays within the narrow viewport')
    assert.ok(groups[0].x + groups[0].width <= groups[1].x, 'Navigation and quick shapes remain separate')
    assert.ok(groups[2].y >= Math.max(groups[0].y + groups[0].height, groups[1].y + groups[1].height), 'Free drawing occupies its own row below the shape shortcuts')
    assert.ok(groups[3].y >= groups[2].y + groups[2].height, 'Canvas actions do not overlap the drawing tools')
    await expect(shapes.getByTestId('tool-rectangle')).toHaveCount(1)
    await expect(shapes.getByTestId('brush-settings-toggle')).toHaveCount(0)
    await expect(drawing.getByTestId('brush-settings-toggle')).toContainText('自定义笔触')
    assert.ok(stage.y >= toolbar.y + toolbar.height, 'The grouped toolbar does not cover the canvas')
    assert.ok(stage.height >= page.viewportSize().height / 2, 'The narrow layout leaves at least half the viewport available for drawing')
    for (const group of [navigation, shapes, drawing, actions]) {
      for (const button of await group.getByRole('button').all()) {
        if (await button.isDisabled()) continue
        await button.scrollIntoViewIfNeeded()
        await button.click({ trial: true })
      }
    }
    await draw(page, 'note', [.15, .30], [.75, .60])
    await page.locator('.inline-text-editor').fill('窄屏原位编辑')
    await page.locator('.inline-text-editor').press('Control+Enter')
    await elements(page, 'shape').click({ button: 'right' })
    const menu = page.getByTestId('canvas-context-menu')
    await expect(menu).toBeVisible()
    const box = await menu.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 321)
    assert.ok(box.y >= 0 && box.y + box.height <= 741)
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem', { name: '导出选区 PNG', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('canvas-stage')).toBeFocused()
    await openGlobalStyle(page)
    await expect(page.locator('#global-pattern')).toBeVisible()
    const styleBox = await page.getByRole('region', { name: '全局线条风格', exact: true }).boundingBox()
    assert.ok(styleBox.x >= 0 && styleBox.x + styleBox.width <= 321)
    await assertFits(page)
  }, { width: 320, height: 740 })
  await fs.writeFile(path.join(output, 'results-refinements.json'), JSON.stringify(results, null, 2))
  assert.ok(results.length, 'No matching acceptance cases')
  assert.ok(results.every(result => result.pass), `${results.filter(result => !result.pass).length} refinement case(s) failed; see ${output}`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  if (server) server.kill('SIGTERM')
})
