/**
 * @fileoverview
 * Client-side Supabase service for the EXE learning system.
 *
 * Responsibilities:
 *  - Write to `user_game_executables`   (per-user, RLS protected)
 *  - Write to `user_executable_feedback`(per-user, RLS protected)
 *  - Read  from `global_game_executable_catalog` (shared, read-only from client)
 *
 * The client NEVER writes to the global catalog — that is handled exclusively
 * by the trusted server-side catalogPromotion module.
 *
 * All writes are upserts or inserts — no raw DELETEs against these tables.
 * Every public function gracefully swallows Supabase errors in production so
 * that catalog failures never break the core scan / remove flows.
 *
 * @module executableCatalog
 */

import { supabase } from './supabase'
import {
  normalizeExeName,
  normalizeGameTitle,
  normalizePath,
  folderFromPath,
  classifyExeHeuristic,
  computeExecutableConfidence,
} from './executableNorm'

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Build the exe_name (filename only) from a full path.
 * @param {string} exePath
 * @returns {string}
 */
function exeNameFromPath(exePath) {
  const norm = exePath.replace(/\\/g, '/')
  return norm.split('/').pop() || exePath
}

/**
 * Log a non-fatal Supabase error without throwing.
 * @param {string} context
 * @param {unknown} error
 */
function warnCatalog(context, error) {
  console.warn(`[executableCatalog] ${context}:`, error)
}

// ─── Session-level write guards ────────────────────────────────────────────────
// Prevents the same write from firing more than once per process lifetime.
// In the Tauri desktop app a "session" lasts until the window is closed.
/** @type {Set<string>} keys are `'operation:userId'` */
const _sessionWritesDone = new Set()

/**
 * Returns true only when the Supabase client has an active, non-expired session
 * whose user id matches the caller's expected userId.
 * Prevents 403s that occur when writes are attempted before auth is ready.
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function hasActiveSession(userId) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) return false
    if (session.user.id !== userId) {
      console.warn('[executableCatalog] Session user mismatch — expected', userId, 'got', session.user.id)
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Build a deterministic dedupe key for a `user_game_executables` row.
 *
 * Priority:
 *   1. `h:<file_hash>`      — file-identity based (survives renames / moves)
 *   2. `p:<normalized_path>` — path based (always available when exe_path is set)
 *
 * The key is stored in the `dedupe_key` column and used as the upsert conflict
 * target instead of `exe_path`.  This makes the constraint stable regardless of
 * how the path was normalised at insert time.
 *
 * @param {string} normPath   Already-normalised exe_path (from normalizePath())
 * @param {string|null} fileHash
 * @returns {string|null}  null when neither path nor hash is available
 */
function buildDedupeKey(normPath, fileHash) {
  if (fileHash) return `h:${fileHash}`
  if (normPath) return `p:${normPath}`
  return null
}

// ─── Global catalog reads (client-side, read-only) ────────────────────────────

/**
 * Batch-look up multiple normalized EXE names in the global catalog.
 * Returns a Map keyed by normalized_exe_name for O(1) access.
 *
 * @param {string[]} normalizedNames
 * @returns {Promise<Map<string, import('./executableTypes.js').GlobalGameExecutableCatalog>>}
 */
export async function lookupCatalogByNames(normalizedNames) {
  const unique = [...new Set(normalizedNames.filter(Boolean))]
  if (unique.length === 0) return new Map()

  try {
    const { data, error } = await supabase
      .from('global_game_executable_catalog')
      .select('*')
      .in('normalized_exe_name', unique)

    if (error) {
      warnCatalog('lookupCatalogByNames', error)
      return new Map()
    }

    /** @type {Map<string, import('./executableTypes.js').GlobalGameExecutableCatalog>} */
    const map = new Map()
    for (const row of data ?? []) {
      map.set(row.normalized_exe_name, row)
    }
    return map
  } catch (err) {
    warnCatalog('lookupCatalogByNames (exception)', err)
    return new Map()
  }
}

/**
 * Look up a single normalized EXE name in the global catalog.
 *
 * @param {string} normalizedName
 * @returns {Promise<import('./executableTypes.js').GlobalGameExecutableCatalog|null>}
 */
export async function lookupCatalogByName(normalizedName) {
  if (!normalizedName) return null
  const map = await lookupCatalogByNames([normalizedName])
  return map.get(normalizedName) ?? null
}

