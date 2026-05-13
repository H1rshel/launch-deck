import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Search, X, Loader2, Gamepad2, BookOpen, Globe2, Clock } from 'lucide-react'
import { useGameSearch } from '../../hooks/useGameSearch'
import { useGameContext } from '../../context/GameContext'

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
  if (result.is_released) return <span className="gs-result__badge gs-result__badge--available">Available Now</span>
  if (result.release_date) return <span className="gs-result__badge gs-result__badge--upcoming">Upcoming</span>
  return <span className="gs-result__badge gs-result__badge--tba">TBA</span>
}

// ── Global (IGDB) result item ─────────────────────────────────────────────────

function GlobalResultItem({ result, onSelect, index }) {
  const platforms = result.platforms?.slice(0, 4) ?? []
  const date = formatDate(result.release_date)

  return (
    <button
      type="button"
      className="gs-result"
      style={{ animationDelay: `${index * 45}ms` }}
      onClick={() => onSelect(result)}
    >
      <div className="gs-result__glow" aria-hidden />
      <div className="gs-result__cover">
        {result.cover_url ? (
          <img src={result.cover_url} alt="" loading="lazy" className="gs-result__img" />
        ) : (
          <div className="gs-result__img-placeholder">
            <span>{result.name?.[0]?.toUpperCase()}</span>
          </div>
        )}
        <div className="gs-result__cover-sheen" aria-hidden />
      </div>

      <div className="gs-result__info">
        <div className="gs-result__top-row">
          <span className="gs-result__name">{result.name}</span>
          <StatusBadge result={result} />
        </div>
        {result.developer_names?.[0] && (
          <span className="gs-result__dev">{result.developer_names[0]}</span>
        )}
        <div className="gs-result__bottom-row">
          {date && <span className="gs-result__date">{date}</span>}
          {platforms.length > 0 && (
            <div className="gs-result__platforms">
              {platforms.map(p => (
                <span key={p} className="gs-result__platform">{abbr(p)}</span>
              ))}
              {result.platforms?.length > 4 && (
                <span className="gs-result__platform">+{result.platforms.length - 4}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="gs-result__arrow" aria-hidden>›</div>
    </button>
  )
}

// ── Library result item ───────────────────────────────────────────────────────

function LibraryResultItem({ game, onSelect, index }) {
  const name = game.displayTitle || game.title || ''
  const lastPlayed = formatDate(game.lastPlayed)

  return (
    <button
      type="button"
      className="gs-result gs-result--library"
      style={{ animationDelay: `${index * 45}ms` }}
      onClick={() => onSelect(game)}
    >
      <div className="gs-result__glow gs-result__glow--library" aria-hidden />
      <div className="gs-result__cover">
        {game.cover_url ? (
          <img src={game.cover_url} alt="" loading="lazy" className="gs-result__img" />
        ) : (
          <div className="gs-result__img-placeholder">
            <span>{name[0]?.toUpperCase()}</span>
          </div>
        )}
        <div className="gs-result__cover-sheen" aria-hidden />
      </div>

      <div className="gs-result__info">
        <div className="gs-result__top-row">
          <span className="gs-result__name">{name}</span>
          <span className={`gs-result__badge ${game.installed ? 'gs-result__badge--installed' : 'gs-result__badge--owned'}`}>
            {game.installed ? 'Installed' : 'Owned'}
          </span>
        </div>
        <span className="gs-result__dev">{game.platform}</span>
        {lastPlayed && (
          <div className="gs-result__bottom-row">
            <Clock size={10} style={{ opacity: 0.5 }} />
            <span className="gs-result__date">{lastPlayed}</span>
          </div>
        )}
      </div>

      <div className="gs-result__arrow" aria-hidden>›</div>
    </button>
  )
}

// ── Main popover ──────────────────────────────────────────────────────────────

export default function GlobalSearchPopover({ isOpen, onClose }) {
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState('global')
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const trimmed = query.trim()

  const { games: libraryGames } = useGameContext()

  // Only feed IGDB hook when in global mode to avoid wasted API calls
  const { results: igdbResults, loading: igdbLoading, error: igdbError } = useGameSearch(
    searchMode === 'global' ? query : ''
  )

  // Library search: split query into words so "ea fc 26" matches "EA Sports FC 26"
  const libraryResults = useMemo(() => {
    if (searchMode !== 'library' || trimmed.length < 2) return []
    const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
    return libraryGames.filter(g => {
      const haystack = [
        g.displayTitle || g.title || '',
        g.platform || '',
        ...(g.franchiseNames || []),
        ...(g.collectionNames || []),
      ].join(' ').toLowerCase()
      return words.every(w => haystack.includes(w))
    }).slice(0, 10)
  }, [libraryGames, searchMode, trimmed])

  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 60)
      return () => clearTimeout(t)
    } else {
      setQuery('')
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  function handleSelectGlobal(result) {
    onClose()
    navigate(`/upcoming/igdb/${encodeURIComponent(result.igdb_id)}`, {
      state: { searchResult: result }
    })
  }

  function handleSelectLibrary(game) {
    onClose()
    navigate(`/game/${game.id}`)
  }

  if (!isOpen) return null

  const showGlobalResults = searchMode === 'global' && trimmed.length >= 2
  const showLibraryResults = searchMode === 'library' && trimmed.length >= 2

  return createPortal(
    <div
      className="gs-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      aria-modal="true"
      role="dialog"
      aria-label="Game search"
    >
      <div className="gs-panel">

        {/* ── Decorative background ── */}
        <div className="gs-bg" aria-hidden>
          <div className="gs-bg__orb gs-bg__orb--a" />
          <div className="gs-bg__orb gs-bg__orb--b" />
          <div className="gs-bg__orb gs-bg__orb--c" />
          <div className="gs-bg__grid" />
          <div className="gs-bg__scan" />
          <div className="gs-bg__edge-top" />
          <div className="gs-bg__edge-bottom" />
          <div className="gs-bg__corner gs-bg__corner--tl" />
          <div className="gs-bg__corner gs-bg__corner--tr" />
        </div>

        {/* ── Header ── */}
        <div className="gs-panel__header">
          <div className="gs-panel__tag">
            <Gamepad2 size={11} strokeWidth={2.2} />
            <span>GAME SEARCH</span>
          </div>
          <button className="gs-panel__close" onClick={onClose} aria-label="Close search">
            <X size={15} strokeWidth={2.2} />
          </button>
        </div>

        {/* ── Search input ── */}
        <div className="gs-panel__search-wrap">
          <Search size={20} className="gs-panel__search-icon" strokeWidth={2} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchMode === 'library' ? 'Search your library…' : 'Search your gaming universe…'}
            className="gs-panel__search-input"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              className="gs-panel__search-clear"
              onClick={() => { setQuery(''); inputRef.current?.focus() }}
              tabIndex={-1}
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* ── Mode toggle ── */}
        <div className="gs-panel__mode-toggle">
          <button
            className={`gs-mode-btn${searchMode === 'library' ? ' gs-mode-btn--active' : ''}`}
            onClick={() => setSearchMode('library')}
          >
            <BookOpen size={12} strokeWidth={2} />
            My Library
          </button>
          <button
            className={`gs-mode-btn${searchMode === 'global' ? ' gs-mode-btn--active' : ''}`}
            onClick={() => setSearchMode('global')}
          >
            <Globe2 size={12} strokeWidth={2} />
            All Games
          </button>
        </div>

        {/* ── Body ── */}
        <div className="gs-panel__body">

          {/* Idle / prompt */}
          {trimmed.length < 2 && (
            <div className="gs-idle">
              <div className="gs-idle__icon-wrap">
                {searchMode === 'library'
                  ? <BookOpen size={28} strokeWidth={1.5} />
                  : <Search size={28} strokeWidth={1.5} />
                }
                <div className="gs-idle__icon-pulse" />
              </div>
              <p className="gs-idle__title">
                {searchMode === 'library' ? 'Search your game collection' : 'Search across millions of games'}
              </p>
              <p className="gs-idle__sub">
                {searchMode === 'library'
                  ? 'Find games you own by title, platform, or franchise'
                  : 'Find upcoming releases, classics, and everything in between'
                }
              </p>
            </div>
          )}

          {/* Global IGDB results */}
          {showGlobalResults && igdbLoading && (
            <div className="gs-state">
              <Loader2 size={18} className="spinning" />
              <span>Scanning the database…</span>
            </div>
          )}

          {showGlobalResults && !igdbLoading && igdbError && (
            <div className="gs-state gs-state--error">
              <span>Search unavailable. Check your connection.</span>
            </div>
          )}

          {showGlobalResults && !igdbLoading && !igdbError && igdbResults.length === 0 && (
            <div className="gs-state">
              <Search size={16} style={{ opacity: 0.3 }} />
              <span>No games found for "<em>{trimmed}</em>"</span>
            </div>
          )}

          {showGlobalResults && !igdbLoading && !igdbError && igdbResults.length > 0 && (
            <div className="gs-results">
              {igdbResults.map((r, i) => (
                <GlobalResultItem key={r.igdb_id} result={r} onSelect={handleSelectGlobal} index={i} />
              ))}
            </div>
          )}

          {/* Library results */}
          {showLibraryResults && libraryResults.length === 0 && (
            <div className="gs-state">
              <BookOpen size={16} style={{ opacity: 0.3 }} />
              <span>No games in your library match "<em>{trimmed}</em>"</span>
            </div>
          )}

          {showLibraryResults && libraryResults.length > 0 && (
            <div className="gs-results">
              {libraryResults.map((g, i) => (
                <LibraryResultItem key={g.id} game={g} onSelect={handleSelectLibrary} index={i} />
              ))}
            </div>
          )}

        </div>

        {/* ── Footer ── */}
        <div className="gs-panel__footer">
          <div className="gs-panel__footer-hint">
            <kbd className="gs-kbd">ESC</kbd>
            <span>close</span>
          </div>
          <div className="gs-panel__footer-hint">
            <kbd className="gs-kbd">↵</kbd>
            <span>open game</span>
          </div>
          <div className="gs-panel__footer-sep" />
          {searchMode === 'global' && (
            <span className="gs-panel__footer-brand">Powered by IGDB</span>
          )}
          {searchMode === 'library' && (
            <span className="gs-panel__footer-brand">{libraryGames.length} games in library</span>
          )}
        </div>

      </div>
    </div>,
    document.body
  )
}
