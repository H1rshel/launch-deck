import { invoke } from '@tauri-apps/api/core'
import {
  getAllGames,
  addGame,
  updateGame,
  getUserRemovedSteamIds,
  getUserRemovedGogIds,
  getUserRemovedEpicIds,
  getUserRemovedUbisoftIds,
  getUserRemovedPaths,
  getFolders,
} from './db'

const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

function getStoredValue(key) {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
}

function setStoredValue(key, value) {
  if (typeof localStorage === 'undefined') return
  if (value == null || value === '') {
    localStorage.removeItem(key)
    return
  }
  localStorage.setItem(key, value)
}

async function fetchOwnedGamesWithRefresh({
  fetchCommand,
  refreshCommand,
  accessTokenKey,
  refreshTokenKey,
}) {
  let accessToken = getStoredValue(accessTokenKey)
  if (!accessToken) return []

  try {
    return await invoke(fetchCommand, { accessToken })
  } catch (initialError) {
    if (!refreshCommand) throw initialError

    const refreshToken = getStoredValue(refreshTokenKey)
    if (!refreshToken) throw initialError

    let refreshed
    try {
      refreshed = await invoke(refreshCommand, { refreshToken })
    } catch (refreshError) {
      const message = String(refreshError || '')
      if (message.includes('invalid_client')) {
        setStoredValue(accessTokenKey, '')
        setStoredValue(refreshTokenKey, '')
      }
      throw refreshError
    }
    accessToken = refreshed.accessToken
    setStoredValue(accessTokenKey, refreshed.accessToken || '')
    setStoredValue(refreshTokenKey, refreshed.refreshToken || '')

    return invoke(fetchCommand, { accessToken })
  }
}

function normalizeTitleKey(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeWindowsPath(value = '') {
  return String(value)
    .replace(/\//g, '\\')
    .toLowerCase()
    .replace(/[\\]+$/, '')
}

function looksLikeUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))
}

function shouldReplaceLauncherId(field, currentValue, nextValue) {
  const current = String(currentValue || '')
  const next = String(nextValue || '')
  if (!field || !next || current === next) return false
  if (!current) return true

  if (field === 'ubisoft_id') {
    return looksLikeUuid(next) && !looksLikeUuid(current)
  }

  return false
}

function isGameInsideDirectory(game, dirLower) {
  const installPath = normalizeWindowsPath(game?.install_path || '')
  return !!installPath && !!dirLower && (installPath === dirLower || installPath.startsWith(`${dirLower}\\`))
}

function getLauncherIdField(platform) {
  if (platform === 'GOG') return 'gog_id'
  if (platform === 'Epic Games') return 'epic_id'
  if (platform === 'Ubisoft Connect') return 'ubisoft_id'
  return null
}

function isRemovedLauncherPath(dirLower, userRemovedPaths) {
  for (const removedPath of userRemovedPaths) {
    if (!removedPath) continue
    const normalizedRemovedPath = normalizeWindowsPath(removedPath)
    const removedDir = normalizedRemovedPath.includes('\\')
      ? normalizedRemovedPath.slice(0, normalizedRemovedPath.lastIndexOf('\\'))
      : normalizedRemovedPath
    if (
      normalizedRemovedPath.startsWith(`${dirLower}\\`) ||
      dirLower === removedDir ||
      dirLower.startsWith(`${removedDir}\\`)
    ) {
      return true
    }
  }
  return false
}

/**
 * Diff-based library sync.
 *
 * Matching priority for existing DB games:
 *   1. launcher-specific IDs (steam_app_id / gog_id / epic_id / ubisoft_id)
 *   2. install_path prefix (games added via scan before sync existed)
 *   3. normalized title fallback
 *
 * Never deletes - only marks installed/not_installed.
 *
 * @param {object} [options]
 * @param {(msg: string|null) => void} [options.onProgress]
 * @returns {{ added: number, updated: number, uninstalled: number, addedTitles: string[] }}
 */
