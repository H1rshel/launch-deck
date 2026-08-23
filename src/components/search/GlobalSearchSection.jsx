import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Globe2, Loader2, Search, ChevronUp, Library } from 'lucide-react'
import { useGameSearch } from '../../hooks/useGameSearch'
import { useGameContext } from '../../context/GameContext'

const MIN_QUERY_LEN = 2

const PLATFORM_ABBREV = {
  'PC (Microsoft Windows)': 'PC',
  'PC': 'PC',
  'PlayStation 5': 'PS5',
  'PlayStation 4': 'PS4',
  'Xbox Series X|S': 'XSX',
  'Xbox Series X': 'XSX',
  'Xbox One': 'XB1',
  'Nintendo Switch': 'NSW',
  'Nintendo Switch 2': 'NSW2',
  'iOS': 'iOS',
  'Android': 'AND',
  'macOS': 'MAC',
  'Linux': 'LNX',
}

function abbr(p) {
  return PLATFORM_ABBREV[p] ?? p.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 4)
}

function releaseYear(dateStr) {
  if (!dateStr) return null
  const y = String(dateStr).slice(0, 4)
  return /^\d{4}$/.test(y) ? y : null
}

// Loose title match so "Marvel's Spider-Man" and "Marvel s Spiderman" collapse together.
function normalizeTitle(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function GlobalCard({ result, owned, onSelect, index }) {
  const platforms = result.platforms?.slice(0, 3) ?? []
  const year = releaseYear(result.release_date)

  return (
    <button
      type="button"
      className={`gsr-card${owned ? ' gsr-card--owned' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
      onClick={() => onSelect(result, owned)}
      title={result.name}
    >
      <div className="gsr-card__cover">
        {result.cover_url ? (
          <img src={result.cover_url} alt="" loading="lazy" className="gsr-card__img" />
        ) : (
          <div className="gsr-card__img-placeholder">
            <span>{result.name?.[0]?.toUpperCase()}</span>
          </div>
        )}
        <div className="gsr-card__scrim" aria-hidden />
        {owned ? (
          <span className="gsr-card__badge gsr-card__badge--owned">
            <Library size={9} strokeWidth={2.4} />
            In library
          </span>
        ) : !result.is_released && (
          <span className="gsr-card__badge gsr-card__badge--upcoming">
            {result.release_date ? 'Upcoming' : 'TBA'}
          </span>
        )}
      </div>

      <div className="gsr-card__info">
        <span className="gsr-card__name">{result.name}</span>
        <div className="gsr-card__meta">
          {year && <span className="gsr-card__year">{year}</span>}
          {platforms.length > 0 && (
            <span className="gsr-card__platforms">
              {platforms.map(p => abbr(p)).join(' · ')}
              {result.platforms?.length > 3 ? ` +${result.platforms.length - 3}` : ''}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

/**
 * Library-first global search.
 *
 * Sits underneath the library results on Home/Library. It stays quiet (and makes
 * no network calls) until the user asks for it — or until the library itself
 * turned up nothing, in which case searching everything is what they wanted.
 */
export default function GlobalSearchSection({ query, libraryCount }) {
  const trimmed = (query ?? '').trim()
  const [expanded, setExpanded] = useState(false)
  const { games } = useGameContext()
  const navigate = useNavigate()

  // Reset to library-first whenever the search is cleared.
  useEffect(() => {
    if (trimmed.length < MIN_QUERY_LEN) setExpanded(false)
  }, [trimmed])

  const hasQuery = trimmed.length >= MIN_QUERY_LEN
  const autoExpanded = hasQuery && libraryCount === 0
  const active = hasQuery && (expanded || autoExpanded)

  // Only feed the hook when active so we never hit IGDB for a plain library filter.
  const { results, loading, error } = useGameSearch(active ? query : '')

  const ownedByTitle = useMemo(() => {
    const map = new Map()
    for (const g of games) {
      const key = normalizeTitle(g.displayTitle || g.title)
      if (key && !map.has(key)) map.set(key, g)
    }
    return map
  }, [games])

  if (!hasQuery) return null

  function handleSelect(result, ownedGame) {
    if (ownedGame) {
      navigate(`/game/${ownedGame.id}`)
      return
    }
    navigate(`/upcoming/igdb/${encodeURIComponent(result.igdb_id)}`, {
      state: { searchResult: result },
    })
  }

  if (!active) {
    return (
      <section className="gsr">
        <div className="gsr-prompt">
          <div className="gsr-prompt__icon">
            <Globe2 size={16} strokeWidth={2} />
          </div>
          <div className="gsr-prompt__text">
            <span className="gsr-prompt__title">Looking for something you don't own yet?</span>
            <span className="gsr-prompt__sub">
              Search every game on IGDB for “{trimmed}”
            </span>
          </div>
          <button type="button" className="gsr-prompt__btn" onClick={() => setExpanded(true)}>
            <Search size={13} strokeWidth={2.2} />
            Search all games
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="gsr gsr--active">
      <div className="gsr__header">
        <h2 className="gsr__title">
          <Globe2 size={15} strokeWidth={2} />
          All Games
          {!loading && !error && results.length > 0 && (
            <span className="gsr__count">{results.length}</span>
          )}
        </h2>
        <div className="gsr__header-right">
          <span className="gsr__brand">Powered by IGDB</span>
          {expanded && (
            <button
              type="button"
              className="gsr__collapse"
              onClick={() => setExpanded(false)}
              aria-label="Hide global results"
            >
              <ChevronUp size={13} strokeWidth={2.2} />
              Hide
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div className="gsr__state">
          <Loader2 size={16} className="spinning" />
          <span>Searching every game…</span>
        </div>
      )}

      {!loading && error && (
        <div className="gsr__state gsr__state--error">
          <span>Global search unavailable. Check your connection.</span>
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <div className="gsr__state">
          <Search size={15} style={{ opacity: 0.35 }} />
          <span>No games found for “{trimmed}”.</span>
        </div>
      )}

      {!loading && !error && results.length > 0 && (
        <div className="gsr__grid">
          {results.map((r, i) => {
            const owned = ownedByTitle.get(normalizeTitle(r.name)) || null
            return (
              <GlobalCard
                key={r.igdb_id}
                result={r}
                owned={owned}
                onSelect={handleSelect}
                index={i}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}
