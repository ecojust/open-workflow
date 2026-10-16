const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium, expect } = require('@playwright/test')

async function main() {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
  await server.listen()
  const baseURL = `http://127.0.0.1:${server.httpServer.address().port}`
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox', '--no-proxy-server'] })
  const errors = []
  async function fixture({ count = 2, kind = 'mermaid', autoSave = true, saveAnswers = [], closeError = false, holdSave = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
    await context.addInitScript(options => {
      const callbacks = new Map(), state = { calls: [], saves: [], saveAnswers: [...options.saveAnswers], closeError: options.closeError, holdSave: options.holdSave, releaseSave: undefined, closeHandler: undefined }
      let next = 0
      window.__closeTest = state
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
      window.__TAURI_INTERNALS__ = {
        transformCallback: callback => { callbacks.set(++next, callback); return next },
        unregisterCallback: id => callbacks.delete(id),
        invoke: async (command, args) => {
          state.calls.push({ command, args })
          if (command === 'plugin:event|listen') { if (args.event === 'native-close-requested') state.closeHandler = callbacks.get(args.handler); return 1 }
          if (command === 'plugin:event|unlisten') return null
          if (command === 'close_native_window') { if (state.closeError) throw Error('关闭失败验证'); return null }
          if (command === 'save_native_file') {
            if (state.holdSave) { state.holdSave = false; await new Promise(resolve => { state.releaseSave = resolve }) }
            const answer = state.saveAnswers.shift()
            if (answer === 'cancel') return null
            if (answer === 'error') throw Error('写入失败验证')
            const document = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(args.request.bytesBase64), char => char.charCodeAt(0))))
            state.saves.push(document)
            return { name: args.request.suggestedName, path: `/fixture/${document.id}.owflow`, stamp: `save-${state.saves.length}` }
          }
          if (command === 'start_document_server') {
            state.snapshot = { sessionId: 'close-test-session', revision: 1, document: args.document }
            return { status: { running: true, sessionId: state.snapshot.sessionId, documentId: args.document.id, title: args.document.title, urls: ['http://127.0.0.1:40000/#/share/test'], localUrl: 'http://127.0.0.1:40000/#/share/test' }, snapshot: state.snapshot }
          }
          if (command === 'read_shared_document') return state.snapshot
          if (command === 'update_shared_document') { state.snapshot = { ...state.snapshot, revision: state.snapshot.revision + 1, document: args.document }; return { accepted: true, snapshot: state.snapshot } }
          if (command === 'stop_document_server') return { ...state.snapshot, revision: state.snapshot.revision + 1, document: { ...state.snapshot.document, title: '网页最后修改', source: 'flowchart LR\n  A[最终网页修改] --> B[已保留]' } }
          throw Error(`未预期命令：${command}`)
        },
      }
    }, { saveAnswers, closeError, holdSave })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(baseURL)
    await page.getByTestId('create-canvas').waitFor()
    await page.evaluate(async ({ count, kind, autoSave }) => {
      const { createDocument } = await import('/src/core/documents.ts')
      const { putDraft } = await import('/src/core/storage.ts')
      const ids = []
      for (let index = 0; index < count; index++) {
        const document = createDocument(kind, kind === 'flow'); document.title = `文档 ${index + 1}`
        document.source = `flowchart LR\n  A[文档 ${index + 1}] --> B[完成]`
        ids.push(document.id)
        await putDraft({ id: document.id, document, savedKey: null, lastOpened: Date.now() + index })
      }
      localStorage.setItem('ow-session', JSON.stringify({ ids, activeId: ids[0], home: !ids.length }))
      localStorage.setItem('ow-autosave', String(autoSave))
    }, { count, kind, autoSave })
    await page.reload()
    await page.waitForFunction(() => typeof window.__closeTest.closeHandler === 'function')
    if (count) await expect(page.getByRole('tab')).toHaveCount(count)
    return { page, context }
  }
  const close = page => page.evaluate(() => window.__closeTest.closeHandler({ event: 'native-close-requested', payload: null }))
  const nativeCloseCount = page => page.evaluate(() => window.__closeTest.calls.filter(call => call.command === 'close_native_window').length)
  const drafts = page => page.evaluate(async () => (await (await import('/src/core/storage.ts')).readDrafts()).records)
  try {
    {
      const { page, context } = await fixture({ count: 0 })
      await expect(page.getByRole('group', { name: '界面主题', exact: true }).getByRole('button')).toHaveCount(3)
      const boxes = await page.getByRole('group', { name: '界面主题', exact: true }).getByRole('button').evaluateAll(buttons => buttons.map(button => ({ x: button.getBoundingClientRect().x, y: button.getBoundingClientRect().y, svg: button.querySelectorAll('svg').length })))
      assert.ok(boxes.every(box => box.svg === 1 && box.y === boxes[0].y)); assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x)
      await page.getByTestId('theme-dark').click(); await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark')
      await page.reload(); await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
      await page.getByTestId('theme-system').click(); await page.emulateMedia({ colorScheme: 'dark' }); await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark')
      await page.emulateMedia({ colorScheme: 'light' }); await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'light')
      await page.getByRole('button', { name: '关于 Open Workflow', exact: true }).click()
      const info = page.getByRole('dialog', { name: '关于 Open Workflow' })
      await expect(info.locator('dl')).toContainText(require('../../package.json').version)
      await expect(info.locator('dl')).toContainText('构建时间开发模式，尚未构建')
      assert.ok(Number.isFinite(Date.parse(await info.locator('time').getAttribute('datetime'))))
      await page.keyboard.press('Escape'); await expect(info).toHaveCount(0); await expect(page.getByRole('button', { name: '关于 Open Workflow', exact: true })).toBeFocused()
      await page.getByRole('button', { name: '使用帮助', exact: true }).click(); await expect(page.getByRole('dialog', { name: '开始创作' })).toBeVisible(); await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 320, height: 720 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      await context.close(); console.log('PASS 顶部主题平铺、持久化、跟随系统、版本与开发时间、帮助及窄屏')
    }
    {
      const { page, context } = await fixture()
      await close(page)
      const dialog = page.getByRole('dialog', { name: '关闭全部文档？' })
      await expect(dialog.locator('li')).toHaveText(['文档 1', '文档 2'])
      await expect(dialog).toContainText('有 2 份文档尚未保存到文件')
      await dialog.getByRole('button', { name: '取消', exact: true }).focus()
      await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: '保存并全部关闭', exact: true })).toBeFocused()
      await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: '关闭对话框', exact: true })).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: '保存并全部关闭', exact: true })).toBeFocused()
      await close(page); await expect(page.getByRole('dialog')).toHaveCount(1)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(page.locator('.operation-overlay')).toHaveCount(0)
      assert.equal(await nativeCloseCount(page), 0); assert.equal((await drafts(page)).length, 2)
      await close(page); await page.getByRole('button', { name: '保存并全部关闭', exact: true }).click()
      await expect.poll(() => nativeCloseCount(page)).toBe(1)
      assert.deepEqual(await page.evaluate(() => window.__closeTest.saves.map(document => document.title)), ['文档 1', '文档 2'])
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await context.close(); console.log('PASS 多文档一次确认、重复关闭防护、取消保留、全部保存后退出')
    }
    for (const answer of ['cancel', 'error']) {
      const { page, context } = await fixture({ saveAnswers: ['ok', answer] })
      await close(page); await page.getByRole('button', { name: '保存并全部关闭', exact: true }).click()
      await expect(page.locator('.operation-overlay')).toHaveCount(0)
      assert.equal(await nativeCloseCount(page), 0)
      await expect(page.getByRole('tab')).toHaveCount(2)
      assert.equal((await drafts(page)).length, 2)
      await close(page); await expect(page.getByRole('dialog').locator('li')).toHaveText(['文档 2'])
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await context.close(); console.log(`PASS 批量保存${answer === 'cancel' ? '取消' : '失败'}保留全部文档，已保存文档不重复询问`)
    }
    {
      const { page, context } = await fixture({ autoSave: false, closeError: true })
      await close(page); await page.getByRole('button', { name: '全部关闭', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('关闭失败验证')
      await expect(page.locator('.operation-overlay')).toHaveCount(0)
      await expect(page.getByRole('tab')).toHaveCount(2)
      assert.equal((await drafts(page)).length, 2, '自动保存关闭时，退出失败仍应恢复被移除的草稿')
      await page.evaluate(() => { window.__closeTest.closeError = false })
      await close(page); await page.getByRole('button', { name: '全部关闭', exact: true }).click()
      await expect.poll(() => nativeCloseCount(page)).toBe(2)
      assert.equal((await drafts(page)).length, 0)
      await context.close(); console.log('PASS 全部关闭明确放弃草稿，原生退出失败恢复草稿且允许重试')
    }
    {
      const { page, context } = await fixture({ holdSave: true })
      await page.getByTitle('保存 (Ctrl+S)', { exact: true }).click()
      await page.waitForFunction(() => typeof window.__closeTest.releaseSave === 'function')
      await close(page); await expect(page.locator('.operation-overlay')).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.evaluate(() => window.__closeTest.releaseSave())
      await expect(page.getByRole('dialog').locator('li')).toHaveText(['文档 2'])
      await page.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(await nativeCloseCount(page), 0)
      await context.close(); console.log('PASS 关闭等待进行中的文件保存，确认只列出剩余未保存文档')
    }
    {
      const { page, context } = await fixture({ kind: 'flow', holdSave: true })
      const shapes = page.locator('g[data-element-id][data-element-type="shape"]')
      const before = await shapes.count(); assert.ok(before > 0)
      await shapes.first().click()
      await page.keyboard.press('Control+s')
      await page.waitForFunction(() => typeof window.__closeTest.releaseSave === 'function')
      await close(page); await expect(page.locator('.editor-layout')).toHaveAttribute('inert', '')
      await page.getByTestId('canvas-stage').evaluate(stage => stage.focus())
      await expect(page.getByTestId('canvas-stage')).not.toBeFocused()
      await page.keyboard.press('Delete'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Control+d')
      await expect(shapes).toHaveCount(before)
      await page.evaluate(() => window.__closeTest.releaseSave())
      await expect(page.getByRole('dialog').locator('li')).toHaveText(['文档 2'])
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(page.locator('.editor-layout')).not.toHaveAttribute('inert', '')
      const same = await page.evaluate(async () => {
        const { readDrafts } = await import('/src/core/storage.ts')
        const { contentKey } = await import('/src/core/documents.ts')
        const saved = window.__closeTest.saves[0]
        return contentKey((await readDrafts()).records.find(item => item.id === saved.id).document) === contentKey(saved)
      })
      assert.equal(same, true)
      await context.close(); console.log('PASS 等待关闭时画布不可聚焦，删除、移动和复制快捷键不能修改文档')
    }
    {
      const { page, context } = await fixture({ count: 1 })
      await page.getByTestId('diagram-source').fill('flowchart LR\n  A[关闭前最后输入] --> B[保留]')
      await close(page); await page.getByRole('button', { name: '保存并全部关闭', exact: true }).click()
      await expect.poll(() => nativeCloseCount(page)).toBe(1)
      assert.match(await page.evaluate(() => window.__closeTest.saves[0].source), /关闭前最后输入/)
      await context.close(); console.log('PASS 关闭前刷新编辑器尚未提交的文本')
    }
    {
      const { page, context } = await fixture({ count: 1 })
      await page.getByTitle('保存 (Ctrl+S)', { exact: true }).click()
      await expect(page.locator('.tab-wrap .dirty-dot')).toHaveCount(0)
      await page.getByTestId('server-toggle').click()
      await expect.poll(() => page.evaluate(() => window.__closeTest.calls.some(call => call.command === 'start_document_server'))).toBe(true)
      await page.getByTestId('server-close').click()
      await close(page)
      await expect(page.getByRole('dialog').locator('li')).toHaveText(['网页最后修改'])
      await page.getByRole('button', { name: '保存并全部关闭', exact: true }).click()
      await expect.poll(() => nativeCloseCount(page)).toBe(1)
      const saved = await page.evaluate(() => window.__closeTest.saves.at(-1))
      assert.equal(saved.title, '网页最后修改'); assert.match(saved.source, /最终网页修改/)
      await context.close(); console.log('PASS 共享服务停止后的最后网页修改加入统一确认并保存')
    }
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
