export default function AchievementsProgress({ unlocked, total, percentage }) {
  return (
    <div className="achievements-progress">
      <div className="achievements-progress__bar-track">
        <div
          className="achievements-progress__bar-fill"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="achievements-progress__label">
        {unlocked} / {total}
      </span>
    </div>
  )
}
