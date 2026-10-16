<script setup lang="ts">
import { buildInfo, formatBuildTime } from '../core/build-info.ts'
import AppIcon from './AppIcon.vue'
const buildTime = formatBuildTime(buildInfo.builtAt)
</script>
<template>
  <div class="app-information">
    <div class="app-identity"><img src="/brand-mark.png" alt="" width="44" height="44"><div><strong>Open Workflow</strong><p>画布与代码图表</p></div></div>
    <dl>
      <div><dt>版本号</dt><dd>{{ buildInfo.version }}</dd></div>
      <div><dt>构建时间</dt><dd><template v-if="buildInfo.development">开发模式，尚未构建</template><time v-else :datetime="buildInfo.builtAt" :title="buildInfo.builtAt">{{ buildTime }}</time></dd></div>
      <div v-if="buildInfo.development"><dt>开发启动</dt><dd><time :datetime="buildInfo.builtAt" :title="buildInfo.builtAt">{{ buildTime }}</time></dd></div>
    </dl>
    <section class="usage-guide" aria-labelledby="usage-guide-title">
      <h3 id="usage-guide-title">使用说明</h3>
      <details>
        <summary><span>画布操作</span><AppIcon name="chevron-right" :size="15"/></summary>
        <div class="guide-content">
          <p>从工具栏选图形后点击画布放置。双击图形编辑文字，用连线工具连接节点。按住空格拖动画布，普通滚轮平移，Ctrl / ⌘ + 滚轮缩放，Shift 点击多选。</p>
          <p>快捷图形与自由绘制工具分组展示，提供流程图形、四方向大括弧、六种笔触、整元素橡皮擦、分区框架和可编辑模板。自定义笔触可调整颜色、粗细、不透明度、平滑和触笔压感；激光指示轨迹短暂显示，不加入文档。</p>
          <p>开启工具锁可连续绘制，Esc 退出；绘制前可设置连线类型和箭头。多选后可组合、对齐和等距分布；点击组合整体选择，Alt + 点击选择单个成员。拖动框架标题可带动内部内容。</p>
        </div>
      </details>
      <details>
        <summary><span>代码图表</span><AppIcon name="chevron-right" :size="15"/></summary>
        <div class="guide-content">
          <p>代码图表工作区提供流程、时序、类图、ER、状态、架构、数据分析与项目计划等丰富的图表模板。选择模板后编辑源码，即时查看预览；移动源码光标会高亮对应图形或连线，也可点击“定位图形”将其移到可见区域。定位提示不进入导出。</p>
          <p>全局绘图风格提供 10 种预设，导出和可编辑副本保留同样的外观。各类型支持常用语法子集，未实现的指令会提示具体行号。</p>
        </div>
      </details>
      <details>
        <summary><span>保存与兼容</span><AppIcon name="chevron-right" :size="15"/></summary>
        <div class="guide-content">
          <p>顶部“自动保存”开关只控制本地草稿，默认开启并记住选择，不会自动写入原文件。关闭后可用 Ctrl / ⌘ + S 手动保存 .owflow 文件并同步草稿；重新开启会保存所有已打开文档的最新内容。</p>
          <p>图形 XML 和白板 JSON 支持基础元素导入，转换限制会单独提示。</p>
        </div>
      </details>
      <details>
        <summary><span>键盘快捷键</span><AppIcon name="chevron-right" :size="15"/></summary>
        <ul class="shortcut-list">
          <li><span>打开文件</span><kbd>Ctrl / ⌘ O</kbd></li>
          <li><span>保存文件</span><kbd>Ctrl / ⌘ S</kbd></li>
          <li><span>撤销</span><kbd>Ctrl / ⌘ Z</kbd></li>
          <li><span>重做</span><kbd>Ctrl / ⌘ Shift Z</kbd></li>
        </ul>
      </details>
    </section>
  </div>
</template>
<style scoped>
.app-information{padding:8px 0 4px;color:var(--ui-text)}
.app-identity{display:flex;align-items:center;gap:12px;margin-bottom:23px}
.app-identity img{flex:none;object-fit:contain}
.app-identity strong{font-size:18px;font-weight:650;letter-spacing:-.4px}
.app-identity p{margin:4px 0 0;color:var(--ui-muted);font-size:11px}
dl{margin:0;display:grid;gap:13px;font-size:12px}
dl>div{display:grid;grid-template-columns:68px minmax(0,1fr);gap:12px}
dt{color:var(--ui-muted)}
dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.usage-guide{margin-top:22px;padding-top:17px;border-top:1px solid var(--ui-line)}
.usage-guide h3{margin:0 0 8px;font-size:12px;font-weight:600}
.usage-guide details{border-bottom:1px solid var(--ui-line)}
.usage-guide details:last-child{border-bottom:0}
.usage-guide summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px;padding:8px 4px;border-radius:5px;list-style:none;cursor:pointer;font-size:12px;font-weight:550}
.usage-guide summary::-webkit-details-marker{display:none}
.usage-guide summary:hover{background:var(--ui-hover)}
.usage-guide summary:focus-visible{outline:2px solid var(--ui-accent);outline-offset:1px}
.usage-guide summary svg{flex:none;color:var(--ui-muted)}
.usage-guide details[open]>summary svg{transform:rotate(90deg)}
.guide-content{padding:0 4px 12px;font-size:12px;line-height:1.85;overflow-wrap:anywhere}
.guide-content p{margin:0 0 8px}
.guide-content p:last-child{margin-bottom:0}
.shortcut-list{display:grid;gap:8px;margin:0;padding:2px 4px 14px;list-style:none;font-size:12px}
.shortcut-list li{display:flex;align-items:center;justify-content:space-between;gap:12px}
.shortcut-list kbd{flex-shrink:0;padding:3px 6px;border:1px solid var(--ui-line);border-radius:4px;background:var(--ui-bg);font-family:inherit;font-size:11px;white-space:nowrap}
@media(max-width:380px){dl>div{grid-template-columns:58px minmax(0,1fr);gap:8px}.shortcut-list li{gap:8px}.shortcut-list kbd{font-size:10px}}
</style>
