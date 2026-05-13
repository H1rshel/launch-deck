/**
 * Game Performance Analysis Engine.
 * Compares the user's rig score against game requirements
 * to produce per-game performance expectations and bottleneck insights.
 * Includes a game complexity model to prevent underestimation for older/lighter games.
 */

// ─── Default requirement profiles ───

const DEFAULT_PROFILES = {
  aaa_modern: {
    min: { cpuScore: 55, gpuScore: 55, ramGb: 16, storageType: 'ssd' },
    recommended: { cpuScore: 75, gpuScore: 80, ramGb: 16, storageType: 'ssd' },
    targetProfiles: {
      '1080p_high': { cpuScore: 65, gpuScore: 70, ramGb: 16 },
      '1440p_high': { cpuScore: 75, gpuScore: 85, ramGb: 16 },
      '4k_high': { cpuScore: 80, gpuScore: 95, ramGb: 16 },
    },
  },
  aaa_older: {
    min: { cpuScore: 40, gpuScore: 40, ramGb: 8, storageType: 'hdd' },
    recommended: { cpuScore: 60, gpuScore: 65, ramGb: 16, storageType: 'ssd' },
    targetProfiles: {
      '1080p_high': { cpuScore: 50, gpuScore: 55, ramGb: 16 },
      '1440p_high': { cpuScore: 60, gpuScore: 70, ramGb: 16 },
      '4k_high': { cpuScore: 65, gpuScore: 85, ramGb: 16 },
    },
  },
  legacy: {
    min: { cpuScore: 20, gpuScore: 20, ramGb: 4, storageType: 'hdd' },
    recommended: { cpuScore: 35, gpuScore: 35, ramGb: 8, storageType: 'hdd' },
    targetProfiles: {
      '1080p_high': { cpuScore: 25, gpuScore: 25, ramGb: 4 },
      '1440p_high': { cpuScore: 30, gpuScore: 35, ramGb: 8 },
      '4k_high': { cpuScore: 35, gpuScore: 45, ramGb: 8 },
    },
  },
  indie_light: {
    min: { cpuScore: 25, gpuScore: 20, ramGb: 4, storageType: 'hdd' },
    recommended: { cpuScore: 40, gpuScore: 40, ramGb: 8, storageType: 'hdd' },
    targetProfiles: {
      '1080p_high': { cpuScore: 30, gpuScore: 30, ramGb: 8 },
      '1440p_high': { cpuScore: 40, gpuScore: 45, ramGb: 8 },
      '4k_high': { cpuScore: 45, gpuScore: 55, ramGb: 8 },
    },
  },
  standard: {
    min: { cpuScore: 40, gpuScore: 45, ramGb: 8, storageType: 'hdd' },
    recommended: { cpuScore: 65, gpuScore: 70, ramGb: 16, storageType: 'ssd' },
    targetProfiles: {
      '1080p_high': { cpuScore: 55, gpuScore: 60, ramGb: 16 },
      '1440p_high': { cpuScore: 65, gpuScore: 75, ramGb: 16 },
      '4k_high': { cpuScore: 70, gpuScore: 90, ramGb: 16 },
    },
  },
}

// ─── Performance tiers ───

const PERFORMANCE_TIERS = [
  { min: 93, tier: 'Overkill',         color: 'purple' },
  { min: 78, tier: 'Excellent',        color: 'green'  },
  { min: 62, tier: 'Optimized',        color: 'cyan'   },
  { min: 46, tier: 'Playable',         color: 'amber'  },
  { min: 30, tier: 'Demanding',        color: 'orange' },
  { min: 0,  tier: 'Not Recommended', color: 'red'    },
]

function getTier(score) {
  return PERFORMANCE_TIERS.find((t) => score >= t.min) || PERFORMANCE_TIERS[PERFORMANCE_TIERS.length - 1]
}

// ─── Game complexity model ───

/**
 * Compute how demanding a game is (0–100) and the legacy boost to apply.
 * Older / lighter games get a boost so they correctly show Excellent/Overkill
 * on modern hardware instead of being underestimated.
 */
