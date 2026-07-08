import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Search, Delete, Space, Eraser, Heart } from 'lucide-react'
import { getGameImages } from '../../utils/imageHandler'
import { ImageWithFallback } from '../../components/ui/GameImages'
import { useInputLayer, useConsoleInput } from '../input/InputProvider'
import { playSfx } from '../audio/sounds'
import { scrollToWithin } from '../lib/scroll'
import { ButtonGlyph } from '../components/HintBar'

/**
 * Search — console-style game finder. Letters come from the on-screen
 * keyboard (driven by the controller) or straight from a physical keyboard;
 * while this overlay is open the input provider switches to text-entry mode
 * so letter keys type instead of triggering console shortcuts.
 */

const KEY_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
  ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'],
  ['U', 'V', 'W', 'X', 'Y', 'Z', '-', "'", ':', '&'],
]

const SPECIALS = [
  { id: 'space', label: 'Space', icon: Space },
  { id: 'backspace', label: 'Delete', icon: Delete },
  { id: 'clear', label: 'Clear', icon: Eraser },
]

function matchGames(games, query) {
  const byTitle = (a, b) =>
    (a.displayTitle || a.title || '').localeCompare(b.displayTitle || b.title || '')
  const q = query.trim().toLowerCase()
  if (!q) return [...games].sort(byTitle)
  const starts = []
  const includes = []
  for (const g of games) {
    const names = [g.displayTitle, g.title].filter(Boolean).map((s) => s.toLowerCase())
    if (names.some((s) => s.startsWith(q))) starts.push(g)
    else if (names.some((s) => s.includes(q))) includes.push(g)
  }
  return [...starts.sort(byTitle), ...includes.sort(byTitle)]
}

