import { supabase } from './supabase'
import {
  getAllGames,
  getDeletedGames,
  getAllGameDetailsCacheForProvider,
  setGameDetailsCache,
  getAppMeta,
  setAppMeta,
} from './db'
import { getCloudGameId } from './cloudSync'

// Syncs the local game_details_cache provider='metadata' payloads (the game
// description + the user's chosen IGDB/RAWG match) to the user_game_metadata
// cloud table, keyed by the same cloud game id as the games table.

const PROVIDER = 'metadata'
const PUSH_MARKER_KEY = 'metadata_pushed_at'
const PULL_CHUNK = 50

let tableAvailable = null

function isTableMissing(error) {
  // 42P01 (undefined table) surfaces as PGRST via REST; PostgREST also returns
  // PGRST205 for tables missing from the schema cache.
  return error?.code === '42P01' || error?.code === 'PGRST205' || error?.code === 'PGRST204'
}

async function buildIdMaps() {
  const games = [...(await getAllGames()), ...(await getDeletedGames())]
  const localToCloud = new Map()
  const cloudToLocal = new Map()
  for (const g of games) {
    const cloudId = getCloudGameId(g)
    localToCloud.set(g.id, cloudId)
    // First mapping wins — mirrors syncCloudToLocal's dedup preference
    if (!cloudToLocal.has(cloudId)) cloudToLocal.set(cloudId, g.id)
  }
  return { localToCloud, cloudToLocal }
}

/**
 * Push local metadata payloads that changed since the last push.
 */
export async function pushGameMetadata(userId) {
  if (!userId || tableAvailable === false) return

  try {
    const entries = await getAllGameDetailsCacheForProvider(PROVIDER)
    if (entries.length === 0) return

    const marker = (await getAppMeta(PUSH_MARKER_KEY)) || ''
    const changed = entries.filter((e) => e.cachedAt && e.cachedAt > marker)
    if (changed.length === 0) return

    const { localToCloud } = await buildIdMaps()

    // Deduplicate by cloud id (two local rows can map to one cloud game)
    const byCloudId = new Map()
    for (const entry of changed) {
      const cloudId = localToCloud.get(entry.gameId) || entry.gameId
      const existing = byCloudId.get(cloudId)
      if (!existing || entry.cachedAt > existing.cachedAt) {
        byCloudId.set(cloudId, entry)
      }
    }

    const rows = [...byCloudId.entries()].map(([cloudId, entry]) => ({
      user_id: userId,
      game_id: cloudId,
      payload: entry.payload ?? {},
      updated_at: entry.cachedAt || new Date().toISOString(),
    }))

    const { error } = await supabase
      .from('user_game_metadata')
      .upsert(rows, { onConflict: 'user_id,game_id' })

    if (error) {
      if (isTableMissing(error)) {
        tableAvailable = false
        console.warn('user_game_metadata table missing — descriptions will not sync across PCs until the Supabase migration is applied.')
        return
      }
      throw error
    }

    tableAvailable = true
    const newestPushed = changed.reduce((max, e) => (e.cachedAt > max ? e.cachedAt : max), marker)
    await setAppMeta(PUSH_MARKER_KEY, newestPushed)
  } catch (err) {
    console.warn('pushGameMetadata failed:', err?.message ?? err)
  }
}

/**
 * Pull cloud metadata payloads that are newer than the local cache.
 */
export async function pullGameMetadata(userId) {
  if (!userId || tableAvailable === false) return

  try {
    const { data: index, error } = await supabase
      .from('user_game_metadata')
      .select('game_id, updated_at')
      .eq('user_id', userId)

    if (error) {
      if (isTableMissing(error)) {
        tableAvailable = false
        return
      }
      throw error
    }
    tableAvailable = true
    if (!index?.length) return

    const { cloudToLocal } = await buildIdMaps()
    const localEntries = await getAllGameDetailsCacheForProvider(PROVIDER)
    const localByGameId = new Map(localEntries.map((e) => [e.gameId, e]))

    const wanted = []
    for (const row of index) {
      const localId = cloudToLocal.get(row.game_id) || row.game_id
      const local = localByGameId.get(localId)
      if (!local || (row.updated_at && row.updated_at > (local.cachedAt || ''))) {
        wanted.push(row.game_id)
      }
    }
    if (wanted.length === 0) return

    for (let i = 0; i < wanted.length; i += PULL_CHUNK) {
      const chunk = wanted.slice(i, i + PULL_CHUNK)
      const { data: rows, error: fetchError } = await supabase
        .from('user_game_metadata')
        .select('game_id, payload, updated_at')
        .eq('user_id', userId)
        .in('game_id', chunk)
      if (fetchError) throw fetchError

      for (const row of rows || []) {
        const localId = cloudToLocal.get(row.game_id) || row.game_id
        await setGameDetailsCache({
          gameId: localId,
          provider: PROVIDER,
          payload: row.payload,
          cachedAt: row.updated_at,
        })
      }
    }

    // Note: the push marker is deliberately NOT advanced here. Pulled rows get
    // cachedAt = cloud updated_at, so the next push echoes them once (a cheap
    // idempotent upsert) — but a local edit made while offline can never be
    // skipped by a marker that jumped past its timestamp.
  } catch (err) {
    console.warn('pullGameMetadata failed:', err?.message ?? err)
  }
}
