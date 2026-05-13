import { Square, Clock } from 'lucide-react'
import { useGameContext } from '../../context/GameContext'
import { getGameImages } from '../../utils/imageHandler'
import { GameLogo } from '../ui/GameImages'

function formatElapsed(seconds) {
  if (!seconds || seconds < 1) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function ConsoleModeNowPlaying({ gamepadConnected }) {
  const { games, activeGames, liveElapsed, forceEndSession } = useGameContext()

  const activeIds = Array.from(activeGames)
  if (activeIds.length === 0) return null

  const gameId = activeIds[activeIds.length - 1]
  const game = games.find((g) => g.id === gameId)
  if (!game) return null

  const elapsed = liveElapsed[gameId] || 0
  const { cover, hero, logo } = getGameImages(game)
  const coverImg = cover || hero

  return (
    <div className="console-now-playing">
      {/* Scan-line overlay for retro feel */}
      <div className="console-now-playing__scanlines" aria-hidden="true" />

      <div className="console-now-playing__inner">
        {/* Cover thumbnail */}
        {coverImg && (
          <div className="console-now-playing__cover-wrap">
            <img src={coverImg} alt="" className="console-now-playing__cover" />
            <div className="console-now-playing__cover-glow" />
          </div>
        )}

        {/* Game identity */}
        <div className="console-now-playing__identity">
          <span className="console-now-playing__badge">
            <span className="console-now-playing__badge-dot" />
            NOW PLAYING
          </span>
          {logo ? (
            <GameLogo game={game} className="console-now-playing__logo" />
          ) : (
            <span className="console-now-playing__title">{game.displayTitle}</span>
          )}
        </div>

        {/* Divider */}
        <div className="console-now-playing__divider" aria-hidden="true" />

        {/* Live clock */}
        <div className="console-now-playing__clock-wrap">
          <Clock size={13} className="console-now-playing__clock-icon" />
          <span className="console-now-playing__clock">{formatElapsed(elapsed)}</span>
          <span className="console-now-playing__session-label">Session</span>
        </div>

        {/* Waveform bars */}
        <div className="console-now-playing__waveform" aria-hidden="true">
          {[...Array(7)].map((_, i) => (
            <span key={i} className="console-now-playing__bar" style={{ animationDelay: `${i * 0.1}s` }} />
          ))}
        </div>

        {/* Stop */}
        <button
          className="console-now-playing__stop"
          onClick={() => forceEndSession(gameId)}
          title="End session"
        >
          {gamepadConnected ? (
            <kbd className="console-now-playing__hotkey console-now-playing__hotkey--yellow">Y</kbd>
          ) : (
            <kbd className="console-now-playing__hotkey">Q</kbd>
          )}
          <span>End</span>
        </button>
      </div>
    </div>
  )
}
