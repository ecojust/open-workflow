<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 })
const paths: Record<string, string> = {
  plus: 'M12 5v14M5 12h14', folder: 'M3 7h7l2-3h9v15H3zM3 7V4h6l3 3', save: 'M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8',
  export: 'M12 3v12m-4-8 4-4 4 4M4 14v7h16v-7', undo: 'M9 4 3 10l6 6M3 10h10a7 7 0 0 1 7 7v3', redo: 'm15 4 6 6-6 6m6-6H11a7 7 0 0 0-7 7v3',
  home: 'm3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7', close: 'm6 6 12 12M6 18 18 6', chevron: 'm6 9 6 6 6-6',
  flow: 'M8 3h8v5H8zM8 16h8v5H8zM12 8v8M3 10h5v5H3zM16 10h5v5h-5zM5.5 10V5H8M16 5h2.5v5',
  board: 'M3 4h18v14H3zM8 22l4-4 4 4M7 8h4v5H7zM14 9h3m-3 4h3', code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M20 15a8 8 0 0 1-11-11 9 9 0 1 0 11 11z', monitor: 'M3 3h18v14H3zM12 17v4M8 21h8', help: 'M9 8a3 3 0 1 1 4 3c-1 1-1 2-1 3m0 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', panel: 'M3 3h18v18H3zM9 3v18m6-13-3 4 3 4',
  check: 'm5 12 4 4L19 6', alert: 'm12 3 10 18H2zM12 9v5m0 3h.01', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  rename: 'm15 3 6 6L8 22H2v-6zM12 6l6 6', arrow: 'M4 12h16m-6-6 6 6-6 6', download: 'M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4',
}
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.flow"/></svg></template>