// ─── user_game_executables writes ─────────────────────────────────────────────

/**
 * Upsert a single row into `user_game_executables`.
 * Conflict key: (user_id, dedupe_key).
 *
 * @param {string} userId
 * @param {import('./executableTypes.js').UpsertExecutableInput} input
 * @returns {Promise<import('./executableTypes.js').UserGameExecutable|null>}
 */
export async function upsertUserExecutable(userId, input) {
  if (!userId || !input.exe_path) return null

  const sessionOk = await hasActiveSession(userId)
  if (!sessionOk) {
    console.debug('[executableCatalog:upsertUserExecutable] Skipped — no active session for', userId)
    return null
  }

  const now = new Date().toISOString()
  const exeName = input.exe_name || exeNameFromPath(input.exe_path)
  const normalizedExe = input.normalized_exe_name || normalizeExeName(exeName)
  const normPath = normalizePath(input.exe_path)
  const folderPath = input.folder_path || folderFromPath(normPath)
  const dedupeKey = buildDedupeKey(normPath, input.file_hash ?? null)

  if (!dedupeKey) {
    console.warn('[executableCatalog:upsertUserExecutable] Skipped — could not build dedupe_key for', input.exe_path)
    return null
  }

  const payload = {
    user_id:               userId,
    dedupe_key:            dedupeKey,
    exe_name:              exeName,
    normalized_exe_name:   normalizedExe,
    exe_path:              normPath,
    folder_path:           folderPath,
    file_hash:             input.file_hash        ?? null,
    file_size_bytes:       input.file_size_bytes   ?? null,
    source:                input.source            ?? 'auto_scan',
    status:                input.status            ?? 'candidate',
    game_title:            input.game_title        ?? null,
    normalized_game_title: input.normalized_game_title ?? (input.game_title ? normalizeGameTitle(input.game_title) : null),
    launcher:              input.launcher          ?? null,
    platform:              input.platform          ?? null,
    confidence:            input.confidence        ?? 0,
    times_seen:            1,
    first_seen_at:         now,
    last_seen_at:          now,
    metadata:              input.metadata          ?? {},
    created_at:            now,
    updated_at:            now,
  }

  try {
    const { data, error } = await supabase
      .from('user_game_executables')
      .upsert(payload, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: false })
      .select()
      .maybeSingle()

    if (error) {
      console.warn(
        `[executableCatalog:upsertUserExecutable] code: ${error.code} — ${error.message}`,
        error.details ? `details: ${error.details}` : '',
      )
      return null
    }
    return data
  } catch (err) {
    warnCatalog('upsertUserExecutable (exception)', err)
    return null
  }
}

/**
 * Batch upsert multiple executables for a user.
 * Conflict key: (user_id, dedupe_key).
 * Rows that cannot produce a dedupe_key are silently skipped.
 *
 * @param {string} userId
 * @param {import('./executableTypes.js').UpsertExecutableInput[]} inputs
 * @returns {Promise<void>}
 */
