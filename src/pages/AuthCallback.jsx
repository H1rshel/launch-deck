import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

/**
 * /auth/callback — handles the Supabase PKCE code exchange in browser/dev mode.
 *
 * In production Tauri builds this route is never hit because:
 *   - the redirectTo is launchdeck://auth/callback (deep link)
 *   - deepLinkHandler.js handles the code exchange natively
 *
 * In browser and tauri-dev mode:
 *   - Supabase redirects to http://localhost:5174/auth/callback?code=XXX
 *   - This component reads the code, calls exchangeCodeForSession, then navigates.
 */
export default function AuthCallback() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('Completing sign-in…')
  const [errorMsg, setErrorMsg] = useState(null)
  const exchanged = useRef(false)

  useEffect(() => {
    if (exchanged.current) return
    exchanged.current = true

    async function exchange() {
      try {
        const params = new URLSearchParams(window.location.search)
        const code = params.get('code')

        if (!code) {
          // Supabase sometimes puts tokens in the hash (implicit flow)
          // For PKCE we always expect a `code` parameter.
          setErrorMsg('No authorization code found in the callback URL. Please try signing in again.')
          return
        }

        const { error } = await supabase.auth.exchangeCodeForSession(code)

        if (error) {
          console.error('[AuthCallback] exchangeCodeForSession failed:', error)
          setErrorMsg(`Sign-in failed: ${error.message || 'Unknown error'}. Please try again.`)
          return
        }

        // Success — onAuthStateChange in AuthContext will pick up SIGNED_IN and
        // navigate; but we also navigate here as a fallback.
        const mode = JSON.parse(localStorage.getItem('ld_setting_startupMode') || '"normal"')
        navigate(mode === 'console' ? '/console' : '/dashboard', { replace: true })
      } catch (err) {
        console.error('[AuthCallback] Unexpected error:', err)
        setErrorMsg('An unexpected error occurred during sign-in. Please try again.')
      }
    }

    exchange()
  }, [navigate])

  return (
    <div className="loading-screen">
      {errorMsg ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <p style={{ color: 'var(--color-danger, #f87171)', marginBottom: '1rem' }}>{errorMsg}</p>
          <button
            onClick={() => navigate('/login', { replace: true })}
            style={{
              padding: '0.5rem 1.5rem',
              background: 'var(--color-accent, #6366f1)',
              color: '#fff',
              border: 'none',
              borderRadius: '0.5rem',
              cursor: 'pointer',
            }}
          >
            Back to Login
          </button>
        </div>
      ) : (
        <>
          <div className="loading-spinner" />
          <p>{status}</p>
        </>
      )}
    </div>
  )
}
