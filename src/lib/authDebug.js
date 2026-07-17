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
  try {
    window.dispatchEvent(new CustomEvent(AUTH_DEBUG_EVENT))
  } catch { /* non-browser */ }
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