export async function batchUpsertUserExecutables(userId, inputs) {
  if (!userId || inputs.length === 0) return

  const sessionOk = await hasActiveSession(userId)
  if (!sessionOk) {
    console.debug('[executableCatalog:batchUpsert] Skipped — no active session for', userId)
    return
  }

  const now = new Date().toISOString()
  let skippedCount = 0

  const rows = inputs
    .filter(input => !!input.exe_path)
    .reduce((acc, input) => {
      const exeName = input.exe_name || exeNameFromPath(input.exe_path)
      const normalizedExe = input.normalized_exe_name || normalizeExeName(exeName)
      const normPath = normalizePath(input.exe_path)
      const folderPath = input.folder_path || folderFromPath(normPath)
      const dedupeKey = buildDedupeKey(normPath, input.file_hash ?? null)

      if (!dedupeKey) {
        console.debug('[executableCatalog:batchUpsert] Skipping row — no dedupe_key for', input.exe_path)
        skippedCount++
        return acc
      }

      acc.push({
        user_id:               userId,
        dedupe_key:            dedupeKey,
        exe_name:              exeName,
        normalized_exe_name:   normalizedExe,
        exe_path:              normPath,
        folder_path:           folderPath,
        file_hash:             input.file_hash        ?? null,
        file_size_bytes:       input.file_size_bytes   ?? null,
        source:                input.source            ?? 'auto_scan',
        status:                input.status            ?? 'candidate',
        game_title:            input.game_title        ?? null,
        normalized_game_title: input.normalized_game_title ?? (input.game_title ? normalizeGameTitle(input.game_title) : null),
        launcher:              input.launcher           ?? null,
        platform:              input.platform           ?? null,
        confidence:            input.confidence         ?? 0,
        times_seen:            1,
        first_seen_at:         now,
        last_seen_at:          now,
        metadata:              input.metadata           ?? {},
        created_at:            now,
        updated_at:            now,
      })
      return acc
    }, [])

  if (rows.length === 0) {
    console.debug(`[executableCatalog:batchUpsert] No valid rows (${skippedCount} skipped — missing dedupe_key)`)
    return
  }

  if (skippedCount > 0) {
    console.debug(`[executableCatalog:batchUpsert] ${skippedCount} row(s) skipped — missing dedupe_key`)
  }

  const CHUNK = 50
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    try {
      const { error } = await supabase
        .from('user_game_executables')
        .upsert(chunk, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: false })

      if (error) {
        console.warn(
          `[executableCatalog:batchUpsert] Chunk ${i}–${i + chunk.length} failed — ` +
          `code: ${error.code}, message: ${error.message}` +
          (error.details ? `, details: ${error.details}` : ''),
          { sample: { exe_path: chunk[0]?.exe_path, dedupe_key: chunk[0]?.dedupe_key } },
        )
      } else {
        console.debug(`[executableCatalog:batchUpsert] Chunk ${i}–${i + chunk.length}: ${chunk.length} rows upserted`)
      }
    } catch (err) {
      console.warn(`[executableCatalog:batchUpsert] Chunk ${i} exception:`, err?.message ?? err)
    }
  }
}

/**
 * Update the status of a specific executable row.
 *
 * @param {string} userId
 * @param {string} exePath           - Raw path (will be normalized internally)
 * @param {import('./executableTypes.js').ExeStatus} status
 * @param {Partial<{game_title: string, confidence: number}>} [extra]
 * @returns {Promise<void>}
 */
export async function updateExecutableStatus(userId, exePath, status, extra = {}) {
  if (!userId || !exePath) return

  const normPath = normalizePath(exePath)
  const now = new Date().toISOString()

  const updates = {
    status,
    updated_at: now,
    last_seen_at: now,
    ...extra,
  }

  try {
    const { error } = await supabase
      .from('user_game_executables')
      .update(updates)
      .eq('user_id', userId)
      .eq('exe_path', normPath)

    if (error) warnCatalog('updateExecutableStatus', error)
  } catch (err) {
    warnCatalog('updateExecutableStatus (exception)', err)
  }
}

/**
 * Retrieve all executable rows for a user scoped to a specific set of paths.
 * Used to check user history before deciding to suppress a candidate.
 *
 * @param {string} userId
 * @param {string[]} normalizedExeNames
 * @returns {Promise<Map<string, import('./executableTypes.js').UserGameExecutable>>}
 */
export async function getUserExecutablesByNames(userId, normalizedExeNames) {
  const unique = [...new Set(normalizedExeNames.filter(Boolean))]
  if (!userId || unique.length === 0) return new Map()

  try {
    const { data, error } = await supabase
      .from('user_game_executables')
      .select('*')
      .eq('user_id', userId)
      .in('normalized_exe_name', unique)

    if (error) {
      warnCatalog('getUserExecutablesByNames', error)
      return new Map()
    }

    /** @type {Map<string, import('./executableTypes.js').UserGameExecutable>} */
    const map = new Map()
    for (const row of data ?? []) {
      map.set(row.normalized_exe_name, row)
    }
    return map
  } catch (err) {
    warnCatalog('getUserExecutablesByNames (exception)', err)
    return new Map()
  }
}

// ─── user_executable_feedback writes ──────────────────────────────────────────

/**
 * Record explicit user feedback for a rejected / removed EXE.
 * Also updates the corresponding user_game_executables row if exe_path is known.
 *
 * @param {string} userId
 * @param {import('./executableTypes.js').FeedbackPayload} payload
 * @returns {Promise<void>}
 */
