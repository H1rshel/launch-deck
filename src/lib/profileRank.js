// Rank thresholds — ordered from lowest to highest score
const RANKS = [
  { name: 'Newcomer',  minScore: 0   },
  { name: 'Player',    minScore: 25  },
  { name: 'Regular',   minScore: 75  },
  { name: 'Dedicated', minScore: 150 },
  { name: 'Veteran',   minScore: 250 },
  { name: 'Elite',     minScore: 400 },
  { name: 'Master',    minScore: 600 },
  { name: 'Legend',    minScore: 900 },
]

export const RANK_LIST = RANKS

/**
 * Calculate a player's profile rank from their games array.
 *
 * Score formula:
 *   totalPlaytimeMinutes (per game) = playtime_minutes + imported_playtime_minutes
 *   totalPlaytimeHours              = floor(sum(totalPlaytimeMinutes) / 60)
 *   activeGamesCount                = games where totalPlaytimeMinutes >= 30
 *   launchDeckPlaytimeHours         = floor(sum(playtime_minutes) / 60)
 *
 *   experienceScore  = totalPlaytimeHours < 20 ? floor(totalPlaytimeHours * 1.5) : totalPlaytimeHours
 *   breadthScore     = activeGamesCount × 6
 *   launchDeckBonus  = floor(launchDeckPlaytimeHours × 0.5)
 *   finalScore       = experienceScore + breadthScore + launchDeckBonus
 *
 * @param {Array<{ playtime_minutes?: number, imported_playtime_minutes?: number }>} [games]
 * @returns {{
 *   totalPlaytimeHours: number,
 *   activeGamesCount: number,
 *   launchDeckPlaytimeHours: number,
 *   experienceScore: number,
 *   breadthScore: number,
 *   launchDeckBonus: number,
 *   finalScore: number,
 *   rank: string,
 *   nextRank: string | null,
 *   nextRankMinScore: number | null,
 *   pointsToNextRank: number | null,
 *   progressWithinRankPercent: number
 * }}
 */
export function getProfileRank(games = []) {
  let totalMinutesSum = 0
  let ldMinutesSum = 0
  let activeGamesCount = 0

  for (const g of games) {
    const ld  = Math.max(0, g.playtime_minutes || 0)
    const imp = Math.max(0, g.imported_playtime_minutes || 0)
    const total = ld + imp
    totalMinutesSum += total
    ldMinutesSum += ld
    if (total >= 30) activeGamesCount++
  }

  const totalPlaytimeHours      = Math.floor(totalMinutesSum / 60)
  const launchDeckPlaytimeHours = Math.floor(ldMinutesSum / 60)

  const experienceScore = totalPlaytimeHours < 20
    ? Math.floor(totalPlaytimeHours * 1.5)
    : totalPlaytimeHours
  const breadthScore    = activeGamesCount * 6
  const launchDeckBonus = Math.floor(launchDeckPlaytimeHours * 0.5)
  const finalScore      = experienceScore + breadthScore + launchDeckBonus

  // Find highest rank the player qualifies for
  let rankIndex = 0
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (finalScore >= RANKS[i].minScore) {
      rankIndex = i
      break
    }
  }

  const isMaxRank        = rankIndex === RANKS.length - 1
  const currentRankEntry = RANKS[rankIndex]
  const nextRankEntry    = isMaxRank ? null : RANKS[rankIndex + 1]

  const rank             = currentRankEntry.name
  const nextRank         = nextRankEntry?.name ?? null
  const nextRankMinScore = nextRankEntry?.minScore ?? null
  const pointsToNextRank = nextRankEntry ? nextRankMinScore - finalScore : null

  // Progress percentage within the current rank band (0–100)
  let progressWithinRankPercent = 100
  if (!isMaxRank) {
    const range  = nextRankEntry.minScore - currentRankEntry.minScore
    const earned = finalScore - currentRankEntry.minScore
    progressWithinRankPercent = Math.min(100, Math.round((earned / range) * 100))
  }

  return {
    totalPlaytimeHours,
    activeGamesCount,
    launchDeckPlaytimeHours,
    experienceScore,
    breadthScore,
    launchDeckBonus,
    finalScore,
    rank,
    nextRank,
    nextRankMinScore,
    pointsToNextRank,
    progressWithinRankPercent,
  }
}
