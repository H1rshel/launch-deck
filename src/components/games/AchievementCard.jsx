function formatUnlockDate(unlockTime) {
  if (!unlockTime) return null
  const d = new Date(unlockTime * 1000)
  const day = d.getDate().toString().padStart(2, '0')
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const year = d.getFullYear()
  return `${day}/${month}/${year}`
}

export default function AchievementCard({ achievement }) {
  const { name, description, icon, unlocked, unlock_time } = achievement
  const unlockDate = formatUnlockDate(unlock_time)

  return (
    <div className={`achievement-card${unlocked ? ' achievement-card--unlocked' : ' achievement-card--locked'}`}>
      <div className="achievement-card__icon-wrap">
        {icon ? (
          <img
            src={icon}
            alt={name}
            className="achievement-card__icon"
            loading="lazy"
          />
        ) : (
          <div className="achievement-card__icon-placeholder" />
        )}
        {unlocked && <div className="achievement-card__glow" />}
      </div>

      {/* Hover tooltip */}
      <div className="achievement-card__tooltip">
        <span className="achievement-card__tooltip-name">{name}</span>
        {description && (
          <span className="achievement-card__tooltip-desc">{description}</span>
        )}
        {unlockDate && (
          <span className="achievement-card__tooltip-date">Unlocked {unlockDate}</span>
        )}
        {!unlocked && (
          <span className="achievement-card__tooltip-locked">Locked</span>
        )}
      </div>
    </div>
  )
}
