import { invoke } from '@tauri-apps/api/core'
import { getIgdbCache, setIgdbCache, setGameDetailsCache } from './db'
import { supabase } from './supabase'
import { mapLegacyIgdbCacheToMetadata, buildMetadataCacheKey, GAME_DETAIL_PROVIDERS, GAME_DETAIL_TTLS, getStaleAfterIso, normalizeMetadataPayload } from './gameDetailCache'

const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

const API_KEY = "87cb7d1095524cb78055146f0a22adaf"
const BASE_URL = "https://api.rawg.io/api"
const IGDB_SHARED_CACHE_DISABLED_KEY = 'launchdeck:igdb_shared_cache_disabled_until'
const IGDB_SHARED_CACHE_DISABLED_TTL_MS = 1000 * 60 * 60 * 12

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function isMissingSharedCacheError(error, status) {
  const details = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return (
    status === 404 ||
    details.includes('igdb_details_cache') ||
    (details.includes('relation') && details.includes('does not exist')) ||
    details.includes('not found') ||
    details.includes('schema cache')
  )
}

function readSharedCacheDisabledUntil() {
  if (typeof localStorage === 'undefined') return 0
  const value = Number(localStorage.getItem(IGDB_SHARED_CACHE_DISABLED_KEY) || 0)
  return Number.isFinite(value) ? value : 0
}

function clearSharedCacheDisable() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(IGDB_SHARED_CACHE_DISABLED_KEY)
  } catch {}
}

let igdbSharedCacheAvailable = (() => {
  const disabledUntil = readSharedCacheDisabledUntil()
  if (!disabledUntil) return true
  if (disabledUntil <= Date.now()) {
    clearSharedCacheDisable()
    return true
  }
  return false
})()

function disableSharedIgdbCache(reason) {
  if (!igdbSharedCacheAvailable) return
  igdbSharedCacheAvailable = false
  try {
    localStorage.setItem(
      IGDB_SHARED_CACHE_DISABLED_KEY,
      String(Date.now() + IGDB_SHARED_CACHE_DISABLED_TTL_MS),
    )
  } catch {}
  console.warn(`IGDB shared cache disabled temporarily: ${reason}`)
}

// Search RAWG for a game by name
export async function searchGame(query) {
  const url = `${BASE_URL}/games?key=${API_KEY}&search=${encodeURIComponent(query)}&page_size=5`
  const res = await fetch(url)
  if (!res.ok) return []
  const data = await res.json()
  return data.results || []
}

// Word-overlap similarity score with strict numeric sequence enforcement
function similarity(a, b) {
  // Extract all digit sequences to catch sequel mismatch (e.g. 2K26 vs 2K20)
  const digitsA = (a.match(/\d+/g) || []).join(',')
  const digitsB = (b.match(/\d+/g) || []).join(',')
  
  if (digitsA && digitsB && digitsA !== digitsB) {
    // Both titles contain numbers, but they don't match. 
    // They are almost certainly different sequels (e.g. F1 22 vs F1 23).
    return 0
  }

  const normalize = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
  const wordsA = normalize(a)
  const wordsB = normalize(b)
  if (wordsA.length === 0 || wordsB.length === 0) return 0

  const setB = new Set(wordsB)
  const matches = wordsA.filter((w) => setB.has(w)).length
  return matches / Math.max(wordsA.length, wordsB.length)
}

// Pick the best match from RAWG results for a given search term
export function bestMatch(results, searchTerm) {
  if (!results || results.length === 0) return null

  let best = null
  let bestScore = 0

  for (const r of results) {
    const score = similarity(searchTerm, r.name)
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }

  // Require at least 50% word overlap to consider it a match
  return bestScore >= 0.5 ? best : null
}

function normalizeMediaTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function isExactOrSeriesTitle(expected, candidate) {
  const left = normalizeMediaTitle(expected)
  const right = normalizeMediaTitle(candidate)
  if (!left || !right) return false
  return left === right || right.endsWith(` ${left}`)
}

/**
 * Fetch metadata for a single game from RAWG.
 * Tries multiple search strategies in priority order.
 *
 * @param {object} game - Game row from DB
 * @returns {object|null} - { normalized_title, cover_url, rating, release_date } or null
 */
