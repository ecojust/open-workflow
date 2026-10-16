import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ref, computed, markRaw, nextTick } from 'vue'
import { clone, newId } from '../src/core/types.ts'
import { contentKey, createDocument, DocumentHistory, MAX_FILE_BYTES, validateDocument } from '../src/core/documents.ts'
import { documentBytes, safeFilename } from '../src/core/files.ts'
import { SharedDocumentSync } from '../src/core/share-sync.ts'
import { sharedContentKey, sharedDocument, validateSharedSnapshot } from '../src/core/sharing.ts'

// Execute the real setup code. Only browser/native IO and mounted child editors are
// substituted; lifecycle functions are neither copied nor reimplemented here.
const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(source, 'App.vue must expose its real setup script to this regression harness')
const script = ts.transpileModule(source.replace(/^import[^\n]*\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const exposed = 'tabs,activeId,home,recent,busy,modal,editor,toast,addDocument,activate,save,closeTab,nativeClose,unload,pageHide,persist,commit,dirty,historyAction,finishModal,openRecent,autoSaveEnabled,setAutoSave,startSharing,stopSharing,retrySharing,serverStatus,serverSyncState'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settleUntil(predicate, description = 'expected asynchronous state') {
  for (let turn = 0; turn < 60; turn++) { if (predicate()) return; await Promise.resolve() }
  assert.ok(predicate(), description)
}
function harness(options = {}) {
  const records = new Map((options.records || []).map(record => [record.id, clone(record)]))
  const local = new Map(Object.entries(options.local || {}))
  const timers = new Map(), timerDelays = new Map(), mounted = [], deleted = [], saved = [], downloads = []
  let timerId = 0, closed = 0
  let serverSnapshot
  const serverStops = []
  const fakeWindow = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
  const environment = {
    ref, computed, markRaw, nextTick, clone, newId, contentKey, createDocument, DocumentHistory, MAX_FILE_BYTES, validateDocument, documentBytes, safeFilename,
    SharedDocumentSync, sharedContentKey, sharedDocument, validateSharedSnapshot,
    onMounted: callback => mounted.push(callback), onBeforeUnmount: () => {},
    window: fakeWindow, document: { activeElement: null },
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) },
    setTimeout: (callback, delay) => { timers.set(++timerId, callback); timerDelays.set(timerId, delay); return timerId }, clearTimeout: id => { timers.delete(id); timerDelays.delete(id) },
    isDesktop: () => Boolean(options.desktop),
    putDraft: async record => { if (options.beforePut) await options.beforePut(record); records.set(record.id, clone(record)) },
    readDrafts: async () => ({ records: [...records.values()].map(clone), skipped: 0 }),
    deleteDraft: async id => { deleted.push(id); records.delete(id) },
    closeNativeWindow: async () => { closed++ },
    onNativeCloseRequest: async () => () => {},
    saveNativeFile: async request => { saved.push(request); return options.nativeSave ? options.nativeSave(request) : { name: request.suggestedName, path: '/test/file.owflow', stamp: 'new-stamp' } },
    downloadBytes: (...args) => downloads.push(args),
    startDocumentServer: async document => {
      if (options.serverStart) return options.serverStart(document)
      serverSnapshot = { sessionId: 'test-session', revision: 1, document: sharedDocument(document) }
      return { status: { running: true, sessionId: serverSnapshot.sessionId, urls: ['http://127.0.0.1:1234/#/share/test'], documentId: document.id, title: document.title }, snapshot: clone(serverSnapshot) }
    },
    readDocumentServer: async () => clone(serverSnapshot),
    writeDocumentServer: async request => {
      if (request.baseRevision !== serverSnapshot.revision) return { accepted: false, snapshot: clone(serverSnapshot) }
      serverSnapshot = { ...serverSnapshot, revision: serverSnapshot.revision + 1, document: sharedDocument(request.document) }
      return { accepted: true, snapshot: clone(serverSnapshot) }
    },
    stopDocumentServer: async sessionId => { serverStops.push(sessionId); return options.serverStop ? options.serverStop(serverSnapshot) : clone(serverSnapshot) },
  }
  const app = Function(...Object.keys(environment), `${script}\nreturn {${exposed}}`)(...Object.values(environment))
  function runTimers(delay = 300) {
    for (const [id, callback] of [...timers]) if (timerDelays.get(id) === delay) {
      timers.delete(id); timerDelays.delete(id); callback()
    }
  }
  return { app, records, local, deleted, saved, downloads, mounted, timers, runTimers, serverStops, serverSnapshot: () => clone(serverSnapshot), closed: () => closed }
}
function record(document, saved = false) { return { id: document.id, document: clone(document), savedKey: saved ? contentKey(document) : null, lastOpened: 100 } }

