import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './useAuth'
import { followBus } from '../lib/followBus'
import { updateFeedCachesOnFollow } from './useUpcomingGames'

// ── Lightweight single-game cache ───────────────────────────────────────────
// Memoizes fetches by `${source}:${sourceGameId}` for the lifetime of the tab.
// The upcoming detail page is cheap to revisit thanks to this.
const _singleCache = new Map()   // key → { data, fetchedAt }
const SINGLE_TTL_MS = 5 * 60 * 1000

function cacheKey(source, id) { return `${source}:${id}` }

/**
 * Fetch a single upcoming game by (source, sourceGameId) directly from cache,
 * plus its followed state for the current user. Used by the detail page so
 * we don't need to round-trip through useUpcomingGames' full pool.
 */
export function useUpcomingGame(source, sourceGameId) {
  const { user } = useAuth()

  // Warm from cache synchronously if we have a fresh copy — avoids flash of
  // skeleton when navigating back to a detail page.
  const seedKey = source && sourceGameId ? cacheKey(source, sourceGameId) : null
  const seedEntry = seedKey ? _singleCache.get(seedKey) : null
  const hasFreshSeed = seedEntry && (Date.now() - seedEntry.fetchedAt) < SINGLE_TTL_MS

  const [game, setGame]         = useState(hasFreshSeed ? seedEntry.data : null)
  const [loading, setLoading]   = useState(!hasFreshSeed)
  const [error, setError]       = useState(null)
  const [isFollowed, setFollow] = useState(false)

  // Fetch game
  useEffect(() => {
    if (!source || !sourceGameId) { setLoading(false); return }
    const key   = cacheKey(source, sourceGameId)
    const entry = _singleCache.get(key)
    if (entry && (Date.now() - entry.fetchedAt) < SINGLE_TTL_MS) {
      setGame(entry.data)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    supabase
      .from('upcoming_games_cache')
      .select('*')
      .eq('source', source)
      .eq('source_game_id', String(sourceGameId))
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          setError(err.message)
        } else {
          setGame(data)
          if (data) _singleCache.set(key, { data, fetchedAt: Date.now() })
        }
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [source, sourceGameId])

  // Fetch follow state
  useEffect(() => {
    if (!user || !source || !sourceGameId) { setFollow(false); return }
    let cancelled = false

    supabase
      .from('user_followed_games')
      .select('id')
      .eq('source', source)
      .eq('source_game_id', String(sourceGameId))
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setFollow(!!data)
      })

    return () => { cancelled = true }
  }, [user, source, sourceGameId])

  const toggleFollow = useCallback(async (gameOverride) => {
    if (!user || !source || !sourceGameId) return
    const wasFollowed = isFollowed
    setFollow(!wasFollowed)   // optimistic

    // Use provided game data (e.g. from component's constructed object) when
    // the hook's own `game` state is null (IGDB search results not in DB yet).
    const gameData = gameOverride || game;

    try {
      if (wasFollowed) {
        const { error: delErr } = await supabase
          .from('user_followed_games')
          .delete()
          .eq('source', source)
          .eq('source_game_id', String(sourceGameId))
        if (delErr) throw delErr
      } else {
        const { error: insErr } = await supabase
          .from('user_followed_games')
          .upsert(
            { user_id: user.id, source, source_game_id: String(sourceGameId) },
            { onConflict: 'user_id,source,source_game_id', ignoreDuplicates: true }
          )
        if (insErr) throw insErr
      }
      updateFeedCachesOnFollow(user.id, wasFollowed ? -1 : 1, gameData)
      followBus.emit()
    } catch (err) {
      setFollow(wasFollowed)   // rollback
      if (import.meta.env.DEV) console.warn('[useUpcomingGame] toggleFollow failed:', err?.message ?? err)
    }
  }, [user, source, sourceGameId, isFollowed, game])

  return { game, loading, error, isFollowed, toggleFollow }
}
