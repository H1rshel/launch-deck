import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Config ────────────────────────────────────────────────────────────────────

const IGDB_CLIENT_ID     = Deno.env.get('IGDB_CLIENT_ID')!
const IGDB_CLIENT_SECRET = Deno.env.get('IGDB_CLIENT_SECRET')!
const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/** Days ahead to look for upcoming releases (fallback if end of year is too close) */
const MIN_LOOKAHEAD_DAYS    = 90
/** IGDB max results per request */
const IGDB_PAGE_SIZE        = 500
/** Max pages per query type (caps total fetched per variant. 40 * 500 = 20,000 games) */
const MAX_PAGES             = 60
/** Rows per Supabase upsert batch */
const UPSERT_BATCH_SIZE     = 250
/** IGDB platform id for Windows PC */
const PC_PLATFORM_ID        = 6

/** Minimum quality score to enter the cache at all. Keeps obvious garbage out. */
const MIN_QUALITY_THRESHOLD = 12
/** How long released games linger in cache before deletion (days). */
const RELEASE_RETENTION_DAYS = 21

// ── Bucket definitions ──────────────────────────────────────────────────────
// Used by the dashboard to carve the feed into tabs without refetching.
const BUCKET_IMMINENT_DAYS = 14
const BUCKET_SOON_DAYS     = 90
const BUCKET_HORIZON_DAYS  = 365

// ── IGDB date_format → our release_date_precision ────────────────────────────
const DATE_PRECISION: Record<number, string> = {
  0: 'day',
  1: 'month',
  2: 'year',
  3: 'month',
  4: 'month',
  5: 'month',
  6: 'month',
  7: 'year',
}

// IGDB quarter month offsets
const QUARTER_MONTH: Record<number, string> = {
  3: '03', 4: '06', 5: '09', 6: '12',
}