export async function fetchGameMetadata(game) {
  // Search strategies in priority order
  const queries = [game.raw_folder_name, game.title, game.raw_file_name].filter(
    Boolean,
  )

  for (const query of queries) {
    try {
      const results = await searchGame(query)
      const match = bestMatch(results, query)

      if (match) {
        return {
          normalized_title: match.name || "",
          cover_url: match.background_image || "",
          rating: match.rating || 0,
          release_date: match.released || "",
        }
      }
    } catch (err) {
      console.error(`RAWG search failed for "${query}":`, err)
    }

    await delay(200)
  }

  return null
}

/**
 * Fetch full details for a game from RAWG (by ID).
 * This endpoint provides developers, publishers, and esrb_rating.
 */
export async function fetchRawgDetails(id) {
  try {
    const res = await fetch(`${BASE_URL}/games/${id}?key=${API_KEY}`)
    if (res.ok) {
      return await res.json()
    }
  } catch (err) {
    console.error(`RAWG details fetch failed for ${id}:`, err)
  }
  return null
}

export async function fetchRawgMediaByTitle(title) {
  try {
    const results = await searchGame(title)
    const match = bestMatch(results, title)
    if (!match?.id || !isExactOrSeriesTitle(title, match.name)) return null

    const screenshotsRes = await fetch(`${BASE_URL}/games/${match.id}/screenshots?key=${API_KEY}`)
    const screenshotsData = screenshotsRes.ok ? await screenshotsRes.json() : null
    const screenshots = (screenshotsData?.results || [])
      .map((shot) => shot.image)
      .filter(Boolean)

    return {
      isExactMatch: true,
      matchedTitle: match.name,
      screenshots,
      artworks: match.background_image ? [match.background_image] : [],
    }
  } catch (err) {
    console.error(`RAWG media fetch failed for "${title}":`, err)
    return null
  }
}

/**
 * Quick RAWG search for scan modal previews.
 * Returns { cover_url, name } for the best match, or null.
 */
export async function fetchPreviewCover(title) {
  try {
    const results = await searchGame(title)
    const match = bestMatch(results, title)
    if (match) {
      return {
        cover_url: match.background_image || "",
        name: match.name || title,
      }
    }
  } catch (err) {
    console.error(`Preview search failed for "${title}":`, err)
  }
  return null
}

/**
 * Search RAWG and return multiple cover options for a game.
 * Returns array of { name, cover_url, rating, released }.
 */
export async function searchCovers(query) {
  try {
    const results = await searchGame(query)
    return (results || [])
      .filter((r) => r.background_image)
      .map((r) => ({
        name: r.name,
        cover_url: r.background_image,
        rating: r.rating || 0,
        released: r.released || "",
      }))
  } catch (err) {
    console.error(`Cover search failed for "${query}":`, err)
    return []
  }
}

/**
 * Fetch full game details from IGDB (primary description + rich metadata).
 * Cache-first: local SQLite → Supabase shared cache → IGDB API.
 * Returns object with description_raw, genres, themes, ageRatings, similarGames, franchise.
 */
