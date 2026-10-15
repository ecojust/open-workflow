import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ref, computed, markRaw, nextTick } from 'vue'
import { clone, newId } from '../src/core/types.ts'
import { contentKey, createDocument, DocumentHistory, MAX_FILE_BYTES, validateDocument } from '../src/core/documents.ts'
import { documentBytes, safeFilename } from '../src/core/files.ts'

// Execute the real setup code. Only browser/native IO and mounted child editors are
// substituted; lifecycle functions are neither copied nor reimplemented here.
const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(source, 'App.vue must expose its real setup script to this regression harness')
const script = ts.transpileModule(source.replace(/^import[^\n]*\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const exposed = 'tabs,activeId,home,recent,busy,modal,editor,toast,addDocument,activate,save,closeTab,nativeClose,unload,pageHide,persist,commit,dirty,historyAction,finishModal,openRecent'

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
  const timers = new Map(), mounted = [], deleted = [], saved = [], downloads = []
  let timerId = 0, closed = 0
  const fakeWindow = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }
  const environment = {
    ref, computed, markRaw, nextTick, clone, newId, contentKey, createDocument, DocumentHistory, MAX_FILE_BYTES, validateDocument, documentBytes, safeFilename,
    onMounted: callback => mounted.push(callback), onBeforeUnmount: () => {},
    window: fakeWindow, document: { activeElement: null },
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId }, clearTimeout: id => timers.delete(id),
    isDesktop: () => Boolean(options.desktop),
    putDraft: async record => { if (options.beforePut) await options.beforePut(record); records.set(record.id, clone(record)) },
    readDrafts: async () => ({ records: [...records.values()].map(clone), skipped: 0 }),
    deleteDraft: async id => { deleted.push(id); records.delete(id) },
    closeNativeWindow: async () => { closed++ },
    onNativeCloseRequest: async () => () => {},
    saveNativeFile: async request => { saved.push(request); return options.nativeSave ? options.nativeSave(request) : { name: request.suggestedName, path: '/test/file.owflow', stamp: 'new-stamp' } },
    downloadBytes: (...args) => downloads.push(args),
  }
  const app = Function(...Object.keys(environment), `${script}\nreturn {${exposed}}`)(...Object.values(environment))
  return { app, records, local, deleted, saved, downloads, mounted, timers, closed: () => closed }
}
function record(document, saved = false) { return { id: document.id, document: clone(document), savedKey: saved ? contentKey(document) : null, lastOpened: 100 } }

test('closing the same clean tab twice cannot close a different document', async () => {
  const { app } = harness()
  const first = createDocument('flow'), second = createDocument('board')
  const tab = app.addDocument(first, contentKey(first)); app.addDocument(second, contentKey(second))
  await Promise.all([app.closeTab(tab), app.closeTab(tab)])
  assert.deepEqual(app.tabs.value.map(item => item.document.id), [second.id])
})

test('canceling native window close preserves drafts previously marked for discard', async () => {
  const first = createDocument('flow'), second = createDocument('board')
  const { app, records, deleted, closed } = harness({ desktop: true, records: [record(first), record(second)] })
  app.addDocument(first); app.addDocument(second)
  const work = app.nativeClose()
  await settleUntil(() => app.modal.value?.title.includes(first.title))
  app.finishModal('discard')
  await settleUntil(() => app.modal.value?.title.includes(second.title))
  assert.deepEqual(deleted, [], 'no destructive draft operation occurs before all choices are known')
  app.finishModal('cancel')
  await work
  assert.equal(app.tabs.value.length, 2)
  assert.ok(records.has(first.id) && records.has(second.id))
  assert.equal(closed(), 0)
})

test('confirmed native window close performs selected discards only after every prompt', async () => {
  const first = createDocument('flow'), second = createDocument('board')
  const { app, records, deleted, closed } = harness({ desktop: true, records: [record(first), record(second)] })
  app.addDocument(first); app.addDocument(second)
  const work = app.nativeClose()
  await settleUntil(() => app.modal.value?.title.includes(first.title)); app.finishModal('discard')
  await settleUntil(() => app.modal.value?.title.includes(second.title))
  assert.equal(deleted.length, 0)
  app.finishModal('discard'); await work
  assert.deepEqual(deleted, [first.id, second.id])
  assert.equal(records.size, 0)
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
