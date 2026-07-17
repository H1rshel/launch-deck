import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  MonitorPlay,
  Ban,
  MoreHorizontal,
  RefreshCw,
  LogOut,
  Volume2,
  VolumeX,
  Heart,
  Gamepad2,
  Wifi,
  WifiOff,
  User,
  ArrowLeft,
  Download,
  Search,
} from 'lucide-react'
import { InputProvider, useConsoleInput, useInputLayer } from '../console/input/InputProvider'
import { initSounds, disposeSounds, playSfx, soundsEnabled, setSoundsEnabled } from '../console/audio/sounds'
import HintBar, { ButtonGlyph } from '../console/components/HintBar'
import { ImageWithFallback } from '../components/ui/GameImages'
import { useProfileAvatar } from '../hooks/useProfileAvatar'
import consoleModeTransitionSfx from '../assets/sounds/console-mode-transition.mp3'
import '../styles/console-mode.css'
import './remote-console.css'

/**
 * Remote Console — the real Console Mode experience for Launch Deck Remote.
 *
 * Reuses the desktop console design system (console-mode.css, the input
 * layer stack, the sound engine, the wrap-around carousel) but is backed
 * purely by cloud data and the native streaming bridge. Everything the
 * user sees before game video is this.
 */

const TILE_W = 148
const TILE_H = 222
const GAP = 22
const SEL_SCALE = 1.3
const VISIBLE = 8

function wrapOffset(i, sel, n) {
  let d = i - sel
  if (n > 1) {
    if (d > n / 2) d -= n
    else if (d < -n / 2) d += n
  }
  return d
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10000)
    return () => clearInterval(id)
  }, [])
  return now
}

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'favorites', label: 'Favorites' },
]

function RemoteStatusBar({ user, hostName, tab, onTabChange }) {
  const { gamepadConnected } = useConsoleInput()
  const { avatarUrl } = useProfileAvatar()
  const isOnline = useOnline()
  const now = useClock()
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now
    .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase()
  const username = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Player'

  return (
    <header className="cos-statusbar">
      <div className="cos-statusbar__brand">
        <img src="/launch-deck-logo-alt.png" alt="" className="cos-statusbar__logo" />
        <span className="cos-statusbar__brand-name">Launch Deck</span>
        <span className="rc-remote-tag">REMOTE</span>
      </div>

      <nav className="cos-statusbar__tabs">
        <ButtonGlyph action="lb" />
        <div className="cos-statusbar__tab-strip">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`cos-statusbar__tab ${tab === t.id ? 'cos-statusbar__tab--active' : ''}`}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <ButtonGlyph action="rb" />
      </nav>

      <div className="cos-statusbar__system">
        {hostName ? (
          <span className="rc-host__chip rc-host__chip--online">
            <span className="rc-host__dot" /> {hostName}
          </span>
        ) : (
          <span className="rc-host__chip">No PC online</span>
        )}
        <span
          className={`cos-statusbar__pad ${gamepadConnected ? 'cos-statusbar__pad--on' : ''}`}
        >
          <Gamepad2 size={17} />
        </span>
        <span className={`cos-statusbar__net ${isOnline ? '' : 'cos-statusbar__net--off'}`}>
          {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
        </span>
        <div className="cos-statusbar__clock">
          <span className="cos-statusbar__time">{time}</span>
          <span className="cos-statusbar__date">{date}</span>
        </div>
        <div className="cos-statusbar__user" title={username}>
          {avatarUrl ? (
            <img src={avatarUrl} alt={username} className="cos-statusbar__avatar" />
          ) : (
            <span className="cos-statusbar__avatar cos-statusbar__avatar--fallback">
              <User size={15} />
            </span>
          )}
        </div>
      </div>
    </header>
  )
}

/** Base input layer: system actions available everywhere. */
function GlobalLayer({ onQuickMenu }) {
  useInputLayer((action) => {
    if (action === 'menu') {
      playSfx('open')
      onQuickMenu()
      return
    }
    return false
  })
  return null
}

/**
 * Quick Menu — faithful port of the desktop console's control center:
 * slides up from the bottom, horizontal items, clock in the head.
 */
