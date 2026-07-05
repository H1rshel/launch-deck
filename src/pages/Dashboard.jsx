import TopBar from '../components/layout/TopBar'
import FeaturedHero from '../components/games/FeaturedHero'
import GameGrid from '../components/games/GameGrid'
import UpcomingSection from '../components/games/UpcomingSection'
import { useGames } from '../hooks/useGames'
import { useGameContext } from '../context/GameContext'

export default function Dashboard() {
  const { games, featuredGame, searchQuery, setSearchQuery, loading } = useGames()
  const { removeGame } = useGameContext()

  const trimmedQuery = searchQuery.trim()
  const isSearching = trimmedQuery.length > 0

  const recentGames = [...games]
    .sort((a, b) => new Date(b.lastPlayed || 0) - new Date(a.lastPlayed || 0))
    .slice(0, 4)

  return (
    <div className="page dashboard">
      <TopBar searchQuery={searchQuery} onSearchChange={setSearchQuery} />
      <div className="page__content">
        {isSearching ? (
          /* Active search: show a single dedicated results grid instead of
             leaking matches into the "Recently Played" / "Your Library" rows. */
          <GameGrid
            games={games}
            title={`Search results for “${trimmedQuery}”`}
            onRemoveGame={removeGame}
            loading={loading}
            emptyMessage={`No games match “${trimmedQuery}”.`}
          />
        ) : (
          <>
            <FeaturedHero game={featuredGame} />
            <GameGrid games={recentGames} title="Recently Played" onRemoveGame={removeGame} loading={loading} />
            <UpcomingSection />
            <GameGrid games={games} title="Your Library" onRemoveGame={removeGame} loading={loading} />
          </>
        )}
      </div>
    </div>
  )
}