export async function fetchGameDetails(query, options = {}) {
  if (!isTauri) return null
  const { forceRefresh = false } = options

  // 1. Check local SQLite cache
  if (!forceRefresh) {
    try {
      const cached = await getIgdbCache(query)
      const mapped = mapLegacyIgdbCacheToMetadata(cached)
      if (mapped) return mapped
    } catch (e) {
      console.warn('IGDB local cache read failed:', e)
    }
  }

  {
    // 2. Check Supabase shared cache
  if (!forceRefresh && igdbSharedCacheAvailable) {
    try {
      const { data, error, status } = await supabase
        .from('igdb_details_cache')
        .select('*')
        .eq('game_title', query)
        .maybeSingle()
      if (error) {
        if (isMissingSharedCacheError(error, status)) {
          disableSharedIgdbCache(error.message || 'missing igdb_details_cache table')
        } else {
          console.warn('IGDB shared cache read failed:', error)
        }
      } else if (data && data.platforms !== undefined) {
        const parsed = {
        summary: data.summary || '',
        storyline: data.storyline || '',
        developers: data.developers || [],
        publishers: data.publishers || [],
        portingStudios: data.porting_studios || [],
        supportingStudios: data.supporting_studios || [],
        genres: data.genres || [],
        themes: data.themes || [],
        platforms: data.platforms || [],
        gameModes: data.game_modes || [],
        playerPerspectives: data.player_perspectives || [],
        engines: data.engines || [],
        ageRatings: data.age_ratings || [],
        primaryAgeRating: data.primary_age_rating || null,
        similarGames: data.similar_games || [],
        franchise: data.franchise || null,
        collections: data.collections || [],
        franchises: data.franchises || [],
        screenshots: data.screenshots || [],
        artworks: data.artworks || [],
        websites: data.websites || [],
        releaseDate: data.release_date || '',
        igdb_id: data.igdb_id || 0,
      }
      // Populate local cache from Supabase hit
      setIgdbCache(query, parsed).catch(() => {})
      return mapLegacyIgdbCacheToMetadata(parsed)
    }
    } catch (error) {
      console.warn('IGDB shared cache request failed:', error)
    }
  }
    // Supabase table may not exist yet — fail silently
  }

  // 3. Fetch from IGDB API
  let match = null
  try {
    const results = await invoke('search_igdb_games', { query })
    if (results && results.length > 0) {
      match = results[0]
    }
  } catch (err) {
    console.warn(`IGDB fetch details failed for "${query}":`, err)
  }

  let summary = match?.summary || ''
  let storyline = match?.storyline || ''
  let releaseDate = match?.firstReleaseDate ? new Date(match.firstReleaseDate * 1000).toISOString().split('T')[0] : ''
  let genres = match?.genres || []
  let themes = match?.themes || []
  let platforms = match?.platforms || []
  let gameModes = match?.gameModes || []
  let playerPerspectives = match?.playerPerspectives || []
  let engines = match?.gameEngines || []
  let screenshots = match?.screenshots || []
  let artworks = match?.artworks || []
  let websites = match?.websites || []

  let developers = []
  let publishers = []
  let portingStudios = []
  let supportingStudios = []

  if (match?.involvedCompanies) {
    const seenDevs = new Set(), seenPubs = new Set(), seenPorts = new Set(), seenSupp = new Set()
    match.involvedCompanies.forEach(c => {
      if (!c.name) return
      if (c.isDeveloper && !seenDevs.has(c.name)) { seenDevs.add(c.name); developers.push({ name: c.name, logoUrl: c.logoUrl }); }
      if (c.isPublisher && !seenPubs.has(c.name)) { seenPubs.add(c.name); publishers.push({ name: c.name, logoUrl: c.logoUrl }); }
      if (c.isPorting && !seenPorts.has(c.name)) { seenPorts.add(c.name); portingStudios.push({ name: c.name, logoUrl: c.logoUrl }); }
      if (c.isSupporting && !seenSupp.has(c.name)) { seenSupp.add(c.name); supportingStudios.push({ name: c.name, logoUrl: c.logoUrl }); }
    })
  }

  let ageRatings = []
  let primaryAgeRating = null

  if (match?.ageRatings && match.ageRatings.length > 0) {
    ageRatings = match.ageRatings.map(r => ({
      organization: r.organization || (r.categoryId === 1 ? 'ESRB' : r.categoryId === 2 ? 'PEGI' : 'Rating'),
      rating: r.rating || r.ratingId?.toString() || '',
      coverUrl: r.coverUrl,
      descriptors: r.descriptors || []
    })).filter(r => r.rating)

    primaryAgeRating = ageRatings.find(r => r.organization === 'ESRB') ||
                       ageRatings.find(r => r.organization === 'PEGI') ||
                       ageRatings[0] || null
  }

  let similarGames = match?.similarGames || []
  let franchise = match?.franchise || null
  let matchCollections = (match?.collections || []).map(c => ({ name: c.name, slug: c.slug || '' }))
  let matchFranchises = (match?.franchises || []).map(f => ({ name: f.name, slug: f.slug || '' }))
  let igdb_id = match?.id || 0

  // 4. Fallback to RAWG for missing critical data
  if (!match || developers.length === 0 || publishers.length === 0 || ageRatings.length === 0 || !summary) {
    try {
      const rawgResults = await searchGame(query)
      const rawgMatch = bestMatch(rawgResults, query)
      if (rawgMatch && rawgMatch.id) {
        const rawgDetails = await fetchRawgDetails(rawgMatch.id)
        if (rawgDetails) {
          if (!summary) summary = rawgDetails.description_raw || rawgDetails.description || ''
          if (developers.length === 0 && rawgDetails.developers) {
            developers = rawgDetails.developers.map(d => ({ name: d.name }))
          }
          if (publishers.length === 0 && rawgDetails.publishers) {
            publishers = rawgDetails.publishers.map(p => ({ name: p.name }))
          }
          if (genres.length === 0 && rawgDetails.genres) {
            genres = rawgDetails.genres.map(g => g.name)
          }
          if (ageRatings.length === 0 && rawgDetails.esrb_rating) {
            let ratingId = 0
            if (rawgDetails.esrb_rating.id === 1) ratingId = 11 // E
            else if (rawgDetails.esrb_rating.id === 2) ratingId = 12 // E10+
            else if (rawgDetails.esrb_rating.id === 3) ratingId = 13 // T
            else if (rawgDetails.esrb_rating.id === 4) ratingId = 14 // M
            else if (rawgDetails.esrb_rating.id === 5) ratingId = 15 // AO
            else if (rawgDetails.esrb_rating.id === 6) ratingId = 6 // RP
            
            if (ratingId > 0) {
              const rb = { organization: 'ESRB', rating: ratingId.toString(), descriptors: [] }
              ageRatings = [rb]
              primaryAgeRating = rb
            }
          }
        }
      }
    } catch (e) {
      console.warn("RAWG fallback failed", e)
    }
  }

  // Abort caching if we literally found nothing
  if (!summary && developers.length === 0 && publishers.length === 0 && genres.length === 0) {
    return null
  }

  const cachePayload = {
    igdb_id,
    summary,
    storyline,
    developers,
    publishers,
    portingStudios,
    supportingStudios,
    genres,
    themes,
    platforms,
    gameModes,
    playerPerspectives,
    engines,
    ageRatings,
    primaryAgeRating,
    similarGames,
    franchise,
    collections: matchCollections,
    franchises: matchFranchises,
    screenshots,
    artworks,
    websites,
    releaseDate,
  }

  // Store in local SQLite
  setIgdbCache(query, cachePayload).catch(() => {})

  // Store in Supabase shared cache
  if (igdbSharedCacheAvailable) {
    supabase
      .from('igdb_details_cache')
      .upsert({
        game_title: query,
        igdb_id: cachePayload.igdb_id,
        summary: cachePayload.summary,
        storyline: cachePayload.storyline,
        developers: cachePayload.developers,
        publishers: cachePayload.publishers,
        porting_studios: cachePayload.portingStudios,
        supporting_studios: cachePayload.supportingStudios,
        genres: cachePayload.genres,
        themes: cachePayload.themes,
        platforms: cachePayload.platforms,
        game_modes: cachePayload.gameModes,
        player_perspectives: cachePayload.playerPerspectives,
        engines: cachePayload.engines,
        age_ratings: cachePayload.ageRatings,
        primary_age_rating: cachePayload.primaryAgeRating,
        similar_games: cachePayload.similarGames,
        franchise: cachePayload.franchise,
        collections: cachePayload.collections,
        franchises: cachePayload.franchises,
        screenshots: cachePayload.screenshots,
        artworks: cachePayload.artworks,
        websites: cachePayload.websites,
        release_date: cachePayload.releaseDate,
        last_fetched: new Date().toISOString(),
      }, { onConflict: 'game_title' })
      .then(({ error, status }) => {
        if (!error) return
        if (isMissingSharedCacheError(error, status)) {
          disableSharedIgdbCache(error.message || 'missing igdb_details_cache table')
        } else {
          console.warn('IGDB shared cache write failed:', error)
        }
      })
      .catch((error) => {
        if (isMissingSharedCacheError(error)) {
          disableSharedIgdbCache(error.message || 'missing igdb_details_cache table')
        } else {
          console.warn('IGDB shared cache write failed:', error)
        }
      })
  }

  return mapLegacyIgdbCacheToMetadata(cachePayload)
}

