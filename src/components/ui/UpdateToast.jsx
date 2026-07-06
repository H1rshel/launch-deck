import { useState, useEffect, useRef } from 'react'
import { Download, ArrowRight, X, Zap } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

/**
 * Prominent, auto-dismissing toast shown when a new Launch Deck version is
 * detected (available, or downloaded-and-ready for auto-download mode).
 *
 * Driven by the same update-banner state as UpdateBanner, but this one grabs
 * attention: it slides in from the top-center, then auto-dismisses after a few
 * seconds. The persistent bottom-right banner and the bell-tray entry remain
 * afterwards as quiet reminders. It shows once per version so it never nags.
 */
const AUTO_DISMISS_MS = 15000

export default function UpdateToast({ banner }) {
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const shownKeyRef = useRef(null)
  const timerRef = useRef(null)

  const version = banner?.version || null
  const ready = !!banner?.ready
  const key = version ? `${version}:${ready ? 'ready' : 'available'}` : null

  useEffect(() => {
    if (!key) return
    if (shownKeyRef.current === key) return // already surfaced this one
    shownKeyRef.current = key

    setLeaving(false)
    setVisible(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(startLeave, AUTO_DISMISS_MS)
    return () => clearTimeout(timerRef.current)
  }, [key])

  function startLeave() {
    setLeaving(true)
    setTimeout(() => {
      setVisible(false)
      setLeaving(false)
    }, 300)
  }

  function goToUpdates() {
    startLeave()
    navigate('/settings', { state: { scrollTo: 'updates' } })
  }

  if (!visible || !banner) return null

  return (
    <div
      className={`update-toast${leaving ? ' update-toast--leaving' : ''}`}
      role="alert"
      aria-live="assertive"
    >
      <div className="update-toast__icon">
        <Zap size={18} />
      </div>
      <div className="update-toast__body">
        <span className="update-toast__title">
          {ready
            ? `Launch Deck ${version} is ready`
            : `Launch Deck ${version} is available`}
        </span>
        <span className="update-toast__msg">
          {ready
            ? 'Restart Launch Deck to apply the update.'
            : banner.notes?.split('\n')[0] || 'A new version is ready to download.'}
        </span>
      </div>
      <button className="update-toast__cta" onClick={goToUpdates}>
        <Download size={13} />
        {ready ? 'Restart' : 'Update'}
        <ArrowRight size={12} />
      </button>
      <button className="update-toast__close" onClick={startLeave} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  )
}
