import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getDeviceId, getUserDevices, isDeviceOnline, getStreamSourceMap } from '../lib/devices'
import { sendCommand } from '../lib/streaming/commandBus'
import { initDeepLinkHandler } from '../services/deepLinkHandler'
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

function GameTile({ game, source, onPlay }) {
  const cover = game.cover_url || game.hero_url
  return (
    <button
      className={`m-tile ${source ? '' : 'm-tile--offline'}`}
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
  const [sheet, setSheet] = useState(null) // {type:'install'|'pair'|'starting', game, source}
  const [pin, setPin] = useState('')
  const [pairing, setPairing] = useState(false)
  const toastTimer = useRef(null)

  // OAuth deep-link callback (launchdeck://auth/callback)
  useEffect(() => {
    initDeepLinkHandler()
  }, [])

  const showToast = useCallback((message, kind = 'info') => {
    clearTimeout(toastTimer.current)
    setToast({ message, kind })
    toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])

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
        <h1 className="m-login__title">Launch Deck</h1>
        <p className="m-login__sub">Stream your PC games to this tablet</p>
        <button className="m-btn m-btn--primary" onClick={signInWithGoogle} disabled={signingIn}>
          {signingIn ? 'Waiting for browser…' : 'Sign in with Google'}
        </button>
        {authError && <p className="m-login__error">{authError}</p>}
      </div>
    )
  }

  return (
    <div className="m-shell">
      <header className="m-header">
        <div className="m-header__brand">
          <img src="/launch-deck-logo-alt.png" alt="" />
          <span>Launch Deck</span>
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
        <main className="m-grid">
          {orderedGames.map((game) => (
            <GameTile
              key={game.game_id}
              game={game}
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
