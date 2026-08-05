import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.0'
import { igdbQuery as cachedIgdbQuery } from '../_shared/igdb.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const IGDB_CLIENT_ID = Deno.env.get('IGDB_CLIENT_ID')!
const IGDB_CLIENT_SECRET = Deno.env.get('IGDB_CLIENT_SECRET')!

const IGDB_FIELDS = 'id,name,slug,summary,category,first_release_date,cover.image_id,artworks.image_id,platforms.name,genres.name,themes.name,keywords.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,franchises.name,hypes,rating,aggregated_rating,total_rating,total_rating_count'

const IGDB_CREDS = { clientId: IGDB_CLIENT_ID, clientSecret: IGDB_CLIENT_SECRET }

// ── Shared Discover cache ────────────────────────────────────────────────────
// These feed queries are byte-identical for every user — the personalisation
// (owned-game filtering, taste-profile ranking) happens below on the RESULT,
// not in the query — so the upstream fetch can be shared by everyone.
//
// It has to be shared through Postgres, not memory: Edge Functions get a
// fresh isolate per request, so the module-scope cache in ../_shared/igdb.ts
// never survives between requests (measured: six concurrent identical
// requests each paid the full ~2s IGDB round trip). That module is still the
// fetch layer underneath — it just can't be the cache.
//
// One hour. IGDB's aggregate ratings and popularity counts move over days, so
// an hour is imperceptible in these feeds, and it cuts upstream calls to at
// most one per distinct query per hour no matter how many users are browsing.
const CACHE_TTL_MS = 60 * 60 * 1000

// Past this, an entry is too old to serve even as a stopgap and the request
// waits for fresh data instead.
const CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Separate from the per-request user client below: the cache is server-owned
// state and the table denies anon/authenticated entirely.
const cacheDb = SERVICE_ROLE_KEY
  ? createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null

function coverUrl(imageId: string | undefined): string | null {
  return imageId ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg` : null
}

// Bumped whenever the SHAPE of a cached payload changes, so entries written
// by an older deploy can never be read back under the new interpretation.
// v1 stored raw IGDB objects; v2 stores mapGame output.
const CACHE_SHAPE_VERSION = 'v2'

async function hashQuery(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${CACHE_SHAPE_VERSION}\n${text}`),
  )
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Runs the query upstream and writes the result back to the shared cache.
 *
 * Stores mapGame's OUTPUT, not the raw IGDB response. mapGame is 1:1 and
 * drops everything the feeds never look at — the nested involved_companies
 * objects, artworks, category, the id/name pairs inside every platform,
 * genre, theme and keyword. The raw for_you pool was 1.6 MB of JSON to read
 * and parse on every request; this is the single biggest lever on warm
 * latency, and it also means the mapping runs once per hour instead of once
 * per request. Responses are unchanged — the same objects come out either way.
 */
async function fetchAndStore(apicalypse: string, hash: string): Promise<any[]> {
  const raw = await cachedIgdbQuery(apicalypse, IGDB_CREDS, { ttlMs: 0 })
  const data = raw.map(mapGame)
  if (cacheDb) {
    const now = Date.now()
    const { error } = await cacheDb.from('discover_cache').upsert(
      {
        query_hash: hash,
        query_text: apicalypse,
        payload: data,
        refreshed_at: new Date(now).toISOString(),
        expires_at: new Date(now + CACHE_TTL_MS).toISOString(),
      },
      { onConflict: 'query_hash' },
    )
    if (error) console.warn('[discover-cache] store failed:', error.message)
  }
  return data
}

/** Uncached upstream path — the exact behaviour this function had before. */
async function fetchDirect(apicalypse: string): Promise<any[]> {
  const raw = await cachedIgdbQuery(apicalypse, IGDB_CREDS)
  return raw.map(mapGame)
}

/**
 * Cache-first fetch of a feed's games, already mapped.
 *
 * Fresh entry  → served from Postgres, no upstream call.
 * Stale entry  → served immediately AND refreshed in the background, so a
 *                user never waits on an expiry and a burst of requests at the
 *                expiry boundary can't stampede IGDB.
 * No entry     → fetched upstream and stored (the pre-cache behaviour).
 *
 * Every failure path falls through to a direct IGDB call, so the feed keeps
 * working exactly as it does today if the cache is unavailable.
 */
