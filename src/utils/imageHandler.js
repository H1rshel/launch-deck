/**
 * Extracts and maps game images with appropriate fallbacks.
 * 
 * Rules:
 * - cover: primary is cover_url, fallback to hero_url
 * - hero: primary is hero_url, fallback to cover_url
 * - logo: primary is logo_url, no fallback
 * 
 * @param {object} game - The game object from the database
 * @returns {object} { cover: string, hero: string, logo: string | null }
 */
export function getGameImages(game) {
  if (!game) {
    return { cover: "", hero: "", logo: null }
  }

  const cover = game.cover_url || game.hero_url || ""
  const hero = game.hero_url || game.cover_url || ""
  const logo = game.logo_url || null

  return { cover, hero, logo }
}