export async function syncLibrary({ onProgress } = {}) {
  if (!isTauri) return { added: 0, updated: 0, uninstalled: 0, addedTitles: [] }

  onProgress?.('Reading Steam library...')
  let steamGames = []
  try {
    steamGames = await invoke('scan_steam_library')
  } catch (err) {
    console.warn('Steam library scan failed (Steam may not be installed):', err)
  }

  const [
    dbGames,
    userRemovedSteamIds,
    userRemovedGogIds,
    userRemovedEpicIds,
    userRemovedUbisoftIds,
    userRemovedPaths,
  ] = await Promise.all([
    getAllGames(),
    getUserRemovedSteamIds(),
    getUserRemovedGogIds(),
    getUserRemovedEpicIds(),
    getUserRemovedUbisoftIds(),
    getUserRemovedPaths(),
  ])
  const now = new Date().toISOString()

  const dbBySteamId = new Map()
  const dbByGogId = new Map()
  const dbByEpicId = new Map()
  const dbByUbisoftId = new Map()
  const dbByTitle = new Map()

  function indexGame(game) {
    if (!game?.id) return game
    const existingIndex = dbGames.findIndex((g) => g.id === game.id)
    if (existingIndex === -1) {
      dbGames.push(game)
    } else {
      dbGames[existingIndex] = game
    }

    if (game.steam_app_id) dbBySteamId.set(String(game.steam_app_id), game)
    if (game.gog_id) dbByGogId.set(String(game.gog_id), game)
    if (game.epic_id) dbByEpicId.set(String(game.epic_id), game)
    if (game.ubisoft_id) dbByUbisoftId.set(String(game.ubisoft_id), game)

    const titleKey = normalizeTitleKey(game.normalized_title || game.title || '')
    if (titleKey) dbByTitle.set(titleKey, game)
    return game
  }

  function mergeIndexedGame(game, updates = {}) {
    if (!game) return null
    const merged = {
      ...game,
      ...updates,
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
      merged.installed = updates.status === 'installed'
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'last_played')) {
      merged.lastPlayed = updates.last_played
    }
    if (
      Object.prototype.hasOwnProperty.call(updates, 'title') ||
      Object.prototype.hasOwnProperty.call(updates, 'normalized_title')
    ) {
      merged.displayTitle = merged.normalized_title || merged.title
    }
    return indexGame(merged)
  }

  for (const game of dbGames) {
    indexGame(game)
  }

  const steamAppIds = new Set(steamGames.map((game) => String(game.appId)))

  let added = 0
  let updated = 0
  const addedTitles = []

  for (const sg of steamGames) {
    const appIdStr = String(sg.appId)
    if (userRemovedSteamIds.has(appIdStr)) continue

    let existing = dbBySteamId.get(appIdStr)

    if (!existing) {
      const steamDir = normalizeWindowsPath(sg.installPath)
      existing = dbGames.find((game) => isGameInsideDirectory(game, steamDir))
    }

    if (existing) {
      const updates = {}
      if (!existing.steam_app_id) updates.steam_app_id = appIdStr
      if (!existing.installed) updates.status = 'installed'

      if (Object.keys(updates).length > 0) {
        updates.last_seen_installed = now
        await updateGame(existing.id, updates)
        existing = mergeIndexedGame(existing, updates)
        updated++
      }

      dbBySteamId.set(appIdStr, existing)
      continue
    }

    onProgress?.(`Adding ${sg.name}...`)
    try {
      const exePaths = await invoke('list_game_exes', { folder: sg.installPath })
      if (!exePaths || exePaths.length === 0) continue

      const exePath = exePaths[0]
      const newGame = await addGame({
        title: sg.name,
        install_path: exePath,
        platform: 'Steam',
        steam_app_id: sg.appId,
        status: 'installed',
        last_seen_installed: now,
        raw_file_name: exePath.split('\\').pop() || '',
        raw_folder_name: sg.installPath.split('\\').pop() || '',
      })
      indexGame(newGame)
      added++
      addedTitles.push(sg.name)
    } catch (err) {
      console.warn(`Skipped ${sg.name}:`, err?.message ?? err)
    }
  }

  const uninstalledTitles = []
  for (const game of dbGames) {
    if (!game.steam_app_id) continue
    if (!steamAppIds.has(String(game.steam_app_id)) && game.installed) {
      await updateGame(game.id, { status: 'not_installed' })
      mergeIndexedGame(game, { status: 'not_installed' })
      uninstalledTitles.push(game.title)
    }
  }

  const steamId = typeof localStorage !== 'undefined' ? localStorage.getItem('steamId') : null
  if (steamId) {
    onProgress?.('Fetching Steam account library...')
    try {
      const ownedGames = await invoke('get_steam_owned_games', { steamId })
      for (const og of ownedGames) {
        const appIdStr = String(og.appId)
        if (userRemovedSteamIds.has(appIdStr)) continue

        const existingByApp = dbBySteamId.get(appIdStr)
        if (existingByApp?.id && og.playtimeMinutes > 0) {
          const ptUpdates = { imported_playtime_minutes: og.playtimeMinutes }
          if (!existingByApp.lastPlayed && og.lastPlayed > 0) {
            ptUpdates.last_played = new Date(og.lastPlayed * 1000).toISOString()
          }
          await updateGame(existingByApp.id, ptUpdates)
          mergeIndexedGame(existingByApp, ptUpdates)
        }

        if (steamAppIds.has(appIdStr)) continue
        if (dbBySteamId.has(appIdStr)) continue

        const titleKey = normalizeTitleKey(og.name)
        if (dbByTitle.has(titleKey)) {
          const existing = dbByTitle.get(titleKey)
          const titleUpdates = {}
          if (!existing.steam_app_id) titleUpdates.steam_app_id = og.appId
          if (og.playtimeMinutes > 0) titleUpdates.imported_playtime_minutes = og.playtimeMinutes
          if (!existing.lastPlayed && og.lastPlayed > 0) {
            titleUpdates.last_played = new Date(og.lastPlayed * 1000).toISOString()
          }
          if (Object.keys(titleUpdates).length > 0) {
            await updateGame(existing.id, titleUpdates)
            mergeIndexedGame(existing, titleUpdates)
          }
          continue
        }

        try {
          const lastPlayedIso = og.lastPlayed > 0 ? new Date(og.lastPlayed * 1000).toISOString() : ''
          const newGame = await addGame({
            title: og.name,
            install_path: '',
            platform: 'Steam',
            steam_app_id: og.appId,
            status: 'not_installed',
            raw_folder_name: og.name,
            raw_file_name: '',
            last_played: lastPlayedIso,
          })
          indexGame(newGame)
          if (og.playtimeMinutes > 0) {
            const ptUpdates = { imported_playtime_minutes: og.playtimeMinutes }
            await updateGame(newGame.id, ptUpdates)
            mergeIndexedGame(newGame, ptUpdates)
          }
          added++
          addedTitles.push(og.name)
        } catch (err) {
          console.warn(`Skipped owned game "${og.name}":`, err?.message ?? err)
        }
      }
    } catch (err) {
      console.warn('Failed to fetch owned Steam games:', err?.message ?? err)
    }
  }

  onProgress?.('Scanning other launchers...')
  try {
    const launcherGames = await invoke('scan_launcher_library')
    const launcherIdMaps = {
      gog_id: dbByGogId,
      epic_id: dbByEpicId,
      ubisoft_id: dbByUbisoftId,
    }
    const userRemovedLauncherIds = {
      gog_id: userRemovedGogIds,
      epic_id: userRemovedEpicIds,
      ubisoft_id: userRemovedUbisoftIds,
    }

    for (const lg of launcherGames) {
      const dirLower = normalizeWindowsPath(lg.installPath)
      const titleKey = normalizeTitleKey(lg.name)
      const launcherField = getLauncherIdField(lg.platform)
      const launcherIdStr = launcherField && lg.launcherId ? String(lg.launcherId) : ''

      if (launcherField && launcherIdStr && userRemovedLauncherIds[launcherField]?.has(launcherIdStr)) {
        continue
      }
      if (isRemovedLauncherPath(dirLower, userRemovedPaths)) continue

      let existing = launcherField && launcherIdStr
        ? launcherIdMaps[launcherField]?.get(launcherIdStr)
        : null

      if (!existing) {
        existing = dbGames.find((game) => isGameInsideDirectory(game, dirLower))
      }
      if (!existing && dbByTitle.has(titleKey)) {
        existing = dbByTitle.get(titleKey)
      }

      if (existing) {
        const updates = {}
        if (
          launcherField &&
          launcherIdStr &&
          (!existing[launcherField] || shouldReplaceLauncherId(launcherField, existing[launcherField], launcherIdStr))
        ) {
          updates[launcherField] = launcherIdStr
        }
        if (!existing.installed) {
          updates.status = 'installed'
        }
        if (
          lg.platform &&
          (
            !existing.platform ||
            existing.platform === 'PC' ||
            (launcherField === 'ubisoft_id' && existing.platform === 'Ubisoft')
          )
        ) {
          updates.platform = lg.platform
        }

        const needsExePath = !isGameInsideDirectory(existing, dirLower)
        if (needsExePath) {
          const exePaths = await invoke('list_game_exes', { folder: lg.installPath })
          if ((!exePaths || exePaths.length === 0) && !existing.installed) {
            continue
          }
          if (exePaths && exePaths.length > 0) {
            const exePath = exePaths[0]
            updates.install_path = exePath
            updates.raw_file_name = exePath.split('\\').pop() || ''
            updates.raw_folder_name = lg.installPath.split('\\').pop() || ''
          }
        }

        if (Object.keys(updates).length > 0) {
          updates.last_seen_installed = now
          await updateGame(existing.id, updates)
          mergeIndexedGame(existing, updates)
          updated++
        }
        continue
      }

      try {
        onProgress?.(`Adding ${lg.name}...`)
        const exePaths = await invoke('list_game_exes', { folder: lg.installPath })
        if (!exePaths || exePaths.length === 0) continue

        const exePath = exePaths[0]
        const newGame = await addGame({
          title: lg.name,
          install_path: exePath,
          platform: lg.platform,
          status: 'installed',
          gog_id: launcherField === 'gog_id' ? launcherIdStr : '',
          epic_id: launcherField === 'epic_id' ? launcherIdStr : '',
          ubisoft_id: launcherField === 'ubisoft_id' ? launcherIdStr : '',
          last_seen_installed: now,
          raw_file_name: exePath.split('\\').pop() || '',
          raw_folder_name: lg.installPath.split('\\').pop() || '',
        })
        indexGame(newGame)
        added++
        addedTitles.push(lg.name)
      } catch (err) {
        console.warn(`Skipped ${lg.platform} game "${lg.name}":`, err?.message ?? err)
      }
    }
  } catch (err) {
    console.warn('Launcher library scan failed:', err?.message ?? err)
  }

  const gogAccessToken = getStoredValue('gogAccessToken')
  if (gogAccessToken) {
    onProgress?.('Fetching GOG account library...')
    try {
      const gogGames = await fetchOwnedGamesWithRefresh({
        fetchCommand: 'get_gog_owned_games',
        refreshCommand: 'refresh_gog_token',
        accessTokenKey: 'gogAccessToken',
        refreshTokenKey: 'gogRefreshToken',
      })
      for (const og of gogGames) {
        const gogIdStr = String(og.appId)
        if (userRemovedGogIds.has(gogIdStr)) continue

        const existingById = dbByGogId.get(gogIdStr)
        if (existingById?.id && (og.playtimeMinutes > 0 || (og.lastPlayed > 0 && !existingById.lastPlayed))) {
          const ptUpdates = {}
          if (og.playtimeMinutes > 0) ptUpdates.imported_playtime_minutes = Math.max(existingById.imported_playtime_minutes || 0, og.playtimeMinutes)
          if (!existingById.lastPlayed && og.lastPlayed > 0) ptUpdates.last_played = new Date(og.lastPlayed * 1000).toISOString()
          await updateGame(existingById.id, ptUpdates)
          mergeIndexedGame(existingById, ptUpdates)
        }

        if (dbByGogId.has(gogIdStr)) continue

        const titleKey = normalizeTitleKey(og.title)
        if (dbByTitle.has(titleKey)) {
          const existing = dbByTitle.get(titleKey)
          const titleUpdates = {}
          if (!existing.gog_id) titleUpdates.gog_id = og.appId
          if (og.playtimeMinutes > 0) titleUpdates.imported_playtime_minutes = Math.max(existing.imported_playtime_minutes || 0, og.playtimeMinutes)
          if (!existing.lastPlayed && og.lastPlayed > 0) titleUpdates.last_played = new Date(og.lastPlayed * 1000).toISOString()
          if (Object.keys(titleUpdates).length > 0) {
            await updateGame(existing.id, titleUpdates)
            mergeIndexedGame(existing, titleUpdates)
          }
          continue
        }

        try {
          const lastPlayedIso = og.lastPlayed > 0 ? new Date(og.lastPlayed * 1000).toISOString() : ''
          const newGame = await addGame({
            title: og.title,
            install_path: '',
            platform: 'GOG',
            gog_id: og.appId,
            status: 'not_installed',
            raw_folder_name: og.title,
            raw_file_name: '',
            last_played: lastPlayedIso,
          })
          indexGame(newGame)
          if (og.playtimeMinutes > 0) {
            const ptUpdates = { imported_playtime_minutes: og.playtimeMinutes }
            await updateGame(newGame.id, ptUpdates)
            mergeIndexedGame(newGame, ptUpdates)
          }
          added++
          addedTitles.push(og.title)
        } catch (err) {
          console.warn(`Skipped GOG game "${og.title}":`, err?.message ?? err)
        }
      }
    } catch (err) {
      console.warn('Failed to fetch GOG owned games:', err?.message ?? err)
    }
  }

  const epicAccessToken = getStoredValue('epicAccessToken')
  if (epicAccessToken) {
    onProgress?.('Fetching Epic Games library...')
    try {
      const epicGames = await fetchOwnedGamesWithRefresh({
        fetchCommand: 'get_epic_owned_games',
        refreshCommand: 'refresh_epic_token',
        accessTokenKey: 'epicAccessToken',
        refreshTokenKey: 'epicRefreshToken',
      })
      for (const og of epicGames) {
        const epicIdStr = String(og.appId)
        if (userRemovedEpicIds.has(epicIdStr)) continue

        const existingById = dbByEpicId.get(epicIdStr)
        if (existingById?.id && (og.playtimeMinutes > 0 || (og.lastPlayed > 0 && !existingById.lastPlayed))) {
          const ptUpdates = {}
          if (og.playtimeMinutes > 0) ptUpdates.imported_playtime_minutes = Math.max(existingById.imported_playtime_minutes || 0, og.playtimeMinutes)
          if (!existingById.lastPlayed && og.lastPlayed > 0) ptUpdates.last_played = new Date(og.lastPlayed * 1000).toISOString()
          await updateGame(existingById.id, ptUpdates)
          mergeIndexedGame(existingById, ptUpdates)
        }

        if (dbByEpicId.has(epicIdStr)) continue

        const titleKey = normalizeTitleKey(og.title)
        if (dbByTitle.has(titleKey)) {
          const existing = dbByTitle.get(titleKey)
          const titleUpdates = {}
          if (!existing.epic_id) titleUpdates.epic_id = og.appId
          if (og.playtimeMinutes > 0) titleUpdates.imported_playtime_minutes = Math.max(existing.imported_playtime_minutes || 0, og.playtimeMinutes)
          if (!existing.lastPlayed && og.lastPlayed > 0) titleUpdates.last_played = new Date(og.lastPlayed * 1000).toISOString()
          if (Object.keys(titleUpdates).length > 0) {
            await updateGame(existing.id, titleUpdates)
            mergeIndexedGame(existing, titleUpdates)
          }
          continue
        }

        try {
          const lastPlayedIso = og.lastPlayed > 0 ? new Date(og.lastPlayed * 1000).toISOString() : ''
          const newGame = await addGame({
            title: og.title,
            install_path: '',
            platform: 'Epic Games',
            epic_id: og.appId,
            status: 'not_installed',
            raw_folder_name: og.title,
            raw_file_name: '',
            last_played: lastPlayedIso,
          })
          indexGame(newGame)
          if (og.playtimeMinutes > 0) {
            const ptUpdates = { imported_playtime_minutes: og.playtimeMinutes }
            await updateGame(newGame.id, ptUpdates)
            mergeIndexedGame(newGame, ptUpdates)
          }
          added++
          addedTitles.push(og.title)
        } catch (err) {
          console.warn(`Skipped Epic game "${og.title}":`, err?.message ?? err)
        }
      }
    } catch (err) {
      console.warn('Failed to fetch Epic owned games:', err?.message ?? err)
    }
  }

  const ubisoftAccountId = typeof localStorage !== 'undefined' ? localStorage.getItem('ubisoftAccountId') : null
  if (ubisoftAccountId) {
    onProgress?.('Fetching Ubisoft Connect library...')
    try {
      const ubisoftGames = await invoke('get_ubisoft_owned_games', { accountId: ubisoftAccountId })
      for (const og of ubisoftGames) {
        const ubisoftIdStr = String(og.appId)
        if (userRemovedUbisoftIds.has(ubisoftIdStr)) continue

        const existingById = dbByUbisoftId.get(ubisoftIdStr)
        if (existingById?.id && (og.playtimeMinutes > 0 || (og.lastPlayed > 0 && !existingById.lastPlayed))) {
          const ptUpdates = {}
          if (og.playtimeMinutes > 0) ptUpdates.imported_playtime_minutes = Math.max(existingById.imported_playtime_minutes || 0, og.playtimeMinutes)
          if (!existingById.lastPlayed && og.lastPlayed > 0) ptUpdates.last_played = new Date(og.lastPlayed * 1000).toISOString()
          await updateGame(existingById.id, ptUpdates)
          mergeIndexedGame(existingById, ptUpdates)
        }

        if (dbByUbisoftId.has(ubisoftIdStr)) continue

        const titleKey = normalizeTitleKey(og.title)
        if (dbByTitle.has(titleKey)) {
          const existing = dbByTitle.get(titleKey)
          const titleUpdates = {}
          if (
            !existing.ubisoft_id ||
            shouldReplaceLauncherId('ubisoft_id', existing.ubisoft_id, og.appId)
          ) {
            titleUpdates.ubisoft_id = og.appId
            if (!existing.platform || existing.platform === 'PC' || existing.platform === 'Ubisoft') {
              titleUpdates.platform = 'Ubisoft Connect'
            }
          }
          if (og.playtimeMinutes > 0) titleUpdates.imported_playtime_minutes = Math.max(existing.imported_playtime_minutes || 0, og.playtimeMinutes)
          if (!existing.lastPlayed && og.lastPlayed > 0) titleUpdates.last_played = new Date(og.lastPlayed * 1000).toISOString()
          
          if (Object.keys(titleUpdates).length > 0) {
            await updateGame(existing.id, titleUpdates)
            mergeIndexedGame(existing, titleUpdates)
          }
          continue
        }

        try {
          const lastPlayedIso = og.lastPlayed > 0 ? new Date(og.lastPlayed * 1000).toISOString() : ''
          const newGame = await addGame({
            title: og.title,
            install_path: '',
            platform: 'Ubisoft Connect',
            ubisoft_id: og.appId,
            status: 'not_installed',
            raw_folder_name: og.title,
            raw_file_name: '',
            last_played: lastPlayedIso,
          })
          indexGame(newGame)
          if (og.playtimeMinutes > 0) {
            const ptUpdates = { imported_playtime_minutes: og.playtimeMinutes }
            await updateGame(newGame.id, ptUpdates)
            mergeIndexedGame(newGame, ptUpdates)
          }
          added++
          addedTitles.push(og.title)
        } catch (err) {
          console.warn(`Skipped Ubisoft game "${og.title}":`, err?.message ?? err)
        }
      }
    } catch (err) {
      console.warn('Failed to fetch Ubisoft owned games:', err?.message ?? err)
    }
  }

  try {
    const folders = await getFolders()
    if (folders && folders.length > 0) {
      onProgress?.('Scanning custom folders...')
      const folderPaths = folders.map((folder) => folder.path)
      const scannedGames = await invoke('advanced_scan', { folders: folderPaths })

      for (const sg of scannedGames) {
        if (!sg.executable) continue
        const sgPathLower = normalizeWindowsPath(sg.executable)
        if (userRemovedPaths.has(sgPathLower)) continue

        const alreadyInDb = dbGames.some(
          (game) => normalizeWindowsPath(game.install_path || '') === sgPathLower
        )
        if (alreadyInDb) continue

        if (sg.confidence >= 50) {
          onProgress?.(`Adding ${sg.name}...`)
          try {
            const newGame = await addGame({
              title: sg.name,
              install_path: sg.executable,
              platform: 'PC',
              status: 'installed',
              last_seen_installed: now,
              raw_file_name: sg.executable.split('\\').pop() || '',
              raw_folder_name: sg.executable.split('\\').slice(0, -1).pop() || '',
            })
            indexGame(newGame)
            added++
            addedTitles.push(sg.name)
          } catch (err) {
            console.warn(`Skipped custom game "${sg.name}":`, err?.message ?? err)
          }
        }
      }
    }
  } catch (err) {
    console.warn('Custom folder scan failed:', err?.message ?? err)
  }

  onProgress?.('Verifying local installs...')
  const localUninstalledTitles = await checkLocalInstalls()
  uninstalledTitles.push(...localUninstalledTitles)

  onProgress?.(null)
  return {
    added,
    updated,
    uninstalled: uninstalledTitles.length,
    addedTitles,
    uninstalledTitles,
  }
}

