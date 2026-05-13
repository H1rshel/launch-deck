import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Search } from 'lucide-react'
import { useGameSearch } from '../../hooks/useGameSearch'

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

function formatDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function StatusBadge({ result }) {
  if (result.is_released) {
    return <span className="search-result__badge search-result__badge--available">Available Now</span>
  }
  if (result.release_date) {
    return <span className="search-result__badge search-result__badge--upcoming">Upcoming</span>
  }
  return <span className="search-result__badge search-result__badge--tba">TBA</span>
}

function SearchResultItem({ result, onSelect }) {
  const platforms = result.platforms?.slice(0, 3) ?? []
  const date = formatDate(result.release_date)

  return (
    <button
      type="button"
      className="search-result__item"
      onClick={() => onSelect(result)}
    >
      <div className="search-result__cover">
        {result.cover_url ? (
          <img src={result.cover_url} alt="" loading="lazy" className="search-result__img" />
        ) : (
          <div className="search-result__img-placeholder">
            <span>{result.name?.[0]?.toUpperCase()}</span>
          </div>
        )}
      </div>

      <div className="search-result__info">
        <div className="search-result__top">
          <span className="search-result__name">{result.name}</span>
          <StatusBadge result={result} />
        </div>

        <div className="search-result__meta">
          {result.developer_names?.[0] && (
            <span className="search-result__dev">{result.developer_names[0]}</span>
          )}
          {date && (
            <span className="search-result__date">{date}</span>
          )}
        </div>

        {platforms.length > 0 && (
          <div className="search-result__platforms">
            {platforms.map(p => (
              <span key={p} className="search-result__platform">{abbr(p)}</span>
            ))}
            {result.platforms?.length > 3 && (
              <span className="search-result__platform">+{result.platforms.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </button>
  )
}

export default function GameSearchResults({ query, onClose }) {
  const { results, loading, error } = useGameSearch(query)
  const navigate = useNavigate()
  const panelRef = useRef(null)
  const trimmed = (query ?? '').trim()

  // Close when clicking outside the parent container
  useEffect(() => {
    function handleDown(e) {
      const parent = panelRef.current?.parentElement
      if (parent && !parent.contains(e.target)) onClose?.()
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (trimmed.length < 2) return null

  function handleSelect(result) {
    onClose?.()
    if (result.is_released) {
      // Navigate to upcoming detail page even for released games from search
      // Use igdb as source and igdb_id as identifier
      navigate(`/upcoming/igdb/${encodeURIComponent(result.igdb_id)}`, {
        state: { searchResult: result }
      })
    } else {
      navigate(`/upcoming/igdb/${encodeURIComponent(result.igdb_id)}`, {
        state: { searchResult: result }
      })
    }
  }

  return (
    <div className="search-results-panel" ref={panelRef} role="listbox" aria-label="Game search results">
      {loading && (
        <div className="search-results-panel__state">
          <Loader2 size={16} className="spinning" />
          <span>Searching…</span>
        </div>
      )}

      {!loading && error && (
        <div className="search-results-panel__state search-results-panel__state--error">
          <span>Search unavailable</span>
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <div className="search-results-panel__state">
          <Search size={14} style={{ opacity: 0.4 }} />
          <span>No games found for "{trimmed}"</span>
        </div>
      )}

      {!loading && !error && results.length > 0 && (
        <div className="search-results-panel__list">
          {results.map(r => (
            <SearchResultItem key={r.igdb_id} result={r} onSelect={handleSelect} />
          ))}
        </div>
      )}
    </div>
  )
}
