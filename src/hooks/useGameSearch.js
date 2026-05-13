import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

const DEBOUNCE_MS = 350
const MIN_QUERY_LEN = 2

export function useGameSearch(query) {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => {
    // Clear any pending debounce
    clearTimeout(timerRef.current)

    const trimmed = (query ?? '').trim()
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults([])
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)

    timerRef.current = setTimeout(async () => {
      // Cancel any in-flight request
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const { data, error: fnErr } = await supabase.functions.invoke('search-igdb-games', {
          body: { query: trimmed, limit: 10 },
        })
        if (controller.signal.aborted) return
        if (fnErr) throw fnErr
        setResults(data?.results ?? [])
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e?.message ?? 'Search failed')
          setResults([])
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timerRef.current)
      abortRef.current?.abort()
    }
  }, [query])

  return { results, loading, error }
}
