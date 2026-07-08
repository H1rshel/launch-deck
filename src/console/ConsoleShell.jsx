import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Power } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useGameContext } from '../context/GameContext'
import { getGameImages } from '../utils/imageHandler'
import GameLoadingScreen from '../components/games/GameLoadingScreen'
import SessionEndModal from '../components/games/SessionEndModal'
import AchievementsModal from '../components/games/AchievementsModal'
import ConsoleModeNowPlaying from '../components/games/ConsoleModeNowPlaying'
import consoleModeTransitionSfx from '../assets/sounds/console-mode-transition.mp3'
import { InputProvider, useConsoleInput, useInputLayer } from './input/InputProvider'
import { initSounds, disposeSounds, playSfx } from './audio/sounds'
import { useSteamGameData } from './lib/useSteamGameData'
import StatusBar from './components/StatusBar'
import HintBar from './components/HintBar'
import HomeScreen from './screens/HomeScreen'
import LibraryScreen from './screens/LibraryScreen'
import QuickMenu from './overlays/QuickMenu'
import GameActionSheet from './overlays/GameActionSheet'
import SearchOverlay from './overlays/SearchOverlay'
import '../styles/console-mode.css'

/**
 * TEMPORARY diagnostic overlay — measures how the fullscreen bottom gap
 * arises. Shows viewport vs. screen dimensions so we can compute the exact
 * shortfall and fix it precisely for every scaling factor. Remove after.
 */
function FullscreenDebug() {
  const [m, setM] = useState(null)
  useEffect(() => {
    let maxInner = 0
    const read = () => {
      maxInner = Math.max(maxInner, window.innerHeight)
      setM({
        inner: `${window.innerWidth}×${window.innerHeight}`,
        outer: `${window.outerWidth}×${window.outerHeight}`,
        screen: `${window.screen.width}×${window.screen.height}`,
        avail: `${window.screen.availWidth}×${window.screen.availHeight}`,
        dpr: window.devicePixelRatio,
        maxInner,
        gap: window.screen.height - window.innerHeight,
      })
    }
    read()
    const id = setInterval(read, 400)
    window.addEventListener('resize', read)
    return () => { clearInterval(id); window.removeEventListener('resize', read) }
  }, [])
  if (!m) return null
  const row = { display: 'flex', justifyContent: 'space-between', gap: 24 }
  return (
    <div style={{
      position: 'fixed', top: 90, left: 24, zIndex: 100000,
      background: 'rgba(0,0,0,0.85)', color: '#00e0ff', padding: '14px 18px',
      borderRadius: 10, border: '1px solid #00e0ff', font: '600 15px/1.6 monospace',
      minWidth: 320, pointerEvents: 'none', boxShadow: '0 0 24px rgba(0,224,255,0.4)',
    }}>
      <div style={{ color: '#fff', marginBottom: 6, fontSize: 13 }}>FULLSCREEN DEBUG</div>
      <div style={row}><span>innerHeight</span><span>{m.inner}</span></div>
      <div style={row}><span>outerHeight</span><span>{m.outer}</span></div>
      <div style={row}><span>screen</span><span>{m.screen}</span></div>
      <div style={row}><span>avail</span><span>{m.avail}</span></div>
      <div style={row}><span>devicePixelRatio</span><span>{m.dpr}</span></div>
      <div style={row}><span>max innerH seen</span><span>{m.maxInner}</span></div>
      <div style={{ ...row, color: m.gap === 0 ? '#3fbf6f' : '#ff5a5a' }}>
        <span>screen.h - innerH</span><span>{m.gap}px</span>
      </div>
    </div>
  )
}

/**
 * Console Mode — Launch Deck's controller-first, fullscreen OS.
 *
 * The shell owns the boot sequence, the ambient/hero background, the
 * screen switcher (Home / Library) and every overlay. Input flows through
 * the InputProvider layer stack: the base layer (global actions) sits at
 * the bottom, the active screen above it, overlays on top — so whatever
 * is visually topmost is also the thing receiving input.
 */

/** Registers the bottom-most input layer for global/system actions. */
function GlobalActionsLayer({ screen, onScreenChange, onBack, onQuickMenu, onSearch }) {
  useInputLayer((action) => {
    switch (action) {
      case 'menu':
        playSfx('open')
        onQuickMenu()
        return
      case 'lb':
      case 'rb':
        playSfx('nav')
        onScreenChange(screen === 'home' ? 'library' : 'home')
        return
      case 'back':
        onBack()
        return
      case 'actionY':
        playSfx('open')
        onSearch()
        return
      default:
        return false
    }
  })
  return null
}

