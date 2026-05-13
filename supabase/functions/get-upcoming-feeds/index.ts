import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { rankGames } from '../_shared/upcomingScoring.ts'

const IGDB_CLIENT_ID = Deno.env.get('IGDB_CLIENT_ID') ?? ''
const IGDB_CLIENT_SECRET = Deno.env.get('IGDB_CLIENT_SECRET') ?? ''

// --- CORS Configuration ---
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Convert JSON profile strings/arrays back into Maps that upcomingScoring.js requires
// Maps IGDB genre names → stable category keys that match the profile's
// categoryAffinity object (which is built from RAWG library genres).
// This bridges the naming gap: IGDB uses "Sport", RAWG uses "Sports", but
// both map to the "sports" category.
const IGDB_GENRE_TO_CATEGORY: Record<string, string> = {
  'sport':              'sports',
  'sports':             'sports',
  'racing':             'sports',
  'action':             'action',
  'shooter':            'action',
  'fighting':           'action',
  'platform':           'action',
  'hack and slash':     'action',
  "beat 'em up":        'action',
  'role-playing (rpg)': 'rpg',
  'rpg':                'rpg',
  'role playing':       'rpg',
  'strategy':           'strategy',
  'real time strategy': 'strategy',
  'turn-based strategy':'strategy',
  'tactical':           'strategy',
  'simulator':          'simulation',
  'simulation':         'simulation',
  'adventure':          'adventure',
  'visual novel':       'adventure',
  'horror':             'horror',
  'puzzle':             'puzzle',
  'arcade':             'arcade',
  'mmo':                'mmo',
  'massively multiplayer': 'mmo',
}

// Returns true when a game has at least one meaningful signal in the user's
// taste profile. Used to prevent recency-only games from flooding "For You".
function hasProfileMatch(game: any, profile: any): boolean {
  const norm = (s: string) => (s ?? '').toLowerCase().trim()

  // Indie games are gated upstream by INDIE_HARD_BLOCK_THRESHOLD; any that
  // slip through still need a real signal (not just a loose category match).
  // If the user rarely plays indie AND the game is indie, reject immediately.
  if (game.is_indie && (profile.indieAffinity as number) < 0.25) return false

  // Series is the strongest signal — exact match beats everything
  if (game.series_name) {
    const w = (profile.seriesWeights as Map<string, number>).get(norm(game.series_name))
    if (w && w > 0.1) return true
  }

  // Developer
  for (const d of (game.developer_names ?? [])) {
    const w = (profile.devWeights as Map<string, number>).get(norm(d))
    if (w && w > 0.25) return true
  }

  // Genre — first try direct map match, then category fallback.
  // Category threshold is 0.75: the dominant category normalizes to 1.0,
  // so 0.75 means only truly dominant categories pass (prevents a user whose
  // top category is action from seeing every action game including unrelated
  // indie action titles).
  const catAffinity = profile.categoryAffinity as Record<string, number>
  for (const g of (game.genres ?? [])) {
    const key = norm(g)
    const directW = (profile.genreWeights as Map<string, number>).get(key)
    if (directW && directW > 0.3) return true
    const cat = IGDB_GENRE_TO_CATEGORY[key]
    if (cat && (catAffinity[cat] ?? 0) >= 0.75) return true
  }

  // Publisher (weaker signal — require stronger weight)
  for (const p of (game.publisher_names ?? [])) {
    const w = (profile.publisherWeights as Map<string, number>).get(norm(p))
    if (w && w > 0.4) return true
  }

  // AAA games pass when the user predominantly plays AAA titles
  if (game.is_aaa && profile.aaaAffinity >= 0.5) return true

  return false
}

