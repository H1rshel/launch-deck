// Detection + typed wrapper for the v2 native shell (android-remote).
// The entire native contract is this tiny surface; when absent, the web UI
// falls back to the legacy Tauri bridge paths.

export function isNativeShell() {
  try {
    return typeof window.LaunchDeckNative?.shellVersion === 'function'
  } catch {
    return false
  }
}

export function nativeStartStream(hostIp, appName) {
  window.LaunchDeckNative.startStream(hostIp, appName)
}

/**
 * Register + pair the host ahead of a stream so the eventual tap is
 * near-instant. Idempotent; call when an online host becomes known.
 */
export function nativePrewarm(hostIp) {
  try {
    window.LaunchDeckNative.prewarm?.(hostIp)
  } catch { /* older shell without prewarm — ignore */ }
}

export function nativeCancelStream() {
  try {
    window.LaunchDeckNative.cancelStream()
  } catch { /* best effort */ }
}

export function nativeOpenUrl(url) {
  window.LaunchDeckNative.openUrl(url)
}

/**
 * Subscribe to events emitted by the native side:
 *  { type: 'pair-pin', pin, host } — relay to the host over the command bus
 *  { type: 'stream-status', step } — engine|connect|pair|app|launch
 *  { type: 'stream-started', app }
 *  { type: 'stream-error', message }
 */
export function onNativeEvent(handler) {
  const listener = (e) => handler(e.detail || {})
  window.addEventListener('ld-native', listener)
  return () => window.removeEventListener('ld-native', listener)
}
