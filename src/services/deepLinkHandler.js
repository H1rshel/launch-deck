import { supabase } from '../lib/supabase'
import { _authBridge } from '../context/AuthContext'
import { logAuth, describeUrl } from '../lib/authDebug'

const isTauri = () => '__TAURI_INTERNALS__' in window

let _initialized = false

export async function initDeepLinkHandler() {
  if (!isTauri() || _initialized) return
  _initialized = true

  try {
    const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link')

    // Handle deep links that arrive while the app is already running (normal OAuth case)
    await onOpenUrl(async (urls) => {
      logAuth('deeplink event', urls.map(describeUrl).join(' '))
      for (const url of urls) {
        if (_handledUrls.has(url)) continue
        _handledUrls.add(url)
        if (await handleAuthUrl(url)) break
      }
    })
    logAuth('deeplink handler ready')

    // Handle deep link if the app was cold-launched via the scheme
    const initialUrls = await getCurrent()
    if (initialUrls) {
      for (const url of initialUrls) {
        if (_handledUrls.has(url)) continue
        _handledUrls.add(url)
        if (await handleAuthUrl(url)) break
      }
    }
  } catch (err) {
    console.error('[DeepLink] Handler init failed:', err)
  }
}

// Tracks handled URLs so the recheck path can't double-exchange a code
const _handledUrls = new Set()

/**
 * Re-reads the current intent/deep-link and processes any auth callback.
 * Android safety net: onOpenUrl doesn't always fire for custom-scheme
 * intent-filters, but the OS still delivers the intent to the (singleTask)
 * activity — polling getCurrent when the app regains focus catches it.
 */
export async function recheckDeepLink() {
  if (!isTauri()) return false
  try {
    const { getCurrent } = await import('@tauri-apps/plugin-deep-link')
    const urls = await getCurrent()
    logAuth('recheck getCurrent', urls?.length ? urls.map(describeUrl).join(' ') : 'empty')
    if (!urls) return false
    for (const url of urls) {
      if (_handledUrls.has(url)) continue
      _handledUrls.add(url)
      if (await handleAuthUrl(url)) return true
    }
  } catch (err) {
    logAuth('recheck FAILED', String(err?.message).slice(0, 60))
  }
  return false
}

async function handleAuthUrl(url) {
  if (!url.startsWith('launchdeck://auth/')) return false

  try {
    const parsed = new URL(url)

    // Safe diagnostic log — shows param keys and hash keys, never values
    const queryKeys = [...parsed.searchParams.keys()]
    const hashKeys = parsed.hash
      ? parsed.hash.substring(1).split('&').map(p => p.split('=')[0]).filter(Boolean)
      : []
    console.log('[DeepLink] Auth callback received.',
      'Query keys:', queryKeys,
      '| Hash keys:', hashKeys,
      '| Path:', parsed.pathname)

    // ── 1. OAuth provider error ────────────────────────────────────────────────
    const oauthError = parsed.searchParams.get('error')
    const oauthErrorDesc = parsed.searchParams.get('error_description')
    if (oauthError) {
      console.error('[DeepLink] OAuth error from provider:', oauthError)
      _authBridge.setSigningIn?.(false)
      _authBridge.setError?.(
        `Sign-in was rejected: ${oauthErrorDesc || oauthError}. ` +
        'Make sure launchdeck://auth/callback is in your Supabase Redirect URLs.'
      )
      return true
    }

    // ── 2. PKCE flow — code in query params (?code=XXX) ───────────────────────
    const code = parsed.searchParams.get('code')
    if (code) {
      // The code verifier was stored in the WebView localStorage when
      // signInWithOAuth() was called. exchangeCodeForSession reads it automatically.
      logAuth('exchanging code')
      const { error: exchangeErr } = await supabase.auth.exchangeCodeForSession(code)
      logAuth('exchange result', exchangeErr ? exchangeErr.message.slice(0, 60) : 'SIGNED IN')
      if (exchangeErr) {
        console.error('[DeepLink] exchangeCodeForSession failed:', exchangeErr.message)
        _authBridge.setSigningIn?.(false)
        _authBridge.setError?.(
          `Sign-in failed: ${exchangeErr.message}. Please try again.`
        )
      }
      // On success, onAuthStateChange fires SIGNED_IN → AuthContext clears signingIn.
      return true
    }

    // ── 3. Implicit / token flow — tokens in hash (#access_token=XXX&…) ───────
    // Supabase uses this if the project or client isn't enforcing PKCE.
    if (parsed.hash && parsed.hash.length > 1) {
      const hashParams = new URLSearchParams(parsed.hash.substring(1))
      const accessToken = hashParams.get('access_token')
      const refreshToken = hashParams.get('refresh_token')

      if (accessToken) {
        // Do NOT log the token values
        const { error: sessionErr } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken ?? '',
        })
        if (sessionErr) {
          console.error('[DeepLink] setSession (implicit flow) failed:', sessionErr.message)
          _authBridge.setSigningIn?.(false)
          _authBridge.setError?.(
            `Sign-in failed: ${sessionErr.message}. Please try again.`
          )
        }
        // On success, onAuthStateChange fires SIGNED_IN → AuthContext clears signingIn.
        return true
      }
    }

    // ── 4. Nothing usable — log safe shape for debugging ──────────────────────
    console.error(
      '[DeepLink] Auth callback had no usable params.',
      'Query keys:', queryKeys,
      '| Hash keys:', hashKeys
    )
    _authBridge.setSigningIn?.(false)
    _authBridge.setError?.(
      'Sign-in could not complete: the callback URL contained no authorization data. ' +
      'Check that launchdeck://auth/callback is listed in your Supabase Redirect URLs.'
    )
    return true

  } catch (err) {
    console.error('[DeepLink] OAuth callback handling failed:', err)
    _authBridge.setSigningIn?.(false)
    _authBridge.setError?.('An unexpected error occurred during sign-in. Please try again.')
  }
  return false
}
