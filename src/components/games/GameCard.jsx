import { useNavigate } from 'react-router-dom'
import { Play, Download, Star, Trash2, Heart, X } from 'lucide-react'
import { useGameContext } from '../../context/GameContext'
import { canInstallGame } from '../../lib/launcher'

import { getGameImages } from '../../utils/imageHandler'
import { ImageWithFallback } from '../ui/GameImages'

function formatDate(dateStr) {
  if (!dateStr) return ''
  const parts = dateStr.split('-')
  if (parts.length !== 3) return dateStr
  const [year, month, day] = parts
  return `${day}/${month}/${year}`
}

export default function GameCard({ game, onRemove, onClearFranchise, isExiting }) {
  const navigate = useNavigate()
  const { playGame, toggleFavorite, installGame } = useGameContext()
  const { cover, hero } = getGameImages(game)
  const bgImage = cover || hero
  const coverStyle = bgImage
    ? { backgroundImage: `url(${bgImage})` }
    : { background: game.gradient }
  const installable = canInstallGame(game)

  function handleCardClick() {
    navigate(`/game/${game.id}`)
  }

  function handlePlay(e) {
    e.stopPropagation()
    playGame(game).catch((err) => console.error(err))
  }

  function handleInstall(e) {
    e.stopPropagation()
    installGame(game).catch((err) => console.error(err))
  }

  const cardClass = [
    'game-card',
    isExiting ? 'game-card--exiting' : '',
    !game.installed ? 'game-card--uninstalled' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cardClass} onClick={handleCardClick}>
      <div className="game-card__cover">
        <div className="game-card__bg" style={coverStyle} />
        <div className="game-card__overlay">
          <span className="game-card__title-lg">{game.displayTitle}</span>
        </div>
        {!game.installed && (
          <span className="game-card__uninstalled-badge">Not Installed</span>
        )}
        {!!game.is_new && (
          <span className="game-card__new-badge">New</span>
        )}
        {!!game.installed && (
          <button className="game-card__play-btn" onClick={handlePlay}>
            <Play size={18} fill="currentColor" />
          </button>
        )}
        {onRemove && (
          <button
            className="game-card__remove-btn"
            onClick={(e) => { e.stopPropagation(); onRemove(game.id); }}
            title="Remove from library"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="game-card__info">
        <div className="game-card__title-row">
          <h3 className="game-card__title">{game.displayTitle}</h3>
          <button
            className={`game-card__fav-btn ${game.favorite ? 'game-card__fav-btn--active' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleFavorite(game.id); }}
            title={game.favorite ? 'Unfavorite' : 'Favorite'}
          >
            <Heart size={13} fill={game.favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
        <div className="game-card__meta">
          <span className="game-card__genre">{game.platform}</span>
          {game.rating > 0 ? (
            <span className="game-card__rating">
              <Star size={12} fill="var(--accent-amber)" stroke="var(--accent-amber)" />
              {game.rating.toFixed(1)}
            </span>
          ) : (
            <span className="game-card__rating">
              {game.playtime} played
            </span>
          )}
        </div>
        {(game.franchiseNames?.length > 0 || game.collectionNames?.length > 0) && (
          <div className="game-card__taxonomy">
            <span className="game-card__franchise-tag">
              {game.franchiseNames?.length > 0
                ? game.franchiseNames[0]
                : game.collectionNames[0]}
            </span>
            {onClearFranchise && (
              <button
                className="game-card__franchise-clear"
                title="Remove from this franchise"
                onClick={(e) => { e.stopPropagation(); onClearFranchise(game.id) }}
              >
                <X size={10} />
              </button>
            )}
          </div>
        )}
        <div className="game-card__footer">
          {game.release_date ? (
            <span className="game-card__size">{formatDate(game.release_date)}</span>
          ) : (
            <span className="game-card__size">{game.progress_percent}% complete</span>
          )}
          {game.installed ? (
            <span className="game-card__status game-card__status--installed">Installed</span>
          ) : installable ? (
            <button className="game-card__install-btn" onClick={handleInstall}>
              <Download size={14} />
              Install
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
