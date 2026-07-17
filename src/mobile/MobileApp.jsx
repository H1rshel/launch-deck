import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth, _authBridge } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getDeviceId, getUserDevices, isDeviceOnline, getStreamSourceMap } from '../lib/devices'
import { sendCommand } from '../lib/streaming/commandBus'
import { initDeepLinkHandler, recheckDeepLink } from '../services/deepLinkHandler'
import { logAuth, getAuthTrace, AUTH_DEBUG_EVENT } from '../lib/authDebug'
import './mobile.css'

// Launch Deck Remote — the slim streaming-only tablet experience.
// Pure Supabase client: no local library, no scanners. Shows the account's
// games, marks which are streamable from an online host PC, and hands the
// actual stream to the Moonlight Android app (one-time pairing is relayed
// through the same command bus the desktop uses).

const MOONLIGHT_MARKET_URL = 'market://details?id=com.limelight'
const PAIRED_KEY = 'ld_mobile_paired_hosts'

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke(cmd, args)
}

function getPairedHosts() {
  try {
    return JSON.parse(localStorage.getItem(PAIRED_KEY) || '[]')
  } catch {
    return []
  }
}

function markPaired(deviceId) {
  const list = getPairedHosts()
  if (!list.includes(deviceId)) {
    list.push(deviceId)
    localStorage.setItem(PAIRED_KEY, JSON.stringify(list))
  }
}

function GameTile({ game, source, onPlay, focused, index }) {
  const cover = game.cover_url || game.hero_url
  return (
    <button
      data-tile-index={index}
      className={`m-tile ${source ? '' : 'm-tile--offline'} ${focused ? 'm-tile--focused' : ''}`}
      onClick={() => onPlay(game, source)}
    >
      {cover ? (
        <img className="m-tile__img" src={cover} alt="" loading="lazy" />
      ) : (
        <span className="m-tile__placeholder">{game.title}</span>
      )}
      {source && (
        <span className="m-tile__badge">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <rect x="2" y="4" width="20" height="13" rx="2" />
            <path d="M8 21h8" />
          </svg>
          Stream
        </span>
      )}
      <span className="m-tile__name">{game.normalized_title || game.title}</span>
    </button>
  )
}

