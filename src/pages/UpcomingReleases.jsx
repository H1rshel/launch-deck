import { useState, useEffect, useRef } from "react"
import { CalendarDays, Search, X, ArrowUpDown, ChevronDown } from "lucide-react"
import TopBar from "../components/layout/TopBar"
import PageHeader from "../components/layout/PageHeader"
import UpcomingGameCard from "../components/games/UpcomingGameCard"
import UpcomingTabs from "../components/games/UpcomingTabs"
import GameSearchResults from "../components/search/GameSearchResults"
import { useUpcomingGames } from "../hooks/useUpcomingGames"

// ── Period filters ──────────────────────────────────────────────────────────
// "Next 7 days / This month / Next 3 months / All" — applied after the tab
// filter, so e.g. "Popular → Next 7 days" is valid.

const getPeriods = (tab) => {
  if (tab === "recent") {
    return [
      { id: "week", label: "Last 7 Days", days: 7 },
      { id: "month", label: "Last Month", days: 30 },
      { id: "quarter", label: "Last 3 Months", days: 90 },
      { id: "all", label: "All Recent", days: null },
    ]
  }
  return [
    { id: "week", label: "Next 7 Days", days: 7 },
    { id: "month", label: "This Month", days: 30 },
    { id: "quarter", label: "Next 3 Months", days: 90 },
    { id: "all", label: "All Upcoming", days: null },
  ]
}

function withinPeriod(game, days) {
  if (days === null) return true
  if (!game.release_date) return false
  const diffDays =
    (new Date(game.release_date).getTime() - Date.now()) / 86_400_000
  return diffDays >= 0 && diffDays <= days
}

// ── Grid skeleton card ──────────────────────────────────────────────────────

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

// ── Page ─────────────────────────────────────────────────────────────────────

// ── Empty state helpers ──────────────────────────────────────────────────
function getEmptyMessage(tab, period) {
  if (tab === "following") {
    return "You aren't following any games yet. Browse other tabs and hit the bell to follow."
  }
  if (tab === "forYou") {
    return "We don't have enough data to personalize your feed yet. Switch to Popular or All Upcoming."
  }
  return "No games match this filter yet. Try a broader timeframe or switch to All Upcoming."
}

// ── Page ─────────────────────────────────────────────────────────────────────

const FEED_MAP = {
  forYou: "for_you",
  following: "following",
  soon: "soon",
  recent: "recent",
  big: "big_releases",
  popular: "popular",
}

const TIMEFRAME_MAP = {
  week: "week",
  month: "month",
  quarter: "quarter",
  all: "rest_of_year",
}

const VALID_TABS = ["forYou", "following", "soon", "recent", "big", "popular"]
const VALID_PERIODS = ["week", "month", "quarter", "all"]

const SORT_OPTIONS = [
  { id: "release_date", label: "Release Date" },
  { id: "popularity", label: "Popularity" },
]
const VALID_SORTS = SORT_OPTIONS.map((s) => s.id)

// Tabs that have their own internal ordering logic — sort dropdown is still
// shown but applies as an *override* via the edge function's sort param.
const SORT_OVERRIDE_TABS = ["for_you", "big_releases", "popular"]

