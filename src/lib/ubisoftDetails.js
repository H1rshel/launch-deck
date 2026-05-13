import { invoke } from '@tauri-apps/api/core'
import {
  normalizeAchievementsPayload,
  normalizeUbisoftPlaytimePayload,
} from './gameDetailCache'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

export async function fetchUbisoftPlaytime(
  game,
  accessToken,
  refreshToken,
  sessionId,
  accountId,
) {
  if (!game?.ubisoft_id || !isTauri) {
    return normalizeUbisoftPlaytimePayload(null)
  }

  try {
    const result = await invoke('get_ubisoft_playtime', {
      appId: String(game.ubisoft_id),
      accessToken: accessToken || null,
      refreshToken: refreshToken || null,
      sessionId: sessionId || null,
      accountId: accountId || null,
    })
    return normalizeUbisoftPlaytimePayload(result)
  } catch (error) {
    return {
      ...normalizeUbisoftPlaytimePayload(null),
      reason:
        typeof error === 'string' ? error : (error?.message || 'Could not load Ubisoft playtime for this game'),
    }
  }
}

export async function fetchUbisoftAchievements(
  game,
  accessToken,
  refreshToken,
  sessionId,
  accountId,
) {
  if (!game?.ubisoft_id || !isTauri) {
    return normalizeAchievementsPayload(null)
  }

  try {
    const result = await invoke('get_ubisoft_achievements', {
      appId: String(game.ubisoft_id),
      accessToken: accessToken || null,
      refreshToken: refreshToken || null,
      sessionId: sessionId || null,
      accountId: accountId || null,
    })
    return normalizeAchievementsPayload(result)
  } catch (error) {
    return normalizeAchievementsPayload({
      available: false,
      reason:
        typeof error === 'string' ? error : (error?.message || 'Could not load Ubisoft achievements for this game'),
      progress: null,
      achievements: [],
    })
  }
}

export async function fetchUbisoftCoreChallenges(
  game,
  accessToken,
  refreshToken,
  sessionId,
  accountId,
) {
  if (!game?.ubisoft_id || !isTauri) {
    return normalizeAchievementsPayload(null)
  }

  try {
    const result = await invoke('get_ubisoft_core_challenges', {
      appId: String(game.ubisoft_id),
      accessToken: accessToken || null,
      refreshToken: refreshToken || null,
      sessionId: sessionId || null,
      accountId: accountId || null,
    })
    return normalizeAchievementsPayload(result)
  } catch (error) {
    return normalizeAchievementsPayload({
      available: false,
      reason:
        typeof error === 'string' ? error : (error?.message || 'Could not load Ubisoft core challenges for this game'),
      progress: null,
      achievements: [],
    })
  }
}
