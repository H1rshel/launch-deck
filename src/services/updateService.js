/**
 * Update service for Launch Deck.
 *
 * Wraps @tauri-apps/plugin-updater and @tauri-apps/plugin-process.
 * All functions degrade gracefully when running in a browser or dev server
 * (no Tauri environment), so the app remains fully functional during development.
 *
 * IMPORTANT – updater signing:
 *   Signed update artifacts require TAURI_SIGNING_PRIVATE_KEY to be set at
 *   build time. The private key must NEVER be committed to the repository.
 *   Store it as a GitHub Actions secret named TAURI_SIGNING_PRIVATE_KEY.
 *   The matching public key goes in tauri.conf.json → plugins.updater.pubkey.
 */

export const UPDATE_MODES = {
  NOTIFY_ONLY: 'notify_only',
  AUTO_DOWNLOAD: 'auto_download',
  MANUAL_ONLY: 'manual_only',
  // TODO: INSTALL_ON_EXIT – download silently and install when the window closes.
  // Requires hooking the window close event and deferring it while the install
  // runs. Not implemented in this release.
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Returns the current app version string from Tauri, or null in browser mode.
 */
export async function getCurrentAppVersion() {
  if (!isTauri()) return null
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return null
  }
}

/**
 * Returns true when running inside a Tauri build that has the updater plugin.
 * Always false in browser / dev server mode.
 */
export function isUpdaterAvailable() {
  return isTauri()
}

/**
 * Check for an available update.
 *
 * Returns one of:
 *   { status: 'available', update, version, notes }
 *   { status: 'not_available' }
 *   { status: 'error', message }
 *
 * Automatic startup callers should use checkAndNotifyUpdate() instead — it
 * never throws and always returns a safe result.
 */
export async function checkForUpdates() {
  if (!isTauri()) {
    return { status: 'error', message: 'Updater not available outside of a Tauri build.' }
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      return { status: 'not_available' }
    }
    return {
      status: 'available',
      update,
      version: update.version,
      notes: update.body ?? null,
    }
  } catch (err) {
    return { status: 'error', message: err?.message ?? String(err) }
  }
}

/**
 * Download and install the given update object (returned by checkForUpdates).
 *
 * onProgress is called with:
 *   { event: 'Started',   downloaded: 0,  total: <bytes|0> }
 *   { event: 'Progress',  downloaded: N,  total: <bytes|0> }
 *   { event: 'Finished',  downloaded: N,  total: <bytes|0> }
 *
 * Throws on failure — callers must catch.
 */
export async function downloadAndInstallUpdate(update, onProgress) {
  let downloaded = 0
  let total = 0

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0
        onProgress?.({ event: 'Started', downloaded: 0, total })
        break
      case 'Progress':
        downloaded += event.data.chunkLength ?? 0
        onProgress?.({ event: 'Progress', downloaded, total })
        break
      case 'Finished':
        onProgress?.({ event: 'Finished', downloaded, total })
        break
    }
  })
}

/**
 * Relaunch the application to apply a freshly installed update.
 * Never force-calls this without user confirmation.
 */
export async function relaunchApp() {
  if (!isTauri()) return
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (err) {
    console.error('[updater] relaunch failed:', err)
  }
}

/**
 * Silent wrapper around checkForUpdates for use in automatic startup checks.
 * Never throws. Returns { status: 'not_available' } on any unexpected error.
 */
export async function checkAndNotifyUpdate() {
  try {
    return await checkForUpdates()
  } catch {
    return { status: 'not_available' }
  }
}