export default function UpcomingReleases() {
  const [tab, setTab] = useState(() => {
    const saved = sessionStorage.getItem("upcoming_tab")
    return saved && VALID_TABS.includes(saved) ? saved : "forYou"
  })
  const [period, setPeriod] = useState(() => {
    const saved = sessionStorage.getItem("upcoming_period")
    return saved && VALID_PERIODS.includes(saved) ? saved : "all"
  })
  const [page, setPage] = useState(1)
  const [igdbQuery, setIgdbQuery] = useState("")
  const [sortOpen, setSortOpen] = useState(false)
  const [sort, setSort] = useState(() => {
    let saved = sessionStorage.getItem("upcoming_sort")
    if (!saved || saved === "release_date") {
      saved = "popularity"
      sessionStorage.setItem("upcoming_sort", saved)
    }
    return VALID_SORTS.includes(saved) ? saved : "popularity"
  })
  const igdbInputRef = useRef(null)
  const sortRef = useRef(null)

  // Close sort dropdown when clicking outside
  useEffect(() => {
    function handleDown(e) {
      if (sortRef.current && !sortRef.current.contains(e.target))
        setSortOpen(false)
    }
    document.addEventListener("mousedown", handleDown)
    return () => document.removeEventListener("mousedown", handleDown)
  }, [])

  // Persist tab/period/sort so navigating to a game detail and back restores state
  useEffect(() => {
    sessionStorage.setItem("upcoming_tab", tab)
  }, [tab])
  useEffect(() => {
    sessionStorage.setItem("upcoming_period", period)
  }, [period])
  useEffect(() => {
    sessionStorage.setItem("upcoming_sort", sort)
  }, [sort])

  // Reset page when tab, period, or sort changes
  useEffect(() => {
    setPage(1)
  }, [tab, period, sort])

  const {
    games,
    meta,
    facets,
    isInitializing,
    isRefetching,
    loading,
    error,
    isFollowed,
    toggleFollow,
  } = useUpcomingGames({
    feed: FEED_MAP[tab] || "all_upcoming",
    timeframe: TIMEFRAME_MAP[period],
    sort,
    page,
    limit: 48,
  })

  const counts = facets
    ? {
        forYou: facets.for_you_count,
        following: facets.following_count,
        soon: facets.soon_count,
        recent: facets.recent_count,
        big: facets.big_releases_count,
        popular: facets.popular_count,
      }
    : {}

  const hasMore = meta?.has_more ?? false

  // Hide the Big Releases tab when there's nothing to show
  const hiddenTabIds = facets && facets.big_releases_count === 0 ? ["big"] : []

  // If currently on Big Releases and it turns out to be empty, fall back to For You
  useEffect(() => {
    if (tab === "big" && facets && facets.big_releases_count === 0)
      setTab("forYou")
  }, [tab, facets])

  return (
    <div className="page upcoming-page page--unified">
      <TopBar />
      <PageHeader
        variant="hero"
        eyebrow="Discover"
        eyebrowIcon={CalendarDays}
        title="Upcoming Releases"
        image="/upcoming-releases.png"
        subtitle="Curated picks, followed titles, and the biggest launches on the horizon."
      />
      <div className="page__content">
        {/* ── Controls row (glass, integrated with header) ───────────── */}
        <div className="glass-panel upcoming-page__controls upcoming-page__controls--integrated">
          <UpcomingTabs
            active={tab}
            onChange={setTab}
            counts={counts}
            size="lg"
            hiddenIds={hiddenTabIds}
          />

          <div className="upcoming-page__right-controls">
            {/* Sort dropdown */}
            <div className="upcoming-page__sort" ref={sortRef}>
              <button
                type="button"
                className={`upcoming-page__sort-btn ${sortOpen ? "is-open" : ""}`}
                onClick={() => setSortOpen((o) => !o)}
                aria-label="Sort games"
              >
                <ArrowUpDown size={12} />
                <span>{SORT_OPTIONS.find((s) => s.id === sort)?.label}</span>
                <ChevronDown
                  size={11}
                  className="upcoming-page__sort-chevron"
                />
              </button>
              {sortOpen && (
                <div className="upcoming-page__sort-menu" role="listbox">
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="option"
                      aria-selected={sort === opt.id}
                      className={`upcoming-page__sort-option ${sort === opt.id ? "is-active" : ""}`}
                      onClick={() => {
                        setSort(opt.id)
                        setSortOpen(false)
                      }}
                    >
                      {sort === opt.id && (
                        <span className="upcoming-page__sort-check">✓</span>
                      )}
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div
              className="upcoming-page__periods"
              role="tablist"
              aria-label="Time period"
            >
              {getPeriods(tab).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`upcoming-page__period ${period === p.id ? "is-active" : ""}`}
                  onClick={() => setPeriod(p.id)}
                  aria-selected={period === p.id}
                  role="tab"
                >
                  {p.label}
                </button>
              ))}
            </div>

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

        {/* ── Content ─────────────────────────────────────────────────── */}
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

        {!isInitializing && error && (
          <div className="upcoming-section__state upcoming-section__state--error">
            <CalendarDays size={32} strokeWidth={1.25} />
            <p>Could not load upcoming games. {error}</p>
          </div>
        )}

        {!isInitializing && !error && games.length === 0 && (
          <div className="upcoming-section__state">
            <CalendarDays
              size={32}
              strokeWidth={1.25}
              style={{ opacity: 0.35, marginBottom: "16px" }}
            />
            <p style={{ marginBottom: "24px" }}>
              {getEmptyMessage(tab, period)}
            </p>
            <button
              className="btn btn--outline"
              onClick={() => {
                setTab("popular")
                setPeriod("all")
              }}
            >
              Clear Filters
            </button>
          </div>
        )}

        {!isInitializing && !error && games.length > 0 && (
          <>
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
                Showing {games.length} of {meta.total_count} releases
              </div>
            )}

            <div
              className={`upcoming-page__grid ${isRefetching ? "is-refetching" : ""}`}
            >
              {games.map((game, i) => (
                <div
                  key={`${game.source}:${game.source_game_id}`}
                  className="upcoming-page__cell"
                >
                  <UpcomingGameCard
                    game={game}
                    isFollowed={isFollowed(game)}
                    onToggleFollow={toggleFollow}
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
      </div>
    </div>
  )
}
