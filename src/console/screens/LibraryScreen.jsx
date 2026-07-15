import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  LayoutGrid,
  HardDriveDownload,
  Heart,
  History,
  Clock,
  Calendar,
  Gauge,
  Hourglass,
  MonitorPlay,
} from 'lucide-react'
import { useStreaming } from '../../context/StreamingContext'
import { getGameImages } from '../../utils/imageHandler'
import { ImageWithFallback, GameLogo } from '../../components/ui/GameImages'
import { useInputLayer } from '../input/InputProvider'
import { playSfx } from '../audio/sounds'
import { relativeTime } from '../lib/format'
import { useGameInsights } from '../lib/useGameInsights'
import { TIER_COLORS } from '../components/GameInsights'
import { ButtonGlyph } from '../components/HintBar'

const TILE_W = 156
const GAP = 20
const GRID_PAD_TOP = 20
const ALPHABET = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

const FILTERS = [
  { id: 'all', label: 'All Games', icon: LayoutGrid },
  { id: 'installed', label: 'Installed', icon: HardDriveDownload },
  { id: 'favorites', label: 'Favorites', icon: Heart },
  { id: 'recent', label: 'Recent', icon: History },
]

function titleLetter(game) {
  const ch = (game?.displayTitle || game?.title || '#').charAt(0).toUpperCase()
  return /[A-Z]/.test(ch) ? ch : '#'
}

/**
 * Library — console-grade collection browser.
 *
 * The grid scrolls in whole-row steps (no partially cut rows — the sliver
 * of the next row is measured at runtime and faded out exactly), flanked by
 * an A–Z jump zone and the "holo-case" spotlight of the focused game.
 */