/**
 * Check non-Steam/launcher games: mark uninstalled only when the stored
 * executable (or its parent folder) is provably gone from disk.
 *
 * Uses a direct path-existence check instead of list_game_exes so that
 * SKIP_NAMES / SKIP_FOLDERS filters cannot cause false-positive removals
 * (e.g. Until Dawn whose exe lives in a folder that matched a skip pattern).
 */
export async function checkLocalInstalls() {
  if (!isTauri) return []
  const uninstalledTitles = []

  const dbGames = await getAllGames()
  const localGames = dbGames.filter((game) => !game.steam_app_id && game.install_path && game.installed)

  for (const game of localGames) {
    try {
      // Primary check: does the exact stored exe still exist?
      const exeExists = await invoke('path_exists', { path: game.install_path })
      if (exeExists) continue

      // Exe missing — check if the parent folder is still present.
      // Support both backslash and forward-slash paths.
      const sep = game.install_path.includes('\\') ? '\\' : '/'
      const folder = game.install_path.split(sep).slice(0, -1).join(sep)

      // If we can't determine a folder (shouldn't happen for valid paths), skip.
      if (!folder) continue

      const folderExists = await invoke('path_exists', { path: folder })

      // Only mark as not_installed when the parent folder is definitively gone.
      // If the folder still exists but the exe is missing (e.g. game updated its
      // binary path), we leave the status alone to avoid a false uninstall.
      if (!folderExists) {
        await updateGame(game.id, { status: 'not_installed' })
        uninstalledTitles.push(game.title)
      }
    } catch {
      // On any I/O / IPC error, be conservative: do NOT mark as uninstalled.
      // Transient permission issues or network drives going offline should not
      // wipe a game's install status.
    }
  }

  return uninstalledTitles
}
