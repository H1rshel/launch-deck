/**
 * Module-level singleton for update banner state.
 *
 * Using a plain module rather than a React context keeps the banner state
 * independent of the component tree, allowing App.jsx (startup check) to set
 * it and AppLayout.jsx to read it without prop-drilling or a new provider.
 *
 * Shape of a banner:
 *   { version: string, notes: string|null, update: object }
 *
 * `update` is the live object returned by @tauri-apps/plugin-updater check().
 * It must stay in memory to call downloadAndInstall() — it cannot be serialised
 * to localStorage.
 */

let _banner = null
const _listeners = new Set()

export function getUpdateBanner() {
  return _banner
}

export function setUpdateBanner(banner) {
  _banner = banner
  _listeners.forEach((fn) => fn(_banner))
}

export function clearUpdateBanner() {
  setUpdateBanner(null)
}

/** Subscribe to banner changes. Returns an unsubscribe function. */
export function subscribeUpdateBanner(fn) {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}
