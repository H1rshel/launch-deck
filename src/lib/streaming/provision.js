import { getAppMeta, setAppMeta } from '../db'
import { setDeviceStreamingFlags } from '../devices'

// Auto-provisioning for the streaming stack:
//  - Host: Sunshine (LizardByte) — installed silently as a Windows service
//  - Client: Moonlight portable — extracted into app data, no admin needed
// The user never configures either tool; Launch Deck owns credentials,
// pairing and app entries.

const SUNSHINE_INSTALLER_URL =
  'https://github.com/LizardByte/Sunshine/releases/latest/download/Sunshine-Windows-AMD64-installer.exe'

const MOONLIGHT_VERSION = '6.1.0'
const MOONLIGHT_ZIP_URL = `https://github.com/moonlight-stream/moonlight-qt/releases/download/v${MOONLIGHT_VERSION}/MoonlightPortable-x64-${MOONLIGHT_VERSION}.zip`

export const SUNSHINE_CREDS_USER_KEY = 'sunshine_username'
export const SUNSHINE_CREDS_PASS_KEY = 'sunshine_password'
const MOONLIGHT_EXE_KEY = 'moonlight_exe'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke(cmd, args)
}

function randomSecret(length = 24) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Sunshine web-UI/API credentials owned by Launch Deck. Generated once per
 * host PC and persisted in the local SQLite app_meta store.
 * NOTE: stored in plaintext at rest (like the platform tokens in
 * localStorage); moving to DPAPI is a tracked follow-up.
 */
export async function getSunshineCreds() {
  let username = await getAppMeta(SUNSHINE_CREDS_USER_KEY)
  let password = await getAppMeta(SUNSHINE_CREDS_PASS_KEY)
  if (!username || !password) {
    username = 'launchdeck'
    password = randomSecret()
    await setAppMeta(SUNSHINE_CREDS_USER_KEY, username)
    await setAppMeta(SUNSHINE_CREDS_PASS_KEY, password)
  }
  return { username, password }
}

export async function sunshineApi(method, path, body = null) {
  const { username, password } = await getSunshineCreds()
  return invoke('sunshine_api', { method, path, body, username, password })
}

