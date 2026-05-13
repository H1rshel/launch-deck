import { Clock } from 'lucide-react'
import { useGameContext } from '../../context/GameContext'

function relativeTime(dateString) {
  if (!dateString) return null
  const d = new Date(dateString)
  if (isNaN(d.getTime())) return null

  const diffMs = Date.now() - d.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  if (diffSecs < 60) return 'Just now'
  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 30) return `${diffDays} days ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths === 1) return '1 month ago'
  if (diffMonths < 12) return `${diffMonths} months ago`
  const diffYears = Math.floor(diffMonths / 12)
  return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`
}

/**
 * LastPlayedBadge — shows when a game was last played, or "Playing now".
 *
 * Props:
 *   game – enriched game object
 */
export default function LastPlayedBadge({ game }) {
  const { activeGames } = useGameContext()
  const isPlaying = activeGames.has(game.id)

  if (isPlaying) {
    return (
      <span className="last-played-badge last-played-badge--live">
        <span className="playtime-display__pulse" />
        Playing now
      </span>
    )
  }

  const relative = relativeTime(game.last_played)
  if (!relative) return null

  return (
    <span className="last-played-badge">
      <Clock size={12} />
      {relative}
    </span>
  )
}