export default function LibraryScreen({ games, onFocusGame, onOpenActions, toggleFavorite }) {
  const [filterId, setFilterId] = useState('all')
  const [zone, setZone] = useState('grid') // 'filters' | 'grid' | 'alpha'
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [cols, setCols] = useState(6)
  const [flash, setFlash] = useState(null) // { letter, key } — ghost letter on jump
  const gridRef = useRef(null)
  const topRowRef = useRef(0)

  const list = useMemo(() => {
    const byTitle = (arr) =>
      [...arr].sort((a, b) =>
        (a.displayTitle || a.title || '').localeCompare(b.displayTitle || b.title || ''))
    switch (filterId) {
      case 'installed':
        return byTitle(games.filter((g) => g.installed))
      case 'favorites':
        return byTitle(games.filter((g) => g.favorite))
      case 'recent':
        return [...games]
          .filter((g) => g.last_played)
          .sort((a, b) => new Date(b.last_played) - new Date(a.last_played))
      default:
        return byTitle(games)
    }
  }, [games, filterId])

  const focused = list[Math.min(selectedIndex, list.length - 1)] || null
  const { perf, hltb } = useGameInsights(focused)
  const { getStreamSource } = useStreaming()
  const focusedStreamSource = focused && !focused.installed ? getStreamSource(focused) : null

  // A–Z index — only meaningful for alphabetically sorted filters
  const isAlphabetical = filterId !== 'recent'
  const letterIndex = useMemo(() => {
    if (!isAlphabetical) return null
    const map = new Map()
    list.forEach((game, i) => {
      const letter = titleLetter(game)
      if (!map.has(letter)) map.set(letter, i)
    })
    return map
  }, [list, isAlphabetical])

  const currentLetter = isAlphabetical && focused ? titleLetter(focused) : null

  useEffect(() => {
    if (selectedIndex > list.length - 1) setSelectedIndex(Math.max(0, list.length - 1))
  }, [list.length, selectedIndex])

  // The alpha zone only exists for alphabetical filters
  useEffect(() => {
    if (!isAlphabetical && zone === 'alpha') setZone('grid')
  }, [isAlphabetical, zone])

  useEffect(() => {
    onFocusGame?.(focused)
  }, [focused?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track how many tiles fit per row so vertical navigation is exact.
  // Re-attach after filter switches — the grid node remounts (key=filterId)
  // to replay the entrance cascade.
  useEffect(() => {
    topRowRef.current = 0
    const el = gridRef.current
    if (!el) return undefined
    const update = () => {
      const width = el.clientWidth
      setCols(Math.max(1, Math.floor((width + GAP) / (TILE_W + GAP))))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [filterId])

  const changeFilter = useCallback((idOrDelta) => {
    playSfx('nav')
    setSelectedIndex(0)
    if (typeof idOrDelta === 'string') {
      setFilterId(idOrDelta)
    } else {
      setFilterId((cur) => {
        const idx = FILTERS.findIndex((f) => f.id === cur)
        return FILTERS[(idx + idOrDelta + FILTERS.length) % FILTERS.length].id
      })
    }
  }, [])

  const move = useCallback(
    (delta) => {
      setSelectedIndex((i) => {
        const next = Math.max(0, Math.min(list.length - 1, i + delta))
        if (next !== i) playSfx('nav')
        return next
      })
    },
    [list.length]
  )

  const jumpToLetter = useCallback(
    (letter, { stay = false } = {}) => {
      const idx = letterIndex?.get(letter)
      if (idx == null) return
      playSfx('nav')
      setSelectedIndex(idx)
      if (!stay) setZone('grid')
      setFlash({ letter, key: Date.now() })
    },
    [letterIndex]
  )

  // Surf letter groups: used by the alpha zone (stays) and LT/RT (from grid)
  const letterStep = useCallback(
    (dir, { stay = false } = {}) => {
      if (!letterIndex || !currentLetter) {
        move(dir * cols * 3)
        return
      }
      const letters = [...letterIndex.keys()]
      const cur = Math.max(0, letters.indexOf(currentLetter))
      const next = Math.max(0, Math.min(letters.length - 1, cur + dir))
      if (next !== cur) jumpToLetter(letters[next], { stay })
    },
    [letterIndex, currentLetter, jumpToLetter, move, cols]
  )

  useInputLayer((action) => {
    switch (action) {
      case 'left':
        if (zone === 'grid') move(-1)
        else if (zone === 'alpha') { playSfx('nav'); setZone('grid') }
        else changeFilter(-1)
        return
      case 'right':
        if (zone === 'grid') {
          const atRowEnd = (selectedIndex + 1) % cols === 0 || selectedIndex === list.length - 1
          if (atRowEnd && isAlphabetical && list.length) { playSfx('nav'); setZone('alpha') }
          else move(1)
        } else if (zone === 'filters') {
          changeFilter(1)
        }
        return
      case 'up':
        if (zone === 'grid') {
          if (selectedIndex - cols >= 0) move(-cols)
          else { playSfx('nav'); setZone('filters') }
        } else if (zone === 'alpha') {
          letterStep(-1, { stay: true })
        }
        return
      case 'down':
        if (zone === 'filters') {
          if (list.length) { playSfx('nav'); setZone('grid') }
        } else if (zone === 'alpha') {
          letterStep(1, { stay: true })
        } else if (selectedIndex + cols <= list.length - 1) {
          move(cols)
        } else if (Math.floor(selectedIndex / cols) < Math.floor((list.length - 1) / cols)) {
          move(list.length - 1 - selectedIndex)
        }
        return
      case 'lt':
        // Triggers cycle the collection filters (bumpers switch screens).
        // Letter jumping lives in the A–Z rail: navigate right → up/down.
        changeFilter(-1)
        return
      case 'rt':
        changeFilter(1)
        return
      case 'accept':
        if (zone === 'filters') {
          if (list.length) { playSfx('select'); setZone('grid') }
        } else if (zone === 'alpha') {
          playSfx('select')
          setZone('grid')
        } else if (focused) {
          playSfx('select')
          onOpenActions(focused)
        }
        return
      case 'actionX':
        if (zone !== 'filters' && focused) { playSfx('select'); toggleFavorite(focused.id) }
        return
      case 'back':
        if (zone === 'alpha') { playSfx('back'); setZone('grid'); return }
        return false
      default:
        return false
    }
  })

  // ── Row-quantized scrolling ──
  // The grid always rests on a whole-row boundary, console style: no row is
  // ever half-cut by the viewport. The sliver of the next row that fits in
  // the leftover band is measured and dissolved by the mask (--cos-peek).
  useEffect(() => {
    const grid = gridRef.current
    const tile = grid?.children[selectedIndex] ? grid.children[0] : null
    if (!grid || !tile) return

    const rowStep = tile.offsetHeight + GAP
    if (rowStep <= GAP) return
    const visibleRows = Math.max(1, Math.floor((grid.clientHeight - GRID_PAD_TOP) / rowStep))
    const totalRows = Math.ceil(list.length / cols)
    const row = Math.floor(selectedIndex / cols)

    let top = topRowRef.current
    if (row < top) top = row
    else if (row > top + visibleRows - 1) top = row - visibleRows + 1
    top = Math.max(0, Math.min(top, Math.max(0, totalRows - visibleRows)))
    topRowRef.current = top

    grid.scrollTo({ top: top * rowStep, behavior: 'smooth' })

    // Fade out exactly the leftover band below the last fully visible row
    const leftover = grid.clientHeight - GRID_PAD_TOP - visibleRows * rowStep + GAP
    grid.style.setProperty('--cos-peek', `${Math.max(28, Math.round(leftover) + 10)}px`)
  }, [selectedIndex, cols, list.length, filterId])

  const genres = (focused?.genres || []).slice(0, 3)
  const focusedImages = focused ? getGameImages(focused) : null
  const tierColor = perf ? TIER_COLORS[perf.tierColor] || TIER_COLORS.gray : null

  return (
    <div className="cos-library">
      <div className="cos-library__header">
        <div className="cos-library__heading">
          <span className="cos-library__eyebrow">Collection</span>
          <span className="cos-library__count">
            {list.length} {list.length === 1 ? 'game' : 'games'}
          </span>
        </div>

        <div className="cos-library__filters-nav">
          <span className="cos-library__filters-trigger" onClick={() => changeFilter(-1)}>
            <ButtonGlyph action="lt" />
          </span>
          <div className="cos-library__filters">
            {FILTERS.map((f) => {
              const Icon = f.icon
              const isActive = filterId === f.id
              const isFocused = zone === 'filters' && isActive
              return (
                <button
                  key={f.id}
                  className={[
                    'cos-filter',
                    isActive ? 'cos-filter--active' : '',
                    isFocused ? 'cos-filter--focused' : '',
                  ].join(' ')}
                  onMouseEnter={() => setZone('filters')}
                  onClick={() => changeFilter(f.id)}
                >
                  <Icon size={15} />
                  <span>{f.label}</span>
                </button>
              )
            })}
          </div>
          <span className="cos-library__filters-trigger" onClick={() => changeFilter(1)}>
            <ButtonGlyph action="rt" />
          </span>
        </div>
      </div>

      <div className="cos-library__divider" aria-hidden="true" />

      <div className="cos-library__body">
        {/* Giant letter watermark tracking the current section */}
        {currentLetter && (
          <div className="cos-library__watermark" key={currentLetter} aria-hidden="true">
            {currentLetter}
          </div>
        )}

        {list.length === 0 ? (
          <div className="cos-library__empty">
            <p>
              {filterId === 'favorites'
                ? 'No favorites yet — press F / X on a game to add one.'
                : filterId === 'recent'
                  ? 'Nothing played recently.'
                  : filterId === 'installed'
                    ? 'No installed games detected.'
                    : 'Your library is empty.'}
            </p>
          </div>
        ) : (
          <>
            <div className="cos-library__grid-wrap">
              <div
                className="cos-library__grid"
                key={filterId}
                ref={gridRef}
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_W}px, 1fr))`,
                  gap: GAP,
                  paddingTop: GRID_PAD_TOP,
                }}
              >
                {list.map((game, i) => {
                  const isSelected =
                    i === selectedIndex && (zone === 'grid' || zone === 'alpha')
                  const images = getGameImages(game)
                  const streamable = !game.installed && !!getStreamSource(game)
                  return (
                    <button
                      key={game.id}
                      style={{ '--i': i }}
                      className={`cos-grid-tile ${isSelected ? 'cos-grid-tile--selected' : ''} ${!game.installed && !streamable ? 'cos-grid-tile--ghost' : ''}`}
                      onMouseEnter={() => {
                        setZone('grid')
                        if (i !== selectedIndex) { playSfx('nav'); setSelectedIndex(i) }
                      }}
                      onClick={() => { playSfx('select'); onOpenActions(game) }}
                      aria-label={game.displayTitle}
                    >
                      <ImageWithFallback
                        primary={images.cover}
                        fallback={images.hero}
                        alt={game.displayTitle}
                        className="cos-grid-tile__img"
                      />
                      <span className="cos-grid-tile__plate" aria-hidden="true">
                        <span className="cos-grid-tile__name">{game.displayTitle}</span>
                      </span>
                      {game.favorite && (
                        <span className="cos-tile__fav">
                          <Heart size={11} fill="currentColor" />
                        </span>
                      )}
                      {streamable && (
                        <span className="cos-tile__stream" title="Streamable from another PC">
                          <MonitorPlay size={11} />
                        </span>
                      )}
                      <span className="cos-tile__ring" aria-hidden="true" />
                      <span className="cos-tile__sheen" aria-hidden="true" />
                    </button>
                  )
                })}
              </div>

              {flash && (
                <div className="cos-library__flash" key={flash.key} aria-hidden="true">
                  {flash.letter}
                </div>
              )}
            </div>

            {isAlphabetical && (
              <div className={`cos-library__alpha ${zone === 'alpha' ? 'cos-library__alpha--active' : ''}`}>
                {ALPHABET.map((letter) => {
                  const present = letterIndex?.has(letter)
                  const isCurrent = letter === currentLetter
                  const isFocused = zone === 'alpha' && isCurrent
                  return (
                    <button
                      key={letter}
                      className={[
                        'cos-library__alpha-letter',
                        present ? 'cos-library__alpha-letter--present' : '',
                        isCurrent ? 'cos-library__alpha-letter--current' : '',
                        isFocused ? 'cos-library__alpha-letter--focused' : '',
                      ].join(' ')}
                      tabIndex={-1}
                      onClick={() => present && jumpToLetter(letter)}
                    >
                      {letter}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Spotlight — holo-case for the focused game */}
            <aside className="cos-library__spotlight">
              {focused && (
                <div className="cos-spot" key={focused.id}>
                  <span className="cos-spot__eyebrow">
                    Now browsing
                    <em>{selectedIndex + 1} / {list.length}</em>
                  </span>

                  <div className="cos-spot__case">
                    <div className="cos-spot__cover">
                      <ImageWithFallback
                        primary={focusedImages.cover}
                        fallback={focusedImages.hero}
                        alt={focused.displayTitle}
                        className="cos-spot__cover-img"
                      />
                      <span className="cos-spot__cover-sheen" aria-hidden="true" />
                    </div>
                  </div>

                  <div className="cos-spot__identity">
                    <GameLogo game={focused} className="cos-spot__logo" />
                    {!focusedImages.logo && (
                      <h3 className="cos-spot__title">{focused.displayTitle}</h3>
                    )}
                  </div>

                  <div className="cos-spot__meta">
                    <span className="cos-spot__row">
                      <span
                        className={`cos-library__focus-dot ${focused.installed ? 'cos-library__focus-dot--on' : ''} ${focusedStreamSource ? 'cos-library__focus-dot--stream' : ''}`}
                      />
                      {focused.installed
                        ? 'Installed'
                        : focusedStreamSource
                          ? `Stream from ${focusedStreamSource.hostname}`
                          : 'Not installed'}
                      {focused.favorite && (
                        <Heart size={11} className="cos-spot__fav-icon" fill="currentColor" />
                      )}
                    </span>
                    {focused.playtime && focused.playtime !== '0m' && (
                      <span className="cos-spot__row">
                        <Clock size={12} /> {focused.playtime} played
                      </span>
                    )}
                    {focused.last_played && (
                      <span className="cos-spot__row">
                        <Calendar size={12} /> {relativeTime(focused.last_played)}
                      </span>
                    )}
                    {genres.length > 0 && (
                      <span className="cos-spot__genres">{genres.join(' · ')}</span>
                    )}
                  </div>

                  {(perf || hltb) && (
                    <div className="cos-spot__insights">
                      {perf && (
                        <>
                          <span className="cos-spot__row">
                            <Gauge size={12} />
                            <em style={{ color: tierColor }}>{perf.tier}</em>
                            <span className="cos-spot__dim">· {perf.bestTarget}</span>
                          </span>
                          <span className="cos-spot__bar" aria-hidden="true">
                            <span
                              className="cos-spot__bar-fill"
                              style={{
                                width: `${Math.min(100, Math.round(perf.overallFit))}%`,
                                background: tierColor,
                              }}
                            />
                          </span>
                        </>
                      )}
                      {hltb && (hltb.main > 0 || hltb.completionist > 0) && (
                        <span className="cos-spot__row">
                          <Hourglass size={12} />
                          {hltb.main > 0 && <span>Story {hltb.main}h</span>}
                          {hltb.main > 0 && hltb.completionist > 0 && (
                            <span className="cos-spot__dim">·</span>
                          )}
                          {hltb.completionist > 0 && <span>100% {hltb.completionist}h</span>}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="cos-spot__hints">
                    <span className="cos-spot__hint">
                      <ButtonGlyph action="accept" />
                      <span>Options</span>
                    </span>
                    <span className="cos-spot__hint">
                      <ButtonGlyph action="actionX" />
                      <span>Favorite</span>
                    </span>
                  </div>
                </div>
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  )
}
