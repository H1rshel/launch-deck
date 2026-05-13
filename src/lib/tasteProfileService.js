import { supabase } from './supabase'
import { getAllGames, backfillGameMetadata } from './db'
import { buildLibraryProfile, profileToDbShape } from './upcomingScoring'

const ALLOWED_COLUMNS = new Set([
  'user_id',
  'top_genres',
  'top_franchises',
  'top_developers',
  'top_publishers',
  'top_series',
  'preferred_tags',
  'category_affinities',
  'indie_affinity',
  'aaa_affinity',
  'sports_affinity',
  'rpg_affinity',
  'action_affinity',
  'strategy_affinity',
  'sim_affinity',
  'horror_affinity',
  'sample_size',
  'last_computed_at',
  'updated_at',
])

function sanitizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => ALLOWED_COLUMNS.has(key))
  )
}

class TasteProfileService {
  constructor() {
    this.lastSignature = null
    this.inProgress = false
  }

  /**
   * Reads all known local games, forms a profile, and pushes it up to the 
   * `user_game_taste_profile` table for headless personalization ranking.
   */
  async buildAndUpsertTasteProfile(userId) {
    if (!userId) return { skipped: true, reason: 'no session' }
    if (this.inProgress) return { skipped: true, reason: 'already running' }
    
    this.inProgress = true
    try {
      // Backfill developers/publishers/themes from cached IGDB data
      // for games enriched before those columns existed
      await backfillGameMetadata().catch(() => {})

      const allLocalGames = await getAllGames()

      const profile = buildLibraryProfile(allLocalGames)
      
      if (!profile.hasData) {
        return { skipped: true, reason: 'no meaningful data yet' }
      }

      const signature = `${profile.sampleSize}:${profile.totalPlaytimeMinutes}`
        + `:${profile.indieAffinity.toFixed(2)}:${profile.aaaAffinity.toFixed(2)}`
        + `:${profile.genreWeights.size}:${profile.seriesWeights.size}`
      
      if (signature === this.lastSignature) {
        return { skipped: true, reason: 'unchanged signature' }
      }

      const rawRow = {
        user_id: userId,
        ...profileToDbShape(profile),
        updated_at: new Date().toISOString(),
      }

      const row = sanitizeRow(rawRow)

      console.log('[TasteProfile] Payload keys:', Object.keys(row))

      const { error } = await supabase
        .from('user_game_taste_profile')
        .upsert(row, { onConflict: 'user_id' })

      if (error) {
        console.warn('[TasteProfileService] Upsert failed:', error.message)
        return { success: false, error }
      }

      // Only stamp signature after successful cloud persist
      this.lastSignature = signature

      console.debug('[TasteProfileService] Profile exported successfully.')
      return { success: true }
    } catch (err) {
      console.warn('[TasteProfileService] FATAL error:', err)
      return { success: false, error: err }
    } finally {
      this.inProgress = false
    }
  }
}

export const tasteProfileService = new TasteProfileService()
