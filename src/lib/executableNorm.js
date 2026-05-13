/**
 * @fileoverview
 * Pure, deterministic normalization utilities for the EXE learning system.
 * All functions are side-effect-free and shared across auto scan, folder scan,
 * single EXE scan, and cloud sync backfill flows.
 *
 * @module executableNorm
 */

// ─── Build / platform suffixes to strip from EXE names ───────────────────────

const EXE_SUFFIX_PATTERN =
  /_win64|_win32|_x64|_x86|_dx12|_dx11|_vulkan|_gl|_shipping|_final|_release|_debug|_development|_retail|_build|_gold|_gold_ship|_eac_eac|_be_be|_anticheatsandbox/gi

// EXE stems that are almost certainly NOT a game's main executable.
// Used by classifyExeHeuristic to detect launchers / tools / installers.
const JUNK_STEMS = new Set([
  // Launchers & updaters
  'launcher', 'gamelauncher', 'gamelauncheri', 'start', 'starter',
  'update', 'updater', 'autoupdate', 'patcher', 'bootstrapper',
  'setup', 'install', 'installer', 'uninstall', 'uninst',
  // Services & helpers
  'service', 'helper', 'host', 'agent', 'broker', 'daemon',
  'crashreporter', 'bugsplat', 'sentry', 'reporter',
  'diagnostics', 'diag', 'errorreporter',
  // Engines / runtimes exposed as stubs
  'ue4prereqsetup', 'ue5prereqsetup', 'vcredist', 'dxsetup', 'directx',
  'redist', 'prerequisites',
  // Common tool names
  'modmanager', 'modtool', 'editor', 'devtools',
  // EA / Epic / Ubisoft launchers
  'eaappinstaller', 'eadesktop', 'epicgameslauncher',
  'ubisoftconnect', 'ubisoftgamelauncher',
])

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Normalize an EXE filename to a compact, comparable slug.
 * Deterministic — same input always produces the same output.
 *
 * Steps:
 *  1. Lowercase
 *  2. Strip ".exe" extension
 *  3. Strip known build/platform suffixes (_win64, _x64, _shipping, …)
 *  4. Remove all separators and punctuation
 *
 * @param {string} exeName  Raw filename (with or without ".exe")
 * @returns {string}        Normalized slug, e.g. "eldenring"
 */
export function normalizeExeName(exeName) {
  if (!exeName) return ''
  let n = exeName.trim().toLowerCase()
  n = n.replace(/\.exe$/i, '')
  n = n.replace(EXE_SUFFIX_PATTERN, '')
  n = n.replace(/[_\-\.\s]+/g, '')
  return n
}

/**
 * Normalize a game title to a dash-separated slug for consistent matching.
 *
 * @param {string} title
 * @returns {string}  e.g. "elden-ring"
 */
export function normalizeGameTitle(title) {
  if (!title) return ''
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Normalize a filesystem path: forward slashes, lowercase, trailing slash removed.
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  if (!path) return ''
  return path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

/**
 * Extract the folder portion from a normalized path.
 *
 * @param {string} normalizedPath  Output of normalizePath()
 * @returns {string}
 */
export function folderFromPath(normalizedPath) {
  const idx = normalizedPath.lastIndexOf('/')
  return idx === -1 ? '' : normalizedPath.slice(0, idx)
}

/**
 * Map a human-readable UI reason label to the DB enum value.
 *
 * @param {string} label  Label shown in the modal, e.g. "Not a game"
 * @returns {import('./executableTypes.js').FeedbackReason}
 */
export function classifyDeletionReason(label) {
  /** @type {Record<string, import('./executableTypes.js').FeedbackReason>} */
  const MAP = {
    'Not a game':            'not_a_game',
    'Duplicate game':        'duplicate',
    'Launcher only':         'launcher_only',
    'Installer / setup file':'installer',
    'Modding tool / utility':'mod_tool',
    'Wrong match':           'wrong_match',
    'Old version':           'old_version',
    'Other':                 'other',
  }
  return MAP[label] ?? 'other'
}

/**
 * Human-readable labels for the feedback modal — in display order.
 *
 * @type {string[]}
 */
export const FEEDBACK_REASON_LABELS = [
  'Not a game',
  'Duplicate game',
  'Launcher only',
  'Installer / setup file',
  'Modding tool / utility',
  'Wrong match',
  'Old version',
  'Other',
]

/**
 * Quick heuristic: classify an EXE based purely on its normalized name,
 * without querying Supabase. Used as a local pre-filter.
 *
 * @param {string} normalizedName  Output of normalizeExeName()
 * @returns {import('./executableTypes.js').ExeClassification}
 */
export function classifyExeHeuristic(normalizedName) {
  if (!normalizedName) return 'unknown'
  if (JUNK_STEMS.has(normalizedName)) return 'tool'
  if (/^(setup|install|uninst)/.test(normalizedName)) return 'installer'
  if (/(launcher|update|patcher|bootstrap)$/.test(normalizedName)) return 'launcher'
  return 'unknown'
}

/**
 * Compute a [0, 1] confidence score for an EXE candidate, blending multiple
 * signals together without overfitting to any single source.
 *
 * @param {import('./executableTypes.js').ConfidenceInput} input
 * @returns {number}  Clamped to [0, 1]
 */
export function computeExecutableConfidence({
  rustConfidence = 0,
  catalogClassification = null,
  catalogConfidence = null,
  userConfirmedBefore = false,
  userRejectedBefore = false,
  timesSeen = 0,
}) {
  // Immediate hard overrides
  if (userRejectedBefore) return 0

  let score = rustConfidence

  // ── Catalog signals ───────────────────────────────────────────────────────
  if (catalogClassification === 'game') {
    // Catalog says "game" → floor at catalogConfidence and add a boost
    const catalogFloor = catalogConfidence ?? 0.75
    score = Math.max(score, catalogFloor)
    score = Math.min(1, score + 0.1)
  } else if (
    catalogClassification === 'launcher' ||
    catalogClassification === 'tool' ||
    catalogClassification === 'installer'
  ) {
    // Known non-game → suppress hard
    score = Math.min(score, 0.25)
  }
  // 'unknown' and null: trust Rust score as-is

  // ── User-history signals ──────────────────────────────────────────────────
  if (userConfirmedBefore) score = Math.min(1, score + 0.2)

  // Seen multiple times is a weak positive signal
  if (timesSeen >= 3) score = Math.min(1, score + 0.05)

  return Math.max(0, Math.min(1, score))
}
