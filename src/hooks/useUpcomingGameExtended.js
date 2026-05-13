import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

// ── In-memory cache for extended IGDB data ──────────────────────────────────
const _extCache = new Map()   // sourceGameId → { data, fetchedAt }
const EXT_TTL_MS = 10 * 60 * 1000  // 10 min

/**
 * Fetches extended IGDB data (screenshots, videos, websites, storyline, summary)
 * for an upcoming game by its IGDB game ID (source_game_id).
 * Falls back to name search if ID-based fetch fails.
 */
export function useUpcomingGameExtended(gameName, sourceGameId) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!sourceGameId && !gameName) return

    const cacheKey = sourceGameId || gameName
    const cached = _extCache.get(cacheKey)
    if (cached && (Date.now() - cached.fetchedAt) < EXT_TTL_MS) {
      setData(cached.data)
      return
    }

    let cancelled = false
    setLoading(true)

    async function fetchExtended() {
      let match = null

      // 1. Try fetching by exact IGDB ID (most accurate)
      if (sourceGameId) {
        try {
          const numId = parseInt(sourceGameId, 10)
          if (!isNaN(numId) && numId > 0) {
            match = await invoke('get_igdb_game_by_id', { gameId: numId })
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('[useUpcomingGameExtended] ID fetch failed, trying name:', err)
        }
      }

      // 2. Fallback to name search
      if (!match && gameName) {
        try {
          const results = await invoke('search_igdb_games', { query: gameName })
          if (results?.length) {
            match = (sourceGameId
              ? results.find(r => String(r.id) === String(sourceGameId))
              : null
            ) || results[0]
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('[useUpcomingGameExtended] name search failed:', err)
        }
      }

      if (cancelled) return

      if (match) {
        const extended = {
          summary:              match.summary || '',
          storyline:            match.storyline || '',
          screenshots:          match.screenshots || [],
          artworks:             match.artworks || [],
          videos:               match.videos || [],
          websites:             match.websites || [],
          // IGDB scoring — 0-100 floats; null/undefined when no ratings exist yet
          rating:               match.rating ?? null,
          rating_count:         match.ratingCount ?? null,
          aggregated_rating:    match.aggregatedRating ?? null,
          aggregated_rating_count: match.aggregatedRatingCount ?? null,
          total_rating:         match.totalRating ?? null,
        }
        _extCache.set(cacheKey, { data: extended, fetchedAt: Date.now() })
        setData(extended)
      }
      setLoading(false)
    }

    fetchExtended()
    return () => { cancelled = true }
  }, [gameName, sourceGameId])

  return { data, loading }
}
