import { Trophy, X, Loader, AlertCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import AchievementRow from "./AchievementRow"

export default function AchievementsModal({
  data,
  loading,
  error,
  onClose,
  title = 'Achievements',
  itemLabel = 'achievements',
  lockedLabel = 'Locked',
}) {
  const scrollRef = useRef(null)
  const [gamepadConnected, setGamepadConnected] = useState(false)

  // Gamepad polling for right stick scroll and B to close
  useEffect(() => {
    let rafId
    let wasConnected = false
    let lastButtonState = []

    function poll() {
      const pad = Array.from(navigator.getGamepads?.() ?? []).find(
        (p) => p?.connected,
      )
      if (pad) {
        if (!wasConnected) {
          setGamepadConnected(true)
          wasConnected = true
        }

        const hit = (idx) => pad.buttons[idx]?.pressed && !lastButtonState[idx]

        // B button to close
        if (hit(1)) {
          onClose()
          return
        }

        // Right stick Y (usually axes[3])
        const stickY = pad.axes[3] || 0
        if (Math.abs(stickY) > 0.15 && scrollRef.current) {
          scrollRef.current.scrollTop += stickY * 15
        }

        lastButtonState = pad.buttons.map((b) => b.pressed)
      } else if (wasConnected) {
        setGamepadConnected(false)
        wasConnected = false
        lastButtonState = []
      }
      rafId = requestAnimationFrame(poll)
    }

    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [onClose])

  const achievements = data?.achievements || []
  const unlocked = achievements.filter((a) => a.unlocked)
  const locked = achievements.filter((a) => !a.unlocked)

  return (
    <div className="ach-modal__backdrop" onClick={onClose}>
      <div className="ach-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ach-modal__header">
          <div className="ach-modal__header-left">
            <Trophy size={20} className="ach-modal__trophy" />
            <h2 className="ach-modal__title">{title}</h2>
            {data?.available && data.progress && (
              <span className="ach-modal__count">
                {data.progress.unlocked} / {data.progress.total}
              </span>
            )}
          </div>
          <button className="ach-modal__close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {data?.available && data.progress && (
          <div className="ach-modal__progress">
            <div className="ach-modal__bar-track">
              <div
                className="ach-modal__bar-fill"
                style={{ width: `${data.progress.percentage}%` }}
              />
            </div>
            <span className="ach-modal__pct">
              {Math.round(data.progress.percentage)}%
            </span>
          </div>
        )}

        <div className="ach-modal__body" ref={scrollRef}>
          {loading && (
            <div className="ach-modal__state">
              <Loader size={18} className="settings__spinner" />
              <span>{`Loading ${itemLabel}...`}</span>
            </div>
          )}

          {error && (
            <div className="ach-modal__state">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && data?.available && achievements.length > 0 && (
            <div className="ach-section__list">
              {unlocked.map((a) => (
                <AchievementRow key={a.id} achievement={a} />
              ))}

              {locked.length > 0 && (
                <>
                  {unlocked.length > 0 && (
                    <div className="ach-section__divider">
                      <span>{lockedLabel}</span>
                    </div>
                  )}
                  {locked.map((a) => (
                    <AchievementRow key={a.id} achievement={a} />
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {gamepadConnected && (
          <div className="ach-modal__hints">
            <span className="ach-modal__hint">
              <kbd>RS ↕</kbd> Scroll
            </span>
            <span className="ach-modal__hint">
              <kbd>B</kbd> Close
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
