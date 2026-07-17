// Lightweight auth-flow tracer. The mobile login screen renders these
// events so OAuth failures on devices without dev tools are diagnosable
// from a screenshot. Never log secrets: URLs are reduced to origin/scheme.

const PERSIST_KEY = 'ld_trace_log'
export const AUTH_DEBUG_EVENT = 'ld-auth-debug'

// Survive process death: if the app crashes (e.g. the embedded engine takes
// the process down), the trace from the doomed session is the only evidence.
const events = (() => {
  try {
    const prev = JSON.parse(localStorage.getItem(PERSIST_KEY) || '[]')
    if (prev.length) prev.push('────── app restarted ──────')
    return prev.slice(-30)
  } catch {
    return []
  }
})()

export function logAuth(step, detail = '') {
  const entry = `${new Date().toISOString().slice(11, 19)} ${step}${detail ? `: ${detail}` : ''}`
  events.push(entry)
  if (events.length > 40) events.shift()
  console.log('[AuthTrace]', entry)
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(events))
  } catch { /* storage full/unavailable */ }
  // WebView flushes localStorage lazily — a crash destroys the newest lines.
  // The Rust append syncs to disk per line and survives process death.
  if ('__TAURI_INTERNALS__' in window) {
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('append_trace_line', { line: entry }))
      .catch(() => {})
  }
  try {
    window.dispatchEvent(new CustomEvent(AUTH_DEBUG_EVENT))
  } catch { /* non-browser */ }
}

/**
 * Startup: replace the (lossy) localStorage view with the durable Rust file
 * log, and append Android's own record of why the app last died.
 */
export async function loadDurableTrace() {
  if (!('__TAURI_INTERNALS__' in window)) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const fileLines = await invoke('read_trace_log').catch(() => [])
    if (Array.isArray(fileLines) && fileLines.length) {
      events.length = 0
      events.push(...fileLines.slice(-30), '────── app restarted ──────')
    }
    // NOTE: get_last_exit_reasons deliberately NOT called here — the JNI
    // call itself proved risky at startup. The durable file log suffices.
    window.dispatchEvent(new CustomEvent(AUTH_DEBUG_EVENT))
  } catch { /* diagnostics must never break the app */ }
}

export function getAuthTrace() {
  return [...events]
}

/** Safe descriptor for a URL — origin or scheme only, never params. */
export function describeUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.origin : `${u.protocol}//…${u.pathname}`
  } catch {
    return String(url).split(/[?#]/)[0].slice(0, 40)
  }
}
