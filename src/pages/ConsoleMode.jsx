import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGameContext } from '../context/GameContext'
import { Play, Power, Star, Clock, MonitorPlay, Heart, History, Library, Gamepad2, ChevronLeft, ChevronRight, Trophy, Calendar, X, Trash2 } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { getGameImages } from '../utils/imageHandler'
import { ImageWithFallback, GameLogo } from '../components/ui/GameImages'
import GameLoadingScreen from '../components/games/GameLoadingScreen'
import SessionEndModal from '../components/games/SessionEndModal'
import AchievementsModal from '../components/games/AchievementsModal'
import ConsoleModeNowPlaying from '../components/games/ConsoleModeNowPlaying'
import consoleModeTransitionSfx from '../assets/sounds/console-mode-transition.mp3'
import gameNavSfx from '../assets/sounds/game-nav.wav'
import selectionSfx from '../assets/sounds/selection.wav'
import '../styles/console-mode.css'

const VIEWS = ['all', 'favorites', 'recent']

function formatMinutes(minutes) {
  if (!minutes || minutes < 1) return '0m'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function relativeTime(dateString) {
  if (!dateString) return null
  const d = new Date(dateString)
  if (isNaN(d.getTime())) return null
  const diffMs = Date.now() - d.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  if (diffSecs < 60) return 'Just now'
  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 30) return `${diffDays} days ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths === 1) return '1 month ago'
  if (diffMonths < 12) return `${diffMonths} months ago`
  const diffYears = Math.floor(diffMonths / 12)
  return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`
}

function generateSearchVariants(displayTitle, originalTitle) {
  let names = [];
  if (displayTitle) names.push(displayTitle);
  if (originalTitle && originalTitle !== displayTitle) names.push(originalTitle);

  let variants = [];
  for (const name of names) {
    if (!name) continue;
    variants.push(name);
    if (name.includes(':')) variants.push(name.split(':')[0].trim());
    if (name.match(/\(\d{4}\)/)) variants.push(name.replace(/\(\d{4}\)/g, '').trim());
    if (name.includes(' - ')) variants.push(name.split(' - ')[0].trim());
    if (name.match(/\s+\d+:\s+(.*)/)) {
      variants.push(name.replace(/\s+\d+:\s+/, ' ').trim());
    }
  }
  return [...new Set(variants)].filter(Boolean);
}

function getDisplayPlaytimeMinutes(game, steamPlaytime) {
  const localMinutes = game?.playtime_minutes || 0
  const importedMinutes =
    steamPlaytime && typeof steamPlaytime.steamPlaytime === 'number'
      ? steamPlaytime.steamPlaytime
      : game?.imported_playtime_minutes || 0
  return localMinutes + importedMinutes
}

