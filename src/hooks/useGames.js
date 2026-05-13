import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useGameContext } from '../context/GameContext'
import { readSetting } from './useSettings'

const SORT_FNS = {
  name: (a, b) => (a.displayTitle || a.title).localeCompare(b.displayTitle || b.title),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0),
  recent: (a, b) => new Date(b.lastPlayed || 0) - new Date(a.lastPlayed || 0),
  release: (a, b) => (b.release_date || '').localeCompare(a.release_date || ''),
}

export function useGames() {
  const { games: allGames, loading } = useGameContext()
  const [searchParams, setSearchParams] = useSearchParams()

  const filter = searchParams.get('filter') || 'all'
  const setFilter = (val) => {
    setSearchParams(prev => { 
      if (val === 'all') prev.delete('filter')
      else prev.set('filter', val)
      return prev 
    }, { replace: true })
  }

  const defaultSort = useMemo(() => {
    const stored = readSetting('defaultSort')
    return stored && SORT_FNS[stored] ? stored : 'name'
  }, [])
  const sortBy = searchParams.get('sort') || defaultSort
  const setSortBy = (val) => {
    setSearchParams(prev => { 
      if (val === defaultSort) prev.delete('sort')
      else prev.set('sort', val)
      return prev 
    }, { replace: true })
  }

  const searchQuery = searchParams.get('q') || ''
  const setSearchQuery = (val) => {
    setSearchParams(prev => { 
      if (val) prev.set('q', val)
      else prev.delete('q')
      return prev 
    }, { replace: true })
  }

  const games = useMemo(() => {
    let filtered = [...allGames]

    if (searchQuery) {
      const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
      filtered = filtered.filter(g => {
        const haystack = [
          g.displayTitle || g.title || '',
          g.platform || '',
          ...(g.franchiseNames || []),
          ...(g.collectionNames || []),
        ].join(' ').toLowerCase()
        return words.every(w => haystack.includes(w))
      })
    }

    if (filter === 'installed') {
      filtered = filtered.filter((g) => g.installed)
    } else if (filter === 'not_installed') {
      filtered = filtered.filter((g) => !g.installed)
    } else if (filter === 'favorites') {
      filtered = filtered.filter((g) => g.favorite)
    } else if (filter === 'collections') {
      // No status filter — FranchiseGroupedView in Library handles grouping
    } else if (filter !== 'all') {
      filtered = filtered.filter((g) => g.platform === filter)
    }

    const sortFn = SORT_FNS[sortBy] || SORT_FNS.name
    filtered.sort(sortFn)

    return filtered
  }, [allGames, filter, sortBy, searchQuery])

  const gameCounts = useMemo(() => ({
    all: allGames.length,
    installed: allGames.filter((g) => g.installed).length,
    not_installed: allGames.filter((g) => !g.installed).length,
    favorites: allGames.filter((g) => g.favorite).length,
    collections: allGames.filter((g) => g.collectionNames?.length > 0 || g.franchiseNames?.length > 0).length,
  }), [allGames])

  const featuredGame = allGames[0] || null

  return { games, gameCounts, featuredGame, filter, setFilter, sortBy, setSortBy, searchQuery, setSearchQuery, loading }
}
