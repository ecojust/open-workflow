/* Real Chromium interaction checks. Run with npm run test:browser.
 * BASE_URL may point to an existing server. With no override this script starts
 * Vite when needed. CHROMIUM_EXECUTABLE can select an installed Chromium.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5199'
const output = process.env.BROWSER_ARTIFACTS || '/tmp/open-workflow-browser'
const fixture = name => path.join(root, 'tests/fixtures', name)
let server
let browser
const results = []

async function available() {
  try { return (await fetch(baseURL, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
}
async function ensureServer() {
  if (await available()) return
  if (process.env.BASE_URL) throw new Error(`Cannot reach BASE_URL ${baseURL}`)
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', data => { log += data })
  server.stderr.on('data', data => { log += data })
  for (let i = 0; i < 80; i++) {
    if (await available()) return
    if (server.exitCode !== null) throw new Error(`Vite exited: ${log}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Vite did not become ready: ${log}`)
}
async function test(name, run, viewport = { width: 1440, height: 1000 }) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return
  const context = await browser.newContext({ viewport, acceptDownloads: true, locale: 'zh-CN' })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(baseURL)
    await page.getByTestId('create-canvas').waitFor({ state: 'visible' })
    await run(page, context)
    assert.deepEqual(errors, [], 'The app should not raise unhandled browser errors')
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true })
    results.push({ name, pass: true })
    process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {})
    results.push({ name, pass: false, error: error.stack || String(error) })
    process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`)
  } finally { await context.close() }
}
async function openFixture(page, name) {
  await page.locator('#file-input').setInputFiles(fixture(name))
  await expect(page.getByRole('tab').last()).toBeVisible()
  if (!name.endsWith('.owflow')) await page.getByRole('dialog').getByRole('button', { name: '知道了', exact: true }).click()
}
async function downloadText(page, trigger) {
  const pending = page.waitForEvent('download')
  await trigger()
  const download = await pending
  const location = await download.path()
  assert.equal(await download.failure(), null)
  return { name: download.suggestedFilename(), text: await fs.readFile(location, 'utf8') }
}
async function saveDocument(page) {
  const download = await downloadText(page, () => page.getByTitle('保存 (Ctrl+S)', { exact: true }).click())
  assert.match(download.name, /\.owflow$/)
  return JSON.parse(download.text)
}
async function gesture(page, from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
}
async function drawAt(page, tool, start, end) {
  await page.getByTestId(`tool-${tool}`).click()
  const stage = await page.getByTestId('canvas-stage').boundingBox()
  assert.ok(stage && stage.width > 100 && stage.height > 100, 'Drawing area should be usable')
  const point = value => ({ x: stage.x + stage.width * value[0], y: stage.y + stage.height * value[1] })
  await gesture(page, point(start), point(end))
}
async function centerOf(locator) {
  const box = await locator.boundingBox()
  assert.ok(box, 'Expected a visible element')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
async function assertFitsViewport(page) {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
  assert.ok(dimensions.scroll <= dimensions.width + 1, `document overflows by ${dimensions.scroll - dimensions.width}px`)
  assert.ok(dimensions.body <= dimensions.width + 1, `body overflows by ${dimensions.body - dimensions.width}px`)
}

async function captureDocumentation() {
  const folder = path.join(root, 'docs/screenshots')
  await fs.mkdir(folder, { recursive: true })
  for (const kind of ['home', 'flow', 'board', 'mermaid']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', locale: 'zh-CN' })
    const page = await context.newPage()
    try {
      await page.goto(baseURL)
      await page.getByTestId('create-canvas').waitFor()
      if (kind === 'flow') await page.getByRole('button', { name: '项目审批流程', exact: false }).click()
      if (kind === 'board') {
        await page.getByTestId('create-canvas').click()
        await page.getByTestId('board-template-toggle').click()
        await page.locator('[data-board-template="brainstorm"]').click()
        await page.getByTestId('canvas-stage').press('Escape')
        await page.getByRole('button', { name: '关闭属性面板', exact: true }).click()
      }
      if (kind === 'mermaid') await page.getByTestId('create-diagram').click()
      if (kind !== 'home') await expect(page.locator('.save-status')).toContainText('草稿已保存')
      if (kind === 'mermaid') {
        await expect(page.getByTestId('diagram-preview').locator('svg')).toBeVisible()
        await page.getByRole('button', { name: '缩小预览', exact: true }).click()
      }
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: path.join(folder, `${kind === 'mermaid' ? 'diagram' : kind}.png`), fullPage: true, animations: 'disabled' })
      if (kind === 'flow') {
        await page.getByTestId('global-style-toggle').click()
        await expect(page.getByRole('region', { name: '全局线条风格', exact: true })).toBeVisible()
        await page.screenshot({ path: path.join(folder, 'flow-style.png'), fullPage: true, animations: 'disabled' })
        await page.getByRole('button', { name: '关闭全局线条设置', exact: true }).click()
        await page.locator('g[data-element-type="shape"]').first().click({ button: 'right' })
        await expect(page.getByTestId('canvas-context-menu')).toBeVisible()
        await page.screenshot({ path: path.join(folder, 'flow-context.png'), fullPage: true, animations: 'disabled' })
      }
      if (kind === 'board') {
        await page.getByTestId('board-template-toggle').click()
        await expect(page.getByTestId('board-template-panel')).toBeVisible()
        await page.screenshot({ path: path.join(folder, 'whiteboard-templates.png'), fullPage: true, animations: 'disabled' })
      }
      if (kind === 'mermaid') {
        await page.getByTestId('diagram-style-toggle').click()
        await expect(page.getByTestId('diagram-style-panel')).toBeVisible()
        await page.screenshot({ path: path.join(folder, 'diagram-styles.png'), fullPage: true, animations: 'disabled' })
        await page.getByTestId('diagram-style-panel').getByRole('button', { name: '完成', exact: true }).click()
        await page.getByTestId('diagram-template-toggle').click()
        await expect(page.getByTestId('diagram-template-library')).toBeVisible()
        await page.screenshot({ path: path.join(folder, 'diagram-library.png'), fullPage: true, animations: 'disabled' })
      }
    } finally { await context.close() }
  }
  process.stdout.write(`Screenshots saved to ${folder}\n`)
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await ensureServer()
  const executablePath = process.env.CHROMIUM_EXECUTABLE || (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  if (process.env.SCREENSHOTS_ONLY === '1') { await captureDocumentation(); return }
  await test('flow-drawing-bindings-and-history', async page => {
    await page.getByTestId('create-canvas').click()
    await drawAt(page, 'rectangle', [0.12, 0.20], [0.32, 0.36])
    await drawAt(page, 'diamond', [0.62, 0.20], [0.82, 0.36])
    const shapes = page.locator('g[data-element-type="shape"]')
    await expect(shapes).toHaveCount(2)
    const first = shapes.nth(0)
    const second = shapes.nth(1)
    await page.getByTestId('tool-edge').click()
    await gesture(page, await centerOf(first), await centerOf(second))
    await expect(page.locator('g[data-element-type="edge"]')).toHaveCount(1)
    const original = await saveDocument(page)
    const originalNodes = original.scene.elements.filter(element => element.type === 'shape')
    const edge = original.scene.elements.find(element => element.type === 'edge')
    assert.equal(edge.from.nodeId, originalNodes[0].id)
    assert.equal(edge.to.nodeId, originalNodes[1].id)
    await page.getByTestId('tool-select').click()
    const from = await centerOf(first)
    await gesture(page, from, { x: from.x + 80, y: from.y + 65 })
    const moved = await saveDocument(page)
    const movedNode = moved.scene.elements.find(element => element.id === originalNodes[0].id)
    assert.ok(movedNode.x > originalNodes[0].x)
    assert.ok(movedNode.y > originalNodes[0].y)
    await page.getByTestId('canvas-stage').focus()
    await page.keyboard.press('Control+z')
    const undone = await saveDocument(page)
    assert.equal(undone.scene.elements.find(element => element.id === originalNodes[0].id).x, originalNodes[0].x)
    await page.getByTestId('canvas-stage').focus()
    await page.keyboard.press('Control+y')
    const redone = await saveDocument(page)
    assert.equal(redone.scene.elements.find(element => element.id === originalNodes[0].id).x, movedNode.x)
    assert.equal(redone.scene.elements.find(element => element.type === 'edge').to.nodeId, originalNodes[1].id)
    await assertFitsViewport(page)
  })
  await test('board-note-pen-and-image', async page => {
    await page.getByTestId('create-canvas').click()
    await drawAt(page, 'note', [0.12, 0.15], [0.38, 0.48])
    await page.getByLabel('编辑图形文字', { exact: true }).fill('第一条可恢复便签')
    await page.getByLabel('编辑图形文字', { exact: true }).press('Control+Enter')
    await page.getByTestId('tool-pen').click()
    const stage = await page.getByTestId('canvas-stage').boundingBox()
    await page.mouse.move(stage.x + stage.width * 0.50, stage.y + stage.height * 0.30)
    await page.mouse.down()
    for (let i = 1; i <= 18; i++) await page.mouse.move(stage.x + stage.width * (0.50 + i * 0.012), stage.y + stage.height * (0.30 + Math.sin(i / 2) * 0.08))
    await page.mouse.up()
    await expect(page.locator('g[data-element-type="stroke"]')).toHaveCount(1)
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32
      const context = canvas.getContext('2d'); context.fillStyle = '#2563eb'; context.fillRect(0, 0, 32, 32)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: 'blue-square.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') })
    await expect(page.locator('g[data-element-type="shape"] image')).toHaveCount(1)
    const saved = await saveDocument(page)
    assert.equal(saved.kind, 'flow')
    assert.ok(saved.scene.elements.some(element => element.shape === 'note' && element.text === '第一条可恢复便签'))
    assert.ok(saved.scene.elements.some(element => element.type === 'stroke' && element.points.length >= 12))
    assert.ok(saved.scene.elements.some(element => element.shape === 'image' && element.imageData.startsWith('data:image/png;base64,')))
    await assertFitsViewport(page)
  })
  await test('native-file-roundtrip', async page => {
    await openFixture(page, 'flow.owflow')
    await expect(page.getByRole('tab').last()).toContainText('原生往返测试')
    const saved = await saveDocument(page)
    assert.equal(saved.format, 'open-workflow')
    assert.equal(saved.version, 1)
    assert.equal(saved.kind, 'flow')
    assert.equal(saved.scene.elements.length, 1)
    assert.equal(saved.scene.elements[0].id, 'fixture-node')
    assert.equal(saved.scene.elements[0].text, '保留节点内容')
    assert.equal(saved.scene.elements[0].x, 80)
    assert.equal(saved.scene.elements[0].style.fill, '#dbeafe')
  })
  await test('graph-xml-real-import', async page => {
    await openFixture(page, 'basic.drawio')
    const saved = await saveDocument(page)
    assert.equal(saved.kind, 'flow')
    const nodes = saved.scene.elements.filter(element => element.type === 'shape')
    const edges = saved.scene.elements.filter(element => element.type === 'edge')
    assert.equal(nodes.length, 2)
    assert.equal(edges.length, 1)
    assert.ok(nodes.some(node => node.text === '导入开始' && node.shape === 'ellipse'))
    assert.ok(nodes.some(node => node.text === '审核条件' && node.shape === 'diamond'))
    assert.equal(edges[0].route, 'orthogonal')
    assert.ok(nodes.some(node => node.id === edges[0].from.nodeId))
    assert.ok(nodes.some(node => node.id === edges[0].to.nodeId))
    assert.ok(saved.importSource.text.includes('mxGraphModel'), 'Original imported source must survive native conversion')
  })
  await test('board-json-real-import', async page => {
    await openFixture(page, 'basic.excalidraw')
    const saved = await saveDocument(page)
    assert.equal(saved.kind, 'board')
    assert.ok(saved.scene.elements.some(element => element.type === 'shape' && element.text === '导入白板'))
    assert.ok(saved.scene.elements.some(element => element.type === 'stroke' && element.points.length >= 5))
    assert.ok(saved.importSource.text.includes('freedraw'))
  })
  await test('diagram-source-and-errors', async page => {
    await page.getByTestId('create-diagram').click()
    const source = page.getByTestId('diagram-source')
    const preview = page.getByTestId('diagram-preview')
    await source.fill('flowchart LR\n  A[测试开始] --> B{审核}\n  B -->|通过| C[测试完成]')
    await expect(preview.locator('svg')).toBeVisible()
    await expect(preview).toContainText('测试开始')
    await expect(preview).toContainText('测试完成')
    const valid = await saveDocument(page)
    assert.equal(valid.kind, 'mermaid')
    assert.ok(valid.source.includes('A[测试开始]'))
    const broken = 'flowchart LR\n  this is unsupported ???'
    await source.fill(broken)
    await expect(page.getByTestId('diagram-error')).toBeVisible()
    await expect(page.getByTestId('diagram-error')).toContainText(/2/)
    await expect(source).toHaveValue(broken)
    await source.fill('sequenceDiagram\n  participant A as 用户\n  participant B as 服务\n  A->>B: 提交请求\n  B-->>A: 返回结果')
    await expect(page.getByTestId('diagram-error')).toHaveCount(0)
    await expect(preview).toContainText('提交请求')
    await expect(preview).toContainText('返回结果')
    await page.getByRole('button', { name: '转为可编辑流程图', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    const copy = await saveDocument(page)
    assert.equal(copy.kind, 'flow')
    assert.ok(copy.scene.elements.length >= 4)
  })
  await test('mobile-home-and-diagram', async page => {
    await assertFitsViewport(page)
    await page.getByTestId('create-diagram').click()
    await expect(page.getByTestId('diagram-source')).toBeVisible()
    await assertFitsViewport(page)
  }, { width: 320, height: 740 })
  await test('mobile-flow-canvas', async page => {
    await page.getByTestId('create-canvas').click()
    const stage = await page.getByTestId('canvas-stage').boundingBox()
    assert.ok(stage.width >= 280, `Mobile canvas is only ${stage.width}px wide`)
    assert.ok(stage.height >= 260, `Mobile canvas is only ${stage.height}px tall`)
    await drawAt(page, 'rectangle', [0.15, 0.25], [0.70, 0.50])
    await expect(page.locator('g[data-element-type="shape"]')).toHaveCount(1)
    await assertFitsViewport(page)
    const saved = await saveDocument(page)
    assert.equal(saved.scene.elements.length, 1)
  }, { width: 320, height: 740 })
  await test('mobile-board-canvas', async page => {
    await page.getByTestId('create-canvas').click()
    await drawAt(page, 'note', [0.15, 0.25], [0.70, 0.55])
    await page.getByLabel('编辑图形文字', { exact: true }).fill('窄屏便签')
    await page.getByLabel('编辑图形文字', { exact: true }).press('Control+Enter')
    await assertFitsViewport(page)
    const saved = await saveDocument(page)
    assert.ok(saved.scene.elements.some(element => element.text === '窄屏便签'))
  }, { width: 320, height: 740 })
  await test('save-flushes-current-text-and-rename', async page => {
    await page.getByTestId('create-diagram').click()
    const sourceText = 'flowchart LR\n  A[尚未防抖的文本] --> B[立即保存]'
    await page.getByTestId('diagram-source').fill(sourceText)
    const codeDownload = await downloadText(page, () => page.keyboard.press('Control+s'))
    assert.equal(JSON.parse(codeDownload.text).source, sourceText)
    await page.getByRole('button', { name: '重命名当前文档', exact: true }).click()
    await page.getByRole('dialog').getByLabel('文档名称').fill('即时保存与重命名')
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click()
    await expect(page.getByRole('tab')).toContainText('即时保存与重命名')
    const renamed = await saveDocument(page)
    assert.equal(renamed.title, '即时保存与重命名')
    await page.locator('.brand').click()
    await page.getByTestId('create-canvas').click()
    await drawAt(page, 'note', [0.15, 0.15], [0.40, 0.45])
    const inlineText = '不离开输入框就直接保存'
    await page.getByLabel('编辑图形文字', { exact: true }).fill(inlineText)
    const noteDownload = await downloadText(page, () => page.keyboard.press('Control+s'))
    assert.ok(JSON.parse(noteDownload.text).scene.elements.some(element => element.text === inlineText))
    const propertyText = '属性文本保持焦点时的最新内容'
    await page.getByTestId('property-text').fill(propertyText)
    const propertyDownload = await downloadText(page, () => page.keyboard.press('Control+s'))
    assert.ok(JSON.parse(propertyDownload.text).scene.elements.some(element => element.text === propertyText))
  })
  await test('save-during-active-drag', async page => {
    await openFixture(page, 'flow.owflow')
    const shape = page.locator('g[data-element-type="shape"]')
    const point = await centerOf(shape)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(point.x + 90, point.y + 50, { steps: 8 })
    const captured = await downloadText(page, () => page.keyboard.press('Control+s'))
    const saved = JSON.parse(captured.text)
    assert.ok(saved.scene.elements[0].x > 80, 'Saving mid-drag must include the visible position')
    assert.ok(saved.scene.elements[0].y > 60)
    await page.mouse.up()
    await page.getByTestId('canvas-stage').focus()
    await page.keyboard.press('Control+z')
    const undone = await saveDocument(page)
    assert.equal(undone.scene.elements[0].x, 80, 'A drag is exactly one undo transaction, even when saved before release')
    assert.equal(undone.scene.elements[0].y, 60)
  })
  await test('paste-edge-after-deleting-bound-nodes', async page => {
    await page.getByTestId('create-canvas').click()
    await drawAt(page, 'rectangle', [0.12, 0.20], [0.32, 0.36])
    await drawAt(page, 'rectangle', [0.62, 0.20], [0.82, 0.36])
    const shapes = page.locator('g[data-element-type="shape"]')
    await page.getByTestId('tool-edge').click()
    await gesture(page, await centerOf(shapes.nth(0)), await centerOf(shapes.nth(1)))
    const edge = page.locator('g[data-element-type="edge"]')
    const coordinates = (await edge.locator('path').first().getAttribute('d')).match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi).map(Number)
    await page.getByTestId('tool-select').click()
    await edge.click()
    await page.keyboard.press('Control+c')
    await shapes.nth(0).click()
    await page.keyboard.press('Delete')
    await shapes.nth(0).click()
    await page.keyboard.press('Delete')
    await expect(shapes).toHaveCount(0)
    await page.keyboard.press('Control+v')
    await expect(edge).toHaveCount(1)
    const saved = await saveDocument(page)
    assert.equal(saved.scene.elements.length, 1)
    const restored = saved.scene.elements[0]
    assert.equal(restored.type, 'edge')
    assert.equal(restored.from.nodeId, undefined)
    assert.equal(restored.to.nodeId, undefined)
    assert.ok(Math.abs(restored.from.x - coordinates[0] - 24) < 0.01)
    assert.ok(Math.abs(restored.from.y - coordinates[1] - 24) < 0.01)
    assert.ok(Math.abs(restored.to.x - coordinates[coordinates.length - 2] - 24) < 0.01)
    assert.ok(Math.abs(restored.to.y - coordinates[coordinates.length - 1] - 24) < 0.01)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
  await test('svg-and-png-export', async page => {
    await openFixture(page, 'flow.owflow')
    await page.getByTitle('导出', { exact: true }).click()
    const svg = await downloadText(page, () => page.getByRole('menuitem', { name: 'SVG 矢量图', exact: true }).click())
    assert.match(svg.name, /\.svg$/)
    assert.match(svg.text, /<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    assert.ok(svg.text.includes('保留节点内容'))
    assert.ok(svg.text.includes('#dbeafe'))
    assert.ok(!svg.text.includes('<script'))
    await page.getByTitle('导出', { exact: true }).click()
    const pending = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'PNG 图片', exact: true }).click()
    const png = await pending
    assert.match(png.suggestedFilename(), /\.png$/)
    const bytes = await fs.readFile(await png.path())
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.ok(bytes.readUInt32BE(16) > 200)
    assert.ok(bytes.readUInt32BE(20) > 100)
  })
  await test('draft-recovery-and-discard-protection', async page => {
    await page.getByTestId('create-canvas').click()
    await drawAt(page, 'note', [0.15, 0.15], [0.40, 0.45])
    await page.getByLabel('编辑图形文字', { exact: true }).fill('刷新后需要保留的草稿')
    await page.getByLabel('编辑图形文字', { exact: true }).press('Control+Enter')
    await expect(page.locator('.save-status')).toContainText('草稿已保存')
    page.once('dialog', dialog => dialog.accept())
    await page.reload()
    await expect(page.getByTestId('canvas-stage')).toBeVisible()
    await expect(page.locator('g[data-element-type="shape"]')).toContainText('刷新后需要保留的草稿')
    await page.getByRole('button', { name: '关闭 未命名画布', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('尚未保存到文件')
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await page.getByRole('button', { name: '关闭 未命名画布', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(page.getByTestId('create-canvas')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('create-canvas')).toBeVisible()
    await expect(page.locator('.recent-item')).toHaveCount(0)
  })
  await test('save-before-tab-close', async page => {
    await page.getByTestId('create-canvas').click()
    await drawAt(page, 'rectangle', [0.15, 0.15], [0.40, 0.45])
    await page.getByRole('button', { name: '关闭 未命名画布', exact: true }).click()
    const download = await downloadText(page, () => page.getByRole('dialog').getByRole('button', { name: '保存并关闭', exact: true }).click())
    assert.equal(JSON.parse(download.text).scene.elements.length, 1)
    await expect(page.getByTestId('create-canvas')).toBeVisible()
    await expect(page.locator('.recent-item')).toHaveCount(1)
    await page.locator('.recent-open').click()
    await expect(page.locator('g[data-element-type="shape"]')).toHaveCount(1)
    await expect(page.locator('.save-status')).toContainText('文件版本一致')
  })
  await test('dark-theme-persists', async page => {
    await page.getByRole('button', { name: '深色主题', exact: true }).click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark')
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: '项目审批流程', exact: false }).click()
    await expect(page.locator('g[data-element-type="shape"]')).toHaveCount(5)
    await assertFitsViewport(page)
  })
  if (process.env.GENERATE_SCREENSHOTS === '1' && results.every(result => result.pass)) await captureDocumentation()
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  assert.ok(results.length > 0, 'No browser cases were registered')
  assert.ok(results.every(result => result.pass), `${results.filter(result => !result.pass).length} browser case(s) failed; see ${output}`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  if (server) server.kill('SIGTERM')
})