test('sharing continues to synchronize edits while local draft autosave is disabled', async () => {
  const { app, records, serverSnapshot } = harness({ desktop: true })
  const doc = createDocument('flow'), tab = app.addDocument(doc, contentKey(doc))
  await app.setAutoSave(false); await app.startSharing()
  try {
    app.commit(tab, document => { document.title = '共享中的修改' }, '改名')
    await app.retrySharing()
    assert.equal(serverSnapshot().document.title, '共享中的修改')
    assert.equal(records.size, 0, 'Network synchronization does not silently enable local draft storage')
  } finally { await app.stopSharing() }
})

test('stopping a service incorporates its final accepted remote snapshot and retains local import data', async () => {
  const { app } = harness({ desktop: true, serverStop: async snapshot => ({ ...snapshot, revision: snapshot.revision + 1, document: { ...snapshot.document, title: '停服前最后一次网页修改' } }) })
  const doc = createDocument('flow'); doc.importSource = { name: 'source.xml', format: 'xml', text: '<original/>' }
  const tab = app.addDocument(doc, contentKey(doc))
  await app.startSharing(); await app.stopSharing()
  assert.equal(tab.document.title, '停服前最后一次网页修改')
  assert.deepEqual(tab.document.importSource, doc.importSource)
  assert.equal(tab.history.canUndo, false, 'Remote revisions establish a new undo baseline')
  assert.equal(app.serverStatus.value.running, false)
})

test('a local edit while stop is pending preserves both the local and final remote versions', async () => {
  const pending = deferred(); let final
  const { app } = harness({ desktop: true, serverStop: async snapshot => { final = { ...snapshot, revision: snapshot.revision + 1, document: { ...snapshot.document, title: '最后网页版本' } }; return pending.promise } })
  const doc = createDocument('flow'), tab = app.addDocument(doc, contentKey(doc))
  await app.startSharing()
  const stopping = app.stopSharing()
  await settleUntil(() => final)
  app.commit(tab, document => { document.title = '停服等待时的本地修改' }, '改名')
  pending.resolve(final); await stopping
  assert.equal(tab.document.title, '停服等待时的本地修改')
  assert.equal(app.tabs.value.length, 2)
  assert.equal(app.tabs.value.find(item => item.document.id !== doc.id).document.title, '最后网页版本 · 网页保留副本')
  assert.equal(app.activeId.value, doc.id)
})

test('closing a tab while its service starts immediately stops the orphaned session', async () => {
  const pending = deferred(); let starting = false
  const { app, serverStops } = harness({ desktop: true, serverStart: () => { starting = true; return pending.promise }, serverStop: async () => null })
  const doc = createDocument('flow'), tab = app.addDocument(doc, contentKey(doc))
  const opening = app.startSharing(); await settleUntil(() => starting)
  await app.closeTab(tab)
  pending.resolve({ status: { running: true, sessionId: 'late', urls: [], documentId: doc.id }, snapshot: { sessionId: 'late', revision: 1, document: doc } })
  await opening
  assert.deepEqual(serverStops, ['late'])
  assert.equal(app.tabs.value.length, 0); assert.equal(app.serverStatus.value.running, false)
})

