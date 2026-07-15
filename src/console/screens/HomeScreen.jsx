import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Play,
  Download,
  Heart,
  Trophy,
  MoreHorizontal,
  Clock,
  Calendar,
  Star,
  Ban,
  MonitorPlay,
} from 'lucide-react'
import { getGameImages } from '../../utils/imageHandler'
import { ImageWithFallback, GameLogo } from '../../components/ui/GameImages'
import { getInstallTarget } from '../../lib/launcher'
import { useStreaming } from '../../context/StreamingContext'
import { useInputLayer } from '../input/InputProvider'
import { playSfx } from '../audio/sounds'
import { formatMinutes, relativeTime, getDisplayPlaytimeMinutes } from '../lib/format'
import { useGameInsights } from '../lib/useGameInsights'
import GameInsights from '../components/GameInsights'

/**
 * Home — the console landing screen.
 *
 * The tile strip is an infinite (wrap-around) carousel: tiles are absolutely
 * positioned and moved purely with transforms, so browsing never causes
 * layout work, and only a window of tiles around the selection is mounted —
 * a 40-game and a 900-game library render the same number of DOM nodes.
 */

const TILE_W = 148
const TILE_H = 222
const GAP = 22
const SEL_SCALE = 1.3
const VISIBLE = 8 // tiles rendered on each side of the selection

/** Signed shortest distance from `sel` to `i` on a ring of size `n`. */
function wrapOffset(i, sel, n) {
  let d = i - sel
  if (n > 1) {
    if (d > n / 2) d -= n
    else if (d < -n / 2) d += n
  }
  return d
}

