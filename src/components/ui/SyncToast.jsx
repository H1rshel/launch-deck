import { useEffect } from 'react'
import { Sparkles } from 'lucide-react'

const AUTO_DISMISS_MS = 6000

/**
 * Non-intrusive bottom-right toast shown when the background sync
 * auto-detects and adds newly installed games.
 *
 * Props:
 *   toast  – { count: number, titles: string[] }
 *   onDismiss – () => void
 */
export default function SyncToast({ toast, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast, onDismiss])

  const label = toast.message ||
    (toast.count === 1
      ? `"${toast.titles[0]}" was added to your library`
      : `${toast.count} new games added to your library`)

  return (
    <div className="sync-toast" role="status" aria-live="polite">
      <Sparkles size={14} className="sync-toast__icon" />
      <span className="sync-toast__text">{label}</span>
      <button className="sync-toast__close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
