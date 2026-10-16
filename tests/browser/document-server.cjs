/* Real service acceptance. Build the web app first, then run this file.
 * BASE_URL, DOCUMENT_SERVER_DRIVER, CHROMIUM_EXECUTABLE, TEST_FILTER and
 * BROWSER_ARTIFACTS may override the local production preview and artifacts.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { chromium, expect } = require('@playwright/test')
const { DocumentServerDriver, installDesktopTransport } = require('./helpers/document-server-driver.cjs')

const root = path.resolve(__dirname, '../..')
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5199'
const output = process.env.BROWSER_ARTIFACTS || '/tmp/open-workflow-document-server'
const viewport = { width: 1440, height: 1000 }
const contextOptions = { viewport, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true }
const results = []
const source = 'flowchart LR\n  A[共享需求] --> B[复核完成]\n'
let browser, preview, driverBinary

async function exists(file) { return fs.access(file).then(() => true, () => false) }
async function runProcess(command, args, options = {}) {
  const process = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let log = ''; process.stdout.on('data', data => { log += data }); process.stderr.on('data', data => { log += data })
  return new Promise((resolve, reject) => { process.on('error', reject); process.on('exit', code => code === 0 ? resolve(log) : reject(Error(`${command} exited ${code}:\n${log}`))) })
}
async function prepareDriver() {
  if (process.env.DOCUMENT_SERVER_DRIVER) { driverBinary = process.env.DOCUMENT_SERVER_DRIVER; assert.ok(await exists(driverBinary)); return }
  const env = { ...process.env }
  if (!env.CARGO_HOME && await exists('/tmp/open-workflow-cargo/bin/cargo')) {
    env.CARGO_HOME = '/tmp/open-workflow-cargo'; env.RUSTUP_HOME = '/tmp/open-workflow-rustup'; env.PATH = `${env.CARGO_HOME}/bin:${env.PATH}`
  }
  await runProcess('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--locked', '--example', 'document_server_driver'], { env })
  driverBinary = path.resolve(root, env.CARGO_TARGET_DIR || 'src-tauri/target', `debug/examples/document_server_driver${process.platform === 'win32' ? '.exe' : ''}`)
  assert.ok(await exists(driverBinary), `Missing service driver: ${driverBinary}`)
}
async function available() { try { return (await fetch(baseURL, { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }
async function ensurePreview() {
  assert.ok(await exists(path.join(root, 'dist/index.html')), 'Build the production web app before running document sharing acceptance')
  if (await available()) return
  if (process.env.BASE_URL) throw Error(`Cannot reach ${baseURL}`)
  preview = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: 'ignore' })
  for (let attempt = 0; attempt < 80; attempt++) { if (await available()) return; await new Promise(resolve => setTimeout(resolve, 250)) }
  throw Error('Production preview did not become ready')
}
async function test(name, run) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return
  const driver = new DocumentServerDriver(driverBinary, path.join(root, 'dist')), contexts = [], pages = [], errors = [], network = [], consoleMessages = []
  const testOutput = path.join(output, name)
  await fs.mkdir(testOutput, { recursive: true })
  const fixture = {
    driver, testOutput,
    async page({ desktop = false, width = viewport.width, height = viewport.height, init } = {}) {
      const context = await browser.newContext({ ...contextOptions, viewport: { width, height } }); contexts.push(context)
      const transport = desktop ? await installDesktopTransport(context, driver, path.join(testOutput, 'native-files')) : undefined
      if (init) await context.addInitScript(init)
      const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(12000)
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push({ url: page.url(), type: message.type(), text: message.text() }) })
      page.on('response', response => { if (response.url().endsWith('/api/document')) void response.json().then(body => network.push({ url: response.url(), method: response.request().method(), request: response.request().postData(), status: response.status(), body })).catch(() => {}) })
      return { page, context, transport }
    },
  }
  try {
    assert.equal((await driver.invoke('document_server_status')).running, false)
    await run(fixture)
    assert.deepEqual(errors, [], 'No uncaught errors in any desktop or browser client')
    for (const [index, page] of pages.entries()) if (!page.isClosed()) await page.screenshot({ path: path.join(testOutput, `client-${index + 1}.png`), fullPage: true, animations: 'disabled' })
    results.push({ name, pass: true }); process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    const status = await driver.invoke('document_server_status').catch(() => null)
    const snapshot = status?.running ? await driver.invoke('read_shared_document', { sessionId: status.sessionId }).catch(() => null) : null
    const clients = await Promise.all(pages.map(page => page.evaluate(() => ({ url: location.href, header: getComputedStyle(document.querySelector('.shared-header') || document.body).display, stylesheets: [...document.styleSheets].map(sheet => sheet.href), status: document.querySelector('[data-testid="shared-status"]')?.outerHTML })).catch(() => null)))
    await fs.writeFile(path.join(testOutput, 'diagnostics.json'), JSON.stringify({ errors, consoleMessages, status, snapshot, clients, network }, null, 2))
    for (const [index, page] of pages.entries()) if (!page.isClosed()) await page.screenshot({ path: path.join(testOutput, `client-${index + 1}-failure.png`), fullPage: true, animations: 'disabled' }).catch(() => {})
    results.push({ name, pass: false, error: error.stack || String(error) }); process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`)
  } finally { await Promise.all(contexts.map(context => context.close())); await driver.close() }
}
async function home(page) { await page.goto(baseURL); await page.getByTestId('create-canvas').waitFor() }
function shapes(page) { return page.locator('g[data-element-id][data-element-type="shape"]') }
async function drawRectangle(page, x = .2, y = .25) {
  await page.getByTestId('tool-rectangle').click()
  const box = await page.getByTestId('canvas-stage').boundingBox(); assert.ok(box && box.width > 100)
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y); await page.mouse.down()
  await page.mouse.move(box.x + box.width * (x + .18), box.y + box.height * (y + .13), { steps: 8 }); await page.mouse.up()
}
async function editShape(page, index, text) {
  await page.getByTestId('tool-select').click(); await shapes(page).nth(index).dblclick()
  await page.locator('.inline-text-editor').fill(text); await page.locator('.inline-text-editor').press('Control+Enter')
  await expect(shapes(page).nth(index)).toContainText(text)
}
async function download(page, trigger) {
  const pending = page.waitForEvent('download'); await trigger(); const item = await pending
  assert.equal(await item.failure(), null)
  return { name: item.suggestedFilename(), bytes: await fs.readFile(await item.path()) }
}
async function desktopFile(page, transport, trigger) {
  const count = transport.files.length; await trigger()
  await expect.poll(() => transport.files.length).toBe(count + 1)
  return transport.files.at(-1)
}
async function assertFits(page, locator) {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)
  assert.ok(overflow <= 1, `Page overflowed ${overflow}px`)
  if (locator) { const box = await locator.boundingBox(), view = page.viewportSize(); assert.ok(box && box.x >= 0 && box.x + box.width <= view.width + 1 && box.y >= 0 && box.y + box.height <= view.height + 1, `Panel outside viewport: ${JSON.stringify(box)}`) }
}
function lanURL(status) {
  const address = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address
  assert.ok(address, 'A non-loopback interface is required for plain HTTP sharing acceptance')
  const url = new URL(status.localUrl || status.urls[0]); url.hostname = address; return url.href
}
function credentials(url) { const parsed = new URL(url); return { endpoint: `${parsed.origin}/api/document`, token: parsed.hash.replace(/^#\/share\//, '') } }
async function openServer(page) { if (!await page.getByTestId('server-dialog').isVisible()) await page.getByTestId('server-toggle').click(); await expect(page.getByTestId('server-dialog')).toBeVisible() }
async function closeServer(page) { if (await page.getByTestId('server-dialog').isVisible()) await page.getByTestId('server-close').click() }
async function startShared(fixture, kind = 'flow', options = {}) {
  const desktop = await fixture.page({ desktop: true, ...options }); await home(desktop.page)
  await desktop.page.getByTestId(kind === 'mermaid' ? 'create-diagram' : 'create-canvas').click()
  if (kind === 'mermaid') { await desktop.page.getByTestId('diagram-source').fill(source); await expect(desktop.page.getByTestId('diagram-export-image')).toBeEnabled() }
  await openServer(desktop.page)
  await expect.poll(async () => (await fixture.driver.invoke('document_server_status')).running).toBe(true)
  const status = await fixture.driver.invoke('document_server_status')
  await expect(desktop.page.getByRole('textbox', { name: '本机地址', exact: true })).toHaveValue(status.localUrl)
  assert.ok(status.urls.some(url => url === lanURL(status)), 'The desktop displays the working LAN address')
  await closeServer(desktop.page)
  return { ...desktop, status, url: lanURL(status), snapshot: () => fixture.driver.invoke('read_shared_document', { sessionId: status.sessionId }) }
}
async function peer(fixture, session, options = {}) {
  const result = await fixture.page(options); await result.page.goto(session.url)
  await expect(result.page.getByTestId('shared-workspace')).toBeVisible(); await expect(result.page.getByTestId('server-toggle')).toBeVisible()
  assert.equal(await result.page.evaluate(() => isSecureContext), false, 'The shared document works over actual plain LAN HTTP')
  const assets = await result.page.evaluate(() => ({ headerLayout: getComputedStyle(document.querySelector('.shared-header')).display, footerLayout: getComputedStyle(document.querySelector('.shared-footer')).display, styles: [...document.styleSheets].map(sheet => sheet.href), loaded: performance.getEntriesByType('resource').map(entry => entry.name) }))
  assert.equal(assets.headerLayout, 'flex', 'The shared workspace stylesheet is active in a production build')
  assert.equal(assets.footerLayout, 'flex', 'The connection status footer uses the shared layout too')
  assert.ok(assets.styles.some(url => /\/SharedWorkspace-[^/]+\.css$/.test(url)), 'The shared entry loads its own layout styles')
  assert.ok(!assets.loaded.some(url => /\/App-[^/]+\.js$/.test(url)), 'Shared links do not preload the local workspace')
  return result
}
async function imageFile(page, format, transport) {
  await page.getByTestId('diagram-export-image').click()
  const trigger = () => page.getByTestId(`diagram-export-${format}`).click()
  return transport ? desktopFile(page, transport, trigger) : download(page, trigger)
}
function assertImage(file, format, label) {
  assert.match(file.name, new RegExp(`\\.${format}$`))
  if (format === 'png') { assert.deepEqual([...file.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(file.bytes.length > 1000) }
  else { const svg = file.bytes.toString('utf8'); assert.match(svg, /<svg\b/); assert.ok(svg.includes(label), 'The image contains the latest edited label'); assert.doesNotMatch(svg, /NaN|Infinity|diagram-source-overlay|data-source-element-id/) }
}
async function main() {
  await fs.mkdir(output, { recursive: true }); await ensurePreview(); await prepareDriver()
  const executablePath = process.env.CHROMIUM_EXECUTABLE || (await exists('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] })

  await test('server-toolbar-autosave-position-and-explicit-image-export', async fixture => {
    const { page } = await fixture.page(); await home(page); await page.getByTestId('create-diagram').click()
    const adjacent = await page.getByTestId('autosave-toggle').evaluate(button => ({ previous: button.previousElementSibling?.getAttribute('title'), parent: button.parentElement?.className }))
    assert.equal(adjacent.previous, '保存 (Ctrl+S)'); assert.equal(adjacent.parent, 'file-actions')
    const server = await page.getByTestId('server-toggle').boundingBox(), sourceTools = await page.getByTestId('diagram-template-toggle').boundingBox()
    assert.ok(server.x < sourceTools.x, 'Server precedes the diagram tools')
    await page.getByTestId('autosave-toggle').click(); await expect(page.getByTestId('autosave-toggle')).toHaveAttribute('aria-checked', 'false')
    assert.equal(await page.evaluate(() => localStorage.getItem('ow-autosave')), 'false')
    await page.getByTestId('autosave-toggle').click(); await expect(page.getByTestId('autosave-toggle')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('diagram-source').fill(source); await expect(page.getByTestId('diagram-export-image')).toBeEnabled()
    assertImage(await imageFile(page, 'svg'), 'svg', '复核完成'); assertImage(await imageFile(page, 'png'), 'png')
    await page.getByTestId('diagram-export-image').click(); await page.keyboard.press('Escape'); await expect(page.getByTestId('diagram-export-image')).toBeFocused()
    await page.getByTestId('diagram-source').fill('unknown invalid diagram'); await expect(page.getByTestId('diagram-error')).toBeVisible(); await expect(page.getByTestId('diagram-export-image')).toBeDisabled()
    await openServer(page); await expect(page.getByTestId('server-dialog')).toContainText('浏览器无法监听'); await expect(page.getByTestId('server-start')).toHaveCount(0)
  })

  await test('server-lan-canvas-two-client-edits-return-to-desktop', async fixture => {
    const session = await startShared(fixture), first = await peer(fixture, session), second = await peer(fixture, session)
    await drawRectangle(first.page); await editShape(first.page, 0, '网页绘制的节点')
    await expect.poll(async () => (await session.snapshot()).document.scene.elements[0]?.text).toBe('网页绘制的节点')
    await expect(first.page.getByTestId('shared-status')).toHaveAttribute('data-phase', 'synced')
    await expect(shapes(session.page)).toHaveCount(1); await expect(shapes(session.page)).toContainText('网页绘制的节点')
    await expect(shapes(second.page)).toHaveCount(1); await expect(shapes(second.page)).toContainText('网页绘制的节点')
    await editShape(session.page, 0, '桌面复核已同步')
    await expect(shapes(first.page)).toContainText('桌面复核已同步'); await expect(shapes(second.page)).toContainText('桌面复核已同步')
    await drawRectangle(second.page, .55, .5)
    await expect.poll(async () => (await session.snapshot()).document.scene.elements.length).toBe(2)
    await expect(shapes(session.page)).toHaveCount(2); await expect(shapes(first.page)).toHaveCount(2)
    const file = await desktopFile(session.page, session.transport, () => session.page.getByTitle('保存 (Ctrl+S)', { exact: true }).click())
    assert.deepEqual(JSON.parse(file.bytes).scene, (await session.snapshot()).document.scene, 'The desktop saves the same scene edited by both web clients')
    assert.ok(session.transport.calls.some(call => call.command === 'read_shared_document'), 'The desktop polls the real native service')
  })

  await test('server-code-source-style-and-image-exports-synchronize', async fixture => {
    const session = await startShared(fixture, 'mermaid'), first = await peer(fixture, session), second = await peer(fixture, session)
    const updated = source.replace('复核完成', '网页新增终点')
    await first.page.getByTestId('diagram-source').fill(updated)
    await expect.poll(async () => (await session.snapshot()).document.source).toBe(updated)
    await expect(session.page.getByTestId('diagram-source')).toHaveValue(updated); await expect(second.page.getByTestId('diagram-source')).toHaveValue(updated)
    await session.page.getByTestId('diagram-source').fill(updated.replace('共享需求', '桌面提出需求'))
    await expect(second.page.getByTestId('diagram-source')).toHaveValue(updated.replace('共享需求', '桌面提出需求'))
    await second.page.getByTestId('diagram-style-toggle').click(); await second.page.locator('[data-diagram-style="ocean"]').click()
    await expect.poll(async () => (await session.snapshot()).document.diagramStyle).toBe('ocean')
    await expect(session.page.getByTestId('diagram-style-toggle')).toHaveAttribute('aria-label', /海洋/)
    await expect(first.page.getByTestId('diagram-export-image')).toBeEnabled()
    assertImage(await imageFile(first.page, 'svg'), 'svg', '桌面提出需求'); assertImage(await imageFile(first.page, 'png'), 'png')
    assertImage(await imageFile(session.page, 'svg', session.transport), 'svg', '网页新增终点')
    const file = await desktopFile(session.page, session.transport, () => session.page.getByTitle('保存 (Ctrl+S)', { exact: true }).click())
    assert.equal(JSON.parse(file.bytes).source, (await session.snapshot()).document.source)
  })

  for (const choice of ['remote', 'local']) await test(`server-lan-cas-conflict-preserves-backup-and-resolves-${choice}`, async fixture => {
    const session = await startShared(fixture, 'mermaid'), first = await peer(fixture, session), second = await peer(fixture, session)
    const local = source.replace('复核完成', '第二位编辑者保留的修改'), remote = source.replace('复核完成', '第一位编辑者已提交')
    let release, captured
    const held = new Promise(resolve => { captured = resolve }), gate = new Promise(resolve => { release = resolve })
    await second.page.route('**/api/document', async route => {
      if (route.request().method() !== 'PUT') return route.continue()
      captured(route.request().postDataJSON()); await gate; await route.continue()
    })
    await second.page.getByTestId('diagram-source').fill(local)
    const stale = await Promise.race([held, new Promise((_, reject) => setTimeout(() => reject(Error('No pending real write to delay')), 10000))])
    assert.equal(stale.document.source, local)
    await first.page.getByTestId('diagram-source').fill(remote)
    await expect.poll(async () => (await session.snapshot()).document.source).toBe(remote)
    const conflictResponse = second.page.waitForResponse(response => response.url().endsWith('/api/document') && response.request().method() === 'PUT' && response.status() === 409)
    release(); await conflictResponse
    await expect(second.page.getByTestId('server-conflict')).toBeVisible(); await expect(second.page.getByTestId('diagram-source')).toHaveValue(local)
    assert.equal((await session.snapshot()).document.source, remote, 'A stale write never overwrites the accepted document')
    await closeServer(second.page)
    const backup = await download(second.page, () => second.page.getByTestId('shared-backup').click())
    assert.equal(JSON.parse(backup.bytes).source, local, 'The unaccepted version remains exportable as a native backup')
    await openServer(second.page); await second.page.getByTestId(`server-conflict-${choice}`).click(); await expect(second.page.getByTestId('server-conflict')).toHaveCount(0); await closeServer(second.page)
    const chosen = choice === 'remote' ? remote : local
    await expect(second.page.getByTestId('diagram-source')).toHaveValue(chosen)
    await expect.poll(async () => (await session.snapshot()).document.source).toBe(chosen)
    await expect(session.page.getByTestId('diagram-source')).toHaveValue(chosen); await expect(first.page.getByTestId('diagram-source')).toHaveValue(chosen)
    await second.page.unroute('**/api/document')
  })

  await test('server-unfinished-canvas-text-survives-incoming-edit', async fixture => {
    const session = await startShared(fixture)
    await drawRectangle(session.page); await editShape(session.page, 0, '共同起点')
    await expect.poll(async () => (await session.snapshot()).document.scene.elements[0]?.text).toBe('共同起点')
    const first = await peer(fixture, session)
    await first.page.getByTestId('tool-select').click(); await shapes(first.page).first().dblclick(); await first.page.locator('.inline-text-editor').fill('正在输入但尚未提交')
    await editShape(session.page, 0, '桌面更新已经到达')
    await expect(first.page.getByTestId('shared-status')).toHaveAttribute('data-phase', 'waiting')
    await expect(first.page.locator('.inline-text-editor')).toHaveValue('正在输入但尚未提交')
    await first.page.locator('.inline-text-editor').press('Control+Enter')
    await expect(first.page.getByTestId('server-conflict')).toBeVisible(); await expect(shapes(first.page)).toContainText('正在输入但尚未提交')
    assert.equal((await session.snapshot()).document.scene.elements[0].text, '桌面更新已经到达')
    await first.page.getByTestId('server-conflict-local').click(); await expect(first.page.getByTestId('server-conflict')).toHaveCount(0); await closeServer(first.page)
    await expect(shapes(session.page)).toContainText('正在输入但尚未提交')
  })

  await test('server-stop-retains-browser-copy-and-restart-invalidates-old-token', async fixture => {
    const session = await startShared(fixture, 'mermaid'), first = await peer(fixture, session)
    await openServer(session.page); await session.page.getByTestId('server-stop').click()
    await expect.poll(async () => (await fixture.driver.invoke('document_server_status')).running).toBe(false)
    await expect(first.page.getByTestId('shared-status')).toHaveAttribute('data-phase', /offline|stopped/)
    const unsent = source.replace('共享需求', '断开后仍可保存的想法')
    await first.page.getByTestId('diagram-source').fill(unsent)
    const backup = await download(first.page, () => first.page.getByTestId('shared-backup').click())
    assert.equal(JSON.parse(backup.bytes).source, unsent)
    await assert.rejects(() => session.snapshot(), 'Stopped sessions are unavailable through the desktop service too')
    await session.page.getByTestId('server-start').click()
    await expect.poll(async () => (await fixture.driver.invoke('document_server_status')).running).toBe(true)
    const fresh = await fixture.driver.invoke('document_server_status')
    assert.notEqual(fresh.sessionId, session.status.sessionId); assert.notEqual(credentials(fresh.localUrl).token, credentials(session.url).token)
    const wrong = await fetch(credentials(fresh.localUrl).endpoint, { headers: { Authorization: `Bearer ${credentials(session.url).token}` } })
    assert.equal(wrong.status, 401, 'Restarted sessions reject previously issued links')
    await expect(first.page.getByTestId('diagram-source')).toHaveValue(unsent)
    const freshPeer = await peer(fixture, { status: fresh, url: lanURL(fresh) })
    await expect(freshPeer.page.getByTestId('diagram-source')).toHaveValue(source)
  })

  await test('server-document-switch-revokes-prior-share-and-closing-stops-service', async fixture => {
    const session = await startShared(fixture, 'mermaid'), first = await peer(fixture, session)
    await session.page.locator('.tab-home').click(); await session.page.getByTestId('create-canvas').click(); await openServer(session.page)
    await expect(session.page.getByTestId('server-start')).toContainText('改为共享当前文档')
    assert.equal((await fixture.driver.invoke('document_server_status')).documentId, session.status.documentId, 'Changing tabs does not silently change the shared document')
    await session.page.getByTestId('server-start').click()
    await expect.poll(async () => { const status = await fixture.driver.invoke('document_server_status'); return status.running && Boolean(status.documentId) && status.documentId !== session.status.documentId }).toBe(true)
    const fresh = await fixture.driver.invoke('document_server_status'); await closeServer(session.page)
    await expect(first.page.getByTestId('shared-status')).toHaveAttribute('data-phase', /offline|stopped/); await expect(first.page.getByTestId('diagram-source')).toHaveValue(source)
    const second = await peer(fixture, { status: fresh, url: lanURL(fresh) }); await expect(second.page.getByTestId('canvas-stage')).toBeVisible(); await expect(shapes(second.page)).toHaveCount(0)
    await drawRectangle(second.page); await expect(shapes(session.page)).toHaveCount(1)
    await desktopFile(session.page, session.transport, () => session.page.getByTitle('保存 (Ctrl+S)', { exact: true }).click())
    await session.page.locator('.tab-wrap.active .tab-close').click()
    await expect.poll(async () => (await fixture.driver.invoke('document_server_status')).running).toBe(false)
    await expect(second.page.getByTestId('shared-status')).toHaveAttribute('data-phase', /offline|stopped/)
    await expect(session.page.getByTestId('diagram-source')).toHaveValue(source)
  })

  await test('server-real-http-authorization-and-rejected-writes-do-not-change-document', async fixture => {
    const session = await startShared(fixture, 'mermaid'), { endpoint, token } = credentials(session.url), before = await session.snapshot()
    assert.equal((await fetch(endpoint)).status, 401)
    const origin = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, Origin: 'http://invalid.local' } })
    assert.equal(origin.status, 403)
    const invalid = { sessionId: before.sessionId, baseRevision: before.revision, document: { ...before.document, id: 'different-document' } }
    const rejected = await fetch(endpoint, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(invalid) })
    assert.ok(rejected.status >= 400 && rejected.status < 500)
    assert.deepEqual(await session.snapshot(), before, 'Rejected writes preserve the exact accepted revision and document')
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), before)
    const page = await fetch(new URL(session.url).origin); assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/)
  })

  await test('server-mobile-clipboard-fallback-and-image-menu-fit', async fixture => {
    const deniedClipboard = () => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('Clipboard unavailable') } } })
      document.execCommand = () => false
    }
    const session = await startShared(fixture, 'mermaid', { width: 320, height: 740, init: deniedClipboard })
    await assertFits(session.page); await openServer(session.page); await assertFits(session.page, session.page.getByTestId('server-dialog'))
    await session.page.getByTestId('server-copy-url').first().click(); await expect(session.page.getByTestId('server-copy-status')).toContainText('链接已选中')
    const selected = await session.page.getByLabel('局域网地址 1', { exact: true }).evaluate(input => ({ value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input }))
    assert.ok(selected.focused); assert.equal(selected.start, 0); assert.equal(selected.end, selected.value.length)
    await session.page.keyboard.press('Escape'); await expect(session.page.getByTestId('server-toggle')).toBeFocused()
    const first = await peer(fixture, session, { width: 320, height: 740, init: deniedClipboard })
    await assertFits(first.page); await openServer(first.page); await assertFits(first.page, first.page.getByTestId('server-dialog'))
    await expect(first.page.getByTestId('server-start')).toHaveCount(0); await expect(first.page.getByTestId('server-stop')).toHaveCount(0)
    await first.page.getByTestId('server-copy-url').click(); await expect(first.page.getByTestId('server-copy-status')).toContainText('链接已选中'); await closeServer(first.page)
    await first.page.getByTestId('diagram-export-image').click(); await assertFits(first.page, first.page.getByTestId('diagram-export-menu')); await first.page.keyboard.press('Escape')
    assertImage(await imageFile(first.page, 'svg'), 'svg', '共享需求')
  })

  await fs.writeFile(path.join(output, 'results-document-server.json'), JSON.stringify({ results }, null, 2))
  assert.ok(results.length, 'No matching document service acceptance cases')
  assert.ok(results.every(result => result.pass), `${results.filter(result => !result.pass).length} document service cases failed; see ${output}`)
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 }).finally(async () => { if (browser) await browser.close(); if (preview) preview.kill('SIGTERM') })
