<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { compileMermaid, MermaidSyntaxError, type MermaidResult } from '../core/mermaid.ts'
import { sceneToSvg } from '../core/svg.ts'
import { clone, type Scene } from '../core/types.ts'
import { DIAGRAM_TEMPLATES, DIAGRAM_KIND_LABELS } from '../core/diagrams/catalog.ts'
import type { DiagramKind, DiagramTemplate } from '../core/diagrams/common.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ source: string; theme: 'light' | 'dark' }>()
const emit = defineEmits<{ change: [source: string]; createFlow: [scene: Scene]; status: [message: string] }>()
const draft = ref(props.source), sourceInput = ref<HTMLTextAreaElement>(), error = ref(''), errorLine = ref(0)
const compiled = ref<MermaidResult | null>(null), parsing = ref(false), scrollTop = ref(0), zoom = ref(1)
type LibraryTemplate = DiagramTemplate & { kind: DiagramKind }
const templatesOpen = ref(false), templateCategory = ref('all'), templateSearch = ref('')
const pendingTemplate = ref<LibraryTemplate>(), templateDialog = ref<HTMLElement>(), templateSearchInput = ref<HTMLInputElement>(), templateButton = ref<HTMLButtonElement>()
let timer: ReturnType<typeof setTimeout> | undefined, published = props.source
const lines = computed(() => Array.from({ length: draft.value.split('\n').length }, (_, index) => index + 1).join('\n'))
const svg = computed(() => compiled.value ? sceneToSvg(compiled.value.scene, { background: true }) : '')
const kindLabel = computed(() => compiled.value ? DIAGRAM_KIND_LABELS[compiled.value.kind] : '图表')
const elementCount = computed(() => compiled.value?.scene.elements.length ?? 0)
const categories = computed(() => [...new Set(DIAGRAM_TEMPLATES.map(template => template.category))])
const kindsCount = computed(() => new Set(DIAGRAM_TEMPLATES.map(template => template.kind)).size)
const kindsList = computed(() => [...new Set(DIAGRAM_TEMPLATES.map(template => DIAGRAM_KIND_LABELS[template.kind]))].join('、'))
const visibleTemplates = computed(() => {
  const search = templateSearch.value.trim().toLocaleLowerCase()
  return DIAGRAM_TEMPLATES.filter(template => (templateCategory.value === 'all' || template.category === templateCategory.value)
    && (!search || `${template.title} ${template.description} ${DIAGRAM_KIND_LABELS[template.kind]} ${template.kind}`.toLocaleLowerCase().includes(search)))
})
const syntaxTemplate = computed(() => DIAGRAM_TEMPLATES.find(template => template.kind === (compiled.value?.kind || 'flowchart')))
const syntaxExample = computed(() => syntaxTemplate.value?.source || '')

async function openTemplates() {
  flush(); pendingTemplate.value = undefined; templatesOpen.value = true
  await nextTick(); templateSearchInput.value?.focus({ preventScroll: true })
}
function closeTemplates(focusSource = false) {
  templatesOpen.value = false; pendingTemplate.value = undefined
  nextTick(() => (focusSource ? sourceInput.value : templateButton.value)?.focus({ preventScroll: true }))
}
function chooseTemplate(template: LibraryTemplate) {
  if (draft.value === template.source) { closeTemplates(); emit('status', '当前源码已经是此模板'); return }
  if (draft.value.trim()) {
    pendingTemplate.value = template
    nextTick(() => templateDialog.value?.querySelector<HTMLButtonElement>('[data-template-cancel]')?.focus({ preventScroll: true }))
    return
  }
  applyTemplate(template)
}
function applyTemplate(template: LibraryTemplate) {
  // Publish pending input separately so replacing a template is one undoable change.
  clearTimeout(timer); publish()
  draft.value = template.source; publish(); parse(); zoom.value = 1; scrollTop.value = 0
  if (sourceInput.value) sourceInput.value.scrollTop = 0
  closeTemplates(true); emit('status', `已使用“${template.title}”，可撤销恢复原源码`)
}
function backToTemplates() {
  pendingTemplate.value = undefined
  nextTick(() => templateSearchInput.value?.focus({ preventScroll: true }))
}
function dialogKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Escape') { event.preventDefault(); if (pendingTemplate.value) backToTemplates(); else closeTemplates(); return }
  if (event.key !== 'Tab' || !templateDialog.value) return
  const controls = [...templateDialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]')]
    .filter(element => element.getClientRects().length)
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}

