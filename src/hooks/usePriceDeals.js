import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

// ── CheapShark store ID → store name mapping ───────────────────────────────
const STORE_NAMES = {
  '1': 'Steam', '2': 'GamersGate', '3': 'GreenManGaming',
  '7': 'GOG', '8': 'Origin', '11': 'Humble Store',
  '13': 'Uplay', '15': 'Fanatical', '21': 'WinGameStore',
  '23': 'GameBillet', '24': 'Voidu', '25': 'Epic Games',
  '27': 'Gamesplanet', '28': 'Gamesload', '29': '2Game',
  '30': 'IndieGala', '31': 'Blizzard', '33': 'DLGamer',
  '34': 'Noctre', '35': 'DreamGame',
}

// ── In-memory cache ─────────────────────────────────────────────────────────
const _priceCache = new Map()
const PRICE_TTL_MS = 15 * 60 * 1000  // 15 min

/**
 * Fetch price deals from CheapShark for a given game title.
 * Returns sorted by price (cheapest first), deduplicated by store.
 */
export function usePriceDeals(gameTitle) {
  const [deals, setDeals]     = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!gameTitle) return

    const key = gameTitle.toLowerCase()
    const cached = _priceCache.get(key)
    if (cached && (Date.now() - cached.fetchedAt) < PRICE_TTL_MS) {
      setDeals(cached.data)
      return
    }

    let cancelled = false
    setLoading(true)

    invoke('fetch_cheapshark_deals', { gameTitle })
      .then(raw => {
        if (cancelled) return

        // Deduplicate by store (keep cheapest per store)
        const byStore = new Map()
        for (const d of raw || []) {
          const storeName = STORE_NAMES[d.storeId] || `Store #${d.storeId}`
          if (!byStore.has(storeName) || parseFloat(d.salePrice) < parseFloat(byStore.get(storeName).salePrice)) {
            byStore.set(storeName, {
              store: storeName,
              salePrice: d.salePrice,
              normalPrice: d.normalPrice,
              savings: parseFloat(d.savings || '0'),
              dealId: d.dealId,
              redirectUrl: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(d.dealId)}`,
            })
          }
        }

        // Sort cheapest first
        const sorted = [...byStore.values()].sort(
          (a, b) => parseFloat(a.salePrice) - parseFloat(b.salePrice)
        )

        _priceCache.set(key, { data: sorted, fetchedAt: Date.now() })
        setDeals(sorted)
        setLoading(false)
      })
      .catch(err => {
        if (import.meta.env.DEV) console.warn('[usePriceDeals]', err)
        if (!cancelled) {
          setDeals([])
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [gameTitle])

  return { deals, loading }
}
