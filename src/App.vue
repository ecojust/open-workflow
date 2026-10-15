<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './components/AppIcon.vue'
import SceneEditor from './components/SceneEditor.vue'
import MermaidEditor from './components/MermaidEditor.vue'
import { clone, newId } from './core/types.ts'
import type { DocumentKind, EditorHandle, Scene, WorkflowDocument } from './core/types.ts'
import { contentKey, createDocument, DocumentHistory, MAX_FILE_BYTES, validateDocument } from './core/documents.ts'
import { deleteDraft, putDraft, readDrafts } from './core/storage.ts'
import type { DraftRecord } from './core/storage.ts'
import { documentBytes, downloadBytes, exportDocument, fileAccept, importText, safeFilename } from './core/files.ts'
import type { ExportFormat } from './core/files.ts'
import { closeNativeWindow, isDesktop, onNativeCloseRequest, openNativeFiles, saveNativeFile } from './native.ts'

interface Tab {
  document: WorkflowDocument; history: Pick<DocumentHistory, 'canUndo' | 'canRedo' | 'commit' | 'undo' | 'redo'>; savedKey: string | null
  path?: string; stamp?: string; revision: number; draftRevision: number
  draftState: 'pending' | 'saved' | 'error'; lastOpened: number
}
type ModalKind = 'unsaved' | 'rename' | 'notice' | 'delete' | 'help'
interface Modal { kind: ModalKind; title: string; text: string; lines?: string[]; value?: string }
const tabs = ref<Tab[]>([])
const activeId = ref('')
const home = ref(true)
const section = ref<'home' | 'recent'>('home')
const recent = ref<DraftRecord[]>([])
const search = ref('')
const booting = ref(true)
const busy = ref('')
const closingWindow = ref(false)
const status = ref('所有创作，留在本地。')
const menu = ref<'new' | 'export' | 'theme' | null>(null)
const toast = ref<{ text: string; error: boolean } | null>(null)
const modal = ref<Modal | null>(null)
const modalPanel = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const editor = ref<EditorHandle>()
const native = isDesktop()
const theme = ref<'light' | 'dark' | 'system'>('system')
const systemDark = ref(false)
const collapsed = ref(false)
const effectiveTheme = computed(() => theme.value === 'system' ? systemDark.value ? 'dark' : 'light' : theme.value)
const active = computed(() => tabs.value.find(tab => tab.document.id === activeId.value))
const visibleRecent = computed(() => recent.value.filter(entry => `${entry.document.title} ${kindName(entry.document.kind)}`.toLowerCase().includes(search.value.toLowerCase())).sort((a, b) => b.lastOpened - a.lastOpened))
const dirty = (tab: Tab) => tab.savedKey !== contentKey(tab.document)
const hasDirty = () => tabs.value.some(dirty)
const activeSaveState = computed(() => !active.value ? '本地优先 · 无需账号' : active.value.draftState === 'error' ? '草稿保存失败' : active.value.draftState === 'pending' ? '正在保存草稿…' : dirty(active.value) ? '草稿已保存 · 尚未保存到文件' : '草稿已保存 · 文件版本一致')
const queues = new Map<string, Promise<void>>()
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>()
const closingTabs = new Set<string>()
let toastTimer: ReturnType<typeof setTimeout> | undefined
let modalResolve: ((value: string) => void) | undefined
let previousFocus: HTMLElement | null = null
let unlisten: (() => void) | undefined
let closing = false
let saveCompletion: Promise<void> | undefined

