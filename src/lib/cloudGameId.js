/**
 * Generate a consistent game ID for cloud sync.
 * Priority: steam -> gog -> epic -> ubisoft -> local id (fallback)
 *
 * Lives in its own module: it's shared by cloudSync, metadataSync, devices
 * and the streaming layer, and importing it through cloudSync created a
 * circular dependency (cloudSync ↔ metadataSync) that crashed the minified
 * bundle at startup ("Cannot access 'X' before initialization").
 */
export function getCloudGameId(game) {
  if (game.steam_app_id) return `steam_${game.steam_app_id}`
  if (game.gog_id) return `gog_${game.gog_id}`
  if (game.epic_id) return `epic_${game.epic_id}`
  if (game.ubisoft_id) return `ubisoft_${game.ubisoft_id}`

  // Fallback to local DB ID
  if (game.id) return game.id

  // Last resort
  return (game.normalized_title || game.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
}
