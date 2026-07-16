import { supabase } from './supabase'
import { getAppMeta, setAppMeta, getAllGames } from './db'
import { getCloudGameId } from './cloudGameId'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

// A device is "online" when its heartbeat is fresher than this.
export const DEVICE_ONLINE_WINDOW_MS = 3 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 60 * 1000

const DEVICE_ID_KEY = 'device_id'
const INSTALL_MAP_HASH_KEY = 'install_map_hash'

let deviceIdPromise = null

/**
 * Stable per-install device identity. Generated once and persisted in the
 * SQLite app_meta table (survives WebView2 profile resets, unlike
 * localStorage). Browser dev mode falls back to localStorage.
 *
 * Single-flight: on first launch many callers (registration, heartbeat,
 * command listener, install map) race here before anything is persisted —
 * without sharing one promise each raced caller minted its own UUID and the
 * device registered multiple times.
 */
export function getDeviceId() {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      if (!isTauri) {
        let id = localStorage.getItem('ld_device_id')
        if (!id) {
          id = crypto.randomUUID()
          localStorage.setItem('ld_device_id', id)
        }
        return id
      }

      // Primary source: the Windows machine GUID — identical on every
      // launch and every reinstall on the same PC, so device identity can
      // never fork again (a persisted random UUID demonstrably did: one
      // laptop registered itself three times).
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const guid = String(await invoke('get_machine_guid') || '').toLowerCase()
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)) {
          setAppMeta(DEVICE_ID_KEY, guid).catch(() => {})
          return guid
        }
      } catch { /* fall back to the persisted random id */ }

      let id = await getAppMeta(DEVICE_ID_KEY)
      if (!id) {
        id = crypto.randomUUID()
        await setAppMeta(DEVICE_ID_KEY, id)
      }
      return id
    })()
    deviceIdPromise.catch(() => {
      deviceIdPromise = null // allow retry if the DB wasn't ready yet
    })
  }
  return deviceIdPromise
}

async function getHostname() {
  if (!isTauri) return 'Browser (dev)'
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke('get_hostname')
  } catch {
    return 'PC'
  }
}

async function getLanIp() {
  if (!isTauri) return ''
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke('get_local_ip')
  } catch {
    return ''
  }
}

async function getHardwareSummary() {
  // Reuse the cached rig snapshot instead of re-running full WMI detection —
  // useMyRig keeps it fresh, and registration must stay cheap.
  try {
    const raw = localStorage.getItem('launchdeck_rig_snapshot')
    if (!raw) return {}
    const snap = JSON.parse(raw)
    const data = snap?.data || snap
    return {
      cpu: data?.cpu?.name || '',
      gpu: data?.gpu?.name || '',
      ram_gb: data?.ram?.totalGb || data?.ram?.total_gb || null,
      platform_type: data?.platformType || '',
    }
  } catch {
    return {}
  }
}

async function getAppVersion() {
  if (!isTauri) return 'dev'
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return ''
  }
}

/**
 * Upsert this PC into user_devices. Called on login; the heartbeat keeps
 * last_seen fresh afterwards.
 */
