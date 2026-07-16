// Lightweight auth-flow tracer. The mobile login screen renders these
// events so OAuth failures on devices without dev tools are diagnosable
// from a screenshot. Never log secrets: URLs are reduced to origin/scheme.

const events = []
export const AUTH_DEBUG_EVENT = 'ld-auth-debug'

export function logAuth(step, detail = '') {
  const entry = `${new Date().toISOString().slice(11, 19)} ${step}${detail ? `: ${detail}` : ''}`
  events.push(entry)
  if (events.length > 20) events.shift()
  console.log('[AuthTrace]', entry)
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