async function fetchGames(apicalypse: string): Promise<any[]> {
  if (!cacheDb) return fetchDirect(apicalypse)

  let hash: string
  try {
    hash = await hashQuery(apicalypse)
  } catch {
    return fetchDirect(apicalypse)
  }

  try {
    const { data: row } = await cacheDb
      .from('discover_cache')
      .select('payload, expires_at')
      .eq('query_hash', hash)
      .maybeSingle()

    if (row && Array.isArray(row.payload)) {
      const expiredFor = Date.now() - new Date(row.expires_at).getTime()
      if (expiredFor < 0) return row.payload as any[]

      if (expiredFor < CACHE_MAX_STALE_MS) {
        // Serve stale, refresh behind the response. waitUntil keeps the
        // isolate alive long enough for the write to land; without it the
        // entry simply stays stale and the next request retries.
        const refresh = fetchAndStore(apicalypse, hash).catch((err) =>
          console.warn('[discover-cache] background refresh failed:', err?.message ?? err),
        )
        try {
          // @ts-ignore — provided by the Supabase Edge Runtime
          EdgeRuntime.waitUntil(refresh)
        } catch { /* not available; fire-and-forget */ }
        return row.payload as any[]
      }
    }
  } catch (err: any) {
    console.warn('[discover-cache] lookup failed:', err?.message ?? err)
    return fetchDirect(apicalypse)
  }

  return fetchAndStore(apicalypse, hash)
}

function mapGame(g: any): any {
  const releaseSec = g.first_release_date ?? null
  const developers = (g.involved_companies ?? []).filter((c: any) => c.developer).map((c: any) => c.company?.name).filter(Boolean)
  const publishers = (g.involved_companies ?? []).filter((c: any) => c.publisher).map((c: any) => c.company?.name).filter(Boolean)
  return {
    source: 'igdb',
    source_game_id: String(g.id),
    name: g.name ?? 'Unknown',
    slug: g.slug,
    summary: g.summary,
    release_date: releaseSec ? new Date(releaseSec * 1000).toISOString().split('T')[0] : null,
    release_date_precision: releaseSec ? 'day' : 'tbd',
    cover_url: coverUrl(g.cover?.image_id ?? g.artworks?.[0]?.image_id),
    developer_names: developers,
    publisher_names: publishers,
    platforms: (g.platforms ?? []).map((p: any) => p.name).filter(Boolean),
    genres:    (g.genres    ?? []).map((gen: any) => gen.name).filter(Boolean),
    themes:    (g.themes    ?? []).map((t: any) => t.name).filter(Boolean),
    keywords:  (g.keywords  ?? []).map((k: any) => k.name).filter(Boolean),
    series_name: g.franchises?.[0]?.name ?? null,
    hype_score: g.hypes ?? 0,
    quality_score: Math.round(g.total_rating ?? 0),
    popularity_score: Math.round(g.total_rating ?? 0),
    recommendation_base_score: Math.round(g.total_rating ?? 0),
    rating_count: g.total_rating_count ?? 0,
    is_aaa:  (g.hypes ?? 0) > 20 || (g.total_rating_count ?? 0) > 500,
    is_indie: (g.genres ?? []).some((gen: any) => gen.name?.toLowerCase() === 'indie'),
  }
}

