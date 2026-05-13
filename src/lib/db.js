const DEFAULT_VISUAL = {
  gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  coverColor: "#667eea",
}

// Format minutes into display string — returns null for zero (hides the tag)
function formatPlaytime(minutes) {
  if (!minutes || minutes < 1) return null
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

// Enrich a DB row with UI display properties
export function enrichGame(row) {
  // Parse collections — stored as JSON '[{name, slug}, ...]' or empty string
  let collectionNames = []
  let collectionSlugs = []
  try {
    const cols = row.collections ? JSON.parse(row.collections) : []
    if (Array.isArray(cols)) {
      collectionNames = cols.map(c => c.name).filter(Boolean)
      collectionSlugs = cols.map(c => c.slug || '').filter(Boolean)
    }
  } catch (_) {}

  // Parse franchises array — stored as JSON '[{name, slug}, ...]' or empty string
  let franchisesArr = []
  try {
    const frs = row.franchises ? JSON.parse(row.franchises) : []
    if (Array.isArray(frs)) franchisesArr = frs
  } catch (_) {}

  // primaryFranchise: from the existing `franchise` name + new `franchise_slug` column
  const primaryFranchise = row.franchise
    ? { name: row.franchise, slug: row.franchise_slug || '' }
    : null

  // Merged franchise names/slugs: primary first, then franchises array — deduplicated by name
  const seenNames = new Set()
  const franchiseNames = []
  const franchiseSlugs = []
  if (primaryFranchise) {
    seenNames.add(primaryFranchise.name)
    franchiseNames.push(primaryFranchise.name)
    franchiseSlugs.push(primaryFranchise.slug)
  }
  for (const f of franchisesArr) {
    if (f.name && !seenNames.has(f.name)) {
      seenNames.add(f.name)
      franchiseNames.push(f.name)
      franchiseSlugs.push(f.slug || '')
    }
  }

  return {
    ...row,
    ...DEFAULT_VISUAL,
    displayTitle: row.normalized_title || row.title,
    playtime: formatPlaytime(row.playtime_minutes || 0),
    installed: row.status === "installed",
    lastPlayed: row.last_played,
    favorite: !!row.favorite,
    franchise: row.franchise || '',
    genres: row.genres ? row.genres.split(',').filter(Boolean) : [],
    themes: row.themes ? row.themes.split(',').filter(Boolean) : [],
    developers: row.developers ? row.developers.split(',').filter(Boolean) : [],
    publishers: row.publishers ? row.publishers.split(',').filter(Boolean) : [],
    // Normalized collection/franchise fields — safe defaults for games without IGDB data
    collectionNames,
    collectionSlugs,
    primaryFranchise,
    franchiseNames,
    franchiseSlugs,
    user_collection: row.user_collection || '',
  }
}

// Check if running inside Tauri webview
const isTauri =
  typeof window !== "undefined" &&
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

// ─── Tauri SQLite backend ───

let db = null
let dbReady = false

async function getDb() {
  if (db) return db
  const SQL = await import("@tauri-apps/plugin-sql")
  db = await SQL.default.load("sqlite:launchdeck.db")
  return db
}

// Ensures tables exist before any query — safe to call multiple times
async function ensureTablesExist() {
  if (dbReady) return
  const conn = await getDb()

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      platform TEXT DEFAULT 'PC',
      install_path TEXT DEFAULT '',
      cover_url TEXT DEFAULT '',
      hero_url TEXT DEFAULT '',
      logo_url TEXT DEFAULT '',
      playtime_minutes INTEGER DEFAULT 0,
      imported_playtime_minutes INTEGER DEFAULT 0,
      progress_percent INTEGER DEFAULT 0,
      last_played TEXT DEFAULT '',
      status TEXT DEFAULT 'not_installed',
      raw_file_name TEXT DEFAULT '',
      raw_folder_name TEXT DEFAULT '',
      metadata_fetched INTEGER DEFAULT 0,
      normalized_title TEXT DEFAULT '',
      rating REAL DEFAULT 0,
      release_date TEXT DEFAULT '',
      favorite INTEGER DEFAULT 0,
      hero_position TEXT DEFAULT '',
      steam_app_id TEXT DEFAULT '',
      last_seen_installed TEXT DEFAULT '',
      user_removed INTEGER DEFAULT 0,
      gog_id TEXT DEFAULT '',
      epic_id TEXT DEFAULT '',
      ubisoft_id TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      deleted INTEGER DEFAULT 0,
      franchise TEXT DEFAULT '',
      franchise_slug TEXT DEFAULT '',
      genres TEXT DEFAULT '',
      themes TEXT DEFAULT '',
      developers TEXT DEFAULT '',
      publishers TEXT DEFAULT '',
      collections TEXT DEFAULT '',
      franchises TEXT DEFAULT '',
      is_new INTEGER DEFAULT 0
    )
  `)

  // Migrate existing DBs — add columns if missing
  const migrations = [
    'ALTER TABLE games ADD COLUMN hero_url TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN logo_url TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN raw_file_name TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN raw_folder_name TEXT DEFAULT ""',
    "ALTER TABLE games ADD COLUMN metadata_fetched INTEGER DEFAULT 0",
    'ALTER TABLE games ADD COLUMN normalized_title TEXT DEFAULT ""',
    "ALTER TABLE games ADD COLUMN rating REAL DEFAULT 0",
    'ALTER TABLE games ADD COLUMN release_date TEXT DEFAULT ""',
    "ALTER TABLE games ADD COLUMN favorite INTEGER DEFAULT 0",
    'ALTER TABLE games ADD COLUMN hero_position TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN steam_app_id TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN last_seen_installed TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN user_removed INTEGER DEFAULT 0',
    'ALTER TABLE games ADD COLUMN gog_id TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN epic_id TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN ubisoft_id TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN updated_at TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN deleted INTEGER DEFAULT 0',
    'ALTER TABLE games ADD COLUMN franchise TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN genres TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN franchise_slug TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN collections TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN franchises TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN imported_playtime_minutes INTEGER DEFAULT 0',
    'ALTER TABLE games ADD COLUMN user_collection TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN is_new INTEGER DEFAULT 0',
    'ALTER TABLE games ADD COLUMN themes TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN developers TEXT DEFAULT ""',
    'ALTER TABLE games ADD COLUMN publishers TEXT DEFAULT ""',
  ]
  for (const sql of migrations) {
    try {
      await conn.execute(sql)
    } catch (_) {
      /* column already exists */
    }
  }

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS game_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE
    )
  `)

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL
    )
  `)

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS hltb_cache (
      game_id TEXT PRIMARY KEY,
      available INTEGER NOT NULL DEFAULT 0,
      main_hours REAL DEFAULT 0,
      main_extra_hours REAL DEFAULT 0,
      completionist_hours REAL DEFAULT 0,
      last_fetched TEXT DEFAULT ''
    )
  `)

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS igdb_cache (
      game_title TEXT PRIMARY KEY,
      igdb_id INTEGER DEFAULT 0,
      summary TEXT DEFAULT '',
      genres TEXT DEFAULT '',
      themes TEXT DEFAULT '',
      age_ratings TEXT DEFAULT '',
      similar_games TEXT DEFAULT '',
      franchise TEXT DEFAULT '',
      collections TEXT DEFAULT '',
      franchises TEXT DEFAULT '',
      last_fetched TEXT DEFAULT ''
    )
  `)

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS game_details_cache (
      game_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      cache_key TEXT DEFAULT '',
      payload_json TEXT DEFAULT '',
      cached_at TEXT DEFAULT '',
      stale_after TEXT DEFAULT '',
      PRIMARY KEY (game_id, provider)
    )
  `)

  const gameDetailsCacheMigrations = [
    'ALTER TABLE game_details_cache ADD COLUMN cache_key TEXT DEFAULT ""',
    'ALTER TABLE game_details_cache ADD COLUMN payload_json TEXT DEFAULT ""',
    'ALTER TABLE game_details_cache ADD COLUMN cached_at TEXT DEFAULT ""',
    'ALTER TABLE game_details_cache ADD COLUMN stale_after TEXT DEFAULT ""',
  ]
  for (const sql of gameDetailsCacheMigrations) {
    try {
      await conn.execute(sql)
    } catch (_) {
      /* column already exists */
    }
  }
  // Migrate igdb_cache for existing installs
  const igdbMigrations = [
    'ALTER TABLE igdb_cache ADD COLUMN collections TEXT DEFAULT ""',
    'ALTER TABLE igdb_cache ADD COLUMN franchises TEXT DEFAULT ""',
  ]
  for (const sql of igdbMigrations) {
    try { await conn.execute(sql) } catch (_) { /* column already exists */ }
  }

  // Clear any stale "unavailable" cache rows stored by earlier versions.
  // We no longer cache failures, so stale rows would block fresh fetches.
  try {
    await conn.execute("DELETE FROM hltb_cache WHERE available = 0")
  } catch (_) {}

  dbReady = true
}

