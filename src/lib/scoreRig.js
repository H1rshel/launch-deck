/**
 * Rig Scoring Engine.
 * Takes a hardware snapshot + hardware DB lookups and produces
 * overall rig grades, per-component scores, and gaming readiness profiles.
 */

import { lookupCpu, lookupGpu, getRamGrade } from './hardwareDb'
import { resolveHardwareEntry } from './normalizeHardware'
import { getHardwareDb } from './hardwareDb'

// ─── Score → Grade mapping ───

function scoreToGrade(score) {
  if (score >= 90) return 'S'
  if (score >= 80) return 'A'
  if (score >= 65) return 'B'
  if (score >= 50) return 'C'
  return 'D'
}

function scoreToLabel(score) {
  if (score >= 90) return 'Excellent'
  if (score >= 80) return 'Strong'
  if (score >= 65) return 'Good'
  if (score >= 50) return 'Moderate'
  if (score >= 35) return 'Limited'
  return 'Insufficient'
}

// ─── Readiness-specific label (different scale, includes Overkill) ───

function readinessLabel(score) {
  if (score >= 75) return 'Excellent'
  if (score >= 60) return 'Strong'
  if (score >= 46) return 'Capable'
  if (score >= 35) return 'Limited'
  return 'Struggling'
}

// ─── Weights ───

const WEIGHTS = { gpu: 0.50, cpu: 0.30, ram: 0.10, storage: 0.10 }

// ─── Drive type base scores ───

const TYPE_SCORES = { nvme: 95, sata_ssd: 75, ssd: 75, hdd: 30 }

// ─── Multi-drive aware storage scoring ───

function computeStorageScore(storage) {
  if (!storage?.length) {
    return {
      score: 30, grade: 'D', label: 'Unknown',
      hasNvme: false, hasHdd: false, hasSsd: false,
      systemDriveType: 'hdd', bestType: 'hdd', statusLines: [],
    }
  }

  const systemDrive = storage.find((d) => d.isSystemDrive) || storage[0]
  const systemScore = TYPE_SCORES[systemDrive?.type] ?? 30

  // Best fast (non-HDD) drive score
  const fastDrives = storage.filter((d) => d.type !== 'hdd')
  const bestFastScore = fastDrives.length > 0
    ? Math.max(...fastDrives.map((d) => TYPE_SCORES[d.type] ?? 30))
    : systemScore

  // Fast storage availability bonus based on total SSD/NVMe capacity
  const totalFastGb = fastDrives.reduce((s, d) => s + (d.sizeGb || 0), 0)
  const fastAvailScore = totalFastGb >= 500 ? 85 : totalFastGb >= 250 ? 70 : totalFastGb > 0 ? 55 : 30

  // Weighted composite: best gaming drive matters most, system drive secondary
  const score = Math.round(
    bestFastScore * 0.5 +
    systemScore * 0.3 +
    fastAvailScore * 0.2,
  )

  const hasNvme = storage.some((d) => d.type === 'nvme')
  const hasSsd = storage.some((d) => d.type === 'sata_ssd' || d.type === 'ssd')
  const hasHdd = storage.some((d) => d.type === 'hdd')
  const bestType = hasNvme ? 'nvme' : hasSsd ? 'sata_ssd' : 'hdd'

  const statusLines = []
  if (hasNvme) statusLines.push('Fast NVMe storage available')
  else if (hasSsd) statusLines.push('SATA SSD storage')
  if (hasHdd && (hasNvme || hasSsd)) statusLines.push('Archive drives detected (HDD)')
  else if (hasHdd && !hasNvme && !hasSsd) statusLines.push('HDD only — longer load times expected')
  if (!hasNvme && hasHdd) statusLines.push('An NVMe SSD would significantly improve load times')

  return {
    score: Math.min(score, 100),
    grade: scoreToGrade(score),
    label: hasNvme ? 'NVMe' : hasSsd ? 'SSD' : 'HDD',
    hasNvme,
    hasHdd,
    hasSsd,
    systemDriveType: systemDrive?.type || 'hdd',
    bestType,
    statusLines,
  }
}

// ─── Main scoring function ───

