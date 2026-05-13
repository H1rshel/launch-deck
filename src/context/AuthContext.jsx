import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react'
import { supabase } from '../lib/supabase'
import { getAuthRedirectUrl, shouldOpenExternalBrowser } from '../services/authRedirectService'

const AuthContext = createContext(null)

// Module-level refs so deepLinkHandler can signal auth completion without
// prop-drilling or re-importing AuthContext (avoids circular deps).
// These are set once when AuthProvider mounts and never change.
export const _authBridge = {
  setSigningIn: null,
  setError: null,
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState(null)
  const profileSyncRef = useRef(null)
  const signingInTimeoutRef = useRef(null)

  // Wire up the bridge so deepLinkHandler can clear loading state.
  useEffect(() => {
    _authBridge.setSigningIn = setSigningIn
    _authBridge.setError = setError
  }, [])

  const clearError = useCallback(() => setError(null), [])

  // Build a local profile object from auth user metadata
  const buildLocalProfile = useCallback((authUser) => ({
    id: authUser.id,
    email: authUser.email,
    username: authUser.user_metadata?.full_name || authUser.email?.split('@')[0] || null,
    avatar_url: authUser.user_metadata?.avatar_url || null,
  }), [])

  // Fetch or create profile row in Supabase profiles table
  const ensureProfile = useCallback(async (authUser) => {
    // Deduplicate — skip if already syncing for this user
    if (profileSyncRef.current === authUser.id) return
    profileSyncRef.current = authUser.id

    const fallback = buildLocalProfile(authUser)

    try {
      // Use maybeSingle() instead of single() to avoid 406 when row doesn't exist
      const { data, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', authUser.id)
        .maybeSingle()

      if (fetchError) {
        // Any fetch error (table missing, schema mismatch, etc.) — use local profile
        setProfile(fallback)
        return
      }

      if (data) {
        setProfile(data)
        return
      }

      // No row found — create new profile
      // Columns: id, username, avatar_url, created_at
      const { data: created, error: insertError } = await supabase
        .from('profiles')
        .insert({
          id: authUser.id,
          username: authUser.user_metadata?.full_name || authUser.email?.split('@')[0] || null,
          avatar_url: authUser.user_metadata?.avatar_url || null,
        })
        .select()
        .maybeSingle()

      if (insertError) {
        setProfile(fallback)
      } else {
        setProfile({ ...fallback, ...created })
      }
    } catch {
      setProfile(fallback)
    }
  }, [buildLocalProfile])

  // Initialize auth and listen for changes
  // IMPORTANT: onAuthStateChange callback must be synchronous to avoid
  // deadlocking Supabase's internal initialization
  useEffect(() => {
    let mounted = true

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, newSession) => {
        if (!mounted) return

        setSession(newSession)
        setUser(newSession?.user ?? null)
        setSigningIn(false)
        setLoading(false)

        if (event === 'SIGNED_OUT') {
          setProfile(null)
          setError(null)
        }

        if (event === 'TOKEN_REFRESHED' && !newSession) {
          setError('Session expired. Please sign in again.')
        }
      }
    )

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  // Sync profile whenever user changes (separate from auth listener to avoid deadlock)
  useEffect(() => {
    if (user) {
      ensureProfile(user)
    } else {
      setProfile(null)
    }
  }, [user, ensureProfile])

  const signInWithGoogle = useCallback(async () => {
    try {
      setSigningIn(true)
      setError(null)

      const openExternal = shouldOpenExternalBrowser()

      const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: getAuthRedirectUrl(),
          // In production Tauri builds, don't navigate the WebView — open the
          // system browser instead so the deep link can return to the running app.
          skipBrowserRedirect: openExternal,
        },
      })

      if (oauthError) {
        setSigningIn(false)
        // Show a specific, safe message — not the generic "Network error"
        const safeMsg = import.meta.env.DEV
          ? `Google sign-in failed: ${oauthError.message}`
          : 'Google sign-in could not start. Please check the OAuth redirect configuration.'
        if (import.meta.env.DEV) {
          console.error('[Auth] signInWithOAuth error:', oauthError)
        }
        setError(safeMsg)
        return
      }

      if (openExternal) {
        if (!data?.url) {
          setSigningIn(false)
          setError('Google sign-in could not start: no OAuth URL was returned by Supabase.')
          if (import.meta.env.DEV) {
            console.error('[Auth] signInWithOAuth returned no URL. data:', data)
          }
          return
        }

        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('open_url', { url: data.url })
        } catch (openerErr) {
          // opener failed — show the real error, not "Network error"
          setSigningIn(false)
          if (import.meta.env.DEV) {
            console.error('[Auth] open_url invoke failed:', openerErr)
          }
          setError(
            'Could not open the system browser to start Google sign-in. ' +
            (import.meta.env.DEV ? String(openerErr) : 'Please try again or restart the app.')
          )
          return
        }

        // signingIn stays true — reset by onAuthStateChange (SIGNED_IN event) when the
        // deep link returns, or by the 75-second timeout below, or when the window
        // regains focus without a session.
        const TIMEOUT_MS = 75_000
        signingInTimeoutRef.current = setTimeout(() => {
          setSigningIn((prev) => {
            if (!prev) return prev // already cleared
            setError('Google sign-in timed out. Please try again.')
            return false
          })
        }, TIMEOUT_MS)
      }
      // Non-external flow (dev/browser): Supabase navigates the WebView directly;
      // onAuthStateChange will fire and clear signingIn.
    } catch (err) {
      setSigningIn(false)
      // Log the real error in dev; show a safe message in production.
      if (import.meta.env.DEV) {
        console.error('[Auth] signInWithGoogle unexpected error:', err)
        setError(`Google sign-in error: ${err?.message || String(err)}`)
      } else {
        setError('Google sign-in could not start. Please check the OAuth redirect configuration.')
      }
    }
  }, [])

  // When the window regains focus after external OAuth, check whether a session
  // arrived via the deep link. If not, reset the spinner after a brief delay so
  // the user isn't stuck with an infinite "Signing in..." button.
  useEffect(() => {
    if (!signingIn) return

    function handleFocus() {
      // Give the deep-link handler ~2 s to fire (it arrives near-simultaneously)
      const checkTimer = setTimeout(async () => {
        const { data: { session: current } } = await supabase.auth.getSession().catch(() => ({ data: {} }))
        if (!current) {
          // No session yet — user may have cancelled or the deep link is slow.
          // Don't reset yet; the 75-s timeout is the final backstop.
          // But if signingIn is still true and there's no session, show a hint.
        }
      }, 2000)
      return () => clearTimeout(checkTimer)
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [signingIn])

  // Clear the timeout when signingIn is reset by any means
  useEffect(() => {
    if (!signingIn && signingInTimeoutRef.current) {
      clearTimeout(signingInTimeoutRef.current)
      signingInTimeoutRef.current = null
    }
  }, [signingIn])

  const signOut = useCallback(async () => {
    try {
      setError(null)
      const { error: signOutError } = await supabase.auth.signOut()
      if (signOutError) {
        setError(signOutError.message || 'Sign-out failed')
      }
    } catch (err) {
      setError('Network error during sign-out')
    }
  }, [])

  const updateProfile = useCallback(async (updates) => {
    if (!user) return
    const { error: updateError } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      
    if (updateError) {
      console.error('Failed to update profile:', updateError)
      throw updateError
    }
    
    setProfile((prev) => prev ? { ...prev, ...updates } : prev)
  }, [user])

  const getCurrentUser = useCallback(async () => {
    try {
      const { data: { user: currentUser }, error: userError } =
        await supabase.auth.getUser()
      if (userError) throw userError
      return currentUser
    } catch (err) {
      console.error('getCurrentUser error:', err.message)
      return null
    }
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        loading,
        signingIn,
        error,
        clearError,
        signInWithGoogle,
        signOut,
        getCurrentUser,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
