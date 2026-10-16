import { createApp } from 'vue'
import './style.css'

const sharedRoute = location.hash.match(/^#\/share\/([A-Za-z0-9_-]+)$/)
// Shared links mount an isolated editor without loading the local workspace or drafts.
// Keep imports separate so each route receives its own extracted stylesheet.
if (sharedRoute) {
  void import('./components/SharedWorkspace.vue').then(({ default: component }) => createApp(component, { token: sharedRoute[1] }).mount('#app'))
} else {
  void import('./App.vue').then(({ default: component }) => createApp(component).mount('#app'))
}