export default function SearchOverlay({ games, onSelect, onClose }) {
  const { setTextEntry } = useConsoleInput()
  const [query, setQuery] = useState('')
  const [zone, setZone] = useState('keys') // 'keys' | 'special' | 'results'
  const [keyPos, setKeyPos] = useState({ row: 1, col: 0 })
  const [specialIndex, setSpecialIndex] = useState(0)
  const [resultIndex, setResultIndex] = useState(0)
  const resultsRef = useRef(null)

  const results = useMemo(() => matchGames(games, query), [games, query])

  useEffect(() => {
    setTextEntry(true)
    return () => setTextEntry(false)
  }, [setTextEntry])

  useEffect(() => {
    setResultIndex(0)
  }, [query])

  const append = useCallback((ch) => {
    playSfx('nav')
    setQuery((q) => (q.length >= 40 ? q : q + ch))
  }, [])

  const backspace = useCallback(() => {
    playSfx('back')
    setQuery((q) => q.slice(0, -1))
  }, [])

  // Physical keyboard: printable characters + Backspace type directly.
  // Typing moves focus to the results so arrows/Enter act on matches.
  useEffect(() => {
    const onKey = (e) => {
      if (!e.isTrusted || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Backspace') {
        e.preventDefault()
        backspace()
      } else if (e.key.length === 1) {
        e.preventDefault()
        append(e.key)
        setZone('results')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [append, backspace])

  const runSpecial = useCallback(
    (id) => {
      if (id === 'space') append(' ')
      else if (id === 'backspace') backspace()
      else if (id === 'clear') { playSfx('back'); setQuery('') }
    },
    [append, backspace]
  )

  const pickResult = useCallback(
    (game) => {
      if (!game) return
      playSfx('select')
      onSelect(game)
    },
    [onSelect]
  )

  useInputLayer((action, meta) => {
    switch (action) {
      case 'left':
        if (zone === 'keys') setKeyPos((p) => { if (p.col > 0) playSfx('nav'); return { ...p, col: Math.max(0, p.col - 1) } })
        else if (zone === 'special') setSpecialIndex((i) => { if (i > 0) playSfx('nav'); return Math.max(0, i - 1) })
        else { playSfx('nav'); setZone('keys') }
        return
      case 'right':
        if (zone === 'keys') {
          if (keyPos.col >= KEY_ROWS[keyPos.row].length - 1) { playSfx('nav'); setZone('results') }
          else { playSfx('nav'); setKeyPos((p) => ({ ...p, col: p.col + 1 })) }
        } else if (zone === 'special') {
          if (specialIndex >= SPECIALS.length - 1) { playSfx('nav'); setZone('results') }
          else { playSfx('nav'); setSpecialIndex((i) => i + 1) }
        }
        return
      case 'up':
        if (zone === 'keys') setKeyPos((p) => { if (p.row > 0) playSfx('nav'); return { row: Math.max(0, p.row - 1), col: p.col } })
        else if (zone === 'special') { playSfx('nav'); setZone('keys'); setKeyPos((p) => ({ row: KEY_ROWS.length - 1, col: p.col })) }
        else setResultIndex((i) => { if (i > 0) playSfx('nav'); return Math.max(0, i - 1) })
        return
      case 'down':
        if (zone === 'keys') {
          if (keyPos.row >= KEY_ROWS.length - 1) { playSfx('nav'); setZone('special') }
          else { playSfx('nav'); setKeyPos((p) => ({ row: p.row + 1, col: p.col })) }
        } else if (zone === 'results') {
          setResultIndex((i) => { if (i < results.length - 1) playSfx('nav'); return Math.min(results.length - 1, i + 1) })
        }
        return
      case 'accept':
        // Physical Enter always means "take the highlighted match" — only the
        // controller uses accept to press on-screen keys.
        if (meta?.source === 'keyboard') { pickResult(results[resultIndex]); return }
        if (zone === 'keys') append(KEY_ROWS[keyPos.row][keyPos.col])
        else if (zone === 'special') runSpecial(SPECIALS[specialIndex].id)
        else pickResult(results[resultIndex])
        return
      case 'actionX':
        // Console convention: X/Square deletes (gamepad only — the F key
        // must type the letter f)
        if (meta?.source === 'gamepad') backspace()
        return
      case 'actionY':
        if (meta?.source === 'gamepad') append(' ')
        return
      case 'back':
        playSfx('back')
        onClose()
        return
      default:
        return
    }
  })

  // Keep the focused result in view (container-scoped — see lib/scroll.js)
  useEffect(() => {
    if (zone !== 'results') return
    scrollToWithin(resultsRef.current, resultsRef.current?.children[resultIndex])
  }, [resultIndex, zone])

  return (
    <div className="cos-search-backdrop">
      <div className="cos-search">
        {/* Left: query + keyboard */}
        <div className="cos-search__panel">
          <div className="cos-search__querybar">
            <Search size={19} className="cos-search__query-icon" />
            <span className="cos-search__query">
              {query || <span className="cos-search__placeholder">Search your library</span>}
            </span>
            <span className="cos-search__caret" aria-hidden="true" />
          </div>

          <div className="cos-search__osk">
            {KEY_ROWS.map((row, r) => (
              <div key={r} className="cos-search__osk-row">
                {row.map((ch, c) => {
                  const focusedKey = zone === 'keys' && keyPos.row === r && keyPos.col === c
                  return (
                    <button
                      key={ch}
                      className={`cos-search__key ${focusedKey ? 'cos-search__key--focused' : ''}`}
                      onMouseEnter={() => { setZone('keys'); setKeyPos({ row: r, col: c }) }}
                      onClick={() => append(ch)}
                    >
                      {ch}
                    </button>
                  )
                })}
              </div>
            ))}
            <div className="cos-search__osk-row cos-search__osk-row--special">
              {SPECIALS.map((sp, i) => {
                const Icon = sp.icon
                const focusedKey = zone === 'special' && specialIndex === i
                return (
                  <button
                    key={sp.id}
                    className={`cos-search__key cos-search__key--special ${focusedKey ? 'cos-search__key--focused' : ''}`}
                    onMouseEnter={() => { setZone('special'); setSpecialIndex(i) }}
                    onClick={() => runSpecial(sp.id)}
                  >
                    <Icon size={14} />
                    <span>{sp.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="cos-search__hints">
            <span className="cos-hint"><ButtonGlyph action="accept" /><span className="cos-hint__label">Type</span></span>
            <span className="cos-hint"><ButtonGlyph action="actionX" /><span className="cos-hint__label">Delete</span></span>
            <span className="cos-hint"><ButtonGlyph action="actionY" /><span className="cos-hint__label">Space</span></span>
            <span className="cos-hint"><ButtonGlyph action="back" /><span className="cos-hint__label">Close</span></span>
          </div>
        </div>

        {/* Right: results */}
        <div className="cos-search__results-panel">
          <span className="cos-search__results-count">
            {results.length} {results.length === 1 ? 'match' : 'matches'}
          </span>
          {results.length === 0 ? (
            <div className="cos-search__no-results">No games match “{query}”</div>
          ) : (
            <div className="cos-search__results" ref={resultsRef}>
              {results.map((game, i) => {
                const images = getGameImages(game)
                const focusedRow = zone === 'results' && i === resultIndex
                return (
                  <button
                    key={game.id}
                    className={`cos-search__result ${focusedRow ? 'cos-search__result--focused' : ''}`}
                    onMouseEnter={() => { setZone('results'); setResultIndex(i) }}
                    onClick={() => pickResult(game)}
                  >
                    <span className="cos-search__result-cover">
                      <ImageWithFallback
                        primary={images.cover}
                        fallback={images.hero}
                        alt={game.displayTitle}
                        className="cos-search__result-img"
                      />
                    </span>
                    <span className="cos-search__result-info">
                      <span className="cos-search__result-title">{game.displayTitle}</span>
                      <span className="cos-search__result-sub">
                        {game.installed ? 'Installed' : 'Not installed'}
                      </span>
                    </span>
                    {game.favorite && (
                      <Heart size={13} className="cos-search__result-fav" fill="currentColor" />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
