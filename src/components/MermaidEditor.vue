<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { compileMermaid, MermaidSyntaxError, type MermaidResult } from '../core/mermaid.ts'
import { sceneToSvg } from '../core/svg.ts'
import { clone, type Scene } from '../core/types.ts'

const props = defineProps<{ source: string; theme: 'light' | 'dark' }>()
const emit = defineEmits<{ change: [source: string]; createFlow: [scene: Scene]; status: [message: string] }>()
const draft = ref(props.source), sourceInput = ref<HTMLTextAreaElement>(), error = ref(''), errorLine = ref(0)
const compiled = ref<MermaidResult | null>(null), parsing = ref(false), scrollTop = ref(0), zoom = ref(1)
let timer: ReturnType<typeof setTimeout> | undefined, published = props.source
const lines = computed(() => Array.from({ length: draft.value.split('\n').length }, (_, index) => index + 1).join('\n'))
const svg = computed(() => compiled.value ? sceneToSvg(compiled.value.scene, { background: true }) : '')
const kindLabel = computed(() => compiled.value?.kind === 'sequence' ? '时序图' : '流程图')
const elementCount = computed(() => compiled.value?.scene.elements.length ?? 0)

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
    <div class="mermaid-toolbar">
      <div class="mermaid-title"><strong>Mermaid</strong><span class="mermaid-badge">自研解析 · 流程 / 时序</span></div>
      <button type="button" class="mermaid-convert" :disabled="!compiled || parsing" @click="createFlow">
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="2.5" width="5" height="5" rx="1"/><rect x="12.5" y="12.5" width="5" height="5" rx="1"/><path d="M7.5 5h7.5v5M12.5 8l2.5 2.5L17.5 8"/></svg>
        转为可编辑流程图
      </button>
    </div>
    <div class="mermaid-workspace">
      <div class="mermaid-source-panel">
        <div class="mermaid-panel-title"><span>源码</span><span>修改后自动预览</span></div>
        <div class="mermaid-code">
          <div class="mermaid-gutter" aria-hidden="true"><pre :style="{ transform: `translateY(${-scrollTop}px)` }">{{ lines }}</pre></div>
          <textarea ref="sourceInput" v-model="draft" aria-label="Mermaid 源码" data-testid="mermaid-source" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" :aria-invalid="Boolean(error)" :aria-describedby="error ? 'mermaid-error-detail' : undefined" @input="onInput" @blur="flush" @keydown="onKeydown" @scroll="scrollTop = ($event.target as HTMLTextAreaElement).scrollTop" />
        </div>
        <details class="mermaid-help">
          <summary>当前支持的语法</summary>
          <p><code>flowchart TD / LR / RL / BT</code> 或 <code>graph</code>；矩形 <code>A[开始]</code>、圆形 <code>B((结束))</code>、菱形 <code>C{判断}</code>；连线 <code>--&gt;</code>、<code>---</code>、<code>-.→</code>、<code>==&gt;</code>、<code>&lt;--&gt;</code>；标签 <code>--&gt;|是|</code>。</p>
          <p><code>sequenceDiagram</code>：<code>participant</code>、<code>actor</code>、<code>A-&gt;&gt;B: 消息</code>、<code>Note over A: 注释</code>、<code>autonumber</code>。</p>
          <p>暂不支持其他图表类型、分组、样式指令和时序激活区。源码会原样保存；转换会创建独立的可编辑副本。</p>
        </details>
      </div>
      <div class="mermaid-preview-panel">
        <div class="mermaid-panel-title"><span>预览 <span v-if="compiled" class="mermaid-preview-kind">{{ kindLabel }}</span></span><div class="mermaid-zoom"><button type="button" aria-label="缩小预览" :disabled="zoom <= .4" @click="zoom = Math.max(.4, zoom - .2)">−</button><button type="button" aria-label="重置预览缩放" @click="zoom = 1">{{ Math.round(zoom * 100) }}%</button><button type="button" aria-label="放大预览" :disabled="zoom >= 3" @click="zoom = Math.min(3, zoom + .2)">+</button></div></div>
        <div v-if="parsing" class="mermaid-parsing" role="status"><span class="mermaid-spinner" />正在解析…</div>
        <div v-if="error && !parsing" id="mermaid-error-detail" class="mermaid-error" role="alert" data-testid="mermaid-error">
          <strong>源码需要修正</strong><p>{{ error }}</p><button v-if="errorLine" type="button" @click="locateError">定位到第 {{ errorLine }} 行</button>
        </div>
        <div v-if="compiled" class="mermaid-preview-scroll" :aria-busy="parsing">
          <div class="mermaid-preview" data-testid="mermaid-preview" :style="{ width: `${zoom * 100}%`, minWidth: `${zoom * 100}%` }" v-html="svg" />
        </div>
        <div v-if="compiled?.warnings.length" class="mermaid-warnings" role="status"><p v-for="warning in compiled.warnings" :key="warning">{{ warning }}</p></div>
        <div v-if="!compiled && !error && !parsing" class="mermaid-empty">在左侧输入源码，即可绘制图表。</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mermaid-editor{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--ui-text,#273449);background:var(--ui-bg,#f4f6fa);font-size:13px}.mermaid-toolbar{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 16px;border-bottom:1px solid var(--ui-line,#e2e8f0);background:var(--ui-surface,#fff)}.mermaid-title{display:flex;align-items:center;gap:10px;white-space:nowrap}.mermaid-title strong{font-size:14px}.mermaid-badge{color:var(--ui-muted,#64748b);font-size:11px}.mermaid-editor button{font:inherit;cursor:pointer;border:1px solid var(--ui-line,#dce3ed);color:var(--ui-text,#273449);background:var(--ui-surface,#fff);border-radius:7px;padding:6px 10px}.mermaid-editor button:hover:not(:disabled){border-color:var(--ui-accent,#3577e5);color:var(--ui-accent,#3577e5)}.mermaid-editor button:disabled{opacity:.45;cursor:default}.mermaid-editor button:focus-visible,.mermaid-editor summary:focus-visible{outline:2px solid var(--ui-accent,#3577e5);outline-offset:2px}.mermaid-convert{display:flex;align-items:center;gap:7px;white-space:nowrap}.mermaid-convert svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.5}.mermaid-workspace{display:grid;grid-template-columns:minmax(260px,37%) minmax(0,1fr);flex:1;min-height:0;overflow:hidden}.mermaid-source-panel,.mermaid-preview-panel{min-width:0;min-height:0;display:flex;flex-direction:column;position:relative}.mermaid-source-panel{background:var(--ui-surface,#fff);border-right:1px solid var(--ui-line,#e2e8f0)}.mermaid-panel-title{height:37px;flex-shrink:0;padding:0 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--ui-muted,#64748b);font-size:11px;border-bottom:1px solid var(--ui-line,#e2e8f0);background:var(--ui-surface,#fff)}.mermaid-panel-title>span:first-child{font-weight:600;color:var(--ui-text,#273449)}.mermaid-code{flex:1;min-height:180px;display:flex;overflow:hidden;position:relative}.mermaid-gutter{flex:0 0 43px;overflow:hidden;text-align:right;padding:16px 10px 0 0;color:var(--ui-muted,#94a3b8);background:var(--ui-bg,#f8fafc);user-select:none}.mermaid-gutter pre{margin:0;font:13px/23px ui-monospace,SFMono-Regular,Consolas,monospace}.mermaid-code textarea{display:block;border:0;border-radius:0;outline:0;resize:none;width:100%;min-width:0;height:100%;min-height:180px;box-sizing:border-box;padding:16px 16px 32px 12px;font:13px/23px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--ui-text,#273449);background:var(--ui-surface,#fff);tab-size:2;white-space:pre;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--ui-line,#cbd5e1) transparent}.mermaid-code textarea:focus{box-shadow:inset 2px 0 var(--ui-accent,#3577e5)}.mermaid-help{padding:11px 14px;border-top:1px solid var(--ui-line,#e2e8f0);font-size:11px;color:var(--ui-muted,#64748b);max-height:38%;overflow:auto;scrollbar-width:thin}.mermaid-help summary{cursor:pointer;color:var(--ui-text,#273449)}.mermaid-help p{margin:10px 0 0;line-height:1.8}.mermaid-help code{font-size:10px;background:var(--ui-bg,#f4f6fa);border-radius:3px;padding:2px 3px}.mermaid-preview-kind{font-weight:400;font-size:10px;padding-left:8px;color:var(--ui-muted,#64748b)}.mermaid-zoom{display:flex;align-items:center;gap:3px}.mermaid-zoom button{border:0;font-size:11px;padding:2px 6px;min-width:24px}.mermaid-preview-scroll{flex:1;min-height:0;overflow:auto;scrollbar-width:thin;padding:24px;box-sizing:border-box;background-image:radial-gradient(var(--ui-line,#d6dfe9) .7px,transparent .7px);background-size:16px 16px}.mermaid-preview{min-height:100%;display:flex;align-items:flex-start;justify-content:center;transition:width .12s;box-sizing:border-box}.mermaid-preview :deep(svg){display:block;width:100%;height:auto;max-height:none;box-shadow:0 4px 24px #1e293b0b;border:1px solid var(--ui-line,#e2e8f0);border-radius:5px}.mermaid-parsing{position:absolute;top:48px;left:50%;transform:translateX(-50%);z-index:2;display:flex;align-items:center;gap:7px;background:var(--ui-surface,#fff);padding:7px 12px;border:1px solid var(--ui-line,#e2e8f0);border-radius:20px;font-size:11px;box-shadow:0 2px 10px #00000009}.mermaid-spinner{width:11px;height:11px;border:2px solid var(--ui-line,#e2e8f0);border-top-color:var(--ui-accent,#3577e5);border-radius:50%;animation:mermaid-spin .8s linear infinite}.mermaid-error{margin:24px;padding:18px;border:1px solid #f3bbbb;border-radius:9px;background:#fff3f3;color:#9b2b2b;line-height:1.6}.mermaid-error strong{font-size:14px}.mermaid-error p{margin:8px 0 14px;overflow-wrap:anywhere}.mermaid-error button{background:#fff;color:#9b2b2b;border-color:#f3bbbb;font-size:12px}.mermaid-warnings{padding:8px 15px;background:var(--ui-surface,#fff);border-top:1px solid var(--ui-line,#e2e8f0);color:var(--ui-muted,#64748b);font-size:11px;max-height:100px;overflow:auto}.mermaid-warnings p{margin:3px 0;line-height:1.5}.mermaid-empty{display:grid;place-items:center;flex:1;color:var(--ui-muted,#64748b);padding:24px;text-align:center}.is-dark .mermaid-error{background:#3a242b;color:#ffc1c1;border-color:#75414a}.is-dark .mermaid-error button{background:#3a242b;color:#ffc1c1;border-color:#75414a}@keyframes mermaid-spin{to{transform:rotate(360deg)}}@media(max-width:760px){.mermaid-workspace{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(210px,43%) minmax(200px,1fr);overflow:auto}.mermaid-source-panel{border-right:0;border-bottom:1px solid var(--ui-line,#e2e8f0)}.mermaid-code{min-height:100px}.mermaid-code textarea{min-height:100px}.mermaid-gutter{flex-basis:34px;padding-right:7px}.mermaid-toolbar{padding:7px 10px;gap:6px}.mermaid-badge{display:none}.mermaid-convert{font-size:11px!important;padding:6px 7px!important}.mermaid-help{padding:8px 10px;max-height:45%}.mermaid-preview-scroll{padding:12px}.mermaid-error{margin:12px;padding:12px}}@media(prefers-reduced-motion:reduce){.mermaid-preview{transition:none}.mermaid-spinner{animation:none}}
</style>
