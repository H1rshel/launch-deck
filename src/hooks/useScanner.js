import { useState, useEffect, useCallback, useRef } from 'react'
import { getFolders, addFolder, removeFolder, getUnenrichedGames, updateGameMetadata, addGame, restoreUserRemovedGame, setGameDetailsCache } from '../lib/db'
import { pickFolder, scanForCandidates, importGames } from '../lib/scanner'
import { enrichAllGames, fetchPreviewCover, fetchUnifiedGameData } from '../lib/rawg'
import { buildMetadataCacheKey, GAME_DETAIL_PROVIDERS, GAME_DETAIL_TTLS, getStaleAfterIso, normalizeMetadataPayload } from '../lib/gameDetailCache'
import { useGameContext } from '../context/GameContext'
import { useAuth } from '../context/AuthContext'
import {
  enrichCandidatesWithCatalog,
  lookupSingleExeInCatalog,
  confirmExecutableAsGame,
} from '../lib/executableCatalog'

export function useScanner() {
  const { refreshGames } = useGameContext()
  const { user } = useAuth()
  const [folders, setFolders] = useState([])
  const [scanning, setScanning] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [candidates, setCandidates] = useState(null) // null = no modal, [] = modal open
  const [coverMap, setCoverMap] = useState({}) // title → { cover_url, name }
  const [enrichProgress, setEnrichProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [enrichResult, setEnrichResult] = useState(null)
  const [error, setError] = useState(null)
  const [scanProgress, setScanProgress] = useState(null)
  const [gameCount, setGameCount] = useState(0) // live count of found games
  const coverAbort = useRef(false)
  const scanAbort = useRef(false)
  const gamesRef = useRef([]) // collect games without re-rendering

  // Single-game add flow
  const [pendingAddGame, setPendingAddGame] = useState(null) // { folderPath, exePath, detectedTitle }
  const [addingGame, setAddingGame] = useState(false)
  const [pendingRestore, setPendingRestore] = useState(null) // { existingId, gameName, install_path, raw_file_name, raw_folder_name }

  const loadFolders = useCallback(async () => {
    try {
      const rows = await getFolders()
      setFolders(rows)
    } catch (err) {
      console.error('Failed to load folders:', err)
    }
  }, [])

  useEffect(() => {
    loadFolders()
  }, [loadFolders])

  const handleAddFolder = useCallback(async () => {
    setError(null)
    try {
      const path = await pickFolder()
      if (!path) return
      await addFolder(path)
      await loadFolders()
    } catch (err) {
      console.error('Add folder error:', err)
      setError(err.message || String(err))
    }
  }, [loadFolders])

  const handleRemoveFolder = useCallback(
    async (id) => {
      try {
        await removeFolder(id)
        await loadFolders()
      } catch (err) {
        setError(err.message || String(err))
      }
    },
    [loadFolders]
  )

  // Step 1: Scan and show candidates in modal
  const handleScan = useCallback(async () => {
    setScanning(true)
    setResult(null)
    setEnrichResult(null)
    setError(null)
    setCoverMap({})
    setGameCount(0)
    setScanProgress({ current: 0, total: 100, status: 'Preparing...' })
    scanAbort.current = false
    coverAbort.current = false
    gamesRef.current = []

    // Open the modal immediately (empty candidates = progress-only phase)
    setCandidates([])

    try {
      const found = await scanForCandidates(
        // Progress callback — only updates a simple number, no list re-render
        (progress) => {
          if (!scanAbort.current) {
            setScanProgress(progress)
          }
        },
        // Game-found callback — collect in ref, only update count
        (newGame) => {
          if (scanAbort.current) return
          const key = newGame.title.toLowerCase().replace(/[^a-z0-9]/g, "")
          const existingIdx = gamesRef.current.findIndex(
            g => g.title.toLowerCase().replace(/[^a-z0-9]/g, "") === key
          )
          if (existingIdx !== -1) {
            if (newGame.confidence > gamesRef.current[existingIdx].confidence ||
                (newGame.source === 'steam' && gamesRef.current[existingIdx].source !== 'steam')) {
              gamesRef.current[existingIdx] = newGame
            }
          } else {
            gamesRef.current.push(newGame)
            // Only update the count (lightweight — just a number)
            setGameCount(gamesRef.current.length)
          }
        }
      )

      if (scanAbort.current) {
        setScanning(false)
        return
      }

      // Scan complete: batch-set all games at once (single re-render)
      let finalList = found.length > 0 ? found : gamesRef.current

      // Enrich with global catalog + user history (fire-and-forget upsert inside)
      try {
        finalList = await enrichCandidatesWithCatalog(finalList, user?.id ?? null, 'folder_scan')
      } catch (catalogErr) {
        console.warn('Catalog enrichment failed (non-fatal):', catalogErr)
      }

      if (finalList.length === 0) {
        setResult({ added: 0, scanned: 0, skipped: 0 })
        setCandidates(null)
      } else {
        setCandidates(finalList)
        // Kick off background cover fetches for all games
        coverAbort.current = false
        for (const game of finalList) {
          if (coverAbort.current) break
          const key = game.title.toLowerCase()
          fetchPreviewCover(game.title).then((cover) => {
            if (cover && !coverAbort.current) {
              setCoverMap((p) => ({ ...p, [key]: cover }))
            }
          }).catch(() => {})
        }
      }
    } catch (err) {
      console.error('Scan error:', err)
      setError(err.message || String(err))
    } finally {
      setScanning(false)
    }
  }, [])

  // Step 2: User confirms selection from modal
  const handleConfirmImport = useCallback(async (selected) => {
    coverAbort.current = true
    setCandidates(null)
    setCoverMap({})
    setError(null)

    const added = await importGames(selected)
    setResult({ added, scanned: selected.length, skipped: 0 })
    if (added > 0) await refreshGames()

    // Auto-enrich
    setEnriching(true)
    setEnrichProgress(null)
    try {
      const enrichRes = await enrichAllGames(
        getUnenrichedGames,
        updateGameMetadata,
        (p) => setEnrichProgress(p)
      )
      setEnrichResult(enrichRes)
      if (enrichRes.enriched > 0) await refreshGames()
    } catch (err) {
      console.error('Auto-enrich error:', err)
    } finally {
      setEnriching(false)
      setEnrichProgress(null)
    }
  }, [refreshGames])

  const handleCancelImport = useCallback(() => {
    scanAbort.current = true
    coverAbort.current = true
    setCandidates(null)
    setCoverMap({})
    setScanning(false)
  }, [])

  // ── Add Single Game ──────────────────────────────────────────────────────────

  // Step A: pick a folder, try to detect the exe, open the search modal
  const handleStartAddSingleGame = useCallback(async () => {
    setError(null)
    try {
      const folderPath = await pickFolder()
      if (!folderPath) return

      // Derive title from folder name as a fallback
      const folderName = folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || folderPath
      let detectedTitle = folderName

      // Find all plausible game exes in the chosen folder
      let exeOptions = []
      let resolvedExe = null
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const exes = await invoke('list_game_exes', { folder: folderPath })
        if (exes?.length > 0) {
          exeOptions = exes
          resolvedExe = exes[0]
          // Use exe filename as title hint only when the folder name has no spaces
          // (single-word folder names are often abbreviations like "LiesofP") AND
          // the exe name doesn't contain build/platform suffixes (Win64, Shipping, etc.)
          if (!folderName.includes(' ')) {
            const topName = exes[0].replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '') || ''
            if (topName && !/win64|win32|shipping|debug|development/i.test(topName)) {
              detectedTitle = topName
            }
          }
        }
      } catch (err) { console.warn('list_game_exes error:', err) }

      // Catalog lookup: prefill title from global catalog when confidence is high
      if (resolvedExe) {
        try {
          const catalogHint = await lookupSingleExeInCatalog(resolvedExe, user?.id ?? null)
          if (catalogHint.suggestedTitle && catalogHint.confidence >= 0.65) {
            detectedTitle = catalogHint.suggestedTitle
          }
        } catch (catalogErr) {
          console.warn('Single EXE catalog lookup failed (non-fatal):', catalogErr)
        }
      }

      setPendingAddGame({ folderPath, exePath: resolvedExe, exeOptions, detectedTitle })
    } catch (err) {
      setError(err.message || String(err))
    }
  }, [])

  // Step B: user picked a game from the search results — add it with full metadata
  // selectedExePath overrides the auto-detected exe (user may have picked a different one)
  const handleConfirmAddSingleGame = useCallback(async (selectedGame, selectedExePath) => {
    if (!pendingAddGame) return
    setAddingGame(true)
    setError(null)
    try {
      const { folderPath, exePath } = pendingAddGame
      const chosenExe = selectedExePath || exePath
      const folderName = folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''

      // 1. Insert the game stub
      let newGame
      try {
        newGame = await addGame({
          title: selectedGame.name,
          install_path: chosenExe,
          platform: 'PC',
          raw_file_name: chosenExe.replace(/\\/g, '/').split('/').pop() || '',
          raw_folder_name: folderName,
        })
      } catch (err) {
        if (err.code === 'USER_REMOVED') {
          // Game was previously removed — ask for user confirmation before restoring
          setPendingRestore({
            existingId: err.existingId,
            gameName: selectedGame.name,
            install_path: chosenExe,
            raw_file_name: chosenExe.replace(/\\/g, '/').split('/').pop() || '',
            raw_folder_name: folderName,
            selectedGame,
          })
          return // wait for user to confirm
        }
        throw err
      }

      // 2. Build metadata from the selected result (IGDB or RAWG)
      const meta = {
        normalized_title: selectedGame.name,
        rating: selectedGame.rating || 0,
        release_date: selectedGame.released || '',
        cover_url: selectedGame.background_image || '',
        metadata_fetched: 1,
      }
      if (selectedGame._igdb_genres?.length) meta.genres = selectedGame._igdb_genres.join(',')
      if (selectedGame._igdb_franchise) meta.franchise = selectedGame._igdb_franchise

      // 3. Fetch SteamGridDB assets (cover/hero/logo) — non-blocking on failure
      try {
        const unified = await fetchUnifiedGameData(selectedGame.name)
        if (unified) {
          if (unified.cover) meta.cover_url = unified.cover
          if (unified.hero) meta.hero_url = unified.hero
          if (unified.logo) meta.logo_url = unified.logo
        }
      } catch (_) { /* SteamGridDB is optional */ }

      await updateGameMetadata(newGame.id, meta)

      // 3b. Record confirmation in user_game_executables
      if (user?.id && chosenExe) {
        confirmExecutableAsGame(user.id, chosenExe, selectedGame.name).catch(() => {})
      }

      // 4. Populate game_details_cache with full IGDB metadata (dev/pub/summary)
      // so the game detail page shows it immediately without a re-fetch.
      if (selectedGame._igdb_involvedCompanies !== undefined) {
        const developers = selectedGame._igdb_involvedCompanies.filter(c => c.isDeveloper).map(c => ({ name: c.name }))
        const publishers = selectedGame._igdb_involvedCompanies.filter(c => c.isPublisher).map(c => ({ name: c.name }))
        const metaPayload = normalizeMetadataPayload({
          description_raw: selectedGame._igdb_summary || '',
          storyline: selectedGame._igdb_storyline || '',
          developers,
          publishers,
          genres: selectedGame._igdb_genres || [],
          themes: selectedGame._igdb_themes || [],
          ageRatings: selectedGame._igdb_ageRatings || [],
          similarGames: selectedGame._igdb_similarGames || [],
          franchise: selectedGame._igdb_franchise || null,
          collections: selectedGame._igdb_collections || [],
          franchises: selectedGame._igdb_franchises || [],
        })
        if (metaPayload) {
          const cacheKey = buildMetadataCacheKey({ ...newGame, normalized_title: selectedGame.name })
          setGameDetailsCache({
            gameId: newGame.id,
            provider: GAME_DETAIL_PROVIDERS.metadata,
            cacheKey,
            payload: metaPayload,
            cachedAt: new Date().toISOString(),
            staleAfter: getStaleAfterIso(GAME_DETAIL_TTLS.metadata),
          }).catch(() => {})
        }
      }

      await refreshGames()
      setPendingAddGame(null)
    } catch (err) {
      console.error('Add single game error:', err)
      setError(err.message || String(err))
    } finally {
      setAddingGame(false)
    }
  }, [pendingAddGame, refreshGames])

  // Called when user confirms re-adding a previously removed game
  const handleConfirmRestore = useCallback(async () => {
    if (!pendingRestore) return
    setAddingGame(true)
    setError(null)
    try {
      await restoreUserRemovedGame(pendingRestore.existingId, {
        install_path: pendingRestore.install_path,
        raw_file_name: pendingRestore.raw_file_name,
        raw_folder_name: pendingRestore.raw_folder_name,
      })

      // Re-apply metadata
      const sg = pendingRestore.selectedGame
      const meta = {
        normalized_title: sg.name,
        rating: sg.rating || 0,
        release_date: sg.released || '',
        cover_url: sg.background_image || '',
        metadata_fetched: 1,
      }
      if (sg._igdb_genres?.length) meta.genres = sg._igdb_genres.join(',')
      if (sg._igdb_franchise) meta.franchise = sg._igdb_franchise
      try {
        const unified = await fetchUnifiedGameData(sg.name)
        if (unified) {
          if (unified.cover) meta.cover_url = unified.cover
          if (unified.hero) meta.hero_url = unified.hero
          if (unified.logo) meta.logo_url = unified.logo
        }
      } catch (_) {}

      await updateGameMetadata(pendingRestore.existingId, meta)

      // Populate game_details_cache with IGDB metadata (dev/pub/summary)
      if (sg._igdb_involvedCompanies !== undefined) {
        const developers = sg._igdb_involvedCompanies.filter(c => c.isDeveloper).map(c => ({ name: c.name }))
        const publishers = sg._igdb_involvedCompanies.filter(c => c.isPublisher).map(c => ({ name: c.name }))
        const metaPayload = normalizeMetadataPayload({
          description_raw: sg._igdb_summary || '',
          storyline: sg._igdb_storyline || '',
          developers,
          publishers,
          genres: sg._igdb_genres || [],
          themes: sg._igdb_themes || [],
          ageRatings: sg._igdb_ageRatings || [],
          similarGames: sg._igdb_similarGames || [],
          franchise: sg._igdb_franchise || null,
          collections: sg._igdb_collections || [],
          franchises: sg._igdb_franchises || [],
        })
        if (metaPayload) {
          const cacheKey = buildMetadataCacheKey({ id: pendingRestore.existingId, normalized_title: sg.name })
          setGameDetailsCache({
            gameId: pendingRestore.existingId,
            provider: GAME_DETAIL_PROVIDERS.metadata,
            cacheKey,
            payload: metaPayload,
            cachedAt: new Date().toISOString(),
            staleAfter: getStaleAfterIso(GAME_DETAIL_TTLS.metadata),
          }).catch(() => {})
        }
      }

      await refreshGames()
      setPendingRestore(null)
      setPendingAddGame(null)
    } catch (err) {
      console.error('Restore game error:', err)
      setError(err.message || String(err))
    } finally {
      setAddingGame(false)
    }
  }, [pendingRestore, refreshGames])

  const handleCancelAddSingleGame = useCallback(() => {
    setPendingAddGame(null)
  }, [])

  // ─────────────────────────────────────────────────────────────────────────────

  const handleEnrich = useCallback(async () => {
    setEnriching(true)
    setEnrichResult(null)
    setError(null)
    setEnrichProgress(null)
    try {
      const res = await enrichAllGames(
        getUnenrichedGames,
        updateGameMetadata,
        (p) => setEnrichProgress(p)
      )
      setEnrichResult(res)
      if (res.enriched > 0) await refreshGames()
    } catch (err) {
      console.error('Enrich error:', err)
      setError(err.message || String(err))
    } finally {
      setEnriching(false)
      setEnrichProgress(null)
    }
  }, [refreshGames])

  return {
    folders,
    scanning,
    enriching,
    candidates,
    coverMap,
    enrichProgress,
    result,
    enrichResult,
    error,
    scanProgress,
    gameCount,
    addFolder: handleAddFolder,
    removeFolder: handleRemoveFolder,
    scan: handleScan,
    confirmImport: handleConfirmImport,
    cancelImport: handleCancelImport,
    enrich: handleEnrich,
    pendingAddGame,
    addingGame,
    pendingRestore,
    confirmRestore: handleConfirmRestore,
    cancelRestore: () => { setPendingRestore(null); setPendingAddGame(null) },
    startAddSingleGame: handleStartAddSingleGame,
    confirmAddSingleGame: handleConfirmAddSingleGame,
    cancelAddSingleGame: handleCancelAddSingleGame,
  }
}
