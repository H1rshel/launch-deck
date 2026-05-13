import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const IGDB_CLIENT_ID = Deno.env.get('IGDB_CLIENT_ID')!
const IGDB_CLIENT_SECRET = Deno.env.get('IGDB_CLIENT_SECRET')!

const IGDB_FIELDS = 'id,name,slug,summary,category,first_release_date,cover.image_id,artworks.image_id,platforms.name,genres.name,themes.name,keywords.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,franchises.name,hypes,rating,aggregated_rating,total_rating,total_rating_count'

async function getIgdbToken(): Promise<string> {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${IGDB_CLIENT_ID}&client_secret=${IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  )
  if (!res.ok) throw new Error(`Twitch token error ${res.status}`)
  const json = await res.json()
  return json.access_token as string
}

function coverUrl(imageId: string | undefined): string | null {
  return imageId ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg` : null
}

async function igdbQuery(apicalypse: string, token: string): Promise<any[]> {
  const res = await fetch('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID': IGDB_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body: apicalypse,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`IGDB error ${res.status}: ${text}`)
  }
  const data = await res.json()
  if (!Array.isArray(data)) {
    throw new Error(`IGDB returned non-array: ${JSON.stringify(data)}`)
  }
  return data
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

    const token = await getIgdbToken()
    const nowSec = Math.floor(Date.now() / 1000)
    const PC_PLATFORMS = '(6, 14, 3)'

    // ── Top 100 ───────────────────────────────────────────────────────────────
    if (feed === 'top_100') {
      const raw = await igdbQuery(
        `fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & total_rating_count > 200; sort total_rating desc; limit ${page_size * 2}; offset ${(page - 1) * page_size * 2};`,
        token
      )
      const filtered = raw.map(mapGame).filter((g: any) => !ownedGameNames.has(normalizeName(g.name)))
      const has_more = filtered.length > page_size || raw.length === page_size * 2
      const items = filtered.slice(0, page_size)
      return reply({ items, meta: { total_count: 100, page, page_size, has_more } })
    }

    // ── Trending ──────────────────────────────────────────────────────────────
    if (feed === 'trending') {
      const sixMonthsAgo = nowSec - 180 * 86400
      const raw = await igdbQuery(
        `fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & first_release_date >= ${sixMonthsAgo} & first_release_date <= ${nowSec} & total_rating_count > 5; sort total_rating_count desc; limit ${Math.min(page * page_size * 2 + 1, 500)}; offset 0;`,
        token
      )
      const filtered = raw.map(mapGame).filter((g: any) => !ownedGameNames.has(normalizeName(g.name)))
      const start = (page - 1) * page_size
      const items = filtered.slice(start, start + page_size)
      const has_more = start + page_size < filtered.length || raw.length === Math.min(page * page_size * 2 + 1, 500)
      return reply({ items, meta: { total_count: null, page, page_size, has_more } })
    }

    // ── Hidden Gems ───────────────────────────────────────────────────────────
    if (feed === 'hidden_gems') {
      const raw = await igdbQuery(
        `fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & total_rating >= 78 & total_rating_count >= 5 & total_rating_count < 150; sort total_rating desc; limit ${page_size * 2 + 1}; offset ${(page - 1) * page_size * 2};`,
        token
      )
      const filtered = raw.map(mapGame).filter((g: any) => !ownedGameNames.has(normalizeName(g.name)))
      const items = filtered.slice(0, page_size)
      const has_more = items.length === page_size && raw.length > page_size * 2
      return reply({ items, meta: { total_count: null, page, page_size, has_more } })
    }

    // ── For You ───────────────────────────────────────────────────────────────
    if (feed === 'for_you') {
      const [popularRaw, recentRaw] = await Promise.all([
        // Grab the 400 most widely-played games to give the algorithm a huge, high-quality pool
        igdbQuery(`fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & total_rating_count > 200; sort total_rating_count desc; limit 400;`, token),
        // Grab the 100 most widely-played recent games (last 12 months)
        igdbQuery(`fields ${IGDB_FIELDS}; where platforms = ${PC_PLATFORMS} & first_release_date >= ${nowSec - 365 * 86400} & first_release_date <= ${nowSec} & total_rating_count > 10; sort total_rating_count desc; limit 100;`, token),
      ])

      const seen = new Set<string>()
      let pool = [...popularRaw, ...recentRaw].map(mapGame).filter((g: any) => {
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