/**
 * Enrich all unenriched games.
 * Priority: IGDB (title/genres/franchise/date) → RAWG (rating fallback) → SteamGridDB (images).
 *
 * @param {function} getUnenriched - async fn returning games where metadata_fetched = false
 * @param {function} updateMeta - async fn(id, metadata) to save to DB
 * @param {function} [onProgress] - optional callback({ current, total })
 * @returns {{ enriched: number, failed: number, total: number }}
 */
export async function enrichAllGames(getUnenriched, updateMeta, onProgress) {
  const games = await getUnenriched()
  const total = games.length
  let enriched = 0
  let failed = 0

  for (let i = 0; i < games.length; i++) {
    const game = games[i]
    onProgress?.({ current: i + 1, total })

    const searchTitle = game.normalized_title || game.raw_folder_name || game.title || game.raw_file_name
    let igdbMeta = null
    let rawgMeta = null
    let bestCover = ''
    let heroUrl = ''
    let logoUrl = ''

    // 1. IGDB — primary source for title, genres, franchise, release_date
    if (isTauri) {
      try {
        const igdbRes = await invoke('search_igdb_games', { query: searchTitle })
        const match = _bestIgdbMatch(searchTitle, igdbRes)
        if (match) {
          // Normalize collections and franchises arrays defensively
          const matchCollections = (match.collections || []).map(c => ({ name: c.name, slug: c.slug || '' }))
          const matchFranchises = (match.franchises || []).map(f => ({ name: f.name, slug: f.slug || '' }))
          const igdbDevs = (match.involvedCompanies || [])
            .filter(c => c.isDeveloper).map(c => c.name).filter(Boolean)
          const igdbPubs = (match.involvedCompanies || [])
            .filter(c => c.isPublisher).map(c => c.name).filter(Boolean)
          igdbMeta = {
            normalized_title: match.name || '',
            genres: (match.genres || []).join(','),
            themes: (match.themes || []).join(','),
            developers: igdbDevs.join(','),
            publishers: igdbPubs.join(','),
            franchise: match.franchise || '',
            franchise_slug: match.franchiseSlug || '',
            collections: JSON.stringify(matchCollections),
            franchises: JSON.stringify(matchFranchises),
            release_date: match.firstReleaseDate
              ? new Date(match.firstReleaseDate * 1000).toISOString().split('T')[0]
              : '',
          }
          if (match.coverUrl) bestCover = match.coverUrl
          // Populate IGDB detail cache for instant loads on the game page
          const developers = (match.involvedCompanies || [])
            .filter(c => c.isDeveloper)
            .map(c => ({ name: c.name }))
          const publishers = (match.involvedCompanies || [])
            .filter(c => c.isPublisher)
            .map(c => ({ name: c.name }))

          setIgdbCache(match.name || searchTitle, {
            igdb_id: match.id || 0,
            summary: match.summary || '',
            developers,
            publishers,
            genres: match.genres || [],
            themes: match.themes || [],
            ageRatings: match.ageRatings || [],
            similarGames: match.similarGames || [],
            franchise: match.franchise || null,
            collections: matchCollections,
            franchises: matchFranchises,
          }).catch(() => {})

          // Populate game_details_cache (new system) with full metadata including
          // developers/publishers so the game detail page shows them immediately.
          const enrichedGame = { ...game, normalized_title: match.name || searchTitle }
          const metaCacheKey = buildMetadataCacheKey(enrichedGame)
          const metaPayload = normalizeMetadataPayload({
            description_raw: match.summary || '',
            storyline: match.storyline || '',
            developers,
            publishers,
            genres: match.genres || [],
            themes: match.themes || [],
            ageRatings: match.ageRatings || [],
            similarGames: match.similarGames || [],
            franchise: match.franchise || null,
            collections: matchCollections,
            franchises: matchFranchises,
          })
          if (metaPayload) {
            const now = new Date().toISOString()
            setGameDetailsCache({
              gameId: game.id,
              provider: GAME_DETAIL_PROVIDERS.metadata,
              cacheKey: metaCacheKey,
              payload: metaPayload,
              cachedAt: now,
              staleAfter: getStaleAfterIso(GAME_DETAIL_TTLS.metadata),
            }).catch(() => {})
          }
        }
      } catch (e) {
        console.warn(`IGDB enrichment failed for "${searchTitle}":`, e)
      }
    }

    // 2. RAWG — secondary, mainly for community rating; also fallback title/date
    try {
      rawgMeta = await fetchGameMetadata(game)
      if (rawgMeta && !bestCover) bestCover = rawgMeta.cover_url || ''
    } catch (_) {}

    // 3. SteamGridDB — primary source for cover/hero/logo
    const titleForImages = igdbMeta?.normalized_title || rawgMeta?.normalized_title || searchTitle
    try {
      const unified = await fetchUnifiedGameData(titleForImages)
      if (unified) {
        if (unified.cover) bestCover = unified.cover
        if (unified.hero) heroUrl = unified.hero
        if (unified.logo) logoUrl = unified.logo
      } else {
        const [grids, heroes, logos] = await Promise.all([
          searchSteamGridAssets(titleForImages, 'grids'),
          searchSteamGridAssets(titleForImages, 'heroes'),
          searchSteamGridAssets(titleForImages, 'logos'),
        ])
        if (grids?.length > 0) bestCover = grids[0].url
        if (heroes?.length > 0) heroUrl = heroes[0].url
        if (logos?.length > 0) logoUrl = logos[0].url
      }
    } catch (err) {
      console.warn(`SteamGridDB fetch failed for "${titleForImages}":`, err)
    }

    if (igdbMeta || rawgMeta || bestCover) {
      const updates = {
        normalized_title: igdbMeta?.normalized_title || rawgMeta?.normalized_title || '',
        cover_url: bestCover,
        hero_url: heroUrl,
        logo_url: logoUrl,
        rating: rawgMeta?.rating || 0,
        release_date: igdbMeta?.release_date || rawgMeta?.release_date || '',
        metadata_fetched: 1,
      }
      if (igdbMeta?.genres) updates.genres = igdbMeta.genres
      if (igdbMeta?.themes) updates.themes = igdbMeta.themes
      if (igdbMeta?.developers) updates.developers = igdbMeta.developers
      if (igdbMeta?.publishers) updates.publishers = igdbMeta.publishers
      if (igdbMeta?.franchise) updates.franchise = igdbMeta.franchise
      if (igdbMeta?.franchise_slug !== undefined) updates.franchise_slug = igdbMeta.franchise_slug
      if (igdbMeta?.collections !== undefined) updates.collections = igdbMeta.collections
      if (igdbMeta?.franchises !== undefined) updates.franchises = igdbMeta.franchises
      await updateMeta(game.id, updates)
      enriched++
    } else {
      await updateMeta(game.id, { metadata_fetched: 1 })
      failed++
    }

    await delay(200)
  }

  return { enriched, failed, total }
}

