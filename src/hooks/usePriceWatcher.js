import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { supabase } from '../lib/supabase'
import { useNotifications } from '../context/NotificationContext'
import { filterAccurateDeals } from '../lib/dealMatching'

export const PRICE_SNAPSHOT_KEY = 'launchdeck_price_snapshot_v2'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const MIN_SAVINGS_PCT = 15 // notify if >=15% off
const STARTUP_DELAY_MS = 8000 // let app settle before hitting APIs

export function getPriceSnapshot() {
  try {
    const stored = localStorage.getItem(PRICE_SNAPSHOT_KEY)
    return stored ? JSON.parse(stored) : { games: {} }
  } catch {
    return { games: {} }
  }
}

export function usePriceWatcher(user) {
  const { addNotification } = useNotifications()
  const timerRef = useRef(null)

  useEffect(() => {
    if (!user?.id) return

    const snapshot = getPriceSnapshot()
    const lastChecked = snapshot.lastChecked ? new Date(snapshot.lastChecked).getTime() : 0
    if (Date.now() - lastChecked < CHECK_INTERVAL_MS) return

    async function checkPrices() {
      try {
        // Fetch followed games including metadata (stored at follow time, covers
        // games that have since been purged from upcoming_games_cache).
        const { data: followed, error } = await supabase
          .from('user_followed_games')
          .select('source, source_game_id, metadata')

        if (error || !followed?.length) return

        // Build a name/cover/source map keyed by source_game_id.
        // Start with metadata (always available); then overwrite with cache
        // entries which have fresher cover URLs.
        const gameInfoMap = {}
        for (const f of followed) {
          const key = String(f.source_game_id)
          const meta = f.metadata
          if (meta?.name) {
            gameInfoMap[key] = {
              source_game_id: key,
              source: f.source,
              name: meta.name,
              cover_url: meta.cover_url ?? null,
            }
          }
        }

        const sourceGameIds = followed.map(g => String(g.source_game_id))
        const { data: cacheGames } = await supabase
          .from('upcoming_games_cache')
          .select('source_game_id, name, cover_url, source')
          .in('source_game_id', sourceGameIds)

        for (const g of cacheGames ?? []) {
          if (g.name) {
            const key = String(g.source_game_id)
            gameInfoMap[key] = {
              source_game_id: key,
              source: g.source ?? gameInfoMap[key]?.source ?? 'igdb',
              name: g.name,
              cover_url: g.cover_url,
            }
          }
        }

        const games = Object.values(gameInfoMap)
        if (!games.length) return

        const fresh = getPriceSnapshot()
        const prevGames = fresh.games || {}
        const newGames = { ...prevGames }
        const notifications = []

        for (const game of games) {
          if (!game.name) continue
          try {
            const raw = await invoke('fetch_cheapshark_deals', { gameTitle: game.name })
            if (!raw?.length) {
              if (newGames[game.source_game_id]?.onSale) {
                newGames[game.source_game_id] = { ...newGames[game.source_game_id], onSale: false }
              }
              continue
            }

            const accurateDeals = filterAccurateDeals(game.name, raw)
            let bestDeal = null
            for (const d of accurateDeals) {
              const savingsPct = parseFloat(d.savings || '0')
              if (savingsPct >= MIN_SAVINGS_PCT) {
                if (!bestDeal || parseFloat(d.salePrice) < parseFloat(bestDeal.salePrice)) {
                  bestDeal = { ...d, savingsPct }
                }
              }
            }

            if (!bestDeal) {
              newGames[game.source_game_id] = { ...newGames[game.source_game_id], onSale: false }
              continue
            }

            const salePrice = parseFloat(bestDeal.salePrice)
            const savings = Math.round(bestDeal.savingsPct)
            const prevEntry = prevGames[game.source_game_id]
            const isNewDeal = !prevEntry?.onSale
            const isBetterDeal = prevEntry?.salePrice && salePrice < prevEntry.salePrice * 0.85

            if (isNewDeal || isBetterDeal) {
              notifications.push({
                title: game.name,
                salePrice,
                savings,
                image: game.cover_url,
                source: game.source,
                sourceGameId: game.source_game_id,
              })
            }

            newGames[game.source_game_id] = {
              onSale: true,
              salePrice,
              savings,
              checkedAt: new Date().toISOString(),
            }
          } catch {
            // Skip individual game errors silently
          }
        }

        localStorage.setItem(PRICE_SNAPSHOT_KEY, JSON.stringify({
          lastChecked: new Date().toISOString(),
          games: newGames,
        }))

        // Notify other components that prices were updated
        window.dispatchEvent(new CustomEvent('price-snapshot-updated'))

        if (notifications.length === 1) {
          const n = notifications[0]
          addNotification({
            title: `${n.title} is on sale!`,
            message: `${n.savings}% off — now $${n.salePrice.toFixed(2)}`,
            type: 'info',
            image: n.image,
            upcomingLink: { source: n.source, sourceGameId: n.sourceGameId },
          })
        } else if (notifications.length > 1) {
          addNotification({
            title: `${notifications.length} followed games are on sale`,
            message: notifications.map(n => `${n.title} (−${n.savings}%)`).join(' · '),
            type: 'info',
            saleGamesInfo: notifications.map(n => ({
              source: n.source,
              sourceGameId: n.sourceGameId,
              title: n.title,
              image: n.image,
            })),
          })
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[usePriceWatcher]', err)
      }
    }

    timerRef.current = setTimeout(checkPrices, STARTUP_DELAY_MS)
    return () => clearTimeout(timerRef.current)
  }, [user?.id, addNotification])
}
