import { getAppMeta, setAppMeta } from '../db'
import { getCloudGameId } from '../cloudSync'
import { getDeviceId } from '../devices'
import { sendCommand } from './commandBus'
import { ensureMoonlightClient } from './provision'

// Client-side streaming: fully automated pairing (PIN relayed to the host
// over the command bus) and one-click stream launch via the Moonlight CLI.

const PAIRED_HOSTS_KEY = 'paired_hosts'

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke(cmd, args)
}

async function getPairedHosts() {
  try {
    return JSON.parse((await getAppMeta(PAIRED_HOSTS_KEY)) || '[]')
  } catch {
    return []
  }
}

async function markHostPaired(deviceId) {
  const hosts = await getPairedHosts()
  if (!hosts.includes(deviceId)) {
    hosts.push(deviceId)
    await setAppMeta(PAIRED_HOSTS_KEY, JSON.stringify(hosts))
  }
}

/**
 * Launches Moonlight with args and resolves with its exit code.
 * `onLaunched` fires after the process spawns.
 */
async function runMoonlight(exePath, args, { timeoutMs = 0, onLaunched } = {}) {
  const { listen } = await import('@tauri-apps/api/event')
  const sessionId = crypto.randomUUID()

  return new Promise((resolve, reject) => {
    let timeoutTimer = null
    let unlisten = null

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (unlisten) unlisten()
    }

    listen('moonlight_exited', (event) => {
      if (event.payload?.session_id !== sessionId) return
      cleanup()
      resolve(event.payload.code)
    }).then((fn) => {
      unlisten = fn
      return invoke('launch_moonlight', { exePath, args, sessionId })
    }).then(() => {
      onLaunched?.()
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(async () => {
          cleanup()
          await invoke('kill_process_by_name', { processName: 'Moonlight.exe' }).catch(() => {})
          const err = new Error('Moonlight timed out')
          err.code = 'moonlight_timeout'
          reject(err)
        }, timeoutMs)
      }
    }).catch((err) => {
      cleanup()
      reject(err)
    })
  })
}

/**
 * Zero-touch pairing with a host device:
 *  1. generate a PIN
 *  2. send it to the host over the command bus (host POSTs it to Sunshine)
 *  3. run `moonlight pair <host> --pin <PIN>`
 * Moonlight's exit code 0 is the source of truth for success.
 */
export async function ensurePairedWithHost(userId, host, { onPhase = () => {} } = {}) {
  const paired = await getPairedHosts()
  if (paired.includes(host.deviceId)) return

  if (!host.lanIp) {
    const err = new Error('The host PC has no reachable address yet — try again in a minute')
    err.code = 'no_host_ip'
    throw err
  }

  onPhase('pairing')
  const pin = String(Math.floor(1000 + Math.random() * 9000))
  const exePath = await ensureMoonlightClient()
  const myDeviceId = await getDeviceId()

  const hostname = await invoke('get_hostname').catch(() => 'Launch Deck')

  // Fire the PIN at the host but don't await — the host retries /api/pin
  // until Moonlight's pair request registers with Sunshine.
  const hostAck = sendCommand(
    userId,
    myDeviceId,
    host.deviceId,
    'pair_request',
    { pin, clientName: hostname },
    { timeoutMs: 90_000 },
  ).catch((err) => {
    console.warn('pair_request command failed:', err?.message)
    return null
  })

  const code = await runMoonlight(exePath, ['pair', host.lanIp, '--pin', pin], {
    timeoutMs: 90_000,
  })

  if (code !== 0) {
    await hostAck // surface a more specific host error if there is one
    const err = new Error('Pairing with the host PC failed')
    err.code = 'pair_failed'
    throw err
  }

  await markHostPaired(host.deviceId)
}

function getQualityArgs() {
  const read = (key, fallback) => {
    try {
      const raw = localStorage.getItem(`ld_setting_${key}`)
      return raw === null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  const resolution = read('streamResolution', '1920x1080')
  const fps = read('streamFps', 60)
  const bitrate = read('streamBitrate', 'auto')

  const args = ['--resolution', String(resolution), '--fps', String(fps)]
  if (bitrate !== 'auto' && Number(bitrate) > 0) {
    args.push('--bitrate', String(Number(bitrate) * 1000)) // Mbps → Kbps
  }
  return args
}

/**
 * End-to-end stream flow. `onPhase` receives:
 * 'provisioning' | 'pairing' | 'preparing' | 'streaming'.
 * Resolves when the Moonlight session ends.
 */
export async function streamGame(userId, game, host, { onPhase = () => {} } = {}) {
  const myDeviceId = await getDeviceId()
  if (host.deviceId === myDeviceId) {
    throw new Error('This game is installed on this PC — launch it directly')
  }

  onPhase('provisioning')
  const exePath = await ensureMoonlightClient((p) => {
    if (p.step === 'downloading') onPhase('provisioning', p.percent)
  })

  await ensurePairedWithHost(userId, host, { onPhase })

  onPhase('preparing')
  const cloudGameId = getCloudGameId(game)
  const prep = await sendCommand(
    userId,
    myDeviceId,
    host.deviceId,
    'prepare_stream',
    { gameId: cloudGameId },
    { timeoutMs: 45_000 },
  )

  const address = prep.lanIp || host.lanIp
  if (!address) {
    const err = new Error('Could not determine the host PC address')
    err.code = 'no_host_ip'
    throw err
  }

  onPhase('streaming')
  const args = [
    'stream',
    address,
    prep.appName,
    '--quit-after',
    '--display-mode',
    'fullscreen',
    ...getQualityArgs(),
  ]

  const code = await runMoonlight(exePath, args)

  // Non-zero exit usually means the connection dropped or the user closed
  // Moonlight mid-handshake; the host cleans the game up via --quit-after
  // semantics, but nudge it anyway on abnormal exits.
  if (code !== 0) {
    sendCommand(
      userId,
      myDeviceId,
      host.deviceId,
      'end_stream',
      { gameId: cloudGameId },
      { timeoutMs: 15_000 },
    ).catch(() => {})
  }

  return { exitCode: code }
}

/** Cancels an in-progress stream by killing the local Moonlight process. */
export async function cancelStream(userId, game, host) {
  await invoke('kill_process_by_name', { processName: 'Moonlight.exe' }).catch(() => {})
  if (userId && game && host) {
    const myDeviceId = await getDeviceId()
    sendCommand(
      userId,
      myDeviceId,
      host.deviceId,
      'end_stream',
      { gameId: getCloudGameId(game) },
      { timeoutMs: 15_000 },
    ).catch(() => {})
  }
}
