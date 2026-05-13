import { supabase } from './supabase'
import {
  getAllGames,
  getDeletedGames,
  addGame,
  updateGame,
} from './db'
import { backfillConfirmedGames } from './executableCatalog'
import { tasteProfileService } from './tasteProfileService'

let gamesTableSupportsUbisoftId = null

// ── Per-session write guards ──────────────────────────────────────────────────
// Prevents EXE backfill from running on every sync cycle.
// Keyed by `'${userId}:${operation}'`.
const _postSyncDoneForSession = new Set()

function buildCloudGamePayload(game, userId, includeUbisoftId = true) {
  const payload = {
    user_id: userId,
    game_id: getCloudGameId(game),
    title: game.title,
    playtime_minutes: game.playtime_minutes || 0,
    progress_percent: game.progress_percent || 0,
    last_played: game.last_played || null,
    updated_at: game.updated_at || new Date().toISOString(),
    deleted: !!game.deleted,
    cover_url: game.cover_url || null,
    hero_url: game.hero_url || null,
    logo_url: game.logo_url || null,
    normalized_title: game.normalized_title || null,
    steam_app_id: game.steam_app_id || null,
    gog_id: game.gog_id || null,
    epic_id: game.epic_id || null,
  }

  if (includeUbisoftId) {
    payload.ubisoft_id = game.ubisoft_id || null
  }

  return payload
}

function isMissingUbisoftColumn(error) {
  return error?.code === 'PGRST204' && /ubisoft_id/i.test(error?.message || '')
}

async function upsertCloudGames(gamesToUpsert) {
  if (gamesToUpsert.length === 0) return null

  const includeUbisoftId = gamesTableSupportsUbisoftId !== false
  let payload = gamesToUpsert

  if (!includeUbisoftId) {
    payload = gamesToUpsert.map(({ ubisoft_id, ...game }) => game)
  }

  let { error } = await supabase
    .from('games')
    .upsert(payload, { onConflict: 'user_id,game_id' })

  if (error && includeUbisoftId && isMissingUbisoftColumn(error)) {
    gamesTableSupportsUbisoftId = false
    const fallbackPayload = gamesToUpsert.map(({ ubisoft_id, ...game }) => game)
    const retry = await supabase
      .from('games')
      .upsert(fallbackPayload, { onConflict: 'user_id,game_id' })
    error = retry.error
  } else if (!error && includeUbisoftId) {
    gamesTableSupportsUbisoftId = true
  }

  return error
}

/**
 * Generate a consistent game ID for cloud sync.
 * Priority: steam -> gog -> epic -> ubisoft -> local id (fallback)
 */
