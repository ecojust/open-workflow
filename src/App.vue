<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './components/AppIcon.vue'
import HeaderControls from './components/HeaderControls.vue'
import AppInformation from './components/AppInformation.vue'
import { buildInfo } from './core/build-info.ts'
import SceneEditor from './components/SceneEditor.vue'
import CodeDiagramEditor from './components/CodeDiagramEditor.vue'
import ServerControl from './components/ServerControl.vue'
import { clone, newId } from './core/types.ts'
import type { DocumentKind, EditorHandle, Scene, WorkflowDocument } from './core/types.ts'
import { contentKey, createDocument, DocumentHistory, MAX_FILE_BYTES, validateDocument } from './core/documents.ts'
import { deleteDraft, putDraft, readDrafts } from './core/storage.ts'
import type { DraftRecord } from './core/storage.ts'
import { documentBytes, downloadBytes, exportDocument, fileAccept, importText, safeFilename } from './core/files.ts'
import type { ExportFormat } from './core/files.ts'
import { normalizeDiagramStyle, type DiagramStyleId } from './core/diagram-appearance.ts'
import { closeNativeWindow, isDesktop, onNativeCloseRequest, openNativeFiles, saveNativeFile, startDocumentServer, readDocumentServer, writeDocumentServer, stopDocumentServer } from './native.ts'
import { sharedContentKey, sharedDocument, validateSharedSnapshot, type ServerStatus, type SharedSnapshot } from './core/sharing.ts'
import { SharedDocumentSync } from './core/share-sync.ts'

interface Tab {
  document: WorkflowDocument; history: Pick<DocumentHistory, 'canUndo' | 'canRedo' | 'commit' | 'undo' | 'redo'>; savedKey: string | null
  path?: string; stamp?: string; revision: number; draftRevision: number
  draftState: 'pending' | 'saved' | 'paused' | 'error'; lastOpened: number
}
type ModalKind = 'unsaved' | 'close-all' | 'rename' | 'notice' | 'delete' | 'info'
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
const menu = ref<'new' | 'export' | null>(null)
const toast = ref<{ text: string; error: boolean } | null>(null)
const modal = ref<Modal | null>(null)
const modalPanel = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const editor = ref<EditorHandle>()
const native = isDesktop()
const theme = ref<'light' | 'dark' | 'system'>('system')
const systemDark = ref(false)
const autoSaveEnabled = ref(true)
const serverStatus = ref<ServerStatus>({ running: false, urls: [] })
const serverBusy = ref(false)
const serverError = ref('')
const serverSyncState = ref<{ status: string; error?: string; conflict?: SharedSnapshot }>({ status: 'stopped' })
let sharedSync: SharedDocumentSync | undefined
let sharingGeneration = 0
let serverStopPending: Promise<void> | undefined
const effectiveTheme = computed(() => theme.value === 'system' ? systemDark.value ? 'dark' : 'light' : theme.value)
const active = computed(() => tabs.value.find(tab => tab.document.id === activeId.value))
const visibleRecent = computed(() => recent.value.filter(entry => `${entry.document.title} ${kindName(entry.document.kind)}`.toLowerCase().includes(search.value.toLowerCase())).sort((a, b) => b.lastOpened - a.lastOpened))
const dirty = (tab: Tab) => tab.savedKey !== contentKey(tab.document)
const hasDirty = () => tabs.value.some(dirty)
const activeSaveState = computed(() => {
  const tab = active.value
  if (!tab) return autoSaveEnabled.value ? '自动保存本地草稿' : '自动保存已关闭'
  if (tab.draftState === 'error') return '草稿保存失败 · 点击重试'
  if (!autoSaveEnabled.value) return tab.draftRevision === tab.revision ? '自动保存已关闭 · 草稿已保存' : '自动保存已关闭 · 草稿未更新'
  if (tab.draftState === 'pending') return '正在保存草稿…'
  return dirty(tab) ? '草稿已保存 · 尚未保存到文件' : '草稿已保存 · 文件版本一致'
})
const queues = new Map<string, Promise<void>>()
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>()
const closingTabs = new Set<string>()
let toastTimer: ReturnType<typeof setTimeout> | undefined
let modalResolve: ((value: string) => void) | undefined
let previousFocus: HTMLElement | null = null
let unlisten: (() => void) | undefined
let closing = false
let pendingWindowClose = false
let saveCompletion: Promise<void> | undefined
let autoSaveGeneration = 0