export default function ConsoleMode() {
  const navigate = useNavigate()
  const {
    games,
    playGame,
    launchingGame,
    installingGame,
    sessionSummary,
    clearSessionSummary,
    toggleFavorite,
    removeGame,
    activeGames,
    forceEndSession,
  } = useGameContext()
  const [isStartup] = useState(() => {
    const flag = sessionStorage.getItem('console_startup') === '1'
    sessionStorage.removeItem('console_startup')
    return flag
  })

  const [activeView, setActiveView] = useState('all')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isSplashing, setIsSplashing] = useState(() => !isStartup)
  const [splashVisible, setSplashVisible] = useState(false)
  const [gamepadConnected, setGamepadConnected] = useState(false)
  
  const [steamPlaytime, setSteamPlaytime] = useState(null)
  const [achData, setAchData] = useState(null)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const contextMenuOpenRef = useRef(contextMenuOpen)
  useEffect(() => { contextMenuOpenRef.current = contextMenuOpen }, [contextMenuOpen])
  
  const [contextMenuIndex, setContextMenuIndex] = useState(0)
  const contextMenuIndexRef = useRef(contextMenuIndex)
  useEffect(() => { contextMenuIndexRef.current = contextMenuIndex }, [contextMenuIndex])
  
  const [showAchievementsModal, setShowAchievementsModal] = useState(false)
  const showAchievementsModalRef = useRef(showAchievementsModal)
  useEffect(() => { showAchievementsModalRef.current = showAchievementsModal }, [showAchievementsModal])
  
  const steamId = localStorage.getItem('steamId') || ''
  
  const carouselRef = useRef(null)
  const gamepadRef = useRef({ prevButtons: [] })
  const activeBgRef = useRef('a')
  const viewGamesRef = useRef([])
  const activeGameRef = useRef(null)

  // Transition: plain Audio element (plays once on mount, no latency concern)
  const sfxTransition = useRef(new Audio(consoleModeTransitionSfx))

  // Nav/Selection: Web Audio API — decoded once, fired instantly with zero latency
  const audioCtxRef = useRef(null)
  const bufNav = useRef(null)
  const bufSelection = useRef(null)

  useEffect(() => {
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    const load = (url, ref) =>
      fetch(url).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab)).then(buf => { ref.current = buf }).catch(() => {})
    load(gameNavSfx, bufNav)
    load(selectionSfx, bufSelection)
    return () => ctx.close()
  }, [])

  const playSound = useCallback((bufRef) => {
    const ctx = audioCtxRef.current
    const buf = bufRef.current
    if (!ctx || !buf) return
    if (ctx.state === 'suspended') ctx.resume()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(0)
  }, [])

  // Two-layer crossfade backgrounds
  const [bgA, setBgA] = useState({ url: null, position: 'right top' })
  const [bgB, setBgB] = useState({ url: null, position: 'right top' })
  const [activeBg, setActiveBg] = useState('a')

  // Filtered/sorted game lists per view
  const viewGames = useMemo(() => {
    const byTitle = arr =>
      [...arr].sort((a, b) =>
        (a.displayTitle || a.title || '').localeCompare(b.displayTitle || b.title || ''))
    switch (activeView) {
      case 'favorites':
        return byTitle(games.filter(g => g.favorite))
      case 'recent':
        return [...games]
          .filter(g => g.last_played)
          .sort((a, b) => new Date(b.last_played) - new Date(a.last_played))
          .slice(0, 20)
      default:
        return byTitle(games)
    }
  }, [games, activeView])

  const activeGame = viewGames[selectedIndex]

  // Keep refs in sync
  useEffect(() => { viewGamesRef.current = viewGames }, [viewGames])
  useEffect(() => { activeGameRef.current = activeGame }, [activeGame])
  
  const contextOptions = useMemo(() => {
    if (!activeGame) return []
    const opts = []
    if (achData?.progress) {
      opts.push({ id: 'achievements', label: 'View Achievements', icon: <Trophy size={20} /> })
    }
    opts.push({ 
      id: 'favorite', 
      label: activeGame.favorite ? 'Remove from Favorites' : 'Add to Favorites', 
      icon: activeGame.favorite ? <X size={20} /> : <Heart size={20} /> 
    })
    opts.push({ id: 'remove', label: 'Remove Game', icon: <Trash2 size={20} /> })
    return opts
  }, [activeGame, achData])

  const contextOptionsRef = useRef(contextOptions)
  useEffect(() => { contextOptionsRef.current = contextOptions }, [contextOptions])

  // Reset index on view change
  useEffect(() => { setSelectedIndex(0) }, [activeView])

  // Crossfade background when active game changes
  useEffect(() => {
    if (!activeGame) return
    const imgs = getGameImages(activeGame)
    const newUrl = imgs.hero || imgs.cover || null
    const newPos = activeGame.hero_position || 'right top'
    const next = activeBgRef.current === 'a' ? 'b' : 'a'
    if (next === 'b') setBgB({ url: newUrl, position: newPos })
    else setBgA({ url: newUrl, position: newPos })
    activeBgRef.current = next
    setActiveBg(next)
  }, [activeGame?.id])

  // Fetch Steam Data for active game
  useEffect(() => {
    const game = activeGameRef.current
    if (!game || !steamId || !game.steam_app_id) {
      setSteamPlaytime(null)
      setAchData(null)
      return
    }

    let cancelled = false
    setSteamPlaytime(null)
    setAchData(null)

    const fetchSteamData = async () => {
      const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
      if (!isTauri) return

      const variants = generateSearchVariants(game.displayTitle, game.title)

      // Playtime
      for (const variant of variants) {
        if (cancelled) break
        try {
          const data = await invoke('get_steam_playtime', { query: variant, steamId })
          if (data && !cancelled) {
            setSteamPlaytime(data)
            break
          }
        } catch (err) {}
      }

      // Achievements
      for (const variant of variants) {
        if (cancelled) break
        try {
          const data = await invoke('get_steam_achievements', { query: variant, steamId })
          if (data && !cancelled) {
            setAchData(data)
            break
          }
        } catch (err) {}
      }
    }

    fetchSteamData()
    return () => { cancelled = true }
  }, [activeGame?.id, steamId])

  const exitConsoleMode = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow()
      await appWindow.setFullscreen(false)
      await appWindow.maximize()
    } catch (e) {
      console.warn('Failed to exit fullscreen:', e)
    }
    navigate('/dashboard')
  }, [navigate])

  const handleKeyDown = useCallback((e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault()
    
    if (showAchievementsModalRef.current) return

    if (e.key === 'Escape') {
      if (contextMenuOpenRef.current) {
        playSound(bufSelection)
        setContextMenuOpen(false)
      } else {
        exitConsoleMode()
      }
    }
    else if (contextMenuOpenRef.current) {
      if (e.key === 'ArrowUp') {
        playSound(bufNav)
        setContextMenuIndex(i => Math.max(i - 1, 0))
      }
      else if (e.key === 'ArrowDown') {
        playSound(bufNav)
        setContextMenuIndex(i => Math.min(i + 1, contextOptionsRef.current.length - 1))
      }
      else if (e.key === 'Enter' || e.key === ' ') {
        playSound(bufSelection)
        const opt = contextOptionsRef.current[contextMenuIndexRef.current]
        if (opt?.id === 'favorite') { toggleFavorite(activeGameRef.current?.id) }
        else if (opt?.id === 'remove') { removeGame(activeGameRef.current?.id) }
        else if (opt?.id === 'achievements') { setShowAchievementsModal(true) }
        setContextMenuOpen(false)
      }
    }
    else if (e.key === 'c' || e.key === 'C' || e.key === 'm' || e.key === 'M') {
      playSound(bufNav)
      setContextMenuIndex(0)
      setContextMenuOpen(true)
    }
    else if (e.key === 'ArrowRight') { playSound(bufNav); setSelectedIndex(i => Math.min(i + 1, viewGamesRef.current.length - 1)) }
    else if (e.key === 'ArrowLeft') { playSound(bufNav); setSelectedIndex(i => Math.max(i - 1, 0)) }
    else if ((e.key === 'q' || e.key === 'Q') && activeGames.size > 0) {
      playSound(bufSelection)
      const activeIds = Array.from(activeGames)
      forceEndSession(activeIds[activeIds.length - 1])
    }
    else if (e.key === 'Enter' && activeGameRef.current?.installed) { playSound(bufSelection); playGame(activeGameRef.current).catch(console.error) }
  }, [exitConsoleMode, playGame, playSound, toggleFavorite, removeGame, activeGames, forceEndSession])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => {
    if (carouselRef.current && viewGames.length > 0) {
      const card = carouselRef.current.children[selectedIndex]
      if (card) card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }
  }, [selectedIndex, viewGames.length])

  useEffect(() => {
    let appWindow
    try {
      appWindow = getCurrentWindow()
      // On startup, App.jsx sets fullscreen after closing the splashscreen
      if (!isStartup) appWindow.setFullscreen(true).catch(() => {})
    } catch (err) {
      console.warn('Tauri window API not available', err)
    }
    return () => { if (appWindow) appWindow.setFullscreen(false).catch(() => {}) }
  }, [isStartup])

  useEffect(() => {
    if (isStartup) return
    sfxTransition.current.play().catch(() => {})
    const showTimer = setTimeout(() => setSplashVisible(true), 200)
    const hideTimer = setTimeout(() => setIsSplashing(false), 2200)
    return () => { clearTimeout(showTimer); clearTimeout(hideTimer) }
  }, [isStartup])

  // Gamepad polling via rAF
  useEffect(() => {
    if (isSplashing) return
    let rafId
    let lastNavTime = 0
    const NAV_DELAY = 180
    let wasConnected = false

    function poll() {
      const pad = Array.from(navigator.getGamepads?.() ?? []).find(p => p?.connected)
      const prev = gamepadRef.current.prevButtons

      if (pad) {
        if (!wasConnected) { setGamepadConnected(true); wasConnected = true }
        const now = performance.now()
        const hit = idx => pad.buttons[idx]?.pressed && !prev[idx]

        if (sessionSummary) {
          if (hit(0)) {
            playSound(bufSelection)
            clearSessionSummary()
          }
          gamepadRef.current.prevButtons = pad.buttons.map(b => b.pressed)
          rafId = requestAnimationFrame(poll)
          return
        }

        if (showAchievementsModalRef.current) {
          if (hit(1)) {
            playSound(bufSelection)
            setShowAchievementsModal(false)
          }
          gamepadRef.current.prevButtons = pad.buttons.map(b => b.pressed)
          rafId = requestAnimationFrame(poll)
          return
        }

        // Menu handling overlay
        if (contextMenuOpenRef.current) {
          if (hit(0)) {
            playSound(bufSelection)
            const opt = contextOptionsRef.current[contextMenuIndexRef.current]
            if (opt?.id === 'favorite') { toggleFavorite(activeGameRef.current?.id) }
            else if (opt?.id === 'remove') { removeGame(activeGameRef.current?.id) }
            else if (opt?.id === 'achievements') { setShowAchievementsModal(true) }
            setContextMenuOpen(false)
          }
          if (hit(1)) {
            playSound(bufSelection)
            setContextMenuOpen(false)
          }
          const uphit = hit(12) || (pad.axes[1] ?? 0) < -0.5
          const downhit = hit(13) || (pad.axes[1] ?? 0) > 0.5
          
          if (!uphit && !downhit) {
            lastNavTime = 0
          } else if (now - lastNavTime > NAV_DELAY) {
            playSound(bufNav)
            if (uphit) setContextMenuIndex(i => Math.max(i - 1, 0))
            else setContextMenuIndex(i => Math.min(i + 1, contextOptionsRef.current.length - 1))
            lastNavTime = now
          }

          gamepadRef.current.prevButtons = pad.buttons.map(b => b.pressed)
          rafId = requestAnimationFrame(poll)
          return
        }

        // A = play, B = exit, Y = force end session
        if (hit(0) && activeGameRef.current?.installed) { playSound(bufSelection); playGame(activeGameRef.current).catch(console.error) }
        if (hit(1)) exitConsoleMode()
        if (hit(3) && activeGames.size > 0) {
          playSound(bufSelection)
          const activeIds = Array.from(activeGames)
          forceEndSession(activeIds[activeIds.length - 1])
        }

        // Menu buttons
        if (hit(8) || hit(9)) {
          playSound(bufNav)
          setContextMenuOpen(true)
        }

        // LB (4) / RB (5) = switch views
        if (hit(4)) { playSound(bufNav); setActiveView(v => VIEWS[(VIEWS.indexOf(v) - 1 + VIEWS.length) % VIEWS.length]) }
        if (hit(5)) { playSound(bufNav); setActiveView(v => VIEWS[(VIEWS.indexOf(v) + 1) % VIEWS.length]) }

        // D-Pad (14/15) or left stick axis 0
        const goLeft = pad.buttons[14]?.pressed || (pad.axes[0] ?? 0) < -0.5
        const goRight = pad.buttons[15]?.pressed || (pad.axes[0] ?? 0) > 0.5
        if (!goLeft && !goRight) {
          lastNavTime = 0
        } else if (now - lastNavTime > NAV_DELAY) {
          playSound(bufNav)
          if (goLeft) setSelectedIndex(i => Math.max(i - 1, 0))
          else setSelectedIndex(i => Math.min(i + 1, viewGamesRef.current.length - 1))
          lastNavTime = now
        }

        gamepadRef.current.prevButtons = pad.buttons.map(b => b.pressed)
      } else if (wasConnected) {
        setGamepadConnected(false)
        wasConnected = false
        gamepadRef.current.prevButtons = []
      }

      rafId = requestAnimationFrame(poll)
    }

    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [isSplashing, exitConsoleMode, playGame, playSound, activeGames, forceEndSession, sessionSummary, clearSessionSummary])

  if (isSplashing) {
    return (
      <div className="console-mode console-mode__splash">
        <div className="console-mode__splash-content" style={{ opacity: splashVisible ? 1 : 0, transition: 'opacity 0.35s ease' }}>
          <MonitorPlay size={72} className="console-mode__splash-icon" strokeWidth={1.5} />
          <h2 className="console-mode__splash-text">LAUNCH DECK CONSOLE</h2>
          <div className="console-mode__splash-loader" />
        </div>
      </div>
    )
  }

  if (!games.length) {
    return (
      <div className="console-mode console-mode--empty">
        <h2>No games in your library.</h2>
        <button onClick={exitConsoleMode} className="console-mode__exit-btn">
          <Power size={24} /> Exit Console
        </button>
      </div>
    )
  }

  return (
    <div className="console-mode">
      {/* Crossfade background layers */}
      <div className={`console-mode__bg-blur ${activeBg === 'a' ? 'is-active' : ''}`}
           style={{ backgroundImage: bgA.url ? `url(${bgA.url})` : 'none' }} />
      <div className={`console-mode__bg-blur ${activeBg === 'b' ? 'is-active' : ''}`}
           style={{ backgroundImage: bgB.url ? `url(${bgB.url})` : 'none' }} />
      <div className={`console-mode__hero-bg ${activeBg === 'a' ? 'is-active' : ''}`}
           style={{ backgroundImage: bgA.url ? `url(${bgA.url})` : 'none', backgroundPosition: bgA.position }} />
      <div className={`console-mode__hero-bg ${activeBg === 'b' ? 'is-active' : ''}`}
           style={{ backgroundImage: bgB.url ? `url(${bgB.url})` : 'none', backgroundPosition: bgB.position }} />
      <div className="console-mode__bg-overlay" />

      {/* Top bar */}
      <div className="console-mode__topbar">
        <div className="console-mode__brand">
          <MonitorPlay size={28} className="console-mode__brand-icon" />
          <span>Launch Deck</span>
          {gamepadConnected && <Gamepad2 size={18} className="console-mode__gamepad-dot" />}
        </div>

        <div className="console-mode__tabs">
          <div className="console-mode__bumper">
            <ChevronLeft size={11} /><span>LB</span>
          </div>
          <div className="console-mode__tab-strip">
            <button
              className={`console-mode__tab ${activeView === 'all' ? 'console-mode__tab--active' : ''}`}
              onClick={() => { playSound(bufNav); setActiveView('all') }}
            >
              <Library size={15} /><span>All Games</span>
            </button>
            <button
              className={`console-mode__tab ${activeView === 'favorites' ? 'console-mode__tab--active' : ''}`}
              onClick={() => { playSound(bufNav); setActiveView('favorites') }}
            >
              <Heart size={15} /><span>Favorites</span>
            </button>
            <button
              className={`console-mode__tab ${activeView === 'recent' ? 'console-mode__tab--active' : ''}`}
              onClick={() => { playSound(bufNav); setActiveView('recent') }}
            >
              <History size={15} /><span>Recent</span>
            </button>
          </div>
          <div className="console-mode__bumper">
            <span>RB</span><ChevronRight size={11} />
          </div>
        </div>

        <button className="console-mode__exit-btn" onClick={exitConsoleMode} title="Exit (ESC)">
          <Power size={20} /><span>Exit</span>
        </button>
      </div>

      {/* Hero content */}
      <div className="console-mode__content">
        {viewGames.length === 0 ? (
          <div className="console-mode__empty-view">
            <p>
              {activeView === 'favorites'
                ? 'No favorites yet — star a game to add it here.'
                : 'No recently played games yet.'}
            </p>
          </div>
        ) : activeGame ? (
          <div className="console-mode__hero" key={activeGame.id}>
            <GameLogo game={activeGame} className="console-mode__game-logo" />
            {!getGameImages(activeGame).logo && (
              <h1 className="console-mode__title">{activeGame.displayTitle}</h1>
            )}
            <div className="console-mode__metadata">
              {(getDisplayPlaytimeMinutes(activeGame, steamPlaytime) > 0 || activeGame.playtime) && (
                <span className="console-mode__tag">
                  <Clock size={16} />
                  {formatMinutes(getDisplayPlaytimeMinutes(activeGame, steamPlaytime)) !== '0m' 
                    ? formatMinutes(getDisplayPlaytimeMinutes(activeGame, steamPlaytime))
                    : activeGame.playtime}
                </span>
              )}
              {activeGame.last_played && (
                <span className="console-mode__tag">
                  <Calendar size={16} />
                  Played {relativeTime(activeGame.last_played)?.toUpperCase()}
                </span>
              )}
              {achData?.progress && (
                <span className="console-mode__tag">
                  <Trophy size={16} />
                  {achData.progress.unlocked} / {achData.progress.total}
                </span>
              )}
              {activeGame.rating > 0 && (
                <span className="console-mode__tag console-mode__tag--rating">
                  <Star size={16} fill="var(--accent-amber)" stroke="none" />
                  {activeGame.rating.toFixed(1)}
                </span>
              )}
              {activeGame.platform && (
                <span className="console-mode__tag">{activeGame.platform}</span>
              )}
            </div>
            {activeGame.installed ? (
              <button className="console-mode__play-btn" onClick={() => { playSound(bufSelection); playGame(activeGame).catch(console.error) }}>
                <Play size={28} fill="currentColor" /><span>Play Now</span>
              </button>
            ) : (
              <button className="console-mode__play-btn console-mode__play-btn--disabled">
                <Play size={28} /><span>Not Installed</span>
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* Coverflow Carousel */}
      <div className="console-mode__carousel-container">
        {viewGames.length > 0 && (
          <div className="console-mode__carousel" ref={carouselRef}>
            {viewGames.map((game, i) => {
              const isActive = i === selectedIndex
              const dist = i - selectedIndex
              const rotY = Math.max(-40, Math.min(40, dist * 14))
              const scale = isActive ? 1.15 : Math.max(0.7, 0.9 - Math.abs(dist) * 0.05)
              const opacity = isActive ? 1 : Math.max(0.3, 0.7 - Math.abs(dist) * 0.1)
              const images = getGameImages(game)
              return (
                <div
                  key={game.id}
                  className={`console-mode__card ${isActive ? 'console-mode__card--active' : ''}`}
                  style={{ transform: `perspective(1200px) rotateY(${rotY}deg) scale(${scale})`, opacity }}
                  onClick={() => setSelectedIndex(i)}
                >
                  <ImageWithFallback
                    primary={images.cover}
                    fallback={images.hero}
                    alt={game.displayTitle}
                    className="console-mode__card-img"
                  />
                  <div className="console-mode__card-glow" />
                </div>
              )
            })}
          </div>
        )}
        {gamepadConnected && (
          <div className="console-mode__controller-hints">
            <span className="console-mode__hint"><kbd>◀▶</kbd> Browse</span>
            <span className="console-mode__hint"><kbd>A</kbd> Play</span>
            <span className="console-mode__hint"><kbd>B</kbd> Exit</span>
            {activeGames.size > 0 && <span className="console-mode__hint"><kbd>Y</kbd> Stop</span>}
            <span className="console-mode__hint"><kbd>≡</kbd> Options</span>
            <span className="console-mode__hint"><kbd>LB</kbd><kbd>RB</kbd> Switch View</span>
          </div>
        )}
      </div>

      {contextMenuOpen && activeGame && (
        <div className="console-mode__context-overlay" onClick={() => setContextMenuOpen(false)}>
          <div className="console-mode__context-menu" onClick={e => e.stopPropagation()}>
            <GameLogo game={activeGame} className="console-mode__context-logo" />
            {!getGameImages(activeGame).logo && (
              <h3 className="console-mode__context-title">{activeGame.displayTitle}</h3>
            )}
            <div className="console-mode__context-options">
              {contextOptions.map((opt, i) => (
                <button
                  key={opt.id}
                  className={`console-mode__context-btn ${i === contextMenuIndex ? 'console-mode__context-btn--focused' : ''}`}
                  onClick={() => {
                    playSound(bufSelection)
                    if (opt.id === 'favorite') toggleFavorite(activeGame.id)
                    else if (opt.id === 'remove') removeGame(activeGame.id)
                    else if (opt.id === 'achievements') setShowAchievementsModal(true)
                    setContextMenuOpen(false)
                  }}
                  onMouseEnter={() => { playSound(bufNav); setContextMenuIndex(i) }}
                >
                  {opt.icon}
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
            {gamepadConnected ? (
              <div className="console-mode__context-hints">
                <span className="console-mode__hint"><kbd>A</kbd> Select</span>
                <span className="console-mode__hint"><kbd>B</kbd> Close</span>
              </div>
            ) : (
              <div className="console-mode__context-hints">
                <span className="console-mode__hint"><kbd>Enter</kbd> Select</span>
                <span className="console-mode__hint"><kbd>Esc</kbd> Close</span>
              </div>
            )}
          </div>
        </div>
      )}

      {showAchievementsModal && achData && (
        <AchievementsModal
          data={achData}
          loading={false}
          error={null}
          onClose={() => setShowAchievementsModal(false)}
        />
      )}

      {launchingGame && <GameLoadingScreen game={launchingGame} />}
      {installingGame && (
        <GameLoadingScreen
          game={installingGame.game}
          mode="install"
          statusText={`Opening ${installingGame.launcher}`}
          subtitle={`Preparing the installation flow in ${installingGame.launcher}.`}
        />
      )}
      {sessionSummary && (
        <SessionEndModal summary={sessionSummary} onClose={clearSessionSummary} gamepadConnected={gamepadConnected} />
      )}
      {activeGames.size > 0 && <ConsoleModeNowPlaying gamepadConnected={gamepadConnected} />}
    </div>
  )
}
