import { useState, useEffect, useMemo } from 'react'
import { analyzeGamePerformance } from '../../lib/analyzeGamePerformance'
import { getHltbData } from '../../lib/hltb'

// Session-level HLTB cache so browsing back and forth is instant. getHltbData
// itself also checks the SQLite cache, so first-visit cost is one lookup.
const hltbMemo = new Map()

// Read the rig score straight from My Rig's localStorage cache — useMyRig
// re-runs full hardware detection on every mount, which we must not trigger
// each time the Home screen remounts. No cache yet → no perf verdict shown.
function loadCachedRigScore() {
  try {
    const raw = localStorage.getItem('launchdeck_rig_score')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * Lightweight game insights for the console hero: rig performance verdict
 * (pure computation over the cached rig score) and HowLongToBeat times
 * (debounced so tile browsing doesn't fire lookups).
 */
export function useGameInsights(game) {
  const [score] = useState(loadCachedRigScore)

  const perf = useMemo(() => {
    if (!score || !game) return null
    const analysis = analyzeGamePerformance(score, game)
    return analysis?.available ? analysis : null
  }, [score, game?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [hltb, setHltb] = useState(null)

  useEffect(() => {
    if (!game) {
      setHltb(null)
      return undefined
    }
    if (hltbMemo.has(game.id)) {
      setHltb(hltbMemo.get(game.id))
      return undefined
    }
    setHltb(null)
    let cancelled = false
    const timer = setTimeout(async () => {
      const data = await getHltbData(game.id, game.displayTitle, game.title)
      // Memoize even if the user browsed away mid-fetch — otherwise a slow
      // HLTB lookup gets discarded every time and the data never appears.
      hltbMemo.set(game.id, data)
      if (!cancelled) setHltb(data)
    }, 450)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [game?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    perf,
    hltb: hltb?.available ? hltb : null,
  }
}
