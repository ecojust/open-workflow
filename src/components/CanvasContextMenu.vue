<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'

const props = defineProps<{
  x: number
  y: number
  hasSelection: boolean
  canEditText: boolean
  hasUnlocked: boolean
  allLocked: boolean
  canPaste: boolean
}>()
const emit = defineEmits<{ action: [action: string]; close: [] }>()

interface MenuItem { action: string; label: string; icon: string; shortcut?: string; disabled?: boolean; danger?: boolean }
const menu = ref<HTMLDivElement>()
const themeSource = ref<HTMLSpanElement>()
const position = ref({ left: 0, top: 0, maxHeight: 600, maxWidth: 260 })
const themeVariables = ref<Record<string, string>>({})
const ready = ref(false)
const activeAction = ref('')
const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
let resizeObserver: ResizeObserver | undefined
let themeObserver: MutationObserver | undefined
let layoutFrame: number | undefined
let mounted = false
let closing = false

const groups = computed<MenuItem[][]>(() => [
  [
    ...(props.canEditText ? [{ action: 'edit-text', label: '编辑文字', icon: 'text', shortcut: 'Enter', disabled: !props.hasUnlocked }] : []),
    { action: 'copy', label: '复制', icon: 'copy', shortcut: `${modifier}+C`, disabled: !props.hasSelection },
    { action: 'duplicate', label: '复制一份', icon: 'duplicate', shortcut: `${modifier}+D`, disabled: !props.hasSelection },
    { action: 'paste', label: '粘贴', icon: 'paste', shortcut: `${modifier}+V`, disabled: !props.canPaste },
    { action: 'select-all', label: '选择全部', icon: 'select', shortcut: `${modifier}+A` },
  ],
  [
    { action: 'front', label: '置于顶层', icon: 'front', disabled: !props.hasSelection || !props.hasUnlocked },
    { action: 'forward', label: '上移一层', icon: 'forward', disabled: !props.hasSelection || !props.hasUnlocked },
    { action: 'backward', label: '下移一层', icon: 'backward', disabled: !props.hasSelection || !props.hasUnlocked },
    { action: 'back', label: '置于底层', icon: 'back', disabled: !props.hasSelection || !props.hasUnlocked },
  ],
  [
    { action: 'lock', label: props.allLocked ? '解锁' : '锁定', icon: props.allLocked ? 'unlock' : 'lock', disabled: !props.hasSelection },
    { action: 'delete', label: '删除', icon: 'delete', shortcut: 'Delete', disabled: !props.hasSelection || !props.hasUnlocked, danger: true },
  ],
  [
    { action: 'export-svg', label: '导出全图 SVG', icon: 'svg' },
    { action: 'export-png', label: '导出全图 PNG', icon: 'image' },
    ...(props.hasSelection ? [
      { action: 'export-selection-svg', label: '导出选区 SVG', icon: 'selection-svg' },
      { action: 'export-selection-png', label: '导出选区 PNG', icon: 'selection-image' },
    ] : []),
  ],
])
const menuStyle = computed<CSSProperties>(() => ({
  ...themeVariables.value,
  left: `${position.value.left}px`,
  top: `${position.value.top}px`,
  maxHeight: `${position.value.maxHeight}px`,
  maxWidth: `${position.value.maxWidth}px`,
  visibility: ready.value ? 'visible' : 'hidden',
}))
const paths: Record<string, string> = {
  text: 'M4 5h16M12 5v14M8 19h8M4 5v3m16-3v3',
  copy: 'M8 8h12v13H8zM16 8V3H3v13h5',
  duplicate: 'M7 7h14v14H7zM17 7V3H3v14h4M11 14h6m-3-3v6',
  paste: 'M8 5H5v16h14V5h-3M8 3h8v4H8zM9 12h6m-6 4h6',
  select: 'M8 3H3v5m0 8v5h5m8 0h5v-5m0-8V3h-5M8 8h8v8H8z',
  front: 'M4 3h16M12 17V7m-4 4 4-4 4 4M5 17v4h14v-4',
  forward: 'M12 20V4m-5 5 5-5 5 5M5 16h4m6 0h4',
  backward: 'M12 4v16m-5-5 5 5 5-5M5 8h4m6 0h4',
  back: 'M4 21h16M12 7v10m-4-4 4 4 4-4M5 7V3h14v4',
  lock: 'M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3M12 14v3',
  unlock: 'M5 10h14v11H5zM8 10V7a4 4 0 0 1 7.5-2M12 14v3',
  delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  svg: 'M8 3h8v5H8zM3 16h5v5H3zM16 16h5v5h-5zM12 8v4M5.5 16v-4h13v4',
  image: 'M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M16 7h.01',
  'selection-svg': 'M7 3H3v4m0 10v4h4m10 0h4v-4m0-10V3h-4M8 9l-3 3 3 3m8-6 3 3-3 3m-3-7-2 10',
  'selection-image': 'M7 3H3v4m0 10v4h4m10 0h4v-4m0-10V3h-4M7 15l4-4 6 6H7zM15 7h.01',
}

