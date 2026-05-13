/**
 * upcomingScoring.js
 *
 * Pure helpers for deriving a user's taste profile from their local library
 * and scoring upcoming games against it.
 *
 * Goal: a lightweight, deterministic "For You" ranking with no ML and no
 * external services. Weights are tunable constants at the top of the file.
 *
 * Profile shape:
 *   {
 *     genreWeights:     Map<string, number>   (normalized 0..1)
 *     devWeights:       Map<string, number>
 *     publisherWeights: Map<string, number>
 *     seriesWeights:    Map<string, number>
 *     tagWeights:       Map<string, number>
 *     themeWeights:     Map<string, number>
 *     categoryAffinity: { [category: string]: 0..1 }
 *     indieAffinity:    0..1   (how much the user plays indie titles)
 *     aaaAffinity:      0..1   (how much the user plays AAA titles)
 *     totalPlaytimeMinutes: number
 *     sampleSize:       number
 *     hasData:          boolean
 *   }
 */

// ── Scoring weights ──────────────────────────────────────────────────────────

const W = {
  GENRE:        25,
  SERIES:       40,
  DEVELOPER:    25,
  PUBLISHER:    10,
  TAG:          15,   // keywords / tags (from IGDB)
  THEME:        10,   // themes (from IGDB)
  HYPE:          6,
  POPULARITY:    4,
  QUALITY:      12,   // recommendation_base_score / quality_score signal
  RECENCY:      10,   // linear falloff 0..180 days — kept moderate so
                      // personalization signals (genre/series/dev) dominate
  EXACT_DATE:    6,   // bonus when release precision is 'day'
  PC_RELEVANT:   4,
  FOLLOWED:     30,   // user explicitly follows this title
}

// Penalties (applied as negative score)
const PEN = {
  LOW_QUALITY:      -25,   // applied when quality_score < 25
  VAGUE_DATE:        -8,   // year / quarter / tbd precision
  INDIE_MISMATCH:   -25,   // is_indie && indieAffinity < INDIE_MISMATCH_THRESHOLD
  AAA_MISMATCH:      -4,   // is_aaa && aaaAffinity < AAA_MISMATCH_THRESHOLD (weak signal)
}

// Cold-start bonuses — applied ONLY when no user taste profile exists.
// These ensure the feed is still ranked by broad-appeal quality signals.
const CS = {
  AAA_TITLE:        14,    // is_aaa games are generally more noteworthy
  SERIES:           12,    // having a series suggests a known IP
  MAJOR_STUDIO:     10,    // recognizable dev or publisher
  RICH_METADATA:     6,    // well-documented = more legitimate
  HAS_SUMMARY:       3,    // extra metadata presence signal
}

const INDIE_MISMATCH_THRESHOLD = 0.35   // penalty applies when indieAffinity < 35%
const AAA_MISMATCH_THRESHOLD   = 0.25

// Coarse category map — aggregates the many specific genres IGDB returns into
// stable higher-level affinities. Keys are lowercase; unmatched genres are
// ignored (they still flow through genreWeights).
const CATEGORY_MAP = {
  sports:     ['sports', 'sport', 'racing'],
  rpg:        ['role-playing (rpg)', 'rpg', 'role playing', 'role-playing'],
  action:     ['action', 'shooter', 'hack and slash/beat \u2019em up', 'fighting', 'platform'],
  strategy:   ['strategy', 'real time strategy (rts)', 'turn-based strategy (tbs)', 'tactical'],
  simulation: ['simulator', 'simulation'],
  puzzle:     ['puzzle', 'point-and-click'],
  adventure:  ['adventure', 'visual novel'],
  horror:     ['horror', 'survival horror'],
  indie:      ['indie'],
  mmo:        ['mmo', 'massively multiplayer'],
  music:      ['music', 'rhythm'],
  card:       ['card & board game', 'card game'],
  arcade:     ['arcade', 'pinball'],
}

// ── Utilities ────────────────────────────────────────────────────────────────