function kindName(kind: DocumentKind): string { return kind === 'mermaid' ? '代码图表' : '画布' }
function kindIcon(kind: DocumentKind): string { return kind === 'mermaid' ? 'code' : 'canvas' }
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
async function persist(tab: Tab, automatic = false, generation = autoSaveGeneration): Promise<void> {
  if (automatic && (!autoSaveEnabled.value || generation !== autoSaveGeneration)) return
  const id = tab.document.id
  clearTimeout(draftTimers.get(id)); draftTimers.delete(id)
  const revision = tab.revision
  const record: DraftRecord = { id, document: clone(tab.document), savedKey: tab.savedKey, lastOpened: tab.lastOpened }
  const previous = queues.get(id) || Promise.resolve()
  const work = previous.catch(() => {}).then(async () => {
    if (automatic && (!autoSaveEnabled.value || generation !== autoSaveGeneration)) return false
    await putDraft(record)
    return true
  }).then(written => {
    if (!written) return
    updateRecent(record)
    if (tab.revision === revision) { tab.draftState = 'saved'; tab.draftRevision = revision }
  }).catch(error => { tab.draftState = 'error'; errorMessage(new Error(`本地草稿未保存：${error instanceof Error ? error.message : String(error)}。请保存到文件。`)) })
  queues.set(id, work); await work
  if (queues.get(id) === work) queues.delete(id)
}
function scheduleDraft(tab: Tab) {
  clearTimeout(draftTimers.get(tab.document.id))
  draftTimers.delete(tab.document.id)
  rememberSession()
  if (!autoSaveEnabled.value) { tab.draftState = tab.draftRevision === tab.revision ? 'saved' : 'paused'; return }
  tab.draftState = 'pending'
  const generation = autoSaveGeneration
  draftTimers.set(tab.document.id, setTimeout(() => void persist(tab, true, generation), 300))
}
async function setAutoSave(enabled: boolean): Promise<void> {
  if (autoSaveEnabled.value === enabled) return
  autoSaveEnabled.value = enabled
  const generation = ++autoSaveGeneration
  try { localStorage.setItem('ow-autosave', String(enabled)) } catch { /* The switch still applies to this session. */ }
  for (const timer of draftTimers.values()) clearTimeout(timer)
  draftTimers.clear()
  if (!enabled) {
    for (const tab of tabs.value) if (tab.draftState !== 'error') tab.draftState = tab.draftRevision === tab.revision ? 'saved' : 'paused'
    status.value = '自动保存已关闭，修改仍可手动保存。'
    return
  }
  await flush()
  if (!autoSaveEnabled.value || generation !== autoSaveGeneration) return
  for (const tab of tabs.value) scheduleDraft(tab)
  status.value = '已开启本地草稿自动保存。'
}
function toggleAutoSave() { void setAutoSave(!autoSaveEnabled.value) }
function addDocument(document: WorkflowDocument, savedKey: string | null = null, path?: string, stamp?: string, existingDraft = false) {
  if (tabs.value.some(tab => tab.document.id === document.id) || (!existingDraft && recent.value.some(record => record.id === document.id))) document = { ...document, id: newId('doc') }
  const tab: Tab = { document, history: markRaw(new DocumentHistory(document)), savedKey, path, stamp, revision: 0, draftRevision: existingDraft ? 0 : -1, draftState: 'pending', lastOpened: Date.now() }
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
    scheduleDraft(tab); publishSharedChange(tab); status.value = label
  } catch (error) { tab.document = clone(tab.document); errorMessage(error) }
}
function changeScene(scene: Scene, label = '已修改画布') { if (active.value) commit(active.value, doc => { doc.scene = scene }, label) }
function changeSource(source: string) { if (active.value) commit(active.value, doc => { doc.source = source }, '已修改图表源码') }
function changeDiagramStyle(style: DiagramStyleId) {
  if (active.value) commit(active.value, doc => { doc.diagramStyle = normalizeDiagramStyle(style) }, '已修改全局绘图风格')
}
function publishSharedChange(tab: Tab) {
  if (serverStatus.value.documentId !== tab.document.id) return
  serverStatus.value.title = tab.document.title
  sharedSync?.localChanged(sharedDocument(tab.document))
}
function applySharedDocument(document: WorkflowDocument) {
  const tab = tabs.value.find(item => item.document.id === serverStatus.value.documentId)
  if (!tab || document.id !== tab.document.id || document.kind !== tab.document.kind) throw new Error('共享文档已关闭或不匹配。')
  const next = validateDocument({ ...document, importSource: tab.document.importSource })
  if (contentKey(next) === contentKey(tab.document)) return
  tab.document = next; tab.revision++
  // Remote changes become the next undo baseline, so undo cannot erase another editor's work.
  tab.history = markRaw(new DocumentHistory(next))
  serverStatus.value.title = next.title
  scheduleDraft(tab); status.value = '已同步网页中的修改。'
}
async function endSharing() {
  if (serverStopPending) return serverStopPending
  const sessionId = serverStatus.value.sessionId
  if (!sessionId) return
  const pending = (async () => {
    await sharedSync?.syncNow()
    const final = await stopDocumentServer(sessionId)
    if (activeId.value === serverStatus.value.documentId && !home.value) await flush()
    const dirtyLocal = sharedSync?.state.dirty ?? false
    sharingGeneration++; sharedSync?.stop(); sharedSync = undefined
    try {
      if (final) {
        const snapshot = validateSharedSnapshot(final)
        const tab = tabs.value.find(item => item.document.id === serverStatus.value.documentId)
        if (tab && sharedContentKey(tab.document) !== sharedContentKey(snapshot.document)) {
          if (!dirtyLocal) applySharedDocument(snapshot.document)
          else {
            const backup = clone(snapshot.document)
            backup.id = newId('doc'); backup.title = `${backup.title} · 网页保留副本`.slice(0, 200)
            const previousActive = activeId.value, previousHome = home.value
            addDocument(backup); activeId.value = previousActive; home.value = previousHome; rememberSession()
            message('停止共享时存在不同版本，网页中的版本已保留为独立文档。')
          }
        }
      }
    } finally {
      serverStatus.value = { running: false, urls: [] }
      serverSyncState.value = { status: 'stopped' }; serverError.value = ''
    }
  })()
  serverStopPending = pending
  try { await pending } finally { if (serverStopPending === pending) serverStopPending = undefined }
}
async function startSharing() {
  if (serverBusy.value || !active.value || home.value) return
  serverBusy.value = true; serverError.value = ''
  try {
    await flush()
    const tab = active.value
    if (!tab || home.value) return
    if (serverStatus.value.running && serverStatus.value.documentId === tab.document.id) { await sharedSync?.syncNow(); return }
    await endSharing()
    const result = await startDocumentServer(sharedDocument(tab.document))
    if (!tabs.value.some(item => item.document.id === tab.document.id) || closingWindow.value) {
      await stopDocumentServer(result.snapshot.sessionId)
      return
    }
    serverStatus.value = result.status
    const generation = ++sharingGeneration
    const client = new SharedDocumentSync({
      read: () => readDocumentServer(result.snapshot.sessionId),
      write: request => writeDocumentServer(request),
      applyRemote: document => { if (generation === sharingGeneration) applySharedDocument(document) },
      canApplyRemote: () => !closing && !closingWindow.value && !modal.value && !(activeId.value === tab.document.id && !home.value && editor.value?.hasPendingEdits?.()),
      onState: state => { if (generation === sharingGeneration) serverSyncState.value = state },
    })
    sharedSync = client; client.start(result.snapshot)
    // A service start can finish after a local edit; queue the newer document as well.
    client.localChanged(sharedDocument(tab.document))
    status.value = 'Server 已开启，可复制局域网地址在网页中编辑。'
  } catch (error) { serverError.value = error instanceof Error ? error.message : String(error) }
  finally { serverBusy.value = false }
}
async function stopSharing() {
  if (serverBusy.value) return
  serverBusy.value = true; serverError.value = ''
  try { await endSharing(); status.value = 'Server 已停止，原访问地址已失效。' }
  catch (error) { serverError.value = error instanceof Error ? error.message : String(error) }
  finally { serverBusy.value = false }
}
async function resolveSharing(choice: 'remote' | 'local') {
  if (serverBusy.value) return
  serverBusy.value = true
  try { await flush(); await sharedSync?.resolveConflict(choice) }
  catch (error) { serverError.value = error instanceof Error ? error.message : String(error) }
  finally { serverBusy.value = false }
}
async function retrySharing() {
  try { await flush(); await sharedSync?.syncNow() }
  catch (error) { serverError.value = error instanceof Error ? error.message : String(error) }
}
async function copyCodeDiagram(scene: Scene) {
  await flush(); const doc = createDocument('flow'); doc.title = `${active.value?.document.title || '代码图表'} · 可编辑副本`.slice(0, 200); doc.scene = clone(scene); addDocument(doc)
  message('已创建可编辑副本，可直接调整图形、文字与连线。')
}
async function historyAction(action: 'undo' | 'redo') {
  await flush(); const tab = active.value; if (!tab || home.value) return
  const restored = tab.history[action]()
  if (restored) { restored.updatedAt = new Date().toISOString(); tab.document = restored; tab.revision++; scheduleDraft(tab); publishSharedChange(tab); status.value = action === 'undo' ? '已撤销' : '已重做' }
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
    const hasBraces = snapshot.scene.elements.some(element => element.type === 'shape' && element.shape.startsWith('brace-'))
    const hasBrushes = snapshot.scene.elements.some(element => element.type === 'stroke' && element.brush)
    const compatibility = (format === 'drawio' || format === 'excalidraw') && (hasBraces || hasBrushes)
      ? '；特殊形状与笔触在兼容格式中可能简化，重新导入本软件可恢复编辑。' : ''
    message(`已导出 ${output.name}${compatibility}`)
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
  const items = [...(modalPanel.value?.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea,a[href],summary') || [])]
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
    await flush(); let choice = await mayClose(tab); if (choice === 'cancel') return
    if (serverStatus.value.documentId === id) {
      const reviewed = contentKey(tab.document)
      await endSharing()
      if (contentKey(tab.document) !== reviewed) { choice = await mayClose(tab); if (choice === 'cancel') return }
    }
    if (choice === 'remove') await removeLocal(id); else if (autoSaveEnabled.value) await persist(tab, true)
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
  if (booting.value) { pendingWindowClose = true; return }
  if (closing) return
  if (serverBusy.value || closingTabs.size || (busy.value && !saveCompletion)) {
    message('请等待当前操作完成后再关闭。')
    return
  }
  closing = true; closingWindow.value = true; menu.value = null
  let requested = false
  const removedDrafts: DraftRecord[] = []
  try {
    // Freeze editing and finish pending saves before reviewing the final document set.
    while (saveCompletion) await saveCompletion
    await flush()
    if (modal.value) finishModal('cancel')
    // Stopping sharing may apply a last remote edit or create a retained conflict copy.
    // Review all of those documents together, after the service has stopped accepting edits.
    await endSharing()
    const unsaved = tabs.value.filter(dirty)
    let discard = false
    if (unsaved.length) {
      const answer = await ask({
        kind: 'close-all', title: '关闭全部文档？',
        text: `有 ${unsaved.length} 份文档尚未保存到文件。“全部关闭”将放弃这些修改并移除对应的本地草稿；已保存的文件不受影响。`,
        lines: unsaved.map(tab => tab.document.title),
      })
      if (answer === 'cancel') return
      discard = answer === 'discard'
      if (!discard) {
        for (const tab of unsaved) if (!await save(tab) || dirty(tab)) return
      }
    }
    for (const tab of tabs.value) {
      if (discard && dirty(tab)) {
        const record = recent.value.find(item => item.id === tab.document.id)
        if (record) removedDrafts.push(clone(record))
        await removeLocal(tab.document.id)
      } else if (autoSaveEnabled.value) await persist(tab, true)
    }
    await Promise.all(queues.values())
    await closeNativeWindow()
    requested = true
  } catch (error) {
    // Keep the complete working session and restore its drafts if the native exit fails.
    for (const record of removedDrafts) {
      try { await putDraft(record); updateRecent(record) }
      catch (restoreError) { errorMessage(restoreError) }
    }
    if (autoSaveEnabled.value) for (const tab of tabs.value) scheduleDraft(tab)
    errorMessage(error)
  } finally { if (!requested) { closing = false; closingWindow.value = false } }
}
function setTheme(value: 'light' | 'dark' | 'system') {
  theme.value = value; menu.value = null
  try { localStorage.setItem('ow-theme', value) } catch { /* Not essential to saving documents. */ }
}
function date(value: string): string { return new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function keyboard(event: KeyboardEvent) {
  if (closingWindow.value && !modal.value) { event.preventDefault(); return }
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
  if (autoSaveEnabled.value) for (const tab of tabs.value) if (tab.draftState === 'pending') void persist(tab, true)
  if (hasDirty()) { event.preventDefault(); event.returnValue = '' }
}
function pageHide() { if (closingWindow.value) return; void editor.value?.flush(); if (autoSaveEnabled.value) for (const tab of tabs.value) if (tab.draftState === 'pending') void persist(tab, true) }
const media = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')
function mediaChange() { systemDark.value = media?.matches || false }
onMounted(async () => {
  const closeListener = onNativeCloseRequest(() => void nativeClose()).catch(error => { errorMessage(error); return undefined })
  mediaChange(); media?.addEventListener('change', mediaChange)
  window.addEventListener('keydown', keyboard); window.addEventListener('beforeunload', unload); window.addEventListener('pagehide', pageHide)
  try {
    const savedTheme = localStorage.getItem('ow-theme'); if (['light', 'dark', 'system'].includes(savedTheme || '')) theme.value = savedTheme as typeof theme.value
    autoSaveEnabled.value = localStorage.getItem('ow-autosave') !== 'false'
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
  unlisten = await closeListener
  if (pendingWindowClose) { pendingWindowClose = false; void nativeClose() }
})
onBeforeUnmount(() => {
  sharingGeneration++; sharedSync?.stop()
  media?.removeEventListener('change', mediaChange); window.removeEventListener('keydown', keyboard); window.removeEventListener('beforeunload', unload); window.removeEventListener('pagehide', pageHide); unlisten?.(); clearTimeout(toastTimer)
  for (const timer of draftTimers.values()) clearTimeout(timer)
  draftTimers.clear(); autoSaveGeneration++
})
</script>

<template>
  <div class="app-shell" :data-theme="effectiveTheme">
    <header class="global-toolbar" :inert="closingWindow">
      <button class="brand" title="返回工作台" aria-label="返回工作台" @click="showHome"><img src="/brand-mark.png" width="30" height="30" alt=""><strong>Open Workflow</strong></button>
      <div class="file-actions">
        <button title="新建文档 (Ctrl+N)" :aria-expanded="menu === 'new'" @click="menu = menu === 'new' ? null : 'new'"><AppIcon name="plus"/><span>新建</span><AppIcon name="chevron" :size="12"/></button>
        <button title="打开文件 (Ctrl+O)" @click="openFiles"><AppIcon name="folder"/><span>打开</span></button>
        <span class="toolbar-divider"></span>
        <button title="保存 (Ctrl+S)" :disabled="!active || home || !!busy" @click="save()"><AppIcon name="save"/><span>保存</span></button>
        <button class="autosave-switch" role="switch" aria-label="自动保存本地草稿" :aria-checked="autoSaveEnabled" :title="autoSaveEnabled ? '自动保存已开启：仅保存本地草稿' : '自动保存已关闭：可手动保存文件与草稿'" data-testid="autosave-toggle" :disabled="booting || closingWindow" @click="toggleAutoSave"><span>自动保存</span><svg class="switch-track" width="30" height="18" viewBox="0 0 30 18" aria-hidden="true"><rect x="0" y="0" width="30" height="18" rx="9"/><circle :cx="autoSaveEnabled ? 21 : 9" cy="9" r="6"/></svg></button>
        <button class="save-as" title="另存为 (Ctrl+Shift+S)" :disabled="!active || home || !!busy" @click="save(active, true)"><AppIcon name="save-as"/><span>另存为</span></button>
        <button title="导出" :disabled="!active || home || !!busy" :aria-expanded="menu === 'export'" @click="menu = menu === 'export' ? null : 'export'"><AppIcon name="export"/><span>导出</span><AppIcon name="chevron" :size="12"/></button>
        <span class="toolbar-divider"></span>
        <button class="icon-button" title="撤销 (Ctrl+Z)" aria-label="撤销" :disabled="home || !active?.history.canUndo" @click="historyAction('undo')"><AppIcon name="undo"/></button>
        <button class="icon-button" title="重做 (Ctrl+Shift+Z)" aria-label="重做" :disabled="home || !active?.history.canRedo" @click="historyAction('redo')"><AppIcon name="redo"/></button>
      </div>
      <div class="toolbar-end">
        <HeaderControls :theme="theme" :effective-theme="effectiveTheme" :info-open="modal?.kind === 'info'" @update:theme="setTheme" @info="ask({ kind: 'info', title: '关于 Open Workflow', text: '' })"/>
      </div>
    </header>
    <input id="file-input" ref="fileInput" type="file" :accept="fileAccept" multiple hidden @change="browserFiles">

    <div v-if="booting" class="boot-screen" role="status"><span class="spinner"></span>正在恢复本地工作区…</div>
    <div v-else-if="home" class="home-layout" :inert="closingWindow">
      <aside class="home-sidebar">
        <div class="sidebar-heading"><span>工作空间</span></div>
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
              <button class="create-card canvas-card" data-testid="create-canvas" @click="create('flow')">
                <div class="card-art"><svg viewBox="0 0 280 112" aria-hidden="true"><path d="M65 56h48m54 0h48" stroke="#94b5ef" fill="none" stroke-width="2"/><rect x="18" y="36" width="70" height="40" rx="8" fill="#fff" stroke="#80a7e8"/><path d="m140 28 36 28-36 28-36-28z" fill="#dbeafe" stroke="#4c83dc"/><rect x="194" y="36" width="70" height="40" rx="20" fill="#fff" stroke="#80a7e8"/><path d="M35 56h35m149 0h22" stroke="#a8bfdf" stroke-width="3" stroke-linecap="round"/></svg><span class="card-plus"><AppIcon name="plus" :size="14" style="width:14px;height:14px"/></span></div>
                <div class="card-copy"><span class="type-icon"><AppIcon name="canvas" :size="22"/></span><div><h2>画布</h2><p>流程、手绘、便签与灵感收集</p></div><AppIcon name="arrow"/></div>
              </button>
              <button class="create-card diagram-card" data-testid="create-diagram" @click="create('mermaid')">
                <div class="card-art"><svg viewBox="0 0 280 112" aria-hidden="true"><rect x="30" y="18" width="146" height="78" rx="8" fill="#fff" stroke="#9acac4"/><path d="m45 40 8 6-8 6m16-6h63M45 65h20m9 0h62m-91 12h56" stroke="#77aaa2" stroke-width="3" stroke-linecap="round"/><path d="M192 40h48v20h-48zm24 20v17m-14 0h28" stroke="#55988e" fill="#d5ece7" stroke-width="2"/></svg><span class="card-plus"><AppIcon name="plus" :size="14" style="width:14px;height:14px"/></span></div>
                <div class="card-copy"><span class="type-icon"><AppIcon name="code" :size="22"/></span><div><h2>代码图表</h2><p>用文字绘制多种图表</p></div><AppIcon name="arrow"/></div>
              </button>
            </div>
            <div class="template-row"><span>从模板开始</span><button @click="create('flow', true)"><AppIcon name="flow" :size="15"/>项目审批流程<AppIcon name="arrow" :size="14"/></button><button @click="create('board', true)"><AppIcon name="board" :size="15"/>灵感收集板<AppIcon name="arrow" :size="14"/></button><span class="format-hint">支持图形 XML、白板 JSON 与图表源码</span></div>
          </template>
          <section class="recent-section" aria-label="最近文档">
            <div class="section-title"><h2>最近文档 <small>{{ recent.length }}</small></h2><label class="search"><AppIcon name="search" :size="16"/><input v-model="search" placeholder="搜索本地文档" aria-label="搜索本地文档"></label></div>
            <div v-if="!visibleRecent.length" class="empty-state"><div class="empty-icon"><AppIcon name="folder" :size="30"/></div><h3>{{ search ? '没有匹配的文档' : '这里将收起你的每一个想法' }}</h3><p>{{ search ? '换一个关键词试试。' : autoSaveEnabled ? '新建或打开文档后，草稿会自动保存在本机。' : '自动保存已关闭；手动保存或开启开关后，会在这里留下草稿。' }}</p><button v-if="!search" class="text-button" @click="openFiles">打开第一个文件<AppIcon name="arrow" :size="16"/></button></div>
            <div v-else class="recent-list">
              <div v-for="record in visibleRecent" :key="record.id" class="recent-item">
                <button class="recent-open" @click="openRecent(record)"><span class="recent-icon" :class="record.document.kind === 'mermaid' ? 'diagram' : record.document.kind"><AppIcon :name="kindIcon(record.document.kind)" :size="22"/></span><span class="recent-title"><strong>{{ record.document.title }}</strong><small>{{ kindName(record.document.kind) }} · {{ record.document.kind === 'mermaid' ? '文本绘图' : `${record.document.scene.elements.length} 个元素` }}</small></span><time :datetime="record.document.updatedAt" :title="new Date(record.document.updatedAt).toLocaleString()">{{ date(record.document.updatedAt) }}</time><AppIcon name="arrow" :size="17"/></button>
                <button class="icon-button remove-recent" :aria-label="`移除草稿 ${record.document.title}`" title="移除本地草稿" @click="removeRecent(record)"><AppIcon name="trash" :size="16"/></button>
              </div>
            </div>
          </section>
          <div class="home-footnote"><span>自由绘制，也可用文字构建图表</span><span>Open Workflow · {{ buildInfo.version }}</span></div>
        </div>
      </main>
    </div>

    <main v-else-if="active" class="editor-layout" :inert="closingWindow">
      <div class="document-tabs" role="tablist" aria-label="打开的文档">
        <button class="tab-home" title="返回工作台" aria-label="返回工作台" @click="showHome"><AppIcon name="home" :size="17"/></button>
        <div v-for="tab in tabs" :key="tab.document.id" class="tab-wrap" :class="{ active: activeId === tab.document.id }">
          <button role="tab" :aria-selected="activeId === tab.document.id" :title="`${tab.document.title} · 双击重命名`" @click="activate(tab)" @dblclick="rename(tab)"><AppIcon :name="kindIcon(tab.document.kind)" :size="15"/><span>{{ tab.document.title }}</span><i v-if="dirty(tab)" class="dirty-dot" title="尚未保存到文件"></i></button>
          <button class="tab-close" :aria-label="`关闭 ${tab.document.title}`" :title="`关闭 ${tab.document.title}`" @click="closeTab(tab)"><AppIcon name="close" :size="13"/></button>
        </div>
        <button class="tab-add" title="新建文档" aria-label="新建文档" @click="menu = 'new'"><AppIcon name="plus" :size="17"/></button>
        <button class="tab-rename" title="重命名当前文档" aria-label="重命名当前文档" @click="rename(active)"><AppIcon name="rename" :size="15"/></button>
      </div>
      <CodeDiagramEditor v-if="active.document.kind === 'mermaid'" :key="active.document.id" ref="editor" :source="active.document.source" :diagram-style="active.document.diagramStyle" :theme="effectiveTheme" @change="changeSource" @change-style="changeDiagramStyle" @create-flow="copyCodeDiagram" @status="status = $event" @export="exportAs">
        <template #server><ServerControl v-if="!modal" :native="native" :status="serverStatus" :document-id="active.document.id" :document-title="active.document.title" :busy="serverBusy" :error="serverError || serverSyncState.error" :sync-phase="serverSyncState.status" :conflict="serverSyncState.status === 'conflict'" @start="startSharing" @stop="stopSharing" @retry="retrySharing" @resolve-conflict="resolveSharing"/></template>
      </CodeDiagramEditor>
      <SceneEditor v-else :key="active.document.id" ref="editor" :scene="active.document.scene" :mode="active.document.kind" :theme="effectiveTheme" @change="changeScene" @status="status = $event" @export="exportAs">
        <template #server><ServerControl v-if="!modal" :native="native" :status="serverStatus" :document-id="active.document.id" :document-title="active.document.title" :busy="serverBusy" :error="serverError || serverSyncState.error" :sync-phase="serverSyncState.status" :conflict="serverSyncState.status === 'conflict'" @start="startSharing" @stop="stopSharing" @retry="retrySharing" @resolve-conflict="resolveSharing"/></template>
      </SceneEditor>
    </main>

    <footer class="status-bar" :inert="closingWindow"><span class="status-info">{{ home ? '画布 · 代码图表' : status }}</span><span v-if="busy" class="status-busy"><span class="spinner small"></span>{{ busy }}</span><button v-else class="save-status" :class="{ error: active?.draftState === 'error', paused: !autoSaveEnabled }" :title="activeSaveState" @click="active?.draftState === 'error' && persist(active)"><span v-if="active?.draftState === 'pending'" class="spinner small"></span><AppIcon v-else :name="active?.draftState === 'error' ? 'alert' : !autoSaveEnabled ? 'save' : 'check'" :size="13"/>{{ activeSaveState }}</button></footer>

    <template v-if="menu"><div class="menu-dismiss" @click="menu = null"></div><div class="popup-menu" :class="`menu-${menu}`" role="menu">
      <template v-if="menu === 'new'"><p>新建文档</p><button role="menuitem" @click="create('flow')"><AppIcon name="canvas"/>画布<small>流程、手绘与便签</small></button><button role="menuitem" @click="create('mermaid')"><AppIcon name="code"/>代码图表<small>文本绘图</small></button></template>
      <template v-else-if="menu === 'export'"><p>导出当前文档</p><button role="menuitem" @click="exportAs('svg')"><AppIcon name="export"/>SVG 矢量图</button><button role="menuitem" @click="exportAs('png')"><AppIcon name="export"/>PNG 图片</button><button role="menuitem" @click="exportAs('drawio')"><AppIcon name="flow"/>图形 XML<small>基础图形</small></button><button role="menuitem" @click="exportAs('excalidraw')"><AppIcon name="board"/>白板 JSON<small>基础元素</small></button><button v-if="active?.document.kind === 'mermaid'" role="menuitem" @click="exportAs('mmd')"><AppIcon name="code"/>图表源码</button><button v-if="active?.document.importSource" role="menuitem" @click="exportAs('original')"><AppIcon name="download"/>导入时的原文件</button></template>
    </div></template>

    <div v-if="toast" class="toast" :class="{ error: toast.error }" :role="toast.error ? 'alert' : 'status'"><AppIcon :name="toast.error ? 'alert' : 'check'"/><span>{{ toast.text }}</span><button class="icon-button" title="关闭提示" aria-label="关闭提示" @click="toast = null"><AppIcon name="close" :size="16"/></button></div>

    <div v-if="closingWindow" class="operation-overlay" role="status"><span class="spinner"></span>正在检查并关闭…</div>
    <div v-if="modal" class="modal-backdrop" @keydown.esc.stop="finishModal('cancel')" @keydown="trapFocus">
      <section ref="modalPanel" class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title">{{ modal.title }}</h2><button class="icon-button" title="关闭" aria-label="关闭对话框" @click="finishModal('cancel')"><AppIcon name="close"/></button></header><div class="modal-body">
        <AppInformation v-if="modal.kind === 'info'"/>
        <p v-if="modal.text">{{ modal.text }}</p><input v-if="modal.kind === 'rename'" v-model="modal.value" class="rename-input" maxlength="200" aria-label="文档名称" @keydown.enter="finishModal('confirm')">
        <ul v-if="modal.lines" class="import-notes"><li v-for="(line, index) in modal.lines" :key="index">{{ line }}</li></ul>
      </div><footer><template v-if="modal.kind === 'close-all'"><button class="danger-text" @click="finishModal('discard')">全部关闭</button><span class="spacer"></span><button class="secondary" @click="finishModal('cancel')">取消</button><button class="primary" @click="finishModal('save')">保存并全部关闭</button></template><template v-else-if="modal.kind === 'unsaved'"><button class="danger-text" @click="finishModal('discard')">放弃修改</button><span class="spacer"></span><button class="secondary" @click="finishModal('cancel')">取消</button><button class="primary" @click="finishModal('save')">保存并关闭</button></template><template v-else-if="modal.kind === 'rename' || modal.kind === 'delete'"><button class="secondary" @click="finishModal('cancel')">取消</button><button :class="modal.kind === 'delete' ? 'danger' : 'primary'" :disabled="modal.kind === 'rename' && !modal.value?.trim()" @click="finishModal('confirm')">{{ modal.kind === 'delete' ? '移除草稿' : '确定' }}</button></template><button v-else class="primary" @click="finishModal('confirm')">知道了</button></footer></section>
    </div>
  </div>
</template>