/**
 * Score the full rig.
 * @param {object} snapshot - Normalized hardware snapshot from detectHardware()
 * @returns {object} Complete rig score result
 */
export function scoreRig(snapshot) {
  if (!snapshot) return getUnknownResult()

  const db = getHardwareDb()

  const cpuEntry = snapshot.cpu
    ? lookupCpu(snapshot.cpu.normalizedName) ||
      resolveHardwareEntry(snapshot.cpu.normalizedName, db.cpus, 'cpu')
    : null

  const gpuEntry = snapshot.gpu
    ? lookupGpu(snapshot.gpu.normalizedName) ||
      resolveHardwareEntry(snapshot.gpu.normalizedName, db.gpus, 'gpu')
    : null

  const ramGrade = snapshot.ram ? getRamGrade(snapshot.ram.totalGb) : { score: 0, label: 'unknown' }
  const storageSummary = computeStorageScore(snapshot.storage)

  const cpuScore = cpuEntry?.gamingScore ?? estimateCpuScore(snapshot.cpu)
  const gpuScore = gpuEntry?.gamingScore ?? estimateGpuScore(snapshot.gpu)
  const ramScore = ramGrade.score
  const storageScore = storageSummary.score

  const overallScore = Math.round(
    gpuScore * WEIGHTS.gpu +
    cpuScore * WEIGHTS.cpu +
    ramScore * WEIGHTS.ram +
    storageScore * WEIGHTS.storage,
  )

  const overallGrade = scoreToGrade(overallScore)
  const readiness = computeGamingReadiness(cpuScore, gpuScore, gpuEntry, ramScore, snapshot)

  const components = [
    { name: 'GPU', score: gpuScore },
    { name: 'CPU', score: cpuScore },
    { name: 'RAM', score: ramScore },
    { name: 'Storage', score: storageScore },
  ].sort((a, b) => b.score - a.score)

  const strengths = generateStrengths(components, readiness, snapshot, gpuEntry)
  const weaknesses = generateWeaknesses(components, snapshot, ramGrade, storageSummary)
  const upgradeHints = generateUpgradeHints(components, snapshot, storageSummary)
  const rigDescription = generateRigDescription(overallScore, overallGrade, readiness, snapshot)
  const performanceIdentity = generatePerformanceIdentity(overallScore, gpuScore, cpuScore, readiness, snapshot)

  return {
    overall: {
      score: overallScore,
      grade: overallGrade,
      label: scoreToLabel(overallScore),
      description: rigDescription,
      performanceIdentity,
    },
    cpu: {
      score: cpuScore,
      grade: scoreToGrade(cpuScore),
      label: scoreToLabel(cpuScore),
      entry: cpuEntry,
      recognized: !!cpuEntry && !cpuEntry._familyMatch,
      familyMatch: !!cpuEntry?._familyMatch,
    },
    gpu: {
      score: gpuScore,
      grade: scoreToGrade(gpuScore),
      label: scoreToLabel(gpuScore),
      entry: gpuEntry,
      recognized: !!gpuEntry && !gpuEntry._familyMatch,
      familyMatch: !!gpuEntry?._familyMatch,
    },
    ram: {
      score: ramScore,
      grade: scoreToGrade(ramScore),
      label: ramGrade.label,
    },
    storage: storageSummary,
    readiness,
    strengths,
    weaknesses,
    upgradeHints,
    scoredAt: new Date().toISOString(),
  }
}

// ─── Gaming Readiness ───

