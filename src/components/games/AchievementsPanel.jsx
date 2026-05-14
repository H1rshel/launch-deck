import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Trophy, Loader, AlertCircle, Lock } from 'lucide-react'

function formatUnlockDate(unlockTime) {
  if (!unlockTime) return null
  const d = new Date(unlockTime * 1000)
  const day = d.getDate().toString().padStart(2, '0')
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const year = d.getFullYear()
  return `${day}/${month}/${year}`
}

function AchievementRow({ achievement }) {
  const { name, description, icon, unlocked, unlock_time } = achievement
  const unlockDate = formatUnlockDate(unlock_time)

  return (
    <div className={`ach-row${unlocked ? ' ach-row--unlocked' : ' ach-row--locked'}`}>
      <div className="ach-row__icon-wrap">
        {icon ? (
          <img src={icon} alt={name} className="ach-row__icon" loading="lazy" />
        ) : (
          <div className="ach-row__icon-placeholder" />
        )}
      </div>
      <div className="ach-row__info">
        <span className="ach-row__name">{name}</span>
        {description && <span className="ach-row__desc">{description}</span>}
      </div>
      <div className="ach-row__status">
        {unlocked && unlockDate ? (
          <span className="ach-row__date">Unlocked {unlockDate}</span>
        ) : !unlocked ? (
          <span className="ach-row__locked-badge"><Lock size={12} /> Locked</span>
        ) : null}
      </div>
    </div>
  )
}

export default function AchievementsPanel({ gameName, steamId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (!gameName || !steamId) return

    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)

    invoke('get_steam_achievements', {
      query: gameName,
      steamId,
      steamApiKey: localStorage.getItem('steamApiKey') || '',
    })
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err) => {
        if (!cancelled) setError(typeof err === 'string' ? err : 'Failed to load achievements')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [gameName, steamId])

  if (!steamId) return null

  const achievements = data?.achievements || []
  const unlocked = achievements.filter(a => a.unlocked)
  const locked = achievements.filter(a => !a.unlocked)
  const PREVIEW_COUNT = 8
  const hasMore = achievements.length > PREVIEW_COUNT
  const visible = showAll ? achievements : achievements.slice(0, PREVIEW_COUNT)
  const visibleUnlocked = visible.filter(a => a.unlocked)
  const visibleLocked = visible.filter(a => !a.unlocked)

  return (
    <div className="ach-section">
      <div className="ach-section__header">
        <Trophy size={18} className="ach-section__icon" />
        <h3 className="ach-section__title">Achievements</h3>
        {data?.available && data.progress && (
          <span className="ach-section__count">
            {data.progress.unlocked} / {data.progress.total}
          </span>
        )}
      </div>

      {data?.available && data.progress && (
        <div className="ach-section__progress">
          <div className="ach-section__bar-track">
            <div
              className="ach-section__bar-fill"
              style={{ width: `${data.progress.percentage}%` }}
            />
          </div>
          <span className="ach-section__pct">{Math.round(data.progress.percentage)}%</span>
        </div>
      )}

      {loading && (
        <div className="ach-section__state">
          <Loader size={18} className="settings__spinner" />
          <span>Loading achievements...</span>
        </div>
      )}

      {error && (
        <div className="ach-section__state ach-section__state--error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && data && !data.available && (
        <div className="ach-section__state ach-section__state--unavailable">
          <AlertCircle size={16} />
          <span>{data.reason || 'Achievements not available'}</span>
        </div>
      )}

      {!loading && !error && data?.available && achievements.length > 0 && (
        <>
          <div className="ach-section__list">
            {visibleUnlocked.length > 0 && visibleUnlocked.map(a => (
              <AchievementRow key={a.id} achievement={a} />
            ))}

            {visibleLocked.length > 0 && (
              <>
                {visibleUnlocked.length > 0 && (
                  <div className="ach-section__divider">
                    <span>Locked</span>
                  </div>
                )}
                {visibleLocked.map(a => (
                  <AchievementRow key={a.id} achievement={a} />
                ))}
              </>
            )}
          </div>

          {hasMore && (
            <button
              className="ach-section__toggle"
              onClick={() => setShowAll(s => !s)}
            >
              {showAll ? 'Show less' : `Show all ${achievements.length} achievements`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
