import { createClient } from '@supabase/supabase-js'

// Supabase URL and anon key are public browser configuration. Keep the Vite
// env vars as the primary source, but include the production values here so a
// misconfigured release workflow cannot ship a blank app.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://aqoqmrcxjltwtojpgpan.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxb3FtcmN4amx0d3RvanBncGFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNTY1MTgsImV4cCI6MjA4ODgzMjUxOH0.o-afZOvtCi40Lbre8MD7cQ1s9dAhbiLDcdzXtCeBPZg'

// supabase-js never times out its own HTTP calls. When the project is
// unreachable at the application layer (paused, saturated, or a stalled
// gateway) the socket stays open and every awaiting call hangs forever —
// which is exactly what froze the app on "Initializing...". Cap every
// request so a stall surfaces as an error the UI can recover from.
const REQUEST_TIMEOUT_MS = 60_000

function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  // Respect an abort signal supabase-js supplied itself.
  const upstream = init.signal
  if (upstream) {
    if (upstream.aborted) controller.abort()
    else upstream.addEventListener('abort', () => controller.abort(), { once: true })
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

// supabase-js persists the session under `sb-<project-ref>-auth-token`.
// Knowing the key lets us read the last known session directly when the auth
// client itself is stuck waiting on the network (see readPersistedSession).
function deriveStorageKey(url) {
  try {
    const ref = new URL(url).hostname.split('.')[0]
    return ref ? `sb-${ref}-auth-token` : 'sb-auth-token'
  } catch {
    return 'sb-auth-token'
  }
}

export const AUTH_STORAGE_KEY = deriveStorageKey(supabaseUrl)

/**
 * Read the last session supabase-js wrote to localStorage, without going
 * through the auth client (which may be blocked on a network call).
 *
 * This is what lets the app boot instantly: the stored session is the same
 * one getSession() would eventually hand back, minus the network round-trip
 * it makes to refresh the access token. The auth client reconciles in the
 * background and corrects this if the session turns out to be stale.
 *
 * Returns null when there is nothing usable stored.
 */
export function readPersistedSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw)
    // Older/newer supabase-js versions wrap the session in { currentSession }.
    const session = parsed?.currentSession ?? parsed
    if (!session?.access_token || !session?.user) return null

    // An expired access token is fine — supabase-js refreshes it in the
    // background. Without a refresh token there is nothing to renew it with,
    // so treat that as signed out rather than flashing a signed-in UI.
    const expiresAt = Number(session.expires_at) || 0
    if (expiresAt * 1000 <= Date.now() && !session.refresh_token) return null

    return session
  } catch {
    return null
  }
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    detectSessionInUrl: true,
    flowType: 'pkce',
    // Pass-through lock: supabase-js's default navigator.locks-based lock
    // can hang forever on some Android WebViews, freezing every auth call
    // (observed as signInWithOAuth never resolving on the tablet). The app
    // is a single WebView context — there are no multi-tab races the lock
    // would protect against.
    lock: async (_name, _acquireTimeout, fn) => await fn(),
  },
  global: {
    fetch: fetchWithTimeout,
  },
})