function norm(s) {
  return (s ?? '').toString().trim().toLowerCase()
}

function asArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [value]
    } catch {
      return [value]
    }
  }
  return []
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function normalizeInPlace(map) {
  let max = 0
  for (const v of map.values()) if (v > max) max = v
  if (max <= 0) return
  for (const [k, v] of map) map.set(k, v / max)
}

export function topEntries(map, limit = 5) {
  if (!map || typeof map.entries !== 'function') return []
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
}

// Determine which coarse categories a genre + theme list falls into.
// Themes are checked too because IGDB classifies horror, survival, etc. as
// themes rather than genres — without this, horror_affinity would always be 0.
function categoriesFromGenres(genres, themes) {
  const hits = new Set()
  const combined = themes ? [...genres, ...themes] : genres
  for (const g of combined) {
    const n = norm(g)
    for (const [cat, patterns] of Object.entries(CATEGORY_MAP)) {
      if (patterns.some(p => n.includes(p))) hits.add(cat)
    }
  }
  return hits
}

// ── Indie / AAA heuristics for a library game ───────────────────────────────
// We don't have `is_indie` / `is_aaa` on local library rows, so we infer
// from the enriched metadata (publisher prominence, genre tags).
const INDIE_GENRE_HINTS = new Set(['indie', 'pixel graphics', 'roguelike', 'roguelite'])
const MAJOR_LOCAL_PUBLISHERS = new Set([
  'activision', 'activision blizzard', 'blizzard entertainment', 'blizzard',
  'bethesda softworks', 'bethesda', 'bethesda game studios', 'zenimax',
  'id software', 'arkane studios',
  'ea', 'electronic arts', 'ea sports', 'dice', 'ea dice',
  'bioware', 'criterion games', 'respawn entertainment',
  'ubisoft', 'ubisoft entertainment', 'ubisoft montreal', 'ubisoft quebec',
  'sony interactive entertainment', 'sony', 'playstation', 'playstation studios',
  'naughty dog', 'insomniac games', 'guerrilla games', 'santa monica studio',
  'sucker punch productions', 'polyphony digital',
  'microsoft', 'xbox game studios', 'microsoft game studios', 'microsoft studios',
  '343 industries', 'the coalition', 'playground games', 'turn 10 studios',
  'obsidian entertainment', 'double fine productions',
  'nintendo', 'nintendo epd', 'game freak', 'the pokémon company',
  'rockstar games', 'rockstar north', 'rockstar san diego',
  'take-two interactive', '2k', '2k games', '2k sports',
  'square enix', 'capcom', 'konami', 'sega', 'atlus',
  'bandai namco', 'bandai namco entertainment', 'bandai namco studios',
  'cd projekt', 'cd projekt red',
  'fromsoftware', 'from software',
  'kojima productions',
  'warner bros', 'warner bros. games', 'warner bros. interactive entertainment',
  'wb games', 'tt games', 'netherrealm studios',
  'paradox interactive', 'paradox development studio',
  'valve', 'valve corporation',
  'epic games',
  'riot games',
  'bungie',
  'thq nordic', 'deep silver', 'koch media', 'plaion',
  'focus entertainment', 'focus home interactive',
  'devolver digital',
  'team17',
  'techland',
  'codemasters',
  'koei tecmo', 'tecmo koei', 'omega force',
  'netease', 'tencent',
  'mihoyo', 'hoyoverse',
])

function localGameScaleHint(game) {
  const pubs   = asArray(game.publisher_names ?? game.publishers).map(norm)
  const devs   = asArray(game.developer_names ?? game.developers).map(norm)
  const genres = asArray(game.genres).map(norm)

  const bigPublisher = pubs.some(p => MAJOR_LOCAL_PUBLISHERS.has(p))
                    || devs.some(d => MAJOR_LOCAL_PUBLISHERS.has(d))
  // Only classify as indie when the genre explicitly says so — not by
  // absence of a major publisher (which wrongly tagged 90%+ of games).
  const indieGenre   = genres.some(g => INDIE_GENRE_HINTS.has(g))

  return {
    looksAaa:   bigPublisher,
    looksIndie: indieGenre && !bigPublisher,
  }
}

