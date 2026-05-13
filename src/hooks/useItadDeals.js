import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

// ── In-memory cache ─────────────────────────────────────────────────────────
const _itadCache = new Map()
const ITAD_TTL_MS = 15 * 60 * 1000 // 15 min

// PC-relevant platform keywords
const PC_PLATFORMS = ['windows', 'pc', 'linux', 'mac', 'steam', 'gog']

function isPcDeal(deal) {
  if (!deal.platforms?.length) return true // assume PC if unspecified
  return deal.platforms.some(p =>
    PC_PLATFORMS.some(pc => p.toLowerCase().includes(pc))
  )
}

/**
 * Fetch structured deal data from IsThereAnyDeal for a given game title.
 * Returns: { result, loading, error }
 *   result.deals  – sorted cheapest first, PC only
 *   result.gameId – ITAD game ID
 *   result.title  – matched game title
 */
export function useItadDeals(gameTitle) {
  const [result, setResult]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  useEffect(() => {
    if (!gameTitle) return

    const key = gameTitle.toLowerCase().trim()
    const cached = _itadCache.get(key)
    if (cached && (Date.now() - cached.fetchedAt) < ITAD_TTL_MS) {
      setResult(cached.data)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    invoke('fetch_itad_deals', { gameTitle })
      .then(raw => {
        if (cancelled) return

        // Filter to PC-relevant offers and sort cheapest first
        const pcDeals = (raw?.deals || [])
          .filter(isPcDeal)
          .sort((a, b) => a.currentPrice - b.currentPrice)

        const data = {
          gameId: raw?.gameId ?? '',
          gameSlug: raw?.gameSlug ?? '',
          title:  raw?.title  ?? gameTitle,
          deals:  pcDeals,
        }

        _itadCache.set(key, { data, fetchedAt: Date.now() })
        setResult(data)
        setLoading(false)
      })
      .catch(err => {
        if (import.meta.env.DEV) console.warn('[useItadDeals]', err)
        if (!cancelled) {
          setError(typeof err === 'string' ? err : 'Failed to fetch ITAD deals')
          setResult(null)
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [gameTitle])

  return { result, loading, error }
}
