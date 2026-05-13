/**
 * Hardware name normalization layer.
 * Cleans raw hardware names from WMI/system detection into
 * concise, recognizable names suitable for DB lookups and display.
 */

// ─── CPU Normalization ───

const CPU_STRIP_PATTERNS = [
  /\(R\)/gi,
  /\(TM\)/gi,
  /\(C\)/gi,
  /CPU\s*/gi,
  /Processor/gi,
  /\d+-Core/gi,
  /with Radeon.*$/i,
  /with Intel.*$/i,
  /@ [\d.]+\s*GHz/i,
  /\s{2,}/g,
]

const CPU_FAMILY_PATTERNS = [
  { regex: /Core\s*i(\d)\s*[-\s]?(\d{4,5}\w*)/i, format: (m) => `Core i${m[1]}-${m[2]}` },
  { regex: /Core\s*Ultra\s*(\d)\s*(\d{3}\w*)/i, format: (m) => `Core Ultra ${m[1]} ${m[2]}` },
  { regex: /Ryzen\s*(\d)\s+(\d{4}\w*)/i, format: (m) => `Ryzen ${m[1]} ${m[2]}` },
  { regex: /Ryzen\s*Threadripper\s*(\w+)/i, format: (m) => `Ryzen Threadripper ${m[1]}` },
  { regex: /Ryzen\s*(\d)\s+PRO\s+(\d{4}\w*)/i, format: (m) => `Ryzen ${m[1]} PRO ${m[2]}` },
]

export function normalizeCpuName(rawName) {
  if (!rawName) return ''
  let name = rawName.trim()

  // Try to extract a clean family match first
  for (const { regex, format } of CPU_FAMILY_PATTERNS) {
    const m = name.match(regex)
    if (m) return format(m)
  }

  // Fallback: strip noise
  for (const pat of CPU_STRIP_PATTERNS) {
    name = name.replace(pat, ' ')
  }

  // Remove leading vendor
  name = name.replace(/^(AMD|Intel)\s+/i, '').trim()

  return name || rawName
}

// ─── GPU Normalization ───

const GPU_STRIP_PATTERNS = [
  /\(R\)/gi,
  /\(TM\)/gi,
  /NVIDIA\s*/gi,
  /AMD\s*/gi,
  /Intel\s*/gi,
  /GeForce\s*/gi,
  /Radeon\s*/gi,
  /Graphics\s*/gi,
  /\s{2,}/g,
]

const GPU_FAMILY_PATTERNS = [
  // NVIDIA RTX/GTX
  { regex: /(?:NVIDIA\s+)?(?:GeForce\s+)?(RTX\s*\d{4}\s*(?:Ti|SUPER|Ti\s*SUPER)?)/i, format: (m) => m[1].replace(/\s+/g, ' ').trim() },
  { regex: /(?:NVIDIA\s+)?(?:GeForce\s+)?(GTX\s*\d{3,4}\s*(?:Ti|SUPER)?)/i, format: (m) => m[1].replace(/\s+/g, ' ').trim() },
  // AMD Radeon RX
  { regex: /(?:AMD\s+)?(?:Radeon\s+)?(RX\s*\d{4}\s*(?:XT|XTX|GRE)?)/i, format: (m) => m[1].replace(/\s+/g, ' ').trim() },
  // Intel Arc
  { regex: /(?:Intel\s+)?(?:Arc\s+)?(A\d{3}\w*)/i, format: (m) => `Arc ${m[1]}` },
]

export function normalizeGpuName(rawName) {
  if (!rawName) return ''
  let name = rawName.trim()

  for (const { regex, format } of GPU_FAMILY_PATTERNS) {
    const m = name.match(regex)
    if (m) return format(m)
  }

  // Fallback: strip noise
  for (const pat of GPU_STRIP_PATTERNS) {
    name = name.replace(pat, ' ')
  }

  return name.trim() || rawName
}

// ─── Family Detection ───

export function detectCpuFamily(normalizedName) {
  if (!normalizedName) return 'unknown'
  const n = normalizedName.toLowerCase()
  if (n.includes('core ultra')) return 'intel_core_ultra'
  if (n.includes('core i9')) return 'intel_core_i9'
  if (n.includes('core i7')) return 'intel_core_i7'
  if (n.includes('core i5')) return 'intel_core_i5'
  if (n.includes('core i3')) return 'intel_core_i3'
  if (n.includes('threadripper')) return 'amd_threadripper'
  if (n.includes('ryzen 9')) return 'amd_ryzen_9'
  if (n.includes('ryzen 7')) return 'amd_ryzen_7'
  if (n.includes('ryzen 5')) return 'amd_ryzen_5'
  if (n.includes('ryzen 3')) return 'amd_ryzen_3'
  return 'unknown'
}

export function detectGpuFamily(normalizedName) {
  if (!normalizedName) return 'unknown'
  const n = normalizedName.toLowerCase()
  if (n.includes('rtx 50')) return 'nvidia_rtx_50'
  if (n.includes('rtx 40')) return 'nvidia_rtx_40'
  if (n.includes('rtx 30')) return 'nvidia_rtx_30'
  if (n.includes('rtx 20')) return 'nvidia_rtx_20'
  if (n.includes('gtx 16')) return 'nvidia_gtx_16'
  if (n.includes('gtx 10')) return 'nvidia_gtx_10'
  if (n.includes('rx 9')) return 'amd_rx_9000'
  if (n.includes('rx 7')) return 'amd_rx_7000'
  if (n.includes('rx 6')) return 'amd_rx_6000'
  if (n.includes('rx 5')) return 'amd_rx_5000'
  if (n.includes('arc')) return 'intel_arc'
  return 'unknown'
}

// ─── Alias Resolution ───

/**
 * Attempt to resolve a hardware name against a DB entries list.
 * Returns the matched entry or null.
 *
 * Strategy:
 * 1. Exact normalized name match
 * 2. Alias match
 * 3. Family-based nearest match
 */
export function resolveHardwareEntry(normalizedName, entries, type = 'cpu') {
  if (!normalizedName || !entries?.length) return null

  const nameLower = normalizedName.toLowerCase().trim()

  // 1. Exact match
  const exact = entries.find(e => e.name.toLowerCase() === nameLower)
  if (exact) return exact

  // 2. Alias match
  const aliased = entries.find(e =>
    e.aliases?.some(a => a.toLowerCase() === nameLower)
  )
  if (aliased) return aliased

  // 3. Partial / contains match (best effort)
  const partial = entries.find(e =>
    nameLower.includes(e.name.toLowerCase()) ||
    e.name.toLowerCase().includes(nameLower)
  )
  if (partial) return partial

  // 4. Family fallback — find closest in same family
  const family = type === 'gpu' ? detectGpuFamily(normalizedName) : detectCpuFamily(normalizedName)
  if (family !== 'unknown') {
    const familyDetector = type === 'gpu' ? detectGpuFamily : detectCpuFamily
    const familyEntries = entries.filter(e => familyDetector(e.name) === family)
    if (familyEntries.length > 0) {
      // Return the median-scored entry in the family as a reasonable estimate
      familyEntries.sort((a, b) => a.gamingScore - b.gamingScore)
      return { ...familyEntries[Math.floor(familyEntries.length / 2)], _familyMatch: true }
    }
  }

  return null
}