function publish() { if (draft.value !== published) { published = draft.value; emit('change', draft.value) } }
function parse() {
  parsing.value = false
  try {
    compiled.value = compileMermaid(draft.value); error.value = ''; errorLine.value = 0
    emit('status', `${kindLabel.value} · ${elementCount.value} 个图元`)
  } catch (cause) {
    compiled.value = null; error.value = cause instanceof Error ? cause.message : '无法解析此源码。'
    errorLine.value = cause instanceof MermaidSyntaxError ? cause.line : 0
    emit('status', 'Mermaid 源码需要修正')
  }
}
function onInput() {
  clearTimeout(timer); parsing.value = true
  timer = setTimeout(() => { publish(); parse() }, 220)
}
function flush() { clearTimeout(timer); publish(); parse() }
function createFlow() { flush(); if (compiled.value) emit('createFlow', clone(compiled.value.scene)) }
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  event.preventDefault()
  const input = sourceInput.value!
  const start = input.selectionStart, end = input.selectionEnd
  draft.value = draft.value.slice(0, start) + '  ' + draft.value.slice(end)
  nextTick(() => { input.selectionStart = input.selectionEnd = start + 2 })
  onInput()
}
function locateError() {
  if (!sourceInput.value || !errorLine.value) return
  const preceding = draft.value.split('\n').slice(0, errorLine.value - 1).join('\n')
  const start = preceding.length + (errorLine.value > 1 ? 1 : 0)
  sourceInput.value.focus(); sourceInput.value.setSelectionRange(start, draft.value.indexOf('\n', start) < 0 ? draft.value.length : draft.value.indexOf('\n', start))
  sourceInput.value.scrollTop = Math.max(0, (errorLine.value - 3) * 23)
  scrollTop.value = sourceInput.value.scrollTop
}
watch(() => props.source, value => {
  if (value === draft.value) { published = value; return }
  clearTimeout(timer); published = value; draft.value = value; parse()
})
onBeforeUnmount(() => { clearTimeout(timer); publish() })
defineExpose({ flush })
parse()
</script>