test('closing a shared tab asks to save a final remote edit accepted during shutdown', async () => {
  const { app } = harness({ desktop: true, serverStop: async snapshot => ({ ...snapshot, revision: 2, document: { ...snapshot.document, title: '最后网页修改' } }) })
  const doc = createDocument('flow'), tab = app.addDocument(doc, contentKey(doc))
  await app.startSharing()
  const closing = app.closeTab(tab)
  await settleUntil(() => app.modal.value?.title.includes('最后网页修改'))
  assert.equal(app.tabs.value.length, 1)
  app.finishModal('cancel'); await closing
  assert.equal(tab.document.title, '最后网页修改'); assert.equal(app.tabs.value.length, 1)
  assert.equal(app.serverStatus.value.running, false)
})

test('closing the same clean tab twice cannot close a different document', async () => {
  const { app } = harness()
  const first = createDocument('flow'), second = createDocument('board')
  const tab = app.addDocument(first, contentKey(first)); app.addDocument(second, contentKey(second))
  await Promise.all([app.closeTab(tab), app.closeTab(tab)])
  assert.deepEqual(app.tabs.value.map(item => item.document.id), [second.id])
})

test('canceling aggregate native close preserves every open document and draft', async () => {
  const first = createDocument('flow'), second = createDocument('board')
  const { app, records, deleted, closed, mounted } = harness({
    desktop: true, records: [record(first), record(second)],
    local: { 'ow-session': JSON.stringify({ ids: [first.id, second.id] }) },
  })
  await mounted[0]()
  const work = app.nativeClose()
  await settleUntil(() => app.modal.value?.kind === 'close-all')
  assert.deepEqual(app.modal.value.lines, [first.title, second.title])
  assert.deepEqual(deleted, [], 'No draft is removed before the aggregate choice is confirmed')
  app.finishModal('cancel')
  await work
  assert.deepEqual(app.tabs.value.map(tab => tab.document.id), [first.id, second.id])
  assert.ok(records.has(first.id) && records.has(second.id))
  assert.equal(closed(), 0)
})

test('confirmed aggregate native close removes only dirty drafts and preserves saved documents', async () => {
  const first = createDocument('flow'), second = createDocument('board'), saved = createDocument('flow')
  const { app, records, deleted, closed, mounted } = harness({
    desktop: true, records: [record(first), record(second), record(saved, true)],
    local: { 'ow-session': JSON.stringify({ ids: [first.id, second.id, saved.id] }) },
  })
  await mounted[0]()
  const work = app.nativeClose()
  await settleUntil(() => app.modal.value?.kind === 'close-all')
  assert.deepEqual(app.modal.value.lines, [first.title, second.title])
  assert.equal(deleted.length, 0)
  app.finishModal('discard'); await work
  assert.deepEqual(deleted, [first.id, second.id])
  assert.deepEqual([...records.keys()], [saved.id])
  assert.equal(closed(), 1)
})

test('beforeunload flushes unpublished editor changes before deciding whether to warn', async () => {
  const { app, records } = harness()
  const doc = createDocument('mermaid'), tab = app.addDocument(doc, contentKey(doc))
  tab.draftState = 'saved'
  let flushes = 0, prompts = 0
  app.editor.value = { flush() { flushes++; app.commit(tab, document => { document.source += '\n  extra[尚未发布的修改]' }, '修改源码') } }
  app.unload({ preventDefault() { prompts++ }, returnValue: null })
  assert.equal(flushes, 1)
  assert.equal(prompts, 1)
  await settleUntil(() => records.has(doc.id))
  assert.match(records.get(doc.id).document.source, /尚未发布的修改/)
})