function deserializeDbProfile(dbRow: any) {
  if (!dbRow) return { hasData: false }

  const toMap = (arr: any[]) => new Map((arr || []).map(o => [o.key, o.weight]))

  return {
    genreWeights:     toMap(dbRow.top_genres),
    devWeights:       toMap(dbRow.top_developers),
    publisherWeights: toMap(dbRow.top_publishers),
    seriesWeights:    toMap(dbRow.top_series),
    tagWeights:       toMap(dbRow.preferred_tags),
    themeWeights:     new Map(), // DB schema has no top_themes column; scoring falls back to zero
    categoryAffinity: dbRow.category_affinities || {},
    indieAffinity:    Number(dbRow.indie_affinity) || 0,
    aaaAffinity:      Number(dbRow.aaa_affinity) || 0,
    sampleSize:       dbRow.sample_size ?? 0,
    hasData:          true
  }
}

function byReleaseDateAsc(a: any, b: any) {
  if (!a.release_date && !b.release_date) return 0
  if (!a.release_date) return 1
  if (!b.release_date) return -1
  return new Date(a.release_date).getTime() - new Date(b.release_date).getTime()
}

function byPopularity(a: any, b: any) {
  const score = (g: any) =>
    (g.recommendation_base_score ?? (g.hype_score ?? 0) * 1.5 + (g.popularity_score ?? 0))
  const diff = score(b) - score(a)
  if (diff !== 0) return diff
  return byReleaseDateAsc(a, b)
}

function coverUrl(imageId: string | undefined): string | null {
  return imageId ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg` : null
}

async function getIgdbToken(): Promise<string> {
  if (!IGDB_CLIENT_ID || !IGDB_CLIENT_SECRET) {
    throw new Error('IGDB credentials are not configured')
  }

  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${IGDB_CLIENT_ID}&client_secret=${IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`Twitch token error ${res.status}: ${await res.text()}`)
  const json = await res.json()
  return json.access_token as string
}

function mapIgdbGame(g: any): any {
  const releaseSec = g.first_release_date ?? null
  const releaseDate = releaseSec ? new Date(releaseSec * 1000).toISOString().split('T')[0] : null
  const isReleased = releaseSec !== null && releaseSec <= Math.floor(Date.now() / 1000)

  const developers = (g.involved_companies ?? [])
    .filter((c: any) => c.developer)
    .map((c: any) => c.company?.name)
    .filter(Boolean)
  const publishers = (g.involved_companies ?? [])
    .filter((c: any) => c.publisher)
    .map((c: any) => c.company?.name)
    .filter(Boolean)

  const rating = Math.round(g.total_rating ?? g.aggregated_rating ?? g.rating ?? 0)

  return {
    source: 'igdb',
    source_game_id: String(g.id),
    name: g.name ?? 'Unknown Game',
    slug: g.slug ?? null,
    summary: g.summary ?? null,
    cover_url: coverUrl(g.cover?.image_id ?? g.artworks?.[0]?.image_id),
    banner_url: coverUrl(g.artworks?.[0]?.image_id ?? g.cover?.image_id),
    release_date: releaseDate,
    release_date_precision: releaseSec ? 'day' : 'tbd',
    status: isReleased ? 'released' : 'upcoming',
    platforms: (g.platforms ?? []).map((p: any) => p.name).filter(Boolean),
    genres: (g.genres ?? []).map((gen: any) => gen.name).filter(Boolean),
    developer_names: developers,
    publisher_names: publishers,
    franchise_name: g.franchises?.[0]?.name ?? null,
    hype_score: g.hypes ?? 0,
    popularity_score: rating,
    recommendation_base_score: rating,
    rating_count: g.total_rating_count ?? 0,
    is_aaa: (g.hypes ?? 0) > 20 || (g.total_rating_count ?? 0) > 500,
    is_indie: (g.genres ?? []).some((gen: any) => gen.name?.toLowerCase() === 'indie'),
  }
}

async function fetchIgdbGamesById(ids: string[]): Promise<Map<string, any>> {
  const numericIds = [...new Set(ids.map((id) => Number(id)).filter(Number.isFinite))]
  const results = new Map<string, any>()
  if (numericIds.length === 0) return results

  const token = await getIgdbToken()
  const fields = [
    'id',
    'name',
    'slug',
    'summary',
    'first_release_date',
    'cover.image_id',
    'artworks.image_id',
    'platforms.name',
    'genres.name',
    'involved_companies.developer',
    'involved_companies.publisher',
    'involved_companies.company.name',
    'franchises.name',
    'hypes',
    'rating',
    'aggregated_rating',
    'total_rating',
    'total_rating_count',
  ].join(',')

  for (let i = 0; i < numericIds.length; i += 500) {
    const batch = numericIds.slice(i, i + 500)
    const res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': IGDB_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: `fields ${fields}; where id = (${batch.join(',')}); limit ${batch.length};`,
    })
    if (!res.ok) throw new Error(`IGDB error ${res.status}: ${await res.text()}`)

    const games = await res.json() as any[]
    for (const game of games) {
      const mapped = mapIgdbGame(game)
      results.set(mapped.source_game_id, mapped)
    }
  }

  return results
}

function fallbackFollowedGame(pair: { source: string; source_game_id: string }) {
  return {
    source: pair.source,
    source_game_id: pair.source_game_id,
    name: `IGDB #${pair.source_game_id}`,
    cover_url: null,
    banner_url: null,
    release_date: null,
    release_date_precision: 'tbd',
    status: 'unknown',
    platforms: [],
    genres: [],
    developer_names: [],
    publisher_names: [],
    franchise_name: null,
    hype_score: 0,
    popularity_score: 0,
    recommendation_base_score: 0,
  }
}

