import { useState, useEffect } from 'react'
import { useAuth } from './useAuth'
import { supabase } from '../lib/supabase'

/**
 * Loads the user's taste profile from the backend database (generated via headless sync).
 * Exposes it in the runtime Map-based shape expected by `upcomingScoring.js`.
 */
export function useLibraryProfile() {
  const { user }  = useAuth()
  const [profile, setProfile] = useState(null)

  useEffect(() => {
    if (!user) {
      setProfile(null)
      return
    }

    let cancelled = false

    async function load() {
      const { data, error } = await supabase
        .from('user_game_taste_profile')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle()

      if (cancelled) return

      if (error || !data) {
        setProfile({ hasData: false })
        return
      }

      // Rehydrate JSON entries into fast JS Maps for scoring sweeps
      const hydrateMap = (arr) => new Map((arr || []).map(x => [x.key, x.weight]))

      setProfile({
        genreWeights: hydrateMap(data.top_genres),
        seriesWeights: hydrateMap(data.top_series),
        devWeights: hydrateMap(data.top_developers),
        publisherWeights: hydrateMap(data.top_publishers),
        tagWeights: hydrateMap(data.preferred_tags),
        themeWeights: new Map(), // no top_themes column in DB; scoring falls back to zero
        categoryAffinity: data.category_affinities || {},
        indieAffinity: Number(data.indie_affinity || 0),
        aaaAffinity: Number(data.aaa_affinity || 0),
        totalPlaytimeMinutes: data.total_playtime_minutes || 0,
        sampleSize: data.sample_size || 0,
        hasData: true
      })
    }
    
    load()

    return () => { cancelled = true }
  }, [user])

  return profile
}