test('saving a snapshot during subsequent edits keeps the newer draft dirty', async () => {
  const pending = deferred()
  const { app, saved, records } = harness({ desktop: true, nativeSave: () => pending.promise })
  const doc = createDocument('flow'), tab = app.addDocument(doc)
  const originalKey = contentKey(doc)
  const work = app.save(tab)
  await settleUntil(() => saved.length === 1)
  app.commit(tab, document => { document.title = '保存期间的新修改' }, '改名')
  pending.resolve({ name: 'first.owflow', path: '/test/first.owflow', stamp: 'saved-version' })
  assert.equal(await work, true)
  assert.equal(tab.savedKey, originalKey)
  assert.equal(app.dirty(tab), true)
  assert.equal(JSON.parse(new TextDecoder().decode(saved[0].bytes)).title, doc.title)
  assert.equal(records.get(doc.id).document.title, '保存期间的新修改')
  assert.equal(records.get(doc.id).savedKey, originalKey)
})

test('native conflict failures preserve saved stamps and keep unsaved changes open', async () => {
  const { app, saved } = harness({ desktop: true, nativeSave: async () => { throw new Error('文件已被其他应用修改') } })
  const doc = createDocument('flow'), key = contentKey(doc)
  const tab = app.addDocument(doc, key, '/test/original.owflow', 'original-stamp')
  app.commit(tab, document => { document.title = '未保存版本' }, '改名')
  assert.equal(await app.save(tab), false)
  assert.equal(saved[0].expectedStamp, 'original-stamp')
  assert.equal(tab.stamp, 'original-stamp')
  assert.equal(tab.savedKey, key)
  assert.equal(app.dirty(tab), true)
  assert.match(app.toast.value.text, /其他应用修改/)
})

test('queued autosaves serialize writes so an older completion cannot replace a newer draft', async () => {
  const gate = deferred()
  let calls = 0
  const { app, records } = harness({ beforePut: () => ++calls === 1 ? gate.promise : undefined })
  const tab = app.addDocument(createDocument('flow'))
  app.commit(tab, document => { document.title = '第一版' }, '修改')
  const first = app.persist(tab)
  await settleUntil(() => calls === 1)
  app.commit(tab, document => { document.title = '第二版' }, '修改')
  const second = app.persist(tab)
  gate.resolve(); await Promise.all([first, second])
  assert.equal(records.get(tab.document.id).document.title, '第二版')
  assert.equal(tab.draftState, 'saved')
  assert.equal(tab.draftRevision, tab.revision)
})

test('importing an existing draft ID creates a separate document while explicit recovery retains identity', () => {
  const doc = createDocument('flow'), item = record(doc)
  const first = harness(); first.app.recent.value = [item]
  const imported = first.app.addDocument(clone(doc))
  assert.notEqual(imported.document.id, doc.id)
  assert.equal(first.app.recent.value[0].document.id, doc.id)
  const second = harness(); second.app.recent.value = [item]
  const recovered = second.app.addDocument(clone(doc), null, undefined, undefined, true)
  assert.equal(recovered.document.id, doc.id)
})

test('restoring a saved workspace preserves IDs, content and the active tab', async () => {
  const first = createDocument('flow'), second = createDocument('mermaid')
  const { app, mounted } = harness({ records: [record(first, true), record(second, true)], local: { 'ow-session': JSON.stringify({ ids: [first.id, second.id], activeId: second.id, home: false }) } })
  for (const mount of mounted) await mount()
  assert.deepEqual(app.tabs.value.map(tab => tab.document.id), [first.id, second.id])
  assert.equal(app.activeId.value, second.id)
  assert.equal(app.home.value, false)
  assert.ok(app.tabs.value.every(tab => !app.dirty(tab)))
})