function computeGameComplexity(game) {
  if (!game) return { score: 60, legacyBoost: 0 }

  const genres = (game.genres || []).map((g) =>
    (typeof g === 'string' ? g : g?.name || '').toLowerCase(),
  )
  const year = game.release_date ? new Date(game.release_date).getFullYear() : null

  const lightGenres = ['indie', 'puzzle', 'platformer', 'casual', 'card', 'board', 'visual novel', 'arcade']
  const heavyGenres = ['open world', 'shooter', 'racing', 'simulation', 'action rpg', 'mmorpg', 'battle royale']

  const isLight = lightGenres.some((lg) => genres.some((g) => g.includes(lg)))
  const isHeavy = heavyGenres.some((hg) => genres.some((g) => g.includes(hg)))

  // Base complexity from release year
  let base = 60
  if (year) {
    if (year < 2010)      base = 12
    else if (year < 2014) base = 22
    else if (year < 2018) base = 38
    else if (year < 2022) base = 58
    else                  base = 75
  }

  // Genre modifier
  if (isLight) base = Math.max(12, base - 20)
  if (isHeavy && year && year >= 2022) base = Math.min(100, base + 15)

  // Legacy boost: older/simpler games get an additive bonus to the fit score
  let legacyBoost = 0
  if (base < 20)      legacyBoost = 28
  else if (base < 30) legacyBoost = 20
  else if (base < 45) legacyBoost = 10
  else if (base < 55) legacyBoost = 4

  return { score: base, legacyBoost }
}

// ─── Confidence indicator ───

function computeConfidence(game, profileSource) {
  if (profileSource === 'explicit') return { level: 'high', label: 'High confidence' }

  const hasYear = !!game?.release_date
  const hasGenres = (game?.genres?.length ?? 0) > 0

  if (hasYear && hasGenres) return { level: 'medium', label: 'Estimated from metadata' }
  if (hasYear || hasGenres) return { level: 'low', label: 'Based on similar titles' }
  return { level: 'low', label: 'Estimated' }
}

// ─── Main analysis function ───

/**
 * Analyze how a game should run on the user's rig.
 * @param {object} rigScore - Result from scoreRig()
 * @param {object} game - Game object (name, genres, release_date, etc.)
 * @param {object} [gameRequirements] - Optional explicit game requirements
 * @returns {object} Performance analysis result
 */
export function analyzeGamePerformance(rigScore, game, gameRequirements = null) {
  if (!rigScore || rigScore.overall.score === 0) {
    return { available: false, reason: 'Hardware not detected' }
  }

  const profile = gameRequirements || estimateRequirements(game)
  const profileSource = gameRequirements ? 'explicit' : 'estimated'
  const { score: complexityScore, legacyBoost } = computeGameComplexity(game)
  const confidence = computeConfidence(game, profileSource)

  const cpuScore = rigScore.cpu.score
  const gpuScore = rigScore.gpu.score
  const ramScore = rigScore.ram.score
  const storageScore = rigScore.storage.score
  const storageSummary = rigScore.storage // has hasNvme, hasHdd, statusLines etc.

  const meetsMin = cpuScore >= profile.min.cpuScore && gpuScore >= profile.min.gpuScore && ramScore >= 30

  // Compute per-resolution scores first (used for both bars and bestTarget)
  const resolutions = {
    '1080p': evaluateResolution(rigScore, profile, '1080p_high', complexityScore, legacyBoost),
    '1440p': evaluateResolution(rigScore, profile, '1440p_high', complexityScore, legacyBoost),
    '4k':    evaluateResolution(rigScore, profile, '4k_high',    complexityScore, legacyBoost),
  }

  // Best target: highest resolution with a comfortable performance margin.
  // Require Excellent+ (≥78) at 1440p and a strong Excellent (≥82) at 4K.
  let targetKey = '1080p'
  if (resolutions['1440p'].score >= 55) targetKey = '1440p'
  if (resolutions['4k'].score   >= 78)  targetKey = '4k'
  const bestTarget = { '1080p': '1080p High', '1440p': '1440p High', '4k': '4K High' }[targetKey]

  // Compute effective performance score with complexity + legacy boost
  const overallFit = computeGameFitScore(rigScore, profile, complexityScore, legacyBoost)
  const tierInfo = getTier(overallFit)

  const meetsRecommended = resolutions[targetKey].score >= 62

  const limiter = determineLimitingFactor(cpuScore, gpuScore, ramScore, storageScore, profile, storageSummary)

  const description = generateDescription(
    tierInfo, targetKey, limiter, game, complexityScore, legacyBoost, meetsMin,
  )

  return {
    available: true,
    overallFit,
    tier: tierInfo.tier,
    tierColor: tierInfo.color,
    // backward compat
    status: tierInfo.tier,
    statusColor: tierInfo.color,
    meetsMinimum: meetsMin,
    meetsRecommended,
    targetKey,
    bestTarget,
    limitingFactor: limiter,
    description,
    explanation: description,
    resolutions,
    complexity: { score: complexityScore, legacyBoost },
    confidence,
    profileSource,
  }
}

