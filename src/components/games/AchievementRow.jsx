import { Lock } from 'lucide-react'

export function formatUnlockDate(unlockTime) {
  if (!unlockTime) return null
  const d = new Date(unlockTime * 1000)
  const day = d.getDate().toString().padStart(2, '0')
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const year = d.getFullYear()
  return `${day}/${month}/${year}`
}

export default function AchievementRow({ achievement }) {
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