<template>
  <section class="mermaid-editor" :class="{ 'is-dark': theme === 'dark' }" aria-label="Mermaid 编辑器">
    <div class="mermaid-toolbar" :inert="templatesOpen">
      <div class="mermaid-title"><AppIcon name="code" :size="18"/><strong>Mermaid</strong><span class="mermaid-badge">{{ kindsCount }} 类图表</span></div>
      <div class="mermaid-toolbar-actions"><button ref="templateButton" type="button" class="mermaid-template-toggle" aria-label="图表类型与模板" :aria-expanded="templatesOpen" aria-haspopup="dialog" data-testid="mermaid-template-toggle" @click="openTemplates"><AppIcon name="templates" :size="16"/><span>图表模板</span><AppIcon name="chevron" :size="12"/></button>
      <button type="button" class="mermaid-convert" aria-label="转为可编辑流程图" data-testid="mermaid-create-copy" :disabled="!compiled || parsing" @click="createFlow"><AppIcon name="duplicate" :size="16"/><span>创建可编辑副本</span></button></div>
    </div>
    <div class="mermaid-workspace" :inert="templatesOpen">
      <div class="mermaid-source-panel">
        <div class="mermaid-panel-title"><span>源码</span><span>修改后自动预览</span></div>
        <div class="mermaid-code">
          <div class="mermaid-gutter" aria-hidden="true"><pre :style="{ transform: `translateY(${-scrollTop}px)` }">{{ lines }}</pre></div>
          <textarea ref="sourceInput" v-model="draft" aria-label="Mermaid 源码" data-testid="mermaid-source" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" :aria-invalid="Boolean(error)" :aria-describedby="error ? 'mermaid-error-detail' : undefined" @input="onInput" @blur="flush" @keydown="onKeydown" @scroll="scrollTop = ($event.target as HTMLTextAreaElement).scrollTop" />
        </div>
        <details class="mermaid-help">
          <summary><AppIcon name="chevron-right" :size="13"/><AppIcon name="help" :size="14"/><span>语法示例与支持范围</span></summary>
          <p><strong>{{ syntaxTemplate ? DIAGRAM_KIND_LABELS[syntaxTemplate.kind] : '图表' }}</strong> · {{ syntaxTemplate?.description }}</p>
          <pre class="mermaid-syntax-example">{{ syntaxExample }}</pre>
          <p>模板包含{{ kindsList }}。示例源码可直接编辑。</p>
          <p>支持这些类型的常用语法子集；未实现的指令会提示具体行号。源码独立保存，创建可编辑副本后可调整图元；副本的修改不会反写源码。</p>
        </details>
      </div>
      <div class="mermaid-preview-panel">
        <div class="mermaid-panel-title"><span>预览 <span v-if="compiled" class="mermaid-preview-kind"><AppIcon :name="compiled.kind" :size="12"/>{{ kindLabel }}</span></span><div class="mermaid-zoom"><button type="button" aria-label="缩小预览" :disabled="zoom <= .4" @click="zoom = Math.max(.4, zoom - .2)"><AppIcon name="minus" :size="13"/></button><button type="button" aria-label="重置预览缩放" @click="zoom = 1">{{ Math.round(zoom * 100) }}%</button><button type="button" aria-label="放大预览" :disabled="zoom >= 3" @click="zoom = Math.min(3, zoom + .2)"><AppIcon name="plus" :size="13"/></button></div></div>
        <div v-if="parsing" class="mermaid-parsing" role="status"><span class="mermaid-spinner" />正在解析…</div>
        <div v-if="error && !parsing" id="mermaid-error-detail" class="mermaid-error" role="alert" data-testid="mermaid-error">
          <strong><AppIcon name="alert" :size="16"/>源码需要修正</strong><p>{{ error }}</p><button v-if="errorLine" type="button" @click="locateError"><AppIcon name="search" :size="14"/>定位到第 {{ errorLine }} 行</button>
        </div>
        <div v-if="compiled" class="mermaid-preview-scroll" :aria-busy="parsing">
          <div class="mermaid-preview" data-testid="mermaid-preview" :style="{ width: `${zoom * 100}%`, minWidth: `${zoom * 100}%` }" v-html="svg" />
        </div>
        <div v-if="compiled?.warnings.length" class="mermaid-warnings" role="status"><p v-for="warning in compiled.warnings" :key="warning">{{ warning }}</p></div>
        <div v-if="!compiled && !error && !parsing" class="mermaid-empty">在左侧输入源码，即可绘制图表。</div>
      </div>
    </div>
    <div v-if="templatesOpen" class="mermaid-library-backdrop" @click.self="closeTemplates()" @keydown="dialogKeydown">
      <section ref="templateDialog" class="mermaid-library" role="dialog" aria-modal="true" :aria-labelledby="pendingTemplate ? 'mermaid-replace-title' : 'mermaid-library-title'" data-testid="mermaid-template-library">
        <header><div><AppIcon :name="pendingTemplate ? 'refresh' : 'templates'" :size="19"/><h2 :id="pendingTemplate ? 'mermaid-replace-title' : 'mermaid-library-title'">{{ pendingTemplate ? '替换当前源码？' : '选择图表模板' }}</h2></div><button type="button" class="mermaid-library-close" aria-label="关闭图表模板" @click="closeTemplates()"><AppIcon name="close" :size="17"/></button></header>
        <template v-if="pendingTemplate">
          <div class="mermaid-replace-content"><div class="mermaid-replace-template"><AppIcon :name="pendingTemplate.kind" :size="25"/><div><strong>{{ pendingTemplate.title }}</strong><small>{{ DIAGRAM_KIND_LABELS[pendingTemplate.kind] }}</small></div></div><p>将使用此模板替换当前源码。替换后可以通过工具栏“撤销”恢复原来的内容。</p><pre>{{ pendingTemplate.source }}</pre></div>
          <footer><button type="button" data-template-cancel @click="backToTemplates">返回模板</button><button type="button" class="mermaid-primary" data-testid="mermaid-confirm-template" @click="applyTemplate(pendingTemplate)"><AppIcon name="check" :size="15"/>替换源码</button></footer>
        </template>
        <template v-else>
          <div class="mermaid-library-tools"><label class="mermaid-template-search"><AppIcon name="search" :size="15"/><input ref="templateSearchInput" v-model="templateSearch" type="search" placeholder="搜索图表类型或用途" aria-label="搜索图表模板"/></label><div class="mermaid-categories" role="group" aria-label="图表分类"><button type="button" :aria-pressed="templateCategory === 'all'" @click="templateCategory = 'all'">全部 <small>{{ kindsCount }}</small></button><button v-for="category in categories" :key="category" type="button" :aria-pressed="templateCategory === category" @click="templateCategory = category">{{ category }}</button></div></div>
          <div class="mermaid-template-grid"><button v-for="template in visibleTemplates" :key="template.id" type="button" class="mermaid-template-card" :data-template-id="template.id" :data-diagram-kind="template.kind" :aria-label="`使用模板：${template.title}`" @click="chooseTemplate(template)"><span class="mermaid-template-icon"><AppIcon :name="template.kind" :size="21"/></span><span class="mermaid-template-copy"><strong>{{ template.title }}</strong><small>{{ template.description }}</small><span>{{ DIAGRAM_KIND_LABELS[template.kind] }}</span></span><AppIcon name="chevron-right" :size="14"/></button><p v-if="!visibleTemplates.length" class="mermaid-no-templates">没有匹配的模板，试试其他关键词或分类。</p></div>
          <footer><span>源码保存在当前文档中，可随时编辑。</span><button type="button" @click="closeTemplates()">取消</button></footer>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped>