function close() {
  if (closing) return
  closing = true
  emit('close')
}
function activate(item: MenuItem) {
  if (item.disabled || closing) return
  emit('action', item.action)
  close()
}
function enabledButtons(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') || [])]
}
function focusButton(button: HTMLButtonElement | undefined, reveal = false) {
  if (!button) return
  activeAction.value = button.dataset.action || ''
  button.focus({ preventScroll: true })
  if (reveal && menu.value) {
    const bounds = button.getBoundingClientRect(), viewport = menu.value.getBoundingClientRect()
    if (bounds.top < viewport.top + 6) menu.value.scrollTop -= viewport.top + 6 - bounds.top
    else if (bounds.bottom > viewport.bottom - 6) menu.value.scrollTop += bounds.bottom - viewport.bottom + 6
  }
}
function keydown(event: KeyboardEvent) {
  // Keep canvas shortcuts from consuming menu navigation or activating twice.
  event.stopPropagation()
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); return }
  const shortcut = event.ctrlKey || event.metaKey
    ? ({ c: 'copy', d: 'duplicate', v: 'paste', a: 'select-all' } as Record<string, string>)[event.key.toLowerCase()]
    : event.key === 'Delete' || event.key === 'Backspace' ? 'delete' : undefined
  if (shortcut && !event.altKey && !event.shiftKey) {
    event.preventDefault()
    const item = groups.value.flat().find(item => item.action === shortcut)
    if (item) activate(item)
    return
  }
  const buttons = enabledButtons()
  if (!buttons.length) return
  const index = buttons.findIndex(button => button === document.activeElement)
  let next: number | undefined
  if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % buttons.length
  else if (event.key === 'ArrowUp') next = index < 0 ? buttons.length - 1 : (index + buttons.length - 1) % buttons.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  if (next !== undefined) { event.preventDefault(); focusButton(buttons[next], true) }
}
function outside(event: Event) {
  if (!menu.value || event.composedPath().includes(menu.value)) return
  close()
}
function copyTheme() {
  if (!themeSource.value) return
  const style = getComputedStyle(themeSource.value), variables: Record<string, string> = {}
  for (const name of ['--ui-bg', '--ui-surface', '--ui-line', '--ui-text', '--ui-muted', '--ui-accent', '--ui-hover', '--ui-soft', '--ui-shadow']) {
    const value = style.getPropertyValue(name).trim()
    if (value) variables[name] = value
  }
  variables.colorScheme = style.colorScheme
  themeVariables.value = variables
}
async function place() {
  if (!mounted || !menu.value) return
  const margin = 8
  const viewport = window.visualViewport
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0
  const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
  position.value.maxWidth = Math.max(0, width - margin * 2)
  position.value.maxHeight = Math.max(0, height - margin * 2)
  await nextTick()
  if (!mounted || !menu.value) return
  const bounds = menu.value.getBoundingClientRect()
  position.value.left = Math.max(left + margin, Math.min(props.x, left + width - bounds.width - margin))
  position.value.top = Math.max(top + margin, Math.min(props.y, top + height - bounds.height - margin))
  ready.value = true
}
function scheduleLayout() {
  if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame)
  layoutFrame = requestAnimationFrame(() => { layoutFrame = undefined; void place() })
}
watch(() => [props.x, props.y], async () => {
  closing = false
  await place()
  if (mounted) focusButton(enabledButtons()[0])
})
watch(() => [props.hasSelection, props.canEditText], scheduleLayout)
watch(groups, async () => {
  await nextTick()
  if (!mounted || !menu.value?.contains(document.activeElement)) return
  if (!(document.activeElement instanceof HTMLButtonElement) || document.activeElement.disabled) focusButton(enabledButtons()[0])
})
onMounted(async () => {
  mounted = true
  copyTheme()
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('contextmenu', outside, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', scheduleLayout)
  window.visualViewport?.addEventListener('resize', scheduleLayout)
  window.visualViewport?.addEventListener('scroll', scheduleLayout)
  resizeObserver = new ResizeObserver(scheduleLayout)
  if (menu.value) resizeObserver.observe(menu.value)
  const themeHost = themeSource.value?.closest('.app-shell') || document.documentElement
  themeObserver = new MutationObserver(copyTheme)
  themeObserver.observe(themeHost, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
  await place()
  if (mounted) focusButton(enabledButtons()[0])
})
onBeforeUnmount(() => {
  mounted = false
  if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame)
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('contextmenu', outside, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', scheduleLayout)
  window.visualViewport?.removeEventListener('resize', scheduleLayout)
  window.visualViewport?.removeEventListener('scroll', scheduleLayout)
})
</script>

<template>
  <span ref="themeSource" hidden aria-hidden="true" />
  <Teleport to="body">
    <div ref="menu" class="canvas-context-menu" :style="menuStyle" role="menu" aria-label="画布菜单" data-testid="canvas-context-menu" @keydown="keydown" @pointerdown.stop @contextmenu.prevent.stop>
      <template v-for="(group, index) in groups" :key="index">
        <div v-if="index" class="context-separator" role="separator" />
        <button v-for="item in group" :key="item.action" type="button" role="menuitem" :data-action="item.action" :disabled="item.disabled" :aria-disabled="item.disabled || undefined" :tabindex="activeAction === item.action ? 0 : -1" :class="{ 'is-danger': item.danger }" @focus="activeAction = item.action" @click="activate(item)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[item.icon]" /></svg>
          <span>{{ item.label }}</span>
          <kbd v-if="item.shortcut" aria-hidden="true">{{ item.shortcut }}</kbd>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.canvas-context-menu { position: fixed; z-index: 110; width: 242px; box-sizing: border-box; padding: 5px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--ui-line, #e5eaf2); border-radius: 9px; background: var(--ui-surface, #fff); color: var(--ui-text, #253149); box-shadow: var(--ui-shadow, 0 10px 32px #17253d26); font: 12px/1.4 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; scrollbar-width: thin; scrollbar-color: var(--ui-line, #dce2ed) transparent; }
.canvas-context-menu button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 31px; padding: 6px 9px; border: 0; border-radius: 5px; background: transparent; color: inherit; font: inherit; text-align: left; white-space: nowrap; cursor: pointer; touch-action: manipulation; }
.canvas-context-menu button svg { width: 16px; height: 16px; flex: none; color: var(--ui-muted, #8490a3); }
.canvas-context-menu button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.canvas-context-menu button kbd { margin-left: auto; padding-left: 12px; color: var(--ui-muted, #8490a3); font-size: 10px; line-height: 1.4; font-family: inherit; white-space: nowrap; }
.canvas-context-menu button:hover:not(:disabled), .canvas-context-menu button:focus-visible { background: var(--ui-hover, #f0f4fa); outline: none; }
.canvas-context-menu button:focus-visible { box-shadow: inset 0 0 0 1.5px var(--ui-accent, #2563eb); }
.canvas-context-menu button:disabled { color: var(--ui-muted, #8490a3); opacity: .45; cursor: default; }
.canvas-context-menu button.is-danger:not(:disabled) { color: #d85364; }
.canvas-context-menu button.is-danger:not(:disabled) svg { color: inherit; }
.context-separator { height: 1px; margin: 5px 4px; background: var(--ui-line, #e5eaf2); }
.canvas-context-menu::-webkit-scrollbar { width: 5px; }
.canvas-context-menu::-webkit-scrollbar-thumb { border-radius: 5px; background: var(--ui-line, #dce2ed); }
</style>
