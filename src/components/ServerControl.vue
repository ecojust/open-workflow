<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { ServerStatus } from '../core/sharing.ts'
import AppIcon from './AppIcon.vue'

const props = withDefaults(defineProps<{
  native: boolean
  status: ServerStatus
  documentId: string
  documentTitle: string
  busy?: boolean
  error?: string
  syncPhase?: string
  conflict?: boolean
  webUrl?: string
}>(), { busy: false, error: '', syncPhase: 'idle', conflict: false, webUrl: '' })
const emit = defineEmits<{ start: []; stop: []; retry: []; resolveConflict: [version: 'remote' | 'local'] }>()
const instanceId = useId(), titleId = `server-title-${instanceId}`, descriptionId = `server-description-${instanceId}`
const opened = ref(false), trigger = ref<HTMLButtonElement>(), dialog = ref<HTMLElement>()
const target = ref<string | HTMLElement>('body'), copyMessage = ref(''), copyFailed = ref(false), copying = ref('')
let previousFocus: HTMLElement | undefined, copyGeneration = 0, disposed = false
const remote = computed(() => Boolean(props.webUrl))
const isCurrent = computed(() => props.status.running && props.status.documentId === props.documentId)
const otherDocument = computed(() => props.status.running && !isCurrent.value && !remote.value)
const hasConflict = computed(() => props.conflict || props.syncPhase === 'conflict')
const addresses = computed(() => [...new Set(props.status.urls.filter(url => url.trim()))])
const sharedTitle = computed(() => remote.value ? props.documentTitle : props.status.title || (isCurrent.value ? props.documentTitle : '未命名文档'))
const phase = computed(() => hasConflict.value ? 'conflict' : props.syncPhase)
const phaseText = computed(() => ({
  idle: props.status.running || remote.value ? '等待同步' : '尚未开启共享',
  connecting: '正在连接…', synced: '修改已同步', pending: '有修改等待同步', syncing: '正在同步修改…',
  waiting: '正在完成本地输入', offline: '连接已断开', conflict: '需要选择保留的版本', stopped: '共享已停止',
  error: '同步未完成',
}[phase.value] || phase.value))
const phaseNote = computed(() => ({
  pending: '本次修改正在等待发送。',
  waiting: '远端更新将在当前编辑结束后应用。',
  offline: '当前修改仍保留在此页面。连接恢复后可重试同步，也可通过顶部“保存”保留副本。',
  stopped: remote.value ? '桌面端已停止此服务。重新开启后，请使用新的共享链接进入；当前内容可通过顶部“保存”保留。' : '重新开启服务后会生成新的共享链接。',
}[phase.value] || ''))
const phaseBusy = computed(() => ['connecting', 'syncing', 'waiting'].includes(phase.value))
const canRetry = computed(() => (remote.value || props.status.running) && !hasConflict.value && (Boolean(props.error) || ['offline', 'error'].includes(phase.value)))
const triggerTitle = computed(() => hasConflict.value ? 'Server · 同步冲突待处理' : remote.value ? 'Server · 共享连接' : props.status.running ? `Server · 正在共享 ${sharedTitle.value}` : 'Server · 局域网共享')

