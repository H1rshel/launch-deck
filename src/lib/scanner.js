import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { addGame, getFolders, getAllGames, restoreUserRemovedGame } from './db'
import { classifyExeHeuristic, normalizeExeName } from './executableNorm'

const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

// Open native folder picker, returns path string or null
export async function pickFolder() {
  if (!isTauri) return null
  try {
    const selected = await open({ directory: true, multiple: false, title: 'Select Game Folder' })
    if (!selected) return null
    return typeof selected === 'string' ? selected : String(selected)
  } catch (err) {
    console.error('Folder picker error:', err)
    throw err
  }
}

// Score an exe candidate — higher = more likely the main game exe.
// Blends name-matching heuristics with the classification signal from executableNorm.
function scoreCandidate(c) {
  const stem = c.raw_file_name.toLowerCase()
  const folder = c.raw_folder_name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const stemClean = stem.replace(/[^a-z0-9]/g, '')
  let score = 0

  // Stem matches or is contained in folder name (or vice versa)
  if (folder && (stemClean.includes(folder) || folder.includes(stemClean))) score += 10

  // Penalize suffixes that indicate non-main exes
  if (/_trial|_demo|_test|_benchmark|_showcase|_shipping/i.test(stem)) score -= 20

  // Penalize "service", "helper", "tool" in stem
  if (/service|helper|tool|report|diag/i.test(stem)) score -= 15

  // Apply heuristic classification signal
  const normExe = normalizeExeName(stem)
  const heuristic = classifyExeHeuristic(normExe)
  if (heuristic === 'game')      score += 8
  if (heuristic === 'launcher')  score -= 18
  if (heuristic === 'tool')      score -= 15
  if (heuristic === 'installer') score -= 25

  // Shorter/simpler names tend to be the main exe
  score -= stem.length * 0.1

  return score
}

/**
 * Locally pre-filter candidates using heuristics before any Supabase call.
 * Suppresss obvious non-games (launchers, installers, tools) when confidence is low.
 * Catalog enrichment (Supabase) runs later in useScanner after this returns.
 *
 * @param {import('./executableTypes.js').ScanCandidate[]} candidates
 * @returns {import('./executableTypes.js').ScanCandidate[]}
 */
export function preFilterCandidates(candidates) {
  return candidates.map(c => {
    const normExe = normalizeExeName(c.raw_file_name || '')
    const heuristic = classifyExeHeuristic(normExe)

    // Annotate with local classification for the UI / catalog enrichment step
    const catalogClassification = c.catalogClassification ?? (heuristic !== 'unknown' ? heuristic : null)

    // Suppress confident non-games — they'll have very low confidence after catalog enrichment anyway,
    // but doing it here prevents them appearing briefly during the live scan stream
    let confidence = c.confidence ?? 0
    if (heuristic === 'installer') confidence = Math.min(confidence, 0.1)
    if (heuristic === 'launcher')  confidence = Math.min(confidence, 0.2)
    if (heuristic === 'tool')      confidence = Math.min(confidence, 0.25)

    return { ...c, confidence, catalogClassification }
  })
}

// Deduplicate candidates that map to the same game title — pick the best exe
function deduplicateCandidates(candidates) {
  const groups = new Map()
  for (const c of candidates) {
    const key = c.title.toLowerCase()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }

  const result = []
  for (const [, group] of groups) {
    if (group.length === 1) {
      result.push(group[0])
    } else {
      // Pick the candidate with the highest score
      group.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
      result.push(group[0])
    }
  }
  return result
}

export async function scanForCandidates(onProgress, onGameFound) {
  if (!isTauri) return []

  const folders = await getFolders()
  const folderPaths = folders.map((f) => f.path)
  if (folderPaths.length === 0) return []
  
  // Pre-fetch all paths to filter the live stream
  const allGames = await getAllGames()
  const existingPaths = new Set(allGames.map(g => (g.install_path || '').toLowerCase()))

  let unlistenProgress = null
  let unlistenFound = null

  // Throttle progress updates to max 10fps to keep the UI smooth
  let lastProgressTime = 0
  if (onProgress) {
    unlistenProgress = await listen('scan-progress', (event) => {
      const now = Date.now()
      if (now - lastProgressTime > 100) {
        lastProgressTime = now
        onProgress(event.payload)
      }
    })
  }

  // Stream games to the UI without blocking on DB checks
  if (onGameFound) {
    unlistenFound = await listen('game-found', (event) => {
      const game = event.payload
      // Skip emitting if it's already in our DB!
      if (game.executable && existingPaths.has(game.executable.toLowerCase())) return
      
      onGameFound({
        title: game.name,
        install_path: game.executable,
        raw_file_name: game.executable.split('\\').pop() || '',
        raw_folder_name: game.executable.split('\\').slice(-2, -1)[0] || '',
        platform: game.source === 'steam' ? 'Steam' : 'PC',
        confidence: game.confidence,
        source: game.source,
        metadata: game.metadata,
        gameData: game.gameData
      })
    })
  }

  // Rust backend runs the 2-pass algorithm and streams results
  const scannedGames = await invoke('advanced_scan', { folders: folderPaths })

  if (unlistenProgress) unlistenProgress()
  if (unlistenFound) unlistenFound()

  // Build deduplicated final list (filter already-imported games quickly using the Set)
  const candidates = []
  for (const game of scannedGames) {
    if (game.executable && existingPaths.has(game.executable.toLowerCase())) continue

    candidates.push({
      title: game.name,
      install_path: game.executable,
      raw_file_name: game.executable.split('\\').pop() || '',
      raw_folder_name: game.executable.split('\\').slice(-2, -1)[0] || '',
      platform: game.source === 'steam' ? 'Steam' : 'PC',
      confidence: game.confidence,
      source: game.source,
      metadata: game.metadata,
      gameData: game.gameData
    })
  }
  
  // Apply local heuristic pre-filter (catalog enrichment happens in useScanner)
  const filtered = preFilterCandidates(candidates)

  // Fire the final progress update using the filtered length
  if (onProgress) {
    onProgress({ current: filtered.length, total: filtered.length, status: 'Complete' })
  }

  return filtered
}

/**
 * Import selected candidates into the database.
 */
export async function importGames(games) {
  let added = 0
  for (const game of games) {
    try {
      await addGame(game)
      added++
    } catch (err) {
      if (err.code === 'USER_REMOVED' && err.existingId) {
        try {
          // The user explicitly checked the box in the bulk modal to import this game,
          // so automatically restore the user_removed row.
          await restoreUserRemovedGame(err.existingId, {
            install_path: game.install_path || '',
            raw_file_name: game.raw_file_name || '',
            raw_folder_name: game.raw_folder_name || ''
          })
          added++
        } catch (restoreErr) {
          console.error('Failed to restore removed game:', game.title, restoreErr)
        }
      } else {
        console.error('Failed to import game:', game.title, err)
      }
    }
  }
  return added
}