function kindName(kind: DocumentKind): string { return { flow: '流程图', board: '自由白板', mermaid: 'Mermaid' }[kind] }
function kindIcon(kind: DocumentKind): string { return { flow: 'flow', board: 'board', mermaid: 'code' }[kind] }
function message(text: string, error = false) {
  toast.value = { text, error }; clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, error ? 12000 : 5000)
}
function errorMessage(error: unknown) { message(error instanceof Error ? error.message : String(error), true) }
function rememberSession() {
  try { localStorage.setItem('ow-session', JSON.stringify({ ids: tabs.value.map(tab => tab.document.id), activeId: activeId.value, home: home.value })) } catch { /* Draft failure is reported separately. */ }
}
function updateRecent(record: DraftRecord) {
  const index = recent.value.findIndex(item => item.id === record.id)
  if (index < 0) recent.value.unshift(record)
  else recent.value[index] = record
}
async function persist(tab: Tab): Promise<void> {
  const id = tab.document.id
  clearTimeout(draftTimers.get(id)); draftTimers.delete(id)
  const revision = tab.revision
  const record: DraftRecord = { id, document: clone(tab.document), savedKey: tab.savedKey, lastOpened: tab.lastOpened }
  const previous = queues.get(id) || Promise.resolve()
  const work = previous.catch(() => {}).then(() => putDraft(record)).then(() => {
    updateRecent(record)
    if (tab.revision === revision) { tab.draftState = 'saved'; tab.draftRevision = revision }
  }).catch(error => { tab.draftState = 'error'; errorMessage(new Error(`本地草稿未保存：${error instanceof Error ? error.message : String(error)}。请保存到文件。`)) })
  queues.set(id, work); await work
  if (queues.get(id) === work) queues.delete(id)
}
function scheduleDraft(tab: Tab) {
  tab.draftState = 'pending'
  clearTimeout(draftTimers.get(tab.document.id))
  draftTimers.set(tab.document.id, setTimeout(() => void persist(tab), 300))
  rememberSession()
}
function addDocument(document: WorkflowDocument, savedKey: string | null = null, path?: string, stamp?: string, existingDraft = false) {
  if (tabs.value.some(tab => tab.document.id === document.id) || (!existingDraft && recent.value.some(record => record.id === document.id))) document = { ...document, id: newId('doc') }
  const tab: Tab = { document, history: markRaw(new DocumentHistory(document)), savedKey, path, stamp, revision: 0, draftRevision: -1, draftState: 'pending', lastOpened: Date.now() }
  tabs.value.push(tab); activeId.value = document.id; home.value = false
  scheduleDraft(tabs.value[tabs.value.length - 1]!)
  return tab
}
async function flush() { await editor.value?.flush() }
async function create(kind: DocumentKind, template = false) {
  await flush(); menu.value = null; addDocument(createDocument(kind, template))
  status.value = kind === 'mermaid' ? '编辑左侧文本，右侧实时预览。' : '从工具栏添加元素，双击编辑文字。'
}
async function activate(tab: Tab) {
  await flush(); home.value = false; activeId.value = tab.document.id; tab.lastOpened = Date.now(); menu.value = null
  rememberSession()
}
async function showHome() { await flush(); home.value = true; menu.value = null; rememberSession() }
function commit(tab: Tab, updater: (doc: WorkflowDocument) => void, label: string) {
  try {
    const proposed = clone(tab.document); updater(proposed)
    const next = validateDocument(proposed)
    if (contentKey(next) === contentKey(tab.document)) return
    next.updatedAt = new Date().toISOString(); tab.document = next; tab.revision++; tab.history.commit(next)
    scheduleDraft(tab); status.value = label
  } catch (error) { tab.document = clone(tab.document); errorMessage(error) }
}
function changeScene(scene: Scene, label = '已修改画布') { if (active.value) commit(active.value, doc => { doc.scene = scene }, label) }
function changeSource(source: string) { if (active.value) commit(active.value, doc => { doc.source = source }, '已修改 Mermaid 源码') }
async function copyMermaid(scene: Scene) {
  await flush(); const doc = createDocument('flow'); doc.title = `${active.value?.document.title || 'Mermaid'} · 可编辑副本`.slice(0, 200); doc.scene = clone(scene); addDocument(doc)
  message('已创建可编辑副本，可直接调整图形、文字与连线。')
}
async function historyAction(action: 'undo' | 'redo') {
  await flush(); const tab = active.value; if (!tab || home.value) return
  const restored = tab.history[action]()
  if (restored) { restored.updatedAt = new Date().toISOString(); tab.document = restored; tab.revision++; scheduleDraft(tab); status.value = action === 'undo' ? '已撤销' : '已重做' }
}
async function save(tab = active.value, saveAs = false): Promise<boolean> {
  if (!tab || (busy.value && (!saveCompletion || busy.value !== '正在保存…'))) return false
  // Reserve the queue synchronously, before flushing can yield. A second Ctrl+S
  // must wait for the first save's draft write rather than discard the request.
  const previous = saveCompletion
  let complete!: () => void
  const completion = new Promise<void>(resolve => { complete = resolve })
  saveCompletion = completion
  busy.value = '正在保存…'; menu.value = null
  try {
    await previous
    if (!tabs.value.some(current => current.document.id === tab.document.id)) return false
    await flush()
    const snapshot = clone(tab.document); const snapshotKey = contentKey(snapshot)
    const bytes = documentBytes(snapshot)
    if (native) {
      const result = await saveNativeFile({ suggestedName: `${safeFilename(snapshot.title)}.owflow`, bytes, path: saveAs ? undefined : tab.path, expectedStamp: saveAs ? undefined : tab.stamp })
      if (!result) return false
      tab.path = result.path; tab.stamp = result.stamp
      message(`已保存 ${result.name}`)
    } else {
      downloadBytes(`${safeFilename(snapshot.title)}.owflow`, bytes, 'application/json')
      message('已下载 .owflow 文件；本地草稿也会保留。')
    }
    tab.savedKey = snapshotKey; await persist(tab); return true
  } catch (error) { errorMessage(error); return false } finally {
    if (saveCompletion === completion) {
      saveCompletion = undefined
      if (busy.value === '正在保存…') busy.value = ''
    }
    complete()
  }
}
async function exportAs(format: ExportFormat, selection?: Scene) {
  await flush(); const tab = active.value; if (!tab || busy.value) return
  busy.value = '正在导出…'; menu.value = null
  try {
    const snapshot = clone(tab.document)
    if (selection) { snapshot.scene = clone(selection); snapshot.title = `${snapshot.title} · 选区`.slice(0, 200) }
    const output = await exportDocument(snapshot, format)
    if (native) { const result = await saveNativeFile({ suggestedName: output.name, bytes: output.bytes }); if (!result) return }
    else downloadBytes(output.name, output.bytes, output.mime)
    message(`已导出 ${output.name}`)
  } catch (error) { errorMessage(error) } finally { busy.value = '' }
}
async function loadFiles(files: Array<{ name: string; text: string; path?: string; stamp?: string }>) {
  await flush(); busy.value = '正在读取文件…'; await nextTick()
  const warnings: string[] = []; const failures: string[] = []; let count = 0
  for (const file of files) {
    try {
      const result = importText(file.name, file.text)
      for (const doc of result.documents) addDocument(doc, result.nativeFormat ? contentKey(doc) : null, result.nativeFormat ? file.path : undefined, result.nativeFormat ? file.stamp : undefined)
      count += result.documents.length
      warnings.push(...result.warnings.map(item => `${file.name}：${item}`))
      if (!result.nativeFormat) warnings.push(`${file.name}：已转换为可编辑文档，原始内容保留在文档中，可通过“导出 → 导入时的原文件”取回。`)
    } catch (error) { failures.push(`${file.name}：${error instanceof Error ? error.message : String(error)}`) }
  }
  busy.value = ''
  if (warnings.length || failures.length) await ask({ kind: 'notice', title: failures.length ? '文件读取结果' : '导入完成', text: `已打开 ${count} 份文档。`, lines: [...failures, ...warnings] })
  else message(`已打开 ${count} 份文档。`)
}
async function openFiles() {
  menu.value = null
  if (native) { try { const files = await openNativeFiles(); if (files.length) await loadFiles(files) } catch (error) { errorMessage(error) } }
  else fileInput.value?.click()
}
async function browserFiles(event: Event) {
  const input = event.target as HTMLInputElement; const files = [...(input.files || [])]; input.value = ''
  if (!files.length) return
  try {
    if (files.some(file => file.size > MAX_FILE_BYTES)) throw new Error('单个文件不能超过 50 MB。')
    await loadFiles(await Promise.all(files.map(async file => ({ name: file.name, text: await file.text() }))))
  } catch (error) { errorMessage(error) }
}
async function openRecent(record: DraftRecord) {
  const existing = tabs.value.find(tab => tab.document.id === record.id)
  if (existing) return activate(existing)
  await flush(); addDocument(clone(record.document), record.savedKey, undefined, undefined, true)
}
async function ask(value: Modal): Promise<string> {
  if (modalResolve) finishModal('cancel')
  previousFocus = document.activeElement as HTMLElement | null
  modal.value = value; menu.value = null
  const result = new Promise<string>(resolve => { modalResolve = resolve })
  await nextTick(); (modalPanel.value?.querySelector('input,button') as HTMLElement | null)?.focus()
  return result
}
function finishModal(answer: string) {
  modal.value = null; const resolve = modalResolve; modalResolve = undefined; resolve?.(answer)
  void nextTick(() => previousFocus?.isConnected && previousFocus.focus())
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const items = [...(modalPanel.value?.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea,a[href]') || [])]
  const first = items[0], last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
async function mayClose(tab: Tab): Promise<'keep' | 'remove' | 'cancel'> {
  if (!dirty(tab)) return 'keep'
  const answer = await ask({ kind: 'unsaved', title: `保存“${tab.document.title}”？`, text: '此文档有尚未保存到文件的修改。选择“放弃修改”会同时移除它的本地草稿。' })
  if (answer === 'save') return await save(tab) && !dirty(tab) ? 'keep' : 'cancel'
  return answer === 'discard' ? 'remove' : 'cancel'
}
async function removeLocal(id: string) {
  clearTimeout(draftTimers.get(id)); draftTimers.delete(id); await queues.get(id)
  await deleteDraft(id); recent.value = recent.value.filter(entry => entry.id !== id)
}
async function closeTab(tab: Tab) {
  const id = tab.document.id
  if (closingTabs.has(id) || busy.value || closing) return
  closingTabs.add(id)
  try {
    await flush(); const choice = await mayClose(tab); if (choice === 'cancel') return
    if (choice === 'remove') await removeLocal(id); else await persist(tab)
    const index = tabs.value.findIndex(item => item.document.id === id)
    if (index < 0) return
    tabs.value.splice(index, 1)
    if (activeId.value === id) activeId.value = tabs.value[Math.max(0, index - 1)]?.document.id || ''
    if (!tabs.value.length) home.value = true
    rememberSession()
  } catch (error) { errorMessage(error) } finally { closingTabs.delete(id) }
}
async function rename(tab: Tab) {
  await flush(); const value = { kind: 'rename' as const, title: '重命名文档', text: '名称会保存在文档中；已存在的磁盘文件名不会随之改变。', value: tab.document.title }
  const answer = await ask(value)
  if (answer !== 'confirm') return
  const name = value.value.trim().slice(0, 200)
  if (name) commit(tab, doc => { doc.title = name }, '已重命名文档')
}
async function removeRecent(record: DraftRecord) {
  if (tabs.value.some(tab => tab.document.id === record.id)) { message('请先关闭此文档，再移除本地草稿。'); return }
  if (await ask({ kind: 'delete', title: '移除本地草稿？', text: `将移除“${record.document.title}”的本地副本，已下载的文件不受影响。` }) !== 'confirm') return
  try { await removeLocal(record.id) } catch (error) { errorMessage(error) }
}
async function nativeClose() {
  if (closing) return; closing = true
  let requested = false
  const choices: Array<{ tab: Tab; choice: 'keep' | 'remove' }> = []
  try {
    await flush()
    for (const tab of [...tabs.value]) {
      const choice = await mayClose(tab); if (choice === 'cancel') return
      choices.push({ tab, choice })
    }
    closingWindow.value = true
    for (const { tab, choice } of choices) {
      if (choice === 'remove') await removeLocal(tab.document.id); else await persist(tab)
    }
    await closeNativeWindow()
    requested = true
  } catch (error) {
    // A failed native close leaves this working session alive, including discarded tabs.
    for (const { tab, choice } of choices) if (choice === 'remove') scheduleDraft(tab)
    errorMessage(error)
  } finally { if (!requested) { closing = false; closingWindow.value = false } }
}
function setTheme(value: 'light' | 'dark' | 'system') {
  theme.value = value; menu.value = null
  try { localStorage.setItem('ow-theme', value) } catch { /* Not essential to saving documents. */ }
}
function toggleSidebar() {
  collapsed.value = !collapsed.value
  try { localStorage.setItem('ow-sidebar', String(collapsed.value)) } catch { /* Optional preference. */ }
}
function date(value: string): string { return new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function keyboard(event: KeyboardEvent) {
  if (closingWindow.value) { event.preventDefault(); return }
  if (event.key === 'Escape') { if (modal.value) { event.preventDefault(); finishModal('cancel') }; menu.value = null; return }
  if (!(event.ctrlKey || event.metaKey) || modal.value) return
  const key = event.key.toLowerCase()
  const input = event.target instanceof Element && Boolean(event.target.closest('input,textarea,[contenteditable="true"]'))
  if (key === 's') { event.preventDefault(); if (!home.value) void save(active.value, event.shiftKey) }
  else if (key === 'o') { event.preventDefault(); void openFiles() }
  else if (!input && (key === 'z' || key === 'y')) { event.preventDefault(); void historyAction(key === 'y' || event.shiftKey ? 'redo' : 'undo') }
  else if (key === 'n') { event.preventDefault(); void create('flow') }
}
function unload(event: BeforeUnloadEvent) {
  if (closingWindow.value) return
  void editor.value?.flush()
  for (const tab of tabs.value) if (tab.draftState === 'pending') void persist(tab)
  if (hasDirty()) { event.preventDefault(); event.returnValue = '' }
}
function pageHide() { if (closingWindow.value) return; void editor.value?.flush(); for (const tab of tabs.value) if (tab.draftState === 'pending') void persist(tab) }
const media = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')
function mediaChange() { systemDark.value = media?.matches || false }
onMounted(async () => {
  mediaChange(); media?.addEventListener('change', mediaChange)
  window.addEventListener('keydown', keyboard); window.addEventListener('beforeunload', unload); window.addEventListener('pagehide', pageHide)
  try {
    const savedTheme = localStorage.getItem('ow-theme'); if (['light', 'dark', 'system'].includes(savedTheme || '')) theme.value = savedTheme as typeof theme.value
    collapsed.value = localStorage.getItem('ow-sidebar') === 'true'
    const result = await readDrafts(); recent.value = result.records
    if (result.skipped) message(`${result.skipped} 份损坏的草稿未能恢复；原始数据仍在本地。`, true)
    const session = JSON.parse(localStorage.getItem('ow-session') || '{}')
    if (Array.isArray(session.ids)) for (const id of session.ids.slice(0, 30)) {
      const record = result.records.find(entry => entry.id === id)
      if (record) addDocument(clone(record.document), record.savedKey, undefined, undefined, true)
    }
    if (tabs.value.some(tab => tab.document.id === session.activeId)) activeId.value = session.activeId
    home.value = session.home !== false || !tabs.value.length
    rememberSession()
  } catch (error) { errorMessage(new Error(`本地草稿不可用：${error instanceof Error ? error.message : String(error)}`)) }
  finally { booting.value = false }
  try { unlisten = await onNativeCloseRequest(() => void nativeClose()) } catch (error) { errorMessage(error) }
})
onBeforeUnmount(() => {
  media?.removeEventListener('change', mediaChange); window.removeEventListener('keydown', keyboard); window.removeEventListener('beforeunload', unload); window.removeEventListener('pagehide', pageHide); unlisten?.(); clearTimeout(toastTimer)
  for (const timer of draftTimers.values()) clearTimeout(timer)
})
</script>

<template>
  <div class="app-shell" :data-theme="effectiveTheme">
    <header class="global-toolbar">
      <button class="brand" title="返回工作台" aria-label="返回工作台" @click="showHome"><img src="/favicon.svg" width="30" height="30" alt=""><strong>Open Workflow</strong></button>
      <div class="file-actions">
        <button title="新建文档 (Ctrl+N)" :aria-expanded="menu === 'new'" @click="menu = menu === 'new' ? null : 'new'"><AppIcon name="plus"/><span>新建</span><AppIcon name="chevron" :size="12"/></button>
        <button title="打开文件 (Ctrl+O)" @click="openFiles"><AppIcon name="folder"/><span>打开</span></button>
        <span class="toolbar-divider"></span>
        <button title="保存 (Ctrl+S)" :disabled="!active || home || !!busy" @click="save()"><AppIcon name="save"/><span>保存</span></button>
        <button class="save-as" title="另存为 (Ctrl+Shift+S)" :disabled="!active || home || !!busy" @click="save(active, true)"><AppIcon name="save-as"/><span>另存为</span></button>
        <button title="导出" :disabled="!active || home || !!busy" :aria-expanded="menu === 'export'" @click="menu = menu === 'export' ? null : 'export'"><AppIcon name="export"/><span>导出</span><AppIcon name="chevron" :size="12"/></button>
        <span class="toolbar-divider"></span>
        <button class="icon-button" title="撤销 (Ctrl+Z)" aria-label="撤销" :disabled="home || !active?.history.canUndo" @click="historyAction('undo')"><AppIcon name="undo"/></button>
        <button class="icon-button" title="重做 (Ctrl+Shift+Z)" aria-label="重做" :disabled="home || !active?.history.canRedo" @click="historyAction('redo')"><AppIcon name="redo"/></button>
      </div>
      <div class="toolbar-end">
        <span class="local-badge"><i></i>{{ native ? '桌面版' : '本地工作区' }}</span>
        <button class="icon-button" title="切换外观" aria-label="切换外观" :aria-expanded="menu === 'theme'" @click="menu = menu === 'theme' ? null : 'theme'"><AppIcon :name="effectiveTheme === 'dark' ? 'moon' : 'sun'"/></button>
        <button class="icon-button help-button" title="使用帮助" aria-label="使用帮助" @click="ask({ kind: 'help', title: '开始创作', text: '' })"><AppIcon name="help"/></button>
      </div>
    </header>
    <input id="file-input" ref="fileInput" type="file" :accept="fileAccept" multiple hidden @change="browserFiles">

    <div v-if="booting" class="boot-screen" role="status"><span class="spinner"></span>正在恢复本地工作区…</div>
    <div v-else-if="home" class="home-layout" :class="{ collapsed }">
      <aside class="home-sidebar">
        <div class="sidebar-heading"><span v-if="!collapsed">工作空间</span><button class="icon-button" :title="collapsed ? '展开侧栏' : '折叠侧栏'" :aria-label="collapsed ? '展开侧栏' : '折叠侧栏'" @click="toggleSidebar"><AppIcon name="panel"/></button></div>
        <nav aria-label="工作台导航">
          <button :class="{ selected: section === 'home' }" title="工作台" @click="section = 'home'"><AppIcon name="home"/><span>工作台</span></button>
          <button :class="{ selected: section === 'recent' }" title="最近文档" @click="section = 'recent'"><AppIcon name="clock"/><span>最近文档</span><small>{{ recent.length }}</small></button>
        </nav>
        <div v-if="tabs.length" class="open-documents"><p>已打开</p><button v-for="tab in tabs" :key="tab.document.id" :title="tab.document.title" @click="activate(tab)"><AppIcon :name="kindIcon(tab.document.kind)"/><span>{{ tab.document.title }}</span><i v-if="dirty(tab)" class="dirty-dot"></i></button></div>
        <div class="sidebar-footer"><AppIcon name="check"/><span>文档在本机保存<br><small>不上传你的画布内容</small></span></div>
      </aside>
      <main class="home-content">
        <div class="home-inner">
          <div class="welcome"><div><p class="eyebrow">OPEN WORKFLOW</p><h1>{{ section === 'home' ? '让想法，清晰可见。' : '继续你的创作。' }}</h1><p>{{ section === 'home' ? '从一条流程、一张白板，或几行文字开始。' : '本机上的文档草稿，都在这里。' }}</p></div><button class="secondary open-file-button" @click="openFiles"><AppIcon name="folder"/>打开已有文件</button></div>
          <template v-if="section === 'home'">
            <div class="create-grid">
              <button class="create-card flow-card" data-testid="create-flow" @click="create('flow')">
                <div class="card-art"><svg viewBox="0 0 280 112" aria-hidden="true"><path d="M65 56h48m54 0h48" stroke="#94b5ef" fill="none" stroke-width="2"/><rect x="18" y="36" width="70" height="40" rx="8" fill="#fff" stroke="#80a7e8"/><path d="m140 28 36 28-36 28-36-28z" fill="#dbeafe" stroke="#4c83dc"/><rect x="194" y="36" width="70" height="40" rx="20" fill="#fff" stroke="#80a7e8"/><path d="M35 56h35m149 0h22" stroke="#a8bfdf" stroke-width="3" stroke-linecap="round"/></svg><span class="card-plus"><AppIcon name="plus" :size="14" style="width:14px;height:14px"/></span></div>
                <div class="card-copy"><span class="type-icon"><AppIcon name="flow" :size="22"/></span><div><h2>流程图</h2><p>梳理步骤，连接逻辑</p></div><AppIcon name="arrow"/></div>
              </button>
              <button class="create-card board-card" data-testid="create-board" @click="create('board')">
                <div class="card-art"><svg viewBox="0 0 280 112" aria-hidden="true"><path d="M88 67q45-65 100-12" stroke="#bc92d6" stroke-width="2" fill="none" stroke-dasharray="5 4"/><rect x="33" y="18" width="70" height="70" rx="3" fill="#fde68a" transform="rotate(-6 68 53)"/><rect x="172" y="29" width="70" height="70" rx="3" fill="#ddd6fe" transform="rotate(7 207 64)"/><path d="M48 40h40m-40 10h30m97 5h40m-40 10h29" stroke="#9d8a7a" opacity=".6" stroke-width="3" stroke-linecap="round"/></svg><span class="card-plus"><AppIcon name="plus" :size="14" style="width:14px;height:14px"/></span></div>
                <div class="card-copy"><span class="type-icon"><AppIcon name="board" :size="22"/></span><div><h2>自由白板</h2><p>手绘、便签与灵感收集</p></div><AppIcon name="arrow"/></div>
              </button>
              <button class="create-card mermaid-card" data-testid="create-mermaid" @click="create('mermaid')">
                <div class="card-art"><svg viewBox="0 0 280 112" aria-hidden="true"><rect x="30" y="18" width="146" height="78" rx="8" fill="#fff" stroke="#9acac4"/><path d="m45 40 8 6-8 6m16-6h63M45 65h20m9 0h62m-91 12h56" stroke="#77aaa2" stroke-width="3" stroke-linecap="round"/><path d="M192 40h48v20h-48zm24 20v17m-14 0h28" stroke="#55988e" fill="#d5ece7" stroke-width="2"/></svg><span class="card-plus"><AppIcon name="plus" :size="14" style="width:14px;height:14px"/></span></div>
                <div class="card-copy"><span class="type-icon"><AppIcon name="code" :size="22"/></span><div><h2>Mermaid</h2><p>用文字绘制多种图表</p></div><AppIcon name="arrow"/></div>
              </button>
            </div>
            <div class="template-row"><span>从示例开始</span><button @click="create('flow', true)"><AppIcon name="flow" :size="15"/>项目审批流程<AppIcon name="arrow" :size="14"/></button><button @click="create('board', true)"><AppIcon name="board" :size="15"/>灵感收集板<AppIcon name="arrow" :size="14"/></button><span class="format-hint">支持导入 draw.io、Excalidraw 与 Mermaid</span></div>
          </template>
          <section class="recent-section" aria-label="最近文档">
            <div class="section-title"><h2>最近文档 <small>{{ recent.length }}</small></h2><label class="search"><AppIcon name="search" :size="16"/><input v-model="search" placeholder="搜索本地文档" aria-label="搜索本地文档"></label></div>
            <div v-if="!visibleRecent.length" class="empty-state"><div class="empty-icon"><AppIcon name="folder" :size="30"/></div><h3>{{ search ? '没有匹配的文档' : '这里将收起你的每一个想法' }}</h3><p>{{ search ? '换一个关键词试试。' : '新建或打开文档后，草稿会自动保存在本机。' }}</p><button v-if="!search" class="text-button" @click="openFiles">打开第一个文件<AppIcon name="arrow" :size="16"/></button></div>
            <div v-else class="recent-list">
              <div v-for="record in visibleRecent" :key="record.id" class="recent-item">
                <button class="recent-open" @click="openRecent(record)"><span class="recent-icon" :class="record.document.kind"><AppIcon :name="kindIcon(record.document.kind)" :size="22"/></span><span class="recent-title"><strong>{{ record.document.title }}</strong><small>{{ kindName(record.document.kind) }} · {{ record.document.kind === 'mermaid' ? '文本绘图' : `${record.document.scene.elements.length} 个元素` }}</small></span><time :datetime="record.document.updatedAt" :title="new Date(record.document.updatedAt).toLocaleString()">{{ date(record.document.updatedAt) }}</time><AppIcon name="arrow" :size="17"/></button>
                <button class="icon-button remove-recent" :aria-label="`移除草稿 ${record.document.title}`" title="移除本地草稿" @click="removeRecent(record)"><AppIcon name="trash" :size="16"/></button>
              </div>
            </div>
          </section>
          <div class="home-footnote"><span>一个工作台，三种表达方式</span><span>Open Workflow · 0.1.0</span></div>
        </div>
      </main>
    </div>

    <main v-else-if="active" class="editor-layout">
      <div class="document-tabs" role="tablist" aria-label="打开的文档">
        <button class="tab-home" title="返回工作台" aria-label="返回工作台" @click="showHome"><AppIcon name="home" :size="17"/></button>
        <div v-for="tab in tabs" :key="tab.document.id" class="tab-wrap" :class="{ active: activeId === tab.document.id }">
          <button role="tab" :aria-selected="activeId === tab.document.id" :title="`${tab.document.title} · 双击重命名`" @click="activate(tab)" @dblclick="rename(tab)"><AppIcon :name="kindIcon(tab.document.kind)" :size="15"/><span>{{ tab.document.title }}</span><i v-if="dirty(tab)" class="dirty-dot" title="尚未保存到文件"></i></button>
          <button class="tab-close" :aria-label="`关闭 ${tab.document.title}`" :title="`关闭 ${tab.document.title}`" @click="closeTab(tab)"><AppIcon name="close" :size="13"/></button>
        </div>
        <button class="tab-add" title="新建文档" aria-label="新建文档" @click="menu = 'new'"><AppIcon name="plus" :size="17"/></button>
        <button class="tab-rename" title="重命名当前文档" aria-label="重命名当前文档" @click="rename(active)"><AppIcon name="rename" :size="15"/></button>
      </div>
      <MermaidEditor v-if="active.document.kind === 'mermaid'" :key="active.document.id" ref="editor" :source="active.document.source" :theme="effectiveTheme" @change="changeSource" @create-flow="copyMermaid" @status="status = $event"/>
      <SceneEditor v-else :key="active.document.id" ref="editor" :scene="active.document.scene" :mode="active.document.kind" :theme="effectiveTheme" @change="changeScene" @status="status = $event" @export="exportAs"/>
    </main>

    <footer class="status-bar"><span class="status-info">{{ home ? '流程图 · 自由白板 · Mermaid' : status }}</span><span v-if="busy" class="status-busy"><span class="spinner small"></span>{{ busy }}</span><button v-else class="save-status" :class="{ error: active?.draftState === 'error' }" :title="activeSaveState" @click="active?.draftState === 'error' && persist(active)"><span v-if="active?.draftState === 'pending'" class="spinner small"></span><AppIcon v-else :name="active?.draftState === 'error' ? 'alert' : 'check'" :size="13"/>{{ activeSaveState }}</button></footer>

    <template v-if="menu"><div class="menu-dismiss" @click="menu = null"></div><div class="popup-menu" :class="`menu-${menu}`" role="menu">
      <template v-if="menu === 'new'"><p>新建文档</p><button role="menuitem" @click="create('flow')"><AppIcon name="flow"/>流程图<small>节点与连线</small></button><button role="menuitem" @click="create('board')"><AppIcon name="board"/>自由白板<small>笔迹与便签</small></button><button role="menuitem" @click="create('mermaid')"><AppIcon name="code"/>Mermaid<small>文本绘图</small></button></template>
      <template v-else-if="menu === 'export'"><p>导出当前文档</p><button role="menuitem" @click="exportAs('svg')"><AppIcon name="export"/>SVG 矢量图</button><button role="menuitem" @click="exportAs('png')"><AppIcon name="export"/>PNG 图片</button><button role="menuitem" @click="exportAs('drawio')"><AppIcon name="flow"/>draw.io 文件<small>基础图形</small></button><button role="menuitem" @click="exportAs('excalidraw')"><AppIcon name="board"/>Excalidraw 文件<small>基础元素</small></button><button v-if="active?.document.kind === 'mermaid'" role="menuitem" @click="exportAs('mmd')"><AppIcon name="code"/>Mermaid 源码</button><button v-if="active?.document.importSource" role="menuitem" @click="exportAs('original')"><AppIcon name="download"/>导入时的原文件</button></template>
      <template v-else><p>外观</p><button v-for="option in [{ value: 'light', label: '浅色', icon: 'sun' }, { value: 'dark', label: '深色', icon: 'moon' }, { value: 'system', label: '跟随系统', icon: 'monitor' }]" :key="option.value" role="menuitemradio" :aria-checked="theme === option.value" @click="setTheme(option.value as 'light' | 'dark' | 'system')"><AppIcon :name="option.icon"/>{{ option.label }}<AppIcon v-if="theme === option.value" name="check" :size="16"/></button></template>
    </div></template>

    <div v-if="toast" class="toast" :class="{ error: toast.error }" :role="toast.error ? 'alert' : 'status'"><AppIcon :name="toast.error ? 'alert' : 'check'"/><span>{{ toast.text }}</span><button class="icon-button" title="关闭提示" aria-label="关闭提示" @click="toast = null"><AppIcon name="close" :size="16"/></button></div>

    <div v-if="closingWindow" class="operation-overlay" role="status"><span class="spinner"></span>正在保存并关闭…</div>
    <div v-if="modal" class="modal-backdrop" @keydown.esc.stop="finishModal('cancel')" @keydown="trapFocus">
      <section ref="modalPanel" class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title">{{ modal.title }}</h2><button class="icon-button" title="关闭" aria-label="关闭对话框" @click="finishModal('cancel')"><AppIcon name="close"/></button></header><div class="modal-body">
        <p v-if="modal.text">{{ modal.text }}</p><input v-if="modal.kind === 'rename'" v-model="modal.value" class="rename-input" maxlength="200" aria-label="文档名称" @keydown.enter="finishModal('confirm')">
        <ul v-if="modal.lines" class="import-notes"><li v-for="(line, index) in modal.lines" :key="index">{{ line }}</li></ul>
        <template v-if="modal.kind === 'help'"><div class="help-block"><h3>流程与白板</h3><p>从工具栏选图形后点击画布放置。双击图形编辑文字，用连线工具连接节点。按住空格拖动画布，普通滚轮平移，Ctrl / ⌘ + 滚轮缩放，Shift 点击多选。</p><p>白板提供荧光笔、整元素橡皮擦、分区框架和四套可编辑模板。多选后可组合、对齐和等距分布；点击组合整体选择，Alt + 点击选择单个成员。拖动框架标题可带动内部内容。</p></div><div class="help-block"><h3>文字绘图</h3><p>Mermaid 工作区提供流程、时序、类图、ER、状态、架构、数据分析与项目计划等丰富的图表模板。选择模板后编辑源码，即时查看预览；也可创建可编辑副本继续调整。各类型支持常用语法子集，未实现的指令会提示具体行号。</p></div><div class="help-block"><h3>保存与兼容</h3><p>本地草稿自动保存到当前浏览器/桌面工作区。Ctrl+S 保存可迁移的 .owflow 文件。draw.io 和 Excalidraw 导入支持基础元素，转换限制会单独提示。无边记和 Whiteboard 的专有文件格式暂不支持。</p></div><div class="shortcuts"><span>打开文件 <kbd>Ctrl / ⌘ O</kbd></span><span>保存文件 <kbd>Ctrl / ⌘ S</kbd></span><span>撤销 <kbd>Ctrl / ⌘ Z</kbd></span><span>重做 <kbd>Ctrl / ⌘ Shift Z</kbd></span></div></template>
      </div><footer><template v-if="modal.kind === 'unsaved'"><button class="danger-text" @click="finishModal('discard')">放弃修改</button><span class="spacer"></span><button class="secondary" @click="finishModal('cancel')">取消</button><button class="primary" @click="finishModal('save')">保存并关闭</button></template><template v-else-if="modal.kind === 'rename' || modal.kind === 'delete'"><button class="secondary" @click="finishModal('cancel')">取消</button><button :class="modal.kind === 'delete' ? 'danger' : 'primary'" :disabled="modal.kind === 'rename' && !modal.value?.trim()" @click="finishModal('confirm')">{{ modal.kind === 'delete' ? '移除草稿' : '确定' }}</button></template><button v-else class="primary" @click="finishModal('confirm')">知道了</button></footer></section>
    </div>
  </div>
</template>
