const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export const GAME_DETAIL_PROVIDERS = Object.freeze({
  metadata: 'metadata',
  hltb: 'hltb',
  steamPlaytime: 'steam_playtime',
  steamAchievements: 'steam_achievements',
  ubisoftPlaytime: 'ubisoft_playtime',
  ubisoftAchievements: 'ubisoft_achievements',
  ubisoftCoreChallenges: 'ubisoft_core_challenges',
})

export const GAME_DETAIL_TTLS = Object.freeze({
  metadata: 30 * DAY_MS,
  hltb: 21 * DAY_MS,
  steamPlaytime: 10 * MINUTE_MS,
  steamAchievements: 10 * MINUTE_MS,
  ubisoftPlaytime: 10 * MINUTE_MS,
  ubisoftAchievements: 10 * MINUTE_MS,
  ubisoftCoreChallenges: 10 * MINUTE_MS,
})

function normalizeKeyPart(value) {
  return String(value || '').trim().toLowerCase()
}

function getTitleKey(game) {
  return normalizeKeyPart(
    game?.displayTitle || game?.normalized_title || game?.title || '',
  )
}

function getSourceKey(game) {
  return [
    game?.steam_app_id,
    game?.gog_id,
    game?.epic_id,
    game?.ubisoft_id,
  ]
    .map(normalizeKeyPart)
    .join('|')
}

export function buildMetadataCacheKey(game) {
  return [getTitleKey(game), getSourceKey(game)].join('|')
}

export function buildHltbCacheKey(game) {
  return [
    getTitleKey(game),
    normalizeKeyPart(game?.title || ''),
    getSourceKey(game),
  ].join('|')
}

export function buildSteamCacheKey(game, steamId) {
  return [
    normalizeKeyPart(steamId),
    normalizeKeyPart(game?.steam_app_id || ''),
    getTitleKey(game),
    normalizeKeyPart(game?.title || ''),
  ].join('|')
}

export function buildUbisoftCacheKey(game, accountId) {
  return [
    normalizeKeyPart(accountId),
    normalizeKeyPart(game?.ubisoft_id || ''),
    getTitleKey(game),
    normalizeKeyPart(game?.title || ''),
  ].join('|')
}

export function generateSearchVariants(displayTitle, originalTitle) {
  const names = []
  if (displayTitle) names.push(displayTitle)
  if (originalTitle && originalTitle !== displayTitle) names.push(originalTitle)

  const variants = []

  for (const name of names) {
    if (!name) continue
    variants.push(name)
    if (name.includes(':')) variants.push(name.split(':')[0].trim())
    if (name.match(/\(\d{4}\)/)) {
      variants.push(name.replace(/\(\d{4}\)/g, '').trim())
    }
    if (name.includes(' - ')) variants.push(name.split(' - ')[0].trim())
    if (name.match(/\s+\d+:\s+(.*)/)) {
      variants.push(name.replace(/\s+\d+:\s+/, ' ').trim())
    }
  }

  return [...new Set(variants)].filter(Boolean)
}

function isFiniteTime(value) {
  return Number.isFinite(new Date(value).getTime())
}

export function getStaleAfterIso(ttlMs, from = Date.now()) {
  return new Date(from + ttlMs).toISOString()
}

export function isCacheEntryStale(entry, cacheKey) {
  if (!entry) return true
  if (cacheKey && entry.cacheKey && entry.cacheKey !== cacheKey) return true
  if (cacheKey && !entry.cacheKey) return true
  if (!entry.staleAfter || !isFiniteTime(entry.staleAfter)) return true
  return new Date(entry.staleAfter).getTime() <= Date.now()
}

export function selectPrimaryAgeRating(ageRatings = []) {
  return (
    ageRatings.find((rating) => rating.organization === 'ESRB') ||
    ageRatings.find((rating) => rating.organization === 'PEGI') ||
    ageRatings[0] ||
    null
  )
}

