/* Browser acceptance for code-diagram appearance and neutral workspace labels.
 * Run against a stable build: BASE_URL=http://127.0.0.1:5213 node tests/browser/diagram-styles.cjs
 * TEST_FILTER, BROWSER_ARTIFACTS and CHROMIUM_EXECUTABLE are optional.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5199'
const output = process.env.BROWSER_ARTIFACTS || '/tmp/open-workflow-diagram-styles'
const results = []
const styles = ['classic', 'minimal', 'blueprint', 'ink', 'sketch', 'forest', 'ocean', 'sunset', 'lavender', 'midnight']
const sample = 'flowchart LR\n  A[开始评审] --> B{满足条件?}\n  B -->|通过| C[交付结果]\n  B -->|修改| A'
const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true }
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
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(baseURL)
    await page.getByTestId('create-diagram').waitFor()
    await expect(page.locator('.local-badge')).toHaveCount(0)
    await run(page)
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
  const file = await pending
  assert.equal(await file.failure(), null)
  return { name: file.suggestedFilename(), bytes: await fs.readFile(await file.path()) }
}
async function save(page) {
  const file = await download(page, () => page.getByTitle('保存 (Ctrl+S)', { exact: true }).click())
  assert.match(file.name, /\.owflow$/)
  return { ...file, document: JSON.parse(file.bytes.toString('utf8')) }
}
async function exportFile(page, type) {
  await page.getByTitle('导出', { exact: true }).click()
  return download(page, () => page.getByRole('menuitem', { name: type === 'svg' ? 'SVG 矢量图' : 'PNG 图片', exact: true }).click())
}
async function createDiagram(page, source = sample) {
  await page.getByTestId('create-diagram').click()
  await page.getByTestId('diagram-source').fill(source)
  await expect(page.getByTestId('diagram-preview').locator('svg')).toContainText('开始评审')
  await expect(page.getByTestId('diagram-error')).toHaveCount(0)
}
async function previewMarkup(page) { return page.getByTestId('diagram-preview').locator('svg').evaluate(svg => svg.outerHTML) }
async function describeSvg(page, markup) {
  return page.evaluate(value => {
    const document = new DOMParser().parseFromString(value, 'image/svg+xml')
    if (document.querySelector('parsererror')) throw Error('Malformed exported SVG')
    const walk = element => [element.localName,
      [...element.attributes].filter(attribute => attribute.name !== 'xmlns').map(attribute => [attribute.name, attribute.value]).sort((a, b) => a[0].localeCompare(b[0])),
      [...element.childNodes].flatMap(child => child.nodeType === 1 ? [walk(child)] : child.nodeType === 3 && child.textContent.trim() ? [child.textContent] : []),
    ]
    return { drawing: walk(document.documentElement), labels: [...document.querySelectorAll('text')].map(text => text.textContent) }
  }, markup)
}
async function openStyles(page) {
  if (!await page.getByTestId('diagram-style-panel').isVisible()) await page.getByTestId('diagram-style-toggle').click()
  await expect(page.getByTestId('diagram-style-panel')).toBeVisible()
}
async function chooseStyle(page, style, close = true) {
  await openStyles(page)
  const card = page.locator(`[data-diagram-style="${style}"]`)
  await card.click()
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  if (close) {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('diagram-style-panel')).toHaveCount(0)
  }
}
async function expectSelectedStyle(page, style) {
  await openStyles(page)
  await expect(page.locator(`[data-diagram-style="${style}"]`)).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
}
async function reopened(file, check) {
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(baseURL)
    await page.getByTestId('create-diagram').waitFor()
    await page.locator('#file-input').setInputFiles({ name: file.name, mimeType: 'application/json', buffer: file.bytes })
    await expect(page.getByTestId('diagram-source')).toBeVisible()
    await check(page)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}
async function chooseTemplate(page, kind) {
  await page.getByTestId('diagram-template-toggle').click()
  await page.locator(`[data-diagram-kind="${kind}"]`).first().click()
  if (await page.getByTestId('diagram-confirm-template').isVisible()) await page.getByTestId('diagram-confirm-template').click()
  await expect(page.getByTestId('diagram-template-library')).toHaveCount(0)
  await expect(page.getByTestId('diagram-error')).toHaveCount(0)
}
async function pngMatchesPreview(page, markup, png) {
  const comparison = await page.evaluate(async ({ markup, png }) => {
    const svgUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
    async function load(url) { const image = new Image(); await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url }); return image }
    try {
      const [expected, actual] = await Promise.all([load(svgUrl), load(png)])
      const canvas = document.createElement('canvas')
      canvas.width = actual.naturalWidth; canvas.height = actual.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(expected, 0, 0, canvas.width, canvas.height)
      const reference = context.getImageData(0, 0, canvas.width, canvas.height).data
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(actual, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let totalError = 0, changed = 0
      for (let index = 0; index < pixels.length; index++) { const difference = Math.abs(pixels[index] - reference[index]); totalError += difference; if (difference > 2) changed++ }
      return { width: canvas.width, height: canvas.height, meanError: totalError / pixels.length, changedFraction: changed / pixels.length }
    } finally { URL.revokeObjectURL(svgUrl) }
  }, { markup, png: `data:image/png;base64,${png.toString('base64')}` })
  assert.ok(comparison.width >= 100 && comparison.height >= 100)
  assert.ok(comparison.meanError < .2 && comparison.changedFraction < .002, `Exported PNG should render the same styled diagram as the preview: ${JSON.stringify(comparison)}`)
}
async function assertFits(page, locator) {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)
  assert.ok(overflow <= 1, `Horizontal page overflow: ${overflow}`)
  if (locator) { const box = await locator.boundingBox(), viewport = page.viewportSize(); assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `Panel outside viewport: ${JSON.stringify(box)}`) }
}

async function main() {
  await fs.mkdir(output, { recursive: true })
  await ensureServer()
  const executablePath = process.env.CHROMIUM_EXECUTABLE || (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined))
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })

  for (const style of styles) await test(`diagram-style-${style}-preview-save-reopen`, async page => {
    await createDiagram(page)
    const classic = await describeSvg(page, await previewMarkup(page))
    await openStyles(page)
    const available = await page.locator('[data-diagram-style]').evaluateAll(cards => cards.map(card => card.getAttribute('data-diagram-style')).sort())
    assert.deepEqual(available, [...styles].sort(), 'Exactly ten distinct styles are available')
    await chooseStyle(page, style)
    await expect(page.getByTestId('diagram-source')).toHaveValue(sample)
    const appearance = await describeSvg(page, await previewMarkup(page))
    assert.deepEqual(appearance.labels, classic.labels, 'A style change preserves every diagram label')
    if (style === 'classic') assert.deepEqual(appearance.drawing, classic.drawing)
    else assert.notDeepEqual(appearance.drawing, classic.drawing, `${style} must visibly change rendered colors, lines or typography`)
    if (style === 'sketch') await expect(page.getByTestId('diagram-preview').locator('[data-sketch-pass="1"]').first()).toBeVisible()
    const file = await save(page)
    assert.equal(file.document.diagramStyle, style)
    assert.equal(file.document.source, sample)
    await reopened(file, async fresh => {
      await expect(fresh.getByTestId('diagram-source')).toHaveValue(sample)
      await expectSelectedStyle(fresh, style)
      assert.deepEqual(await describeSvg(fresh, await previewMarkup(fresh)), appearance, 'Opening the downloaded document restores the exact appearance')
    })
    await page.reload()
    await expect(page.getByTestId('diagram-source')).toHaveValue(sample)
    assert.deepEqual(await describeSvg(page, await previewMarkup(page)), appearance, 'The automatic local draft also preserves the style')
  })

  for (const style of ['blueprint', 'sketch', 'midnight']) await test(`diagram-style-${style}-svg-png-editable-copy`, async page => {
    await createDiagram(page)
    if (style === 'midnight') await chooseTemplate(page, 'pie')
    await chooseStyle(page, style)
    const markup = await previewMarkup(page), appearance = await describeSvg(page, markup)
    const svg = await exportFile(page, 'svg')
    assert.match(svg.name, /\.svg$/)
    assert.deepEqual(await describeSvg(page, svg.bytes.toString('utf8')), appearance, 'SVG uses the displayed style')
    const png = await exportFile(page, 'png')
    assert.match(png.name, /\.png$/)
    await pngMatchesPreview(page, markup, png.bytes)
    await page.getByTestId('diagram-create-copy').click()
    await expect(page.getByTestId('scene-editor')).toBeVisible()
    const editable = await save(page)
    assert.equal(editable.document.kind, 'flow')
    assert.ok(editable.document.scene.elements.some(element => element.type === 'shape' && element.text && appearance.labels.includes(element.text)), 'The editable copy preserves actual preview text from the chosen example')
    if (style === 'midnight') {
      const slices = editable.document.scene.elements.filter(element => element.type === 'stroke' && element.closed)
      assert.ok(slices.length >= 3 && new Set(slices.map(slice => slice.style.fill)).size >= 3, 'Night styling preserves distinct chart data categories')
    }
    const copiedSvg = await exportFile(page, 'svg')
    assert.deepEqual(await describeSvg(page, copiedSvg.bytes.toString('utf8')), appearance, 'Editable copy retains the preview appearance instead of returning to classic')
    if (style === 'sketch') assert.ok(editable.document.scene.elements.some(element => element.style.roughness === 'sketch'))
  })

  await test('diagram-style-history-and-template-replacement', async page => {
    await createDiagram(page)
    await chooseStyle(page, 'forest')
    const forest = await describeSvg(page, await previewMarkup(page))
    await chooseStyle(page, 'midnight')
    const midnight = await describeSvg(page, await previewMarkup(page))
    assert.notDeepEqual(midnight.drawing, forest.drawing)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    assert.deepEqual(await describeSvg(page, await previewMarkup(page)), forest)
    assert.equal((await save(page)).document.diagramStyle, 'forest')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    assert.deepEqual(await describeSvg(page, await previewMarkup(page)), midnight)
    assert.equal((await save(page)).document.diagramStyle, 'midnight')
    await expect(page.getByTestId('diagram-source')).toHaveValue(sample)
    await chooseTemplate(page, 'pie')
    const replacement = await page.getByTestId('diagram-source').inputValue()
    assert.notEqual(replacement, sample)
    await expectSelectedStyle(page, 'midnight')
    const saved = await save(page)
    assert.equal(saved.document.diagramStyle, 'midnight')
    assert.equal(saved.document.source, replacement)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByTestId('diagram-source')).toHaveValue(sample)
    assert.deepEqual(await describeSvg(page, await previewMarkup(page)), midnight, 'Undoing a template replacement keeps the selected style')
  })

  await test('diagram-style-pending-source-and-invalid-draft', async page => {
    await createDiagram(page)
    const changed = sample.replace('开始评审', '新输入尚未失焦')
    await page.getByTestId('diagram-source').fill(changed)
    await chooseStyle(page, 'ocean')
    const saved = await save(page)
    assert.equal(saved.document.source, changed, 'Opening the style chooser flushes the latest source input')
    assert.equal(saved.document.diagramStyle, 'ocean')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByTestId('diagram-source')).toHaveValue(changed)
    await expectSelectedStyle(page, 'classic')
    const invalid = 'unsupportedDiagram\n  请保留这份错误源码'
    await page.getByTestId('diagram-source').fill(invalid)
    await chooseStyle(page, 'ink')
    await expect(page.getByTestId('diagram-error')).toBeVisible()
    await expect(page.getByTestId('diagram-create-copy')).toBeDisabled()
    const draft = await save(page)
    assert.equal(draft.document.source, invalid)
    assert.equal(draft.document.diagramStyle, 'ink')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByTestId('diagram-source')).toHaveValue(invalid)
    await expect(page.getByTestId('diagram-error')).toBeVisible()
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await page.getByTestId('diagram-source').fill(sample)
    await expect(page.getByTestId('diagram-error')).toHaveCount(0)
    await expect(page.getByTestId('diagram-preview').locator('svg')).toContainText('开始评审')
    await expectSelectedStyle(page, 'ink')
  })

  await test('diagram-style-mobile-svg-controls-and-neutral-labels', async page => {
    await createDiagram(page)
    await openStyles(page)
    const panel = page.getByTestId('diagram-style-panel')
    await assertFits(page, panel)
    const missingSvg = await page.locator('[data-diagram-style]').evaluateAll(cards => cards.filter(card => !card.querySelector('svg path,svg rect,svg circle,svg polyline,svg line')).map(card => card.getAttribute('data-diagram-style')))
    assert.deepEqual(missingSvg, [], 'Every style card has a real SVG appearance sample')
    const iconButtons = page.locator('[data-testid="diagram-style-toggle"], [data-testid="diagram-template-toggle"], [data-testid="diagram-create-copy"]')
    assert.deepEqual(await iconButtons.evaluateAll(buttons => buttons.filter(button => !button.querySelector('svg path,svg rect,svg circle,svg polyline,svg line')).map(button => button.getAttribute('data-testid'))), [])
    await page.locator('[data-diagram-style="classic"]').focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-diagram-style="minimal"]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-diagram-style="minimal"]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('[data-diagram-style="midnight"]').scrollIntoViewIfNeeded()
    await chooseStyle(page, 'midnight', false)
    await page.keyboard.press('Control+z')
    await expect(page.locator('[data-diagram-style="minimal"]')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Control+Shift+z')
    await expect(page.locator('[data-diagram-style="midnight"]')).toHaveAttribute('aria-pressed', 'true')
    const saved = await download(page, () => page.keyboard.press('Control+s'))
    assert.equal(JSON.parse(saved.bytes.toString('utf8')).diagramStyle, 'midnight', 'Save shortcut works while the style panel is open')
    await assertFits(page, panel)
    await page.screenshot({ path: path.join(output, 'diagram-style-mobile-panel.png'), fullPage: true, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.getByTestId('diagram-style-toggle')).toBeFocused()
    await assertFits(page)
    await expect(page.locator('.diagram-title strong')).toHaveText('代码图表')
    await expect(page.locator('.diagram-editor')).toHaveAttribute('aria-label', '代码图表编辑器')
    await expect(page.getByTestId('diagram-source')).toHaveAttribute('aria-label', '代码图表源码')
  }, { width: 320, height: 740 })

  await fs.writeFile(path.join(output, 'results-diagram-styles.json'), JSON.stringify(results, null, 2))
  assert.ok(results.length, 'No matching browser acceptance cases')
  assert.ok(results.every(result => result.pass), `${results.filter(result => !result.pass).length} diagram style case(s) failed; see ${output}`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  if (server) server.kill('SIGTERM')
})
