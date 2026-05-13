/**
 * useMyRig hook.
 * Manages hardware detection, scoring, and caching.
 * Provides the full rig snapshot + scores to any consumer.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { detectHardware } from '../lib/detectHardware'
import { scoreRig } from '../lib/scoreRig'

const CACHE_KEY = 'launchdeck_rig_snapshot'
const SCORE_CACHE_KEY = 'launchdeck_rig_score'

function loadCached(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveCached(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // Storage full
  }
}

/**
 * Hook that provides hardware snapshot and rig score.
 *
 * On first mount:
 * 1. Loads cached snapshot + score (instant)
 * 2. Runs hardware detection in background
 * 3. Scores the detected hardware
 * 4. Caches everything
 *
 * Returns { snapshot, score, loading, scanning, error, rescan }
 */
export function useMyRig() {
  const [snapshot, setSnapshot] = useState(() => loadCached(CACHE_KEY))
  const [score, setScore] = useState(() => loadCached(SCORE_CACHE_KEY))
  const [loading, setLoading] = useState(!loadCached(CACHE_KEY))
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState(null)
  const mountedRef = useRef(true)

  const runDetection = useCallback(async (isRescan = false) => {
    if (isRescan) setScanning(true)
    else setLoading(true)
    setError(null)

    try {
      const hw = await detectHardware()
      if (!mountedRef.current) return

      if (!hw) {
        setError('Could not detect hardware')
        return
      }

      setSnapshot(hw)
      saveCached(CACHE_KEY, hw)

      const scored = scoreRig(hw)
      setScore(scored)
      saveCached(SCORE_CACHE_KEY, scored)
    } catch (err) {
      if (mountedRef.current) {
        setError(err.message || 'Hardware detection failed')
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
        setScanning(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    // Always run detection on mount (updates the cache)
    runDetection(false)
    return () => {
      mountedRef.current = false
    }
  }, [runDetection])

  const rescan = useCallback(() => runDetection(true), [runDetection])

  return {
    snapshot,
    score,
    loading,
    scanning,
    error,
    rescan,
  }
}
