import { invoke } from '@tauri-apps/api/core'
import { updateGame } from './db'

export function getInstallTarget(game) {
  if (!game) return null

  if (game.steam_app_id) {
    const appId = Number(game.steam_app_id)
    if (Number.isFinite(appId) && appId > 0) {
      return {
        type: 'steam',
        appId,
        launcher: 'Steam',
        processNames: ['steam.exe'],
      }
    }
  }

  if (game.gog_id) {
    return {
      type: 'url',
      url: `goggalaxy://openGameView/${encodeURIComponent(String(game.gog_id))}`,
      launcher: 'GOG Galaxy',
      processNames: ['galaxyclient.exe'],
    }
  }

  if (game.epic_id) {
    return {
      type: 'url',
      // Epic supports Artifact-ID based launcher navigation via the apps route.
      url: `com.epicgames.launcher://apps/${encodeURIComponent(String(game.epic_id))}?action=installer`,
      launcher: 'Epic Games Launcher',
      processNames: ['epicgameslauncher.exe'],
    }
  }

  if (game.ubisoft_id) {
    return {
      type: 'ubisoft',
      appId: String(game.ubisoft_id),
      launcher: 'Ubisoft Connect',
      processNames: ['ubisoftconnect.exe', 'upc.exe'],
    }
  }

  return null
}

export function canInstallGame(game) {
  return !!getInstallTarget(game)
}

export async function installGame(game) {
  const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
  const target = getInstallTarget(game)

  if (!target) {
    throw new Error('No launcher install target is available for this game')
  }

  if (!isTauri) {
    console.log(`Open install flow in ${target.launcher}:`, target)
    return target
  }

  if (target.type === 'steam') {
    await invoke('install_steam_game', { appId: target.appId })
  } else if (target.type === 'ubisoft') {
    await invoke('install_ubisoft_game', { appId: target.appId })
  } else {
    await invoke('open_url', { url: target.url })
  }

  if (target.processNames?.length) {
    try {
      await invoke('wait_for_processes', {
        processNames: target.processNames,
        timeoutMs: 8000,
      })
    } catch (err) {
      console.warn(`Failed waiting for ${target.launcher} to open:`, err)
    }
  }

  return target
}

export async function launchGame(game) {
  const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
  if (!isTauri) {
    console.log('Launch game (dev mode):', game.install_path)
    return
  }

  if (!game.install_path) {
    throw new Error('No install path for this game')
  }

  await invoke('launch_game', { gameId: game.id, path: game.install_path })

  // Update last_played timestamp
  try {
    await updateGame(game.id, {
      last_played: new Date().toISOString(),
      status: 'installed',
    })
  } catch (err) {
    console.error('Failed to update last_played:', err)
  }
}