export default function MobileApp() {
  const { user, loading, signInWithGoogle, signingIn, error: authError, signOut } = useAuth()

  const [games, setGames] = useState([])
  const [sourceMap, setSourceMap] = useState(() => new Map())
  const [devices, setDevices] = useState([])
  const [libLoading, setLibLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [sheet, setSheetRaw] = useState(null) // {type:'install'|'pair'|'starting', game, source}
  // Ghost-click guard: a tile tap can synthesize a second click on the sheet
  // button that renders under the same finger position — arm buttons late.
  const [sheetArmed, setSheetArmed] = useState(false)
  const setSheet = useCallback((next) => {
    setSheetRaw(next)
    setSheetArmed(false)
  }, [])
  useEffect(() => {
    if (!sheet) return undefined
    const t = setTimeout(() => setSheetArmed(true), 450)
    return () => clearTimeout(t)
  }, [sheet])
  const [pin, setPin] = useState('')
  const [pairing, setPairing] = useState(false)
  const toastTimer = useRef(null)

  // Declared before anything that lists it as a dependency — a useCallback
  // deps array referencing a later `const` is a TDZ crash on every render.
  const showToast = useCallback((message, kind = 'info') => {
    clearTimeout(toastTimer.current)
    setToast({ message, kind })
    toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])

  // OAuth deep-link callback (launchdeck://auth/callback)
  useEffect(() => {
    initDeepLinkHandler()
  }, [])

  // Android safety net: the deep-link event doesn't reliably fire for
  // custom-scheme intents, but the intent still reaches the activity —
  // re-read it whenever the app regains focus, and poll while a sign-in
  // is in flight so the callback can't be missed.
  useEffect(() => {
    const onVisible = () => {
      logAuth('visibility', document.visibilityState)
      if (document.visibilityState === 'visible') recheckDeepLink()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Live auth trace for the login screen (diagnosable from a screenshot)
  const [trace, setTrace] = useState(() => getAuthTrace())
  useEffect(() => {
    const onTrace = () => setTrace(getAuthTrace())
    window.addEventListener(AUTH_DEBUG_EVENT, onTrace)
    return () => window.removeEventListener(AUTH_DEBUG_EVENT, onTrace)
  }, [])

  // Surface silent JS failures in the trace (crashes that swallow taps)
  useEffect(() => {
    const onError = (e) =>
      logAuth('JS ERROR', String(e.reason?.message || e.message || e.reason || e.error).slice(0, 80))
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onError)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onError)
    }
  }, [])

  // ── Device-link sign-in (browser-free) ──
  const [linkCode, setLinkCode] = useState('')
  const [linking, setLinking] = useState(false)
  const linkWithCode = useCallback(async () => {
    if (linkCode.length !== 6 || linking) return
    setLinking(true)
    try {
      logAuth('link claim', linkCode)
      const { data, error } = await supabase.functions.invoke('link-device', {
        body: { code: linkCode },
      })
      if (error || data?.error) {
        throw new Error(data?.error || error?.message || 'link failed')
      }
      logAuth('link token received')
      const { error: otpErr } = await supabase.auth.verifyOtp({
        type: 'magiclink',
        token_hash: data.token_hash,
      })
      if (otpErr) throw otpErr
      logAuth('link SIGNED IN')
    } catch (err) {
      const msg = String(err?.message || err)
      logAuth('link FAILED', msg.slice(0, 60))
      showToast(
        msg.includes('code_not_found')
          ? 'Code not found or expired — generate a fresh one on your PC'
          : `Linking failed: ${msg}`,
        'error',
      )
    } finally {
      setLinking(false)
    }
  }, [linkCode, linking, showToast])

  useEffect(() => {
    if (!signingIn) return undefined
    const poll = setInterval(recheckDeepLink, 2000)
    // If the browser round-trip never completes, unstick the button
    const unstick = setTimeout(() => _authBridge.setSigningIn?.(false), 180_000)
    return () => {
      clearInterval(poll)
      clearTimeout(unstick)
    }
  }, [signingIn])


  const refresh = useCallback(async () => {
    if (!user?.id) return
    try {
      const [{ data: rows }, map, deviceList] = await Promise.all([
        supabase
          .from('games')
          .select('game_id, title, normalized_title, cover_url, hero_url, added_at')
          .eq('user_id', user.id)
          .eq('deleted', false)
          .order('added_at', { ascending: false, nullsFirst: false }),
        getStreamSourceMap(user.id),
        getUserDevices(user.id),
      ])
      setGames(rows || [])
      setSourceMap(map)
      setDevices(deviceList)
    } catch (err) {
      console.warn('Library refresh failed:', err?.message)
    } finally {
      setLibLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    if (!user?.id) return undefined
    refresh()
    const timer = setInterval(refresh, 60_000)
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user?.id, refresh])

  const onlineHosts = useMemo(
    () => devices.filter((d) => d.streaming_host_enabled && d.sunshine_provisioned && isDeviceOnline(d)),
    [devices],
  )

  const orderedGames = useMemo(() => {
    // Streamable first, then the rest
    return [...games].sort((a, b) => {
      const sa = sourceMap.has(a.game_id) ? 0 : 1
      const sb = sourceMap.has(b.game_id) ? 0 : 1
      return sa - sb
    })
  }, [games, sourceMap])

  // ── Controller navigation: D-pad/left stick moves focus, A plays, B closes ──
  const [padFocus, setPadFocus] = useState(-1)
  const gridRef = useRef(null)
  const handlePlayRef = useRef(null)
  const navRefs = useRef({})
  useEffect(() => {
    navRefs.current = { orderedGames, sourceMap, sheet, padFocus }
  })

  useEffect(() => {
    if (!user?.id) return undefined
    let raf
    const prev = {}
    const cols = () => {
      const el = gridRef.current
      return el ? Math.max(1, Math.floor((el.clientWidth + 16) / 166)) : 4
    }
    const loop = () => {
      const gp = [...(navigator.getGamepads?.() || [])].find(Boolean)
      if (gp) {
        const ax = gp.axes?.[0] ?? 0
        const ay = gp.axes?.[1] ?? 0
        const state = {
          left: gp.buttons?.[14]?.pressed || ax < -0.6,
          right: gp.buttons?.[15]?.pressed || ax > 0.6,
          up: gp.buttons?.[12]?.pressed || ay < -0.6,
          down: gp.buttons?.[13]?.pressed || ay > 0.6,
          a: gp.buttons?.[0]?.pressed,
          b: gp.buttons?.[1]?.pressed,
        }
        const { orderedGames: games2, sourceMap: map2, sheet: sheet2, padFocus: cur } = navRefs.current
        const n = games2.length
        const move = (delta) => {
          if (!n) return
          const next = cur < 0 ? 0 : Math.min(n - 1, Math.max(0, cur + delta))
          setPadFocus(next)
          document
            .querySelector(`[data-tile-index="${next}"]`)
            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
        if (!sheet2) {
          if (state.left && !prev.left) move(-1)
          if (state.right && !prev.right) move(1)
          if (state.up && !prev.up) move(-cols())
          if (state.down && !prev.down) move(cols())
          if (state.a && !prev.a && cur >= 0 && games2[cur]) {
            const game = games2[cur]
            handlePlayRef.current?.(game, map2.get(game.game_id)?.[0] || null)
          }
        } else if (state.b && !prev.b && sheet2.type !== 'starting') {
          setSheet(null)
        }
        Object.assign(prev, state)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [user?.id, setSheet])

  const startStream = useCallback(
    async (game, source) => {
      setSheet({ type: 'starting', game, source })
      try {
        const myId = await getDeviceId()
        const prep = await sendCommand(
          user.id,
          myId,
          source.deviceId,
          'prepare_stream',
          { gameId: game.game_id },
          { timeoutMs: 45_000 },
        )
        await invoke('launch_moonlight_stream', {
          pcName: prep.hostname || source.hostname,
          appName: prep.appName || null,
        })
        setSheet(null)
      } catch (err) {
        setSheet(null)
        showToast(err?.message || 'Could not start the stream', 'error')
      }
    },
    [user?.id, showToast],
  )

  const handlePlay = useCallback(
    async (game, source) => {
      if (!source) {
        showToast(
          onlineHosts.length
            ? 'This game is not installed on any online PC'
            : 'None of your PCs are online with streaming enabled',
        )
        return
      }
      let installed = false
      try {
        installed = await invoke('is_moonlight_installed')
      } catch { /* not android / bridge missing */ }

      if (!installed) {
        setSheet({ type: 'install', game, source })
        return
      }
      if (!getPairedHosts().includes(source.deviceId)) {
        setPin('')
        setSheet({ type: 'pair', game, source })
        return
      }
      startStream(game, source)
    },
    [onlineHosts.length, showToast, startStream],
  )

  // Gamepad loop reads handlePlay through a ref (stable across renders)
  useEffect(() => {
    handlePlayRef.current = handlePlay
  }, [handlePlay])

  const submitPair = useCallback(async () => {
    if (!sheet?.source || pin.length !== 4 || pairing) return
    setPairing(true)
    try {
      const myId = await getDeviceId()
      await sendCommand(
        user.id,
        myId,
        sheet.source.deviceId,
        'pair_request',
        { pin, clientName: 'Launch Deck Tablet' },
        { timeoutMs: 90_000 },
      )
      markPaired(sheet.source.deviceId)
      showToast('Paired! Starting your stream…', 'success')
      const { game, source } = sheet
      setSheet(null)
      startStream(game, source)
    } catch (err) {
      showToast(err?.message || 'Pairing failed — check the PIN and try again', 'error')
    } finally {
      setPairing(false)
    }
  }, [sheet, pin, pairing, user?.id, startStream, showToast])

  // ── Screens ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="m-shell m-center">
        <div className="m-spinner" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="m-shell m-center m-login">
        <img src="/launch-deck-logo-alt.png" alt="" className="m-login__logo" />
        <h1 className="m-login__title">Launch Deck Remote</h1>
        <p className="m-login__sub">Stream your PC games to this tablet</p>

        <div className="m-link-box">
          <p className="m-link-box__hint">
            On your PC: <b>Settings → Streaming → Link a tablet</b>, then type the code here
          </p>
          <div className="m-link-box__row">
            <input
              className="m-link-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={6}
              placeholder="ABC123"
              value={linkCode}
              onChange={(e) =>
                setLinkCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))
              }
            />
            <button
              className="m-btn m-btn--primary"
              disabled={linkCode.length !== 6 || linking}
              onClick={linkWithCode}
            >
              {linking ? 'Linking…' : 'Link'}
            </button>
          </div>
        </div>

        <p className="m-login__or">or</p>
        <button
          className="m-google-btn"
          onClick={() => {
            logAuth('google btn onClick')
            signInWithGoogle()
          }}
          disabled={signingIn}
        >
          <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          <span>{signingIn ? 'Waiting for browser…' : 'Sign in with Google'}</span>
        </button>
        {signingIn && (
          <button className="m-signout" onClick={() => _authBridge.setSigningIn?.(false)}>
            Cancel and try again
          </button>
        )}
        {authError && <p className="m-login__error">{authError}</p>}
        {trace.length > 0 && (
          <div className="m-trace">
            {trace.slice(-8).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="m-shell">
      <header className="m-header">
        <div className="m-header__brand">
          <img src="/launch-deck-logo-alt.png" alt="" />
          <span>Launch Deck Remote</span>
        </div>
        <div className="m-header__status">
          {onlineHosts.length ? (
            <span className="m-chip m-chip--online">
              <span className="m-dot" /> {onlineHosts[0].hostname}
              {onlineHosts.length > 1 ? ` +${onlineHosts.length - 1}` : ''}
            </span>
          ) : (
            <span className="m-chip">No host online</span>
          )}
          <button className="m-signout" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {libLoading ? (
        <div className="m-center m-grow"><div className="m-spinner" /></div>
      ) : (
        <main className="m-grid" ref={gridRef}>
          {orderedGames.map((game, i) => (
            <GameTile
              key={game.game_id}
              game={game}
              index={i}
              focused={i === padFocus}
              source={sourceMap.get(game.game_id)?.[0] || null}
              onPlay={handlePlay}
            />
          ))}
          {orderedGames.length === 0 && (
            <p className="m-empty">No games yet — add games on your PC and they'll appear here.</p>
          )}
        </main>
      )}

      {sheet?.type === 'install' && (
        <div className="m-sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>One-time setup</h3>
            <p>Streaming uses the free Moonlight app to play the video from your PC.</p>
            <button
              className="m-btn m-btn--primary"
              disabled={!sheetArmed}
              onClick={() => invoke('open_url', { url: MOONLIGHT_MARKET_URL }).catch(() => {})}
            >
              Get Moonlight (free)
            </button>
            <button className="m-btn" onClick={() => setSheet(null)}>Later</button>
          </div>
        </div>
      )}

      {sheet?.type === 'pair' && (
        <div className="m-sheet-backdrop" onClick={() => !pairing && setSheet(null)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Link this tablet with {sheet.source.hostname}</h3>
            <ol className="m-steps">
              <li>Open Moonlight and tap <b>{sheet.source.hostname}</b></li>
              <li>Moonlight shows a 4-digit PIN — type it below</li>
              <li>Launch Deck approves it on your PC automatically</li>
            </ol>
            <button
              className="m-btn"
              disabled={!sheetArmed}
              onClick={() => invoke('open_moonlight_app').catch(() => {})}
            >
              Open Moonlight
            </button>
            <input
              className="m-pin"
              inputMode="numeric"
              maxLength={4}
              placeholder="••••"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            />
            <button
              className="m-btn m-btn--primary"
              disabled={pin.length !== 4 || pairing}
              onClick={submitPair}
            >
              {pairing ? 'Pairing…' : 'Pair & Stream'}
            </button>
          </div>
        </div>
      )}

      {sheet?.type === 'starting' && (
        <div className="m-sheet-backdrop">
          <div className="m-sheet m-sheet--starting">
            <div className="m-spinner" />
            <h3>Starting {sheet.game.normalized_title || sheet.game.title}</h3>
            <p>Getting the game ready on {sheet.source.hostname}…</p>
          </div>
        </div>
      )}

      {toast && <div className={`m-toast m-toast--${toast.kind}`}>{toast.message}</div>}
    </div>
  )
}
