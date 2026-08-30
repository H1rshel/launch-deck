import { supabase } from './supabase'
import {
  getAllGames,
  getDeletedGames,
  addGame,
  updateGame,
  getAppMeta,
  setAppMeta,
} from './db'
import { backfillConfirmedGames } from './executableCatalog'
import { tasteProfileService } from './tasteProfileService'
import { pushGameMetadata, pullGameMetadata } from './metadataSync'
import { getCloudGameId } from './cloudGameId'

// Re-exported for existing importers
export { getCloudGameId }

// ── Concurrency guard ────────────────────────────────────────────────────────
// Three independent callers can ask for a cloud sync at once: the login-time
// effect, the 5-minute periodic effect, and the debounced push queued by any
// local game edit. Each pass is a multi-query round trip over the whole
// library, and the WebView allows only a handful of concurrent connections to
// one origin — so overlapping runs don't just duplicate the work, they queue
// behind each other and starve every OTHER Supabase call (the upcoming-feed
// edge function included) for as long as they take.
//
// Collapsing duplicate in-flight runs onto one promise keeps the syncing
// indicator honest too: it can only report the single run that is actually
// happening, instead of a pile of overlapping start/end events.
const _syncInflight = new Map()
const _syncPending = new Map()

function startSyncRun(key, userId, run) {
  const promise = (async () => {
    window.dispatchEvent(new CustomEvent('cloud-sync-start'))
    try {
      return await run(userId)
    } finally {
      window.dispatchEvent(new CustomEvent('cloud-sync-end'))
      if (_syncInflight.get(key) === promise) _syncInflight.delete(key)
    }
  })()

  _syncInflight.set(key, promise)
  return promise
}

function coalesceSync(name, userId, run) {
  const key = `${name}:${userId}`
  const current = _syncInflight.get(key)
  if (!current) return startSyncRun(key, userId, run)

  // A run is already going — but it took its snapshot of the library before
  // this caller asked, so simply handing back the running promise could drop
  // the change that prompted the call (the debounced push after a game edit
  // is exactly that case). Queue one follow-up run instead, and let every
  // caller that arrives meanwhile share it: N overlapping requests collapse
  // to at most one extra pass, and nothing gets skipped.
  const queued = _syncPending.get(key)
  if (queued) return queued

  const follow = current
    .catch(() => {})
    .then(() => {
      _syncPending.delete(key)
      return startSyncRun(key, userId, run)
    })

  _syncPending.set(key, follow)
  return follow
}

/** Force sync all local changes up to the cloud. Concurrent calls share one run. */
export function syncLocalToCloud(userId) {
  if (!userId) return Promise.resolve()
  return coalesceSync('push', userId, syncLocalToCloudImpl)
}

/** Fetch all cloud changes and apply them locally. Concurrent calls share one run. */
export function syncCloudToLocal(userId) {
  if (!userId) return Promise.resolve({ added: 0 })
  return coalesceSync('pull', userId, syncCloudToLocalImpl)
}

let gamesTableSupportsUbisoftId = null

// Customization columns added by the 2026-07 streaming/multi-PC migration.
// If the cloud `games` table doesn't have them yet, we strip them and keep
// syncing the legacy payload instead of failing the whole sync.
const CUSTOMIZATION_COLUMNS = [
  'hero_position',
  'favorite',
  'user_collection',
  'rating',
  'release_date',
  'franchise',
  'franchise_slug',
  'genres',
  'themes',
  'developers',
  'publishers',
  'collections',
  'franchises',
  'imported_playtime_minutes',
  'added_at',
]
let gamesTableSupportsCustomization = null

// Local games from getAllGames() are enriched for the UI (genres/themes/... as
// arrays), but SQLite + the cloud table store them as raw CSV/JSON strings.
// Normalize back to strings before building payloads.
function asStoredString(value) {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value.join(',')
  return String(value)
}

// ── Per-session write guards ──────────────────────────────────────────────────
// Prevents a second EXE backfill starting while the first is still in flight.
// Keyed by `'${userId}:${operation}'`.
const _postSyncDoneForSession = new Set()

// Persisted across restarts in app_meta, so an unchanged exe list costs zero
// network writes no matter how often the app is relaunched.
const EXE_BACKFILL_HASH_KEY = 'exe_backfill_hash'

