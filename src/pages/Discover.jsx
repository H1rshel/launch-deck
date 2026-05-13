import { useState, useEffect, useRef } from "react"
import {
  Compass,
  Search,
  X,
  Sparkles,
  TrendingUp,
  Trophy,
  Gem,
  Heart,
} from "lucide-react"
import TopBar from "../components/layout/TopBar"
import PageHeader from "../components/layout/PageHeader"
import UpcomingGameCard from "../components/games/UpcomingGameCard"
import DiscoverTabs from "../components/games/DiscoverTabs"
import GameSearchResults from "../components/search/GameSearchResults"
import { useDiscoverGames } from "../hooks/useDiscoverGames"
import { useUpcomingGames } from "../hooks/useUpcomingGames"
import { getPriceSnapshot } from "../hooks/usePriceWatcher"

// ── Skeleton card ──────────────────────────────────────────────────────────────
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

// ── Tab metadata ───────────────────────────────────────────────────────────────
const TAB_META = {
  for_you: {
    Icon: Sparkles,
    eyebrow: "Personalized",
    title: "For You",
    subtitle:
      "Games curated around your play history, favorite genres, and preferred studios.",
    emptyMsg:
      "We don't have enough data to personalize your feed yet. Play some games or add titles to your library!",
  },
  top_100: {
    Icon: Trophy,
    eyebrow: "All-Time Best",
    title: "Top 100 Games",
    subtitle:
      "The highest-rated games of all time, scored by thousands of players worldwide.",
    emptyMsg: "Could not load the Top 100 chart. Please try again in a moment.",
  },
  trending: {
    Icon: TrendingUp,
    eyebrow: "Right Now",
    title: "Trending",
    subtitle:
      "Games gaining the most traction in the last six months. The pulse of the industry.",
    emptyMsg: "No trending titles right now. Check back soon!",
  },
  hidden_gems: {
    Icon: Gem,
    eyebrow: "Underrated",
    title: "Hidden Gems",
    subtitle:
      "Exceptional games that flew under the radar — high scores, surprisingly few reviews.",
    emptyMsg: "Could not find any hidden gems right now.",
  },
  following: {
    Icon: Heart,
    eyebrow: "My List",
    title: "Following",
    subtitle:
      "Games you're tracking — from Discover, Upcoming Releases, or IGDB search.",
    emptyMsg:
      "You haven't followed any games yet. Browse other tabs and hit the bell icon to follow.",
  },
}

const VALID_TABS = [
  "for_you",
  "top_100",
  "trending",
  "hidden_gems",
  "following",
]