export function getCloudGameId(game) {
  if (game.steam_app_id) return `steam_${game.steam_app_id}`
  if (game.gog_id) return `gog_${game.gog_id}`
  if (game.epic_id) return `epic_${game.epic_id}`
  if (game.ubisoft_id) return `ubisoft_${game.ubisoft_id}`
  
  // Fallback to local DB ID
  if (game.id) return game.id
  
  // Last resort
  return (game.normalized_title || game.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
}

/**
 * Perform initial full-library sync.
 * Used to populate cloud DB from 80+ existing games.
 */
export async function initialSync(userId) {
  if (!userId) return

  // 1. Fetch all cloud games for user
  const { data: cloudGames, error } = await supabase
    .from('games')
    .select('*')
    .eq('user_id', userId)
    
  if (error) {
    console.error('Initial sync: Failed to fetch cloud games', error)
    return
  }

  const cloudIds = new Set(cloudGames.map(cg => cg.game_id))
  
  // 2. Fetch all local games (including deleted ones)
  const allLocalGames = await getAllGames()
  const deletedLocalGames = await getDeletedGames()
  const combinedLocalGames = [...allLocalGames, ...deletedLocalGames]
  
  // 3. Batch push all missing/newer local games to cloud
  const gamesToUpsert = []
  
  for (const game of combinedLocalGames) {
    const cloudGameId = getCloudGameId(game)
    const existingCloudGame = cloudGames.find(cg => cg.game_id === cloudGameId)
    
    // Convert to ISO timestamp for comparison
    const localUpdated = new Date(game.updated_at || new Date(0)).getTime()
    const cloudUpdated = existingCloudGame ? new Date(existingCloudGame.updated_at || new Date(0)).getTime() : 0
    
    if (!existingCloudGame || localUpdated > cloudUpdated) {
      gamesToUpsert.push(buildCloudGamePayload(game, userId))
    }
  }

  if (gamesToUpsert.length > 0) {
    const upsertError = await upsertCloudGames(gamesToUpsert)
      
    if (upsertError) {
      console.error('Initial sync: Failed to upsert games', upsertError)
    } else {
      console.log(`Initial sync: Upserted ${gamesToUpsert.length} games to cloud.`)
    }
  }

  // 4. Also perform a regular cloud-to-local sync to fetch any existing cloud data
  await syncCloudToLocal(userId)
  
  // 5. Upsert derived taste profile for ranking feeds using all normalized library content
  await tasteProfileService.buildAndUpsertTasteProfile(userId)
}

/**
 * Force sync all local changes up to the cloud.
 */
export async function syncLocalToCloud(userId) {
  if (!userId) return

  window.dispatchEvent(new CustomEvent('cloud-sync-start'))
  try {
    const { data: cloudGames, error } = await supabase
    .from('games')
    .select('game_id, updated_at')
    .eq('user_id', userId)

  if (error) {
    console.error('syncLocalToCloud: Failed to fetch cloud games', error)
    return
  }

  const allLocalGames = await getAllGames()
  const deletedLocalGames = await getDeletedGames()
  const combinedLocalGames = [...allLocalGames, ...deletedLocalGames]

  const gamesToUpsert = []

  for (const game of combinedLocalGames) {
    const cloudGameId = getCloudGameId(game)
    const cloudGame = cloudGames.find(cg => cg.game_id === cloudGameId)
    
    const localUpdatedStr = game.updated_at || new Date(0).toISOString()
    const cloudUpdatedStr = cloudGame?.updated_at || new Date(0).toISOString()
    
    const localUpdated = new Date(localUpdatedStr).getTime()
    const cloudUpdated = new Date(cloudUpdatedStr).getTime()
    
    // If Supabase was just updated with new schema, migrating local images up.
    const needsImagePush = cloudGame && !cloudGame.cover_url && game.cover_url
    
    if (!cloudGame || localUpdated > cloudUpdated || needsImagePush) {
      gamesToUpsert.push(buildCloudGamePayload({
        ...game,
        updated_at: localUpdatedStr,
      }, userId))
    }
  }

  if (gamesToUpsert.length > 0) {
    const upsertError = await upsertCloudGames(gamesToUpsert)

    if (upsertError) {
      console.error('syncLocalToCloud: Failed to upsert games', upsertError)
    }
  }

  // Refresh profile upon outbound delta push explicitly 
  await tasteProfileService.buildAndUpsertTasteProfile(userId)
} catch (err) {
  console.error('syncLocalToCloud: Error', err)
} finally {
  window.dispatchEvent(new CustomEvent('cloud-sync-end'))
}
}

/**
 * Fetch all cloud changes and apply them locally if newer.
 */
export async function syncCloudToLocal(userId) {
  if (!userId) return { added: 0 }
  
  let addedCount = 0

  window.dispatchEvent(new CustomEvent('cloud-sync-start'))
  try {
    const { data: cloudGames, error } = await supabase
    .from('games')
    .select('*')
    .eq('user_id', userId)

  if (error) {
    console.error('syncCloudToLocal: Failed to fetch cloud games', error)
    return { added: 0 }
  }

  const allLocalGames = await getAllGames()
  const deletedLocalGames = await getDeletedGames()
  const combinedLocalGames = [...allLocalGames, ...deletedLocalGames]

  // Build a title-keyed map for dedup: catches cross-platform duplicates (e.g. Ubisoft Connect
  // entry + PC scan entry for same game) that ID-based matching misses. Also updated mid-loop
  // so two cloud entries with the same title don't both get inserted in one sync run.
  const localByNormTitle = new Map()
  for (const lg of combinedLocalGames) {
    const normTitle = (lg.normalized_title || lg.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (normTitle) localByNormTitle.set(normTitle, lg)
  }

  for (const cg of cloudGames) {
    // Find matching local game
    // Reverse matching logic matching getCloudGameId priority
    let localGame = null

    if (cg.game_id.startsWith('steam_')) {
      const steamAppId = cg.game_id.replace('steam_', '')
      localGame = combinedLocalGames.find(lg => String(lg.steam_app_id) === steamAppId)
    } else if (cg.game_id.startsWith('gog_')) {
      const gogId = cg.game_id.replace('gog_', '')
      localGame = combinedLocalGames.find(lg => String(lg.gog_id) === gogId)
    } else if (cg.game_id.startsWith('epic_')) {
      const epicId = cg.game_id.replace('epic_', '')
      localGame = combinedLocalGames.find(lg => String(lg.epic_id) === epicId)
    } else if (cg.game_id.startsWith('ubisoft_')) {
      const ubisoftId = cg.game_id.replace('ubisoft_', '')
      localGame = combinedLocalGames.find(lg => String(lg.ubisoft_id) === ubisoftId)
    }

    // Fallback: match by local DB ID or normalized title slug
    if (!localGame) {
      localGame = combinedLocalGames.find(lg =>
        lg.id === cg.game_id ||
        (lg.normalized_title || lg.title).toLowerCase().replace(/[^a-z0-9]+/g, '-') === cg.game_id
      )
    }

    // Fallback: match by normalized title to deduplicate cross-platform entries
    // (e.g. a Ubisoft Connect cloud entry matching an existing PC-platform local game).
    // Only for non-deleted entries — a deleted cloud duplicate must not propagate its
    // deleted flag to the live canonical entry via the update path below.
    if (!localGame && !cg.deleted) {
      const cloudNormTitle = (cg.normalized_title || cg.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (cloudNormTitle) localGame = localByNormTitle.get(cloudNormTitle)
    }

    const cloudUpdated = new Date(cg.updated_at || new Date(0)).getTime()
    
    if (!localGame) {
      // Cloud game fully missing locally -> INSERT as not installed
      if (!cg.deleted) {
        // Build basic game properties based on ID prefix
        const isSteam = cg.game_id.startsWith('steam_')
        const isGog = cg.game_id.startsWith('gog_')
        const isEpic = cg.game_id.startsWith('epic_')
        const isUbisoft = cg.game_id.startsWith('ubisoft_')

        await addGame({
          id: cg.game_id,
          title: cg.title,
          install_path: '',
          platform: isSteam ? 'Steam' : isGog ? 'GOG' : isEpic ? 'Epic Games' : isUbisoft ? 'Ubisoft Connect' : 'PC',
          steam_app_id: cg.steam_app_id || (isSteam ? cg.game_id.replace('steam_', '') : ''),
          gog_id: cg.gog_id || (isGog ? cg.game_id.replace('gog_', '') : ''),
          epic_id: cg.epic_id || (isEpic ? cg.game_id.replace('epic_', '') : ''),
          ubisoft_id: cg.ubisoft_id || (isUbisoft ? cg.game_id.replace('ubisoft_', '') : ''),
          status: 'not_installed',
          gameData: {
            cover: cg.cover_url || '',
            hero: cg.hero_url || '',
            logo: cg.logo_url || '',
            name: cg.normalized_title || ''
          },
          playtime_minutes: cg.playtime_minutes || 0,
          progress_percent: cg.progress_percent || 0,
          last_played: cg.last_played || '',
          updated_at: cg.updated_at,
        })
        addedCount++

        // Register in the title map so a subsequent cloud entry for the same game
        // (different ID, same title — e.g. a PC-scan duplicate) won't be inserted again.
        // Include status/user_removed so the update path doesn't write undefined into those fields.
        const normTitle = (cg.normalized_title || cg.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
        if (normTitle) localByNormTitle.set(normTitle, { id: cg.game_id, title: cg.title, status: 'not_installed', user_removed: 0, updated_at: cg.updated_at })
      }
    } else {
      // Game exists locally, compare updated timestamps
      const localUpdated = new Date(localGame.updated_at || new Date(0)).getTime()
      
      if (cloudUpdated > localUpdated) {
        // Cloud is newer -> UPDATE local
        await updateGame(localGame.id, {
          title: cg.title,
          playtime_minutes: cg.playtime_minutes,
          progress_percent: cg.progress_percent,
          last_played: cg.last_played || '',
          updated_at: cg.updated_at,
          deleted: cg.deleted ? 1 : 0,
          status: cg.deleted ? 'not_installed' : localGame.status,
          user_removed: cg.deleted ? 1 : localGame.user_removed,
          cover_url: cg.cover_url || localGame.cover_url,
          hero_url: cg.hero_url || localGame.hero_url,
          logo_url: cg.logo_url || localGame.logo_url,
          normalized_title: cg.normalized_title || localGame.normalized_title,
          steam_app_id: cg.steam_app_id || localGame.steam_app_id,
          gog_id: cg.gog_id || localGame.gog_id,
          epic_id: cg.epic_id || localGame.epic_id,
          ubisoft_id: cg.ubisoft_id || localGame.ubisoft_id
        })
      }
    }
  }

  // ── Post-sync writes (once per session per user) ───────────────────────────
  // user_game_executables backfill
  const installedGames = allLocalGames.filter(g => g.install_path && g.raw_file_name)
  const exeKey = `${userId}:exe_backfill`
  if (_postSyncDoneForSession.has(exeKey)) {
    console.debug('[cloudSync] EXE backfill skipped — already done this session')
  } else if (installedGames.length === 0) {
    console.debug('[cloudSync] EXE backfill skipped — no installed games with exe paths')
  } else {
    _postSyncDoneForSession.add(exeKey)
    backfillConfirmedGames(userId, installedGames).catch(err => {
      _postSyncDoneForSession.delete(exeKey) // allow retry on next sync if it failed
      console.warn('[cloudSync] EXE backfill failed (non-fatal):', err?.message ?? err)
    })
  }

  // Sync is completed - re-derive taste profile for server logic ranking feeds
  await tasteProfileService.buildAndUpsertTasteProfile(userId)

  return { added: addedCount }
} catch (err) {
  console.error("Cloud Sync Error", err)
} finally {
  window.dispatchEvent(new CustomEvent('cloud-sync-end'))
}
}

// Global debounce queue for syncing changes
let syncTimeout = null

/**
 * Triggers a sync from local to cloud after a brief debounce to batch rapid updates.
 */
export function queueSyncLocalToCloud(userId) {
  if (!userId) return

  if (syncTimeout) {
    clearTimeout(syncTimeout)
  }

  // Debounce for 5 seconds to batch rapid local updates
  syncTimeout = setTimeout(() => {
    syncLocalToCloud(userId).catch(err => {
      console.warn('Queued local->cloud sync failed. Offline?', err)
    })
  }, 5000)
}
