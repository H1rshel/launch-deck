import { Gamepad2 } from 'lucide-react'

function SimilarGameCard({ game, onClick, owned }) {
  return (
    <div
      className={`similar-games__card${owned ? ' similar-games__card--owned' : ''}`}
      title={owned ? `${game.name} — In your library` : game.name}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      <div className="similar-games__card-cover">
        {game.coverUrl ? (
          <img
            src={game.coverUrl}
            alt={game.name}
            className="similar-games__card-img"
            loading="lazy"
          />
        ) : (
          <div className="similar-games__card-placeholder">
            <span className="similar-games__card-initial">
              {game.name?.charAt(0)?.toUpperCase()}
            </span>
          </div>
        )}
        {owned && <div className="similar-games__card-owned-badge" title="In your library" />}
      </div>
      <span className="similar-games__card-title">{game.name}</span>
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="similar-games__card similar-games__card--skeleton">
      <div className="similar-games__card-cover similar-games__card-cover--skeleton" />
      <div className="similar-games__skeleton-title" />
    </div>
  )
}

/**
 * SimilarGamesPanel — displays IGDB "similar games" recommendations.
 *
 * Props:
 *   games        – array of { id, name, coverUrl }
 *   loading      – boolean
 *   onGameClick  – (game) => void — called when a card is clicked
 *   ownedNames   – Set of lowercase game names the user owns
 */
export default function SimilarGamesPanel({ games, loading, onGameClick, ownedNames }) {
  if (!loading && (!games || games.length === 0)) return null

  const visibleGames = games ? games.slice(0, 10) : []

  return (
    <div className={`similar-games${visibleGames.length > 0 ? ' similar-games--loaded' : ''}`}>
      <div className="similar-games__header">
        <Gamepad2 size={15} className="similar-games__icon" />
        <span className="similar-games__title">More Like This</span>
      </div>

      <div className="similar-games__grid">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)
          : visibleGames.map((game) => (
              <SimilarGameCard
                key={game.id}
                game={game}
                owned={ownedNames?.has(game.name?.toLowerCase())}
                onClick={() => onGameClick?.(game)}
              />
            ))}
      </div>
    </div>
  )
}