/** Swallows all input while a blocking overlay (launch/install) is showing. */
function InputBlocker({ enabled }) {
  useInputLayer(() => undefined, enabled)
  return null
}

/**
 * Drives the app-global modals (launch confirm, remove-game feedback) with a
 * controller. Those modals live outside the console tree and already handle
 * real keyboard events themselves, so this layer only acts on gamepad input:
 * it resolves the launch confirm directly and re-dispatches synthetic key
 * events for the feedback modal's own keyboard navigation. While active it
 * captures everything so the screens underneath stay frozen.
 */
function ModalBridgeLayer({ pendingLaunchConfirm, pendingRemoveGame }) {
  const enabled = !!pendingLaunchConfirm || !!pendingRemoveGame
  useInputLayer((action, meta) => {
    if (meta?.source !== 'gamepad') return
    if (pendingLaunchConfirm) {
      if (action === 'accept') { playSfx('select'); pendingLaunchConfirm.resolve(true) }
      else if (action === 'back') { playSfx('back'); pendingLaunchConfirm.resolve(false) }
      return
    }
    const KEYMAP = { up: 'ArrowUp', down: 'ArrowDown', accept: 'Enter', back: 'Escape' }
    const key = KEYMAP[action]
    if (key) {
      playSfx(action === 'up' || action === 'down' ? 'nav' : 'select')
      window.dispatchEvent(new KeyboardEvent('keydown', { key }))
    }
  }, enabled)
  return null
}

/**
 * While attract mode is showing, the waking press must not also act on the
 * UI underneath. Activity notification happens before layer dispatch, so
 * this layer is still registered for the waking input and swallows it.
 */
function AttractWakeLayer({ enabled }) {
  useInputLayer(() => undefined, enabled)
  return null
}

/** Lets controller/keyboard users leave the empty-library state. */
function EmptyExitLayer({ onExit }) {
  useInputLayer((action) => {
    if (action === 'accept' || action === 'back') onExit()
  })
  return null
}

function AchievementsLayer({ data, onClose }) {
  useInputLayer((action) => {
    if (action === 'back' || action === 'accept') {
      playSfx('back')
      onClose()
    }
  })
  return <AchievementsModal data={data} loading={false} error={null} onClose={onClose} />
}

function SessionSummaryLayer({ summary, onClose, gamepadConnected }) {
  useInputLayer((action) => {
    if (action === 'accept' || action === 'back') {
      playSfx('select')
      onClose()
    }
  })
  return <SessionEndModal summary={summary} onClose={onClose} gamepadConnected={gamepadConnected} />
}

