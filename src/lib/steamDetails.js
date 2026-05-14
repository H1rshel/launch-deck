import { invoke } from '@tauri-apps/api/core'
import {
  generateSearchVariants,
  normalizeAchievementsPayload,
  normalizeSteamPlaytimePayload,
} from './gameDetailCache'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

function readSteamApiKey() {
  try {
    return localStorage.getItem('steamApiKey') || ''
  } catch {
    return ''
  }
}

export async function fetchSteamPlaytime(game, steamId, steamApiKey = readSteamApiKey()) {
  if (!game || !steamId || !isTauri) {
    return normalizeSteamPlaytimePayload(null)
  }

  const variants = generateSearchVariants(game.displayTitle, game.title)
  const appId = Number.parseInt(game.steam_app_id, 10) || null

  for (const variant of variants) {
    try {
      const result = await invoke('get_steam_playtime', {
        query: variant,
        steamId,
        appId,
        steamApiKey,
      })
      if (result) return normalizeSteamPlaytimePayload(result)
    } catch (_) {
      // Try the next variant before giving up.
    }
  }

  return {
    ...normalizeSteamPlaytimePayload(null),
    reason: 'No Steam playtime found for this game',
  }
}

export async function fetchSteamAchievements(game, steamId, steamApiKey = readSteamApiKey()) {
  if (!game || !isTauri) {
    return normalizeAchievementsPayload(null)
  }

  if (!steamId) {
    return normalizeAchievementsPayload({
      available: false,
      reason: 'Connect your Steam account in Settings to view achievements',
      progress: null,
      achievements: [],
    })
  }

  const variants = generateSearchVariants(game.displayTitle, game.title)
  const appId = Number.parseInt(game.steam_app_id, 10) || null
  for (const variant of variants) {
    try {
      const result = await invoke('get_steam_achievements', {
        query: variant,
        steamId,
        appId,
        steamApiKey,
      })
      if (result) return normalizeAchievementsPayload(result)
    } catch (_) {
      // Try the next variant before giving up.
    }
  }

  return normalizeAchievementsPayload({
    available: false,
    reason: 'No Steam AppID found for this game',
    progress: null,
    achievements: [],
  })
}
