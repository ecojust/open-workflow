<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { createDocument, DocumentHistory } from '../core/documents.ts'
import { documentBytes, downloadBytes, exportDocument, safeFilename } from '../core/files.ts'
import { createSharedHttpClient, SharedDocumentSync, type SharedSyncState } from '../core/share-sync.ts'
import { sharedDocument, type ServerStatus } from '../core/sharing.ts'
import type { DiagramStyleId } from '../core/diagram-appearance.ts'
import { clone, type EditorHandle, type Scene, type WorkflowDocument } from '../core/types.ts'
import AppIcon from './AppIcon.vue'
import CodeDiagramEditor from './CodeDiagramEditor.vue'
import SceneEditor from './SceneEditor.vue'
import ServerControl from './ServerControl.vue'

const props = defineProps<{ token: string }>()
const current = shallowRef<WorkflowDocument>()
const editor = ref<EditorHandle>(), serverControl = ref<InstanceType<typeof ServerControl>>()
const history = shallowRef<DocumentHistory>(), historyVersion = ref(0)
const theme = ref<'light' | 'dark'>(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
const connecting = ref(true), connectionError = ref(''), operationBusy = ref(false), resolving = ref(false), message = ref(''), messageError = ref(false)
const syncState = shallowRef<SharedSyncState>({ status: 'stopped', dirty: false, remotePending: false, revision: 0, sessionId: '' })
const client = createSharedHttpClient(props.token), webUrl = location.href
let sync: SharedDocumentSync | undefined, initialRequest: AbortController | undefined, disposed = false
const phase = computed(() => connecting.value ? 'connecting' : !current.value ? 'offline' : syncState.value.status)
const phaseText = computed(() => ({ connecting: '正在连接共享文档', synced: '修改已同步', pending: '等待同步修改', syncing: '正在同步', waiting: '完成当前编辑后接收更新', offline: '连接已断开', conflict: '请选择保留的版本', stopped: '共享已停止' }[phase.value]))
const serverStatus = computed<ServerStatus>(() => ({ running: Boolean(current.value) && !['offline', 'stopped'].includes(phase.value), sessionId: syncState.value.sessionId, documentId: current.value?.id, title: current.value?.title, urls: [webUrl] }))
const error = computed(() => connectionError.value || syncState.value.error || '')
const canUndo = computed(() => { void historyVersion.value; return history.value?.canUndo ?? false })
const canRedo = computed(() => { void historyVersion.value; return history.value?.canRedo ?? false })

function announce(text: string, isError = false) { message.value = text; messageError.value = isError }
function applyRemote(document: WorkflowDocument) {
  current.value = clone(document)
  history.value = new DocumentHistory(document); historyVersion.value++
  announce('已接收远端更新，撤销记录从此版本开始。')
}
async function connect() {
  if (disposed) return
  if (sync) { await sync.syncNow(); return }
  initialRequest?.abort()
  const request = new AbortController(); initialRequest = request
  connecting.value = true; connectionError.value = ''
  try {
    const snapshot = await client.read(request.signal)
    if (disposed || request !== initialRequest) return
    current.value = clone(snapshot.document); history.value = new DocumentHistory(snapshot.document); historyVersion.value++
    sync = new SharedDocumentSync({ ...client, applyRemote, canApplyRemote: () => !editor.value?.hasPendingEdits?.(), onState: state => { syncState.value = state } })
    sync.start(snapshot)
    announce('编辑会与桌面端同步；“保存”可下载当前文档副本。')
  } catch (cause) {
    if (disposed || request !== initialRequest) return
    connectionError.value = cause instanceof Error ? cause.message : '无法连接共享文档，请重试。'
  } finally { if (request === initialRequest) { initialRequest = undefined; connecting.value = false } }
}
function commit(update: Partial<Pick<WorkflowDocument, 'scene' | 'source' | 'diagramStyle'>>) {
  if (!current.value) return
  try {
    const document = sharedDocument({ ...current.value, ...update, updatedAt: new Date().toISOString() })
    history.value?.commit(document); historyVersion.value++
    current.value = document; sync?.localChanged(document)
  } catch (cause) { announce(cause instanceof Error ? cause.message : '无法保存当前编辑。', true) }
}
function changeScene(scene: Scene) { commit({ scene: clone(scene) }) }
function changeSource(source: string) { commit({ source }) }
function changeStyle(diagramStyle: DiagramStyleId) { commit({ diagramStyle }) }
async function moveHistory(direction: 'undo' | 'redo') {
  await editor.value?.flush()
  const document = history.value?.[direction]()
  if (!document) return
  document.updatedAt = new Date().toISOString(); current.value = document; historyVersion.value++
  sync?.localChanged(document)
}
async function backup() {
  try {
    await editor.value?.flush()
    if (!current.value) return
    downloadBytes(`${safeFilename(current.value.title)}.owflow`, documentBytes(current.value), 'application/json')
    announce('已下载当前文档副本。')
  } catch (cause) { announce(cause instanceof Error ? cause.message : '无法下载文档，请重试。', true) }
}
async function imageExport(format: 'svg' | 'png', selection?: Scene) {
  if (operationBusy.value) return
  operationBusy.value = true
  try {
    await editor.value?.flush()
    if (!current.value) return
    const document = clone(current.value)
    if (selection) { document.kind = 'flow'; document.scene = clone(selection) }
    const result = await exportDocument(document, format)
    downloadBytes(result.name, result.bytes, result.mime); announce(`已导出 ${format.toUpperCase()} 图片。`)
  } catch (cause) { announce(cause instanceof Error ? cause.message : '无法导出图片。', true) }
  finally { operationBusy.value = false }
}
function downloadEditable(scene: Scene) {
  try {
    const document = createDocument('flow'); document.title = `${current.value?.title || '代码图表'} · 可编辑副本`; document.scene = clone(scene)
    downloadBytes(`${safeFilename(document.title)}.owflow`, documentBytes(document), 'application/json')
    announce('已下载可编辑画布副本，可在工作台打开。')
  } catch (cause) { announce(cause instanceof Error ? cause.message : '无法下载可编辑副本。', true) }
}
async function resolveConflict(choice: 'remote' | 'local') {
  if (resolving.value) return
  resolving.value = true
  try { await editor.value?.flush(); await sync?.resolveConflict(choice) }
  catch (cause) { announce(cause instanceof Error ? cause.message : '版本选择未完成，请重试。', true) }
  finally { resolving.value = false }
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (syncState.value.dirty || syncState.value.conflict || editor.value?.hasPendingEdits?.()) { event.preventDefault(); event.returnValue = '' }
}
function keydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  if (event.key.toLowerCase() === 's') { event.preventDefault(); void backup(); return }
  if ((event.target as HTMLElement | null)?.closest('input,textarea,[contenteditable="true"],[role="dialog"]')) return
  if (event.key.toLowerCase() === 'z') { event.preventDefault(); void moveHistory(event.shiftKey ? 'redo' : 'undo') }
  else if (event.key.toLowerCase() === 'y') { event.preventDefault(); void moveHistory('redo') }
}
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', keydown); void connect() })
onBeforeUnmount(() => { disposed = true; initialRequest?.abort(); sync?.stop(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', keydown) })
</script>

<template>
  <main class="app-shell shared-workspace" :data-theme="theme" data-testid="shared-workspace">
    <header class="shared-header">
      <div class="shared-heading"><AppIcon :name="current?.kind === 'mermaid' ? 'code' : 'canvas'" :size="21"/><div><strong :title="current?.title">{{ current?.title || '共享文档' }}</strong><small>Open Workflow · 局域网编辑</small></div></div>
      <nav class="shared-actions" aria-label="共享文档操作">
        <button type="button" title="撤销" aria-label="撤销" data-testid="shared-undo" :disabled="!current || !canUndo" @click="moveHistory('undo')"><AppIcon name="undo" :size="17"/></button>
        <button type="button" title="重做" aria-label="重做" data-testid="shared-redo" :disabled="!current || !canRedo" @click="moveHistory('redo')"><AppIcon name="redo" :size="17"/></button>
        <button type="button" title="保存当前文档副本（Ctrl / ⌘ + S）" data-testid="shared-backup" :disabled="!current" @click="backup"><AppIcon name="save" :size="17"/><span>保存</span></button>
        <button type="button" title="导出 SVG 矢量图" data-testid="shared-export-svg" :disabled="!current || operationBusy" @click="imageExport('svg')"><AppIcon name="shapes" :size="17"/><span>SVG</span></button>
        <button type="button" title="导出 PNG 图片" data-testid="shared-export-png" :disabled="!current || operationBusy" @click="imageExport('png')"><AppIcon name="image" :size="17"/><span>PNG</span></button>
        <button type="button" :title="theme === 'light' ? '深色主题' : '浅色主题'" :aria-label="theme === 'light' ? '深色主题' : '浅色主题'" @click="theme = theme === 'light' ? 'dark' : 'light'"><AppIcon :name="theme === 'light' ? 'moon' : 'sun'" :size="17"/></button>
      </nav>
    </header>
    <div v-if="current && (phase === 'offline' || phase === 'conflict' || phase === 'stopped')" class="shared-notice" :data-testid="phase === 'conflict' ? 'shared-conflict' : 'shared-offline'" role="alert">
      <AppIcon name="alert" :size="17"/>
      <span>{{ phase === 'conflict' ? '此设备与远端都有修改，已保留你的版本。请选择继续使用的版本。' : '连接已断开，本地修改仍保留在此页面。离开前请下载副本。' }}</span>
      <button v-if="phase === 'conflict'" type="button" @click="serverControl?.open()">选择版本</button>
      <button v-else type="button" data-testid="shared-retry" @click="connect">重试连接</button>
      <button type="button" @click="backup">下载副本</button>
    </div>
    <section v-if="!current" class="shared-empty" aria-live="polite">
      <span v-if="connecting" class="spinner" aria-hidden="true"/><AppIcon v-else name="server" :size="36"/>
      <h1>{{ connecting ? '正在连接共享文档' : '暂时无法连接' }}</h1>
      <p>{{ connecting ? '正在获取桌面端的最新内容…' : error }}</p>
      <button v-if="!connecting" type="button" data-testid="shared-retry" @click="connect"><AppIcon name="refresh" :size="16"/>重试连接</button>
    </section>
    <div v-else class="shared-editor">
      <CodeDiagramEditor v-if="current.kind === 'mermaid'" :key="current.id" ref="editor" :source="current.source" :diagram-style="current.diagramStyle" :theme="theme" @change="changeSource" @change-style="changeStyle" @create-flow="downloadEditable" @export="imageExport" @status="announce">
        <template #server><ServerControl ref="serverControl" :native="false" :status="serverStatus" :document-id="current.id" :document-title="current.title" :web-url="webUrl" :sync-phase="phase" :conflict="Boolean(syncState.conflict)" :busy="resolving" :error="error" @retry="connect" @resolve-conflict="resolveConflict"/></template>
      </CodeDiagramEditor>
      <SceneEditor v-else :key="current.id" ref="editor" :scene="current.scene" :mode="current.kind" :theme="theme" @change="changeScene" @status="announce" @export="imageExport">
        <template #server><ServerControl ref="serverControl" :native="false" :status="serverStatus" :document-id="current.id" :document-title="current.title" :web-url="webUrl" :sync-phase="phase" :conflict="Boolean(syncState.conflict)" :busy="resolving" :error="error" @retry="connect" @resolve-conflict="resolveConflict"/></template>
      </SceneEditor>
    </div>
    <footer class="shared-footer">
      <span class="shared-message" :class="{ 'is-error': messageError }" role="status">{{ message || '共享页面只编辑当前文档' }}</span>
      <span class="shared-status" data-testid="shared-status" :data-phase="phase" :data-revision="syncState.revision" :title="error || phaseText" role="status"><span v-if="connecting || phase === 'syncing' || operationBusy" class="spinner small" aria-hidden="true"/><AppIcon v-else :name="phase === 'synced' ? 'check' : ['offline', 'conflict', 'stopped'].includes(phase) ? 'alert' : 'clock'" :size="13"/>{{ phaseText }}</span>
    </footer>
  </main>
</template>

<style scoped>
.shared-workspace { height: 100dvh; }
.shared-header { flex: none; display: flex; align-items: center; gap: 16px; min-height: 58px; padding: 9px 15px; border-bottom: 1px solid var(--ui-line); background: var(--ui-surface); }
.shared-heading { display: flex; align-items: center; gap: 10px; min-width: 100px; flex: 1; }
.shared-heading > svg { color: var(--ui-accent); }.shared-heading > div { min-width: 0; }.shared-heading strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }.shared-heading small { display: block; color: var(--ui-muted); margin-top: 4px; font-size: 10px; }
.shared-actions { display: flex; align-items: center; gap: 3px; flex: none; }
.shared-actions button, .shared-notice button, .shared-empty button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--ui-line); border-radius: 6px; background: var(--ui-surface); padding: 7px 9px; font-size: 11px; white-space: nowrap; }
.shared-actions button { border-color: transparent; }.shared-actions button:hover:not(:disabled), .shared-notice button:hover, .shared-empty button:hover { background: var(--ui-hover); color: var(--ui-accent); }
.shared-editor { flex: 1; min-height: 0; min-width: 0; display: flex; overflow: hidden; }.shared-editor > :deep(*) { width: 100%; min-width: 0; }
.shared-notice { flex: none; display: flex; align-items: center; gap: 9px; padding: 8px 14px; border-bottom: 1px solid #d9770644; background: #d9770610; font-size: 11px; line-height: 1.6; }.shared-notice > svg { color: #d97706; }.shared-notice > span { flex: 1; }.shared-notice button { font-size: 10px; padding: 5px 8px; }
.shared-empty { display: flex; flex: 1; align-items: center; justify-content: center; flex-direction: column; gap: 12px; padding: 30px; text-align: center; }.shared-empty > svg { color: var(--ui-accent); }.shared-empty h1 { font-size: 18px; margin: 5px 0 0; font-weight: 600; }.shared-empty p { font-size: 12px; color: var(--ui-muted); margin: 0 0 8px; line-height: 1.8; max-width: 430px; }
.shared-footer { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 13px; min-height: 29px; border-top: 1px solid var(--ui-line); background: var(--ui-surface); color: var(--ui-muted); font-size: 10px; }
.shared-message { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }.shared-message.is-error { color: #dc2626; }.shared-status { display: flex; align-items: center; gap: 5px; white-space: nowrap; }.shared-status[data-phase=synced] > svg { color: #16a34a; }.shared-status[data-phase=conflict], .shared-status[data-phase=offline] { color: #d97706; }
@media (max-width: 640px) { .shared-header { flex-wrap: wrap; gap: 7px; padding: 8px; }.shared-heading { min-width: 0; }.shared-heading strong { font-size: 12px; }.shared-heading small { font-size: 9px; }.shared-actions { width: 100%; justify-content: flex-end; }.shared-actions button { padding: 6px 9px; }.shared-notice { flex-wrap: wrap; padding: 8px; }.shared-notice > span { flex-basis: calc(100% - 28px); }.shared-notice button:first-of-type { margin-left: 26px; }.shared-footer { padding: 6px 8px; font-size: 9px; }.shared-message { max-width: 52%; } }
</style>
