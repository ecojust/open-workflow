<script setup lang="ts">
import AppIcon from './AppIcon.vue'
type Theme = 'light' | 'dark' | 'system'
const props = defineProps<{ theme: Theme; effectiveTheme: 'light' | 'dark'; infoOpen: boolean }>()
const emit = defineEmits<{ 'update:theme': [theme: Theme]; info: [] }>()
const themes: { id: Theme; label: string; icon: string }[] = [
  { id: 'light', label: '浅色主题', icon: 'sun' },
  { id: 'dark', label: '深色主题', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'monitor' },
]
</script>
<template>
  <div class="header-controls" role="group" aria-label="外观与信息" @keydown.space.stop @keyup.space.stop>
    <div class="theme-switch" role="group" aria-label="界面主题">
      <button v-for="option in themes" :key="option.id" type="button" :data-testid="`theme-${option.id}`" :aria-label="option.label" :title="option.id === 'system' && props.theme === 'system' ? `跟随系统（当前为${props.effectiveTheme === 'dark' ? '深色' : '浅色'}）` : option.label" :aria-pressed="props.theme === option.id" @click="emit('update:theme', option.id)"><AppIcon :name="option.icon" :size="17"/></button>
    </div>
    <button class="header-info" type="button" title="关于 Open Workflow" aria-label="关于 Open Workflow" aria-haspopup="dialog" :aria-expanded="infoOpen" @click="emit('info')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></svg></button>
  </div>
</template>
<style scoped>
.header-controls{display:flex;align-items:center;gap:4px;flex:none}
.theme-switch{display:flex;flex:none;gap:2px;padding:3px;border:1px solid var(--ui-line);border-radius:7px;background:var(--ui-bg)}
.theme-switch>button{display:grid;place-items:center;width:28px;height:26px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--ui-muted)}
.theme-switch>button:hover{background:var(--ui-hover);color:var(--ui-text)}
.theme-switch>button[aria-pressed="true"]{background:var(--ui-surface);color:var(--ui-accent);box-shadow:0 1px 3px #0002}
.theme-switch>button:focus-visible,.header-info:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.header-info{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--ui-muted)}
.header-info:hover{background:var(--ui-hover);color:var(--ui-text)}
@media(max-width:420px){.header-controls{gap:2px}.header-info{width:28px;height:30px}}
</style>
