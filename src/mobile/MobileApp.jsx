import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth, _authBridge } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getDeviceId, getUserDevices, isDeviceOnline, getStreamSourceMap } from '../lib/devices'
import { sendCommand } from '../lib/streaming/commandBus'
import { initDeepLinkHandler, recheckDeepLink } from '../services/deepLinkHandler'
import { logAuth } from '../lib/authDebug'
import {
  isNativeShell,
  nativeStartStream,
  nativeCancelStream,
  nativePrewarm,
  nativeAppVersion,
  nativeInstallUpdate,
  onNativeEvent,
} from './nativeShell'
import RemoteConsole from './RemoteConsole'
import './mobile.css'

// Launch Deck Remote — the console-mode streaming experience for tablets.
// Pure Supabase client: no local library, no scanners. Shows the account's
// games in the real Console Mode UI, marks which are streamable from an
// online host PC, and hands the stream to the embedded engine (pairing is
// invisible, relayed through the same command bus the desktop uses).

const RELEASES_URL = 'https://api.github.com/repos/H1rshel/launch-deck/releases?per_page=20'

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

export default function MobileApp() {
  const { user, loading, signInWithGoogle, signingIn, error: authError, signOut } = useAuth()

  const [games, setGames] = useState([])
  const [sourceMap, setSourceMap] = useState(() => new Map())
  const [descMap, setDescMap] = useState(() => new Map())
  const [devices, setDevices] = useState([])
  const [libLoading, setLibLoading] = useState(true)
  const [toast, setToast] = useState(null)
  // starting: { game, source, step } | null — drives the console's launch overlay
  const [starting, setStarting] = useState(null)
  const toastTimer = useRef(null)

  const showToast = useCallback((message, kind = 'info') => {
    clearTimeout(toastTimer.current)
    setToast({ message, kind })
    toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])

  // OAuth deep-link callback (browser fallback only; native uses device-link)
  useEffect(() => {
    initDeepLinkHandler()
  }, [])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheckDeepLink()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // ── Device-link sign-in (browser-free) ──
  const [linkCode, setLinkCode] = useState('')
  const [linking, setLinking] = useState(false)
  const linkWithCode = useCallback(async () => {
    if (linkCode.length !== 6 || linking) return
    setLinking(true)
    try {
      const { data, error } = await supabase.functions.invoke('link-device', {
        body: { code: linkCode },
      })
      if (error || data?.error) {
        throw new Error(data?.error || error?.message || 'link failed')
      }
      const { error: otpErr } = await supabase.auth.verifyOtp({
        type: 'magiclink',
        token_hash: data.token_hash,
      })
      if (otpErr) throw otpErr
    } catch (err) {
      const msg = String(err?.message || err)
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
    const unstick = setTimeout(() => _authBridge.setSigningIn?.(false), 180_000)
    return () => {
      clearInterval(poll)
      clearTimeout(unstick)
    }
  }, [signingIn])

  // ── Library + streamable sources + descriptions ──
  const refresh = useCallback(async () => {
    if (!user?.id) return
    try {
      const [{ data: rows }, { data: meta }, map, deviceList] = await Promise.all([
        supabase
          .from('games')
          .select('game_id, title, normalized_title, cover_url, hero_url, hero_position, genres, favorite, added_at')
          .eq('user_id', user.id)
          .eq('deleted', false)
          .order('added_at', { ascending: false, nullsFirst: false }),
        supabase
          .from('user_game_metadata')
          .select('game_id, payload')
          .eq('user_id', user.id),
        getStreamSourceMap(user.id),
        getUserDevices(user.id),
      ])
      setGames(rows || [])
      setSourceMap(map)
      setDevices(deviceList)
      const dm = new Map()
      for (const row of meta || []) {
        const d = row.payload?.description_raw || row.payload?.description || ''
        if (d) dm.set(row.game_id, d)
      }
      setDescMap(dm)
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

  // Streamable games first, then the rest (alphabetical within each group)
  const orderedGames = useMemo(() => {
    const byTitle = (a, b) =>
      (a.normalized_title || a.title || '').localeCompare(b.normalized_title || b.title || '')
    const streamable = games.filter((g) => sourceMap.has(g.game_id)).sort(byTitle)
    const rest = games.filter((g) => !sourceMap.has(g.game_id)).sort(byTitle)
    return [...streamable, ...rest]
  }, [games, sourceMap])

  // Refs the native-event handler reads (stable across renders)
  const hostRefs = useRef({})
  useEffect(() => {
    hostRefs.current = { sourceMap, onlineHosts, startingSource: starting?.source }
  })

  // Resolve the host device that owns a given LAN ip (for the PIN relay)
  const resolveTargetDevice = useCallback((hostIp) => {
    const { onlineHosts: hosts, sourceMap: map, startingSource } = hostRefs.current
    const byHost = (hosts || []).find((d) => d.lan_ip === hostIp)
    if (byHost) return byHost.device_id
    const bySource = map
      ? [...map.values()].flat().find((s) => s.lanIp === hostIp)
      : null
    return bySource?.deviceId || startingSource?.deviceId || null
  }, [])

  // ── Native shell: PIN relay + stream lifecycle events ──
  useEffect(() => {
    if (!isNativeShell() || !user?.id) return undefined
    return onNativeEvent(async (ev) => {
      if (ev.type === 'pair-pin') {
        // Invisible pairing: engine generated the PIN — relay it to the host
        // over the command bus; the host auto-approves. User sees nothing.
        try {
          const myId = await getDeviceId()
          const targetDevice = resolveTargetDevice(ev.host)
          if (targetDevice) {
            sendCommand(user.id, myId, targetDevice, 'pair_request', {
              pin: ev.pin,
              clientName: 'Launch Deck Remote',
            }, { timeoutMs: 90_000 }).catch((e) => logAuth('pin relay ERR', String(e?.message).slice(0, 50)))
          } else {
            logAuth('pin relay ERR', 'no target device for ' + ev.host)
          }
        } catch (e) {
          logAuth('pin relay ERR', String(e?.message).slice(0, 50))
        }
      } else if (ev.type === 'stream-status') {
        setStarting((s) => (s ? { ...s, step: ev.step } : s))
      } else if (ev.type === 'stream-started') {
        setStarting(null)
      } else if (ev.type === 'stream-error') {
        setStarting(null)
        showToast(ev.message || 'Stream failed', 'error')
      } else if (ev.type === 'update-progress') {
        setUpdating({ pct: Number(ev.pct) || 0 })
      } else if (ev.type === 'update-ready') {
        setUpdating(null)
        showToast('Update downloaded — confirm the install prompt', 'success')
      } else if (ev.type === 'update-error') {
        setUpdating(null)
        showToast(ev.message || 'Update failed', 'error')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, resolveTargetDevice])

  // ── Prewarm: register + pair the online host ahead of the first tap ──
  const prewarmedRef = useRef(new Set())
  useEffect(() => {
    if (!isNativeShell()) return
    for (const host of onlineHosts) {
      const ip = host.lan_ip
      if (ip && !prewarmedRef.current.has(ip)) {
        prewarmedRef.current.add(ip)
        logAuth('prewarm', host.hostname || ip)
        nativePrewarm(ip)
      }
    }
  }, [onlineHosts])

  // ── In-app updates: check GitHub releases against the installed version ──
  const [update, setUpdate] = useState(null) // { version, url } | null
  const [updating, setUpdating] = useState(null) // { pct } | null
  useEffect(() => {
    if (!isNativeShell() || !user?.id) return
    const current = nativeAppVersion()
    if (!current) return
    let stale = false
    ;(async () => {
      try {
        const res = await fetch(RELEASES_URL)
        const rels = await res.json()
        const latest = (Array.isArray(rels) ? rels : []).find((r) =>
          r.tag_name?.startsWith('remote-v'),
        )
        if (!latest) return
        const version = latest.tag_name.slice('remote-v'.length)
        const asset = (latest.assets || []).find((a) => a.name?.endsWith('.apk'))
        if (!stale && asset && compareVersions(version, current) > 0) {
          setUpdate({ version, url: asset.browser_download_url })
          showToast(`Update ${version} is ready — install it from the Quick Menu`, 'success')
        }
      } catch { /* offline or rate-limited — try again next launch */ }
    })()
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const installUpdate = useCallback(() => {
    if (!update) return
    setUpdating({ pct: 0 })
    if (!nativeInstallUpdate(update.url)) {
      setUpdating(null)
      showToast('Could not start the update', 'error')
    }
  }, [update, showToast])

  // ── Start a stream ──
  const startStream = useCallback(
    async (game, source) => {
      if (!source) return
      setStarting({ game, source, step: 'engine' })
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
        if (isNativeShell()) {
          // Headless engine — overlay stays until stream-started/error event
          nativeStartStream(prep.lanIp || source.lanIp, prep.appName)
          return
        }
        // Non-native (browser) has no engine — nothing to launch
        setStarting(null)
        showToast('Streaming needs the Launch Deck Remote app', 'error')
      } catch (err) {
        setStarting(null)
        showToast(err?.message || 'Could not start the stream', 'error')
      }
    },
    [user?.id, showToast],
  )

  const handlePlay = useCallback(
    (game, source) => {
      if (!source) {
        showToast(
          onlineHosts.length
            ? 'This game is not installed on any online PC'
            : 'None of your PCs are online with streaming enabled',
        )
        return
      }
      startStream(game, source)
    },
    [onlineHosts.length, showToast, startStream],
  )

  const cancelStreaming = useCallback(() => {
    if (isNativeShell()) nativeCancelStream()
    setStarting(null)
  }, [])

  // Favorite toggle — optimistic locally, written to the cloud row so the
  // desktop picks it up through its normal LWW pull.
  const toggleFavorite = useCallback(
    async (game) => {
      const next = !game.favorite
      setGames((rows) =>
        rows.map((g) => (g.game_id === game.game_id ? { ...g, favorite: next } : g)),
      )
      const { error } = await supabase
        .from('games')
        .update({ favorite: next, updated_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('game_id', game.game_id)
      if (error) {
        setGames((rows) =>
          rows.map((g) => (g.game_id === game.game_id ? { ...g, favorite: !next } : g)),
        )
        showToast('Could not update favorite', 'error')
      }
    },
    [user?.id, showToast],
  )

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
      <div className="m-shell m-center m-login m-login--console">
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

        {!isNativeShell() && <p className="m-login__or">or</p>}
        {!isNativeShell() && (
          <button
            className="m-google-btn"
            onClick={signInWithGoogle}
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
        )}
        {signingIn && (
          <button className="m-signout" onClick={() => _authBridge.setSigningIn?.(false)}>
            Cancel and try again
          </button>
        )}
        {authError && <p className="m-login__error">{authError}</p>}
      </div>
    )
  }

  return (
    <RemoteConsole
      user={user}
      games={orderedGames}
      sourceMap={sourceMap}
      descMap={descMap}
      onlineHosts={onlineHosts}
      libLoading={libLoading}
      starting={starting}
      toast={toast}
      update={update}
      updating={updating}
      onInstallUpdate={installUpdate}
      onPlay={handlePlay}
      onCancel={cancelStreaming}
      onRefresh={refresh}
      onSignOut={signOut}
      onToggleFavorite={toggleFavorite}
    />
  )
}
