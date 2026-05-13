import { Trophy, Loader, AlertCircle } from 'lucide-react'
import AchievementCard from './AchievementCard'

function formatUnlockDate(unlockTime) {
  if (!unlockTime) return null
  const d = new Date(unlockTime * 1000)
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

const GRID_MAX = 11
const RING_RADIUS = 16
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export default function AchievementsPreview({
  data,
  loading,
  refreshing = false,
  error,
  onShowAll,
  title = 'Achievements',
  itemLabel = 'achievements',
  lockedLabel = 'Locked Achievements',
  ctaLabel = 'View My Achievements',
}) {
  if (!data && !loading && !error && !refreshing) return null

  const achievements = data?.achievements || []
  const unlocked = achievements.filter((achievement) => achievement.unlocked)
  const locked = achievements.filter((achievement) => !achievement.unlocked)
  const showBlockingLoader = loading && !data
  const showBlockingError = !showBlockingLoader && !data && !!error
  const showUnavailable =
    !showBlockingLoader && !showBlockingError && data && !data.available

  const featured = unlocked[0]
  const gridUnlocked = unlocked.slice(1, GRID_MAX + 1)
  const moreUnlocked = Math.max(0, unlocked.length - 1 - GRID_MAX)
  const gridLocked = locked.slice(0, GRID_MAX)
  const moreLocked = Math.max(0, locked.length - GRID_MAX)

  // Next locked achievement to highlight
  const nextAchievement = locked[0]

  // Progress ring values
  const percentage = data?.progress?.percentage ?? 0
  const ringOffset = RING_CIRCUMFERENCE - (percentage / 100) * RING_CIRCUMFERENCE

  return (
    <div className="ach-preview">
      {/* SVG gradient definition (hidden) */}
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id="ach-ring-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--accent-cyan)" />
            <stop offset="100%" stopColor="var(--accent-purple)" />
          </linearGradient>
        </defs>
      </svg>

      <div className="ach-preview__header">
        <Trophy size={16} className="ach-preview__trophy" />
        <span className="ach-preview__title">{title}</span>
        {data?.available && data.progress && (
          <span className="ach-preview__count">
            {data.progress.unlocked} / {data.progress.total}
          </span>
        )}
        {refreshing && (
          <Loader
            size={14}
            className="ach-preview__refresh-spinner settings__spinner"
          />
        )}
      </div>

      {data?.available && data.progress && (
        <div className="ach-preview__progress">
          {/* Progress ring */}
          <div className="ach-preview__ring">
            <svg viewBox="0 0 36 36">
              <circle
                className="ach-preview__ring-bg"
                cx="18" cy="18" r={RING_RADIUS}
              />
              <circle
                className="ach-preview__ring-fill"
                cx="18" cy="18" r={RING_RADIUS}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={ringOffset}
              />
            </svg>
            <span className="ach-preview__ring-pct">
              {Math.round(percentage)}%
            </span>
          </div>
          {/* Linear bar */}
          <div className="ach-preview__progress-info">
            <div className="ach-preview__bar-track">
              <div
                className="ach-preview__bar-fill"
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className="ach-preview__pct">
              {data.progress.unlocked} of {data.progress.total} unlocked
            </span>
          </div>
        </div>
      )}

      {showBlockingLoader && (
          <div className="ach-preview__state">
            <Loader size={16} className="settings__spinner" />
            <span>{`Loading ${itemLabel}...`}</span>
          </div>
      )}

      {showBlockingError && (
        <div className="ach-preview__state">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {showUnavailable && (
        <div className="ach-preview__state">
          <AlertCircle size={14} />
          <span>{data.reason || 'Unavailable'}</span>
        </div>
      )}

      {!showBlockingLoader && data?.available && achievements.length > 0 && (
        <>
          {featured && (
            <div className="ach-preview__featured">
              <div className="ach-preview__featured-icon-wrap">
                {featured.icon ? (
                  <img
                    src={featured.icon}
                    alt={featured.name}
                    className="ach-preview__featured-icon"
                  />
                ) : (
                  <div className="ach-preview__featured-icon-placeholder" />
                )}
                <div className="ach-preview__featured-glow" />
              </div>
              <div className="ach-preview__featured-info">
                <span className="ach-preview__featured-name">
                  {featured.name}
                </span>
                {featured.description && (
                  <span className="ach-preview__featured-desc">
                    {featured.description}
                  </span>
                )}
                {featured.unlock_time && (
                  <span className="ach-preview__featured-date">
                    {formatUnlockDate(featured.unlock_time)}
                  </span>
                )}
              </div>
            </div>
          )}

          {gridUnlocked.length > 0 && (
            <div className="ach-preview__grid-row">
              {gridUnlocked.map((achievement) => (
                <AchievementCard
                  key={achievement.id}
                  achievement={achievement}
                />
              ))}
              {moreUnlocked > 0 && (
                <button className="ach-preview__overflow" onClick={onShowAll}>
                  +{moreUnlocked}
                </button>
              )}
            </div>
          )}

          {/* Next achievement to unlock */}
          {nextAchievement && (
            <div className="ach-preview__next">
              <span className="ach-preview__next-label">Next</span>
              <span className="ach-preview__next-name">{nextAchievement.name}</span>
            </div>
          )}

          {locked.length > 0 && (
            <>
              <div className="ach-preview__section-label">
                {lockedLabel}
              </div>
              <div className="ach-preview__grid-row ach-preview__grid-row--locked">
                {gridLocked.map((achievement) => (
                  <AchievementCard
                    key={achievement.id}
                    achievement={achievement}
                  />
                ))}
                {moreLocked > 0 && (
                  <button
                    className="ach-preview__overflow ach-preview__overflow--locked"
                    onClick={onShowAll}
                  >
                    +{moreLocked}
                  </button>
                )}
              </div>
            </>
          )}

          {onShowAll && (
            <button className="ach-preview__cta" onClick={onShowAll}>
              {ctaLabel}
            </button>
          )}
        </>
      )}
    </div>
  )
}