export function normalizeMetadataPayload(details) {
  if (!details) return null

  const ageRatings = Array.isArray(details.ageRatings) ? details.ageRatings : []
  const genres = Array.isArray(details.genres)
    ? details.genres
        .map((genre) => (typeof genre === 'string' ? { name: genre } : genre))
        .filter(Boolean)
    : []
  const primaryAgeRating =
    details.primaryAgeRating || selectPrimaryAgeRating(ageRatings)

  return {
    description_raw: details.description_raw || '',
    storyline: details.storyline || '',
    developers: Array.isArray(details.developers) ? details.developers : [],
    publishers: Array.isArray(details.publishers) ? details.publishers : [],
    portingStudios: Array.isArray(details.portingStudios)
      ? details.portingStudios
      : [],
    supportingStudios: Array.isArray(details.supportingStudios)
      ? details.supportingStudios
      : [],
    genres,
    themes: Array.isArray(details.themes) ? details.themes : [],
    platforms: Array.isArray(details.platforms) ? details.platforms : [],
    gameModes: Array.isArray(details.gameModes) ? details.gameModes : [],
    playerPerspectives: Array.isArray(details.playerPerspectives)
      ? details.playerPerspectives
      : [],
    engines: Array.isArray(details.engines) ? details.engines : [],
    ageRatings,
    primaryAgeRating,
    similarGames: Array.isArray(details.similarGames) ? details.similarGames : [],
    franchise: details.franchise || null,
    collections: Array.isArray(details.collections) ? details.collections : [],
    franchises: Array.isArray(details.franchises) ? details.franchises : [],
    screenshots: Array.isArray(details.screenshots) ? details.screenshots : [],
    artworks: Array.isArray(details.artworks) ? details.artworks : [],
    websites: Array.isArray(details.websites) ? details.websites : [],
    releaseDate: details.releaseDate || '',
  }
}

export function mapLegacyIgdbCacheToMetadata(cached) {
  if (!cached) return null

  return normalizeMetadataPayload({
    description_raw: cached.summary || '',
    storyline: cached.storyline || '',
    developers: cached.developers || [],
    publishers: cached.publishers || [],
    portingStudios: cached.portingStudios || [],
    supportingStudios: cached.supportingStudios || [],
    genres: (cached.genres || []).map((genre) =>
      typeof genre === 'string' ? { name: genre } : genre,
    ),
    themes: cached.themes || [],
    platforms: cached.platforms || [],
    gameModes: cached.gameModes || [],
    playerPerspectives: cached.playerPerspectives || [],
    engines: cached.engines || [],
    ageRatings: cached.ageRatings || [],
    primaryAgeRating: cached.primaryAgeRating || null,
    similarGames: cached.similarGames || [],
    franchise: cached.franchise || null,
    collections: cached.collections || [],
    franchises: cached.franchises || [],
    screenshots: cached.screenshots || [],
    artworks: cached.artworks || [],
    websites: cached.websites || [],
    releaseDate: cached.releaseDate || '',
  })
}

export function normalizeSteamPlaytimePayload(result) {
  if (!result) {
    return {
      available: false,
      steamPlaytime: 0,
      lastPlayedSteam: 0,
      appId: 0,
      reason: 'Steam playtime unavailable',
    }
  }

  return {
    available: true,
    steamPlaytime: result.steamPlaytime ?? result.steam_playtime ?? 0,
    lastPlayedSteam:
      result.lastPlayedSteam ?? result.last_played_steam ?? 0,
    appId: result.appId ?? result.app_id ?? 0,
    reason: '',
  }
}

export function normalizeUbisoftPlaytimePayload(result) {
  if (!result) {
    return {
      available: false,
      playtimeMinutes: 0,
      lastPlayed: '',
      appId: '',
      spaceId: '',
      reason: 'Ubisoft playtime unavailable',
    }
  }

  const playtimeMinutes =
    result.playtimeMinutes ?? result.playtime_minutes ?? 0
  const lastPlayed = result.lastPlayed ?? result.last_played ?? ''

  return {
    available: playtimeMinutes > 0 || !!lastPlayed,
    playtimeMinutes,
    lastPlayed,
    appId: result.appId ?? result.app_id ?? '',
    spaceId: result.spaceId ?? result.space_id ?? '',
    reason: result.reason || '',
  }
}

export function normalizeAchievementsPayload(result) {
  if (!result) {
    return {
      available: false,
      reason: 'Achievements unavailable',
      progress: null,
      achievements: [],
    }
  }

  return {
    available: !!result.available,
    reason: result.reason || '',
    progress: result.progress || null,
    achievements: Array.isArray(result.achievements)
      ? result.achievements
      : [],
  }
}

export function normalizeHltbPayload(result) {
  if (!result) {
    return {
      available: false,
      reason: 'Completion time unavailable',
      main: 0,
      mainExtra: 0,
      completionist: 0,
    }
  }

  return {
    available: !!result.available,
    reason: result.reason || '',
    main: result.main || 0,
    mainExtra: result.mainExtra || 0,
    completionist: result.completionist || 0,
  }
}

export function hasMetadataContent(details) {
  if (!details) return false
  return Boolean(
    details.description_raw ||
      details.storyline ||
      details.developers?.length ||
      details.publishers?.length ||
      details.genres?.length ||
      details.themes?.length ||
      details.primaryAgeRating ||
      details.similarGames?.length ||
      details.franchise ||
      details.collections?.length ||
      details.franchises?.length ||
      details.releaseDate,
  )
}

export function hasAnyResourceData(data) {
  if (data == null) return false
  if (Array.isArray(data)) return data.length > 0
  if (typeof data !== 'object') return true
  return Object.keys(data).length > 0
}
