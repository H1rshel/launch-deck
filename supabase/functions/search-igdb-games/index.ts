import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const IGDB_CLIENT_ID     = Deno.env.get('IGDB_CLIENT_ID')!
const IGDB_CLIENT_SECRET = Deno.env.get('IGDB_CLIENT_SECRET')!

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

function coverUrl(imageId: string | undefined): string | null {
  return imageId ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg` : null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = await req.json().catch(() => ({}))
    const query: string = (body.query ?? '').trim()
    const limit: number = Math.min(Number(body.limit) || 10, 20)

    if (!query || query.length < 2) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const token = await getIgdbToken()
    const nowSec = Math.floor(Date.now() / 1000)

    // Search IGDB — escape double quotes in the query
    const safeQuery = query.replace(/"/g, '\\"')
    const igdbQuery = `
      search "${safeQuery}";
      fields
        id, name, slug, status, summary,
        first_release_date,
        cover.image_id,
        artworks.image_id,
        platforms.name,
        genres.name,
        involved_companies.developer,
        involved_companies.publisher,
        involved_companies.company.name,
        franchises.name,
        hypes, rating, aggregated_rating, total_rating;
      limit ${limit};
    `

    const igdbRes = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': IGDB_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: igdbQuery,
    })
    if (!igdbRes.ok) throw new Error(`IGDB search error ${igdbRes.status}: ${await igdbRes.text()}`)
    const games = await igdbRes.json() as any[]

    // Map to clean result objects
    const results = games.map((g: any) => {
      const releaseSec: number | null = g.first_release_date ?? null
      const isReleased = releaseSec !== null && releaseSec <= nowSec
      const releaseDate = releaseSec
        ? new Date(releaseSec * 1000).toISOString().split('T')[0]
        : null

      const developers: string[] = (g.involved_companies ?? [])
        .filter((c: any) => c.developer)
        .map((c: any) => c.company?.name)
        .filter(Boolean)

      const publishers: string[] = (g.involved_companies ?? [])
        .filter((c: any) => c.publisher)
        .map((c: any) => c.company?.name)
        .filter(Boolean)

      const platforms: string[] = (g.platforms ?? []).map((p: any) => p.name).filter(Boolean)
      const genres: string[]    = (g.genres ?? []).map((gen: any) => gen.name).filter(Boolean)
      const franchise: string | null = g.franchises?.[0]?.name ?? null

      // Pick best cover image (cover > first artwork)
      const cover = coverUrl(g.cover?.image_id ?? g.artworks?.[0]?.image_id)

      return {
        igdb_id:      g.id,
        name:         g.name,
        slug:         g.slug ?? null,
        cover_url:    cover,
        release_date: releaseDate,
        is_released:  isReleased,
        status:       isReleased ? 'released' : (releaseDate ? 'upcoming' : 'unknown'),
        summary:      g.summary ?? null,
        platforms,
        genres,
        developer_names: developers,
        publisher_names: publishers,
        franchise_name: franchise,
        hype_score:   g.hypes ?? 0,
        rating:       g.total_rating ?? g.aggregated_rating ?? g.rating ?? null,
      }
    })

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    console.error('search-igdb-games error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