/** FNV-1a — short stable digest, so app_meta stores 8 chars instead of a list. */
function hashSignature(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function buildCloudGamePayload(game, userId, includeUbisoftId = true) {
  const payload = {
    user_id: userId,
    game_id: getCloudGameId(game),
    title: game.title,
    playtime_minutes: game.playtime_minutes || 0,
    progress_percent: game.progress_percent || 0,
    last_played: game.last_played || null,
    updated_at: game.updated_at || new Date().toISOString(),
    // user_removed rows are hidden from the library even when deleted=0 —
    // in the cloud both mean "not in this user's library".
    deleted: !!(game.deleted || game.user_removed),
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

  if (gamesTableSupportsCustomization !== false) {
    payload.hero_position = game.hero_position || null
    payload.favorite = !!game.favorite
    payload.user_collection = game.user_collection || null
    payload.rating = game.rating || null
    payload.release_date = game.release_date || null
    payload.franchise = game.franchise || null
    payload.franchise_slug = game.franchise_slug || null
    payload.genres = asStoredString(game.genres)
    payload.themes = asStoredString(game.themes)
    payload.developers = asStoredString(game.developers)
    payload.publishers = asStoredString(game.publishers)
    payload.collections = game.collections || null
    payload.franchises = game.franchises || null
    payload.imported_playtime_minutes = game.imported_playtime_minutes || 0
    // Date the game was first added — keeps "Latest Added" identical on
    // every PC instead of reflecting each PC's own install date.
    payload.added_at = game.created_at || null
  }

  return payload
}

function isMissingCustomizationColumn(error) {
  if (error?.code !== 'PGRST204') return false
  const msg = error?.message || ''
  return CUSTOMIZATION_COLUMNS.some((col) => msg.includes(col))
}

function stripCustomizationColumns(payload) {
  const out = { ...payload }
  for (const col of CUSTOMIZATION_COLUMNS) delete out[col]
  return out
}

function isMissingUbisoftColumn(error) {
  return error?.code === 'PGRST204' && /ubisoft_id/i.test(error?.message || '')
}

/**
 * Two local rows can map to the same cloud game_id (e.g. a user-removed
 * `steam_123` entry plus a folder-scanned copy of the same game). Postgres
 * rejects a batch upsert that touches one conflict key twice (error 21000,
 * "ON CONFLICT DO UPDATE command cannot affect row a second time") — and one
 * such pair silently killed EVERY sync of the whole library. Keep the live
 * row over the deleted one, then the newest.
 */
function dedupeByCloudGameId(rows) {
  const byId = new Map()
  for (const row of rows) {
    const existing = byId.get(row.game_id)
    if (!existing) {
      byId.set(row.game_id, row)
      continue
    }
    let winner
    if (!!existing.deleted !== !!row.deleted) {
      winner = existing.deleted ? row : existing
    } else {
      winner =
        String(row.updated_at || '') > String(existing.updated_at || '')
          ? row
          : existing
    }
    byId.set(row.game_id, winner)
  }
  return [...byId.values()]
}

async function upsertCloudGames(gamesToUpsert) {
  if (gamesToUpsert.length === 0) return null

  const includeUbisoftId = gamesTableSupportsUbisoftId !== false
  let payload = dedupeByCloudGameId(gamesToUpsert)

  if (!includeUbisoftId) {
    payload = payload.map(({ ubisoft_id, ...game }) => game)
  }

  let { error } = await supabase
    .from('games')
    .upsert(payload, { onConflict: 'user_id,game_id' })

  if (error && gamesTableSupportsCustomization !== false && isMissingCustomizationColumn(error)) {
    // Cloud migration not applied yet — retry without the new columns.
    gamesTableSupportsCustomization = false
    console.warn('Cloud games table is missing customization columns — run the Supabase migration to sync image positions, favorites and collections across PCs.')
    const fallbackPayload = payload.map(stripCustomizationColumns)
    const retry = await supabase
      .from('games')
      .upsert(fallbackPayload, { onConflict: 'user_id,game_id' })
    error = retry.error
    payload = fallbackPayload
  } else if (!error) {
    gamesTableSupportsCustomization = true
  }

  if (error && includeUbisoftId && isMissingUbisoftColumn(error)) {
    gamesTableSupportsUbisoftId = false
    const fallbackPayload = payload.map(({ ubisoft_id, ...game }) => game)
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
 * A failed push means the cloud (and every other PC) silently drifts from
 * this library — that must be user-visible, not just a console line.
 * GameContext listens for this and raises a notification.
 */
function reportSyncFailure(error) {
  if (!error) return
  console.error('Cloud sync push failed:', error)
  try {
    window.dispatchEvent(
      new CustomEvent('cloud-sync-failed', {
        detail: { message: error.message || String(error) },
      }),
    )
  } catch { /* non-browser context */ }
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
      reportSyncFailure(upsertError)
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
async function syncLocalToCloudImpl(userId) {
  if (!userId) return

  try {
    // Fetch the comparison columns (cover for the image backfill, favorite as
    // a "customization columns ever synced?" probe). Falls back to the legacy
    // column list when the cloud migration hasn't been applied yet.
    let { data: cloudGames, error } = await supabase
    .from('games')
    .select('game_id, updated_at, cover_url, favorite, deleted, added_at')
    .eq('user_id', userId)

  if (error) {
    ;({ data: cloudGames, error } = await supabase
      .from('games')
      .select('game_id, updated_at, cover_url, deleted')
      .eq('user_id', userId))
    if (!error) gamesTableSupportsCustomization = false
  }

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
    // Never backfill onto a deleted cloud row — a force-push ignores LWW and
    // would resurrect a game another PC deliberately removed.
    const needsImagePush = cloudGame && !cloudGame.deleted && !cloudGame.cover_url && game.cover_url

    // One-shot backfill: the customization columns were just added (favorite
    // is null on every pre-migration row), so push rows whose local copy has
    // customizations even though updated_at hasn't moved.
    // Only genuine USER customizations qualify — genres/franchise come from
    // automatic enrichment on every PC, and letting them trigger the backfill
    // meant a fresh install force-pushed favorite=false over the real values.
    const needsCustomizationPush =
      gamesTableSupportsCustomization !== false &&
      cloudGame &&
      !cloudGame.deleted &&
      cloudGame.favorite === null &&
      !!(game.favorite || game.hero_position || game.user_collection)

    // One-shot backfill for the added_at column (LWW never touches rows
    // that haven't changed, so existing libraries need this nudge once).
    const needsAddedAtPush =
      gamesTableSupportsCustomization !== false &&
      cloudGame &&
      !cloudGame.deleted &&
      cloudGame.added_at === null &&
      !!game.created_at

    // Mirror of the pull-side rule: an ACTIVE, NON-INSTALLED local copy must
    // never push over a cloud deletion — background touches (enrichment,
    // badge clearing) bump updated_at and would out-timestamp a deliberate
    // removal made on another PC. Skip the push; the pull adopts the
    // deletion. Installed games keep normal LWW protection.
    if (
      cloudGame?.deleted &&
      !game.deleted &&
      !game.user_removed &&
      game.status !== 'installed'
    ) {
      continue
    }

    if (!cloudGame || localUpdated > cloudUpdated || needsImagePush || needsCustomizationPush || needsAddedAtPush) {
      gamesToUpsert.push(buildCloudGamePayload({
        ...game,
        updated_at: localUpdatedStr,
      }, userId))
    }
  }

  // Tombstone orphaned cloud rows from cloud-id drift: a game first pushed
  // under its local path id that later gained a store id maps to a NEW cloud
  // game_id — the old row would otherwise live on as a phantom "active"
  // game on every other PC.
  const localById = new Map(combinedLocalGames.map((g) => [g.id, g]))
  for (const cg of cloudGames) {
    if (cg.deleted) continue
    const owner = localById.get(cg.game_id)
    if (!owner || getCloudGameId(owner) === cg.game_id) continue
    gamesToUpsert.push({
      ...buildCloudGamePayload(owner, userId),
      game_id: cg.game_id,
      deleted: true,
      updated_at: new Date().toISOString(),
    })
  }

  if (gamesToUpsert.length > 0) {
    const upsertError = await upsertCloudGames(gamesToUpsert)

    if (upsertError) {
      reportSyncFailure(upsertError)
    }
  }

  // Sync the descriptions / chosen-metadata payloads alongside the games
  await pushGameMetadata(userId)

  // Refresh profile upon outbound delta push explicitly
  await tasteProfileService.buildAndUpsertTasteProfile(userId)
} catch (err) {
  console.error('syncLocalToCloud: Error', err)
}
}

/**
 * Maps cloud customization columns to a local UPDATE object. Null cloud
 * values mean "never synced" (pre-migration rows) and are skipped so they
 * can't wipe local customizations.
 */
function buildLocalCustomizationUpdates(cg) {
  const updates = {}
  if (cg.hero_position != null) updates.hero_position = cg.hero_position
  if (cg.favorite != null) updates.favorite = cg.favorite ? 1 : 0
  if (cg.user_collection != null) updates.user_collection = cg.user_collection
  if (cg.rating != null) updates.rating = cg.rating
  if (cg.release_date != null) updates.release_date = cg.release_date
  if (cg.franchise != null) updates.franchise = cg.franchise
  if (cg.franchise_slug != null) updates.franchise_slug = cg.franchise_slug
  if (cg.genres != null) updates.genres = cg.genres
  if (cg.themes != null) updates.themes = cg.themes
  if (cg.developers != null) updates.developers = cg.developers
  if (cg.publishers != null) updates.publishers = cg.publishers
  if (cg.collections != null) updates.collections = cg.collections
  if (cg.franchises != null) updates.franchises = cg.franchises
  if (cg.imported_playtime_minutes != null) updates.imported_playtime_minutes = cg.imported_playtime_minutes
  return updates
}

/**
 * "Date added" converges on the EARLIEST value either side knows — the
 * cloud value comes from the PC that originally added the game, while a
 * secondary PC only knows its own insert date.
 */
function pickEarliestAddedAt(cg, localGame) {
  if (!cg.added_at) return undefined
  const local = localGame?.created_at || ''
  if (!local || cg.added_at < local) return cg.added_at
  return undefined
}

// PostgREST puts the `in` list in the URL, so chunk it to stay well clear of
// header/URL length limits on a large first-sync library.
const CLOUD_FETCH_CHUNK = 100

/**
 * Resolve a cloud row to its local counterpart, mirroring getCloudGameId's
 * id priority and then falling back to local id / title slug / normalized
 * title. Extracted so the pre-fetch pass and the reconcile loop below cannot
 * drift apart — they must agree on what "already exists locally" means.
 */
function findLocalMatch(cg, combinedLocalGames, localByNormTitle) {
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

  return localGame || null
}

/**
 * Fetch all cloud changes and apply them locally if newer.
 */
async function syncCloudToLocalImpl(userId) {
  if (!userId) return { added: 0 }
  
  let addedCount = 0

  try {
    // Two-step fetch instead of `select('*')`. The reconcile loop below only
    // needs six narrow columns to DECIDE what to do with a row — the wide
    // payload (covers, genres, developers, publishers, …) is only read on the
    // branches that actually insert or update. In the steady state nothing has
    // changed, so the second query is skipped entirely and each 5-minute cycle
    // transfers a fingerprint instead of the whole library. At one user that's
    // a nicety; at thousands of users on 5-minute timers it's the difference
    // between a fingerprint scan and streaming every row of every library.
    const { data: cloudIndex, error } = await supabase
    .from('games')
    .select('game_id, updated_at, deleted, added_at, title, normalized_title')
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

  // Decide up front which rows the reconcile loop will actually read the wide
  // payload from — only the insert and cloud-is-newer branches do. Matching
  // uses the same helper the loop uses, against the pre-loop local state.
  // localByNormTitle only ever GAINS entries during the loop, so a row that
  // matched here still matches there: this pass can over-estimate (harmless
  // extra row in the fetch) but can never miss a row that needs full data.
  const needsFullRow = []
  for (const cg of cloudIndex) {
    const localGame = findLocalMatch(cg, combinedLocalGames, localByNormTitle)
    if (localGame && cg.deleted && getCloudGameId(localGame) !== cg.game_id) continue
    if (!localGame) {
      if (!cg.deleted) needsFullRow.push(cg.game_id)
      continue
    }
    const cloudUpdated = new Date(cg.updated_at || new Date(0)).getTime()
    const localUpdated = new Date(localGame.updated_at || new Date(0)).getTime()
    if (cloudUpdated > localUpdated) needsFullRow.push(cg.game_id)
  }

  const fullRowById = new Map()
  for (let i = 0; i < needsFullRow.length; i += CLOUD_FETCH_CHUNK) {
    const chunk = needsFullRow.slice(i, i + CLOUD_FETCH_CHUNK)
    const { data: rows, error: fetchError } = await supabase
      .from('games')
      .select('*')
      .eq('user_id', userId)
      .in('game_id', chunk)
    if (fetchError) {
      console.error('syncCloudToLocal: Failed to fetch changed cloud games', fetchError)
      return { added: 0 }
    }
    for (const row of rows || []) fullRowById.set(row.game_id, row)
  }

  // Rows that need wide data carry it; the rest keep the fingerprint, which
  // holds every column the remaining branches read.
  const cloudGames = cloudIndex.map((cg) => fullRowById.get(cg.game_id) || cg)

  for (const cg of cloudGames) {
    const localGame = findLocalMatch(cg, combinedLocalGames, localByNormTitle)

    // A deleted cloud row only applies to a local game that CANONICALLY maps
    // to that game_id. The id-fallback above can match a live game by its
    // local path id even though the game now syncs under a store id — that
    // cloud row is an obsolete alias (tombstoned by syncLocalToCloud), and
    // applying its deleted flag would wipe the real game.
    if (localGame && cg.deleted && getCloudGameId(localGame) !== cg.game_id) {
      continue
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

        const added = await addGame({
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
          created_at: cg.added_at || cg.updated_at || '',
        })
        addedCount++

        // Apply synced customizations (image position, favorite, collection,
        // metadata fields) so a fresh PC mirrors the main PC immediately.
        const customUpdates = buildLocalCustomizationUpdates(cg)
        if (Object.keys(customUpdates).length > 0) {
          await updateGame(added.id, { ...customUpdates, updated_at: cg.updated_at })
        }

        // Register in the title map so a subsequent cloud entry for the same game
        // (different ID, same title — e.g. a PC-scan duplicate) won't be inserted again.
        // Include status/user_removed so the update path doesn't write undefined into those fields.
        const normTitle = (cg.normalized_title || cg.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
        if (normTitle) localByNormTitle.set(normTitle, { id: cg.game_id, title: cg.title, status: 'not_installed', user_removed: 0, updated_at: cg.updated_at })
      }
    } else {
      // Game exists locally, compare updated timestamps
      const localUpdated = new Date(localGame.updated_at || new Date(0)).getTime()
      
      // Date-added convergence is independent of LWW — apply whenever the
      // cloud knows an earlier origin date than this PC does.
      const earlierAddedAt = pickEarliestAddedAt(cg, localGame)
      if (earlierAddedAt && !(cloudUpdated > localUpdated)) {
        await updateGame(localGame.id, {
          created_at: earlierAddedAt,
          updated_at: localGame.updated_at, // don't disturb LWW state
        })
      }

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
          ubisoft_id: cg.ubisoft_id || localGame.ubisoft_id,
          ...buildLocalCustomizationUpdates(cg),
          ...(earlierAddedAt ? { created_at: earlierAddedAt } : {}),
        })
      } else if (
        cg.deleted &&
        !localGame.deleted &&
        !localGame.user_removed &&
        localGame.status !== 'installed'
      ) {
        // Deletion overrides last-write-wins for NON-INSTALLED copies: a PC
        // holding a stale "not installed" catalog entry bumps updated_at with
        // every metadata touch, which would forever out-timestamp (and keep
        // resurrecting) a deliberate removal made on another PC. An installed
        // copy is clearly still wanted, so it keeps normal LWW protection.
        await updateGame(localGame.id, {
          deleted: 1,
          user_removed: 1,
          status: 'not_installed',
          updated_at: cg.updated_at,
        })
      }
    }
  }

  // ── Post-sync writes ───────────────────────────────────────────────────────
  // user_game_executables backfill. Gated on a persisted signature rather than
  // a per-session flag: the exe list barely ever changes, but a session flag
  // re-uploaded the whole list on every app launch. The signature covers
  // exactly the fields backfillConfirmedGames sends, so any real change still
  // pushes immediately; the marker is only advanced once the push succeeds.
  const installedGames = allLocalGames.filter(g => g.install_path && g.raw_file_name)
  const exeKey = `${userId}:exe_backfill`
  const exeHash = installedGames.length
    ? hashSignature(
        installedGames
          .map(g => `${g.id} ${g.install_path} ${g.raw_file_name} ${g.title} ${g.platform || ''}`)
          .sort()
          .join(''),
      )
    : ''
  const lastExeHash = await getAppMeta(EXE_BACKFILL_HASH_KEY)

  if (installedGames.length === 0) {
    console.debug('[cloudSync] EXE backfill skipped — no installed games with exe paths')
  } else if (exeHash === lastExeHash) {
    console.debug('[cloudSync] EXE backfill skipped — exe list unchanged')
  } else if (_postSyncDoneForSession.has(exeKey)) {
    console.debug('[cloudSync] EXE backfill already in flight this session')
  } else {
    _postSyncDoneForSession.add(exeKey)
    backfillConfirmedGames(userId, installedGames)
      .then(() => setAppMeta(EXE_BACKFILL_HASH_KEY, exeHash))
      .catch(err => {
        console.warn('[cloudSync] EXE backfill failed (non-fatal):', err?.message ?? err)
      })
      .finally(() => {
        _postSyncDoneForSession.delete(exeKey)
      })
  }

  // Pull descriptions / chosen-metadata payloads for the library
  await pullGameMetadata(userId)

  // Sync is completed - re-derive taste profile for server logic ranking feeds
  await tasteProfileService.buildAndUpsertTasteProfile(userId)

  return { added: addedCount }
} catch (err) {
  console.error("Cloud Sync Error", err)
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
