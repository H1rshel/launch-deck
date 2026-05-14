import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { fetchRawgMediaByTitle } from '../lib/rawg'

const _extCache = new Map()
const EXT_TTL_MS = 10 * 60 * 1000

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
  return [value]
}

function buildIgdbImageUrl(imageId, size = 't_1080p') {
  if (!imageId || typeof imageId !== 'string') return ''
  return `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg`
}

function normalizeIgdbUrl(url, size = 't_1080p') {
  if (!url || typeof url !== 'string') return ''
  if (/^https?:\/\//i.test(url)) return url.replace('/t_thumb/', `/${size}/`)
  if (url.startsWith('//')) return `https:${url}`.replace('/t_thumb/', `/${size}/`)
  return ''
}

export function normalizeUpcomingImages(value) {
  const seen = new Set()

  return asArray(value)
    .flatMap((item) => {
      if (!item) return []
      if (typeof item === 'string') {
        return [normalizeIgdbUrl(item) || buildIgdbImageUrl(item) || item]
      }

      const url =
        normalizeIgdbUrl(item.url) ||
        normalizeIgdbUrl(item.imageUrl) ||
        normalizeIgdbUrl(item.image_url) ||
        buildIgdbImageUrl(item.imageId || item.image_id || item.id)

      return url ? [url] : []
    })
    .filter((url) => {
      if (!url || seen.has(url)) return false
      seen.add(url)
      return true
    })
}

export function normalizeUpcomingVideos(value) {
  const seen = new Set()

  return asArray(value)
    .map((item) => {
      if (!item) return null
      if (typeof item === 'string') {
        return { videoId: item, name: 'Trailer' }
      }

      const videoId = item.videoId || item.video_id || item.youtubeId || item.youtube_id || item.id
      if (!videoId) return null
      return {
        videoId: String(videoId),
        name: item.name || item.title || 'Trailer',
      }
    })
    .filter((video) => {
      if (!video || seen.has(video.videoId)) return false
      seen.add(video.videoId)
      return true
    })
}

function normalizeTitle(value) {
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

function sameGameTitle(expected, candidate) {
  const left = normalizeTitle(expected)
  const right = normalizeTitle(candidate)
  if (!left || !right) return false
  if (left === right) return true
  return right.endsWith(` ${left}`)
}

export function normalizeUpcomingExtended(match) {
  if (!match) return null

  return {
    id: match.id ?? null,
    name: match.name || '',
    summary: match.summary || '',
    storyline: match.storyline || '',
    screenshots: normalizeUpcomingImages(match.screenshots),
    artworks: normalizeUpcomingImages(match.artworks),
    videos: normalizeUpcomingVideos(match.videos),
    websites: asArray(match.websites),
    age_ratings: asArray(match.ageRatings ?? match.age_ratings),
    similar_games: asArray(match.similarGames ?? match.similar_games),
    game_modes: asArray(match.gameModes ?? match.game_modes),
    player_perspectives: asArray(match.playerPerspectives ?? match.player_perspectives),
    game_engines: asArray(match.gameEngines ?? match.game_engines),
    rating: match.rating ?? null,
    rating_count: match.ratingCount ?? match.rating_count ?? null,
    aggregated_rating: match.aggregatedRating ?? match.aggregated_rating ?? null,
    aggregated_rating_count: match.aggregatedRatingCount ?? match.aggregated_rating_count ?? null,
    total_rating: match.totalRating ?? match.total_rating ?? null,
  }
}

/**
 * Fetches extended IGDB data for an upcoming game by its IGDB game ID.
 * Falls back to name search, then RAWG screenshots when IGDB media is missing.
 */
export function useUpcomingGameExtended(gameName, sourceGameId) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!sourceGameId && !gameName) return

    const cacheKey = `${sourceGameId || 'name'}:${normalizeTitle(gameName)}`
    const cached = _extCache.get(cacheKey)
    if (cached && (Date.now() - cached.fetchedAt) < EXT_TTL_MS) {
      setData(cached.data)
      return
    }

    let cancelled = false
    setData(null)
    setLoading(true)

    async function fetchExtended() {
      let match = null
      let extended = null

      if (sourceGameId) {
        try {
          const numId = parseInt(sourceGameId, 10)
          if (!isNaN(numId) && numId > 0) {
            match = await invoke('get_igdb_game_by_id', { gameId: numId })
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('[useUpcomingGameExtended] ID fetch failed, trying name:', err)
        }
      }

      if (!match && gameName) {
        try {
          const results = await invoke('search_igdb_games', { query: gameName })
          if (results?.length) {
            match = (sourceGameId
              ? results.find((result) => String(result.id) === String(sourceGameId))
              : null
            ) || results.find((result) => sameGameTitle(gameName, result.name)) || null
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('[useUpcomingGameExtended] name search failed:', err)
        }
      }

      if (match) {
        extended = normalizeUpcomingExtended(match)
      }

      if (gameName && (!extended || (extended.screenshots.length === 0 && extended.artworks.length === 0))) {
        try {
          const rawgMedia = await fetchRawgMediaByTitle(gameName)
          if (rawgMedia?.isExactMatch) {
            extended = {
              ...(extended || normalizeUpcomingExtended({})),
              screenshots: [
                ...(extended?.screenshots || []),
                ...(rawgMedia.screenshots || []),
              ],
              artworks: [
                ...(extended?.artworks || []),
                ...(rawgMedia.artworks || []),
              ],
            }
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn('[useUpcomingGameExtended] RAWG media fallback failed:', err)
        }
      }

      if (cancelled) return

      if (extended) {
        const normalized = {
          ...extended,
          screenshots: normalizeUpcomingImages(extended.screenshots),
          artworks: normalizeUpcomingImages(extended.artworks),
          videos: normalizeUpcomingVideos(extended.videos),
        }
        _extCache.set(cacheKey, { data: normalized, fetchedAt: Date.now() })
        setData(normalized)
      }
      setLoading(false)
    }

    fetchExtended()
    return () => { cancelled = true }
  }, [gameName, sourceGameId])

  return { data, loading }
}
