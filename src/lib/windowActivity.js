/**
 * Marks <html> with `app-inactive` while the window is not in use, which
 * inactive.css turns into "pause every animation".
 *
 * A minimised or tray-hidden window is already handled natively (the Rust side
 * marks the WebView invisible), but a window that merely sits behind a
 * fullscreen game is neither: WebView2 cannot see it is covered, so the
 * ambient loops in global.css (background zoom, orb drift, glow rotation,
 * equaliser bars...) kept compositing every frame on the GPU the game was
 * using.
 *
 * The class is applied only after a short grace period so a quick alt-tab
 * doesn't freeze an entrance animation half-way, and removed instantly on
 * return so the UI is never seen paused.
 */
const INACTIVE_DELAY_MS = 1500

export function installWindowActivityTracking() {
  const root = document.documentElement
  let timer = null

  const update = () => {
    clearTimeout(timer)
    timer = null
    if (!document.hidden && document.hasFocus()) {
      root.classList.remove('app-inactive')
      return
    }
    timer = setTimeout(() => root.classList.add('app-inactive'), INACTIVE_DELAY_MS)
  }

  window.addEventListener('focus', update)
  window.addEventListener('blur', update)
  document.addEventListener('visibilitychange', update)
  update()
}