async function verifySunshineApi({ attempts = 10, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      await sunshineApi('GET', '/api/apps')
      return true
    } catch {
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return false
}

/**
 * Fully provisions this PC as a streaming host:
 * download → silent install (one UAC prompt) → set credentials → verify API →
 * flag the device registry. Idempotent — safe to call when already set up.
 *
 * onProgress: ({ step, percent }) => void
 *   steps: 'checking' | 'downloading' | 'installing' | 'verifying' | 'done'
 */
export async function provisionSunshineHost(userId, onProgress = () => {}) {
  if (!isTauri) throw new Error('Streaming host setup requires the desktop app')

  onProgress({ step: 'checking' })
  const alreadyInstalled = await invoke('is_sunshine_installed')
  const { username, password } = await getSunshineCreds()

  // Already installed + our creds already work → nothing to do.
  if (alreadyInstalled) {
    const serviceUp = await invoke('is_sunshine_service_running')
    if (serviceUp) {
      try {
        await sunshineApi('GET', '/api/apps')
        onProgress({ step: 'done' })
        await setDeviceStreamingFlags(userId, { hostEnabled: true, provisioned: true })
        return
      } catch {
        // Installed but our creds don't work yet — fall through to set them.
      }
    }
  }

  let installerPath = null
  if (!alreadyInstalled) {
    onProgress({ step: 'downloading', percent: 0 })
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen('download_progress', (event) => {
      const { dest_name: destName, downloaded, total } = event.payload || {}
      if (destName === 'sunshine-installer.exe' && total > 0) {
        onProgress({ step: 'downloading', percent: Math.round((downloaded / total) * 100) })
      }
    })
    try {
      installerPath = await invoke('download_file', {
        url: SUNSHINE_INSTALLER_URL,
        destName: 'sunshine-installer.exe',
      })
    } finally {
      unlisten()
    }
  }

  onProgress({ step: 'installing' })

  // One elevated script = one UAC prompt for the whole setup. The NSIS
  // installer registers the SunshineService (auto-start) and adds the
  // required firewall rules itself.
  //
  // CRITICAL: the installer auto-launches sunshine.exe even with /S, and any
  // stray (non-service) instance holds Sunshine's files locked — every
  // service start then dies with "file is being used by another process".
  // So every step is bracketed with process kills, and the service start is
  // verified in a retry loop; a script that can't get the service Running
  // exits non-zero so the user sees a real error instead of a dead API.
  const escape = (s) => String(s).replace(/'/g, "''")
  const lines = []
  if (installerPath) {
    lines.push(`Start-Process -FilePath '${escape(installerPath)}' -ArgumentList '/S' -Wait`)
    lines.push(`Start-Sleep -Seconds 2`)
  }
  lines.push(`Stop-Service -Name SunshineService -ErrorAction SilentlyContinue`)
  lines.push(`Stop-Process -Name sunshine -Force -ErrorAction SilentlyContinue`)
  lines.push(`Stop-Process -Name sunshinesvc -Force -ErrorAction SilentlyContinue`)
  lines.push(`Start-Sleep -Seconds 1`)
  lines.push(`& 'C:\\Program Files\\Sunshine\\sunshine.exe' --creds '${escape(username)}' '${escape(password)}'`)
  lines.push(`Stop-Process -Name sunshine -Force -ErrorAction SilentlyContinue`)
  lines.push(`Start-Sleep -Seconds 1`)
  lines.push(`$tries = 0`)
  lines.push(`while ($tries -lt 5) {`)
  lines.push(`  Start-Service -Name SunshineService -ErrorAction SilentlyContinue`)
  lines.push(`  Start-Sleep -Seconds 2`)
  lines.push(`  if ((Get-Service -Name SunshineService).Status -eq 'Running') { break }`)
  lines.push(`  Stop-Process -Name sunshine -Force -ErrorAction SilentlyContinue`)
  lines.push(`  Stop-Process -Name sunshinesvc -Force -ErrorAction SilentlyContinue`)
  lines.push(`  $tries++`)
  lines.push(`}`)
  lines.push(`if ((Get-Service -Name SunshineService).Status -ne 'Running') { exit 1 }`)

  await invoke('run_elevated_script', { script: lines.join('\n') })

  onProgress({ step: 'verifying' })
  const ok = await verifySunshineApi()
  if (!ok) {
    throw new Error(
      'The streaming service installed but did not respond. Toggle streaming again to retry — if it keeps failing, restart this PC first.',
    )
  }

  await setDeviceStreamingFlags(userId, { hostEnabled: true, provisioned: true })
  onProgress({ step: 'done' })
}

/**
 * Ensures the portable Moonlight client exists locally; downloads and
 * extracts it on first use (no admin rights needed). Returns the exe path.
 */
export async function ensureMoonlightClient(onProgress = () => {}) {
  if (!isTauri) throw new Error('Streaming requires the desktop app')

  const saved = await getAppMeta(MOONLIGHT_EXE_KEY)
  if (saved) {
    try {
      const exists = await invoke('path_exists', { path: saved })
      if (exists) return saved
    } catch { /* fall through to re-download */ }
  }

  onProgress({ step: 'downloading', percent: 0 })
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen('download_progress', (event) => {
    const { dest_name: destName, downloaded, total } = event.payload || {}
    if (destName === 'moonlight-portable.zip' && total > 0) {
      onProgress({ step: 'downloading', percent: Math.round((downloaded / total) * 100) })
    }
  })

  let zipPath
  try {
    zipPath = await invoke('download_file', {
      url: MOONLIGHT_ZIP_URL,
      destName: 'moonlight-portable.zip',
    })
  } finally {
    unlisten()
  }

  onProgress({ step: 'extracting' })
  const { appDataDir, join } = await import('@tauri-apps/api/path')
  const base = await appDataDir()
  const destDir = await join(base, 'streaming', 'moonlight')
  await invoke('extract_zip', { zipPath, destDir })

  const exePath = await join(destDir, 'Moonlight.exe')
  const exists = await invoke('path_exists', { path: exePath })
  if (!exists) {
    throw new Error('Moonlight download finished but Moonlight.exe was not found')
  }

  await setAppMeta(MOONLIGHT_EXE_KEY, exePath)
  onProgress({ step: 'done' })
  return exePath
}
