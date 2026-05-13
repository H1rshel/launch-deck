import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Search, X, Loader, Layers, Check } from 'lucide-react'

const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

/**
 * Modal for searching IGDB collections/franchises and picking one,
 * or typing a custom collection name.
 *
 * Props:
 *   open        - boolean
 *   onClose     - () => void
 *   onSelect    - (collectionName: string) => void
 *   title       - optional header text
 *   existingCollections - string[] of existing collection names for quick-pick
 */
export default function CollectionSearchModal({ open, onClose, onSelect, title, existingCollections = [] }) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState([]) // unique collection names extracted from IGDB results
  const [customName, setCustomName] = useState('')
  const [mode, setMode] = useState('search') // 'search' | 'existing' | 'custom'
  const [existingFilter, setExistingFilter] = useState('')
  const inputRef = useRef(null)
  const debounceRef = useRef(null)

  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 80)
    }
    if (!open) {
      setQuery('')
      setResults([])
      setCustomName('')
      setExistingFilter('')
      setMode('search')
    }
  }, [open])

  function handleQueryChange(value) {
    setQuery(value)
    clearTimeout(debounceRef.current)
    if (!value.trim()) {
      setResults([])
      return
    }
    debounceRef.current = setTimeout(() => searchIgdb(value.trim()), 400)
  }

  async function searchIgdb(term) {
    if (!isTauri) return
    setSearching(true)
    try {
      const igdbRes = await invoke('search_igdb_games', { query: term })
      // Extract unique collection and franchise names from all results
      const names = new Set()
      for (const r of (igdbRes || [])) {
        for (const c of (r.collections || [])) {
          if (c.name) names.add(c.name)
        }
        for (const f of (r.franchises || [])) {
          if (f.name) names.add(f.name)
        }
        if (r.franchise) names.add(r.franchise)
      }
      setResults([...names].sort())
    } catch (err) {
      console.warn('IGDB collection search failed:', err)
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  if (!open) return null

  return (
    <div className="collection-modal__backdrop" onClick={onClose}>
      <div className="collection-modal" onClick={(e) => e.stopPropagation()}>
        <div className="collection-modal__header">
          <Layers size={16} />
          <span>{title || 'Choose Collection'}</span>
          <button className="collection-modal__close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="collection-modal__tabs">
          <button
            className={`collection-modal__tab${mode === 'search' ? ' collection-modal__tab--active' : ''}`}
            onClick={() => setMode('search')}
          >
            <Search size={12} /> IGDB Search
          </button>
          {existingCollections.length > 0 && (
            <button
              className={`collection-modal__tab${mode === 'existing' ? ' collection-modal__tab--active' : ''}`}
              onClick={() => setMode('existing')}
            >
              <Layers size={12} /> Existing
            </button>
          )}
          <button
            className={`collection-modal__tab${mode === 'custom' ? ' collection-modal__tab--active' : ''}`}
            onClick={() => setMode('custom')}
          >
            Custom
          </button>
        </div>

        <div className="collection-modal__body">
          {/* IGDB Search Mode */}
          {mode === 'search' && (
            <>
              <div className="collection-modal__search-row">
                <Search size={14} className="collection-modal__search-icon" />
                <input
                  ref={inputRef}
                  className="collection-modal__input"
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  placeholder="Search IGDB for a collection or franchise…"
                />
                {searching && <Loader size={14} className="collection-modal__spinner" />}
              </div>
              <div className="collection-modal__results">
                {results.length === 0 && query && !searching && (
                  <div className="collection-modal__empty">No collections found for "{query}"</div>
                )}
                {results.map((name) => (
                  <button
                    key={name}
                    className="collection-modal__result-item"
                    onClick={() => onSelect(name)}
                  >
                    <Layers size={13} />
                    <span>{name}</span>
                    <Check size={13} className="collection-modal__result-check" />
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Existing collections mode */}
          {mode === 'existing' && (
            <>
              <div className="collection-modal__search-row">
                <Search size={14} className="collection-modal__search-icon" />
                <input
                  className="collection-modal__input"
                  value={existingFilter}
                  onChange={(e) => setExistingFilter(e.target.value)}
                  placeholder="Filter existing collections…"
                  autoFocus
                />
              </div>
              <div className="collection-modal__results">
                {existingCollections
                  .filter((name) => !existingFilter.trim() || name.toLowerCase().includes(existingFilter.toLowerCase()))
                  .map((name) => (
                    <button
                      key={name}
                      className="collection-modal__result-item"
                      onClick={() => onSelect(name)}
                    >
                      <Layers size={13} />
                      <span>{name}</span>
                      <Check size={13} className="collection-modal__result-check" />
                    </button>
                  ))}
              </div>
            </>
          )}

          {/* Custom name mode */}
          {mode === 'custom' && (
            <div className="collection-modal__custom">
              <input
                className="collection-modal__input"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="Type a custom collection name…"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customName.trim()) onSelect(customName.trim())
                }}
              />
              <button
                className="collection-modal__apply-btn"
                disabled={!customName.trim()}
                onClick={() => onSelect(customName.trim())}
              >
                Apply
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
