import {
  useState,
  useEffect,
  useCallback,
  useRef,
  createContext,
  useContext,
} from 'react'
import { useAuth } from './AuthContext'
import { useNotifications } from './NotificationContext'
import { getCloudGameId } from '../lib/cloudSync'
import { getDeviceId, getStreamSourceMap, getUserDevices } from '../lib/devices'
import { startCommandListener } from '../lib/streaming/commandBus'
import { createHostHandlers } from '../lib/streaming/streamingHost'
import { streamGame, cancelStream } from '../lib/streaming/streamingClient'
import { ensureMoonlightClient } from '../lib/streaming/provision'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

const SOURCES_REFRESH_MS = 60 * 1000

const StreamingContext = createContext(null)

/**
 * Owns everything multi-PC streaming:
 *  - keeps the "which games can be streamed from which online PC" map fresh
 *  - runs the host-side command listener (pairing PINs, stream prep)
 *  - drives the client stream flow + the full-screen progress overlay state
 */
export function StreamingProvider({ children }) {
  const { user } = useAuth()
  const { addNotification } = useNotifications()

  // Map<cloudGameId, [{deviceId, hostname, lanIp}]> — online hosts only
  const [sourceMap, setSourceMap] = useState(() => new Map())
  // { game, host, phase: 'provisioning'|'pairing'|'preparing'|'streaming', percent? }
  const [streamingSession, setStreamingSession] = useState(null)
  const streamingRef = useRef(false)
  // How many devices other than this one are registered to the account. Only
  // those can ever send this PC a command, and the Realtime subscription that
  // receives them is the project's single biggest database cost — so it is
  // only opened once a second device actually exists.
  const [hasOtherDevices, setHasOtherDevices] = useState(false)

  const refreshStreamSources = useCallback(async () => {
    if (!user?.id) {
      setSourceMap((prev) => (prev.size === 0 ? prev : new Map()))
      return
    }
    const devices = await getUserDevices(user.id)
    const thisDeviceId = await getDeviceId()
    setHasOtherDevices(devices.some((d) => d.device_id !== thisDeviceId))

    const map = await getStreamSourceMap(user.id)
    // Keep the previous Map identity when nothing changed — GameCard is
    // memoized, and a fresh map every refresh would re-render the whole
    // library every 60s.
    setSourceMap((prev) => {
      if (prev.size === map.size) {
        let same = true
        for (const [key, hosts] of map) {
          const prevHosts = prev.get(key)
          if (
            !prevHosts ||
            prevHosts.length !== hosts.length ||
            prevHosts.some((h, i) => h.deviceId !== hosts[i].deviceId || h.lanIp !== hosts[i].lanIp)
          ) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return map
    })
  }, [user?.id])

  useEffect(() => {
    if (!user?.id) return undefined
    refreshStreamSources()
    const timer = setInterval(refreshStreamSources, SOURCES_REFRESH_MS)
    const onFocus = () => refreshStreamSources()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [user?.id, refreshStreamSources])

  // Pre-provision the Moonlight client in the background as soon as any game
  // is streamable — the ~120MB download/extract otherwise lands on the first
  // Stream click and makes it feel broken-slow.
  const moonlightPrefetchRef = useRef(false)
  useEffect(() => {
    if (!isTauri || moonlightPrefetchRef.current || sourceMap.size === 0) return
    moonlightPrefetchRef.current = true
    ensureMoonlightClient().catch(() => {
      moonlightPrefetchRef.current = false // retry on the next refresh
    })
  }, [sourceMap])

  // Host side: answer pairing/stream requests from the user's other PCs.
  useEffect(() => {
    if (!user?.id || !isTauri) return undefined
    let stop = null
    let cancelled = false
    ;(async () => {
      try {
        const deviceId = await getDeviceId()
        if (cancelled) return
        stop = startCommandListener(
          user.id,
          deviceId,
          createHostHandlers({ userId: user.id, notify: addNotification }),
          { realtime: hasOtherDevices },
        )
      } catch (err) {
        console.warn('Could not start streaming command listener:', err?.message)
      }
    })()
    return () => {
      cancelled = true
      if (stop) stop()
    }
  }, [user?.id, hasOtherDevices]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Best host for a game that is NOT installed locally, or null.
   * This is what makes the Stream button appear.
   */
  const getStreamSource = useCallback(
    (game) => {
      if (!game || game.installed || !isTauri) return null
      const hosts = sourceMap.get(getCloudGameId(game))
      return hosts?.[0] || null
    },
    [sourceMap],
  )

  /** One-click stream. Resolves when the Moonlight session ends. */
  const startStream = useCallback(
    async (game) => {
      if (streamingRef.current) return
      const host = getStreamSource(game)
      if (!host || !user?.id) return

      streamingRef.current = true
      setStreamingSession({ game, host, phase: 'provisioning' })
      try {
        await streamGame(user.id, game, host, {
          onPhase: (phase, percent) =>
            setStreamingSession((prev) =>
              prev ? { ...prev, phase, percent } : { game, host, phase, percent },
            ),
        })
      } catch (err) {
        console.error('Stream failed:', err)
        addNotification({
          title: 'Streaming failed',
          message: err?.message || 'Could not start the stream.',
          type: 'error',
          image: game.cover_url || game.hero_url || null,
        })
      } finally {
        streamingRef.current = false
        setStreamingSession(null)
        refreshStreamSources()
      }
    },
    [getStreamSource, user?.id, addNotification, refreshStreamSources],
  )

  const cancelStreaming = useCallback(async () => {
    const session = streamingSession
    setStreamingSession(null)
    streamingRef.current = false
    if (session) {
      await cancelStream(user?.id, session.game, session.host).catch(() => {})
    }
  }, [streamingSession, user?.id])

  return (
    <StreamingContext.Provider
      value={{
        getStreamSource,
        startStream,
        cancelStreaming,
        streamingSession,
        refreshStreamSources,
      }}
    >
      {children}
    </StreamingContext.Provider>
  )
}

export function useStreaming() {
  const context = useContext(StreamingContext)
  if (!context) throw new Error('useStreaming must be used within StreamingProvider')
  return context
}