async function initTauriDb() {
  await ensureTablesExist()

  // Self-heal: Clean up any sync artifact duplicates from previous app versions.
  // We want to keep the 'not_installed' record (which has cloud playtime) and 
  // copy the installation info from the 'installed' duplicate, then delete the duplicate.
  const conn = await getDb()
  try {
    const allGamesRows = await conn.select("SELECT * FROM games WHERE deleted = 0 AND user_removed = 0")
    
    // Group by fully normalized title
    const byTitle = {}
    for (const g of allGamesRows) {
      const norm = (g.normalized_title || g.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (!norm) continue
      if (!byTitle[norm]) byTitle[norm] = []
      byTitle[norm].push(g)
    }

    const updated = new Date().toISOString()
    
    for (const norm in byTitle) {
      const group = byTitle[norm]
      const notInstalled = group.filter(g => g.status === 'not_installed')
      const installed = group.filter(g => g.status === 'installed')
      
      if (notInstalled.length > 0 && installed.length > 0) {
        // We have duplicates! Merge installed info into the cloud (not_installed) record.
        const cloudGame = notInstalled[0]
        const localGame = installed[0]

        // 1. Copy install path to the cloud record
        await conn.execute(`
          UPDATE games 
          SET status = 'installed', install_path = $1, raw_file_name = $2, raw_folder_name = $3, updated_at = $4
          WHERE id = $5
        `, [localGame.install_path, localGame.raw_file_name, localGame.raw_folder_name, updated, cloudGame.id])
        
        // 2. Mark the local duplicate as deleted
        await conn.execute(`
          UPDATE games 
          SET deleted = 1, user_removed = 1, updated_at = $1
          WHERE id = $2
        `, [updated, localGame.id])
      }
    }

    // Self-heal: If last_played is empty but sessions exist, restore it from the latest session.
    await conn.execute(`
      UPDATE games 
      SET last_played = (SELECT MAX(start_time) FROM sessions WHERE sessions.game_id = games.id)
      WHERE (last_played = '' OR last_played IS NULL) 
      AND EXISTS (SELECT 1 FROM sessions WHERE sessions.game_id = games.id)
    `)
  } catch (err) {
    console.warn('Cleanup step failed:', err)
  }
}

async function tauriGetAll() {
  await ensureTablesExist()
  const conn = await getDb()
  try {
    return await conn.select("SELECT * FROM games WHERE deleted = 0 AND user_removed = 0 ORDER BY CASE WHEN last_played = '' OR last_played IS NULL THEN '0' ELSE last_played END DESC")
  } catch (err) {
    console.error("tauriGetAll SQL error:", err)
    // Fallback to basic fetch if advanced ordering fails
    return await conn.select("SELECT * FROM games WHERE deleted = 0 AND user_removed = 0")
  }
}

async function tauriAdd(game) {
  await ensureTablesExist()
  const conn = await getDb()
  const id = game.id || game.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  
  // Check if a row with this ID already exists (possibly soft-deleted)
  const existing = await conn.select("SELECT id, user_removed FROM games WHERE id = $1", [id])
  
  if (existing && existing.length > 0) {
    // If the user explicitly removed this game, do NOT restore it automatically
    if (existing[0].user_removed) {
      const err = new Error(`"${game.title}" was previously removed. Re-add it?`)
      err.code = 'USER_REMOVED'
      err.existingId = id
      throw err
    }
    // Row exists but was auto-removed (e.g. sync marked as deleted) — restore it
    await conn.execute(
      `UPDATE games SET 
        title=$1, platform=$2, install_path=$3, cover_url=$4, hero_url=$5, logo_url=$6,
        playtime_minutes=$7, progress_percent=$8, last_played=$9, status=$10,
        raw_file_name=$11, raw_folder_name=$12, metadata_fetched=$13, normalized_title=$14,
        rating=$15, release_date=$16, favorite=$17, steam_app_id=$18, last_seen_installed=$19,
        gog_id=$20, epic_id=$21, ubisoft_id=$22, updated_at=$23, deleted=0, user_removed=0, is_new=1
       WHERE id=$24`,
      [
        game.title,
        game.platform || "PC",
        game.install_path || "",
        game.cover_url || "",
        game.hero_url || "",
        game.logo_url || "",
        game.playtime_minutes || 0,
        game.progress_percent || 0,
        game.last_played || "",
        game.status || "not_installed",
        game.raw_file_name || "",
        game.raw_folder_name || "",
        game.metadata_fetched ? 1 : 0,
        game.normalized_title || "",
        game.rating || 0,
        game.release_date || "",
        game.favorite ? 1 : 0,
        game.steam_app_id || "",
        game.last_seen_installed || "",
        game.gog_id || "",
        game.epic_id || "",
        game.ubisoft_id || "",
        game.updated_at || new Date().toISOString(),
        id,
      ]
    )
  } else {
    await conn.execute(
      `INSERT INTO games (id, title, platform, install_path, cover_url, hero_url, logo_url, playtime_minutes, progress_percent, last_played, status, raw_file_name, raw_folder_name, metadata_fetched, normalized_title, rating, release_date, favorite, steam_app_id, last_seen_installed, gog_id, epic_id, ubisoft_id, updated_at, deleted, is_new)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
      [
        id,
        game.title,
        game.platform || "PC",
        game.install_path || "",
        game.cover_url || "",
        game.hero_url || "",
        game.logo_url || "",
        game.playtime_minutes || 0,
        game.progress_percent || 0,
        game.last_played || "",
        game.status || "not_installed",
        game.raw_file_name || "",
        game.raw_folder_name || "",
        game.metadata_fetched ? 1 : 0,
        game.normalized_title || "",
        game.rating || 0,
        game.release_date || "",
        game.favorite ? 1 : 0,
        game.steam_app_id || "",
        game.last_seen_installed || "",
        game.gog_id || "",
        game.epic_id || "",
        game.ubisoft_id || "",
        game.updated_at || new Date().toISOString(),
        game.deleted ? 1 : 0,
        game.is_new ? 1 : 0,
      ],
    )
  }
  return { ...game, id }
}

async function tauriUpdate(id, updates) {
  await ensureTablesExist()
  const conn = await getDb()
  const fields = Object.keys(updates)
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(", ")
  await conn.execute(`UPDATE games SET ${setClause} WHERE id = $1`, [
    id,
    ...fields.map((f) => updates[f]),
  ])
}

async function tauriRemove(id) {
  await ensureTablesExist()
  const conn = await getDb()
  const updated_at = new Date().toISOString()
  await conn.execute(
    "UPDATE games SET user_removed = 1, status = 'not_installed', deleted = 1, updated_at = $2 WHERE id = $1",
    [id, updated_at],
  )
}

// ─── In-memory fallback (browser dev mode) ───

let memoryStore = null
let memoryGameDetailsCache = new Map()

function getMemoryStore() {
  if (memoryStore) return memoryStore
  memoryStore = []
  return memoryStore
}

// ─── Public API ───

export async function initDb() {
  if (isTauri) {
    await initTauriDb()
  } else {
    getMemoryStore()
  }
}

export async function getAllGames() {
  if (isTauri) {
    return (await tauriGetAll()).map(enrichGame)
  }
  return getMemoryStore().filter(g => !g.deleted).map(enrichGame)
}

/**
 * One-time backfill: copies developers/publishers/themes from
 * game_details_cache into the main games table for games that
 * were enriched before those columns existed.
 */
export async function backfillGameMetadata() {
  if (!isTauri) return 0
  await ensureTablesExist()
  const conn = await getDb()

  // Find games with metadata but empty developers column
  const games = await conn.select(
    `SELECT g.id, gdc.payload_json
     FROM games g
     JOIN game_details_cache gdc ON gdc.game_id = g.id AND gdc.provider = 'metadata'
     WHERE g.metadata_fetched = 1
       AND (g.developers IS NULL OR g.developers = '')`
  )

  let updated = 0
  for (const row of games) {
    try {
      const payload = JSON.parse(row.payload_json)
      const devs = (payload.developers || []).map(d => d.name || d).filter(Boolean).join(',')
      const pubs = (payload.publishers || []).map(p => p.name || p).filter(Boolean).join(',')
      const themes = (payload.themes || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean).join(',')
      if (devs || pubs || themes) {
        await conn.execute(
          `UPDATE games SET developers = $1, publishers = $2, themes = $3 WHERE id = $4`,
          [devs, pubs, themes, row.id]
        )
        updated++
      }
    } catch (_) {}
  }

  if (updated > 0) console.debug(`[backfillGameMetadata] Updated ${updated} games with dev/pub/theme data`)
  return updated
}

export async function getDeletedGames() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    return conn.select("SELECT * FROM games WHERE deleted = 1")
  }
  return getMemoryStore().filter(g => g.deleted)
}

export async function addGame({
  id,
  title,
  install_path,
  platform,
  raw_file_name,
  raw_folder_name,
  gameData,
  steam_app_id,
  gog_id,
  epic_id,
  ubisoft_id,
  last_seen_installed,
  status,
  playtime_minutes,
  progress_percent,
  last_played,
  cover_url,
  hero_url,
  logo_url,
  normalized_title,
}) {
  // Derive ID from exact pass, or default to slugified path/title
  let resolvedId = id ? String(id) : null

  let existing = null
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    
    if (resolvedId) {
      const rows = await conn.select("SELECT * FROM games WHERE id = $1", [resolvedId])
      if (rows && rows.length > 0) existing = rows[0]
    }
    
    if (!existing) {
      const allRows = await conn.select("SELECT * FROM games WHERE deleted = 0")
      const normInput = (normalized_title !== undefined ? normalized_title : (gameData?.name || title || '')).toLowerCase().replace(/[^a-z0-9]+/g, "")
      
      let bestMatch = null
      for (const row of allRows) {
        const rowNorm = (row.normalized_title || row.title || '').toLowerCase().replace(/[^a-z0-9]+/g, "")
        if (rowNorm && rowNorm === normInput) {
          if (!bestMatch) {
            bestMatch = row
          } else if (bestMatch.status === 'installed' && row.status === 'not_installed') {
            bestMatch = row
          }
        }
      }
      
      if (bestMatch) {
        existing = bestMatch
        resolvedId = existing.id
      }
    }
  } else {
    const store = getMemoryStore()
    if (resolvedId) {
      existing = store.find((g) => g.id === resolvedId)
    }
    if (!existing) {
      const normInput = (normalized_title !== undefined ? normalized_title : (gameData?.name || title || '')).toLowerCase().replace(/[^a-z0-9]+/g, "")
      let bestMatch = null
      for (const row of store) {
        if (row.deleted) continue
        const rowNorm = (row.normalized_title || row.title || '').toLowerCase().replace(/[^a-z0-9]+/g, "")
        if (rowNorm && rowNorm === normInput) {
          if (!bestMatch) {
            bestMatch = row
          } else if (bestMatch.status === 'installed' && row.status === 'not_installed') {
            bestMatch = row
          }
        }
      }
      if (bestMatch) {
        existing = bestMatch
        resolvedId = existing.id
      }
    }
  }

  if (!resolvedId) {
    resolvedId = (install_path || title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(-80)
  }

  const game = {
    id: resolvedId,
    title: title || existing?.title,
    platform: platform || existing?.platform || "PC",
    install_path: install_path !== undefined ? install_path : (existing?.install_path || ""),
    cover_url: cover_url !== undefined ? cover_url : (gameData?.cover || existing?.cover_url || ""),
    hero_url: hero_url !== undefined ? hero_url : (gameData?.hero || existing?.hero_url || ""),
    logo_url: logo_url !== undefined ? logo_url : (gameData?.logo || existing?.logo_url || ""),
    playtime_minutes: playtime_minutes !== undefined ? playtime_minutes : (existing?.playtime_minutes || 0),
    progress_percent: progress_percent !== undefined ? progress_percent : (existing?.progress_percent || 0),
    last_played: last_played !== undefined ? last_played : (existing?.last_played || ""),
    status: status !== undefined ? status : (install_path ? "installed" : (existing?.status || "not_installed")),
    raw_file_name: raw_file_name !== undefined ? raw_file_name : (existing?.raw_file_name || ""),
    raw_folder_name: raw_folder_name !== undefined ? raw_folder_name : (existing?.raw_folder_name || ""),
    metadata_fetched: (gameData || cover_url || normalized_title) ? 1 : (existing?.metadata_fetched || 0),
    normalized_title: normalized_title !== undefined ? normalized_title : (gameData?.name || existing?.normalized_title || ""),
    rating: existing?.rating || 0,
    release_date: gameData?.releaseDate || gameData?.release_date || existing?.release_date || "",
    steam_app_id: steam_app_id !== undefined ? String(steam_app_id) : (existing?.steam_app_id || ""),
    gog_id: gog_id !== undefined ? String(gog_id) : (existing?.gog_id || ""),
    epic_id: epic_id !== undefined ? String(epic_id) : (existing?.epic_id || ""),
    ubisoft_id: ubisoft_id !== undefined ? String(ubisoft_id) : (existing?.ubisoft_id || ""),
    last_seen_installed: last_seen_installed !== undefined ? last_seen_installed : (existing?.last_seen_installed || ""),
    updated_at: new Date().toISOString(),
    deleted: 0,
    is_new: existing?.is_new !== undefined ? existing.is_new : 1,
    favorite: existing?.favorite || 0,
    franchise: existing?.franchise || "",
    franchise_slug: existing?.franchise_slug || "",
    genres: existing?.genres || "",
    themes: existing?.themes || "",
    developers: existing?.developers || "",
    publishers: existing?.publishers || "",
    collections: existing?.collections || "",
    franchises: existing?.franchises || "",
    imported_playtime_minutes: existing?.imported_playtime_minutes || 0,
    user_collection: existing?.user_collection || "",
  }

  if (isTauri) {
    await tauriAdd(game)
  } else {
    const store = getMemoryStore()
    const existing = store.find((g) => g.id === game.id)
    if (!existing) {
      store.push(game)
    } else {
      Object.assign(existing, game)
    }
  }

  return enrichGame(game)
}

export async function updateGame(id, updates) {
  if (!updates.updated_at) {
    updates.updated_at = new Date().toISOString()
  }
  if (isTauri) {
    await tauriUpdate(id, updates)
  } else {
    const store = getMemoryStore()
    const idx = store.findIndex((g) => g.id === id)
    if (idx !== -1) Object.assign(store[idx], updates)
  }
}

export async function incrementPlaytime(id, minutes) {
  const updated_at = new Date().toISOString()
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    await conn.execute(
      'UPDATE games SET playtime_minutes = playtime_minutes + $1, last_played = $2, updated_at = $2 WHERE id = $3',
      [minutes, updated_at, id]
    )
  } else {
    const store = getMemoryStore()
    const game = store.find((g) => g.id === id)
    if (game) {
      game.playtime_minutes = (game.playtime_minutes || 0) + minutes
      game.last_played = updated_at
      game.updated_at = updated_at
    }
  }
}

export async function removeGame(id) {
  if (isTauri) {
    await tauriRemove(id)
  } else {
    const store = getMemoryStore()
    const idx = store.findIndex((g) => g.id === id)
    if (idx !== -1) {
       store[idx].deleted = 1
       store[idx].user_removed = 1
       store[idx].status = 'not_installed'
       store[idx].updated_at = new Date().toISOString()
    }
  }
}

/**
 * Force-restore a game that the user previously removed.
 * Only called after explicit user confirmation in the UI.
 */
export async function restoreUserRemovedGame(id, updates = {}) {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const updated_at = new Date().toISOString()
    await conn.execute(
      `UPDATE games SET user_removed=0, deleted=0, status='installed', updated_at=$1,
        install_path=COALESCE(NULLIF($2,''), install_path),
        raw_file_name=COALESCE(NULLIF($3,''), raw_file_name),
        raw_folder_name=COALESCE(NULLIF($4,''), raw_folder_name)
       WHERE id=$5`,
      [
        updated_at,
        updates.install_path || '',
        updates.raw_file_name || '',
        updates.raw_folder_name || '',
        id
      ]
    )
  } else {
    const store = getMemoryStore()
    const idx = store.findIndex((g) => g.id === id)
    if (idx !== -1) {
      Object.assign(store[idx], { user_removed: 0, deleted: 0, status: 'installed', updated_at: new Date().toISOString(), ...updates })
    }
  }
}

// ─── Metadata ───

export async function getUnenrichedGames() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    return conn.select("SELECT * FROM games WHERE metadata_fetched = 0")
  }
  return getMemoryStore().filter((g) => !g.metadata_fetched)
}

/**
 * Returns games that were already enriched (metadata_fetched = 1) but are
 * still missing IGDB collection/franchise data — eligible for a targeted re-fetch.
 */
export async function getGamesNeedingCollectionEnrich() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    return conn.select(`
      SELECT * FROM games
      WHERE deleted = 0 AND user_removed = 0
        AND metadata_fetched = 1
        AND (franchise   = '' OR franchise   IS NULL)
        AND (collections = '' OR collections IS NULL OR collections = '[]')
        AND (franchises  = '' OR franchises  IS NULL OR franchises  = '[]')
    `)
  }
  return getMemoryStore().filter(g =>
    !g.deleted && !g.user_removed && g.metadata_fetched &&
    !g.franchise &&
    (!g.collections || g.collections === '[]') &&
    (!g.franchises || g.franchises === '[]')
  )
}

export async function updateGameMetadata(id, metadata) {
  return updateGame(id, metadata)
}

export async function markGameSeen(id) {
  return updateGame(id, { is_new: 0 })
}

/**
 * Clear franchise/collection data for a game so it becomes eligible for
 * re-enrichment on the next pass (sets all franchise fields to NULL/empty).
 */
export async function clearGameFranchise(id) {
  return updateGame(id, {
    franchise: '',
    franchise_slug: '',
    franchises: null,
    collections: null,
  })
}

/**
 * Set a user-defined collection override for a game.
 * When set, this takes priority over IGDB-derived collections in grouping.
 */
export async function setGameCollection(id, collectionName) {
  return updateGame(id, { user_collection: collectionName || '' })
}

/**
 * Clear the user-defined collection override, reverting to auto-detected grouping.
 */
export async function clearGameCollection(id) {
  return updateGame(id, { user_collection: '' })
}

// ─── Game Folders ───

let memoryFolders = []

export async function getFolders() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    return conn.select("SELECT * FROM game_folders ORDER BY id")
  }
  return [...memoryFolders]
}

export async function addFolder(folderPath) {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    await conn.execute(
      "INSERT OR IGNORE INTO game_folders (path) VALUES ($1)",
      [folderPath],
    )
  } else {
    if (!memoryFolders.find((f) => f.path === folderPath)) {
      memoryFolders.push({ id: memoryFolders.length + 1, path: folderPath })
    }
  }
}

export async function removeFolder(id) {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    await conn.execute("DELETE FROM game_folders WHERE id = $1", [id])
  } else {
    memoryFolders = memoryFolders.filter((f) => f.id !== id)
  }
}

// ─── Sessions ───

export async function addSession(gameId, startTime, endTime, durationMinutes) {
  if (!isTauri || durationMinutes < 1) return
  await ensureTablesExist()
  const conn = await getDb()
  await conn.execute(
    'INSERT INTO sessions (game_id, start_time, end_time, duration_minutes) VALUES ($1, $2, $3, $4)',
    [gameId, startTime, endTime, durationMinutes],
  )
}

export async function getGameSessions(gameId) {
  if (!isTauri) return []
  await ensureTablesExist()
  const conn = await getDb()
  return conn.select(
    'SELECT * FROM sessions WHERE game_id = $1 ORDER BY start_time DESC',
    [gameId],
  )
}

export async function getAllSessions() {
  if (!isTauri) return []
  await ensureTablesExist()
  const conn = await getDb()
  return conn.select('SELECT * FROM sessions ORDER BY start_time DESC')
}

export async function getGameBySteamAppId(steamAppId) {
  const id = String(steamAppId)
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      "SELECT * FROM games WHERE steam_app_id = $1 LIMIT 1",
      [id],
    )
    return rows[0] ? enrichGame(rows[0]) : null
  }
  return getMemoryStore().find((g) => String(g.steam_app_id) === id) || null
}

/**
 * Returns a Set of steam_app_id strings the user has explicitly removed,
 * so the sync loop can skip re-adding them.
 */
export async function getUserRemovedSteamIds() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      "SELECT steam_app_id FROM games WHERE user_removed = 1 AND steam_app_id != ''",
    )
    return new Set(rows.map((r) => String(r.steam_app_id)))
  }
  return new Set()
}

/**
 * Returns a Set of gog_id strings the user has explicitly removed.
 */
export async function getUserRemovedGogIds() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      "SELECT gog_id FROM games WHERE user_removed = 1 AND gog_id != ''",
    )
    return new Set(rows.map((r) => String(r.gog_id)))
  }
  return new Set()
}

/**
 * Returns a Set of epic_id strings the user has explicitly removed.
 */
export async function getUserRemovedEpicIds() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      "SELECT epic_id FROM games WHERE user_removed = 1 AND epic_id != ''",
    )
    return new Set(rows.map((r) => String(r.epic_id)))
  }
  return new Set()
}

/**
 * Returns a Set of ubisoft_id strings the user has explicitly removed.
 */
export async function getUserRemovedUbisoftIds() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      "SELECT ubisoft_id FROM games WHERE user_removed = 1 AND ubisoft_id != ''",
    )
    return new Set(rows.map((r) => String(r.ubisoft_id)))
  }
  return new Set()
}

export async function gameExistsByPath(installPath) {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      "SELECT COUNT(*) as count FROM games WHERE install_path = $1",
      [installPath],
    )
    return rows[0].count > 0
  }
  return getMemoryStore().some((g) => g.install_path === installPath)
}

/**
 * Returns a Set of install_path strings the user has explicitly removed,
 * so the sync loop can skip re-adding them.
 */
export async function getUserRemovedPaths() {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      "SELECT install_path FROM games WHERE user_removed = 1 AND install_path != ''"
    )
    return new Set(rows.map((r) => r.install_path.toLowerCase()))
  }
  return new Set()
}

// ─── HLTB Cache ───

export async function getHltbCache(gameId) {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      'SELECT * FROM hltb_cache WHERE game_id = $1',
      [gameId]
    )
    if (!rows[0]) return null
    const r = rows[0]
    return {
      available: !!r.available,
      main: r.main_hours,
      mainExtra: r.main_extra_hours,
      completionist: r.completionist_hours,
      lastFetched: r.last_fetched || '',
    }
  }
  return null
}

// ─── IGDB Details Cache ───

export async function getIgdbCache(gameTitle) {
  if (!isTauri) return null
  await ensureTablesExist()
  const conn = await getDb()
  const rows = await conn.select('SELECT * FROM igdb_cache WHERE game_title = $1', [gameTitle])
  if (!rows[0]) return null
  const r = rows[0]
  try {
    return {
      igdb_id: r.igdb_id,
      summary: r.summary || '',
      genres: r.genres ? JSON.parse(r.genres) : [],
      themes: r.themes ? JSON.parse(r.themes) : [],
      ageRatings: r.age_ratings ? JSON.parse(r.age_ratings) : [],
      similarGames: r.similar_games ? JSON.parse(r.similar_games) : [],
      franchise: r.franchise || null,
      collections: r.collections ? JSON.parse(r.collections) : [],
      franchises: r.franchises ? JSON.parse(r.franchises) : [],
      lastFetched: r.last_fetched || '',
    }
  } catch {
    return null
  }
}

export async function setIgdbCache(gameTitle, data) {
  if (!isTauri) return
  await ensureTablesExist()
  const conn = await getDb()
  await conn.execute(
    `INSERT INTO igdb_cache (game_title, igdb_id, summary, genres, themes, age_ratings, similar_games, franchise, collections, franchises, last_fetched)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT(game_title) DO UPDATE SET
       igdb_id = excluded.igdb_id,
       summary = excluded.summary,
       genres = excluded.genres,
       themes = excluded.themes,
       age_ratings = excluded.age_ratings,
       similar_games = excluded.similar_games,
       franchise = excluded.franchise,
       collections = excluded.collections,
       franchises = excluded.franchises,
       last_fetched = excluded.last_fetched`,
    [
      gameTitle,
      data.igdb_id || 0,
      data.summary || '',
      JSON.stringify(data.genres || []),
      JSON.stringify(data.themes || []),
      JSON.stringify(data.ageRatings || []),
      JSON.stringify(data.similarGames || []),
      data.franchise || '',
      JSON.stringify(data.collections || []),
      JSON.stringify(data.franchises || []),
      new Date().toISOString(),
    ]
  )
}

export async function setHltbCache(gameId, data) {
  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    await conn.execute(
      `INSERT INTO hltb_cache (game_id, available, main_hours, main_extra_hours, completionist_hours, last_fetched)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(game_id) DO UPDATE SET
         available = excluded.available,
         main_hours = excluded.main_hours,
         main_extra_hours = excluded.main_extra_hours,
         completionist_hours = excluded.completionist_hours,
         last_fetched = excluded.last_fetched`,
      [
        gameId,
        data.available ? 1 : 0,
        data.main || 0,
        data.mainExtra || 0,
        data.completionist || 0,
        new Date().toISOString(),
      ]
    )
  }
}

// ─── Generic Game Detail Cache ───

function getMemoryGameDetailsCacheKey(gameId, provider) {
  return `${gameId}::${provider}`
}

export async function getGameDetailsCache(gameId, provider) {
  if (!gameId || !provider) return null

  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const rows = await conn.select(
      `SELECT game_id, provider, cache_key, payload_json, cached_at, stale_after
       FROM game_details_cache
       WHERE game_id = $1 AND provider = $2`,
      [gameId, provider],
    )
    const row = rows[0]
    if (!row?.payload_json) return null

    try {
      return {
        gameId: row.game_id,
        provider: row.provider,
        cacheKey: row.cache_key || '',
        payload: JSON.parse(row.payload_json),
        cachedAt: row.cached_at || '',
        staleAfter: row.stale_after || '',
      }
    } catch {
      return null
    }
  }

  return memoryGameDetailsCache.get(
    getMemoryGameDetailsCacheKey(gameId, provider),
  ) || null
}

export async function setGameDetailsCache({
  gameId,
  provider,
  payload,
  cacheKey = '',
  cachedAt,
  staleAfter,
}) {
  if (!gameId || !provider) return

  const normalizedCachedAt = cachedAt || new Date().toISOString()
  const entry = {
    gameId,
    provider,
    cacheKey,
    payload,
    cachedAt: normalizedCachedAt,
    staleAfter: staleAfter || '',
  }

  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    await conn.execute(
      `INSERT INTO game_details_cache (game_id, provider, cache_key, payload_json, cached_at, stale_after)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(game_id, provider) DO UPDATE SET
         cache_key = excluded.cache_key,
         payload_json = excluded.payload_json,
         cached_at = excluded.cached_at,
         stale_after = excluded.stale_after`,
      [
        gameId,
        provider,
        cacheKey,
        JSON.stringify(payload ?? null),
        normalizedCachedAt,
        staleAfter || '',
      ],
    )
    return
  }

  memoryGameDetailsCache.set(
    getMemoryGameDetailsCacheKey(gameId, provider),
    entry,
  )
}

export async function clearGameDetailsCache(gameId, provider) {
  if (!gameId || !provider) return

  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    await conn.execute(
      'DELETE FROM game_details_cache WHERE game_id = $1 AND provider = $2',
      [gameId, provider],
    )
    return
  }

  memoryGameDetailsCache.delete(getMemoryGameDetailsCacheKey(gameId, provider))
}

export async function clearGameDetailsCacheByProviders(providers = []) {
  const normalizedProviders = [...new Set((providers || []).filter(Boolean))]
  if (normalizedProviders.length === 0) return

  if (isTauri) {
    await ensureTablesExist()
    const conn = await getDb()
    const placeholders = normalizedProviders
      .map((_, index) => `$${index + 1}`)
      .join(', ')
    await conn.execute(
      `DELETE FROM game_details_cache WHERE provider IN (${placeholders})`,
      normalizedProviders,
    )
    return
  }

  for (const key of [...memoryGameDetailsCache.keys()]) {
    const provider = key.split('::')[1]
    if (normalizedProviders.includes(provider)) {
      memoryGameDetailsCache.delete(key)
    }
  }
}