export async function submitExecutableFeedback(userId, payload) {
  if (!userId) return

  const now = new Date().toISOString()
  const normalizedExe = payload.normalized_exe_name || normalizeExeName(payload.exe_name)
  const normPath = normalizePath(payload.exe_path || '')

  try {
    const { error } = await supabase
      .from('user_executable_feedback')
      .insert({
        user_id:                  userId,
        user_game_executable_id:  payload.user_game_executable_id ?? null,
        exe_name:                 payload.exe_name   || '',
        normalized_exe_name:      normalizedExe,
        exe_path:                 normPath,
        reason:                   payload.reason,
        details:                  payload.details    ?? null,
        created_at:               now,
      })

    if (error) warnCatalog('submitExecutableFeedback', error)
  } catch (err) {
    warnCatalog('submitExecutableFeedback (exception)', err)
  }

  // Mirror the rejection into user_game_executables if we have a path
  if (normPath) {
    await updateExecutableStatus(userId, normPath, 'rejected')
  }
}

// ─── Scan enrichment helpers ──────────────────────────────────────────────────

/**
 * Enrich an array of scan candidates with global catalog data and user history.
 *
 * For each candidate:
 *  - Looks up the normalized EXE name in the global catalog
 *  - Looks up user history (confirmed / rejected before)
 *  - Recomputes confidence
 *  - Attaches catalogClassification, catalogGameTitle, catalogConfidence
 *  - Suppresses known non-games (confidence → 0) when confidence would be low
 *  - Upserts all candidates into user_game_executables
 *
 * @param {import('./executableTypes.js').ScanCandidate[]} candidates
 * @param {string|null} userId   - null = not logged in, skip Supabase
 * @param {import('./executableTypes.js').ExeSource} [source]
 * @returns {Promise<import('./executableTypes.js').ScanCandidate[]>}
 */
export async function enrichCandidatesWithCatalog(candidates, userId, source = 'auto_scan') {
  if (candidates.length === 0) return candidates

  // Compute normalized names for all candidates
  const withNorm = candidates.map(c => ({
    ...c,
    _normExe: normalizeExeName(c.raw_file_name || ''),
  }))

  // ── Batch-fetch catalog + user history ───────────────────────────────────
  const allNormNames = withNorm.map(c => c._normExe).filter(Boolean)

  const [catalogMap, userHistoryMap] = await Promise.all([
    lookupCatalogByNames(allNormNames),
    userId ? getUserExecutablesByNames(userId, allNormNames) : Promise.resolve(new Map()),
  ])

  // ── Enrich each candidate ─────────────────────────────────────────────────
  const enriched = withNorm.map(c => {
    const catalog = catalogMap.get(c._normExe)
    const history = userHistoryMap.get(c._normExe)

    /** @type {import('./executableTypes.js').ExeClassification|null} */
    const catalogClassification = catalog?.classification ?? classifyExeHeuristic(c._normExe)

    const newConfidence = computeExecutableConfidence({
      rustConfidence:       (c.confidence ?? 0.5),
      catalogClassification,
      catalogConfidence:    catalog?.confidence ?? null,
      userConfirmedBefore:  history?.status === 'confirmed_game',
      userRejectedBefore:   history?.status === 'rejected',
      timesSeen:            history?.times_seen ?? 0,
    })

    return {
      ...c,
      confidence:           newConfidence,
      catalogClassification,
      catalogGameTitle:     catalog?.suggested_game_title ?? null,
      catalogConfidence:    catalog?.confidence ?? null,
      // Prefer catalog's suggested title if confidence is high enough
      title: (catalog?.suggested_game_title && newConfidence >= 0.65)
        ? catalog.suggested_game_title
        : c.title,
    }
  })

  // ── Upsert into user_game_executables (fire-and-forget) ──────────────────
  if (userId) {
    /** @type {import('./executableTypes.js').UpsertExecutableInput[]} */
    const upsertInputs = enriched.map(c => ({
      exe_name:             c.raw_file_name,
      exe_path:             c.install_path,
      folder_path:          '',
      source,
      status:               c.catalogClassification === 'game' && c.confidence >= 0.7
                              ? 'confirmed_game'
                              : c.confidence <= 0
                              ? 'rejected'
                              : 'candidate',
      game_title:           c.title || null,
      platform:             c.platform || null,
      confidence:           c.confidence,
      metadata:             c.metadata ?? {},
    }))

    batchUpsertUserExecutables(userId, upsertInputs).catch(err => {
      warnCatalog('enrichCandidatesWithCatalog upsert', err)
    })
  }

  // Return without the internal _normExe field
  return enriched.map(({ _normExe, ...rest }) => rest)
}