// IGDB status integer → our status string
const IGDB_STATUS: Record<number, string> = {
  0: 'released',
  2: 'upcoming',
  3: 'upcoming',
  4: 'upcoming',
  5: 'offline',
  6: 'cancelled',
  7: 'rumoured',
  8: 'delisted',
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface IgdbReleaseDate {
  id:          number
  date?:       number
  date_format: number
  y?:          number
  m?:          number
  platform?: { id: number; name: string; abbreviation?: string }
}

interface IgdbGame {
  id:                  number
  name:                string
  slug?:               string
  status?:             number
  first_release_date?: number
  summary?:            string
  cover?:              { image_id: string }
  artworks?:           Array<{ image_id: string }>
  screenshots?:        Array<{ image_id: string }>
  platforms?:          Array<{ id: number; name: string; abbreviation?: string }>
  genres?:             Array<{ name: string }>
  themes?:             Array<{ name: string }>
  keywords?:           Array<{ name: string }>
  involved_companies?: Array<{
    developer: boolean
    publisher: boolean
    company:   { name: string }
  }>
  release_dates?: IgdbReleaseDate[]
  franchises?:    Array<{ name: string }>
  collections?:   Array<{ name: string }>
  hypes?:         number
  rating?:        number
  aggregated_rating?: number
  total_rating?:     number
}

// ── Known-big publisher / developer list (heuristic for AAA inference) ──────
// Coarse, not exhaustive. Used only to nudge AAA classification for ambiguous
// mid-popularity titles. Lowercase.
const MAJOR_COMPANIES = new Set([
  'activision', 'activision blizzard', 'blizzard entertainment',
  'bethesda softworks', 'bethesda game studios', 'id software', 'zenimax',
  'ea', 'electronic arts', 'ea sports', 'dice',
  'ubisoft', 'ubisoft entertainment', 'ubisoft montreal',
  'sony interactive entertainment', 'playstation studios',
  'naughty dog', 'insomniac games', 'guerrilla games', 'bungie',
  'microsoft', 'xbox game studios', 'microsoft game studios',
  '343 industries', 'the coalition', 'obsidian entertainment',
  'nintendo', 'nintendo epd',
  'rockstar games', 'rockstar north',
  'take-two interactive', '2k', '2k games', '2k sports',
  'square enix', 'square enix japan',
  'capcom', 'konami', 'sega', 'bandai namco', 'bandai namco entertainment',
  'cd projekt', 'cd projekt red',
  'fromsoftware', 'kojima productions',
  'warner bros', 'warner bros. games', 'warner bros. interactive',
  'netease', 'tencent',
  'epic games', 'valve',
  'paradox interactive', 'paradox development studio',
  'riot games', 'activision publishing',
])

// ── IGDB auth ─────────────────────────────────────────────────────────────────

async function getIgdbToken(): Promise<string> {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token` +
    `?client_id=${IGDB_CLIENT_ID}` +
    `&client_secret=${IGDB_CLIENT_SECRET}` +
    `&grant_type=client_credentials`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`Twitch token error ${res.status}: ${await res.text()}`)
  const json = await res.json()
  return json.access_token as string
}

// ── IGDB fetch helpers ────────────────────────────────────────────────────────

const IGDB_FIELDS = `
  id, name, slug, status, summary,
  first_release_date,
  cover.image_id,
  artworks.image_id,
  screenshots.image_id,
  platforms.id, platforms.name, platforms.abbreviation,
  genres.name,
  themes.name,
  keywords.name,
  involved_companies.developer,
  involved_companies.publisher,
  involved_companies.company.name,
  release_dates.date, release_dates.date_format,
  release_dates.y, release_dates.m,
  release_dates.platform.id,
  release_dates.platform.name,
  release_dates.platform.abbreviation,
  franchises.name, collections.name,
  hypes, rating, aggregated_rating, total_rating
`

async function fetchIgdbPage(
  token: string,
  offset: number,
  minDateSec: number,
  futureSec: number,
  variant: 'global' | 'pc' | 'hype_tba',
): Promise<IgdbGame[]> {
  let dateFilter: string
  if (variant === 'pc') {
    dateFilter = `release_dates.platform = ${PC_PLATFORM_ID} & first_release_date >= ${minDateSec} & release_dates.date <= ${futureSec}`
  } else if (variant === 'hype_tba') {
    // High-hype games with no confirmed release date — catches big anticipated
    // titles like GTA VI, Pragmata, etc. that don't have a first_release_date.
    dateFilter = `first_release_date = null & hypes >= 20`
  } else {
    dateFilter = `first_release_date >= ${minDateSec} & first_release_date <= ${futureSec}`
  }

  const query = `
    fields ${IGDB_FIELDS};
    where (${dateFilter})
      & (status = null | (status != 6 & status != 8))
      & cover != null
      & (category = null | category = 0 | category = 8 | category = 9 | category = 10);
    sort ${variant === 'pc' ? 'first_release_date asc' : 'hypes desc'};
    limit ${IGDB_PAGE_SIZE};
    offset ${offset};
  `

  const res = await fetch('https://api.igdb.com/v4/games', {
    method:  'POST',
    headers: {
      'Client-ID':     IGDB_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'text/plain',
    },
    body: query,
  })
  if (!res.ok) throw new Error(`IGDB [${variant}] page ${offset} error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<IgdbGame[]>
}

async function fetchAllIgdbGames(token: string, maxPages: number): Promise<Map<number, IgdbGame>> {
  const now = new Date()
  // Always look through end of NEXT year so 2027 releases (GTA VI, etc.) are included
  const endOfLookahead = new Date(now.getFullYear() + 1, 11, 31, 23, 59, 59)
  const nowSec    = Math.floor(now.getTime() / 1000)

  // Lookahead until end of next year, or at least 90 days
  const futureSec = Math.max(
    Math.floor(endOfLookahead.getTime() / 1000),
    nowSec + MIN_LOOKAHEAD_DAYS * 86400
  )

  const merged = new Map<number, IgdbGame>()

  for (const variant of ['global', 'pc', 'hype_tba'] as const) {
    // hype_tba is sorted by hype descending — one page of the top 500 is enough
    const pageLimit = variant === 'hype_tba' ? 1 : maxPages
    let currentOffset = 0
    let currentMinDate = nowSec

    for (let page = 0; page < pageLimit; page++) {
      const games  = await fetchIgdbPage(token, currentOffset, currentMinDate, futureSec, variant)
      console.log(`[sync] IGDB [${variant}] page ${page} (offset: ${currentOffset}): ${games.length} results`)

      for (const g of games) {
        if (!merged.has(g.id)) merged.set(g.id, g)
      }

      if (games.length < IGDB_PAGE_SIZE) break

      currentOffset += IGDB_PAGE_SIZE
      if (currentOffset >= 4500) {
        // We're hitting IGDB's 5000 total limit. Shift date window.
        let maxDate = currentMinDate
        for (const g of games) {
          if (g.first_release_date && g.first_release_date > maxDate) {
            maxDate = g.first_release_date
          }
        }
        if (maxDate === currentMinDate) maxDate += 1
        currentMinDate = maxDate
        currentOffset = 0
      }
    }
  }

  return merged
}

// ── Normalization ─────────────────────────────────────────────────────────────

function igdbImageUrl(imageId: string | undefined, size: string): string | null {
  if (!imageId) return null
  return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`
}

function bestReleaseDate(game: IgdbGame): { date: string | null; precision: string } {
  const pcEntry = game.release_dates?.find(rd => rd.platform?.id === PC_PLATFORM_ID)
  const entry   = pcEntry ?? game.release_dates?.[0]

  if (entry) {
    const fmt       = entry.date_format ?? 7
    const precision = DATE_PRECISION[fmt] ?? 'year'

    if (entry.date) {
      return {
        date:      new Date(entry.date * 1000).toISOString().split('T')[0],
        precision,
      }
    }

    if (entry.y) {
      const year  = entry.y
      const month = (entry.m && entry.m > 0)
        ? String(entry.m).padStart(2, '0')
        : QUARTER_MONTH[fmt] ?? '01'
      return { date: `${year}-${month}-01`, precision }
    }
  }

  if (game.first_release_date) {
    return {
      date:      new Date(game.first_release_date * 1000).toISOString().split('T')[0],
      precision: 'day',
    }
  }

  return { date: null, precision: 'tbd' }
}

function deriveStatus(game: IgdbGame, releaseDateIso: string | null): string {
  const mapped = game.status !== undefined ? IGDB_STATUS[game.status] : undefined
  if (mapped && mapped !== 'released') return mapped

  if (releaseDateIso) {
    return new Date(releaseDateIso) > new Date() ? 'upcoming' : 'released'
  }
  return 'upcoming'
}

// ── Quality + completeness scoring (server-side) ─────────────────────────────
//
// Both scores are bounded to 0..100. Weights are coarse on purpose — this is
// a prefilter plus a ranking hint, not a precision instrument.

function metadataCompletenessScore(game: IgdbGame, precision: string): number {
  let score = 0
  if (game.name)                              score += 10
  if (game.cover?.image_id)                   score += 18
  if ((game.artworks?.length ?? 0) > 0 ||
      (game.screenshots?.length ?? 0) > 0)    score += 10
  if ((game.genres?.length ?? 0) > 0)         score += 12
  if ((game.themes?.length ?? 0) > 0)         score += 6
  if ((game.keywords?.length ?? 0) > 0)       score += 4
  if (game.summary && game.summary.length > 40) score += 12
  if ((game.involved_companies ?? []).some(c => c.developer)) score += 10
  if ((game.involved_companies ?? []).some(c => c.publisher)) score += 5
  if (precision === 'day')                    score += 10
  else if (precision === 'month')             score += 5
  else if (precision === 'quarter')           score += 2
  if ((game.platforms?.length ?? 0) > 0)      score += 3
  return Math.min(100, score)
}

/**
 * Normalize IGDB signals and blend with completeness into an overall quality.
 * IGDB `hypes` is a small integer follower count (0..~500); we saturate at 60.
 * IGDB `rating` / `total_rating` are 0..100; we clamp to 100.
 */
function qualityScore(game: IgdbGame, completeness: number): number {
  const hypeNorm = Math.min(1, (game.hypes ?? 0) / 60)
  const ratingRaw = game.total_rating ?? game.aggregated_rating ?? game.rating ?? 0
  const popNorm  = Math.min(1, ratingRaw / 100)
  const compNorm = completeness / 100

  // Blend weights — completeness dominates to push out low-info records.
  const blended =
    compNorm * 55 +
    hypeNorm * 25 +
    popNorm  * 20

  return Math.round(Math.min(100, blended))
}

/**
 * Classify a game as is_aaa / is_indie using heuristic signals.
 * These are intentionally coarse and soft: the ranker uses them as a nudge,
 * not a gate.
 */
function classifyScale(game: IgdbGame, quality: number):
  { isAaa: boolean; isIndie: boolean }
{
  const companies = [
    ...(game.involved_companies ?? []).map(c => (c.company?.name ?? '').toLowerCase()),
  ]
  const hasMajor = companies.some(c => MAJOR_COMPANIES.has(c))
  const hasFranchise = (game.franchises?.length ?? 0) > 0
  const strongHype   = (game.hypes ?? 0) >= 25
  const strongPop    = (game.total_rating ?? game.aggregated_rating ?? 0) >= 75
  const richMeta     = quality >= 65

  const isAaa = (hasMajor && (strongHype || hasFranchise || richMeta)) ||
                (strongPop && strongHype) ||
                (hasFranchise && strongHype)

  const weakHype   = (game.hypes ?? 0) < 5
  const weakPop    = (game.total_rating ?? 0) < 40 && (game.aggregated_rating ?? 0) < 40
  const leanMeta   = quality < 55
  const isIndie    = !isAaa && !hasMajor && weakHype && weakPop && !hasFranchise && leanMeta

  return { isAaa, isIndie }
}

function releaseBucket(releaseDateIso: string | null): string {
  if (!releaseDateIso) return 'tba'
  const diffDays = (new Date(releaseDateIso).getTime() - Date.now()) / 86_400_000
  if (diffDays < 0) return 'released'
  if (diffDays <= BUCKET_IMMINENT_DAYS) return 'imminent'
  if (diffDays <= BUCKET_SOON_DAYS)     return 'soon'
  if (diffDays <= BUCKET_HORIZON_DAYS)  return 'horizon'
  return 'horizon'
}

/**
 * A lightweight "base" recommendation score, independent of any user.
 * Used as a reasonable default ranking for users with no library signal,
 * and as a small additive in the personalized score.
 */
function recommendationBaseScore(game: IgdbGame, quality: number): number {
  const hypeNorm = Math.min(1, (game.hypes ?? 0) / 60)
  const ratingRaw = game.total_rating ?? game.aggregated_rating ?? game.rating ?? 0
  const popNorm  = Math.min(1, ratingRaw / 100)

  return Math.round(
    quality * 0.55 +
    hypeNorm * 100 * 0.30 +
    popNorm  * 100 * 0.15
  )
}

/**
 * Server-side computation of Big Release status using explicitly requested metadata
 */
function computeBigReleaseStats(game: IgdbGame, isAaa: boolean, quality: number) {
  let score = 0
  
  // AAA Structural Boost
  if (isAaa) score += 35
  
  // Popularity & Engagement
  const hypeScore = Math.min(100, (game.hypes ?? 0) * 2)
  const ratingScore = game.total_rating ?? game.aggregated_rating ?? game.rating ?? 0
  score += (hypeScore * 0.4) + (ratingScore * 0.3)
  
  // Asset Quality
  if (quality >= 70) score += 15
  else if (quality >= 50) score += 10

  // Series Recognition
  if ((game.collections?.length ?? 0) > 0 || (game.franchises?.length ?? 0) > 0) {
    score += 15
  }

  score = Math.min(100, Math.round(score))

  let tier = 'niche'
  if (score >= 80) tier = 'blockbuster'
  else if (score >= 60) tier = 'major'
  else if (score >= 40) tier = 'notable'

  // Big release = AAA flag OR composite score high enough.
  // Removed raw `hypes > 30` trigger — high hype alone can come from an
  // indie studio's prior hit (e.g. Poncle/Vampire Survivors) and would tag
  // indie games as Big Releases.  score >= 65 already bakes in hype weight.
  const isBigRelease = isAaa || score >= 65

  return { 
    is_big_release: isBigRelease, 
    popularity_tier: tier, 
    big_release_score: score 
  }
}

// ── Main normalization ───────────────────────────────────────────────────────

function normalizeGame(game: IgdbGame) {
  const { date: releaseDate, precision } = bestReleaseDate(game)
  const status = deriveStatus(game, releaseDate)

  const developers = (game.involved_companies ?? [])
    .filter(c => c.developer).map(c => c.company?.name).filter(Boolean) as string[]
  const publishers = (game.involved_companies ?? [])
    .filter(c => c.publisher).map(c => c.company?.name).filter(Boolean) as string[]

  const bannerImageId = game.artworks?.[0]?.image_id ?? game.screenshots?.[0]?.image_id

  const completeness = metadataCompletenessScore(game, precision)
  let quality        = qualityScore(game, completeness)
  const { isAaa, isIndie } = classifyScale(game, quality)

  // Guarantee survival of notable AAA releases against filtering
  if (isAaa && quality < 60) {
    quality = 60
  }
  const bucket       = status === 'released' ? 'released' : releaseBucket(releaseDate)
  const recBase      = recommendationBaseScore(game, quality)
  
  const bigStats     = computeBigReleaseStats(game, isAaa, quality)

  // Lifecycle timestamps
  const now = new Date().toISOString()
  const released_at = status === 'released' ? (releaseDate ? new Date(releaseDate).toISOString() : now) : null
  const expires_at  = status === 'released'
    ? new Date(Date.now() + RELEASE_RETENTION_DAYS * 86_400_000).toISOString()
    : null

  return {
    source:                 'igdb',
    source_game_id:         String(game.id),
    name:                   game.name,
    slug:                   game.slug ?? null,
    cover_url:              igdbImageUrl(game.cover?.image_id, 'cover_big'),
    banner_url:             igdbImageUrl(bannerImageId, 'screenshot_big'),
    release_date:           releaseDate,
    release_date_precision: precision,
    status,
    platforms:              (game.platforms ?? []).map(p => p.abbreviation || p.name),
    genres:                 (game.genres  ?? []).map(g => g.name),
    themes:                 (game.themes  ?? []).map(t => t.name),
    tags:                   (game.keywords ?? []).map(k => k.name),
    developer_names:        developers,
    publisher_names:        publishers,
    franchise_name:         game.franchises?.[0]?.name ?? null,
    series_name:            game.collections?.[0]?.name ?? null,
    summary:                game.summary ?? null,
    hype_score:             game.hypes  ?? null,
    popularity_score:       game.rating ?? null,

    // Derived signals
    quality_score:               quality,
    metadata_completeness_score: completeness,
    recommendation_base_score:   recBase,

    // Scale
    is_indie: isIndie,
    is_aaa:   isAaa,

    // Big Release Feeds
    is_big_release:    bigStats.is_big_release,
    popularity_tier:   bigStats.popularity_tier,
    big_release_score: bigStats.big_release_score,

    // Lifecycle
    release_bucket: bucket,
    released_at,
    expires_at,

    last_synced_at: now,
  }
}

// ── Upstream quality gate ────────────────────────────────────────────────────
// Reject obvious garbage before it ever hits the cache.

function passesQualityGate(row: ReturnType<typeof normalizeGame>): boolean {
  // Must have a name
  if (!row.name || row.name.trim().length < 2) return false

  // Must meet minimum quality score
  if ((row.quality_score ?? 0) < MIN_QUALITY_THRESHOLD) return false

  // Must have at least a cover OR a banner, otherwise the card will look broken
  if (!row.cover_url && !row.banner_url) return false

  // Must have a usable future release date — OR be a high-hype/high-quality TBA title.
  // hype_tba query brings in big anticipated games (GTA VI, Pragmata, etc.) with no date.
  if (!row.release_date && (row.quality_score ?? 0) < 40 && (row.hype_score ?? 0) < 20) return false

  // PC filter: Launch Deck is PC-focused. If the game has platform data and
  // none of them are PC-related, drop it — we don't want console-only titles
  // flooding the feed. Games with no platform data are kept (might be early
  // announcements with incomplete metadata).
  const platforms = (row.platforms ?? []) as string[]
  if (platforms.length > 0) {
    const hasPc = platforms.some(p => {
      const up = (p ?? '').toUpperCase()
      return up === 'PC' || up === 'WIN' || up.includes('WINDOWS')
    })
    if (!hasPc) return false
  }

  return true
}

// ── Supabase upsert (batched) ─────────────────────────────────────────────────

function buildBatches(rows: any[], size: number) {
  const batches = []
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size))
  }
  return batches
}

async function upsertBatched(supabase: any, rows: any[], batchSize: number) {
  const batches = buildBatches(rows, batchSize)
  let upserted = 0
  let errors = 0
  const errorDetails: string[] = []

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const { error, count } = await supabase
      .from('upcoming_games_cache')
      .upsert(batch, { onConflict: 'source,source_game_id', count: 'exact' })

    if (error) {
      console.error(`[sync] Upsert batch failed:`, error.message, error.details ?? '')
      errorDetails.push(error.message)
      errors++
    } else {
      upserted += count ?? batch.length
    }
  }

  return { upserted, errors, errorDetails }
}

// ── Lifecycle sweep ───────────────────────────────────────────────────────────
// 1. Any upcoming row whose release_date has passed → status='released' and
//    set released_at / expires_at if not already set.
// 2. Any released row whose expires_at is in the past → delete from cache.
// 3. Update release_bucket based on current date for freshness.

async function runLifecycleSweep(supabase: ReturnType<typeof createClient>): Promise<void> {
  const now      = new Date()
  const nowIso   = now.toISOString()
  const today    = nowIso.split('T')[0]
  const expireAt = new Date(now.getTime() + RELEASE_RETENTION_DAYS * 86_400_000).toISOString()

  // 1. Transition upcoming → released when the date passes.
  {
    const { error, count } = await supabase
      .from('upcoming_games_cache')
      .update({
        status:         'released',
        release_bucket: 'released',
        released_at:    nowIso,
        expires_at:     expireAt,
        last_synced_at: nowIso,
      })
      .eq('status', 'upcoming')
      .lt('release_date', today)

    if (error) {
      console.warn('[sync] Lifecycle transition failed (non-fatal):', error.message)
    } else if (count && count > 0) {
      console.log(`[sync] Lifecycle: ${count} past-dated rows transitioned to 'released'`)
    }
  }

  // 2. Delete rows whose retention window has expired.
  {
    const { error, count } = await supabase
      .from('upcoming_games_cache')
      .delete({ count: 'exact' })
      .eq('status', 'released')
      .lt('expires_at', nowIso)

    if (error) {
      console.warn('[sync] Lifecycle delete failed (non-fatal):', error.message)
    } else if (count && count > 0) {
      console.log(`[sync] Lifecycle: ${count} expired released rows deleted`)
    }
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  let dryRun = false
  let overrideMaxPages = MAX_PAGES

  if (req.method === 'POST') {
    try {
      const body = await req.json()
      if (body.dry_run === true) dryRun = true
      if (typeof body.max_pages === 'number') overrideMaxPages = body.max_pages
    } catch (_) {}
  }

  const startMs = Date.now()
  console.log(`[sync-upcoming-games] Starting… dry_run=${dryRun}, max_pages=${overrideMaxPages}`)

  try {
    const token = await getIgdbToken()
    console.log('[sync-upcoming-games] Twitch token obtained')

    const gameMap = await fetchAllIgdbGames(token, overrideMaxPages)
    console.log(`[sync-upcoming-games] Total unique games: ${gameMap.size}`)

    if (gameMap.size === 0) {
      return json({ synced: 0, message: 'No upcoming games in IGDB window' })
    }

    const normalized = [...gameMap.values()].map(normalizeGame)
    const rows       = normalized.filter(passesQualityGate)
    const dropped    = normalized.length - rows.length
    
    const bigReleaseCount = rows.filter(r => r.is_aaa).length
    console.log(`[sync-upcoming-games] Quality gate: ${rows.length} passed, ${dropped} dropped. Guaranteed big releases: ${bigReleaseCount}`)

    if (dryRun) {
      const droppedReasonsSample = normalized.filter(g => !passesQualityGate(g)).slice(0, 5).map(g => ({ name: g.name, quality: g.quality_score }))
      console.log(`[sync-upcoming-games] DRY RUN - Skipping Supabase upsert. Dropped sample:`, droppedReasonsSample)
      return json({
        dry_run: true,
        fetched: normalized.length,
        filtered: dropped,
        guaranteed_big_releases: bigReleaseCount,
        dropped_sample: droppedReasonsSample,
        synced: rows.length,
      })
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // 4) Upsert
    const { upserted, errors, errorDetails } = await upsertBatched(supabase, rows, UPSERT_BATCH_SIZE)

    // Run lifecycle sweep after the upsert so we reflect the latest state.
    await runLifecycleSweep(supabase)

    const elapsed = Date.now() - startMs
    console.log(`[sync-logs] Completed in ${elapsed}ms. Inserted ${upserted}, Errors: ${errors}`)

    return json({
      fetched:  normalized.length,
      filtered: dropped,
      guaranteed_big_releases: bigReleaseCount,
      synced:   upserted,
      dropped,
      errors,
      errorDetails,
      elapsed_ms: elapsed,
    })
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    console.error('[sync-upcoming-games] FATAL:', msg)
    return json({ error: msg }, 500)
  }
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