// ── Inner content component that picks the right hook based on active tab ──────
function DiscoverContent({ tab, page, setPage, setTab }) {
  const isFollowingTab = tab === "following"

  // Price deals for Following tab — read from localStorage, refresh when watcher updates
  const [priceDeals, setPriceDeals] = useState({})
  useEffect(() => {
    if (!isFollowingTab) return
    const load = () => setPriceDeals(getPriceSnapshot().games || {})
    load()
    window.addEventListener("price-snapshot-updated", load)
    return () => window.removeEventListener("price-snapshot-updated", load)
  }, [isFollowingTab])

  // Following tab uses the upcoming-feeds pipeline (same as UpcomingReleases)
  const upcoming = useUpcomingGames({
    feed: "following",
    timeframe: "rest_of_year",
    page,
    limit: 48,
    sort: "popularity",
  })

  // All other tabs use the discover pipeline
  const discover = useDiscoverGames({ feed: tab, page, limit: 48 })

  const {
    games,
    meta,
    isInitializing,
    isRefetching,
    loading,
    error,
    isFollowed,
    toggleFollow,
  } = isFollowingTab ? upcoming : discover

  const totalCount = Number(meta?.total_count ?? meta?.totalCount ?? 0)
  const hasMore =
    Boolean(meta?.has_more ?? meta?.hasMore) ||
    (totalCount > 0 && games.length < totalCount)
  const meta_ = TAB_META[tab] ?? TAB_META.top_100

  return (
    <>
      {/* ── Loading skeleton ──────────────────────────────────────────────── */}
      {isInitializing && (
        <div className="upcoming-page__grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="upcoming-page__cell"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <SkeletonCard />
            </div>
          ))}
        </div>
      )}

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {!isInitializing && error && (
        <div className="upcoming-section__state upcoming-section__state--error">
          <Compass size={32} strokeWidth={1.25} />
          <p>Could not load games. {error}</p>
        </div>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {!isInitializing && !error && games.length === 0 && (
        <div className="upcoming-section__state">
          <meta_.Icon
            size={32}
            strokeWidth={1.25}
            style={{ opacity: 0.35, marginBottom: "16px" }}
          />
          <p style={{ marginBottom: "24px" }}>{meta_.emptyMsg}</p>
          {tab !== "following" && (
            <button
              className="btn btn--outline"
              onClick={() => setTab("top_100")}
            >
              Browse Top 100
            </button>
          )}
        </div>
      )}

      {/* ── Games grid ───────────────────────────────────────────────────── */}
      {!isInitializing && !error && games.length > 0 && (
        <>
          {/* Tab context heading */}
          <div className="discover-page__section-header">
            <meta_.Icon
              size={18}
              strokeWidth={2}
              className="discover-page__section-icon"
            />
            <div>
              <div className="discover-page__section-eyebrow">
                {meta_.eyebrow}
              </div>
              <h2 className="discover-page__section-title">{meta_.title}</h2>
              <p className="discover-page__section-subtitle">
                {meta_.subtitle}
              </p>
            </div>
          </div>

          {/* Meta bar */}
          {meta && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: "20px",
                opacity: 0.6,
                fontSize: "13px",
              }}
            >
              Showing {games.length}
              {meta.total_count ? ` of ${meta.total_count}` : ""} games
            </div>
          )}

          {/* Grid */}
          <div
            className={`upcoming-page__grid ${isRefetching ? "is-refetching" : ""}`}
          >
            {games.map((game, idx) => (
              <div
                key={`${game.source}:${game.source_game_id}`}
                className="upcoming-page__cell"
                style={{ animationDelay: `${Math.min(idx, 11) * 40}ms` }}
              >
                <UpcomingGameCard
                  game={game}
                  isFollowed={isFollowed(game)}
                  onToggleFollow={() => toggleFollow(game)}
                  rank={
                    tab === "top_100" ? idx + 1 + (page - 1) * 48 : undefined
                  }
                  deal={
                    isFollowingTab
                      ? (priceDeals[game.source_game_id] ?? null)
                      : null
                  }
                />
              </div>
            ))}
          </div>

          {hasMore && (
            <div className="upcoming-page__load-more">
              <button
                className="upcoming-page__load-more-btn"
                onClick={() => setPage((prev) => prev + 1)}
                disabled={loading}
              >
                {loading ? "Loading..." : "Load More"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function Discover() {
  const [tab, setTab] = useState(() => {
    const saved = sessionStorage.getItem("discover_tab")
    return saved && VALID_TABS.includes(saved) ? saved : "for_you"
  })
  const [page, setPage] = useState(1)
  const [igdbQuery, setIgdbQuery] = useState("")
  const igdbInputRef = useRef(null)

  // Following count for tab badge — cache hit from preloadUpcomingFeeds, no extra network call
  const { facets: followingFacets } = useUpcomingGames({
    feed: "following",
    timeframe: "rest_of_year",
    page: 1,
    limit: 48,
    sort: "popularity",
  })
  const discoverCounts = { following: followingFacets?.following_count ?? 0 }

  // Persist tab
  useEffect(() => {
    sessionStorage.setItem("discover_tab", tab)
  }, [tab])
  // Reset page on tab change
  useEffect(() => {
    setPage(1)
  }, [tab])

  function handleTabChange(newTab) {
    setTab(newTab)
  }

  return (
    <div className="page upcoming-page page--unified">
      <TopBar />
      <PageHeader
        variant="hero"
        eyebrow="Discover"
        eyebrowIcon={Compass}
        title="Discover Games"
        image="/discover.png"
        subtitle="Personalized recommendations, all-time classics, and hidden masterpieces."
      />

      <div className="page__content">
        {/* ── Controls row ────────────────────────────────────────────────── */}
        <div className="glass-panel upcoming-page__controls upcoming-page__controls--integrated">
          <DiscoverTabs
            active={tab}
            onChange={handleTabChange}
            counts={discoverCounts}
            size="lg"
          />

          <div className="upcoming-page__right-controls">
            {/* IGDB search */}
            <div className="upcoming-page__igdb-search">
              <Search size={13} className="upcoming-page__igdb-search-icon" />
              <input
                ref={igdbInputRef}
                type="text"
                className="upcoming-page__igdb-search-input"
                placeholder="Search IGDB…"
                value={igdbQuery}
                onChange={(e) => setIgdbQuery(e.target.value)}
              />
              {igdbQuery && (
                <button
                  className="upcoming-page__igdb-search-clear"
                  onClick={() => {
                    setIgdbQuery("")
                    igdbInputRef.current?.focus()
                  }}
                  tabIndex={-1}
                  aria-label="Clear search"
                >
                  <X size={10} />
                </button>
              )}
              {(igdbQuery?.trim().length ?? 0) >= 2 && (
                <GameSearchResults
                  query={igdbQuery}
                  onClose={() => setIgdbQuery("")}
                />
              )}
            </div>
          </div>
        </div>

        {/* ── Content — rendered by inner component to keep hook rules clean ── */}
        <DiscoverContent
          tab={tab}
          page={page}
          setPage={setPage}
          setTab={setTab}
        />
      </div>
    </div>
  )
}