/**
 * Look up a single EXE path in the global catalog and user history.
 * Used by the single-game-add flow to prefill title and confidence.
 *
 * @param {string} exePath
 * @param {string|null} userId
 * @returns {Promise<{
 *   catalogEntry: import('./executableTypes.js').GlobalGameExecutableCatalog|null,
 *   userHistory:  import('./executableTypes.js').UserGameExecutable|null,
 *   suggestedTitle: string|null,
 *   classification: import('./executableTypes.js').ExeClassification,
 *   confidence: number,
 * }>}
 */
export async function lookupSingleExeInCatalog(exePath, userId) {
  const exeName = exeNameFromPath(exePath)
  const normalizedExe = normalizeExeName(exeName)

  const [catalogEntry, userHistoryMap] = await Promise.all([
    lookupCatalogByName(normalizedExe),
    userId ? getUserExecutablesByNames(userId, [normalizedExe]) : Promise.resolve(new Map()),
  ])

  const history = userHistoryMap.get(normalizedExe) ?? null
  const classification = catalogEntry?.classification ?? classifyExeHeuristic(normalizedExe)
  const confidence = computeExecutableConfidence({
    rustConfidence:       0.5, // neutral default for single picks
    catalogClassification: classification,
    catalogConfidence:    catalogEntry?.confidence ?? null,
    userConfirmedBefore:  history?.status === 'confirmed_game',
    userRejectedBefore:   history?.status === 'rejected',
    timesSeen:            history?.times_seen ?? 0,
  })

  return {
    catalogEntry,
    userHistory: history,
    suggestedTitle: catalogEntry?.suggested_game_title ?? null,
    classification,
    confidence,
  }
}

// ─── user_preferred_platforms seeding (DEPRECATED) ───────────────────────────
//
// Launch Deck is PC-focused and personalization has moved to the richer
// taste-profile system (see src/lib/upcomingScoring.js and
// src/hooks/useLibraryProfile.js). `user_preferred_platforms` is no longer
// consulted at runtime.
//
// `seedPreferredPlatforms` is retained for backwards compatibility but is not
// invoked anywhere in the app. The table can be dropped in a future migration.

/**
 * @deprecated Platform preference is no longer used in personalization.
 *
 * Maps a local game platform string to the abbreviated IGDB platform name
 * used in `upcoming_games_cache.platforms`.
 * Returns null if no known mapping exists.
 *
 * @param {string} platform
 * @returns {string|null}
 */
function platformToIgdbAbbrev(platform) {
  const p = (platform || '').trim()
  // PC launchers all map to the IGDB "PC" abbreviation
  if (p === 'PC' || p === 'Steam' || p === 'GOG' || p === 'Epic Games' || p === 'Ubisoft Connect') return 'PC'
  if (p === 'PlayStation 5') return 'PS5'
  if (p === 'PlayStation 4') return 'PS4'
  if (p === 'PlayStation 3') return 'PS3'
  if (p === 'Xbox Series X|S' || p === 'Xbox Series X') return 'XSX'
  if (p === 'Xbox One') return 'XB1'
  if (p === 'Nintendo Switch') return 'NSW'
  if (p === 'Nintendo Switch 2') return 'NSW2'
  if (p === 'iOS') return 'iOS'
  if (p === 'Android') return 'AND'
  if (p === 'macOS') return 'MAC'
  if (p === 'Linux') return 'LNX'
  return null
}

/**
 * @deprecated No longer part of the runtime flow; see file-level note above.
 *
 * Infer the user's preferred platforms from their local game library and upsert
 * them into `user_preferred_platforms`.
 *
 * Runs at most once per process lifetime per user (guarded by _sessionWritesDone).
 * Skips immediately if auth is not ready — prevents 403 on startup.
 *
 * @param {string} userId
 * @param {Array<{ platform?: string, steam_app_id?: string, gog_id?: string, epic_id?: string, ubisoft_id?: string }>} games
 * @returns {Promise<void>}
 */