.mermaid-editor{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--ui-text,#273449);background:var(--ui-bg,#f4f6fa);font-size:13px}.mermaid-toolbar{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 16px;border-bottom:1px solid var(--ui-line,#e2e8f0);background:var(--ui-surface,#fff)}.mermaid-title{display:flex;align-items:center;gap:10px;white-space:nowrap}.mermaid-title strong{font-size:14px}.mermaid-badge{color:var(--ui-muted,#64748b);font-size:11px}.mermaid-editor button{font:inherit;cursor:pointer;border:1px solid var(--ui-line,#dce3ed);color:var(--ui-text,#273449);background:var(--ui-surface,#fff);border-radius:7px;padding:6px 10px}.mermaid-editor button:hover:not(:disabled){border-color:var(--ui-accent,#3577e5);color:var(--ui-accent,#3577e5)}.mermaid-editor button:disabled{opacity:.45;cursor:default}.mermaid-editor button:focus-visible,.mermaid-editor summary:focus-visible{outline:2px solid var(--ui-accent,#3577e5);outline-offset:2px}.mermaid-convert{display:flex;align-items:center;gap:7px;white-space:nowrap}.mermaid-convert svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.5}.mermaid-workspace{display:grid;grid-template-columns:minmax(260px,37%) minmax(0,1fr);flex:1;min-height:0;overflow:hidden}.mermaid-source-panel,.mermaid-preview-panel{min-width:0;min-height:0;display:flex;flex-direction:column;position:relative}.mermaid-source-panel{background:var(--ui-surface,#fff);border-right:1px solid var(--ui-line,#e2e8f0)}.mermaid-panel-title{height:37px;flex-shrink:0;padding:0 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--ui-muted,#64748b);font-size:11px;border-bottom:1px solid var(--ui-line,#e2e8f0);background:var(--ui-surface,#fff)}.mermaid-panel-title>span:first-child{font-weight:600;color:var(--ui-text,#273449)}.mermaid-code{flex:1;min-height:180px;display:flex;overflow:hidden;position:relative}.mermaid-gutter{flex:0 0 43px;overflow:hidden;text-align:right;padding:16px 10px 0 0;color:var(--ui-muted,#94a3b8);background:var(--ui-bg,#f8fafc);user-select:none}.mermaid-gutter pre{margin:0;font:13px/23px ui-monospace,SFMono-Regular,Consolas,monospace}.mermaid-code textarea{display:block;border:0;border-radius:0;outline:0;resize:none;width:100%;min-width:0;height:100%;min-height:180px;box-sizing:border-box;padding:16px 16px 32px 12px;font:13px/23px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--ui-text,#273449);background:var(--ui-surface,#fff);tab-size:2;white-space:pre;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--ui-line,#cbd5e1) transparent}.mermaid-code textarea:focus{box-shadow:inset 2px 0 var(--ui-accent,#3577e5)}.mermaid-help{padding:11px 14px;border-top:1px solid var(--ui-line,#e2e8f0);font-size:11px;color:var(--ui-muted,#64748b);max-height:38%;overflow:auto;scrollbar-width:thin}.mermaid-help summary{cursor:pointer;color:var(--ui-text,#273449)}.mermaid-help p{margin:10px 0 0;line-height:1.8}.mermaid-help code{font-size:10px;background:var(--ui-bg,#f4f6fa);border-radius:3px;padding:2px 3px}.mermaid-preview-kind{font-weight:400;font-size:10px;padding-left:8px;color:var(--ui-muted,#64748b)}.mermaid-zoom{display:flex;align-items:center;gap:3px}.mermaid-zoom button{border:0;font-size:11px;padding:2px 6px;min-width:24px}.mermaid-preview-scroll{flex:1;min-height:0;overflow:auto;scrollbar-width:thin;padding:24px;box-sizing:border-box;background-image:radial-gradient(var(--ui-line,#d6dfe9) .7px,transparent .7px);background-size:16px 16px}.mermaid-preview{min-height:100%;display:flex;align-items:flex-start;justify-content:center;transition:width .12s;box-sizing:border-box}.mermaid-preview :deep(svg){display:block;width:100%;height:auto;max-height:none;box-shadow:0 4px 24px #1e293b0b;border:1px solid var(--ui-line,#e2e8f0);border-radius:5px}.mermaid-parsing{position:absolute;top:48px;left:50%;transform:translateX(-50%);z-index:2;display:flex;align-items:center;gap:7px;background:var(--ui-surface,#fff);padding:7px 12px;border:1px solid var(--ui-line,#e2e8f0);border-radius:20px;font-size:11px;box-shadow:0 2px 10px #00000009}.mermaid-spinner{width:11px;height:11px;border:2px solid var(--ui-line,#e2e8f0);border-top-color:var(--ui-accent,#3577e5);border-radius:50%;animation:mermaid-spin .8s linear infinite}.mermaid-error{margin:24px;padding:18px;border:1px solid #f3bbbb;border-radius:9px;background:#fff3f3;color:#9b2b2b;line-height:1.6}.mermaid-error strong{font-size:14px}.mermaid-error p{margin:8px 0 14px;overflow-wrap:anywhere}.mermaid-error button{background:#fff;color:#9b2b2b;border-color:#f3bbbb;font-size:12px}.mermaid-warnings{padding:8px 15px;background:var(--ui-surface,#fff);border-top:1px solid var(--ui-line,#e2e8f0);color:var(--ui-muted,#64748b);font-size:11px;max-height:100px;overflow:auto}.mermaid-warnings p{margin:3px 0;line-height:1.5}.mermaid-empty{display:grid;place-items:center;flex:1;color:var(--ui-muted,#64748b);padding:24px;text-align:center}.is-dark .mermaid-error{background:#3a242b;color:#ffc1c1;border-color:#75414a}.is-dark .mermaid-error button{background:#3a242b;color:#ffc1c1;border-color:#75414a}@keyframes mermaid-spin{to{transform:rotate(360deg)}}@media(max-width:760px){.mermaid-workspace{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(210px,43%) minmax(200px,1fr);overflow:auto}.mermaid-source-panel{border-right:0;border-bottom:1px solid var(--ui-line,#e2e8f0)}.mermaid-code{min-height:100px}.mermaid-code textarea{min-height:100px}.mermaid-gutter{flex-basis:34px;padding-right:7px}.mermaid-toolbar{padding:7px 10px;gap:6px}.mermaid-badge{display:none}.mermaid-convert{font-size:11px!important;padding:6px 7px!important}.mermaid-help{padding:8px 10px;max-height:45%}.mermaid-preview-scroll{padding:12px}.mermaid-error{margin:12px;padding:12px}}@media(prefers-reduced-motion:reduce){.mermaid-preview{transition:none}.mermaid-spinner{animation:none}}
</style>

<style scoped>
.mermaid-editor { position: relative; }
.mermaid-toolbar-actions, .mermaid-template-toggle, .mermaid-error strong, .mermaid-error button { display: flex; align-items: center; gap: 7px; }
.mermaid-toolbar-actions { min-width: 0; gap: 8px; }
.mermaid-template-toggle { white-space: nowrap; font-size: 12px !important; }
.mermaid-title > svg { color: var(--ui-accent, #3577e5); }
.mermaid-preview-kind { display: inline-flex; align-items: center; gap: 4px; }
.mermaid-zoom button { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; }
.mermaid-help summary { list-style: none; display: flex; align-items: center; gap: 6px; min-height: 20px; }
.mermaid-help summary::-webkit-details-marker { display: none; }
.mermaid-help[open] summary > svg:first-child { transform: rotate(90deg); }
.mermaid-syntax-example { margin: 10px 0 0; padding: 10px; border: 1px solid var(--ui-line, #e2e8f0); border-radius: 5px; background: var(--ui-bg, #f4f6fa); color: var(--ui-text, #273449); overflow: auto; font: 11px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.mermaid-library-backdrop { position: absolute; inset: 0; z-index: 35; display: flex; align-items: center; justify-content: center; padding: 18px; background: #14213d55; }
.mermaid-library { display: flex; flex-direction: column; width: 720px; max-width: 100%; max-height: 100%; overflow: hidden; border: 1px solid var(--ui-line, #dce3ed); border-radius: 11px; background: var(--ui-surface, #fff); box-shadow: 0 18px 64px #0f172a30; }
.mermaid-library > header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--ui-line, #e2e8f0); }
.mermaid-library > header > div { display: flex; align-items: center; gap: 9px; }
.mermaid-library > header > div > svg { color: var(--ui-accent, #3577e5); }
.mermaid-library h2 { margin: 0; font-size: 16px; font-weight: 650; }
.mermaid-library .mermaid-library-close { display: grid; place-items: center; width: 29px; height: 29px; padding: 0; flex: none; border-color: transparent; }
.mermaid-library-tools { flex: none; padding: 13px 17px 10px; border-bottom: 1px solid var(--ui-line, #e2e8f0); }
.mermaid-template-search { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 10px; background: var(--ui-bg, #f4f6fa); border: 1px solid var(--ui-line, #e2e8f0); border-radius: 6px; color: var(--ui-muted, #64748b); }
.mermaid-template-search:focus-within { border-color: var(--ui-accent, #3577e5); }
.mermaid-template-search input { min-width: 0; flex: 1; width: 100%; border: 0; background: transparent; color: var(--ui-text, #273449); font: inherit; font-size: 12px; outline: 0; }
.mermaid-template-search input:focus-visible { box-shadow: none; }
.mermaid-categories { display: flex; align-items: center; gap: 5px; margin-top: 10px; overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
.mermaid-categories button { flex: none; display: flex; align-items: center; gap: 5px; padding: 5px 9px; border-color: transparent; font-size: 11px; white-space: nowrap; }
.mermaid-categories button[aria-pressed="true"] { color: var(--ui-accent, #3577e5); background: var(--ui-soft, #eaf1ff); border-color: var(--ui-soft, #eaf1ff); }
.mermaid-categories small { font-size: 10px; opacity: .8; }
.mermaid-template-grid { min-height: 0; padding: 13px 17px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; gap: 9px; overflow-y: auto; scrollbar-width: thin; }
.mermaid-template-grid .mermaid-template-card { min-width: 0; display: flex; align-items: center; gap: 10px; padding: 12px; text-align: left; }
.mermaid-template-card > svg { margin-left: auto; color: var(--ui-muted, #64748b); }
.mermaid-template-icon { display: grid; place-items: center; width: 35px; height: 38px; flex: none; border-radius: 7px; background: var(--ui-soft, #eaf1ff); color: var(--ui-accent, #3577e5); }
.mermaid-template-copy { display: grid; min-width: 0; gap: 4px; }
.mermaid-template-copy strong { font-size: 12px; color: var(--ui-text, #273449); line-height: 1.45; }
.mermaid-template-copy small { font-size: 10px; color: var(--ui-muted, #64748b); line-height: 1.5; }
.mermaid-template-copy > span { font-size: 9px; color: var(--ui-accent, #3577e5); }
.mermaid-no-templates { grid-column: 1 / -1; margin: 18px 0; color: var(--ui-muted, #64748b); text-align: center; font-size: 12px; }
.mermaid-library > footer { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding: 11px 17px; border-top: 1px solid var(--ui-line, #e2e8f0); }
.mermaid-library > footer > span { margin-right: auto; color: var(--ui-muted, #64748b); font-size: 10px; }
.mermaid-library > footer button { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; white-space: nowrap; }
.mermaid-library .mermaid-primary { color: #fff; border-color: #2563eb; background: #2563eb; }
.mermaid-library .mermaid-primary:hover { color: #fff; background: #1d4ed8; border-color: #1d4ed8; }
.mermaid-replace-content { min-height: 0; overflow: auto; padding: 17px; }
.mermaid-replace-template { display: flex; align-items: center; gap: 11px; }
.mermaid-replace-template > svg { color: var(--ui-accent, #3577e5); }
.mermaid-replace-template strong { display: block; font-size: 14px; }
.mermaid-replace-template small { display: block; margin-top: 3px; color: var(--ui-muted, #64748b); font-size: 10px; }
.mermaid-replace-content p { color: var(--ui-muted, #64748b); font-size: 12px; line-height: 1.8; margin: 16px 0 12px; }
.mermaid-replace-content pre { max-height: 28vh; overflow: auto; margin: 0; padding: 12px; border: 1px solid var(--ui-line, #e2e8f0); border-radius: 6px; background: var(--ui-bg, #f4f6fa); color: var(--ui-text, #273449); font: 11px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
@media (max-width: 640px) {
  .mermaid-title { gap: 5px; }.mermaid-title strong { display: none; }
  .mermaid-toolbar-actions { gap: 5px; }.mermaid-template-toggle { font-size: 11px !important; padding: 6px 7px !important; gap: 4px; }
  .mermaid-template-toggle > svg:last-child { display: none; }
  .mermaid-convert { gap: 5px; }
  .mermaid-library-backdrop { padding: 10px; }.mermaid-library > header { padding: 12px; }.mermaid-library h2 { font-size: 14px; }
  .mermaid-library-tools { padding: 10px 12px 7px; }.mermaid-template-grid { grid-template-columns: minmax(0, 1fr); padding: 10px 12px; gap: 7px; }
  .mermaid-template-grid .mermaid-template-card { padding: 10px; }.mermaid-template-copy strong { font-size: 11px; }
  .mermaid-library > footer { padding: 10px 12px; }.mermaid-library > footer > span { max-width: 60%; line-height: 1.5; }
  .mermaid-replace-content { padding: 12px; }
}
</style>
