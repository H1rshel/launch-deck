import { invoke } from '@tauri-apps/api/core'
import { getHltbCache, setHltbCache } from './db'
import {
  generateSearchVariants,
  normalizeHltbPayload,
} from './gameDetailCache'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

export async function fetchHltbDataRemote(gameName, originalName) {
  if (!gameName || !isTauri) {
    return normalizeHltbPayload(null)
  }

  try {
    const variants = generateSearchVariants(gameName, originalName)

    for (const variant of variants) {
      const result = await invoke('get_hltb_data', { query: variant })
      if (result?.available) {
        return normalizeHltbPayload(result)
      }
    }
  } catch (e) {
    console.error('[HLTB] Error in fetchHltbDataRemote:', e)
  }

  return normalizeHltbPayload({
    available: false,
    reason: 'Completion time unavailable',
  })
}

/**
 * Fetch HLTB completion time data for a game.
 * - Checks the local SQLite cache first (returns instantly if cached with real data)
 * - Only caches successful results — failures always retry on next visit
 * - Always resolves — never throws
 *
 * @param {string} gameId   — DB game ID (used as cache key)
 * @param {string} gameName — Human-readable title to search HLTB with
 * @param {string} originalName — Backup raw title to search with
 * @returns {{ available: boolean, main: number, mainExtra: number, completionist: number }}
 */
export async function getHltbData(gameId, gameName, originalName) {
  const unavailable = normalizeHltbPayload(null)

  if (!gameId || !gameName) return unavailable

  try {
    // 1. Check cache — only trust rows where available = true (real data)
    const cached = await getHltbCache(gameId)
    if (cached?.available === true) {
      console.log('[HLTB] Cache hit for', gameName)
      return cached
    }

    // 2. Not in Tauri? Return unavailable (browser dev mode)
    if (!isTauri) return unavailable

    const data = await fetchHltbDataRemote(gameName, originalName)

    // 4. Only cache successful results (never cache "unavailable")
    if (data.available) {
      setHltbCache(gameId, data).catch((e) => console.error('[HLTB] Cache write error:', e))
    }

    return data
  } catch (e) {
    console.error('[HLTB] Error in getHltbData:', e)
    return unavailable
  }
}