function controls(): HTMLElement[] {
  return [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') || [])].filter(element => element.getClientRects().length)
}
function keepFocus(event: FocusEvent) {
  if (!opened.value || !dialog.value || dialog.value.contains(event.target as Node)) return
  dialog.value.focus({ preventScroll: true })
}
async function open(startIfStopped = false) {
  if (opened.value) return
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  await nextTick()
  if (disposed) return
  target.value = trigger.value?.closest<HTMLElement>('.app-shell') || document.body
  opened.value = true; copyMessage.value = ''
  document.addEventListener('focusin', keepFocus, true)
  await nextTick()
  dialog.value?.focus({ preventScroll: true })
  if (startIfStopped && props.native && !remote.value && !props.status.running && !props.busy) emit('start')
}
function close() {
  if (!opened.value) return
  opened.value = false; copyGeneration++; copying.value = ''; copyMessage.value = ''
  document.removeEventListener('focusin', keepFocus, true)
  nextTick(() => (previousFocus?.isConnected ? previousFocus : trigger.value)?.focus({ preventScroll: true }))
}
function keydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Escape') { event.preventDefault(); close(); return }
  if (event.key !== 'Tab') return
  const items = controls(), first = items[0], last = items.at(-1), active = document.activeElement
  if (!items.length) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && (active === first || active === dialog.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (active === last || active === dialog.value)) { event.preventDefault(); first?.focus() }
}
async function copyAddress(url: string, event: MouseEvent) {
  const generation = ++copyGeneration
  const input = (event.currentTarget as HTMLElement).closest('.server-address-row')?.querySelector<HTMLInputElement>('input')
  copying.value = url; copyMessage.value = ''; copyFailed.value = false
  let copied = false
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); copied = true }
  } catch { /* Plain HTTP pages can copy through the selected address below. */ }
  if (disposed || generation !== copyGeneration || !opened.value) return
  if (!copied && input?.isConnected) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    input.focus({ preventScroll: true }); input.select(); input.setSelectionRange(0, input.value.length)
    try { copied = document.execCommand('copy') } catch { copied = false }
    if (copied && active?.isConnected && dialog.value?.contains(active)) active.focus({ preventScroll: true })
  }
  if (disposed || generation !== copyGeneration) return
  copying.value = ''; copyFailed.value = !copied
  copyMessage.value = copied ? '链接已复制' : '链接已选中，请按 Ctrl / ⌘ + C 复制，或长按地址复制。'
}
watch(hasConflict, value => { if (value) void open() }, { immediate: true })
onMounted(() => { target.value = trigger.value?.closest<HTMLElement>('.app-shell') || document.body })
onBeforeUnmount(() => { disposed = true; copyGeneration++; document.removeEventListener('focusin', keepFocus, true) })
defineExpose({ open, close })
</script>