// ─── IGDB title-matching helpers ─────────────────────────────────────────────

// Roman numeral ↔ Arabic mapping for sequel matching
const _ROMAN_MAP = { i:1, ii:2, iii:3, iv:4, v:5, vi:6, vii:7, viii:8, ix:9, x:10, xi:11, xii:12, xiii:13, xiv:14, xv:15 }

function _normTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[''':]/g, '')           // strip apostrophes / colons
    .replace(/[^\w\s]/g, ' ')         // other punctuation → space
    .replace(/\b(the|a|an)\b\s*/g, '') // drop leading articles
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Jaccard similarity on word sets with numeric/roman-numeral awareness.
 * Returns 0–1; 1 = identical after normalisation.
 * Hard-rejects when both titles contain numbers but they differ
 * (prevents matching "Resident Evil 2" → "Resident Evil 4").
 */
function _titleSimilarity(query, candidate) {
  const q = _normTitle(query)
  const c = _normTitle(candidate)
  if (!q || !c) return 0
  if (q === c) return 1.0

  // Normalize roman numerals to arabic in both titles for comparison
  const normalizeNumerals = (words) => words.map(w => {
    if (_ROMAN_MAP[w]) return String(_ROMAN_MAP[w])
    return w
  })

  const qW = q.split(' ').filter(Boolean)
  const cW = c.split(' ').filter(Boolean)
  const qNorm = normalizeNumerals(qW)
  const cNorm = normalizeNumerals(cW)

  // Hard-reject if both contain numbers but they differ
  const qNums = qNorm.filter(w => /^\d+$/.test(w)).join(',')
  const cNums = cNorm.filter(w => /^\d+$/.test(w)).join(',')
  if (qNums && cNums && qNums !== cNums) return 0

  const qSet = new Set(qNorm)
  const cSet = new Set(cNorm)
  const inter = [...qSet].filter(w => cSet.has(w)).length
  const union = new Set([...qSet, ...cSet]).size
  return union === 0 ? 0 : inter / union
}

/**
 * Pick the best IGDB result for a given query title.
 * Returns null if no result scores above the minimum threshold (0.5).
 */
function _bestIgdbMatch(query, results) {
  if (!results || results.length === 0) return null
  let best = null
  let bestScore = -1
  for (const r of results) {
    const score = _titleSimilarity(query, r.name || '')
    if (score > bestScore) { bestScore = score; best = r }
  }
  return bestScore >= 0.5 ? best : null
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Targeted re-enrichment pass that ONLY updates collection/franchise fields.
 * Safe to run on already-enriched games — never touches cover/hero/logo/rating.
 *
 * Uses title-similarity scoring to reject obviously wrong IGDB results
 * (e.g. "LEGO Marvel's Avengers" matching "Marvel's Avengers", or "9th Dawn"
 * matching "Until Dawn").  A result must score ≥ 0.5 to be accepted.
 *
 * @param {object[]} games      - game rows (can be any enriched games)
 * @param {function} updateMeta - async fn(id, updates)
 * @param {function} [onProgress] - optional({ current, total })
 * @returns {{ enriched: number, total: number }}
 */
export async function enrichCollectionData(games, updateMeta, onProgress) {
  if (!isTauri) return { enriched: 0, total: 0 }

  const total = games.length
  let enriched = 0

  for (let i = 0; i < games.length; i++) {
    const game = games[i]
    if (typeof onProgress === 'function') onProgress({ current: i + 1, total })

    const searchTitle = game.normalized_title || game.raw_folder_name || game.title
    try {
      const igdbRes = await invoke('search_igdb_games', { query: searchTitle })
      const match = _bestIgdbMatch(searchTitle, igdbRes)

      if (match) {
        const matchCollections = (match.collections || []).map(c => ({ name: c.name, slug: c.slug || '' }))
        const matchFranchises  = (match.franchises  || []).map(f => ({ name: f.name, slug: f.slug || '' }))

        const updates = {}
        updates.collections    = JSON.stringify(matchCollections)
        updates.franchises     = JSON.stringify(matchFranchises)
        if (match.franchise)     updates.franchise      = match.franchise
        if (match.franchiseSlug) updates.franchise_slug = match.franchiseSlug

        await updateMeta(game.id, updates)
        enriched++
      } else {
        // No confident match — write empty arrays so this game is not retried next run
        await updateMeta(game.id, { collections: '[]', franchises: '[]' })
      }
    } catch (e) {
      console.warn(`Collection enrichment failed for "${searchTitle}":`, e)
    }

    await delay(200)
  }

  return { enriched, total }
}

/**
 * Fetch unified game data from Rust backend (RAWG + SteamGridDB)
 *
 * @param {string} query - the search string (e.g. game title)
 * @returns {Promise<object>} { id, name, releaseDate, genres, platforms, cover, hero, logo }
 */
export async function fetchUnifiedGameData(query) {
  if (!isTauri) return null
  try {
    const data = await invoke('get_game_data', { query })
    return data
  } catch (err) {
    console.error(`Backend fetch failed for "${query}":`, err)
    throw err
  }
}

/**
 * Fetch multiple assets from SteamGridDB via Rust backend
 * Returns array of { name, url } mock objects
 */
export async function searchSteamGridAssets(query, assetType = 'grids') {
  if (!isTauri) return []
  try {
    const assets = await invoke('search_steamgrid_assets', { query, assetType })
    return assets.map((c) => ({
      name: `${c.style} by ${c.author}`, 
      url: c.url,
    }))
  } catch (err) {
    console.error(`SteamGridDB search failed for "${query}":`, err)
    return []
  }
}

/**
 * Search TheGamesDB for games via Rust backend.
 * Returns normalized array of { name, released, background_image, rating }
 * matching the RAWG result shape for consistent UI handling.
 */
export async function searchGamesDB(query) {
  if (!isTauri) return []
  const results = await invoke('search_games_db', { query })
  return results.map((r) => ({
    name: r.name,
    released: r.releaseDate || '',
    background_image: r.imageUrl || null,
    rating: 0,
  }))
}

/**
 * Search Google Images via Rust backend (scrape).
 * Returns array of { url, width, height, source }
 */
export async function searchWebImages(query) {
  if (!isTauri) return []
  try {
    return await invoke('search_web_images', { query })
  } catch (err) {
    console.error(`Web image search failed for "${query}":`, err)
    return []
  }
}

/**
 * Search SteamGridDB for games via Rust backend
 * Returns array of { id, name, release_date }
 */
export async function searchSteamGridGames(query) {
  if (!isTauri) return []
  try {
    const games = await invoke('search_steamgrid_games', { query })
    return games
  } catch (err) {
    console.error(`SteamGridDB game search failed for "${query}":`, err)
    return []
  }
}
