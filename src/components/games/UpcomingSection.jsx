import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, ArrowRight } from 'lucide-react'
import { useUpcomingGames } from '../../hooks/useUpcomingGames'
import UpcomingGameCard from './UpcomingGameCard'
import UpcomingTabs from './UpcomingTabs'
import UpcomingScrollStrip from './UpcomingScrollStrip'

// Skeleton card — mirrors the upcoming-card shape + height
function SkeletonCard() {
  return (
    <div className="upcoming-card upcoming-card--skeleton" aria-hidden="true">
      <div className="upcoming-card__cover upcoming-card__cover--skeleton" />
      <div className="upcoming-card__info">
        <div className="skeleton-line skeleton-line--sm" />
        <div className="skeleton-line" />
        <div className="skeleton-line skeleton-line--countdown" />
        <div className="skeleton-line skeleton-line--btn" />
      </div>
    </div>
  )
}

const DASHBOARD_LIMIT = 14  // cap strip to keep it snappy; deeper browsing → /upcoming

const FEED_MAP = {
  forYou: 'for_you',
  following: 'following',
  soon: 'soon',
  recent: 'recent',
  big: 'big_releases',
  popular: 'popular'
}

export default function UpcomingSection() {
  const [tab, setTab] = useState('forYou')

  // Dashboard view applies default curation limits and hits the edge function
  const {
    games, meta, facets,
    isInitializing, loading, error,
    isFollowed, toggleFollow,
  } = useUpcomingGames({ 
    feed: FEED_MAP[tab] || 'all_upcoming',
    limit: DASHBOARD_LIMIT 
  })

  // We are already receiving exactly the sliced tab Games from the Edge Function
  const tabGames = games || []

  const counts = facets ? {
    forYou: facets.for_you_count,
    following: facets.following_count,
    soon: facets.soon_count,
    recent: facets.recent_count,
    big: facets.big_releases_count,
    popular: facets.popular_count,
  } : {}

  const hiddenTabIds = facets && facets.big_releases_count === 0 ? ['big'] : []

  useEffect(() => {
    if (tab === 'big' && facets && facets.big_releases_count === 0) setTab('forYou')
  }, [tab, facets])

  return (
    <section className="upcoming-section">
      {/* ── Header row ────────────────────────────────────────────────────── */}
      <div className="upcoming-section__header">
        <div className="upcoming-section__heading">
          <h2 className="upcoming-section__title">Upcoming Releases</h2>
          <UpcomingTabs active={tab} onChange={setTab} counts={counts} hiddenIds={hiddenTabIds} />
        </div>

        <Link to="/upcoming" className="upcoming-section__view-all">
          View All
          <ArrowRight size={14} strokeWidth={2.5} />
        </Link>
      </div>

      {/* ── Loading — skeleton row ────────────────────────────────────────── */}
      {isInitializing && (
        <UpcomingScrollStrip ariaLabel="Upcoming releases — loading">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="upcoming-section__item" role="listitem">
              <SkeletonCard />
            </div>
          ))}
        </UpcomingScrollStrip>
      )}

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {!isInitializing && error && (
        <div className="upcoming-section__state upcoming-section__state--error">
          <CalendarDays size={28} strokeWidth={1.25} />
          <p>Could not load upcoming games.</p>
        </div>
      )}

      {/* ── Empty for this tab ────────────────────────────────────────────── */}
      {!isInitializing && !error && tabGames.length === 0 && (
        <div className="upcoming-section__state">
          <CalendarDays size={32} strokeWidth={1.25} style={{ opacity: 0.35 }} />
          <p>
            {tab === 'following'
              ? 'Follow games to see them here.'
              : 'No upcoming releases match this view yet.'}
          </p>
        </div>
      )}

      {/* ── Content ───────────────────────────────────────────────────────── */}
      {!isInitializing && !error && tabGames.length > 0 && (
        <UpcomingScrollStrip ariaLabel={`Upcoming releases — ${tab}`}>
          {tabGames.map((game, i) => (
            <div
              key={`${game.source}:${game.source_game_id}`}
              className="upcoming-section__item"
              style={{ animationDelay: `${i * 55}ms` }}
              role="listitem"
            >
              <UpcomingGameCard
                game={game}
                isFollowed={isFollowed(game)}
                onToggleFollow={toggleFollow}
              />
            </div>
          ))}
        </UpcomingScrollStrip>
      )}
    </section>
  )
}