<template>
  <button ref="trigger" type="button" class="server-trigger" :class="{ 'is-running': status.running || remote, 'has-conflict': hasConflict }" :title="triggerTitle" aria-label="Server 局域网共享" aria-haspopup="dialog" :aria-expanded="opened" data-testid="server-toggle" @click="open(true)">
    <AppIcon name="server" :size="17"/><span>Server</span><span v-if="hasConflict || status.running || remote" class="server-dot" aria-hidden="true"/>
  </button>
  <Teleport :to="target">
    <div v-if="opened" class="server-backdrop" @click.self="close" @keydown="keydown" @pointerdown.stop>
      <section ref="dialog" class="server-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId" tabindex="-1" data-testid="server-dialog">
        <header class="server-header"><div><AppIcon name="server" :size="21"/><h2 :id="titleId">Server <span>局域网共享</span></h2></div><button type="button" class="server-close" aria-label="关闭 Server 设置" data-testid="server-close" @click="close"><AppIcon name="close" :size="18"/></button></header>
        <div class="server-content">
          <p :id="descriptionId" class="server-description">{{ remote ? '在浏览器中编辑当前共享文档，修改会与桌面端同步。' : native ? '开启后，同一局域网内持有链接的人可编辑此文档，修改会同步。' : '浏览器无法监听局域网端口。请在桌面应用中打开文档并开启 Server，再用共享链接进入。' }}</p>
          <div class="server-document" data-testid="server-document"><span>{{ remote ? '共享文档' : status.running ? '正在共享' : '当前文档' }}</span><strong>{{ status.running || remote ? sharedTitle : documentTitle || '未命名文档' }}</strong><small v-if="status.running && !remote">{{ otherDocument ? '其他文档' : '当前文档' }}<template v-if="status.port"> · 端口 {{ status.port }}</template></small></div>
          <p v-if="otherDocument" class="server-switch-note">当前正在共享“{{ sharedTitle }}”。点击下方按钮可改为共享“{{ documentTitle || '未命名文档' }}”。</p>

          <section v-if="status.running || remote" class="server-sync" :class="{ 'is-offline': phase === 'offline' || phase === 'stopped', 'is-conflict': hasConflict }" aria-label="同步状态" data-testid="server-sync-status">
            <div class="server-sync-heading" role="status"><span v-if="phaseBusy" class="server-spinner" aria-hidden="true"/><AppIcon v-else :name="hasConflict || phase === 'offline' || phase === 'stopped' || error ? 'alert' : phase === 'synced' ? 'check' : 'refresh'" :size="16"/><strong>{{ phaseText }}</strong><span v-if="status.running && !remote" class="server-running">服务运行中</span></div>
            <p v-if="phaseNote">{{ phaseNote }}</p>
          </section>
          <section v-if="hasConflict" class="server-conflict" role="alert" data-testid="server-conflict">
            <h3><AppIcon name="alert" :size="17"/>同一文档有两份不同的修改</h3>
            <p>请选择继续使用的版本。采用远端版本会替换当前内容；保留我的修改会将当前内容同步到服务端。需要留存当前版本时，可先关闭此窗口，通过顶部“保存”导出副本。</p>
            <div class="server-conflict-actions"><button type="button" :disabled="busy" data-testid="server-conflict-remote" @click="emit('resolveConflict', 'remote')">采用远端版本</button><button type="button" class="server-primary" :disabled="busy" data-testid="server-conflict-local" @click="emit('resolveConflict', 'local')">保留我的修改</button></div>
          </section>
          <div v-if="error" class="server-error" role="alert" data-testid="server-error"><AppIcon name="alert" :size="16"/><span>{{ error }}</span></div>

          <section v-if="remote" class="server-addresses" aria-label="当前共享链接">
            <h3>当前共享链接</h3><div class="server-address-row"><input :value="webUrl" readonly aria-label="当前共享链接" spellcheck="false" @focus="($event.target as HTMLInputElement).select()"><button type="button" title="复制当前共享链接" aria-label="复制当前共享链接" data-testid="server-copy-url" :disabled="copying === webUrl" @click="copyAddress(webUrl, $event)"><AppIcon name="copy" :size="16"/></button></div>
          </section>
          <template v-else-if="native && status.running">
            <section class="server-addresses" aria-label="局域网地址">
              <h3>局域网地址 <span>{{ addresses.length ? '同一局域网设备打开任一地址即可编辑' : '暂未发现可用地址' }}</span></h3>
              <div v-for="(url, index) in addresses" :key="url" class="server-address-row"><input :value="url" readonly :aria-label="`局域网地址 ${index + 1}`" spellcheck="false" @focus="($event.target as HTMLInputElement).select()"><button type="button" :title="`复制局域网地址 ${index + 1}`" :aria-label="`复制局域网地址 ${index + 1}`" data-testid="server-copy-url" :disabled="copying === url" @click="copyAddress(url, $event)"><AppIcon name="copy" :size="16"/></button></div>
              <p v-if="!addresses.length" class="server-hint">请确认设备已连接网络；如有本机地址，可先在这台设备上打开。</p>
            </section>
            <section v-if="status.localUrl" class="server-addresses" aria-label="本机地址"><h3>本机地址 <span>仅用于这台设备</span></h3><div class="server-address-row"><input :value="status.localUrl" readonly aria-label="本机地址" spellcheck="false" @focus="($event.target as HTMLInputElement).select()"><button type="button" title="复制本机地址" aria-label="复制本机地址" data-testid="server-copy-local" :disabled="copying === status.localUrl" @click="copyAddress(status.localUrl, $event)"><AppIcon name="copy" :size="16"/></button></div></section>
          </template>
          <p v-if="copyMessage" class="server-copy-message" :class="{ 'copy-failed': copyFailed }" role="status" data-testid="server-copy-status"><AppIcon :name="copyFailed ? 'copy' : 'check'" :size="14"/>{{ copyMessage }}</p>
          <p v-if="native && status.running && !remote" class="server-hint">停止服务后，已打开的共享页面将停止同步。</p>
        </div>
        <footer class="server-footer">
          <span v-if="busy" class="server-working" role="status"><span class="server-spinner" aria-hidden="true"/>正在处理…</span>
          <button v-if="canRetry" type="button" :disabled="busy" data-testid="server-retry" @click="emit('retry')"><AppIcon name="refresh" :size="15"/>重试同步</button>
          <template v-if="native && !remote">
            <button v-if="status.running" type="button" class="server-stop" :disabled="busy" data-testid="server-stop" @click="emit('stop')">停止服务</button>
            <button v-if="!isCurrent" type="button" class="server-primary" :disabled="busy || !documentId" data-testid="server-start" @click="emit('start')"><AppIcon name="server" :size="15"/>{{ otherDocument ? '改为共享当前文档' : '开启服务' }}</button>
            <button v-else type="button" @click="close">完成</button>
          </template>
          <button v-else type="button" @click="close">完成</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.server-trigger { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none; min-height: 32px; border: 1px solid var(--ui-line, #e5eaf2); border-radius: 7px; padding: 6px 9px; background: var(--ui-surface, #fff); color: var(--ui-text, #253149); font: inherit; font-size: 12px; line-height: 1.3; white-space: nowrap; cursor: pointer; }
.server-trigger:hover, .server-trigger[aria-expanded="true"] { border-color: var(--ui-accent, #2563eb); color: var(--ui-accent, #2563eb); background: var(--ui-soft, #eaf1ff); }
.server-trigger > svg { color: var(--ui-accent, #2563eb); }
.server-dot { width: 6px; height: 6px; border-radius: 50%; background: #16a34a; }
.server-trigger.has-conflict .server-dot { background: #d97706; }
.server-trigger:focus-visible, .server-dialog button:focus-visible { outline: 2px solid var(--ui-accent, #2563eb); outline-offset: 3px; }
.server-backdrop { position: fixed; inset: 0; z-index: 140; display: flex; align-items: center; justify-content: center; padding: 20px; background: #101b335e; backdrop-filter: blur(3px); color: var(--ui-text, #253149); }
.server-dialog { display: flex; flex-direction: column; width: 570px; max-width: 100%; max-height: min(780px, calc(100dvh - 40px)); overflow: hidden; border: 1px solid var(--ui-line, #e5eaf2); border-radius: 12px; background: var(--ui-surface, #fff); box-shadow: 0 20px 64px #0f172a38; outline: none; font: 12px/1.65 system-ui, sans-serif; }
.server-header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px 12px; border-bottom: 1px solid var(--ui-line, #e5eaf2); }
.server-header > div { min-width: 0; display: flex; align-items: center; gap: 9px; }
.server-header > div > svg { color: var(--ui-accent, #2563eb); }
.server-header h2 { margin: 0; font-size: 16px; font-weight: 650; }
.server-header h2 span { margin-left: 6px; font-size: 12px; color: var(--ui-muted, #8490a3); font-weight: 400; }
.server-dialog button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 10px; border: 1px solid var(--ui-line, #e5eaf2); border-radius: 6px; background: var(--ui-surface, #fff); color: var(--ui-text, #253149); font: inherit; cursor: pointer; }
.server-dialog button:hover:not(:disabled) { border-color: var(--ui-accent, #2563eb); color: var(--ui-accent, #2563eb); background: var(--ui-hover, #f0f4fa); }
.server-dialog button:disabled { opacity: .48; cursor: default; }
.server-dialog .server-close { width: 30px; min-height: 30px; flex: none; padding: 0; border-color: transparent; }
.server-content { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px 17px; scrollbar-width: thin; scrollbar-color: var(--ui-line, #cbd5e1) transparent; overscroll-behavior: contain; }
.server-description, .server-switch-note, .server-hint { margin: 0; color: var(--ui-muted, #8490a3); font-size: 11px; line-height: 1.8; }
.server-description { margin-bottom: 13px; }
.server-document { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 10px; padding: 10px 12px; border: 1px solid var(--ui-line, #e5eaf2); border-radius: 7px; background: var(--ui-bg, #f5f7fb); }
.server-document > span { flex: none; color: var(--ui-muted, #8490a3); font-size: 10px; }
.server-document strong { min-width: 0; flex: 1; overflow-wrap: anywhere; font-weight: 600; font-size: 12px; }
.server-document small { color: var(--ui-muted, #8490a3); font-size: 10px; }
.server-switch-note { margin: 8px 1px 0; overflow-wrap: anywhere; }
.server-sync { margin-top: 13px; padding: 10px 12px; border: 1px solid var(--ui-line, #e5eaf2); border-radius: 7px; background: var(--ui-bg, #f5f7fb); }
.server-sync-heading { display: flex; align-items: center; gap: 7px; font-size: 11px; }
.server-sync-heading > svg { color: #16a34a; }
.server-sync-heading strong { font-weight: 550; }
.server-running { margin-left: auto; color: var(--ui-muted, #8490a3); font-size: 10px; }
.server-sync p { margin: 5px 0 0; color: var(--ui-muted, #8490a3); font-size: 10px; line-height: 1.8; }
.server-sync.is-offline .server-sync-heading > svg, .server-sync.is-conflict .server-sync-heading > svg { color: #d97706; }
.server-conflict { margin-top: 13px; padding: 12px; border: 1px solid #d9770659; border-radius: 7px; background: #d9770610; }
.server-conflict h3 { display: flex; align-items: center; gap: 7px; margin: 0; color: var(--ui-text, #253149); font-size: 12px; font-weight: 600; }
.server-conflict h3 > svg { color: #d97706; }
.server-conflict p { margin: 7px 0 11px; color: var(--ui-muted, #8490a3); font-size: 11px; line-height: 1.8; }
.server-conflict-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.server-conflict-actions > button { flex: 1; font-size: 11px; white-space: nowrap; }
.server-error { display: flex; align-items: flex-start; gap: 8px; margin-top: 13px; padding: 10px 12px; border: 1px solid #dc262650; border-radius: 7px; background: #dc26260c; font-size: 11px; }
.server-error > svg { flex: none; margin-top: 2px; color: #dc2626; }
.server-error > span { min-width: 0; overflow-wrap: anywhere; }
.server-addresses { margin-top: 15px; }
.server-addresses h3 { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 9px; margin: 0 0 6px; font-size: 11px; font-weight: 600; }
.server-addresses h3 span { font-size: 10px; color: var(--ui-muted, #8490a3); font-weight: 400; }
.server-address-row { display: flex; align-items: stretch; gap: 5px; margin-top: 6px; min-width: 0; }
.server-address-row input { display: block; flex: 1; min-width: 0; width: 0; padding: 7px 9px; border: 1px solid var(--ui-line, #e5eaf2); border-radius: 6px; background: var(--ui-bg, #f5f7fb); color: var(--ui-text, #253149); font: 11px/1.5 ui-monospace, monospace; }
.server-address-row input:focus { outline: 2px solid var(--ui-accent, #2563eb); outline-offset: 1px; }
.server-address-row button { flex: none; width: 34px; padding: 0; }
.server-copy-message { display: flex; align-items: flex-start; gap: 6px; margin: 9px 0 0; color: #15803d; font-size: 10px; }
.server-copy-message > svg { flex: none; margin-top: 1px; }
.server-copy-message.copy-failed { color: var(--ui-muted, #8490a3); }
.server-content > .server-hint { margin-top: 12px; }
.server-footer { display: flex; flex: none; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--ui-line, #e5eaf2); background: var(--ui-bg, #f5f7fb); }
.server-dialog .server-primary { color: #fff; background: #2563eb; border-color: #2563eb; }
.server-dialog .server-primary:hover:not(:disabled) { color: #fff; background: #1d4ed8; border-color: #1d4ed8; }
.server-dialog .server-stop { color: #dc2626; }
.server-working { margin-right: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--ui-muted, #8490a3); font-size: 10px; }
.server-spinner { display: inline-block; width: 12px; height: 12px; flex: none; border: 1.5px solid var(--ui-line, #e5eaf2); border-top-color: var(--ui-accent, #2563eb); border-radius: 50%; animation: server-spin .8s linear infinite; }
@keyframes server-spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) { .server-trigger { min-height: 31px; padding: 5px 7px; gap: 5px; font-size: 11px; }.server-backdrop { padding: 10px; }.server-dialog { max-height: calc(100dvh - 20px); }.server-header { padding: 12px 13px 10px; }.server-header h2 { font-size: 15px; }.server-header h2 span { font-size: 11px; }.server-content { padding: 12px 13px 14px; }.server-footer { padding: 10px 12px; gap: 6px; }.server-footer button { font-size: 11px; }.server-running { font-size: 9px; }.server-document small { width: 100%; padding-left: 0; } }
@media (prefers-reduced-motion: reduce) { .server-spinner { animation: none; } }
</style>