// ─── Score computation ───

function computeGameFitScore(rigScore, profile, complexityScore, legacyBoost) {
  // Complexity multiplier only boosts old/simple games — never penalises modern ones
  const complexityMult = Math.max(1.0, 1 + (50 - complexityScore) / 100)
  const effGpu = Math.min(rigScore.gpu.score * complexityMult, 100)

  const rec = profile.recommended
  const cpuRatio = Math.min(rigScore.cpu.score / rec.cpuScore, 1.5)
  const gpuRatio = Math.min(effGpu / rec.gpuScore, 1.5)
  const ramRatio = Math.min(rigScore.ram.score / 70, 1.2)

  // Hardware fit against requirements (scale to ~70 max before adjustments)
  const hardwareFit = (gpuRatio * 0.5 + cpuRatio * 0.35 + ramRatio * 0.15) * 70

  const raw = hardwareFit + legacyBoost
  return Math.round(Math.min(Math.max(raw, 0), 100))
}

// ─── Bottleneck detection ───

function determineLimitingFactor(cpuScore, gpuScore, ramScore, storageScore, profile, storageSummary) {
  const rec = profile.recommended

  // Storage gap is based on actual drive type, not score
  const storageGap = storageSummary?.hasHdd && !storageSummary?.hasNvme && !storageSummary?.hasSsd ? 40 : 0

  const gaps = [
    { component: 'GPU',     gap: rec.gpuScore - gpuScore, weight: 2.0 },
    { component: 'CPU',     gap: rec.cpuScore - cpuScore, weight: 1.5 },
    { component: 'RAM',     gap: 70 - ramScore,           weight: 0.8 },
    { component: 'Storage', gap: storageGap,              weight: 0.6 },
  ]

  const limiting = gaps.filter((g) => g.gap > 0).sort((a, b) => b.gap * b.weight - a.gap * a.weight)

  if (limiting.length === 0) {
    return { component: 'balanced', label: 'No bottleneck — well balanced for this game' }
  }

  const top = limiting[0]
  const messages = {
    GPU:     'GPU is the limiting factor for higher resolutions',
    CPU:     'CPU may limit high-FPS gameplay',
    RAM:     'RAM may affect performance in memory-heavy scenes',
    Storage: storageSummary?.hasHdd
      ? 'Installed on HDD — expect longer load times and possible streaming stutter'
      : 'Storage speed may increase load times',
  }

  return {
    component: top.component.toLowerCase(),
    label: messages[top.component] || `${top.component} may be limiting`,
  }
}

// ─── Per-resolution evaluation ───

/**
 * Score is relative to what THIS GAME demands at the given resolution, not raw rig power.
 * Scaling factor (67) is calibrated so that exactly meeting the game's target profile
 * gives ~67 ("Optimized"), being ~20% above gives ~78+ ("Excellent"), and being ~40%+
 * above gives 93+ ("Overkill").
 */
function evaluateResolution(rigScore, profile, targetKey, complexityScore, legacyBoost) {
  const complexityMult = Math.max(1.0, 1 + (50 - complexityScore) / 100)
  const effGpu = Math.min(rigScore.gpu.score * complexityMult, 100)
  const cpuScore = rigScore.cpu.score
  const ramScore = rigScore.ram.score

  const target = profile.targetProfiles[targetKey]

  // How much does the rig exceed (or fall short of) what this game needs at this resolution?
  const gpuRatio = Math.min(effGpu / target.gpuScore, 1.5)
  const cpuRatio = Math.min(cpuScore / target.cpuScore, 1.5)
  const ramRatio = Math.min(ramScore / 70, 1.3)

  // GPU carries the most weight at higher resolutions; CPU dominates at 1080p
  let gpuW, cpuW, ramW
  if (targetKey === '1080p_high') {
    gpuW = 0.55; cpuW = 0.35; ramW = 0.10
  } else if (targetKey === '1440p_high') {
    gpuW = 0.62; cpuW = 0.28; ramW = 0.10
  } else {
    // 4k_high — almost entirely GPU-bound
    gpuW = 0.72; cpuW = 0.18; ramW = 0.10
  }

  const weightedRatio = gpuRatio * gpuW + cpuRatio * cpuW + ramRatio * ramW
  const raw = weightedRatio * 67 + legacyBoost
  const perfScore = Math.min(100, Math.max(0, Math.round(raw)))

  const tier = getTier(perfScore)
  return { label: tier.tier, score: perfScore, color: tier.color }
}