function computeGamingReadiness(cpuScore, gpuScore, gpuEntry, ramScore, snapshot) {
  // GPU effectiveness decreases at higher resolutions (pixel workload scaling)
  const gpuEff1440 = gpuScore * 0.68
  const gpuEff4k   = gpuScore * 0.55

  // Performance scores — GPU weight increases at higher resolutions (more GPU-bound)
  const perf1080    = Math.round(gpuScore    * 0.60 + cpuScore * 0.30 + ramScore * 0.10)
  const perf1440    = Math.round(gpuEff1440  * 0.70 + cpuScore * 0.20 + ramScore * 0.10)
  const perf4k      = Math.round(gpuEff4k    * 0.80 + cpuScore * 0.10 + ramScore * 0.10)
  const perfEsports = Math.round(cpuScore * 0.55 + gpuScore * 0.30 + ramScore * 0.15)

  // Target: highest resolution with a sustained-60-FPS-calibrated score >= threshold
  let primaryResolution = '1080p'
  if (perf1440 >= 55) primaryResolution = '1440p'
  if (perf4k   >= 56) primaryResolution = '4k'

  // Overkill: GPU is far too powerful for this resolution
  const is1080Overkill = primaryResolution !== '1080p' && perf1080 >= 70
  const is1440Overkill = primaryResolution === '4k'    && perf1440 >= 68

  // Labels (Overkill overrides regular label)
  const label1080    = is1080Overkill ? 'Overkill' : readinessLabel(perf1080)
  const label1440    = is1440Overkill ? 'Overkill' : readinessLabel(perf1440)
  const label4k      = readinessLabel(perf4k)
  const labelEsports = readinessLabel(perfEsports)

  const rtMap = { flagship: 95, strong: 80, good: 65, moderate: 45, limited: 30, none: 5 }
  const rtCapability = gpuEntry?.rayTracing || 'none'
  const rayTracing = rtMap[rtCapability] || 10

  return {
    primaryResolution,
    '1080p':    { score: perf1080,    label: label1080,    isOverkill: is1080Overkill },
    '1440p':    { score: perf1440,    label: label1440,    isOverkill: is1440Overkill },
    '4k':       { score: perf4k,      label: label4k,      isOverkill: false },
    esports:    { score: perfEsports, label: labelEsports, isOverkill: false },
    rayTracing: { score: rayTracing,  label: readinessLabel(rayTracing), capability: rtCapability },
  }
}

// ─── Fallback score estimation ───

function estimateCpuScore(cpu) {
  if (!cpu) return 30
  const { threads } = cpu
  if (threads >= 24) return 85
  if (threads >= 16) return 75
  if (threads >= 12) return 65
  if (threads >= 8) return 55
  if (threads >= 4) return 40
  return 30
}

function estimateGpuScore(gpu) {
  if (!gpu) return 20
  const vram = gpu.vramGb || 0
  if (vram >= 24) return 85
  if (vram >= 16) return 75
  if (vram >= 12) return 65
  if (vram >= 8) return 50
  if (vram >= 6) return 40
  if (vram >= 4) return 30
  return 20
}

// ─── Performance Identity label ───

function generatePerformanceIdentity(score, gpuScore, cpuScore, readiness, snapshot) {
  const primary = readiness.primaryResolution

  if (primary === '4k') {
    if (score >= 88) return '4K Powerhouse'
    return '4K-Ready Rig'
  }
  if (primary === '1440p') {
    if (score >= 85) return '1440p Powerhouse'
    if (gpuScore >= cpuScore + 12) return 'GPU-Dominant 1440p Build'
    return '1440p Gaming Rig'
  }
  // primary === '1080p'
  if (readiness.esports.score >= 82) return 'Esports Optimized'
  if (score >= 70) return '1080p Performance Rig'
  if (score >= 45) return 'Mainstream Gaming PC'
  return 'Entry-Level Rig'
}

// ─── Insight generation ───

function generateStrengths(components, readiness, snapshot, gpuEntry) {
  const strengths = []
  const top = components[0]

  if (top.score >= 85) {
    strengths.push(`Your ${top.name} is your strongest component — it's exceptional`)
  } else if (top.score >= 75) {
    strengths.push(`Your ${top.name} is your strongest component`)
  }

  const primary = readiness.primaryResolution
  if (primary === '4k') {
    strengths.push('Your system handles 4K gaming with ease')
  } else if (primary === '1440p') {
    strengths.push('Your system is ideal for 1440p gaming')
  } else if (readiness['1080p'].score >= 85) {
    strengths.push('Excellent 1080p gaming performance')
  }

  if (readiness.esports.score >= 85) {
    strengths.push('Built for high refresh rate and competitive gaming')
  }
  if (gpuEntry?.rayTracing === 'flagship' || gpuEntry?.rayTracing === 'strong') {
    strengths.push('Strong ray tracing support for immersive visuals')
  }
  if (snapshot.ram?.totalGb >= 32) {
    strengths.push('Plenty of RAM — no bottlenecks from memory')
  }

  return strengths.slice(0, 4)
}

