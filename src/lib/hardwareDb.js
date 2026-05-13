/**
 * Hardware reference database service.
 * Loads the bundled hardware DB and supports future online updates.
 * Always returns valid data — falls back to bundled DB if update fails.
 */

import bundledDb from '../data/hardware_db.json'

const CACHE_KEY = 'launchdeck_hardware_db'

let activeDb = null

/**
 * Get the current hardware database.
 * Priority: cached updated DB > bundled DB
 */
export function getHardwareDb() {
  if (activeDb) return activeDb

  // Try to load a newer cached version from localStorage
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (parsed.version && parsed.cpus && parsed.gpus) {
        // Only use if newer than bundled
        if (parsed.version >= bundledDb.version) {
          activeDb = parsed
          return activeDb
        }
      }
    }
  } catch (_) {
    // Corrupt cache — ignore
  }

  activeDb = bundledDb
  return activeDb
}

/**
 * Get the DB version string.
 */
export function getHardwareDbVersion() {
  return getHardwareDb().version
}

/**
 * Lookup a CPU in the database.
 */
export function lookupCpu(normalizedName) {
  const db = getHardwareDb()
  return findEntry(normalizedName, db.cpus)
}

/**
 * Lookup a GPU in the database.
 */
export function lookupGpu(normalizedName) {
  const db = getHardwareDb()
  return findEntry(normalizedName, db.gpus)
}

/**
 * Get RAM score and label by total GB.
 */
export function getRamGrade(totalGb) {
  const db = getHardwareDb()
  const rules = db.ramRules

  // Find the closest matching tier (round down)
  const thresholds = Object.keys(rules)
    .map(Number)
    .sort((a, b) => a - b)

  let matched = thresholds[0]
  for (const t of thresholds) {
    if (totalGb >= t) matched = t
  }

  return rules[String(matched)] || { score: 20, label: 'unknown' }
}

/**
 * Get storage score and label by type string.
 */
export function getStorageGrade(storageType) {
  const db = getHardwareDb()
  const rules = db.storageRules
  return rules[storageType] || rules['hdd'] || { score: 30, label: 'unknown' }
}

/**
 * Find an entry by name or alias (case-insensitive).
 */
function findEntry(name, entries) {
  if (!name || !entries?.length) return null
  const lower = name.toLowerCase().trim()

  // Exact name match
  const exact = entries.find((e) => e.name.toLowerCase() === lower)
  if (exact) return exact

  // Alias match
  const aliased = entries.find((e) =>
    e.aliases?.some((a) => a.toLowerCase() === lower),
  )
  if (aliased) return aliased

  // Partial match (name contains or is contained)
  const partial = entries.find(
    (e) =>
      lower.includes(e.name.toLowerCase()) ||
      e.name.toLowerCase().includes(lower),
  )
  if (partial) return partial

  return null
}

/**
 * Cache an updated hardware DB for future use.
 * Called when an online update is downloaded.
 */
export function cacheHardwareDb(newDb) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(newDb))
    activeDb = newDb
  } catch (_) {
    // Storage full — ignore
  }
}

/**
 * Clear cached DB and revert to bundled.
 */
export function clearHardwareDbCache() {
  localStorage.removeItem(CACHE_KEY)
  activeDb = bundledDb
}
