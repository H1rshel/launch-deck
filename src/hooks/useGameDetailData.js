import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearGameDetailsCache,
  getGameDetailsCache,
  getHltbCache,
  getIgdbCache,
  setGameDetailsCache,
} from '../lib/db'
import { fetchHltbDataRemote } from '../lib/hltb'
import { fetchGameDetails } from '../lib/rawg'
import {
  buildUbisoftCacheKey,
  buildHltbCacheKey,
  buildMetadataCacheKey,
  buildSteamCacheKey,
  GAME_DETAIL_PROVIDERS,
  GAME_DETAIL_TTLS,
  getStaleAfterIso,
  hasAnyResourceData,
  mapLegacyIgdbCacheToMetadata,
  normalizeMetadataPayload,
} from '../lib/gameDetailCache'
import { fetchSteamAchievements, fetchSteamPlaytime } from '../lib/steamDetails'
import {
  fetchUbisoftAchievements,
  fetchUbisoftCoreChallenges,
  fetchUbisoftPlaytime,
} from '../lib/ubisoftDetails'
import { useOnlineStatus } from './useOnlineStatus'

function createInitialState(identity, offline) {
  return {
    identity,
    data: null,
    isLoading: false,
    isRefreshing: false,
    error: null,
    offline,
    isStale: true,
    lastUpdated: '',
  }
}

function normalizeError(error, fallback) {
  if (typeof error === 'string' && error.trim()) return error
  if (error?.message) return error.message
  return fallback
}

