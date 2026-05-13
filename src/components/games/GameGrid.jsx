import { useState, useCallback } from 'react'
import { Loader } from 'lucide-react'
import GameCard from './GameCard'

export default function GameGrid({ games, title, onRemoveGame, onClearFranchise, loading }) {
  const [exitingIds, setExitingIds] = useState(new Set())

  const handleRemove = useCallback((id) => {
    setExitingIds((prev) => new Set(prev).add(id))
    setTimeout(() => {
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      onRemoveGame(id)
    }, 300)
  }, [onRemoveGame])

  return (
    <section className="game-grid">
      {title && <h2 className="game-grid__title">{title}</h2>}
      <div className="game-grid__container">
        {games.map((game) => (
          <GameCard
            key={game.id}
            game={game}
            onRemove={onRemoveGame ? handleRemove : undefined}
            onClearFranchise={onClearFranchise}
            isExiting={exitingIds.has(game.id)}
          />
        ))}
      </div>
      {loading ? (
        <div className="game-grid__loading" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 40, color: 'var(--text-secondary)' }}>
          <Loader size={24} className="settings__spinner" />
          <p>Loading your library...</p>
        </div>
      ) : games.length === 0 && (
        <p className="game-grid__empty">No games found.</p>
      )}
    </section>
  )
}
