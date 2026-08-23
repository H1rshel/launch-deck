import TopBar from '../components/layout/TopBar'
import FeaturedHero from '../components/games/FeaturedHero'
import GameGrid from '../components/games/GameGrid'
import UpcomingSection from '../components/games/UpcomingSection'
import GlobalSearchSection from '../components/search/GlobalSearchSection'
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

  // Most-recently-added games (created_at is an ISO timestamp → lexical sort).
  const latestAdded = [...games]
    .filter((g) => g.created_at)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 6)

  return (
    <div className="page dashboard">
      <TopBar searchQuery={searchQuery} onSearchChange={setSearchQuery} />
      <div className="page__content">
        {isSearching ? (
          /* Active search: library first in a dedicated results grid instead of
             leaking matches into the "Recently Played" / "Your Library" rows,
             with global (IGDB) results available underneath it. */
          <>
            <GameGrid
              games={games}
              title={`In your library — “${trimmedQuery}”`}
              onRemoveGame={removeGame}
              loading={loading}
              emptyMessage={`No games in your library match “${trimmedQuery}”.`}
            />
            {!loading && (
              <GlobalSearchSection query={trimmedQuery} libraryCount={games.length} />
            )}
          </>
        ) : (
          <>
            <FeaturedHero game={featuredGame} />
            <GameGrid games={recentGames} title="Recently Played" onRemoveGame={removeGame} loading={loading} />
            {latestAdded.length > 0 && (
              <GameGrid games={latestAdded} title="Latest Added" onRemoveGame={removeGame} />
            )}
            <UpcomingSection />
            <GameGrid games={games} title="Your Library" onRemoveGame={removeGame} loading={loading} />
          </>
        )}
      </div>
    </div>
  )
}
