const isTauri = () => '__TAURI_INTERNALS__' in window

// In production installed builds, use the custom URL scheme so the system
// browser can hand off the OAuth code back to the running app via deep link.
// In dev (browser or tauri dev), use /auth/callback so the route can exchange
// the PKCE code for a session via Supabase.
export function getAuthRedirectUrl() {
  if (isTauri() && !import.meta.env.DEV) {
    return 'launchdeck://auth/callback'
  }
  // Must match the /auth/callback route in App.jsx, not /login
  return window.location.origin + '/auth/callback'
}

// Production Tauri builds must open the OAuth URL in the system browser
// (not navigate the WebView), so the deep link can come back to the running app.
export function shouldOpenExternalBrowser() {
  return isTauri() && !import.meta.env.DEV
}