// ─── Context-aware description ───

function generateDescription(tierInfo, targetKey, limiter, game, complexityScore, legacyBoost, meetsMin) {
  const isLegacy = legacyBoost >= 20
  const isLight  = complexityScore < 40
  const targetLabel = { '1080p': '1080p', '1440p': '1440p', '4k': '4K' }[targetKey] || targetKey

  if (!meetsMin) {
    return 'Your hardware may struggle with this title. Consider lowering settings significantly.'
  }

  if (tierInfo.tier === 'Overkill') {
    if (isLegacy) return `Very lightweight for your hardware — runs flawlessly at ${targetLabel} and beyond.`
    if (isLight)  return 'Extremely light for your rig — maximum settings at any resolution, no contest.'
    return 'Complete overkill — expect locked maximum framerates at any resolution.'
  }

  if (tierInfo.tier === 'Excellent') {
    if (isLegacy) return `Old title — no challenge for your hardware. Enjoy buttery performance at ${targetLabel}.`
    if (targetKey === '4k')    return 'Your rig handles this beautifully at 4K. Enjoy maxed-out settings.'
    if (targetKey === '1440p') return `Well matched for your hardware — expect smooth ${targetLabel} gameplay at max settings.`
    return 'Well matched for your system — expect smooth, high-quality gameplay.'
  }

  if (tierInfo.tier === 'Optimized') {
    if (targetKey === '1440p') {
      if (limiter.component === 'gpu') return `Well optimized for your system — enjoy ${targetLabel} gameplay. GPU limits 4K headroom.`
      return `Well optimized for your system — expect smooth ${targetLabel} gameplay.`
    }
    if (targetKey === '4k') return 'Solid 4K performance. Minor settings tweaks may help reach locked framerates.'
    return 'Should run smoothly at your target resolution and settings.'
  }

  if (tierInfo.tier === 'Playable') {
    if (limiter.component === 'gpu') return `Playable at ${targetLabel}. GPU is the main limitation — drop settings for higher resolutions.`
    if (limiter.component === 'cpu') return 'Playable but CPU-limited — high FPS may require settings adjustments.'
    return `Playable at ${targetLabel} with high settings. Reduce quality for smoother performance.`
  }

  if (tierInfo.tier === 'Demanding') {
    return `Demanding title for your current hardware. Medium settings at ${targetLabel} recommended.`
  }

  return 'Performance may be limited. Check minimum requirements and lower settings.'
}

// ─── Requirement estimation from metadata ───

function estimateRequirements(game) {
  if (!game) return DEFAULT_PROFILES.standard

  const genres = (game.genres || []).map((g) =>
    (typeof g === 'string' ? g : g?.name || '').toLowerCase(),
  )
  const releaseYear = game.release_date ? new Date(game.release_date).getFullYear() : null

  const lightGenres = ['indie', 'puzzle', 'platformer', 'casual', 'card', 'board games', 'visual novel']
  if (lightGenres.some((lg) => genres.some((g) => g.includes(lg)))) {
    return DEFAULT_PROFILES.indie_light
  }

  if (releaseYear && releaseYear < 2014) {
    return DEFAULT_PROFILES.legacy
  }

  const heavyGenres = ['open world', 'shooter', 'racing', 'simulation', 'action rpg']
  const isHeavy = heavyGenres.some((hg) => genres.some((g) => g.includes(hg)))

  if (releaseYear && releaseYear >= 2023 && isHeavy) {
    return DEFAULT_PROFILES.aaa_modern
  }

  if (releaseYear && releaseYear < 2020) {
    return DEFAULT_PROFILES.aaa_older
  }

  return DEFAULT_PROFILES.standard
}
