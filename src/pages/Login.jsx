import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import Logo from '../components/ui/Logo'
import GoogleLoginButton from '../components/auth/GoogleLoginButton'

export default function Login() {
  const { user, loading, signingIn, error, clearError } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && user) {
      const mode = JSON.parse(localStorage.getItem('ld_setting_startupMode') || '"normal"')
      if (mode === 'console') {
        sessionStorage.setItem('console_startup', '1')
        navigate('/console', { replace: true })
      } else {
        navigate('/dashboard', { replace: true })
      }
    }
  }, [user, loading, navigate])

  // Auto-clear error after 8 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(clearError, 8000)
      return () => clearTimeout(timer)
    }
  }, [error, clearError])

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>Initializing...</p>
      </div>
    )
  }

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-card__glow-ring" />
        <Logo size={110} />
        <h1 className="login-card__title">Launch Deck</h1>
        <p className="login-card__subtitle">Your premium game launcher</p>

        <div className="login-card__divider" />

        {error && (
          <div className="login-card__error">
            <span>{error}</span>
            <button className="login-card__error-close" onClick={clearError}>
              &times;
            </button>
          </div>
        )}

        <GoogleLoginButton loading={signingIn} />

        <p className="login-card__footer">
          Sign in to access your game library
        </p>
      </div>
    </div>
  )
}
