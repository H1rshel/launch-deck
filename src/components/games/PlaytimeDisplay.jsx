import { Clock } from 'lucide-react'
import { useGameContext } from '../../context/GameContext'

function formatMinutes(minutes) {
  if (!minutes || minutes < 1) return '0m'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function formatLiveSeconds(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * PlaytimeDisplay — shows total playtime with optional Steam breakdown.
 * When the game is actively running, shows a live "Playing now" counter.
 *
 * Props:
 *   game           – enriched game object from DB
 *   steamPlaytime  – minutes from Steam (number | null)
 *   compact        – if true, renders a minimal single-line format
 */
export default function PlaytimeDisplay({
  game,
  importedPlaytime = null,
  compact = false,
}) {
  const { activeGames, liveElapsed } = useGameContext()
  const isPlaying = activeGames.has(game.id)
  const liveSeconds = liveElapsed[game.id] || 0

  const localMinutes = game.playtime_minutes || 0
  const importedMinutes =
    typeof importedPlaytime === 'number'
      ? importedPlaytime
      : game.imported_playtime_minutes || 0
  const totalMinutes = localMinutes + importedMinutes

  if (compact) {
    if (isPlaying) {
      return (
        <span className="playtime-display playtime-display--compact playtime-display--live">
          <span className="playtime-display__pulse" />
          Playing now · {formatLiveSeconds(liveSeconds)}
        </span>
      )
    }
    return (
      <span className="playtime-display playtime-display--compact">
        <Clock size={12} />
        {formatMinutes(totalMinutes)}
      </span>
    )
  }

  return (
    <div className={`playtime-display${isPlaying ? ' playtime-display--active' : ''}`}>
      <div className="playtime-display__primary">
        {isPlaying ? (
          <>
            <span className="playtime-display__pulse" />
            <span className="playtime-display__value playtime-display__value--live">
              {formatLiveSeconds(liveSeconds)}
            </span>
            <span className="playtime-display__live-label">Playing now</span>
          </>
        ) : (
          <>
            <Clock size={16} className="playtime-display__icon" />
            <span className="playtime-display__value">{formatMinutes(totalMinutes)}</span>
          </>
        )}
      </div>
    </div>
  )
}