test('a second save waits for pending draft IO and then saves the latest editor contents', async () => {
  const gate = deferred()
  let writes = 0
  const { app, downloads, records } = harness({ beforePut: () => ++writes === 1 ? gate.promise : undefined })
  const tab = app.addDocument(createDocument('flow'))
  const first = app.save(tab)
  await settleUntil(() => writes === 1)
  assert.equal(downloads.length, 1, 'the first download has started while its draft write is still pending')
  app.editor.value = { flush() { app.commit(tab, document => { document.title = '属性文字的最新编辑' }, '修改文字') } }
  const second = app.save(tab)
  gate.resolve()
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(downloads.length, 2)
  assert.equal(JSON.parse(new TextDecoder().decode(downloads[1][1])).title, '属性文字的最新编辑')
  assert.equal(records.get(tab.document.id).document.title, '属性文字的最新编辑')
  assert.equal(app.dirty(tab), false)
})

test('native saves requested in the same turn run serially and use the previous save stamp', async () => {
  const gate = deferred()
  const { app, saved } = harness({ desktop: true, nativeSave: request => saved.length === 1 ? gate.promise : { name: request.suggestedName, path: '/test/same.owflow', stamp: 'second-stamp' } })
  const tab = app.addDocument(createDocument('flow'))
  const first = app.save(tab), second = app.save(tab)
  await settleUntil(() => saved.length > 0)
  const requestsBeforeCompletion = saved.length
  app.commit(tab, document => { document.title = '第二次保存内容' }, '修改文字')
  gate.resolve({ name: 'same.owflow', path: '/test/same.owflow', stamp: 'first-stamp' })
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(requestsBeforeCompletion, 1, 'only one native dialog/file write may be active')
  assert.equal(saved.length, 2)
  assert.equal(saved[1].path, '/test/same.owflow')
  assert.equal(saved[1].expectedStamp, 'first-stamp')
  assert.equal(JSON.parse(new TextDecoder().decode(saved[1].bytes)).title, '第二次保存内容')
  assert.equal(tab.stamp, 'second-stamp')
  assert.equal(app.dirty(tab), false)
})

for (const outcome of ['cancel', 'failure']) test(`a native save ${outcome} releases the queue for the next requested save`, async () => {
  const gate = deferred()
  const { app, saved } = harness({ desktop: true, nativeSave: request => saved.length === 1 ? gate.promise : { name: request.suggestedName, path: '/test/retry.owflow', stamp: 'retry-stamp' } })
  const tab = app.addDocument(createDocument('flow'))
  const first = app.save(tab)
  await settleUntil(() => saved.length === 1)
  app.commit(tab, document => { document.title = '下一次保存' }, '修改文字')
  const second = app.save(tab)
  if (outcome === 'cancel') gate.resolve(null)
  else gate.reject(new Error('可恢复的保存失败'))
  assert.equal(await first, false)
  assert.equal(await second, true)
  assert.equal(saved.length, 2)
  assert.equal(tab.stamp, 'retry-stamp')
  assert.equal(app.busy.value, '')
  assert.equal(app.dirty(tab), false)
})

test('a queued Save As retains its explicit new-file intent instead of reusing the earlier path', async () => {
  const gate = deferred()
  const { app, saved } = harness({ desktop: true, nativeSave: request => saved.length === 1 ? gate.promise : { name: request.suggestedName, path: '/test/copy.owflow', stamp: 'copy-stamp' } })
  const doc = createDocument('flow'), tab = app.addDocument(doc, contentKey(doc), '/test/original.owflow', 'old-stamp')
  const first = app.save(tab)
  await settleUntil(() => saved.length === 1)
  const second = app.save(tab, true)
  gate.resolve({ name: 'original.owflow', path: '/test/original.owflow', stamp: 'updated-stamp' })
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(saved[1].path, undefined)
  assert.equal(saved[1].expectedStamp, undefined)
  assert.equal(tab.path, '/test/copy.owflow')
})