// Lightweight personalized ranker — no external imports needed
function rankByProfile(games: any[], profile: any | null): any[] {
  if (!profile) {
    return [...games].sort((a, b) => (b.quality_score ?? 0) - (a.quality_score ?? 0))
  }

  function toMap(arr: any[]): Map<string, number> {
    const m = new Map<string, number>()
    if (!Array.isArray(arr)) return m
    for (const e of arr) {
      if (e?.key) m.set(e.key.toLowerCase(), e.weight ?? 0)
    }
    return m
  }

  const genreMap  = toMap(profile.top_genres ?? [])
  const seriesMap = toMap(profile.top_series ?? [])
  const devMap    = toMap(profile.top_developers ?? [])

  function score(g: any): number {
    let s = (g.quality_score ?? 0) * 0.5

    // Genre match
    for (const genre of (g.genres ?? [])) {
      const w = genreMap.get(genre.toLowerCase())
      if (w) s += w * 30
    }

    // Series match
    if (g.series_name) {
      const w = seriesMap.get(g.series_name.toLowerCase())
      if (w) s += w * 50
    }

    // Developer match
    for (const dev of (g.developer_names ?? [])) {
      const w = devMap.get(dev.toLowerCase())
      if (w) { s += w * 25; break }
    }

    return s
  }

  return [...games].sort((a, b) => score(b) - score(a))
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const reply = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  try {
    const body = await req.json().catch(() => ({}))
    const { feed = 'top_100', page = 1, page_size = 48 } = body

    // ── Get User Owned Games (if authenticated) ───────────────────────────────
    const authHeader = req.headers.get('Authorization')
    let ownedGameNames = new Set<string>()
    let profile: any = null
    let supabase: any = null

    const normalizeName = (n: string) => (n || '').toLowerCase().replace(/[^a-z0-9]/g, '')

    if (authHeader) {
      supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      )
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const [gamesRes, profileRes] = await Promise.all([
            supabase.from('games').select('name').eq('user_id', user.id),
            supabase.from('user_game_taste_profile').select('*').eq('user_id', user.id).single()
          ])
          if (gamesRes.data) {
            gamesRes.data.forEach((g: any) => {
              const norm = normalizeName(g.name)
              if (norm) ownedGameNames.add(norm)
            })
          }
          if (profileRes.data) {
            profile = profileRes.data
          }
        }
      } catch (_) { /* ignore auth errors */ }
    }

    // Quantised to the cache TTL, and it MUST match it. These timestamps go
    // straight into the apicalypse text, which is the cache key — a raw
    // per-second `now` would mint a new key every second, and any window
    // shorter than the TTL would mint one per window and multiply the
    // upstream calls the cache is there to avoid. "A game released in the
    // last hour" is not a distinction any of these feeds can express anyway.
    const nowSec = Math.floor(Date.now() / CACHE_TTL_MS) * (CACHE_TTL_MS / 1000)
    const PC_PLATFORMS = '(6, 14, 3)'

    // ── Top 100 ───────────────────────────────────────────────────────────────
    if (feed === 'top_100') {
      const raw = await fetchGames(
        `fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & total_rating_count > 200; sort total_rating desc; limit ${page_size * 2}; offset ${(page - 1) * page_size * 2};`,
      )
      const filtered = raw.filter((g: any) => !ownedGameNames.has(normalizeName(g.name)))
      const has_more = filtered.length > page_size || raw.length === page_size * 2
      const items = filtered.slice(0, page_size)
      return reply({ items, meta: { total_count: 100, page, page_size, has_more } })
    }

    // ── Trending ──────────────────────────────────────────────────────────────
    if (feed === 'trending') {
      const sixMonthsAgo = nowSec - 180 * 86400
      const raw = await fetchGames(
        `fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & first_release_date >= ${sixMonthsAgo} & first_release_date <= ${nowSec} & total_rating_count > 5; sort total_rating_count desc; limit ${Math.min(page * page_size * 2 + 1, 500)}; offset 0;`,
      )
      const filtered = raw.filter((g: any) => !ownedGameNames.has(normalizeName(g.name)))
      const start = (page - 1) * page_size
      const items = filtered.slice(start, start + page_size)
      const has_more = start + page_size < filtered.length || raw.length === Math.min(page * page_size * 2 + 1, 500)
      return reply({ items, meta: { total_count: null, page, page_size, has_more } })
    }

    // ── Hidden Gems ───────────────────────────────────────────────────────────
    if (feed === 'hidden_gems') {
      const raw = await fetchGames(
        `fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & total_rating >= 78 & total_rating_count >= 5 & total_rating_count < 150; sort total_rating desc; limit ${page_size * 2 + 1}; offset ${(page - 1) * page_size * 2};`,
      )
      const filtered = raw.filter((g: any) => !ownedGameNames.has(normalizeName(g.name)))
      const items = filtered.slice(0, page_size)
      const has_more = items.length === page_size && raw.length > page_size * 2
      return reply({ items, meta: { total_count: null, page, page_size, has_more } })
    }

    // ── For You ───────────────────────────────────────────────────────────────
    if (feed === 'for_you') {
      const [popularRaw, recentRaw] = await Promise.all([
        // Grab the 400 most widely-played games to give the algorithm a huge, high-quality pool
        fetchGames(`fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & total_rating_count > 200; sort total_rating_count desc; limit 400;`),
        // Grab the 100 most widely-played recent games (last 12 months)
        fetchGames(`fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & first_release_date >= ${nowSec - 365 * 86400} & first_release_date <= ${nowSec} & total_rating_count > 10; sort total_rating_count desc; limit 100;`),
      ])

      const seen = new Set<string>()
      let pool = [...popularRaw, ...recentRaw].filter((g: any) => {
        if (seen.has(g.source_game_id) || ownedGameNames.has(normalizeName(g.name))) return false
        seen.add(g.source_game_id)
        return true
      })

      pool = rankByProfile(pool, profile)

      const start = (page - 1) * page_size
      return reply({
        items: pool.slice(start, start + page_size),
        meta: { total_count: pool.length, page, page_size, has_more: start + page_size < pool.length }
      })
    }

    return reply({ error: `Unknown feed: ${feed}` }, 400)

  } catch (err: any) {
    console.error('[get-discover-feeds]', err?.message ?? err)
    return reply({ error: err?.message ?? 'Internal error' }, 500)
  }
})
