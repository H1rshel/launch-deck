import { useNavigate } from 'react-router-dom'
import { Square, Clock, Gamepad2 } from 'lucide-react'
import { useGameContext } from '../../context/GameContext'
import { getGameImages } from '../../utils/imageHandler'

function formatElapsed(seconds) {
  if (!seconds || seconds < 1) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function NowPlayingBar() {
  const navigate = useNavigate()
  const { games, activeGames, liveElapsed, forceEndSession } = useGameContext()

  const activeIds = Array.from(activeGames)
  if (activeIds.length === 0) return null

  // Show the most recently launched active game
  const gameId = activeIds[activeIds.length - 1]
  const game = games.find((g) => g.id === gameId)
  if (!game) return null

  const elapsed = liveElapsed[gameId] || 0
  const { cover, hero } = getGameImages(game)
  const bgImage = cover || hero

  function handleNavigate() {
    navigate(`/game/${game.id}`)
  }

  return (
    <div className="now-playing-bar" role="status" aria-label={`Now playing: ${game.displayTitle}`}>
      {/* Ambient background tint from game art */}
      {bgImage && (
        <div
          className="now-playing-bar__ambient"
          style={{ backgroundImage: `url(${bgImage})` }}
        />
      )}

      <button className="now-playing-bar__game-info" onClick={handleNavigate} title="Go to game page">
        <div className="now-playing-bar__cover-wrap">
          {bgImage ? (
            <img src={bgImage} alt="" className="now-playing-bar__cover" />
          ) : (
            <div className="now-playing-bar__cover now-playing-bar__cover--placeholder">
              <Gamepad2 size={18} />
            </div>
          )}
          <span className="now-playing-bar__status-dot" />
        </div>
        <div className="now-playing-bar__text">
          <span className="now-playing-bar__label">Now Playing</span>
          <span className="now-playing-bar__title">{game.displayTitle}</span>
        </div>
      </button>

      <div className="now-playing-bar__center">
        <div className="now-playing-bar__clock">
          <Clock size={14} className="now-playing-bar__clock-icon" />
          <span className="now-playing-bar__clock-time">{formatElapsed(elapsed)}</span>
        </div>
        <div className="now-playing-bar__waveform" aria-hidden="true">
          {[...Array(5)].map((_, i) => (
            <span key={i} className="now-playing-bar__bar" style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
        </div>
      </div>

      <button
        className="now-playing-bar__stop"
        onClick={() => forceEndSession(gameId)}
        title="End session"
      >
        <Square size={14} fill="currentColor" />
        <span>End Session</span>
      </button>
    </div>
  )
}
