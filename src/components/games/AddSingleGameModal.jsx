import { useState, useCallback, useEffect } from 'react'
import { X, Search, Loader, FileCode2, ChevronDown, AlertTriangle, FolderOpen, Check } from 'lucide-react'
import { searchGame } from '../../lib/rawg'

const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

async function searchIgdbFirst(term) {
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const raw = await invoke('search_igdb_games', { query: term })
      if (raw && raw.length > 0) {
        return raw.map((r) => ({
          name: r.name,
          background_image: r.coverUrl || null,
          released: r.firstReleaseDate
            ? new Date(r.firstReleaseDate * 1000).toISOString().split('T')[0]
            : '',
          rating: 0,
          _igdb_genres: r.genres || [],
          _igdb_franchise: r.franchise || null,
          _igdb_id: r.id || null,
          _igdb_summary: r.summary || '',
          _igdb_storyline: r.storyline || '',
          _igdb_themes: r.themes || [],
          _igdb_ageRatings: r.ageRatings || [],
          _igdb_similarGames: r.similarGames || [],
          _igdb_involvedCompanies: r.involvedCompanies || [],
          _igdb_collections: (r.collections || []).map(c => ({ name: c.name, slug: c.slug || '' })),
          _igdb_franchises: (r.franchises || []).map(f => ({ name: f.name, slug: f.slug || '' })),
        }))
      }
    } catch (e) {
      console.warn('IGDB search failed, falling back to RAWG:', e)
    }
  }
  return (await searchGame(term)) || []
}

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

async function pickExeFile() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      title: 'Select Game Executable',
      filters: [{ name: 'Executable', extensions: ['exe'] }],
      multiple: false,
    })
    return typeof selected === 'string' ? selected : null
  } catch {
    return null
  }
}

export default function AddSingleGameModal({ folderPath, exePath, exeOptions = [], initialTitle, onConfirm, onClose, adding }) {
  const [query, setQuery] = useState(initialTitle || '')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const [selectedExe, setSelectedExe] = useState(exePath || null)
  const [exeOpen, setExeOpen] = useState(false)

  const noExeFound = !selectedExe && exeOptions.length === 0

  const handleSearch = useCallback(async (overrideQuery) => {
    const term = (overrideQuery ?? query).trim()
    if (!term) return
    setLoading(true)
    setHasSearched(true)
    setSearchError(null)
    try {
      const items = await searchIgdbFirst(term)
      setResults(items || [])
    } catch (err) {
      setResults([])
      setSearchError(err?.message || 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [query])

  const handleBrowse = useCallback(async () => {
    const exe = await pickExeFile()
    if (exe) {
      setSelectedExe(exe)
      setExeOpen(false)
      const hint = basename(exe).replace(/\.exe$/i, '')
      if (hint) {
        setQuery(hint)
        handleSearch(hint)
      }
    }
  }, [handleSearch])

  useEffect(() => {
    if (initialTitle) handleSearch(initialTitle)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cover-picker__backdrop" onClick={adding ? undefined : onClose}>
      <div className="cover-picker add-game__modal" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="cover-picker__header">
          <h3 className="cover-picker__title">Add Game</h3>
          <button className="cover-picker__close" onClick={onClose} disabled={adding}>
            <X size={18} />
          </button>
        </div>

        {/* ── Exe selector ───────────────────────────────────── */}
        {noExeFound ? (
          /* Error state — no exe detected */
          <div className="add-game__exe-error">
            <div className="add-game__exe-error-header">
              <AlertTriangle size={42} />
              <span>No executable detected in this folder</span>
            </div>
            <button className="add-game__browse-btn" onClick={handleBrowse}>
              <FolderOpen size={18} />
              Browse for .exe file…
            </button>
          </div>
        ) : (
          /* Exe accordion */
          <div className="add-game__exe-section">
            <button
              className={`add-game__exe-toggle${exeOpen ? ' add-game__exe-toggle--open' : ''}`}
              onClick={() => setExeOpen(o => !o)}
              disabled={adding}
            >
              <FileCode2 size={13} className="add-game__exe-toggle-icon" />
              <span className="add-game__exe-toggle-name">{selectedExe ? basename(selectedExe) : '—'}</span>
              <ChevronDown size={13} className="add-game__exe-toggle-chevron" />
            </button>

            {exeOpen && (
              <div className="add-game__exe-list">
                {exeOptions.map((exe) => (
                  <button
                    key={exe}
                    className={`add-game__exe-item${exe === selectedExe ? ' add-game__exe-item--active' : ''}`}
                    onClick={() => { setSelectedExe(exe); setExeOpen(false) }}
                  >
                    <div className="add-game__exe-item-check">
                      {exe === selectedExe && <Check size={11} />}
                    </div>
                    <div className="add-game__exe-item-info">
                      <span className="add-game__exe-item-name">{basename(exe)}</span>
                      <span className="add-game__exe-item-path">{exe}</span>
                    </div>
                  </button>
                ))}
                <button className="add-game__exe-item add-game__exe-item--browse" onClick={handleBrowse}>
                  <div className="add-game__exe-item-check">
                    <FolderOpen size={11} />
                  </div>
                  <div className="add-game__exe-item-info">
                    <span className="add-game__exe-item-name">Browse for .exe file…</span>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Search + results (hidden while exe list is open or in error/no-exe state) ── */}
        {!noExeFound && (
          <>
            <div className="cover-picker__search">
              <input
                className="cover-picker__input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search game title..."
                onKeyDown={(e) => e.key === 'Enter' && !adding && handleSearch()}
                autoFocus
                disabled={adding}
              />
              <button
                className="cover-picker__search-btn"
                onClick={() => handleSearch()}
                disabled={loading || adding}
              >
                {loading ? <Loader size={16} className="settings__spinner" /> : <Search size={16} />}
              </button>
            </div>

            <div className="cover-picker__metadata-results">
              {adding ? (
                <div className="add-game__status">
                  <Loader size={22} className="settings__spinner" />
                  <span>Adding game and fetching metadata…</span>
                </div>
              ) : exeOpen ? (
                /* Exe list is open — don't show results beneath it */
                null
              ) : (
                <>
                  {results.map((r, i) => (
                    <div
                      key={i}
                      className="cover-picker__metadata-item"
                      onClick={() => onConfirm(r, selectedExe)}
                    >
                      {r.background_image ? (
                        <img src={r.background_image} alt="" className="cover-picker__metadata-item-img" />
                      ) : (
                        <div className="cover-picker__metadata-item-placeholder" />
                      )}
                      <div className="cover-picker__metadata-item-info">
                        <span className="cover-picker__metadata-item-name">{r.name}</span>
                        <span className="cover-picker__metadata-item-date">
                          {r.released ? r.released.substring(0, 4) : 'Unknown Year'}
                        </span>
                      </div>
                    </div>
                  ))}
                  {searchError && !loading && (
                    <p className="cover-picker__empty" style={{ color: 'var(--color-error, #f87171)' }}>
                      {searchError}
                    </p>
                  )}
                  {hasSearched && results.length === 0 && !loading && !searchError && (
                    <p className="cover-picker__empty">No games found — try a different title.</p>
                  )}
                  {!hasSearched && !loading && (
                    <p className="cover-picker__empty">Search for the correct game title above.</p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