test('save requests do not take ownership of a different busy operation', async () => {
  const { app, downloads } = harness()
  const tab = app.addDocument(createDocument('flow'))
  app.busy.value = '正在导出…'
  assert.equal(await app.save(tab), false)
  assert.equal(downloads.length, 0)
  assert.equal(app.busy.value, '正在导出…')
})

test('automatic local drafts remain enabled by default without downloading a file', async () => {
  const { app, records, downloads, runTimers } = harness()
  const tab = app.addDocument(createDocument('flow'))
  assert.equal(app.autoSaveEnabled.value, true)
  app.commit(tab, document => { document.title = '默认自动草稿' }, '改名')
  runTimers()
  await settleUntil(() => records.get(tab.document.id)?.document.title === '默认自动草稿')
  assert.equal(downloads.length, 0)
  assert.equal(app.dirty(tab), true, 'A local draft does not mark the document saved to a file')
})

test('disabling automatic drafts cancels pending timers and page lifecycle cannot bypass the preference', async () => {
  const { app, records, local, downloads, runTimers } = harness()
  const tab = app.addDocument(createDocument('flow'))
  app.commit(tab, document => { document.title = '尚未写入的草稿' }, '改名')
  await app.setAutoSave(false)
  assert.equal(local.get('ow-autosave'), 'false')
  app.commit(tab, document => { document.title = '关闭后的修改' }, '改名')
  let warnings = 0
  app.unload({ preventDefault() { warnings++ }, returnValue: null })
  app.pageHide()
  runTimers()
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  assert.equal(records.size, 0)
  assert.equal(downloads.length, 0)
  assert.equal(tab.draftState, 'paused')
  assert.equal(warnings, 1, 'Unsaved-file protection remains active when local drafts are paused')
})

test('disabling automatic drafts skips an automatic write queued behind unfinished IO', async () => {
  const gate = deferred()
  let writes = 0
  const { app, records } = harness({ beforePut: () => ++writes === 1 ? gate.promise : undefined })
  const tab = app.addDocument(createDocument('flow'))
  app.commit(tab, document => { document.title = '已经开始保存' }, '改名')
  const first = app.persist(tab, true)
  await settleUntil(() => writes === 1)
  app.commit(tab, document => { document.title = '排队等待的自动草稿' }, '改名')
  const queued = app.persist(tab, true)
  await app.setAutoSave(false)
  gate.resolve(); await Promise.all([first, queued])
  assert.equal(writes, 1, 'Already-started IO completes, but the queued automatic write never starts')
  assert.equal(records.get(tab.document.id).document.title, '已经开始保存')
  assert.equal(tab.document.title, '排队等待的自动草稿')
  assert.equal(tab.draftState, 'paused')
  assert.ok(tab.draftRevision < tab.revision)
})

test('re-enabling drafts flushes the current editor and persists every open tab without file saves', async () => {
  const { app, records, downloads, saved, runTimers } = harness()
  await app.setAutoSave(false)
  const first = app.addDocument(createDocument('flow')), second = app.addDocument(createDocument('mermaid'))
  app.commit(first, document => { document.title = '后台画布的最新修改' }, '改名')
  let flushes = 0
  app.editor.value = { flush() { flushes++; app.commit(second, document => { document.source = 'flowchart LR\n A[重新开启时提交的文字]' }, '修改源码') } }
  await app.setAutoSave(true)
  runTimers()
  await settleUntil(() => records.size === 2 && app.tabs.value.every(tab => tab.draftRevision === tab.revision))
  assert.ok(flushes >= 1)
  assert.equal(records.get(first.document.id).document.title, '后台画布的最新修改')
  assert.match(records.get(second.document.id).document.source, /重新开启时提交的文字/)
  assert.equal(downloads.length, 0)
  assert.equal(saved.length, 0)
  assert.ok(app.tabs.value.every(tab => tab.draftRevision === tab.revision))
})

