import { useState, useEffect } from 'react'
import { X, Trophy, Clock } from 'lucide-react'
import { getGameImages } from '../../utils/imageHandler'

function formatSessionTime(seconds) {
  if (!seconds || seconds <= 0) return '0s'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return m === 1 && s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

export default function SessionEndModal({ summary, onClose, gamepadConnected }) {
  const [visible, setVisible] = useState(false)
  const [barWidth, setBarWidth] = useState(0)
  const { game, elapsedSecs, newAchievements, achData, achLoading } = summary
  const { hero, cover, logo } = getGameImages(game)
  const bgImage = hero || cover

  const timeStr = formatSessionTime(elapsedSecs)
  const progress = achData?.progress
  const hasNewAchs = newAchievements?.length > 0

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setVisible(true)
      setTimeout(() => setBarWidth(progress?.percentage ?? 0), 300)
    })
    return () => cancelAnimationFrame(frame)
  }, [progress?.percentage])

  return (
    <div
      className={`session-modal__backdrop ${visible ? 'session-modal__backdrop--visible' : ''}`}
      onClick={onClose}
    >
      <div
        className="session-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero header */}
        {bgImage && (
          <div className="session-modal__hero">
            <div
              className="session-modal__hero-img"
              style={{ backgroundImage: `url(${bgImage})` }}
            />
            <div className="session-modal__hero-overlay" />
            <div className="session-modal__hero-badge">Session Complete</div>
            {logo ? (
              <img
                src={logo}
                alt={game.displayTitle}
                className="session-modal__hero-logo"
              />
            ) : (
              <h2 className="session-modal__hero-title">{game.displayTitle}</h2>
            )}
          </div>
        )}

        <div className="session-modal__body">
          {/* Close button */}
          <button className="session-modal__close" onClick={onClose} title="Close">
            <X size={18} />
          </button>

          {/* No hero fallback title */}
          {!bgImage && (
            <div className="session-modal__fallback-header">
              <span className="session-modal__label">Session Complete</span>
              <h2 className="session-modal__fallback-title">{game.displayTitle}</h2>
            </div>
          )}

          {/* Time played */}
          <div className="session-modal__time-card">
            <Clock size={18} className="session-modal__time-icon" />
            <div className="session-modal__time-content">
              <span className="session-modal__time-label">Time Played</span>
              <span className="session-modal__time-value">{timeStr}</span>
            </div>
          </div>

          {/* New achievements */}
          {achLoading && (
            <div className="session-modal__ach-loading">
              <div className="session-modal__ach-spinner" />
              <span>Checking achievements...</span>
            </div>
          )}

          {!achLoading && hasNewAchs && (
            <div className="session-modal__achievements">
              <div className="session-modal__section-title">
                <Trophy size={14} />
                <span>{newAchievements.length} Achievement{newAchievements.length > 1 ? 's' : ''} Unlocked</span>
              </div>
              <div className="session-modal__ach-list">
                {newAchievements.map((a, i) => (
                  <div
                    key={a.id}
                    className="session-modal__ach-item"
                    style={{ animationDelay: `${i * 80}ms` }}
                  >
                    {a.icon && (
                      <img
                        src={a.icon}
                        alt={a.name}
                        className="session-modal__ach-icon"
                      />
                    )}
                    <div className="session-modal__ach-info">
                      <span className="session-modal__ach-name">{a.name}</span>
                      {a.description && (
                        <span className="session-modal__ach-desc">{a.description}</span>
                      )}
                    </div>
                    <span className="session-modal__ach-badge">New</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Overall achievement progress */}
          {!achLoading && progress && achData?.available && (
            <div className="session-modal__progress">
              <div className="session-modal__progress-header">
                <span className="session-modal__progress-label">
                  Achievement Progress
                </span>
                <span className="session-modal__progress-pct">
                  {progress.unlocked} / {progress.total}
                </span>
              </div>
              <div className="session-modal__bar-track">
                <div
                  className="session-modal__bar-fill"
                  style={{ width: `${barWidth}%` }}
                />
              </div>
            </div>
          )}

          {/* Close button */}
          <button className="session-modal__continue-btn" onClick={onClose}>
            {gamepadConnected ? (
              <>
                <kbd className="console-now-playing__hotkey">A</kbd>
                Continue
              </>
            ) : (
              'Continue'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
