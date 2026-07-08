import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

function generateSearchVariants(displayTitle, originalTitle) {
  const names = []
  if (displayTitle) names.push(displayTitle)
  if (originalTitle && originalTitle !== displayTitle) names.push(originalTitle)

  const variants = []
  for (const name of names) {
    if (!name) continue
    variants.push(name)
    if (name.includes(':')) variants.push(name.split(':')[0].trim())
    if (name.match(/\(\d{4}\)/)) variants.push(name.replace(/\(\d{4}\)/g, '').trim())
    if (name.includes(' - ')) variants.push(name.split(' - ')[0].trim())
    if (name.match(/\s+\d+:\s+(.*)/)) variants.push(name.replace(/\s+\d+:\s+/, ' ').trim())
  }
  return [...new Set(variants)].filter(Boolean)
}

/**
 * Fetches Steam playtime + achievements for the currently focused game.
 * Debounced slightly so rapid tile browsing doesn't spam the backend.
 */
export function useSteamGameData(game) {
  const [steamPlaytime, setSteamPlaytime] = useState(null)
  const [achData, setAchData] = useState(null)
  const steamId = localStorage.getItem('steamId') || ''

  useEffect(() => {
    setSteamPlaytime(null)
    setAchData(null)

    if (!game || !steamId || !game.steam_app_id) return undefined

    const isTauri =
      typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
    if (!isTauri) return undefined

    let cancelled = false

    const timer = setTimeout(async () => {
      const variants = generateSearchVariants(game.displayTitle, game.title)
      const appId = Number.parseInt(game.steam_app_id, 10) || null
      const steamApiKey = localStorage.getItem('steamApiKey') || ''

      for (const variant of variants) {
        if (cancelled) return
        try {
          const data = await invoke('get_steam_playtime', { query: variant, steamId, appId, steamApiKey })
          if (data && !cancelled) {
            setSteamPlaytime(data)
            break
          }
        } catch {}
      }

      for (const variant of variants) {
        if (cancelled) return
        try {
          const data = await invoke('get_steam_achievements', { query: variant, steamId, appId, steamApiKey })
          if (data && !cancelled) {
            setAchData(data)
            break
          }
        } catch {}
      }
    }, 350)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [game?.id, steamId])

  return { steamPlaytime, achData }
}