export async function seedPreferredPlatforms(userId, games) {
  if (!userId) {
    console.debug('[executableCatalog:seedPreferredPlatforms] Skipped — no userId')
    return
  }
  if (games.length === 0) {
    console.debug('[executableCatalog:seedPreferredPlatforms] Skipped — empty library')
    return
  }

  // Guard: only seed once per session per user
  const guardKey = `platforms:${userId}`
  if (_sessionWritesDone.has(guardKey)) {
    console.debug('[executableCatalog:seedPreferredPlatforms] Skipped — already seeded this session')
    return
  }

  // Gate on active session — prevents 403 before auth is fully ready
  const sessionOk = await hasActiveSession(userId)
  if (!sessionOk) {
    console.debug('[executableCatalog:seedPreferredPlatforms] Skipped — no active session for', userId)
    return
  }

  /** @type {Set<string>} */
  const platforms = new Set()
  for (const g of games) {
    // Steam / GOG / Epic / Ubisoft IDs imply PC ownership
    if (g.steam_app_id || g.gog_id || g.epic_id || g.ubisoft_id) {
      platforms.add('PC')
    }
    const abbrev = platformToIgdbAbbrev(g.platform)
    if (abbrev) platforms.add(abbrev)
  }

  if (platforms.size === 0) {
    console.debug('[executableCatalog:seedPreferredPlatforms] Skipped — no mappable platforms in library')
    return
  }

  console.debug('[executableCatalog:seedPreferredPlatforms] Seeding platforms:', [...platforms])

  const now = new Date().toISOString()
  const rows = [...platforms].map((p) => ({
    user_id:    userId,
    platform:   p,
    created_at: now,
  }))

  try {
    const { error } = await supabase
      .from('user_preferred_platforms')
      .upsert(rows, { onConflict: 'user_id,platform', ignoreDuplicates: true })

    if (error) {
      if (error.code === '42501' || /rls|policy|permission/i.test(error.message ?? '')) {
        console.warn('[executableCatalog:seedPreferredPlatforms] RLS blocked write — code:', error.code, error.message)
      } else {
        console.warn(`[executableCatalog:seedPreferredPlatforms] Upsert failed — code: ${error.code}, message: ${error.message}`)
      }
    } else {
      _sessionWritesDone.add(guardKey)
      console.debug('[executableCatalog:seedPreferredPlatforms] Done —', platforms.size, 'platform(s) seeded:', [...platforms])
    }
  } catch (err) {
    warnCatalog('seedPreferredPlatforms (exception)', err)
  }
}

// ─── Cloud-sync backfill ──────────────────────────────────────────────────────

/**
 * Backfill confirmed games from the user's cloud library into
 * `user_game_executables` with source=cloud_sync and status=confirmed_game.
 *
 * This is called once after a successful cloud-to-local sync so that EXE
 * learning starts immediately from the existing library.
 *
 * @param {string} userId
 * @param {Array<{
 *   title:       string,
 *   install_path: string,
 *   raw_file_name: string,
 *   platform:    string,
 *   steam_app_id?: string,
 *   gog_id?:     string,
 *   epic_id?:    string,
 *   ubisoft_id?: string,
 * }>} games
 * @returns {Promise<void>}
 */
export async function backfillConfirmedGames(userId, games) {
  if (!userId || games.length === 0) return

  /** @type {import('./executableTypes.js').UpsertExecutableInput[]} */
  const inputs = games
    .filter(g => g.install_path && g.raw_file_name)
    .map(g => {
      const launcher = g.steam_app_id   ? 'steam'
                     : g.gog_id         ? 'gog'
                     : g.epic_id        ? 'epic'
                     : g.ubisoft_id     ? 'ubisoft'
                     : null

      return {
        exe_name:              g.raw_file_name,
        exe_path:              g.install_path,
        source:                /** @type {import('./executableTypes.js').ExeSource} */ ('cloud_sync'),
        status:                /** @type {import('./executableTypes.js').ExeStatus} */ ('confirmed_game'),
        game_title:            g.title,
        normalized_game_title: normalizeGameTitle(g.title),
        launcher,
        platform:              g.platform || null,
        confidence:            0.9,
      }
    })

  await batchUpsertUserExecutables(userId, inputs)
}

/**
 * Confirm a candidate as a real game.
 * Updates status, fills game_title, marks confidence high.
 *
 * @param {string} userId
 * @param {string} exePath
 * @param {string} gameTitle
 * @returns {Promise<void>}
 */
export async function confirmExecutableAsGame(userId, exePath, gameTitle) {
  await updateExecutableStatus(userId, exePath, 'confirmed_game', {
    game_title:            gameTitle,
    normalized_game_title: normalizeGameTitle(gameTitle),
    confidence:            0.95,
  })
}