function QuickMenu({ onClose, onRefresh, onSignOut, userEmail, update, onInstallUpdate }) {
  const [index, setIndex] = useState(0)
  const [soundsOn, setSoundsOn] = useState(soundsEnabled())
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10000)
    return () => clearInterval(id)
  }, [])

  const items = useMemo(() => {
    const list = [{ id: 'resume', label: 'Resume', icon: ArrowLeft }]
    if (update) {
      list.push({
        id: 'update',
        label: `Install Update ${update.version}`,
        sub: 'Downloads and opens the installer',
        icon: Download,
        active: true,
      })
    }
    list.push({
      id: 'sounds',
      label: soundsOn ? 'Sounds On' : 'Sounds Off',
      icon: soundsOn ? Volume2 : VolumeX,
      active: soundsOn,
    })
    list.push({
      id: 'refresh',
      label: 'Refresh Library',
      sub: 'Pull the latest from your PC',
      icon: RefreshCw,
    })
    list.push({
      id: 'signout',
      label: confirmingSignOut ? 'Press Again to Sign Out' : 'Sign Out',
      sub: confirmingSignOut ? 'You will need a new link code' : userEmail,
      icon: LogOut,
      danger: true,
    })
    return list
  }, [soundsOn, confirmingSignOut, userEmail, update])

  const activate = useCallback(
    (item) => {
      playSfx('select')
      switch (item.id) {
        case 'resume':
          onClose()
          break
        case 'sounds': {
          const next = !soundsEnabled()
          setSoundsEnabled(next)
          setSoundsOn(next)
          break
        }
        case 'refresh':
          onRefresh()
          onClose()
          break
        case 'update':
          onInstallUpdate()
          onClose()
          break
        case 'signout':
          if (confirmingSignOut) onSignOut()
          else setConfirmingSignOut(true)
          break
        default:
          break
      }
    },
    [onClose, onRefresh, onSignOut, onInstallUpdate, confirmingSignOut],
  )

  useInputLayer((action) => {
    switch (action) {
      case 'left':
        setConfirmingSignOut(false)
        setIndex((i) => { if (i > 0) playSfx('nav'); return Math.max(0, i - 1) })
        return
      case 'right':
        setConfirmingSignOut(false)
        setIndex((i) => { if (i < items.length - 1) playSfx('nav'); return Math.min(items.length - 1, i + 1) })
        return
      case 'accept':
        activate(items[index])
        return
      case 'back':
      case 'menu':
        playSfx('back')
        setConfirmingSignOut(false)
        onClose()
        return
      default:
        return
    }
  })

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="cos-quickmenu-backdrop" onClick={onClose}>
      <div className="cos-quickmenu" onClick={(e) => e.stopPropagation()}>
        <div className="cos-quickmenu__head">
          <div className="cos-quickmenu__clock">
            <span className="cos-quickmenu__time">{time}</span>
            <span className="cos-quickmenu__date">{date}</span>
          </div>
          <span className="cos-quickmenu__hint">
            <ButtonGlyph action="back" />
            <span>Close</span>
          </span>
        </div>

        <div className="cos-quickmenu__items">
          {items.map((item, i) => {
            const Icon = item.icon
            const focusedItem = i === index
            return (
              <button
                key={item.id}
                className={[
                  'cos-quickmenu__item',
                  focusedItem ? 'cos-quickmenu__item--focused' : '',
                  item.danger ? 'cos-quickmenu__item--danger' : '',
                  item.active ? 'cos-quickmenu__item--active' : '',
                ].join(' ')}
                onMouseEnter={() => { setConfirmingSignOut(false); setIndex(i) }}
                onClick={() => activate(item)}
              >
                <span className="cos-quickmenu__item-icon">
                  <Icon size={22} />
                </span>
                <span className="cos-quickmenu__item-label">{item.label}</span>
                {item.sub && <span className="cos-quickmenu__item-sub">{item.sub}</span>}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Y — find a game by name. Uses the real keyboard/IME; controller navigates results. */
function SearchOverlay({ games, sourceMap, onSelect, onClose }) {
  const { setTextEntry } = useConsoleInput()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    setTextEntry(true)
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => {
      clearTimeout(t)
      setTextEntry(false)
    }
  }, [setTextEntry])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const title = (g) => (g.normalized_title || g.title || '').toLowerCase()
    const starts = games.filter((g) => title(g).startsWith(q))
    const contains = games.filter((g) => !title(g).startsWith(q) && title(g).includes(q))
    return [...starts, ...contains].slice(0, 8)
  }, [games, query])

  useEffect(() => { setIndex(0) }, [query])

  useInputLayer((action) => {
    switch (action) {
      case 'up':
        playSfx('nav')
        setIndex((i) => Math.max(0, i - 1))
        return
      case 'down':
        playSfx('nav')
        setIndex((i) => Math.min(Math.max(results.length - 1, 0), i + 1))
        return
      case 'accept':
        if (results[index]) { playSfx('select'); onSelect(results[index]) }
        return
      case 'back':
        playSfx('back')
        onClose()
        return
      default:
        return
    }
  })

  return (
    <div className="rc-search__backdrop" onClick={onClose}>
      <div className="rc-search" onClick={(e) => e.stopPropagation()}>
        <div className="rc-search__box">
          <Search size={19} />
          <input
            ref={inputRef}
            className="rc-search__input"
            placeholder="Search your library…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="rc-search__hint">
            <ButtonGlyph action="back" />
          </span>
        </div>
        {results.length > 0 && (
          <div className="rc-search__results">
            {results.map((game, i) => {
              const streamable = sourceMap.has(game.game_id)
              return (
                <button
                  key={game.game_id}
                  className={`rc-search__row ${i === index ? 'rc-search__row--focused' : ''}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => { playSfx('select'); onSelect(game) }}
                >
                  <span className="rc-search__thumb">
                    <ImageWithFallback
                      primary={game.cover_url}
                      fallback={game.hero_url}
                      alt={game.normalized_title || game.title}
                      className="rc-search__thumb-img"
                    />
                  </span>
                  <span className="rc-search__name">{game.normalized_title || game.title}</span>
                  {streamable && <span className="rc-search__chip">Stream</span>}
                </button>
              )
            })}
          </div>
        )}
        {query.trim() && results.length === 0 && (
          <p className="rc-search__none">Nothing matches “{query.trim()}”</p>
        )}
      </div>
    </div>
  )
}

const STEP_TEXT = {
  engine: 'Starting the streaming engine…',
  connect: 'Contacting your PC…',
  pair: 'Securing the connection…',
  app: 'Finding the game…',
  launch: 'Starting video…',
}

function StartingOverlay({ starting, onCancel }) {
  useInputLayer((action) => {
    if (action === 'back') {
      playSfx('back')
      onCancel()
    }
  })
  const art = starting.game.hero_url || starting.game.cover_url
  return (
    <div className="rc-starting" onClick={onCancel}>
      {art && <div className="rc-starting__bg" style={{ backgroundImage: `url(${art})` }} />}
      <div className="rc-starting__shade" />
      <div className="rc-starting__content" onClick={(e) => e.stopPropagation()}>
        {starting.game.cover_url && (
          <img className="rc-starting__cover" src={starting.game.cover_url} alt="" />
        )}
        <div className="rc-starting__ring" />
        <h2>{starting.game.normalized_title || starting.game.title}</h2>
        <p>{STEP_TEXT[starting.step] || `Getting ready on ${starting.source.hostname}…`}</p>
        <span className="rc-starting__cancel">Tap anywhere to cancel</span>
      </div>
    </div>
  )
}

function ConsoleHome({
  user,
  games,
  sourceMap,
  descMap,
  onlineHosts,
  libLoading,
  starting,
  update,
  updating,
  onInstallUpdate,
  onPlay,
  onCancel,
  onRefresh,
  onSignOut,
  onToggleFavorite,
  toast,
}) {
  const { device, gamepadConnected } = useConsoleInput()
  const [selectedId, setSelectedId] = useState(null)
  const [zone, setZone] = useState('tiles')
  const [actionIndex, setActionIndex] = useState(0)
  const [quickMenu, setQuickMenu] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [tab, setTab] = useState('home')
  const prevOffsetsRef = useRef(new Map())

  const visibleGames = useMemo(
    () => (tab === 'favorites' ? games.filter((g) => g.favorite) : games),
    [games, tab],
  )

  const n = visibleGames.length
  let selectedIndex = visibleGames.findIndex((g) => g.game_id === selectedId)
  if (selectedIndex === -1) selectedIndex = 0
  const focused = visibleGames[selectedIndex] || null

  useEffect(() => {
    if (n && !visibleGames.some((g) => g.game_id === selectedId)) {
      setSelectedId(visibleGames[0].game_id)
    }
  }, [visibleGames, selectedId, n])

  const switchTab = useCallback((next) => {
    if (!next || next === tab) return
    playSfx('nav')
    setTab(next)
    setZone('tiles')
  }, [tab])

  const focusedSource = focused ? sourceMap.get(focused.game_id)?.[0] || null : null
  const description = focused ? descMap.get(focused.game_id) || '' : ''

  const actions = useMemo(() => {
    if (!focused) return []
    const primary = focusedSource
      ? { id: 'primary', label: `Stream from ${focusedSource.hostname}`, icon: MonitorPlay, kind: 'play' }
      : {
          id: 'primary',
          label: onlineHosts.length ? 'Not on an online PC' : 'No PC online',
          icon: Ban,
          kind: 'disabled',
        }
    return [primary, { id: 'more', label: 'Menu', icon: MoreHorizontal }]
  }, [focused, focusedSource, onlineHosts.length])

  const runAction = useCallback(
    (action) => {
      if (!focused || !action) return
      playSfx('select')
      if (action.id === 'primary') onPlay(focused, focusedSource)
      else if (action.id === 'more') setQuickMenu(true)
    },
    [focused, focusedSource, onPlay],
  )

  const moveTile = useCallback(
    (delta) => {
      if (n < 2) return
      const next = (selectedIndex + delta + n) % n
      playSfx('nav')
      setSelectedId(visibleGames[next].game_id)
    },
    [n, selectedIndex, visibleGames],
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
        if (zone === 'tiles') { if (focused) { playSfx('select'); onPlay(focused, focusedSource) } }
        else runAction(actions[actionIndex])
        return
      case 'lb':
      case 'rb':
        switchTab(tab === 'home' ? 'favorites' : 'home')
        return
      case 'actionX':
        if (focused) { playSfx('select'); onToggleFavorite(focused) }
        return
      case 'actionY':
        playSfx('open')
        setSearchOpen(true)
        return
      default:
        return false
    }
  }, !starting && !quickMenu && !searchOpen)

  const onWheel = useCallback(
    (e) => {
      if (Math.abs(e.deltaY) < 4 && Math.abs(e.deltaX) < 4) return
      moveTile(e.deltaY + e.deltaX > 0 ? 1 : -1)
    },
    [moveTile],
  )

  // ── Background crossfade ──
  const [bgA, setBgA] = useState({ url: null, position: 'right top' })
  const [bgB, setBgB] = useState({ url: null, position: 'right top' })
  const [activeBgLayer, setActiveBgLayer] = useState('a')
  const activeBgRef = useRef('a')
  useEffect(() => {
    if (!focused) return
    const url = focused.hero_url || focused.cover_url || null
    const position = focused.hero_position || 'right top'
    const next = activeBgRef.current === 'a' ? 'b' : 'a'
    if (next === 'b') setBgB({ url, position })
    else setBgA({ url, position })
    activeBgRef.current = next
    setActiveBgLayer(next)
  }, [focused?.game_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const windowTiles = useMemo(() => {
    const tiles = []
    for (let i = 0; i < n; i++) {
      const d = wrapOffset(i, selectedIndex, n)
      if (Math.abs(d) > VISIBLE) continue
      tiles.push({ game: visibleGames[i], offset: d })
    }
    return tiles
  }, [visibleGames, selectedIndex, n])

  const prevOffsets = prevOffsetsRef.current
  useEffect(() => {
    const next = new Map()
    for (const t of windowTiles) next.set(t.game.game_id, t.offset)
    prevOffsetsRef.current = next
  })

  const hints = useMemo(
    () => [
      { action: 'dirH', label: 'Browse' },
      { action: 'accept', label: focusedSource ? 'Stream' : 'Select' },
      { action: 'actionX', label: focused?.favorite ? 'Unfavorite' : 'Favorite' },
      { action: 'actionY', label: 'Search' },
      { action: 'menu', label: 'Quick Menu' },
    ],
    [focusedSource, focused?.favorite],
  )

  const genres = (focused?.genres || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3)
  const edgePad = (TILE_W * SEL_SCALE - TILE_W) / 2 + 10

  if (libLoading && !games.length) {
    return (
      <div className="console-os" data-device={device}>
        <div className="cos-ambient" aria-hidden="true" />
        <div className="rc-center"><div className="rc-spinner" /></div>
      </div>
    )
  }

  if (!games.length) {
    return (
      <div className="console-os console-os--empty" data-device={device}>
        <div className="cos-ambient" aria-hidden="true" />
        <h2>Your library is empty</h2>
        <p>Add games on your PC and they will appear here, ready to stream.</p>
        <button className="cos-action cos-action--primary" onClick={onRefresh}>
          <RefreshCw size={18} /> <span>Refresh</span>
        </button>
      </div>
    )
  }

  return (
    <div className="console-os rc-shell" data-device={device}>
      <div className="cos-ambient" aria-hidden="true" />
      <div
        className={`cos-bg-blur ${activeBgLayer === 'a' ? 'is-active' : ''}`}
        style={{ backgroundImage: bgA.url ? `url(${bgA.url})` : 'none' }}
      />
      <div
        className={`cos-bg-blur ${activeBgLayer === 'b' ? 'is-active' : ''}`}
        style={{ backgroundImage: bgB.url ? `url(${bgB.url})` : 'none' }}
      />
      <div
        className={`cos-bg-hero ${activeBgLayer === 'a' ? 'is-active' : ''}`}
        style={{ backgroundImage: bgA.url ? `url(${bgA.url})` : 'none', backgroundPosition: bgA.position }}
      />
      <div
        className={`cos-bg-hero ${activeBgLayer === 'b' ? 'is-active' : ''}`}
        style={{ backgroundImage: bgB.url ? `url(${bgB.url})` : 'none', backgroundPosition: bgB.position }}
      />
      <div className="cos-bg-shade" aria-hidden="true" />

      <GlobalLayer onQuickMenu={() => setQuickMenu(true)} />

      <RemoteStatusBar
        user={user}
        hostName={onlineHosts[0]?.hostname || null}
        tab={tab}
        onTabChange={switchTab}
      />

      <main className="cos-content">
        <div className="cos-home">
          <div
            className="cos-home__strip"
            style={{ height: TILE_H * SEL_SCALE + 28 }}
            onWheel={onWheel}
          >
            {windowTiles.map(({ game, offset }) => {
              const isSelected = offset === 0
              const source = sourceMap.get(game.game_id)?.[0]
              const x = offset * (TILE_W + GAP) + Math.sign(offset) * edgePad
              const prev = prevOffsets.get(game.game_id)
              const teleported = prev !== undefined && Math.abs(prev - offset) > VISIBLE
              return (
                <button
                  key={game.game_id}
                  className={`cos-tile ${isSelected ? 'cos-tile--selected' : ''} ${isSelected && zone === 'tiles' ? 'cos-tile--focused' : ''} ${source ? '' : 'rc-tile--offline'}`}
                  style={{
                    width: TILE_W,
                    height: TILE_H,
                    transform: `translate(-50%, -50%) translateX(${x}px) scale(${isSelected ? SEL_SCALE : 1})`,
                    opacity: isSelected ? 1 : Math.max(0.35, 0.8 - Math.abs(offset) * 0.09),
                    zIndex: 100 - Math.abs(offset),
                    transition: teleported ? 'none' : undefined,
                  }}
                  onClick={() => {
                    if (isSelected) { playSfx('select'); onPlay(game, source || null) }
                    else { playSfx('nav'); setSelectedId(game.game_id); setZone('tiles') }
                  }}
                  aria-label={game.normalized_title || game.title}
                >
                  <ImageWithFallback
                    primary={game.cover_url}
                    fallback={game.hero_url}
                    alt={game.normalized_title || game.title}
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
            {tab === 'favorites' && n === 0 && (
              <div className="rc-fav-empty">
                <Heart size={26} />
                <p>No favorites yet</p>
                <span>
                  Press <b>X</b> on a game (or favorite it on your PC) and it will live here.
                </span>
              </div>
            )}
          </div>

          {focused && (
            <div className="cos-hero" key={focused.game_id}>
              <div className="cos-hero__identity">
                <h1 className="cos-hero__title">{focused.normalized_title || focused.title}</h1>
              </div>

              <p className="cos-hero__byline">
                {focusedSource ? (
                  <>
                    <span className="cos-hero__byline-accent">Ready to stream</span>
                    <span className="cos-hero__byline-sep"> from {focusedSource.hostname}</span>
                  </>
                ) : (
                  <span className="cos-hero__byline-sep">
                    {onlineHosts.length
                      ? 'Not installed on an online PC'
                      : 'Start Launch Deck on your PC to stream'}
                  </span>
                )}
              </p>

              {genres.length > 0 && (
                <div className="cos-hero__meta">
                  {genres.map((genre) => (
                    <span key={genre} className="cos-pill cos-pill--genre">{genre}</span>
                  ))}
                </div>
              )}

              {description && <p className="rc-desc">{description}</p>}

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
          )}
        </div>
      </main>

      {gamepadConnected && <HintBar hints={hints} />}

      {quickMenu && (
        <QuickMenu
          onClose={() => setQuickMenu(false)}
          onRefresh={onRefresh}
          onSignOut={onSignOut}
          userEmail={user?.email || ''}
          update={update}
          onInstallUpdate={onInstallUpdate}
        />
      )}

      {searchOpen && (
        <SearchOverlay
          games={games}
          sourceMap={sourceMap}
          onClose={() => setSearchOpen(false)}
          onSelect={(game) => {
            setSearchOpen(false)
            if (tab === 'favorites' && !game.favorite) setTab('home')
            setSelectedId(game.game_id)
            setZone('tiles')
          }}
        />
      )}

      {starting && <StartingOverlay starting={starting} onCancel={onCancel} />}

      {updating && (
        <div className="rc-update-pill">
          <span className="rc-update-pill__ring" />
          Downloading update… {updating.pct}%
        </div>
      )}

      {toast && <div className={`m-toast m-toast--${toast.kind}`}>{toast.message}</div>}
    </div>
  )
}

export default function RemoteConsole(props) {
  const [booting, setBooting] = useState(true)
  const [bootVisible, setBootVisible] = useState(false)

  useEffect(() => {
    initSounds()
    return () => disposeSounds()
  }, [])

  useEffect(() => {
    const sfx = new Audio(consoleModeTransitionSfx)
    sfx.play().catch(() => {})
    const showTimer = setTimeout(() => setBootVisible(true), 200)
    const hideTimer = setTimeout(() => setBooting(false), 2200)
    return () => { clearTimeout(showTimer); clearTimeout(hideTimer) }
  }, [])

  if (booting) {
    return (
      <div className="console-os cos-boot">
        <div className="cos-ambient" aria-hidden="true" />
        <div className="cos-boot__content" style={{ opacity: bootVisible ? 1 : 0 }}>
          <img src="/launch-deck-logo-alt.png" alt="" className="cos-boot__logo" />
          <h2 className="cos-boot__wordmark">Launch Deck</h2>
          <span className="cos-boot__mode">Remote</span>
          <div className="cos-boot__loader" />
        </div>
      </div>
    )
  }

  return (
    <InputProvider>
      <ConsoleHome {...props} />
    </InputProvider>
  )
}
