<script setup lang="ts">
import { buildInfo, formatBuildTime } from '../core/build-info.ts'
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
</style>