serve(async (req) => {
  // 1. Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

    // Forward the user's JWT when present so RLS policies see the right role.
    // Fall back to the anon key so unauthenticated callers can still read the
    // public upcoming_games_cache table without a 401.
    const authHeader = req.headers.get('Authorization')
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: {
        headers: authHeader
          ? { Authorization: authHeader }
          : { Authorization: `Bearer ${supabaseKey}` },
      },
    })

    const body = await req.json().catch(() => ({}))
    const { 
      page = 1, 
      page_size = 48, 
      feed = 'all_upcoming', 
      timeframe = 'rest_of_year',
      date_from, 
      date_to,
      sort
    } = body

    // Calculate dates
    const now = new Date()
    let start = date_from
    let end = date_to

    if (!start) {
      start = now.toISOString().split('T')[0] // default today
    }

    if (!end) {
      const DAY = 86_400_000
      if (timeframe === 'week') {
        end = new Date(Date.now() + 7   * DAY).toISOString().split('T')[0]
      } else if (timeframe === 'month') {
        end = new Date(Date.now() + 30  * DAY).toISOString().split('T')[0]
      } else if (timeframe === 'quarter') {
        end = new Date(Date.now() + 90  * DAY).toISOString().split('T')[0]
      } else {
        // 'rest_of_year' and any unknown value: cap at Dec 31 of the current year
        end = new Date(Date.UTC(now.getUTCFullYear(), 11, 31)).toISOString().split('T')[0]
      }
    }

    // Authenticate user to see if we have customization context
    const { data: { user } } = await supabase.auth.getUser()

    // 2. Fetch raw game records (bounded by date) + TBA/no-date games separately
    let query = supabase
      .from('upcoming_games_cache')
      .select('*')
      .eq('status', 'upcoming')
      .gte('release_date', start)

    if (end) query = query.lte('release_date', end)

    // Also pull TBA/high-hype games with no confirmed date (GTA VI, Pragmata, etc.)
    const tbaQuery = supabase
      .from('upcoming_games_cache')
      .select('*')
      .eq('status', 'upcoming')
      .is('release_date', null)

    // Include both explicitly-released rows AND past-dated upcoming rows (which
    // haven't been swept by sync-upcoming-games yet). This prevents the recent
    // tab from going stale when the sync job hasn't run for a while.
    // Floor at 90 days to cover the "Last 3 Months" timeframe filter; the
    // "All Recent" case below applies a tighter 60-day default.
    const todayStr = now.toISOString().split('T')[0]
    const recentFloor = new Date(Date.now() - 90 * 86_400_000).toISOString().split('T')[0]
    const recentQuery = supabase
      .from('upcoming_games_cache')
      .select('*')
      .or(`status.eq.released,and(status.eq.upcoming,release_date.lt.${todayStr})`)
      .gte('release_date', recentFloor)
      .order('release_date', { ascending: false })
      .limit(200)

    const [{ data: datedGames, error: gamesErr }, { data: tbaGames }, { data: recentGamesRaw }] = await Promise.all([query, tbaQuery, recentQuery])

    const gamesRaw = [...(datedGames ?? []), ...(tbaGames ?? [])]
    const recentRaw = recentGamesRaw ?? []
    
    if (gamesErr) throw gamesErr
    if (!gamesRaw) throw new Error("No games returned.")

    let profile = { hasData: false }
    // Key = "source:source_game_id" to avoid cross-source collisions
    let followedIds = new Set<string>()
    // Raw array of { source, source_game_id } for supplementary fetch
    let followedPairs: { source: string; source_game_id: string; metadata: any }[] = []

    // 3. Fetch personalization layers if authenticated
    if (user) {
      const [profileRes, followRes] = await Promise.all([
        supabase.from('user_game_taste_profile').select('*').eq('user_id', user.id).single(),
        supabase.from('user_followed_games').select('source, source_game_id, metadata').eq('user_id', user.id)
      ])

      if (profileRes.data) profile = deserializeDbProfile(profileRes.data)
      if (followRes.data) {
        followRes.data.forEach((r: any) => {
          const key = `${r.source}:${String(r.source_game_id)}`
          followedIds.add(key)
          followedPairs.push({ source: r.source, source_game_id: String(r.source_game_id), metadata: r.metadata ?? null })
        })
      }
    }

    // 4. Score all fetched games
    const isFollowedRaw = (g: any) => followedIds.has(`${g.source}:${String(g.source_game_id)}`)
    const scoredGames = rankGames(gamesRaw, profile, { isFollowed: isFollowedRaw })
    const scoredRecentGames = rankGames(recentRaw, profile, { isFollowed: isFollowedRaw })

    // 5. Partition to calculate exact facets
    const threeMonthsFromNow = Date.now() + (90 * 86_400_000)
    
    // Popular = games with any meaningful hype or popularity signal
    const popularPool = scoredGames.filter((g: any) =>
      (g.hype_score ?? 0) > 0 || (g.recommendation_base_score ?? 0) >= 8
    )

    const facets = {
      all_upcoming_count: scoredGames.length,
      for_you_count: 0,
      // Set to followingPool.length below (after the pool loop) so it reflects
      // only games that are actually renderable, not total DB rows which can
      // include released/non-cached titles.
      following_count: 0,
      soon_count: 0,
      big_releases_count: 0,
      popular_count: popularPool.length,
      recent_count: scoredRecentGames.length,
    }

    // "For You" pool — personalized with a quality/relevance floor.
    // When the user has a profile:
    //   - Raise the score floor to 20 to drop low-signal games.
    //   - Hard-block indie games when the user has essentially no indie affinity
    //     (< 0.10), so a user whose entire library is AAA titles never sees
    //     random indie releases in their personal feed.
    // Without profile: use a lower cold-start floor so the feed isn't blank.
    // Block indie games when indieAffinity < 20% — wide enough to cover users
    // who own a handful of indie titles but predominantly play other genres.
    const INDIE_HARD_BLOCK_THRESHOLD = 0.20
    const forYouPool = scoredGames.filter((g: any) => {
      const score = g.__score ?? 0
      if (profile.hasData) {
        // Require a minimum personalized score
        if (score < 20) return false
        // Hard-block indie games for users who rarely play indie
        if (g.is_indie && (profile as any).indieAffinity < INDIE_HARD_BLOCK_THRESHOLD) return false
        // Require at least one real signal match — prevents recency-only
        // games from flooding the feed for users with a clear taste profile
        if (!hasProfileMatch(g, profile)) return false
      } else {
        // Cold-start (no profile): show only games with a meaningful signal.
        // is_indie is too conservative (games with good metadata escape it),
        // so we require at least one positive indicator instead: AAA flag,
        // actual IGDB hype, or a high recommendation score (which itself
        // requires hype OR rating — pure metadata tops out around 30).
        if (score < 15) return false
        const hasMeaningfulSignal = g.is_aaa
          || (g.hype_score ?? 0) >= 15
          || (g.recommendation_base_score ?? 0) >= 48
        if (!hasMeaningfulSignal) return false
      }
      return true
    })
    facets.for_you_count = forYouPool.length

    // Calculate others
    let soonPool: any[] = []
    let bigPool: any[] = []
    let followingPool: any[] = []

    for (const g of scoredGames) {
      // Following
      if (isFollowedRaw(g)) followingPool.push(g)

      // Soon
      if (g.release_date) {
        const dateMs = new Date(g.release_date).getTime()
        if (dateMs >= Date.now() && dateMs <= threeMonthsFromNow) {
          soonPool.push(g)
          facets.soon_count++
        }
      }

      // Big Releases — strict criteria to avoid indie games leaking in.
      // is_big_release can be set by the sync for high-hype games regardless
      // of studio size, so require big_release_score >= 65 to gate it
      // (AAA boost in that score means only real AAA titles easily clear it).
      const isBig = g.is_aaa
        || (g.is_big_release && (g.big_release_score ?? 0) >= 65 && !g.is_indie)
        || (!g.is_indie && (g.recommendation_base_score ?? 0) >= 40 && (g.hype_score ?? 0) >= 15)
      if (isBig) {
        bigPool.push(g)
        facets.big_releases_count++
      }
    }
    // Supplement: any followed game that has a non-upcoming status in the cache
    // (released games, etc.) won't be in scoredGames. Fetch them separately so
    // the Following tab reflects the user's actual follows, not just upcoming.
    // Resolve in this order:
    // 1. upcoming_games_cache
    // 2. user_followed_games.metadata
    // 3. IGDB by source_game_id for older rows created before metadata existed
    // 4. minimal fallback card, so DB follows are never silently dropped
    if (user && followedPairs.length > 0) {
      const inPool = new Set(followingPool.map((g: any) => `${g.source}:${String(g.source_game_id)}`))
      const missingPairs = followedPairs.filter(p => !inPool.has(`${p.source}:${p.source_game_id}`))
      if (missingPairs.length > 0) {
        const pendingIgdbPairs: typeof missingPairs = []
        const extras = await Promise.all(
          missingPairs.map(async p => {
            const { data } = await supabase
              .from('upcoming_games_cache')
              .select('*')
              .eq('source', p.source)
              .eq('source_game_id', p.source_game_id)
              .maybeSingle()
            if (data) return data
            if (p.metadata) return p.metadata
            if (p.source === 'igdb') {
              pendingIgdbPairs.push(p)
              return null
            }
            return fallbackFollowedGame(p)
          })
        )
        extras.forEach((g: any) => { if (g) followingPool.push(g) })

        if (pendingIgdbPairs.length > 0) {
          try {
            const igdbById = await fetchIgdbGamesById(pendingIgdbPairs.map(p => p.source_game_id))
            pendingIgdbPairs.forEach((p) => {
              followingPool.push(igdbById.get(p.source_game_id) ?? fallbackFollowedGame(p))
            })
          } catch (err) {
            console.warn('Failed to resolve followed IGDB games:', err)
            pendingIgdbPairs.forEach((p) => followingPool.push(fallbackFollowedGame(p)))
          }
        }
      }
    }
    // following_count reflects the actual renderable user_followed_games rows.
    facets.following_count = followingPool.length

    // 6. Support for pre-warming all standard feeds at once
    if (feed === 'preload') {
      const getSlice = (arr: any[]) => arr.slice(0, page_size)
      
      const preloadedFeeds = {
        for_you: forYouPool,
        following: followingPool.sort(byReleaseDateAsc),
        soon: soonPool.sort(byReleaseDateAsc),
        big_releases: bigPool.sort((a, b) => (b.recommendation_base_score ?? 0) - (a.recommendation_base_score ?? 0) || byReleaseDateAsc(a, b)),
        popular: [...popularPool].sort(byPopularity),
        recent: scoredRecentGames.sort((a, b) => new Date(String(b.release_date || 0)).getTime() - new Date(String(a.release_date || 0)).getTime()),
        all_upcoming: [...scoredGames].sort(byReleaseDateAsc)
      }

      const payload: Record<string, any> = {}
      for (const [key, arr] of Object.entries(preloadedFeeds)) {
        const slice = getSlice(arr)
        payload[key] = {
          items: slice,
          facets: facets,
          meta: {
            total_count: arr.length,
            showing_count: slice.length,
            page: 1,
            page_size,
            has_more: slice.length < arr.length,
            date_from: start,
            date_to: end,
            timeframe
          }
        }
      }

      return new Response(JSON.stringify(payload), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 7. Select single active feed
    let activeFeed = scoredGames
    
    switch (feed) {
      case 'for_you':
        activeFeed = forYouPool // Already scored/sorted by rankGames
        break
      case 'following':
        activeFeed = followingPool.sort(byReleaseDateAsc)
        break
      case 'soon':
        activeFeed = soonPool.sort(byReleaseDateAsc)
        break
      case 'big_releases':
        // Sort explicitly by recommendation score over ranked score
        activeFeed = bigPool.sort((a, b) => (b.recommendation_base_score ?? 0) - (a.recommendation_base_score ?? 0) || byReleaseDateAsc(a, b))
        break
      case 'popular':
        activeFeed = [...popularPool].sort(byPopularity)
        break
      case 'recent':
        activeFeed = scoredRecentGames.sort((a, b) => new Date(String(b.release_date || 0)).getTime() - new Date(String(a.release_date || 0)).getTime())
        if (timeframe === 'week') {
          const cut = Date.now() - 7 * 86_400_000
          activeFeed = activeFeed.filter(g => new Date(g.release_date).getTime() >= cut)
        } else if (timeframe === 'month') {
          const cut = Date.now() - 30 * 86_400_000
          activeFeed = activeFeed.filter(g => new Date(g.release_date).getTime() >= cut)
        } else if (timeframe === 'quarter') {
          const cut = Date.now() - 90 * 86_400_000
          activeFeed = activeFeed.filter(g => new Date(g.release_date).getTime() >= cut)
        } else {
          // "All Recent" — default to last 60 days so ancient titles don't surface
          const cut = Date.now() - 60 * 86_400_000
          activeFeed = activeFeed.filter(g => new Date(g.release_date).getTime() >= cut)
        }
        break
      case 'all_upcoming':
      default:
        activeFeed = [...scoredGames].sort(byReleaseDateAsc)
        break
    }

    // Custom sorting override
    if (sort === 'release_date') activeFeed = activeFeed.sort(byReleaseDateAsc)
    if (sort === 'popularity') activeFeed = activeFeed.sort(byPopularity)

    // 8. Paginate
    const total_count = activeFeed.length
    const startIdx = (page - 1) * page_size
    const endIdx = startIdx + page_size
    const activeSlice = activeFeed.slice(startIdx, endIdx)

    return new Response(JSON.stringify({
      items: activeSlice,
      meta: {
        total_count,
        showing_count: activeSlice.length,
        page,
        page_size,
        has_more: endIdx < total_count,
        date_from: start,
        date_to: end,
        timeframe
      },
      facets
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    console.error('Error fetching upcoming feeds:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
