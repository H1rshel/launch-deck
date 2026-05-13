import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Play, MoreVertical, ArrowRightLeft, Trash2, RotateCcw } from 'lucide-react'
import { useGameContext } from '../../context/GameContext'
import { getGameImages } from '../../utils/imageHandler'

function formatPlaytime(minutes) {
  if (!minutes || minutes < 1) return null
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export default function CompactGameCard({ game, onMoveToCollection, onRemoveFromCollection, onClearFranchise }) {
  const navigate = useNavigate()
  const { playGame } = useGameContext()
  const { cover } = getGameImages(game)
  const [menuPos, setMenuPos] = useState(null)
  const btnRef = useRef(null)

  // Total playtime = Launch Deck tracked + imported
  const totalMinutes = (game.playtime_minutes || 0) + (game.imported_playtime_minutes || 0)
  const playtimeLabel = formatPlaytime(totalMinutes)

  const coverStyle = cover
    ? { backgroundImage: `url(${cover})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: game.gradient }

  function handlePlay(e) {
    e.stopPropagation()
    playGame(game).catch(console.error)
  }

  const openMenu = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 4, left: rect.right - 180 })
    }
  }, [])

  const closeMenu = useCallback(() => setMenuPos(null), [])

  return (
    <div className={`compact-card${!game.installed ? ' compact-card--uninstalled' : ''}`} onClick={() => navigate(`/game/${game.id}`)}>
      <div className="compact-card__cover" style={coverStyle}>
        {!game.installed && (
          <span className="compact-card__uninstalled">Not Installed</span>
        )}
        {!!game.is_new && (
          <span className="compact-card__new-badge">New</span>
        )}
        {!!game.installed && (
          <button className="compact-card__play" onClick={handlePlay}>
            <Play size={14} fill="currentColor" />
          </button>
        )}
      </div>
      <div className="compact-card__body">
        <span className="compact-card__title">{game.displayTitle}</span>
        <div className="compact-card__meta">
          {playtimeLabel ? (
            <span className="compact-card__playtime">{playtimeLabel}</span>
          ) : (
            <span className="compact-card__playtime compact-card__playtime--none">No playtime</span>
          )}
          {game.platform && (
            <span className="compact-card__platform">{game.platform}</span>
          )}
        </div>
      </div>

      {/* Menu trigger */}
      <div className="compact-card__menu-anchor" onClick={(e) => e.stopPropagation()}>
        <button
          ref={btnRef}
          className="compact-card__menu-btn"
          onClick={menuPos ? closeMenu : openMenu}
        >
          <MoreVertical size={14} />
        </button>
      </div>

      {/* Menu rendered via portal to escape overflow:hidden */}
      {menuPos && createPortal(
        <>
          <div className="compact-card__menu-backdrop" onClick={closeMenu} />
          <div
            className="compact-card__menu"
            style={{ top: menuPos.top, left: menuPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {onMoveToCollection && (
              <button
                className="compact-card__menu-item"
                onClick={() => { closeMenu(); onMoveToCollection(game) }}
              >
                <ArrowRightLeft size={13} />
                <span>Move to collection…</span>
              </button>
            )}
            {onRemoveFromCollection && (
              <button
                className="compact-card__menu-item"
                onClick={() => { closeMenu(); onRemoveFromCollection(game.id) }}
              >
                <Trash2 size={13} />
                <span>Remove from collection</span>
              </button>
            )}
            {onClearFranchise && (
              <button
                className="compact-card__menu-item"
                onClick={() => { closeMenu(); onClearFranchise(game.id) }}
              >
                <RotateCcw size={13} />
                <span>Reset to auto-detect</span>
              </button>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