// ── Profile extraction ───────────────────────────────────────────────────────

/**
 * Build a taste profile from the user's local library.
 * Frequency + playtime + favorites weighted.
 */
export function buildLibraryProfile(games) {
  const genreWeights     = new Map()
  const devWeights       = new Map()
  const publisherWeights = new Map()
  const seriesWeights    = new Map()
  const tagWeights       = new Map()
  const themeWeights     = new Map()
  const categoryAffinity = {}

  const emptyProfile = () => ({
    genreWeights, devWeights, publisherWeights, seriesWeights,
    tagWeights, themeWeights, categoryAffinity,
    indieAffinity: 0, aaaAffinity: 0,
    totalPlaytimeMinutes: 0,
    sampleSize: 0,
    hasData: false,
  })

  if (!Array.isArray(games) || games.length === 0) return emptyProfile()

  const incr = (map, key, amount) => {
    const k = norm(key)
    if (!k) return
    map.set(k, (map.get(k) ?? 0) + amount)
  }

  let totalPlaytime = 0
  let indieWeight   = 0
  let aaaWeight     = 0
  let totalWeight   = 0

  const catAcc = {}

  for (const g of games) {
    const minutes  = g.playtime_minutes ?? 0
    totalPlaytime += minutes

    // Base weight:
    //   1.0 for owned, scales up with hours played (diminishing).
    const hours    = Math.min(100, minutes / 60)
    const baseMult = 1 + Math.min(3, hours / 25)

    // Favourites get an explicit boost
    const favMult  = g.favorite ? 1.5 : 1

    const weight   = baseMult * favMult
    totalWeight   += weight

    // Genres + themes
    const genres = asArray(g.genres)
    const themes = asArray(g.themes)
    for (const genre of genres) incr(genreWeights, genre, weight)

    // Coarse category accumulation (genres + themes combined)
    const cats = categoriesFromGenres(genres, themes)
    for (const c of cats) catAcc[c] = (catAcc[c] ?? 0) + weight

    // Devs / publishers
    for (const dev of asArray(g.developer_names ?? g.developers)) incr(devWeights, dev, weight)
    for (const pub of asArray(g.publisher_names ?? g.publishers)) incr(publisherWeights, pub, weight * 0.6)

    // Series (prefer collections from IGDB metadata if available, fallback to franchise)
    const seriesList = asArray(g.series_name ?? g.series ?? g.franchiseNames ?? g.franchises ?? g.franchise_name)
    for (const s of seriesList) incr(seriesWeights, s, weight * 1.4)

    // Tags / themes (not always present on local rows; kept for symmetry)
    for (const t of asArray(g.tags))   incr(tagWeights, t, weight)
    for (const th of asArray(g.themes)) incr(themeWeights, th, weight)

    // Scale affinity
    const { looksAaa, looksIndie } = localGameScaleHint(g)
    if (looksAaa)   aaaWeight   += weight
    if (looksIndie) indieWeight += weight
  }

  // Normalize each map to 0..1 so weights are comparable across profiles.
  normalizeInPlace(genreWeights)
  normalizeInPlace(devWeights)
  normalizeInPlace(publisherWeights)
  normalizeInPlace(seriesWeights)
  normalizeInPlace(tagWeights)
  normalizeInPlace(themeWeights)

  // Normalize categories to 0..1 relative to dominant category
  {
    let max = 0
    for (const v of Object.values(catAcc)) if (v > max) max = v
    if (max > 0) {
      for (const [k, v] of Object.entries(catAcc)) categoryAffinity[k] = clamp01(v / max)
    }
  }

  const indieAffinity = totalWeight > 0 ? clamp01(indieWeight / totalWeight) : 0
  const aaaAffinity   = totalWeight > 0 ? clamp01(aaaWeight   / totalWeight) : 0

  return {
    genreWeights,
    devWeights,
    publisherWeights,
    seriesWeights,
    tagWeights,
    themeWeights,
    categoryAffinity,
    indieAffinity,
    aaaAffinity,
    totalPlaytimeMinutes: totalPlaytime,
    sampleSize: games.length,
    hasData: genreWeights.size > 0 || seriesWeights.size > 0 || devWeights.size > 0,
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function bestMapHit(map, keys) {
  if (!keys.length || map.size === 0) return 0
  let best = 0
  for (const k of keys) {
    const w = map.get(norm(k))
    if (w && w > best) best = w
  }
  return best
}

function sumMapHits(map, keys, cap = 1.5) {
  if (!keys.length || map.size === 0) return 0
  let sum = 0
  for (const k of keys) {
    const w = map.get(norm(k))
    if (w) sum += w
  }
  return Math.min(cap, sum)
}

/**
 * Score a single upcoming game against a taste profile.
 * Returns a number. Can be negative for strongly mis-matched titles.
 */
export function scoreUpcomingGame(game, profile, opts = {}) {
  const hasProfile = !!profile?.hasData
  let score = 0

  // Profile-independent signals first (so users with no library still get a meaningful ranking)
  // Quality
  const quality = game.recommendation_base_score ?? game.quality_score ?? 0
  if (quality > 0) {
    score += W.QUALITY * clamp01(quality / 100)
  }

  // Hype / popularity (saturate)
  if (game.hype_score)       score += W.HYPE       * clamp01(game.hype_score / 60)
  if (game.popularity_score) score += W.POPULARITY * clamp01(game.popularity_score / 100)

  // Recency
  if (game.release_date) {
    const daysAhead = (new Date(game.release_date).getTime() - Date.now()) / 86_400_000
    if (daysAhead >= 0) {
      const recency = Math.max(0, 1 - daysAhead / 180)
      score += W.RECENCY * recency
    }
  }

  // Exact-date bonus
  if (game.release_date_precision === 'day') score += W.EXACT_DATE

  // PC-relevant bonus
  const platforms = asArray(game.platforms).map(p => p.toString().toUpperCase())
  if (platforms.length === 0 || platforms.some(p => p.includes('PC') || p === 'WIN')) {
    score += W.PC_RELEVANT
  }

  // ── Personalization signals ─────────────────────────────────────────────────
  if (hasProfile) {
    // Genre (multi-match with soft cap)
    score += W.GENRE * sumMapHits(profile.genreWeights, asArray(game.genres))

    // Series (bullseye)
    const seriesName = game.series_name ?? game.franchise_name
    if (seriesName) {
      const w = profile.seriesWeights.get(norm(seriesName))
      if (w) score += W.SERIES * w
    }

    // Developer
    score += W.DEVELOPER * bestMapHit(profile.devWeights, asArray(game.developer_names))
    // Publisher
    score += W.PUBLISHER * bestMapHit(profile.publisherWeights, asArray(game.publisher_names))

    // Tags (IGDB keywords) — DB stores as `keywords`, not `tags`
    score += W.TAG   * sumMapHits(profile.tagWeights,   asArray(game.keywords ?? game.tags),   2)
    // Themes — typically few
    score += W.THEME * sumMapHits(profile.themeWeights, asArray(game.themes), 1.5)

    // Scale penalties — only with profile signal
    if (game.is_indie && profile.indieAffinity < INDIE_MISMATCH_THRESHOLD) {
      score += PEN.INDIE_MISMATCH
    }
    if (game.is_aaa && profile.aaaAffinity < AAA_MISMATCH_THRESHOLD) {
      score += PEN.AAA_MISMATCH
    }
  } else {
    // ── Cold-start bonuses ──────────────────────────────────────────────────
    // No taste profile → rank by broad quality/prominence signals so the
    // feed looks curated ("best upcoming on PC") instead of random.
    if (game.is_aaa) score += CS.AAA_TITLE
    if (game.series_name ?? game.franchise_name) score += CS.SERIES

    // Recognizable studio
    const devs = asArray(game.developer_names).map(norm)
    const pubs = asArray(game.publisher_names).map(norm)
    if (devs.some(d => MAJOR_LOCAL_PUBLISHERS.has(d)) || pubs.some(p => MAJOR_LOCAL_PUBLISHERS.has(p))) {
      score += CS.MAJOR_STUDIO
    }

    // Rich metadata = more signal, more legitimate
    const genreCount = asArray(game.genres).length
    const hasThemes  = asArray(game.themes).length > 0
    const hasTags    = asArray(game.keywords ?? game.tags).length > 0
    if (genreCount >= 2 && (hasThemes || hasTags)) score += CS.RICH_METADATA
    if (game.summary && game.summary.length > 50)  score += CS.HAS_SUMMARY
  }

  // ── Quality / date penalties ───────────────────────────────────────────────
  // Only penalize when we actually have a quality score. NULL = un-resynced
  // legacy row → treat as unknown, not low-quality.
  if (typeof game.quality_score === 'number' && game.quality_score < 25) {
    score += PEN.LOW_QUALITY
  }

  const precision = game.release_date_precision
  if (precision === 'year' || precision === 'quarter' || precision === 'tbd') {
    score += PEN.VAGUE_DATE
  }

  // Followed bonus (only when opts.isFollowed is true)
  if (opts.isFollowed) score += W.FOLLOWED

  return score
}

/**
 * Attach __score to each game, return a new array sorted descending.
 * Games are not mutated.
 *
 * opts.isFollowed?: (game) => boolean  — optional follow-check, applies FOLLOWED bonus
 */
export function rankGames(games, profile, opts = {}) {
  const followedFn = typeof opts.isFollowed === 'function' ? opts.isFollowed : null

  return games
    .map(g => ({
      ...g,
      __score: scoreUpcomingGame(g, profile, {
        isFollowed: followedFn ? followedFn(g) : false,
      }),
    }))
    .sort((a, b) => {
      if (b.__score !== a.__score) return b.__score - a.__score
      // Tiebreaker: closer release date wins, then higher base rec score.
      if (a.release_date && b.release_date) {
        const cmp = new Date(a.release_date) - new Date(b.release_date)
        if (cmp !== 0) return cmp
      } else if (!a.release_date && b.release_date) return 1
        else if (a.release_date && !b.release_date) return -1
      return (b.recommendation_base_score ?? 0) - (a.recommendation_base_score ?? 0)
    })
}

/**
 * Build a short human-readable "because…" reason for why a game ranks high.
 * Used on the detail page "You may care because…" section.
 */
export function matchReasons(game, profile, limit = 3) {
  if (!profile?.hasData) return []
  const reasons = []

  // Series
  const seriesName = game.series_name ?? game.franchise_name
  if (seriesName) {
    const w = profile.seriesWeights.get(norm(seriesName))
    if (w && w > 0.2) reasons.push({ kind: 'series', label: seriesName, weight: w * 1.4 })
  }

  // Top developer match
  for (const d of asArray(game.developer_names)) {
    const w = profile.devWeights.get(norm(d))
    if (w && w > 0.2) { reasons.push({ kind: 'developer', label: d, weight: w }); break }
  }

  // Top publisher match — only if strong
  for (const p of asArray(game.publisher_names)) {
    const w = profile.publisherWeights.get(norm(p))
    if (w && w > 0.4) { reasons.push({ kind: 'publisher', label: p, weight: w * 0.7 }); break }
  }

  // Top genre match
  let topGenre = null; let topGenreW = 0
  for (const g of asArray(game.genres)) {
    const w = profile.genreWeights.get(norm(g)) ?? 0
    if (w > topGenreW) { topGenre = g; topGenreW = w }
  }
  if (topGenre && topGenreW > 0.15) reasons.push({ kind: 'genre', label: topGenre, weight: topGenreW })

  // Top tag match
  let topTag = null; let topTagW = 0
  for (const t of asArray(game.tags)) {
    const w = profile.tagWeights.get(norm(t)) ?? 0
    if (w > topTagW) { topTag = t; topTagW = w }
  }
  if (topTag && topTagW > 0.25) reasons.push({ kind: 'tag', label: topTag, weight: topTagW * 0.8 })

  return reasons.sort((a, b) => b.weight - a.weight).slice(0, limit)
}

// ── Dashboard curation helpers ──────────────────────────────────────────────
// The dashboard feed should be tighter than the full page. These helpers
// apply an additional quality/affinity floor so the curated strip avoids
// low-signal titles.

/**
 * Filter a ranked "For You" list to the subset worth showing on the dashboard.
 * - Must meet a minimum personalized score when the profile has data, OR
 *   a minimum base recommendation score when it doesn't.
 * - Drops games with vague dates unless they're already high-quality matches.
 */
/**
 * @param {Array} rankedGames  — already scored+sorted by rankGames
 * @param {object} profile     — from buildLibraryProfile
 * @param {object} [opts]
 * @param {number} [opts.minPersonalized=18] — __score floor when profile exists
 * @param {number} [opts.minColdStart=12]    — __score floor when no profile
 * @param {number} [opts.fallbackLimit=20]   — max items in the safety-net fallback
 */
export function curateForDashboard(
  rankedGames,
  profile,
  { minPersonalized = 18, minColdStart = 12, fallbackLimit = 20 } = {},
) {
  const hasProfile = !!profile?.hasData

  // Score threshold differs between personalized and cold-start modes.
  // Cold-start scores cluster ~0..70; personalized can reach ~200+.
  const threshold = hasProfile ? minPersonalized : minColdStart

  const strict = rankedGames.filter(g => {
    // Hard quality floor — only applied when we actually have a quality_score.
    if (typeof g.quality_score === 'number' && g.quality_score < 30) return false

    return (g.__score ?? 0) >= threshold
  })

  // Safety net: if the strict filter empties the feed (e.g. all legacy rows
  // with null quality data), show the top N by score so the dashboard is
  // never blank.
  if (strict.length === 0 && rankedGames.length > 0) {
    return rankedGames.slice(0, fallbackLimit)
  }

  return strict
}

// ── Export top-entry serialization for the taste profile table ──────────────

/**
 * Serialize a Map to a top-N ordered jsonb-friendly array.
 *   [{ key, weight }]
 */
export function serializeTopEntries(map, limit = 20) {
  if (!map || typeof map.entries !== 'function') return []
  return topEntries(map, limit).map(([key, weight]) => ({ key, weight }))
}

/**
 * Build the persisted-shape of the profile for user_game_taste_profile.
 * Useful if you later wire up a writer.
 */
export function profileToDbShape(profile) {
  return {
    top_genres:            serializeTopEntries(profile.genreWeights) || [],
    top_developers:        serializeTopEntries(profile.devWeights) || [],
    top_publishers:        serializeTopEntries(profile.publisherWeights) || [],
    top_series:            serializeTopEntries(profile.seriesWeights) || [],
    preferred_tags:        serializeTopEntries(profile.tagWeights) || [],
    
    indie_affinity:        Number(profile.indieAffinity || 0),
    aaa_affinity:          Number(profile.aaaAffinity || 0),
    
    // Extract specific category affinities, default to 0
    sports_affinity:       Number(profile.categoryAffinity?.sports || 0),
    rpg_affinity:          Number(profile.categoryAffinity?.rpg || 0),
    action_affinity:       Number(profile.categoryAffinity?.action || 0),
    strategy_affinity:     Number(profile.categoryAffinity?.strategy || 0),
    sim_affinity:          Number(profile.categoryAffinity?.simulation || 0),
    horror_affinity:       Number(profile.categoryAffinity?.horror || 0),
    
    // Store full affinities object in JSONB
    category_affinities:   profile.categoryAffinity || {},
    sample_size:           profile.sampleSize ?? 0,
    last_computed_at:      new Date().toISOString(),
  }
}