export async function registerDevice(userId) {
  if (!userId) return null
  const deviceId = await getDeviceId()

  const [hostname, lanIp, hardware, appVersion] = await Promise.all([
    getHostname(),
    getLanIp(),
    getHardwareSummary(),
    getAppVersion(),
  ])

  const row = {
    user_id: userId,
    device_id: deviceId,
    hostname,
    lan_ip: lanIp,
    hardware,
    app_version: appVersion,
    last_seen: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('user_devices')
    .upsert(row, { onConflict: 'user_id,device_id' })

  if (error) {
    console.warn('registerDevice failed:', error.message)
    return null
  }

  // Self-cleanup: remove ghost registrations of THIS machine under old
  // device ids (pre-machine-GUID installs, first-launch races). Matching by
  // hostname is safe in practice — it's this user's own PCs.
  if (hostname) {
    supabase
      .from('user_devices')
      .delete()
      .eq('user_id', userId)
      .eq('hostname', hostname)
      .neq('device_id', deviceId)
      .then(({ error: cleanErr }) => {
        if (cleanErr) console.debug('device ghost cleanup failed:', cleanErr.message)
      })
  }

  return deviceId
}

let heartbeatTimer = null

export function startHeartbeat(userId) {
  stopHeartbeat()
  if (!userId) return

  const beat = async () => {
    try {
      const deviceId = await getDeviceId()
      const lanIp = await getLanIp()
      const update = { last_seen: new Date().toISOString() }
      if (lanIp) update.lan_ip = lanIp
      await supabase
        .from('user_devices')
        .update(update)
        .eq('user_id', userId)
        .eq('device_id', deviceId)
    } catch (err) {
      console.debug('Device heartbeat failed (offline?):', err?.message)
    }
  }

  beat()
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
}

export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export function isDeviceOnline(device) {
  if (!device?.last_seen) return false
  return Date.now() - new Date(device.last_seen).getTime() < DEVICE_ONLINE_WINDOW_MS
}

/** All devices registered to the user (this PC included), newest-seen first. */
export async function getUserDevices(userId) {
  if (!userId) return []
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .order('last_seen', { ascending: false })
  if (error) {
    console.warn('getUserDevices failed:', error.message)
    return []
  }
  return data || []
}

export async function removeDevice(userId, deviceId) {
  if (!userId || !deviceId) return
  await supabase
    .from('user_devices')
    .delete()
    .eq('user_id', userId)
    .eq('device_id', deviceId)
  await supabase
    .from('device_game_installs')
    .delete()
    .eq('user_id', userId)
    .eq('device_id', deviceId)
}

/** Flip this device's streaming-host flags in the registry. */
export async function setDeviceStreamingFlags(userId, { hostEnabled, provisioned }) {
  if (!userId) return
  const deviceId = await getDeviceId()
  const update = {}
  if (hostEnabled !== undefined) update.streaming_host_enabled = !!hostEnabled
  if (provisioned !== undefined) update.sunshine_provisioned = !!provisioned
  if (Object.keys(update).length === 0) return
  await supabase
    .from('user_devices')
    .update(update)
    .eq('user_id', userId)
    .eq('device_id', deviceId)
}

// ─── Per-device install map ──────────────────────────────────────────────────

/**
 * Publish which games are installed on THIS device so other PCs can offer
 * "Stream from <this PC>". Diffed against the last-pushed snapshot (hash in
 * app_meta) so the common no-change case costs zero network writes.
 */
export async function pushInstallMap(userId, { force = false } = {}) {
  if (!userId || !isTauri) return

  try {
    const deviceId = await getDeviceId()
    const games = await getAllGames()
    const installedIds = [
      ...new Set(
        games
          .filter((g) => g.status === 'installed' && g.install_path)
          .map((g) => getCloudGameId(g)),
      ),
    ].sort()

    // Keyed by device id so an identity migration (random UUID → machine
    // GUID) re-publishes the map under the new id instead of no-op'ing.
    const hash = `${deviceId}:${installedIds.join('|')}`
    const lastHash = await getAppMeta(INSTALL_MAP_HASH_KEY)
    if (!force && hash === lastHash) return

    const now = new Date().toISOString()

    // Upsert current installs, then flip rows for games that are no longer
    // installed here (kept as installed=false so history stays cheap to diff).
    if (installedIds.length > 0) {
      const rows = installedIds.map((gameId) => ({
        user_id: userId,
        device_id: deviceId,
        game_id: gameId,
        installed: true,
        updated_at: now,
      }))
      const { error } = await supabase
        .from('device_game_installs')
        .upsert(rows, { onConflict: 'user_id,device_id,game_id' })
      if (error) throw error
    }

    const { error: clearError } = await supabase
      .from('device_game_installs')
      .update({ installed: false, updated_at: now })
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .eq('installed', true)
      .not('game_id', 'in', `(${installedIds.map((id) => `"${id}"`).join(',') || '""'})`)
    if (clearError) throw clearError

    await setAppMeta(INSTALL_MAP_HASH_KEY, hash)
  } catch (err) {
    console.warn('pushInstallMap failed:', err?.message ?? err)
  }
}

/**
 * Fetch stream sources for the whole library: a Map keyed by cloud game_id
 * whose values are online, provisioned host devices (excluding this PC)
 * that have the game installed.
 */
export async function getStreamSourceMap(userId) {
  const empty = new Map()
  if (!userId) return empty

  try {
    const deviceId = await getDeviceId()
    const [devices, { data: installs, error }] = await Promise.all([
      getUserDevices(userId),
      supabase
        .from('device_game_installs')
        .select('device_id, game_id, installed')
        .eq('user_id', userId)
        .eq('installed', true),
    ])
    if (error) throw error

    const hostById = new Map()
    for (const d of devices) {
      if (
        d.device_id !== deviceId &&
        d.streaming_host_enabled &&
        d.sunshine_provisioned &&
        isDeviceOnline(d)
      ) {
        hostById.set(d.device_id, d)
      }
    }
    if (hostById.size === 0) return empty

    const map = new Map()
    for (const row of installs || []) {
      const host = hostById.get(row.device_id)
      if (!host) continue
      if (!map.has(row.game_id)) map.set(row.game_id, [])
      map.get(row.game_id).push({
        deviceId: host.device_id,
        hostname: host.hostname || 'PC',
        lanIp: host.lan_ip || '',
      })
    }
    return map
  } catch (err) {
    console.warn('getStreamSourceMap failed:', err?.message ?? err)
    return empty
  }
}
