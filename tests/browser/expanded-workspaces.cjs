/* Browser acceptance for the expanded diagram library and whiteboard.
 * Run against a stable build: BASE_URL=http://127.0.0.1:5210 node tests/browser/expanded-workspaces.cjs
 * TEST_FILTER, CHROMIUM_EXECUTABLE and BROWSER_ARTIFACTS are optional.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5199'
const output = process.env.BROWSER_ARTIFACTS || '/tmp/open-workflow-expanded'
const results = []
const diagramKinds = {
  flowchart: '流程图', sequence: '时序图', class: '类图', state: '状态图', er: '实体关系图',
  gitgraph: '分支历史图', pie: '饼图', gantt: '甘特图', xychart: '柱线图', quadrant: '象限图',
  mindmap: '思维导图', timeline: '时间线', journey: '用户旅程', kanban: '看板', requirement: '需求图',
  c4: '系统上下文图', architecture: '架构图', sankey: '桑基图', radar: '雷达图',
  treemap: '矩形树图', block: '块图', packet: '数据包图',
}
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
async function test(name, run, viewport = { width: 1440, height: 1000 }) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return
  const context = await browser.newContext({ viewport, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  if (process.env.DEBUG_BROWSER) {
    page.on('console', message => process.stdout.write(`BROWSER ${message.type()} ${message.text()}\n`))
    let downloads = 0
    page.on('download', () => process.stdout.write(`DOWNLOAD ${++downloads}\n`))
    await page.addInitScript(() => {
      const original = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function (...args) { if (this.download) console.log('Requested download', this.download); return original.apply(this, args) }
      document.addEventListener('click', event => { if (event.target.closest?.('button[title="保存 (Ctrl+S)"]')) console.log('Save button click delivered') }, true)
    })
  }
  try {
    await page.goto(baseURL)
    await page.getByTestId('create-flow').waitFor()
    await run(page, context)
    assert.deepEqual(errors, [], 'No uncaught browser errors')
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
async function save(page) {
  const file = await download(page, () => page.getByTitle('保存 (Ctrl+S)', { exact: true }).click())
  assert.match(file.name, /\.owflow$/)
  return JSON.parse(file.bytes.toString('utf8'))
}
async function exportedSvg(page) {
  await page.getByTitle('导出', { exact: true }).click()
  const file = await download(page, () => page.getByRole('menuitem', { name: 'SVG 矢量图', exact: true }).click())
  assert.match(file.name, /\.svg$/)
  return file.bytes.toString('utf8')
}
async function gesture(page, start, end) {
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 16 })
  await page.mouse.up()
}
async function stagePoint(page, x, y) {
  const box = await page.getByTestId('canvas-stage').boundingBox()
  assert.ok(box && box.width > 150 && box.height > 200)
  return { x: box.x + box.width * x, y: box.y + box.height * y }
}
async function draw(page, tool, start, end) {
  await page.getByTestId(`tool-${tool}`).click()
  await gesture(page, await stagePoint(page, ...start), await stagePoint(page, ...end))
}
function elements(page, type = 'shape') { return page.locator(`g[data-element-id][data-element-type="${type}"]`) }
function byId(page, id) { return page.locator(`g[data-element-id="${id}"]`) }
async function center(locator) {
  const box = await locator.boundingBox()
  assert.ok(box)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
async function undo(page) { await page.getByRole('button', { name: '撤销', exact: true }).click() }
async function redo(page) { await page.getByRole('button', { name: '重做', exact: true }).click() }
async function selectAll(page) { await page.getByTestId('canvas-stage').focus(); await page.keyboard.press('Control+a') }
async function contextAction(page, target, name) {
  await target.click({ button: 'right' })
  await page.getByTestId('canvas-context-menu').getByRole('menuitem', { name, exact: true }).click()
}
async function assertFits(page, target) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
  assert.ok(sizes.document <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1, `Document overflow: ${JSON.stringify(sizes)}`)
  if (target) {
    const box = await target.boundingBox(), viewport = page.viewportSize()
    assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `Dialog outside viewport: ${JSON.stringify(box)}`)
  }
}
async function chooseTemplate(page, kind) {
  await page.getByTestId('mermaid-template-toggle').click()
  await page.getByLabel('搜索图表模板', { exact: true }).fill('')
  await page.locator(`[data-diagram-kind="${kind}"]`).first().click()
  if (await page.getByTestId('mermaid-confirm-template').isVisible()) await page.getByTestId('mermaid-confirm-template').click()
  await expect(page.getByTestId('mermaid-template-library')).toHaveCount(0)
  await expect(page.getByTestId('mermaid-error')).toHaveCount(0)
  await expect(page.getByTestId('mermaid-preview').locator('svg')).toBeVisible()
  await expect(page.locator('.mermaid-preview-kind')).toContainText(diagramKinds[kind])
}
function coords(document) { return document.scene.elements.filter(e => e.type === 'shape').map(e => ({ id: e.id, x: e.x, y: e.y, width: e.width, height: e.height })) }
function near(actual, expected, label) { assert.ok(Math.abs(actual - expected) < .05, `${label}: ${actual} != ${expected}`) }

async function main() {
  await fs.mkdir(output, { recursive: true })
  await ensureServer()
  const executablePath = process.env.CHROMIUM_EXECUTABLE || (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })

  for (const [kind, label] of Object.entries(diagramKinds)) await test(`diagram-${kind}-template-save-svg-editable-copy`, async page => {
    await page.getByTestId('create-mermaid').click()
    await chooseTemplate(page, kind)
    const source = await page.getByTestId('mermaid-source').inputValue()
    assert.ok(source.trim().length > 20, `${label} should have a useful sample`)
    const preview = await page.getByTestId('mermaid-preview').locator('svg').evaluate(svg => ({
      labels: [...svg.querySelectorAll('text')].map(text => text.textContent),
      primitives: svg.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon').length,
    }))
    assert.ok(preview.labels.length >= 2 && preview.primitives >= 2, 'Preview contains real diagram primitives and labels')
    const requiredLabels = {
      class: ['+String id', '+String name', '+int quantity'],
      er: ['string email [UK]', 'decimal total', 'int quantity'],
      requirement: ['verifymethod: test', 'verifymethod: demonstration', 'docref: tests/account'],
    }[kind] || []
    const renderedText = preview.labels.join('').replace(/\s/g, '')
    for (const label of requiredLabels) assert.ok(renderedText.includes(label.replace(/\s/g, '')), `Template field must be fully visible: ${label}`)
    const native = await save(page)
    assert.equal(native.kind, 'mermaid')
    assert.equal(native.source, source)
    const svg = await exportedSvg(page)
    const exported = await page.evaluate(markup => {
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
      return { error: doc.querySelector('parsererror')?.textContent, labels: [...doc.querySelectorAll('text')].map(text => text.textContent), viewBox: doc.documentElement.getAttribute('viewBox') }
    }, svg)
    assert.equal(exported.error, undefined)
    assert.deepEqual(exported.labels, preview.labels, 'Export must contain the exact preview labels')
    assert.ok(exported.viewBox?.split(/\s+/).every(value => Number.isFinite(Number(value))))
    for (let step = 0; step < 3; step++) {
      const diagram = await page.getByTestId('mermaid-preview').boundingBox(), pane = await page.locator('.mermaid-preview-scroll').boundingBox()
      if (diagram.height <= pane.height - 32) break
      await page.getByRole('button', { name: '缩小预览', exact: true }).click()
    }
    await page.screenshot({ path: path.join(output, `diagram-${kind}-preview.png`), fullPage: true, animations: 'disabled' })
    await page.getByTestId('mermaid-create-copy').click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByTestId('scene-editor')).toBeVisible()
    const editable = await save(page)
    assert.equal(editable.kind, 'flow')
    assert.equal(editable.source, '')
    assert.ok(editable.scene.elements.length >= 2)
    if (kind === 'pie') assert.ok(editable.scene.elements.some(e => e.type === 'stroke' && e.closed && e.style.fill !== 'none'), 'Pie slices stay filled vector elements')
    const editableShape = editable.scene.elements.find(e => e.type === 'shape' && e.shape !== 'frame' && e.text)
    assert.ok(editableShape, 'Converted diagram has independently editable text')
    await byId(page, editableShape.id).dblclick()
    await page.locator('.inline-text-editor').fill(`${label}验收修改`)
    await page.locator('.inline-text-editor').press('Control+Enter')
    const edited = await save(page)
    assert.equal(edited.scene.elements.find(e => e.id === editableShape.id).text, `${label}验收修改`)
  })

  await test('diagram-library-search-cancel-history-and-error', async page => {
    await page.getByTestId('create-mermaid').click()
    const source = page.getByTestId('mermaid-source')
    const original = 'flowchart LR\n  unique[保留的源码] --> done[原始终点]'
    await source.fill(original)
    await page.getByTestId('mermaid-template-toggle').click()
    const kinds = await page.locator('[data-diagram-kind]').evaluateAll(cards => [...new Set(cards.map(card => card.getAttribute('data-diagram-kind')))].sort())
    assert.deepEqual(kinds, Object.keys(diagramKinds).sort(), 'All 22 diagram families are discoverable')
    await page.getByLabel('搜索图表模板', { exact: true }).fill('radar')
    await expect(page.locator('[data-diagram-kind]')).toHaveCount(1)
    await page.locator('[data-diagram-kind="radar"]').click()
    await expect(page.getByTestId('mermaid-confirm-template')).toBeVisible()
    await page.locator('[data-template-cancel]').click()
    assert.equal(await source.inputValue(), original)
    await page.locator('[data-diagram-kind="radar"]').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mermaid-confirm-template')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mermaid-template-library')).toHaveCount(0)
    await expect(page.getByTestId('mermaid-template-toggle')).toBeFocused()
    assert.equal(await source.inputValue(), original)
    await chooseTemplate(page, 'radar')
    const replacement = await source.inputValue()
    await undo(page)
    await expect(source).toHaveValue(original)
    await redo(page)
    await expect(source).toHaveValue(replacement)
    const invalid = 'notSupportedDiagram\n  untouched invalid source'
    await source.fill(invalid)
    await expect(page.getByTestId('mermaid-error')).toBeVisible()
    await expect(page.getByTestId('mermaid-create-copy')).toBeDisabled()
    assert.equal((await save(page)).source, invalid, 'Invalid draft remains saveable without replacing source')
    await undo(page)
    await expect(source).toHaveValue(replacement)
    await expect(page.getByTestId('mermaid-error')).toHaveCount(0)
  })

  await test('board-seven-new-shapes-have-real-outline', async page => {
    await page.getByTestId('create-board').click()
    const shapes = [['triangle', '三角形'], ['hexagon', '六边形'], ['star', '星形'], ['parallelogram', '平行四边形'], ['cylinder', '圆柱'], ['cloud', '云形'], ['frame', '分区框架']]
    for (let index = 0; index < shapes.length; index++) {
      await page.getByRole('button', { name: '图形素材面板', exact: true }).click()
      await page.getByRole('button', { name: `绘制${shapes[index][1]}`, exact: true }).click()
      await page.getByRole('button', { name: '关闭图形素材', exact: true }).click()
      const x = .07 + (index % 3) * .29, y = .17 + Math.floor(index / 3) * .25
      await gesture(page, await stagePoint(page, x, y), await stagePoint(page, x + .21, y + .17))
    }
    const doc = await save(page)
    assert.deepEqual(doc.scene.elements.map(e => e.shape).sort(), shapes.map(e => e[0]).sort())
    for (const element of doc.scene.elements) {
      const node = byId(page, element.id)
      const outline = await node.evaluate(g => ({ paths: [...g.querySelectorAll('path')].map(p => p.getAttribute('d')), polygons: g.querySelectorAll('polygon').length, rects: [...g.querySelectorAll('rect')].map(r => r.getAttribute('fill')) }))
      if (element.shape === 'frame') assert.ok(outline.rects.every(fill => !fill || fill === 'none' || fill === 'transparent'), 'Frame body is transparent')
      else assert.ok(outline.paths.length || outline.polygons, `${element.shape} is drawn with its own outline, not a rectangle`)
      if (['triangle', 'hexagon', 'star', 'parallelogram', 'cloud'].includes(element.shape)) {
        const box = await node.boundingBox()
        const cornerTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-element-id]')?.getAttribute('data-element-id'), { x: box.x + 2, y: box.y + 2 })
        assert.notEqual(cornerTarget, element.id, `${element.shape} should not have an invisible rectangular hit target`)
      }
    }
    const svg = await exportedSvg(page)
    assert.ok(!svg.includes('NaN') && !svg.includes('undefined'))
  })

  await test('board-group-drag-copy-alt-member-ungroup-and-lock', async page => {
    await page.getByTestId('create-board').click()
    await draw(page, 'rectangle', [.15, .23], [.32, .38])
    await draw(page, 'rectangle', [.49, .23], [.66, .38])
    await selectAll(page)
    await page.getByTestId('group-selection').click()
    const grouped = await save(page), originals = grouped.scene.elements
    assert.ok(originals[0].groupId && originals[0].groupId === originals[1].groupId)
    const start = await center(byId(page, originals[0].id))
    await gesture(page, start, { x: start.x + 70, y: start.y + 60 })
    const moved = await save(page)
    for (let i = 0; i < 2; i++) { near(moved.scene.elements[i].x - originals[i].x, moved.scene.elements[0].x - originals[0].x, 'Group x'); near(moved.scene.elements[i].y - originals[i].y, moved.scene.elements[0].y - originals[0].y, 'Group y') }
    assert.ok(moved.scene.elements[0].x !== originals[0].x)
    await page.getByTestId('canvas-stage').focus()
    await page.keyboard.press('Control+d')
    const duplicated = await save(page), copies = duplicated.scene.elements.filter(e => !originals.some(o => o.id === e.id))
    assert.equal(copies.length, 2)
    assert.ok(copies[0].groupId && copies[0].groupId === copies[1].groupId && copies[0].groupId !== originals[0].groupId, 'Duplicating a group creates an independent group')
    await byId(page, copies[0].id).click({ modifiers: ['Alt'] })
    const memberStart = await center(byId(page, copies[0].id))
    await page.keyboard.down('Alt')
    await gesture(page, memberStart, { x: memberStart.x, y: memberStart.y + 110 })
    await page.keyboard.up('Alt')
    const singleMoved = await save(page)
    const untouched = singleMoved.scene.elements.find(e => e.id === copies[1].id)
    near(untouched.x, copies[1].x, 'Alt member sibling x'); near(untouched.y, copies[1].y, 'Alt member sibling y')
    assert.notEqual(singleMoved.scene.elements.find(e => e.id === copies[0].id).y, copies[0].y)
    await page.getByTestId('canvas-stage').focus()
    await page.keyboard.press('Control+Shift+g')
    const ungrouped = await save(page)
    assert.ok(ungrouped.scene.elements.filter(e => copies.some(c => c.id === e.id)).every(e => !e.groupId))
    await contextAction(page, byId(page, copies[0].id), '锁定')
    const lockedBefore = await save(page), locked = lockedBefore.scene.elements.find(e => e.id === copies[0].id)
    const lockedStart = await center(byId(page, locked.id))
    await gesture(page, lockedStart, { x: lockedStart.x + 70, y: lockedStart.y + 70 })
    await page.getByTestId('canvas-stage').focus(); await page.keyboard.press('Delete')
    const after = (await save(page)).scene.elements.find(e => e.id === locked.id)
    assert.ok(after?.locked); near(after.x, locked.x, 'Locked x'); near(after.y, locked.y, 'Locked y')
  })

  // Chromium suppresses the 11th automatic download in a burst. Keep each
  // operation in its own real document/context, including all three saves.
  const alignmentValues = { left: e => e.x, center: e => e.x + e.width / 2, right: e => e.x + e.width, top: e => e.y, middle: e => e.y + e.height / 2, bottom: e => e.y + e.height }
  for (const operation of [...Object.keys(alignmentValues).map(direction => ({ type: 'align', direction })), ...['horizontal', 'vertical'].map(direction => ({ type: 'distribute', direction }))]) await test(`board-${operation.type}-${operation.direction}-save-and-undo`, async page => {
    await page.getByTestId('create-board').click()
    await draw(page, 'rectangle', [.10, .20], [.24, .30])
    await draw(page, 'rectangle', [.38, .40], [.56, .57])
    await draw(page, 'rectangle', [.72, .69], [.86, .82])
    await selectAll(page)
    const before = coords(await save(page))
    const { type, direction } = operation
    if (type === 'align') {
      const value = alignmentValues[direction]
      await page.getByTestId(`align-${direction}`).click()
      const aligned = coords(await save(page))
      for (const node of aligned) near(value(node), value(aligned[0]), `Align ${direction}`)
    } else {
      const [axis, dimension] = direction === 'horizontal' ? ['x', 'width'] : ['y', 'height']
      await page.getByTestId(`distribute-${direction}`).click()
      const distributed = coords(await save(page)).sort((a, b) => a[axis] - b[axis])
      near(distributed[1][axis] - distributed[0][axis] - distributed[0][dimension], distributed[2][axis] - distributed[1][axis] - distributed[1][dimension], `Equal ${direction} gaps`)
      near(distributed[0][axis], before[0][axis], 'First anchor'); near(distributed[2][axis], before[2][axis], 'Last anchor')
    }
    await undo(page)
    assert.deepEqual(coords(await save(page)), before)
  })

  await test('board-highlighter-eraser-one-history-step-and-locked-content', async page => {
    await page.getByTestId('create-board').click()
    await draw(page, 'rectangle', [.17, .30], [.32, .44])
    await draw(page, 'rectangle', [.47, .30], [.62, .44])
    const shapes = (await save(page)).scene.elements
    await contextAction(page, byId(page, shapes[1].id), '锁定')
    await draw(page, 'highlighter', [.12, .55], [.70, .55])
    await draw(page, 'pen', [.12, .66], [.70, .66])
    const before = await save(page), highlight = before.scene.elements.find(e => e.type === 'stroke' && e.style.opacity === .32)
    assert.ok(highlight && highlight.style.strokeWidth >= 14 && highlight.points.length > 3)
    await page.getByTestId('tool-eraser').click()
    await gesture(page, await stagePoint(page, .24, .27), await stagePoint(page, .24, .72))
    const erased = await save(page)
    assert.equal(erased.scene.elements.length, 1, 'One eraser gesture removes the unlocked shape and both crossing strokes')
    assert.equal(erased.scene.elements[0].id, shapes[1].id)
    await gesture(page, await center(byId(page, shapes[1].id)), await stagePoint(page, .65, .40))
    assert.equal((await save(page)).scene.elements.length, 1, 'Eraser leaves locked content intact')
    await undo(page)
    assert.deepEqual((await save(page)).scene.elements, before.scene.elements, 'One undo restores every element touched in a single eraser gesture')
    await redo(page)
    assert.equal((await save(page)).scene.elements.length, 1)
    for (const [index, width] of [50, 100].entries()) {
      await page.getByTestId('global-style-toggle').click()
      await page.locator('#global-width').fill(String(width))
      await page.locator('#global-width').press('Tab')
      await draw(page, 'highlighter', [.15, .54 + index * .14], [.70, .54 + index * .14])
      const wide = await save(page), strokes = wide.scene.elements.filter(e => e.type === 'stroke')
      assert.equal(strokes.length, index + 1, 'Wide highlighter must stay on the canvas instead of rolling back')
      assert.equal(strokes.at(-1).style.strokeWidth, 100, 'Highlighter width clamps to the scene format maximum')
      assert.equal(strokes.at(-1).style.opacity, .32)
    }
  })

  await test('board-frame-follows-contained-content-note-color-opacity', async page => {
    await page.getByTestId('create-board').click()
    await draw(page, 'rectangle', [.20, .31], [.34, .44])
    await draw(page, 'note', [.40, .34], [.55, .49])
    await page.locator('.inline-text-editor').fill('跟随分区的便签')
    await page.locator('.inline-text-editor').press('Control+Enter')
    await page.getByRole('button', { name: '便签颜色 #d8f4df', exact: true }).click()
    await page.locator('#element-opacity').fill('0.55')
    await page.locator('#element-opacity').press('Tab')
    await draw(page, 'rectangle', [.75, .32], [.89, .46])
    await draw(page, 'frame', [.12, .20], [.65, .67])
    const before = await save(page), frame = before.scene.elements.find(e => e.shape === 'frame'), note = before.scene.elements.find(e => e.shape === 'note')
    assert.equal(note.style.fill, '#d8f4df'); assert.equal(note.style.opacity, .55)
    assert.equal(before.scene.elements[0].id, frame.id, 'Frame is placed behind its contents')
    const bounds = await byId(page, frame.id).boundingBox()
    const header = { x: bounds.x + bounds.width / 2, y: bounds.y + 9 }
    await gesture(page, header, { x: header.x + 30, y: header.y + 70 })
    const after = await save(page), movedFrame = after.scene.elements.find(e => e.id === frame.id), dx = movedFrame.x - frame.x, dy = movedFrame.y - frame.y
    assert.ok(dx || dy)
    for (const node of before.scene.elements.filter(e => e.id !== frame.id)) {
      const moved = after.scene.elements.find(e => e.id === node.id)
      const contained = node.x >= frame.x && node.x + node.width <= frame.x + frame.width
      near(moved.x - node.x, contained ? dx : 0, 'Frame content x'); near(moved.y - node.y, contained ? dy : 0, 'Frame content y')
    }
    await undo(page)
    assert.deepEqual((await save(page)).scene.elements, before.scene.elements)
    const resetBounds = await byId(page, frame.id).boundingBox()
    await page.mouse.click(resetBounds.x + resetBounds.width / 2, resetBounds.y + 9)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    const nudged = await save(page), nudgeFrame = nudged.scene.elements.find(e => e.id === frame.id)
    assert.ok(nudgeFrame.x !== frame.x && nudgeFrame.y !== frame.y, 'Frame supports keyboard movement')
    for (const node of before.scene.elements.filter(e => e.id !== frame.id)) {
      const current = nudged.scene.elements.find(e => e.id === node.id), contained = node.x >= frame.x && node.x + node.width <= frame.x + frame.width
      near(current.x - node.x, contained ? nudgeFrame.x - frame.x : 0, 'Keyboard frame content x')
      near(current.y - node.y, contained ? nudgeFrame.y - frame.y : 0, 'Keyboard frame content y')
    }
    const nudgedBounds = await byId(page, frame.id).boundingBox()
    await page.mouse.click(nudgedBounds.x + nudgedBounds.width / 2, nudgedBounds.y + 9, { button: 'right' })
    await page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '锁定', exact: true }).click()
    await page.getByTestId('canvas-stage').focus()
    await page.keyboard.press('ArrowRight')
    const lockedFrame = await save(page)
    assert.ok(lockedFrame.scene.elements.find(e => e.id === frame.id).locked)
    assert.deepEqual(coords(lockedFrame), coords(nudged), 'A locked frame cannot move its children with an arrow key')
    await page.reload()
    await expect(page.getByTestId('scene-editor')).toBeVisible()
    const restored = await save(page)
    assert.equal(restored.scene.elements.find(e => e.id === note.id).style.opacity, .55)
    assert.equal(restored.scene.elements.find(e => e.id === note.id).style.fill, '#d8f4df')
  })

  await test('board-locked-group-keyboard-and-context-shortcuts', async page => {
    await page.getByTestId('create-board').click()
    await draw(page, 'rectangle', [.15, .30], [.32, .45])
    await draw(page, 'rectangle', [.49, .30], [.66, .45])
    await selectAll(page)
    await elements(page).first().click({ button: 'right' })
    await page.keyboard.press('Control+g')
    await expect(page.getByTestId('canvas-context-menu')).toHaveCount(0)
    const grouped = await save(page), [first, second] = grouped.scene.elements
    assert.ok(first.groupId && first.groupId === second.groupId)
    await byId(page, first.id).click({ modifiers: ['Alt'] })
    await contextAction(page, byId(page, first.id), '锁定')
    await byId(page, second.id).click()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    const locked = await save(page)
    assert.deepEqual(coords(locked), coords(grouped), 'A group with a locked member cannot be torn apart by keyboard movement')
    await byId(page, first.id).click({ modifiers: ['Alt'] })
    await contextAction(page, byId(page, first.id), '解锁')
    await byId(page, second.id).click()
    await byId(page, second.id).click({ button: 'right' })
    await page.keyboard.press('Control+Shift+g')
    await expect(page.getByTestId('canvas-context-menu')).toHaveCount(0)
    assert.ok((await save(page)).scene.elements.every(e => !e.groupId), 'Context menu forwards the ungroup shortcut')
  })

  for (const id of ['brainstorm', 'quadrant', 'kanban', 'retrospective']) await test(`board-template-${id}-insert-undo-save`, async page => {
    await page.getByTestId('create-board').click()
    await draw(page, 'rectangle', [.12, .20], [.30, .36])
    const before = await save(page)
    await page.getByTestId('board-template-toggle').click()
    const panel = page.getByTestId('board-template-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-board-template]')).toHaveCount(4)
    await panel.locator(`[data-board-template="${id}"]`).click()
    await expect(panel).toHaveCount(0)
    const inserted = await save(page)
    assert.ok(inserted.scene.elements.length > before.scene.elements.length + 5)
    assert.deepEqual(inserted.scene.elements.find(e => e.id === before.scene.elements[0].id), before.scene.elements[0], 'Template insertion preserves existing work')
    assert.ok(inserted.scene.elements.some(e => e.shape === 'note'))
    assert.ok(inserted.scene.elements.some(e => e.shape === 'frame'))
    const ids = new Set(inserted.scene.elements.map(e => e.id))
    assert.equal(ids.size, inserted.scene.elements.length)
    await undo(page)
    assert.deepEqual((await save(page)).scene.elements, before.scene.elements, 'Template insertion is one undoable step')
    await redo(page)
    assert.deepEqual((await save(page)).scene.elements, inserted.scene.elements)
    const note = inserted.scene.elements.find(e => e.shape === 'note')
    await byId(page, note.id).dblclick()
    await page.locator('.inline-text-editor').fill('模板便签可以继续编辑')
    await page.locator('.inline-text-editor').press('Control+Enter')
    assert.equal((await save(page)).scene.elements.find(e => e.id === note.id).text, '模板便签可以继续编辑')
    await exportedSvg(page)
  })

  await test('workspace-svg-icons-home-flow-board-mermaid', async page => {
    async function assertIcons(selector) {
      const issues = await page.locator(selector).evaluateAll(buttons => buttons.filter(button => !button.querySelector('svg path, svg line, svg polyline, svg rect, svg circle, svg ellipse, svg polygon')).map(button => button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent))
      assert.deepEqual(issues, [], `Controls must use real SVG icons: ${selector}`)
    }
    await assertIcons('[data-testid="create-flow"], [data-testid="create-board"], [data-testid="create-mermaid"]')
    for (const mode of ['flow', 'board', 'mermaid']) {
      if (mode !== 'flow') await page.locator('.tab-home').click()
      await page.getByTestId(`create-${mode}`).click()
      await assertIcons('button[title="保存 (Ctrl+S)"], button[title="导出"], button[aria-label="撤销"], button[aria-label="重做"]')
      if (mode !== 'mermaid') {
        await assertIcons('[data-testid^="tool-"], [data-testid="global-style-toggle"], button[aria-label="图形素材面板"], button[aria-label="属性面板"]')
        await page.getByRole('button', { name: '图形素材面板', exact: true }).click()
        await assertIcons('.shape-grid button')
        await page.getByRole('button', { name: '关闭图形素材', exact: true }).click()
      } else {
        await assertIcons('[data-testid="mermaid-template-toggle"], [data-testid="mermaid-create-copy"], button[aria-label="缩小预览"], button[aria-label="放大预览"]')
        await page.getByTestId('mermaid-template-toggle').click()
        await assertIcons('[data-template-id]')
        await page.keyboard.press('Escape')
      }
    }
  })

  await test('mobile-template-library-and-expanded-whiteboard-fit', async page => {
    await page.getByTestId('create-mermaid').click()
    await page.getByTestId('mermaid-template-toggle').click()
    const library = page.getByTestId('mermaid-template-library')
    await assertFits(page, library)
    const search = page.getByLabel('搜索图表模板', { exact: true })
    await expect(search).toBeFocused()
    await search.fill('packet')
    await page.locator('[data-diagram-kind="packet"]').click()
    await assertFits(page, library)
    await page.getByTestId('mermaid-confirm-template').click()
    await expect(page.getByTestId('mermaid-preview').locator('svg')).toBeVisible()
    await page.locator('.tab-home').click()
    await page.getByTestId('create-board').click()
    await assertFits(page, page.locator('.canvas-commandbar'))
    await page.getByRole('button', { name: '图形素材面板', exact: true }).click()
    await expect(page.getByRole('button', { name: '绘制星形', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '绘制星形', exact: true }).click()
    if (await page.getByRole('button', { name: '关闭图形素材', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭图形素材', exact: true }).click()
    await gesture(page, await stagePoint(page, .18, .30), await stagePoint(page, .72, .55))
    assert.equal((await save(page)).scene.elements[0].shape, 'star')
    await assertFits(page)
  }, { width: 320, height: 740 })

  await fs.writeFile(path.join(output, 'results-expanded-workspaces.json'), JSON.stringify(results, null, 2))
  assert.ok(results.length, 'No matching acceptance cases')
  assert.ok(results.every(result => result.pass), `${results.filter(result => !result.pass).length} expanded workspace case(s) failed; see ${output}`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  if (server) server.kill('SIGTERM')
})
