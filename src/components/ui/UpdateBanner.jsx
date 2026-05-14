import { useState } from 'react'
import { Download, ArrowRight, X, Zap } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { clearUpdateBanner } from '../../services/updateState'

/**
 * Floating non-blocking banner shown when a new Launch Deck version is
 * available. Sits in the bottom-right corner, similar to SyncToast.
 *
 * The user can:
 *   "Update now"  → navigates to Settings → Updates section
 *   "Later"       → dismisses for this session (banner is cleared from state)
 *
 * This banner never auto-dismisses and never forces any action.
 */
export default function UpdateBanner({ banner }) {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)

  function dismiss() {
    setLeaving(true)
    setTimeout(() => clearUpdateBanner(), 250)
  }

  function goToSettings() {
    navigate('/settings', { state: { scrollTo: 'updates' } })
  }

  return (
    <div className={`update-banner${leaving ? ' update-banner--leaving' : ''}`} role="status" aria-live="polite">
      <div className="update-banner__icon-wrap">
        <Zap size={14} className="update-banner__icon" />
      </div>
      <div className="update-banner__body">
        <span className="update-banner__title">
          Launch Deck {banner.version} available
        </span>
        {banner.notes && (
          <span className="update-banner__notes">{banner.notes.split('\n')[0]}</span>
        )}
      </div>
      <div className="update-banner__actions">
        <button className="update-banner__btn update-banner__btn--primary" onClick={goToSettings}>
          <Download size={12} />
          Update
          <ArrowRight size={11} />
        </button>
        <button className="update-banner__btn update-banner__btn--dismiss" onClick={dismiss} aria-label="Dismiss">
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