function generateWeaknesses(components, snapshot, ramGrade, storageSummary) {
  const weaknesses = []
  const weakest = components[components.length - 1]

  if (weakest.score < 50) {
    weaknesses.push(`Your ${weakest.name} is holding your rig back`)
  } else if (weakest.score < 65) {
    weaknesses.push(`Your ${weakest.name} may limit performance in demanding titles`)
  }
  if (snapshot.ram?.totalGb <= 8) {
    weaknesses.push('8 GB RAM is below recommended for most modern games')
  }
  if (storageSummary.hasHdd && !storageSummary.hasNvme && !storageSummary.hasSsd) {
    weaknesses.push('HDD-only setup will cause noticeably longer load times')
  }
  if (snapshot.ram?.totalGb === 16) {
    weaknesses.push('16 GB RAM is fine today, but 32 GB is better for newer AAA titles')
  }

  return weaknesses.slice(0, 3)
}

function generateUpgradeHints(components, snapshot, storageSummary) {
  const hints = []
  const sorted = [...components].sort((a, b) => a.score - b.score)

  for (const c of sorted) {
    if (c.score < 65) {
      if (c.name === 'RAM' && (snapshot.ram?.totalGb ?? 0) < 32) {
        hints.push('Upgrading to 32 GB RAM would help in memory-heavy open-world games')
      } else if (c.name === 'GPU') {
        hints.push('A GPU upgrade would have the biggest impact on gaming performance')
      } else if (c.name === 'CPU') {
        hints.push('A newer CPU would help in CPU-bound games and high-FPS scenarios')
      }
    }
  }

  if (!storageSummary.hasNvme) {
    hints.push('Adding an NVMe SSD would significantly improve load times and game streaming')
  }

  if (
    (snapshot.ram?.totalGb ?? 0) <= 16 &&
    (snapshot.ram?.totalGb ?? 0) >= 12 &&
    !hints.some((h) => h.includes('RAM'))
  ) {
    hints.push('Upgrading RAM is the easiest way to future-proof your system')
  }

  return hints.slice(0, 3)
}

function generateRigDescription(score, grade, readiness, snapshot) {
  const platform = snapshot.platformType === 'laptop' ? 'laptop' : 'rig'

  if (score >= 92) return `Top-tier gaming ${platform}`
  if (score >= 85 && readiness['1440p'].score >= 80) return `Strong 1440p gaming ${platform}`
  if (score >= 80) return `Powerful upper-midrange ${platform}`
  if (score >= 70) return `Balanced midrange gaming ${platform}`
  if (score >= 60) return `Solid 1080p gaming ${platform}`
  if (score >= 45) return `Entry-level gaming ${platform}`
  return `Basic ${platform}`
}

function getUnknownResult() {
  return {
    overall: {
      score: 0, grade: 'D', label: 'Unknown',
      description: 'Hardware not detected', performanceIdentity: null,
    },
    cpu: { score: 0, grade: 'D', label: 'Unknown', entry: null, recognized: false, familyMatch: false },
    gpu: { score: 0, grade: 'D', label: 'Unknown', entry: null, recognized: false, familyMatch: false },
    ram: { score: 0, grade: 'D', label: 'unknown' },
    storage: {
      score: 0, grade: 'D', label: 'unknown',
      hasNvme: false, hasHdd: false, hasSsd: false,
      systemDriveType: 'hdd', bestType: 'hdd', statusLines: [],
    },
    readiness: {
      '1080p': { score: 0, label: 'Unknown' },
      '1440p': { score: 0, label: 'Unknown' },
      '4k': { score: 0, label: 'Unknown' },
      esports: { score: 0, label: 'Unknown' },
      rayTracing: { score: 0, label: 'Unknown', capability: 'unknown' },
    },
    strengths: [],
    weaknesses: ['Hardware detection unavailable'],
    upgradeHints: [],
    scoredAt: new Date().toISOString(),
  }
}