function getTimestampOrNow(value) {
  const timestamp = new Date(value || '').getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function isEntryStale(entry, cacheKey) {
  if (!entry) return true
  if (!entry.staleAfter) return true
  const staleAfter = new Date(entry.staleAfter).getTime()
  if (!Number.isFinite(staleAfter)) return true
  if (entry.cacheKey && cacheKey && entry.cacheKey !== cacheKey) return true
  if (!entry.cacheKey && cacheKey) return true
  return staleAfter <= Date.now()
}

function isSuccessfulAvailablePayload(payload) {
  if (payload == null || typeof payload !== 'object') return true
  if (!Object.prototype.hasOwnProperty.call(payload, 'available')) return true
  return payload.available !== false
}

function useCachedGameDetailResource({
  game,
  provider,
  cacheKey,
  ttlMs,
  enabled = true,
  shouldFetch = true,
  allowOfflineFetch = false,
  revalidateOnMount = false,
  fetcher,
  legacyLoader,
  offlineMessage,
  missingMessage,
  shouldPersistPayload = isSuccessfulAvailablePayload,
  shouldUseCachedPayload = isSuccessfulAvailablePayload,
}) {
  const isOnline = useOnlineStatus()
  const identity = game?.id ? `${game.id}:${provider}:${cacheKey}` : ''
  const [state, setState] = useState(() =>
    createInitialState(identity, !isOnline),
  )
  const requestIdRef = useRef(0)

  const persistCache = useCallback(
    async (payload, cachedAt = new Date().toISOString()) => {
      if (!game?.id) return
      await setGameDetailsCache({
        gameId: game.id,
        provider,
        cacheKey,
        payload,
        cachedAt,
        staleAfter: getStaleAfterIso(ttlMs, getTimestampOrNow(cachedAt)),
      })
    },
    [cacheKey, game?.id, provider, ttlMs],
  )

  const runFetch = useCallback(
    async ({ force = false, currentData = null } = {}) => {
      if (!game?.id || !enabled || !shouldFetch) return null

      const requestId = ++requestIdRef.current
      const hasCurrentData = hasAnyResourceData(currentData)
      const canFetch = isOnline || allowOfflineFetch

      if (!canFetch) {
        setState((prev) =>
          prev.identity === identity
            ? {
                ...prev,
                isLoading: false,
                isRefreshing: false,
                error: hasAnyResourceData(prev.data) ? null : offlineMessage,
                offline: true,
              }
            : prev,
        )
        return null
      }

      setState((prev) =>
        prev.identity === identity
          ? {
              ...prev,
              isLoading: !hasAnyResourceData(prev.data) && !hasCurrentData,
              isRefreshing:
                hasAnyResourceData(prev.data) || hasCurrentData,
              error:
                hasAnyResourceData(prev.data) || hasCurrentData
                  ? null
                  : prev.error,
              offline: !isOnline,
            }
          : prev,
      )

      try {
        const payload = await fetcher({ game, force })
        if (requestId !== requestIdRef.current) return null

        if (payload != null) {
          const cachedAt = new Date().toISOString()
          if (shouldPersistPayload(payload)) {
            try {
              await persistCache(payload, cachedAt)
            } catch (_) {
              // Keep the in-memory UI update even if cache persistence fails.
            }
          }
          setState((prev) =>
            prev.identity === identity
              ? {
                  ...prev,
                  data: payload,
                  isLoading: false,
                  isRefreshing: false,
                  error: null,
                  offline: !isOnline,
                  isStale: false,
                  lastUpdated: cachedAt,
                }
              : prev,
          )
          return payload
        }

        setState((prev) =>
          prev.identity === identity
            ? {
                ...prev,
                isLoading: false,
                isRefreshing: false,
                error:
                  hasAnyResourceData(prev.data)
                    ? null
                    : isOnline
                      ? missingMessage
                      : offlineMessage,
                offline: !isOnline,
                isStale: true,
              }
            : prev,
        )
        return null
      } catch (error) {
        if (requestId !== requestIdRef.current) return null

        setState((prev) =>
          prev.identity === identity
            ? {
                ...prev,
                isLoading: false,
                isRefreshing: false,
                error: hasAnyResourceData(prev.data)
                  ? null
                  : normalizeError(
                      error,
                      isOnline ? missingMessage : offlineMessage,
                    ),
                offline: !isOnline,
              }
            : prev,
        )
        return null
      }
    },
    [
      enabled,
      fetcher,
      game,
      identity,
      isOnline,
      allowOfflineFetch,
      missingMessage,
      offlineMessage,
      persistCache,
      shouldFetch,
    ],
  )

  useEffect(() => {
    let cancelled = false
    requestIdRef.current += 1

    if (!game?.id) {
      setState(createInitialState('', !isOnline))
      return () => {
        cancelled = true
      }
    }

    setState((prev) =>
      prev.identity === identity
        ? { ...prev, offline: !isOnline }
        : createInitialState(identity, !isOnline),
    )

    ;(async () => {
      let entry = await getGameDetailsCache(game.id, provider)
      if (cancelled) return

      if (!entry && legacyLoader) {
        const legacy = await legacyLoader(game)
        if (cancelled) return

        if (legacy?.data != null) {
          entry = {
            gameId: game.id,
            provider,
            cacheKey,
            payload: legacy.data,
            cachedAt: legacy.cachedAt || '',
            staleAfter:
              legacy.staleAfter ||
              getStaleAfterIso(ttlMs, getTimestampOrNow(legacy.cachedAt)),
          }
          persistCache(entry.payload, entry.cachedAt || new Date().toISOString()).catch(
            () => {},
          )
        }
      }

      const hasUsableCachedPayload =
        entry?.payload != null && shouldUseCachedPayload(entry.payload)
      if (entry?.payload != null && !hasUsableCachedPayload) {
        entry = null
        clearGameDetailsCache(game.id, provider).catch(() => {})
      }

      const data = entry?.payload ?? null
      const stale = isEntryStale(entry, cacheKey)
      const hasData = hasAnyResourceData(data)
      const shouldRevalidate =
        enabled &&
        shouldFetch &&
        (isOnline || allowOfflineFetch) &&
        (stale || revalidateOnMount)

      setState((prev) =>
        prev.identity === identity
          ? {
              ...prev,
              data,
              isLoading: !hasData && shouldRevalidate,
              isRefreshing: hasData && shouldRevalidate,
              error:
                !isOnline &&
                enabled &&
                shouldFetch &&
                !hasData &&
                !allowOfflineFetch
                  ? offlineMessage
                  : null,
              offline: !isOnline,
              isStale: stale,
              lastUpdated: entry?.cachedAt || '',
            }
          : prev,
      )

      if (shouldRevalidate) {
        await runFetch({ force: stale, currentData: data })
      }
    })()

    return () => {
      cancelled = true
      requestIdRef.current += 1
    }
  }, [
    cacheKey,
    enabled,
    game,
    identity,
    isOnline,
    legacyLoader,
    missingMessage,
    offlineMessage,
    allowOfflineFetch,
    persistCache,
    provider,
    revalidateOnMount,
    runFetch,
    shouldFetch,
    shouldPersistPayload,
    shouldUseCachedPayload,
    ttlMs,
  ])

  const refresh = useCallback(() => {
    return runFetch({ force: true, currentData: state.data })
  }, [runFetch, state.data])

  return useMemo(
    () => ({
      data: state.data,
      isLoading: state.isLoading,
      isRefreshing: state.isRefreshing,
      error: state.error,
      refresh,
      offline: state.offline,
      isStale: state.isStale,
      lastUpdated: state.lastUpdated,
    }),
    [refresh, state],
  )
}

export function useGameMetadata(game) {
  const cacheKey = useMemo(() => buildMetadataCacheKey(game), [game])
  const query = game?.displayTitle || game?.normalized_title || game?.title || ''

  const legacyLoader = useCallback(async () => {
    if (!query) return null
    const cached = await getIgdbCache(query)
    const mapped = mapLegacyIgdbCacheToMetadata(cached)
    if (!mapped) return null

    return {
      data: mapped,
      cachedAt: cached?.lastFetched || '',
    }
  }, [query])

  const fetcher = useCallback(
    async ({ force }) => {
      if (!query) return null
      const details = await fetchGameDetails(query, { forceRefresh: force })
      return normalizeMetadataPayload(details)
    },
    [query],
  )

  return useCachedGameDetailResource({
    game,
    provider: GAME_DETAIL_PROVIDERS.metadata,
    cacheKey,
    ttlMs: GAME_DETAIL_TTLS.metadata,
    fetcher,
    legacyLoader,
    offlineMessage: 'Offline. Cached metadata unavailable.',
    missingMessage: 'Game metadata unavailable.',
  })
}

export function useSteamPlaytime(game, steamId, options = {}) {
  const { revalidateOnMount = false } = options
  const cacheKey = useMemo(() => buildSteamCacheKey(game, steamId), [game, steamId])

  const fetcher = useCallback(() => fetchSteamPlaytime(game, steamId), [game, steamId])

  return useCachedGameDetailResource({
    game,
    provider: GAME_DETAIL_PROVIDERS.steamPlaytime,
    cacheKey,
    ttlMs: GAME_DETAIL_TTLS.steamPlaytime,
    shouldFetch: !!steamId && !!game?.steam_app_id,
    revalidateOnMount,
    fetcher,
    offlineMessage: 'Offline. Cached Steam playtime unavailable.',
    missingMessage: 'Steam playtime unavailable.',
  })
}

export function useSteamAchievements(game, steamId, options = {}) {
  const cacheKey = useMemo(() => buildSteamCacheKey(game, steamId), [game, steamId])
  const { revalidateOnMount = false } = options

  const fetcher = useCallback(
    () => fetchSteamAchievements(game, steamId),
    [game, steamId],
  )

  return useCachedGameDetailResource({
    game,
    provider: GAME_DETAIL_PROVIDERS.steamAchievements,
    cacheKey,
    ttlMs: GAME_DETAIL_TTLS.steamAchievements,
    shouldFetch: !!steamId && !!game?.steam_app_id,
    revalidateOnMount,
    fetcher,
    offlineMessage: 'Offline. Cached achievements unavailable.',
    missingMessage: 'Achievements unavailable.',
  })
}

export function useUbisoftPlaytime(
  game,
  accessToken,
  refreshToken,
  sessionId,
  accountId,
  options = {},
) {
  const cacheKey = useMemo(
    () => buildUbisoftCacheKey(game, accountId),
    [accountId, game],
  )
  const { revalidateOnMount = false } = options

  const fetcher = useCallback(
    () =>
      fetchUbisoftPlaytime(
        game,
        accessToken,
        refreshToken,
        sessionId,
        accountId,
      ),
    [accessToken, accountId, game, refreshToken, sessionId],
  )

  return useCachedGameDetailResource({
    game,
    provider: GAME_DETAIL_PROVIDERS.ubisoftPlaytime,
    cacheKey,
    ttlMs: GAME_DETAIL_TTLS.ubisoftPlaytime,
    shouldFetch: !!game?.ubisoft_id,
    allowOfflineFetch: true,
    revalidateOnMount,
    fetcher,
    offlineMessage: 'Offline. Cached Ubisoft playtime unavailable.',
    missingMessage: 'Ubisoft playtime unavailable.',
    shouldPersistPayload: isSuccessfulAvailablePayload,
    shouldUseCachedPayload: isSuccessfulAvailablePayload,
  })
}

export function useUbisoftAchievements(
  game,
  accessToken,
  refreshToken,
  sessionId,
  accountId,
  options = {},
) {
  const cacheKey = useMemo(
    () => buildUbisoftCacheKey(game, accountId),
    [accountId, game],
  )
  const { revalidateOnMount = false } = options

  const fetcher = useCallback(
    () =>
      fetchUbisoftAchievements(
        game,
        accessToken,
        refreshToken,
        sessionId,
        accountId,
      ),
    [accessToken, accountId, game, refreshToken, sessionId],
  )

  return useCachedGameDetailResource({
    game,
    provider: GAME_DETAIL_PROVIDERS.ubisoftAchievements,
    cacheKey,
    ttlMs: GAME_DETAIL_TTLS.ubisoftAchievements,
    shouldFetch: !!game?.ubisoft_id,
    revalidateOnMount,
    fetcher,
    offlineMessage: 'Offline. Cached Ubisoft achievements unavailable.',
    missingMessage: 'Ubisoft achievements unavailable.',
    shouldPersistPayload: isSuccessfulAvailablePayload,
    shouldUseCachedPayload: isSuccessfulAvailablePayload,
  })
}

export function useUbisoftCoreChallenges(
  game,
  accessToken,
  refreshToken,
  sessionId,
  accountId,
  options = {},
) {
  const cacheKey = useMemo(
    () => buildUbisoftCacheKey(game, accountId),
    [accountId, game],
  )
  const { revalidateOnMount = false } = options

  const fetcher = useCallback(
    () =>
      fetchUbisoftCoreChallenges(
        game,
        accessToken,
        refreshToken,
        sessionId,
        accountId,
      ),
    [accessToken, accountId, game, refreshToken, sessionId],
  )

  return useCachedGameDetailResource({
    game,
    provider: GAME_DETAIL_PROVIDERS.ubisoftCoreChallenges,
    cacheKey,
    ttlMs: GAME_DETAIL_TTLS.ubisoftCoreChallenges,
    shouldFetch: !!game?.ubisoft_id,
    revalidateOnMount,
    fetcher,
    offlineMessage: 'Offline. Cached Ubisoft core challenges unavailable.',
    missingMessage: 'Ubisoft core challenges unavailable.',
    shouldPersistPayload: isSuccessfulAvailablePayload,
    shouldUseCachedPayload: isSuccessfulAvailablePayload,
  })
}

export function useHltb(game, options = {}) {
  const { enabled = true } = options
  const cacheKey = useMemo(() => buildHltbCacheKey(game), [game])

  const legacyLoader = useCallback(async () => {
    if (!game?.id) return null
    const cached = await getHltbCache(game.id)
    if (!cached) return null
    return {
      data: cached,
      cachedAt: cached.lastFetched || '',
    }
  }, [game?.id])

  const fetcher = useCallback(async () => {
    const name = game?.displayTitle || game?.title || ''
    return fetchHltbDataRemote(name, game?.title || '')
  }, [game])

  return useCachedGameDetailResource({
    game,
    provider: GAME_DETAIL_PROVIDERS.hltb,
    cacheKey,
    ttlMs: GAME_DETAIL_TTLS.hltb,
    enabled,
    fetcher,
    legacyLoader,
    offlineMessage: 'Offline. Cached completion time unavailable.',
    missingMessage: 'Completion time unavailable.',
  })
}