export default function HomeScreen({
  games,
  steamPlaytime,
  achData,
  jumpTo,
  onFocusGame,
  onPrimary,
  onOpenActions,
  onShowAchievements,
  toggleFavorite,
}) {
  const ordered = useMemo(() => {
    const byTitle = (a, b) =>
      (a.displayTitle || a.title || '').localeCompare(b.displayTitle || b.title || '')
    const played = games
      .filter((g) => g.last_played)
      .sort((a, b) => new Date(b.last_played) - new Date(a.last_played))
    const rest = games.filter((g) => !g.last_played).sort(byTitle)
    return [...played, ...rest]
  }, [games])

  // Selection tracked by game id so reordering (e.g. after a play session
  // bumps last_played) never silently moves focus to a different game.
  const [selectedId, setSelectedId] = useState(() => ordered[0]?.id ?? null)
  const [zone, setZone] = useState('tiles') // 'tiles' | 'actions'
  const [actionIndex, setActionIndex] = useState(0)
  const prevOffsetsRef = useRef(new Map())

  const n = ordered.length
  let selectedIndex = ordered.findIndex((g) => g.id === selectedId)
  if (selectedIndex === -1) selectedIndex = 0
  const focused = ordered[selectedIndex] || null

  // Re-anchor the id if the selected game disappeared from the list
  useEffect(() => {
    if (n && !ordered.some((g) => g.id === selectedId)) {
      setSelectedId(ordered[0].id)
    }
  }, [ordered, selectedId, n])

  // External jump requests (e.g. picking a search result)
  useEffect(() => {
    if (jumpTo?.id && ordered.some((g) => g.id === jumpTo.id)) {
      setSelectedId(jumpTo.id)
      setZone('tiles')
    }
  }, [jumpTo]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onFocusGame?.(focused)
  }, [focused?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const { perf, hltb } = useGameInsights(focused)
  const { getStreamSource } = useStreaming()

  const primaryAction = useMemo(() => {
    if (!focused) return null
    if (focused.installed) return { id: 'primary', label: 'Play', icon: Play, kind: 'play' }
    const streamSource = getStreamSource(focused)
    if (streamSource) {
      return {
        id: 'primary',
        label: `Stream from ${streamSource.hostname}`,
        icon: MonitorPlay,
        kind: 'play',
      }
    }
    if (getInstallTarget(focused)) return { id: 'primary', label: 'Install', icon: Download, kind: 'install' }
    return { id: 'primary', label: 'Not Installed', icon: Ban, kind: 'disabled' }
  }, [focused, getStreamSource])

  const actions = useMemo(() => {
    if (!focused || !primaryAction) return []
    const list = [primaryAction]
    list.push({
      id: 'favorite',
      label: focused.favorite ? 'Favorited' : 'Favorite',
      icon: Heart,
      active: !!focused.favorite,
    })
    if (achData?.progress) {
      list.push({ id: 'achievements', label: 'Achievements', icon: Trophy })
    }
    list.push({ id: 'more', label: 'Options', icon: MoreHorizontal })
    return list
  }, [focused, primaryAction, achData])

  useEffect(() => {
    if (actionIndex > actions.length - 1) setActionIndex(Math.max(0, actions.length - 1))
  }, [actions.length, actionIndex])

  const runAction = useCallback(
    (action) => {
      if (!focused || !action) return
      playSfx('select')
      if (action.id === 'primary') onPrimary(focused)
      else if (action.id === 'favorite') toggleFavorite(focused.id)
      else if (action.id === 'achievements') onShowAchievements()
      else if (action.id === 'more') onOpenActions(focused)
    },
    [focused, onPrimary, toggleFavorite, onShowAchievements, onOpenActions]
  )

  const moveTile = useCallback(
    (delta) => {
      if (n < 2) return
      const next = (selectedIndex + delta + n) % n
      playSfx('nav')
      setSelectedId(ordered[next].id)
    },
    [n, selectedIndex, ordered]
  )

  useInputLayer((action) => {
    switch (action) {
      case 'left':
        if (zone === 'tiles') moveTile(-1)
        else setActionIndex((i) => { if (i > 0) playSfx('nav'); return Math.max(0, i - 1) })
        return
      case 'right':
        if (zone === 'tiles') moveTile(1)
        else setActionIndex((i) => { if (i < actions.length - 1) playSfx('nav'); return Math.min(actions.length - 1, i + 1) })
        return
      case 'up':
        if (zone === 'actions') { playSfx('nav'); setZone('tiles') }
        return
      case 'down':
        if (zone === 'tiles' && actions.length) { playSfx('nav'); setZone('actions'); setActionIndex(0) }
        return
      case 'accept':
        if (zone === 'tiles') { if (focused) { playSfx('select'); onPrimary(focused) } }
        else runAction(actions[actionIndex])
        return
      case 'actionX':
        if (focused) { playSfx('select'); toggleFavorite(focused.id) }
        return
      default:
        return false
    }
  })

  const onWheel = useCallback(
    (e) => {
      if (Math.abs(e.deltaY) < 4 && Math.abs(e.deltaX) < 4) return
      moveTile(e.deltaY + e.deltaX > 0 ? 1 : -1)
    },
    [moveTile]
  )

  // Build the visible window around the selection
  const windowTiles = useMemo(() => {
    const tiles = []
    for (let i = 0; i < n; i++) {
      const d = wrapOffset(i, selectedIndex, n)
      if (Math.abs(d) > VISIBLE) continue
      tiles.push({ game: ordered[i], offset: d })
    }
    return tiles
  }, [ordered, selectedIndex, n])

  // Remember each tile's last offset so a tile whose ring distance flips
  // sign across the far edge snaps instead of flying across the strip.
  const prevOffsets = prevOffsetsRef.current
  useEffect(() => {
    const next = new Map()
    for (const t of windowTiles) next.set(t.game.id, t.offset)
    prevOffsetsRef.current = next
  })

  if (!focused) return null

  const playtime = getDisplayPlaytimeMinutes(focused, steamPlaytime)
  const achPct = achData?.progress?.total
    ? Math.round((achData.progress.unlocked / achData.progress.total) * 100)
    : null

  const releaseYear = focused.release_date
    ? new Date(focused.release_date).getFullYear() || null
    : null
  const developer = focused.developers?.[0] || null
  const genres = (focused.genres || []).slice(0, 2)

  const edgePad = (TILE_W * SEL_SCALE - TILE_W) / 2 + 10

  return (
    <div className="cos-home">
      {/* Infinite tile strip */}
      <div
        className="cos-home__strip"
        style={{ height: TILE_H * SEL_SCALE + 28 }}
        onWheel={onWheel}
      >
        {windowTiles.map(({ game, offset }) => {
          const isSelected = offset === 0
          const images = getGameImages(game)
          const x = offset * (TILE_W + GAP) + Math.sign(offset) * edgePad
          const prev = prevOffsets.get(game.id)
          const teleported = prev !== undefined && Math.abs(prev - offset) > VISIBLE
          return (
            <button
              key={game.id}
              className={`cos-tile ${isSelected ? 'cos-tile--selected' : ''} ${isSelected && zone === 'tiles' ? 'cos-tile--focused' : ''}`}
              style={{
                width: TILE_W,
                height: TILE_H,
                transform: `translate(-50%, -50%) translateX(${x}px) scale(${isSelected ? SEL_SCALE : 1})`,
                opacity: isSelected ? 1 : Math.max(0.35, 0.8 - Math.abs(offset) * 0.09),
                zIndex: 100 - Math.abs(offset),
                transition: teleported ? 'none' : undefined,
              }}
              onMouseEnter={() => {
                if (!isSelected) { playSfx('nav'); setSelectedId(game.id) }
                setZone('tiles')
              }}
              onClick={() => {
                if (isSelected) { playSfx('select'); onPrimary(game) }
                else setSelectedId(game.id)
              }}
              aria-label={game.displayTitle}
            >
              <ImageWithFallback
                primary={images.cover}
                fallback={images.hero}
                alt={game.displayTitle}
                className="cos-tile__img"
              />
              <span className="cos-tile__veil" aria-hidden="true" />
              {game.favorite && (
                <span className="cos-tile__fav">
                  <Heart size={11} fill="currentColor" />
                </span>
              )}
              <span className="cos-tile__ring" aria-hidden="true" />
              <span className="cos-tile__sheen" aria-hidden="true" />
            </button>
          )
        })}
        {n > 1 && (
          <span className="cos-home__counter">
            {selectedIndex + 1} <em>/</em> {n}
          </span>
        )}
      </div>

      {/* Hero panel */}
      <div className="cos-hero" key={focused.id}>
        <div className="cos-hero__identity">
          <GameLogo game={focused} className="cos-hero__logo" />
          {!getGameImages(focused).logo && (
            <h1 className="cos-hero__title">{focused.displayTitle}</h1>
          )}
        </div>

        {(focused.franchise || developer || releaseYear) && (
          <p className="cos-hero__byline">
            {focused.franchise && (
              <>
                <span className="cos-hero__byline-accent">{focused.franchise}</span>
                <span className="cos-hero__byline-sep"> series</span>
              </>
            )}
            {focused.franchise && (developer || releaseYear) && <span className="cos-hero__byline-dot">·</span>}
            {developer}
            {developer && releaseYear && <span className="cos-hero__byline-dot">·</span>}
            {releaseYear}
          </p>
        )}

        <div className="cos-hero__meta">
          {(playtime > 0 || focused.playtime) && (
            <span className="cos-pill">
              <Clock size={14} />
              {formatMinutes(playtime) !== '0m' ? formatMinutes(playtime) : focused.playtime}
            </span>
          )}
          {focused.last_played && (
            <span className="cos-pill">
              <Calendar size={14} />
              {relativeTime(focused.last_played)}
            </span>
          )}
          {achData?.progress && (
            <span className="cos-pill cos-pill--ach">
              <Trophy size={14} />
              <span>{achData.progress.unlocked} / {achData.progress.total}</span>
              <span className="cos-pill__bar" aria-hidden="true">
                <span className="cos-pill__bar-fill" style={{ width: `${achPct}%` }} />
              </span>
            </span>
          )}
          {focused.rating > 0 && (
            <span className="cos-pill cos-pill--rating">
              <Star size={14} fill="currentColor" stroke="none" />
              {focused.rating.toFixed(1)}
            </span>
          )}
          {genres.map((genre) => (
            <span key={genre} className="cos-pill cos-pill--genre">{genre}</span>
          ))}
        </div>

        <div className="cos-hero__actions">
          {actions.map((action, i) => {
            const Icon = action.icon
            const focusedBtn = zone === 'actions' && i === actionIndex
            const isPrimary = action.id === 'primary'
            return (
              <button
                key={action.id}
                className={[
                  'cos-action',
                  isPrimary ? 'cos-action--primary' : '',
                  action.kind === 'disabled' ? 'cos-action--disabled' : '',
                  action.active ? 'cos-action--active' : '',
                  focusedBtn ? 'cos-action--focused' : '',
                ].join(' ')}
                onMouseEnter={() => { setZone('actions'); setActionIndex(i) }}
                onClick={() => runAction(action)}
              >
                <Icon size={isPrimary ? 22 : 18} fill={isPrimary && action.kind === 'play' ? 'currentColor' : 'none'} />
                <span>{action.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Quiet insights in the opposite corner — keyed so they fade with the game */}
      <div className="cos-insights-anchor" key={`insights-${focused.id}`}>
        <GameInsights perf={perf} hltb={hltb} />
      </div>
    </div>
  )
}