test('an off-on cycle cannot revive a stale automatic snapshot that was already queued', async () => {
  const gate = deferred()
  let writes = 0
  const { app, records, runTimers } = harness({ beforePut: () => ++writes === 1 ? gate.promise : undefined })
  const tab = app.addDocument(createDocument('flow'))
  const first = app.persist(tab, true)
  await settleUntil(() => writes === 1)
  app.commit(tab, document => { document.title = '旧开关周期排队的内容' }, '改名')
  const stale = app.persist(tab, true)
  await app.setAutoSave(false)
  app.commit(tab, document => { document.title = '新开关周期的最新内容' }, '改名')
  await app.setAutoSave(true)
  gate.resolve(); await Promise.all([first, stale])
  assert.equal(writes, 1, 'Re-enabling must not allow the old generation of automatic writes to resume')
  runTimers()
  await settleUntil(() => records.get(tab.document.id)?.document.title === '新开关周期的最新内容')
  assert.equal(writes, 2)
})

test('manual saving while automatic drafts are off still saves the latest file and local snapshot', async () => {
  const { app, records, downloads, runTimers } = harness()
  await app.setAutoSave(false)
  const tab = app.addDocument(createDocument('flow'))
  app.editor.value = { flush() { app.commit(tab, document => { document.title = '手动保存最新内容' }, '改名') } }
  assert.equal(await app.save(tab), true)
  assert.equal(downloads.length, 1)
  assert.equal(JSON.parse(new TextDecoder().decode(downloads[0][1])).title, '手动保存最新内容')
  assert.equal(records.get(tab.document.id).document.title, '手动保存最新内容')
  assert.equal(app.dirty(tab), false)
  assert.equal(app.autoSaveEnabled.value, false)
  app.commit(tab, document => { document.title = '下一次尚未手动保存' }, '改名')
  runTimers()
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  assert.equal(records.get(tab.document.id).document.title, '手动保存最新内容')
  assert.equal(app.dirty(tab), true)
})

test('disabled preference is restored before recovering tabs and does not rewrite existing drafts', async () => {
  const doc = createDocument('flow')
  let writes = 0
  const { app, records, mounted, runTimers } = harness({
    beforePut: () => { writes++ }, records: [record(doc, true)],
    local: { 'ow-autosave': 'false', 'ow-session': JSON.stringify({ ids: [doc.id], activeId: doc.id, home: false }) },
  })
  for (const mount of mounted) await mount()
  assert.equal(app.autoSaveEnabled.value, false)
  assert.equal(app.tabs.value.length, 1)
  assert.equal(app.tabs.value[0].draftRevision, app.tabs.value[0].revision)
  runTimers()
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  assert.equal(writes, 0)
  assert.deepEqual(records.get(doc.id).document, doc)
})

test('paused drafts retain unsaved tab-close protection and cancel leaves current edits intact', async () => {
  const { app, records } = harness()
  await app.setAutoSave(false)
  const tab = app.addDocument(createDocument('flow'))
  app.commit(tab, document => { document.title = '关闭前未保存的编辑' }, '改名')
  const closing = app.closeTab(tab)
  await settleUntil(() => app.modal.value?.kind === 'unsaved')
  app.finishModal('cancel'); await closing
  assert.equal(app.tabs.value.length, 1)
  assert.equal(tab.document.title, '关闭前未保存的编辑')
  assert.equal(records.size, 0)
  assert.equal(app.dirty(tab), true)
})

test('closing an unchanged saved tab while drafts are paused does not perform another automatic write', async () => {
  let writes = 0
  const { app, records } = harness({ beforePut: () => { writes++ } })
  await app.setAutoSave(false)
  const tab = app.addDocument(createDocument('flow'))
  assert.equal(await app.save(tab), true)
  assert.equal(writes, 1)
  await app.closeTab(tab)
  assert.equal(writes, 1)
  assert.equal(app.tabs.value.length, 0)
  assert.ok(records.has(tab.document.id), 'Closing a clean tab retains the manually saved local copy')
})
