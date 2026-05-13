// Folders that indicate the exe is nested inside a build/bin directory
// — when encountered as the immediate parent, look one level up for the real game name
const GENERIC_FOLDERS = new Set([
  'bin', 'binaries', 'x64', 'x86', 'win64', 'win32',
  'game', 'build', 'release', 'debug', 'shipping',
  'win_ship', 'retail', 'dist', 'output',
])

/**
 * Clean a raw name into a human-readable game title.
 *
 * Rules:
 *  1. Strip ".exe" extension
 *  2. Replace _ - . separators with spaces
 *  3. Insert space between letter→digit and digit→letter transitions
 *  4. Collapse whitespace, trim
 *  5. Title-case each word (preserving all-caps short words like "II", "III")
 */
export function cleanGameName(raw) {
  let name = raw.replace(/\.exe$/i, '')

  // Replace common separators with spaces
  name = name.replace(/[_\-\.]+/g, ' ')

  // Insert space between letter runs (2+) and digit runs
  // "Cyberpunk2077" → "Cyberpunk 2077"  |  "re9" → "re 9"
  // But NOT single letters between digits: "2K25" stays "2K25"
  name = name.replace(/([a-zA-Z]{2,})(\d)/g, '$1 $2')
  name = name.replace(/(\d)([a-zA-Z]{2,})/g, '$1 $2')

  // Collapse whitespace
  name = name.replace(/\s+/g, ' ').trim()

  if (!name) return 'Unknown Game'

  // Title-case — but preserve short all-caps tokens (II, III, IV, DLC, HD, VR)
  name = name
    .split(' ')
    .map((word) => {
      if (word.length <= 3 && word === word.toUpperCase()) return word
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')

  return name
}

/**
 * Given a full exe path, determine the best game title using folder context.
 *
 * Priority:
 *  1. Parent folder name  (most common: "C:/Games/Elden Ring/eldenring.exe")
 *  2. Grandparent folder  (if parent is generic like "bin", "x64")
 *  3. File name stem      (last resort)
 *
 * Also returns raw metadata for future enrichment.
 */
export function extractGameInfo(exePath) {
  const normalized = exePath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)

  const fileName = parts[parts.length - 1] || ''
  const fileStem = fileName.replace(/\.exe$/i, '')
  const parentFolder = parts.length >= 2 ? parts[parts.length - 2] : ''
  const grandparentFolder = parts.length >= 3 ? parts[parts.length - 3] : ''

  // Determine best source for the game name
  let bestName = fileStem

  if (parentFolder) {
    const parentLower = parentFolder.toLowerCase()
    if (GENERIC_FOLDERS.has(parentLower)) {
      // Parent is a generic build folder — try grandparent
      if (grandparentFolder) {
        bestName = grandparentFolder
      }
    } else {
      bestName = parentFolder
    }
  }

  const title = cleanGameName(bestName)

  return {
    title,
    raw_file_name: fileStem,
    raw_folder_name: parentFolder,
    install_path: exePath,
  }
}