function ConsoleRoot({ isStartup }) {
  const navigate = useNavigate()
  const {
    games,
    playGame,
    installGame,
    launchingGame,
    installingGame,
    sessionSummary,
    clearSessionSummary,
    toggleFavorite,
    removeGame,
    activeGames,
    forceEndSession,
    pendingLaunchConfirm,
    pendingRemoveGame,
  } = useGameContext()
  const { gamepadConnected, device, subscribeActivity } = useConsoleInput()

  const [screen, setScreen] = useState('home')
  const [focusedId, setFocusedId] = useState(null)
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const [actionSheetId, setActionSheetId] = useState(null)
  const [showAchievements, setShowAchievements] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [jumpTo, setJumpTo] = useState(null) // { id, nonce } — focus request for Home
  const [attract, setAttract] = useState(false)
  const attractRef = useRef(false)
  useEffect(() => { attractRef.current = attract }, [attract])

  const focusedGame = useMemo(
    () => games.find((g) => g.id === focusedId) || null,
    [games, focusedId]
  )
  const actionSheetGame = useMemo(
    () => games.find((g) => g.id === actionSheetId) || null,
    [games, actionSheetId]
  )
  const { steamPlaytime, achData } = useSteamGameData(focusedGame)

  const activeSessionGame = useMemo(() => {
    if (activeGames.size === 0) return null
    const ids = Array.from(activeGames)
    return games.find((g) => g.id === ids[ids.length - 1]) || null
  }, [activeGames, games])

  // ── Window / navigation ──
  const exitConsoleMode = useCallback(async (to = '/dashboard') => {
    try {
      await invoke('set_console_fullscreen', { enabled: false })
    } catch (e) {
      console.warn('Failed to exit fullscreen:', e)
    }
    navigate(to)
  }, [navigate])

  const quitApp = useCallback(async () => {
    try {
      const { exit } = await import('@tauri-apps/plugin-process')
      await exit(0)
    } catch (e) {
      console.warn('Failed to quit app:', e)
      exitConsoleMode()
    }
  }, [exitConsoleMode])

  useEffect(() => {
    // Leave any lingering DOM fullscreen — window fullscreen is authoritative,
    // and stacking both causes WebView2 edge artifacts.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})

    let entered = false
    try {
      // On startup, App.jsx sets fullscreen (with overscan) after closing the
      // native splashscreen; otherwise enter it now.
      if (!isStartup) {
        invoke('set_console_fullscreen', { enabled: true }).catch(() => {})
        entered = true
      }
    } catch (err) {
      console.warn('Tauri window API not available', err)
    }
    return () => { if (entered) invoke('set_console_fullscreen', { enabled: false }).catch(() => {}) }
  }, [isStartup])

  // ── Game actions ──
  const handlePrimary = useCallback(
    (game) => {
      if (!game) return
      if (game.installed) playGame(game).catch(console.error)
      else installGame(game).catch(console.error)
    },
    [playGame, installGame]
  )

  const endSession = useCallback(() => {
    if (activeGames.size === 0) return
    const ids = Array.from(activeGames)
    forceEndSession(ids[ids.length - 1])
  }, [activeGames, forceEndSession])

  const viewDetails = useCallback(
    (game) => { exitConsoleMode(`/game/${game.id}`) },
    [exitConsoleMode]
  )

  const handleBack = useCallback(() => {
    if (screen === 'library') {
      playSfx('back')
      setScreen('home')
    } else {
      exitConsoleMode()
    }
  }, [screen, exitConsoleMode])

  // ── Background crossfade (two stacked layers) ──
  const [bgA, setBgA] = useState({ url: null, position: 'right top' })
  const [bgB, setBgB] = useState({ url: null, position: 'right top' })
  const [activeBgLayer, setActiveBgLayer] = useState('a')
  const activeBgRef = useRef('a')

  useEffect(() => {
    if (!focusedGame) return
    const imgs = getGameImages(focusedGame)
    const url = imgs.hero || imgs.cover || null
    const position = focusedGame.hero_position || 'right top'
    const next = activeBgRef.current === 'a' ? 'b' : 'a'
    if (next === 'b') setBgB({ url, position })
    else setBgA({ url, position })
    activeBgRef.current = next
    setActiveBgLayer(next)
  }, [focusedGame?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attract mode: fade the UI away after ~60s idle, wake on any input ──
  const overlaysOpen =
    quickMenuOpen ||
    !!actionSheetId ||
    showAchievements ||
    searchOpen ||
    !!sessionSummary ||
    !!launchingGame ||
    !!installingGame ||
    !!pendingLaunchConfirm ||
    !!pendingRemoveGame

  useEffect(() => {
    if (overlaysOpen) {
      setAttract(false)
      return undefined
    }
    let timer = setTimeout(() => setAttract(true), 60000)
    const onActivity = () => {
      if (attractRef.current) setAttract(false)
      clearTimeout(timer)
      timer = setTimeout(() => setAttract(true), 60000)
    }
    const unsubscribe = subscribeActivity(onActivity)
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [overlaysOpen, subscribeActivity])

  // ── Hints ──
  const hints = useMemo(() => {
    if (screen === 'home') {
      return [
        { action: 'dirH', label: 'Browse' },
        { action: 'accept', label: 'Play' },
        { action: 'actionX', label: 'Favorite' },
        { action: 'actionY', label: 'Search' },
        { action: 'menu', label: 'Quick Menu' },
        { action: 'back', label: 'Desktop' },
      ]
    }
    return [
      { action: 'dir', label: 'Navigate' },
      { action: 'accept', label: 'Options' },
      { action: 'actionX', label: 'Favorite' },
      { action: 'actionY', label: 'Search' },
      { action: 'menu', label: 'Quick Menu' },
      { action: 'back', label: 'Home' },
    ]
  }, [screen])

  // ── Empty library ──
  if (!games.length) {
    return (
      <div className="console-os console-os--empty" data-device={device}>
        <EmptyExitLayer onExit={exitConsoleMode} />
        <div className="cos-ambient" aria-hidden="true" />
        <h2>Your library is empty</h2>
        <p>Add games in Desktop Mode, then come back.</p>
        <button className="cos-action cos-action--primary" onClick={() => exitConsoleMode()}>
          <Power size={20} /> <span>Desktop Mode</span>
        </button>
      </div>
    )
  }

  const blocked = !!launchingGame || !!installingGame

  return (
    <div
      className={`console-os ${activeGames.size > 0 ? 'console-os--session' : ''} ${attract ? 'console-os--attract' : ''}`}
      data-device={device}
    >
      <FullscreenDebug />

      {/* Background stack: ambient glow + blurred fill + hero art */}
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

      {/* Base input layer — must mount before the screens */}
      <GlobalActionsLayer
        screen={screen}
        onScreenChange={setScreen}
        onBack={handleBack}
        onQuickMenu={() => setQuickMenuOpen(true)}
        onSearch={() => setSearchOpen(true)}
      />

      <StatusBar screen={screen} onScreenChange={(s) => { if (s !== screen) { playSfx('nav'); setScreen(s) } }} />

      <main className="cos-content" key={screen}>
        {screen === 'home' ? (
          <HomeScreen
            games={games}
            steamPlaytime={steamPlaytime}
            achData={achData}
            jumpTo={jumpTo}
            onFocusGame={(g) => setFocusedId(g?.id ?? null)}
            onPrimary={handlePrimary}
            onOpenActions={(g) => { playSfx('open'); setActionSheetId(g.id) }}
            onShowAchievements={() => setShowAchievements(true)}
            toggleFavorite={toggleFavorite}
          />
        ) : (
          <LibraryScreen
            games={games}
            onFocusGame={(g) => setFocusedId(g?.id ?? null)}
            onOpenActions={(g) => { playSfx('open'); setActionSheetId(g.id) }}
            toggleFavorite={toggleFavorite}
          />
        )}
      </main>

      <HintBar hints={hints} />

      {actionSheetGame && (
        <GameActionSheet
          game={actionSheetGame}
          achData={actionSheetGame.id === focusedGame?.id ? achData : null}
          onClose={() => setActionSheetId(null)}
          onPrimary={handlePrimary}
          toggleFavorite={toggleFavorite}
          onShowAchievements={() => setShowAchievements(true)}
          onViewDetails={viewDetails}
          onRemove={removeGame}
        />
      )}

      {searchOpen && (
        <SearchOverlay
          games={games}
          onClose={() => setSearchOpen(false)}
          onSelect={(game) => {
            setSearchOpen(false)
            setScreen('home')
            setJumpTo({ id: game.id, nonce: Date.now() })
          }}
        />
      )}

      {quickMenuOpen && (
        <QuickMenu
          onClose={() => setQuickMenuOpen(false)}
          onExitToDesktop={() => exitConsoleMode()}
          onQuitApp={quitApp}
          activeGame={activeSessionGame}
          onEndSession={endSession}
        />
      )}

      {showAchievements && achData && (
        <AchievementsLayer data={achData} onClose={() => setShowAchievements(false)} />
      )}

      {sessionSummary && (
        <SessionSummaryLayer
          summary={sessionSummary}
          onClose={clearSessionSummary}
          gamepadConnected={gamepadConnected}
        />
      )}

      <InputBlocker enabled={blocked} />
      <ModalBridgeLayer
        pendingLaunchConfirm={pendingLaunchConfirm}
        pendingRemoveGame={pendingRemoveGame}
      />
      <AttractWakeLayer enabled={attract} />

      {launchingGame && <GameLoadingScreen game={launchingGame} />}
      {installingGame && (
        <GameLoadingScreen
          game={installingGame.game}
          mode="install"
          statusText={`Opening ${installingGame.launcher}`}
          subtitle={`Preparing the installation flow in ${installingGame.launcher}.`}
        />
      )}

      {activeGames.size > 0 && <ConsoleModeNowPlaying />}
    </div>
  )
}

export default function ConsoleShell() {
  const [isStartup] = useState(() => {
    const flag = sessionStorage.getItem('console_startup') === '1'
    sessionStorage.removeItem('console_startup')
    return flag
  })

  const [booting, setBooting] = useState(() => !isStartup)
  const [bootVisible, setBootVisible] = useState(false)
  const sfxTransition = useRef(null)

  useEffect(() => {
    initSounds()
    return () => disposeSounds()
  }, [])

  useEffect(() => {
    if (isStartup) return undefined
    sfxTransition.current = new Audio(consoleModeTransitionSfx)
    sfxTransition.current.play().catch(() => {})
    const showTimer = setTimeout(() => setBootVisible(true), 200)
    const hideTimer = setTimeout(() => setBooting(false), 2200)
    return () => { clearTimeout(showTimer); clearTimeout(hideTimer) }
  }, [isStartup])

  if (booting) {
    return (
      <div className="console-os cos-boot">
        <div className="cos-ambient" aria-hidden="true" />
        <div className="cos-boot__content" style={{ opacity: bootVisible ? 1 : 0 }}>
          <img src="/launch-deck-logo-alt.png" alt="" className="cos-boot__logo" />
          <h2 className="cos-boot__wordmark">Launch Deck</h2>
          <span className="cos-boot__mode">Console Mode</span>
          <div className="cos-boot__loader" />
        </div>
      </div>
    )
  }

  return (
    <InputProvider>
      <ConsoleRoot isStartup={isStartup} />
    </InputProvider>
  )
}
