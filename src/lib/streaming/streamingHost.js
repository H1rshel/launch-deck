import { getAllGames, addSession, incrementPlaytime } from '../db'
import { getCloudGameId, queueSyncLocalToCloud } from '../cloudSync'
import { sunshineApi, getSunshineCreds } from './provision'

// Host-side streaming service: answers pair_request / prepare_stream /
// end_stream commands from the user's other PCs, manages Sunshine app
// entries, and records play sessions for streamed games so playtime lands
// in the library (and syncs to the cloud) exactly like local play.

const APP_NAME_PREFIX = 'LD: '

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke(cmd, args)
}

function exeNameFromPath(installPath) {
  return installPath?.replace(/\\/g, '/').split('/').pop() || ''
}

async function findLocalGameByCloudId(cloudGameId) {
  const games = await getAllGames()
  return (
    games.find((g) => getCloudGameId(g) === cloudGameId && g.status === 'installed') ||
    games.find((g) => getCloudGameId(g) === cloudGameId) ||
    null
  )
}

/**
 * Makes sure Sunshine has an app entry for the game and returns its name.
 * The entry's cmd is the game exe directly: Sunshine ties the stream lifetime
 * to that process (client quits → game terminated; game exits → stream ends).
 *
 * The entry is named after the GAME TITLE — mobile Moonlight clients show
 * these names directly, so "Cyberpunk 2077" beats "LD: steam_1091500".
 * Legacy "LD: <id>" entries are migrated in place.
 */
export async function ensureSunshineApp(game) {
  const appName =
    (game.normalized_title || game.title || '').trim() ||
    APP_NAME_PREFIX + getCloudGameId(game)
  const legacyName = APP_NAME_PREFIX + getCloudGameId(game)

  const current = await sunshineApi('GET', '/api/apps')
  const apps = current?.apps || []
  const existing =
    apps.find((a) => a?.name === appName) || apps.find((a) => a?.name === legacyName)
  if (existing && existing.name === appName && existing.cmd === game.install_path) return appName

  const dir = game.install_path.replace(/\\[^\\]+$/, '')
  await sunshineApi('POST', '/api/apps', {
    name: appName,
    index: typeof existing?.index === 'number' ? existing.index : -1,
    cmd: game.install_path,
    'working-dir': dir,
    'auto-detach': true,
    'wait-all': true,
    'exit-timeout': 5,
    elevated: false,
    'exclude-global-prep-cmd': false,
    'image-path': '',
    'prep-cmd': [],
    detached: [],
  })

  return appName
}

// One tracker per game at a time
const activeTrackers = new Set()

/**
 * Records the streamed play session on the host by watching the game process:
 * wait for it to appear (Sunshine launches it when the client connects), then
 * poll until it's gone and persist session + playtime.
 */
function trackStreamedSession(game, userId) {
  const exeName = exeNameFromPath(game.install_path)
  if (!exeName || activeTrackers.has(game.id)) return
  activeTrackers.add(game.id)

  const APPEAR_TIMEOUT_MS = 3 * 60 * 1000
  const POLL_MS = 10_000
  const MAX_SESSION_MS = 8 * 60 * 60 * 1000

  ;(async () => {
    try {
      // Phase 1 — wait for Sunshine to actually start the game
      const appearDeadline = Date.now() + APPEAR_TIMEOUT_MS
      let started = false
      while (Date.now() < appearDeadline) {
        if (await invoke('check_process_running', { processName: exeName })) {
          started = true
          break
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
      if (!started) return

      const sessionStart = Date.now()

      // Phase 2 — poll until the game exits (or the safety net trips)
      while (Date.now() - sessionStart < MAX_SESSION_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS))
        const running = await invoke('check_process_running', { processName: exeName })
        if (!running) break
      }

      const sessionEnd = Date.now()
      const elapsedMins = Math.round((sessionEnd - sessionStart) / 60000)
      if (elapsedMins > 0) {
        await addSession(
          game.id,
          new Date(sessionStart).toISOString(),
          new Date(sessionEnd).toISOString(),
          elapsedMins,
        ).catch(() => {})
        await incrementPlaytime(game.id, elapsedMins).catch(() => {})
        if (userId) queueSyncLocalToCloud(userId)
      }
    } catch (err) {
      console.warn('Streamed session tracking failed:', err?.message ?? err)
    } finally {
      activeTrackers.delete(game.id)
    }
  })()
}

/**
 * Command handlers for the host side of streaming. Wired into the command
 * bus by StreamingContext.
 */
export function createHostHandlers({ userId, notify = () => {} }) {
  return {
    /**
     * Client started `moonlight pair <us>` with a PIN and needs it submitted
     * to Sunshine. Retry: the PIN can arrive before Moonlight's pair request
     * registers with Sunshine.
     */
    pair_request: async ({ pin, clientName }) => {
      if (!(await invoke('is_sunshine_installed'))) {
        const err = new Error('This PC is not set up as a streaming host yet')
        err.code = 'host_not_provisioned'
        throw err
      }

      const deadline = Date.now() + 60_000
      let lastError = null
      while (Date.now() < deadline) {
        try {
          const resp = await sunshineApi('POST', '/api/pin', {
            pin: String(pin),
            name: clientName || 'Launch Deck',
          })
          const ok = resp?.status === true || resp?.status === 'true'
          if (ok) return { paired: true }
          lastError = new Error('Sunshine rejected the pairing PIN')
        } catch (err) {
          lastError = err
          if (String(err?.message || '').includes('401')) {
            // Credentials drift — retrying won't help; tell both sides.
            notify({
              title: 'Streaming needs repair',
              message: 'The streaming service rejected Launch Deck’s credentials. Toggle streaming OFF and ON in Settings → Streaming to repair it.',
            })
            const authErr = new Error('The host’s streaming service needs repair — on the host PC, toggle streaming off and on in Settings → Streaming')
            authErr.code = 'host_auth'
            throw authErr
          }
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      throw lastError || new Error('Pairing timed out')
    },

    /**
     * Client wants to stream a game: verify it, ensure the Sunshine app
     * entry, start session tracking, and hand back the app name + address.
     */
    prepare_stream: async ({ gameId }) => {
      const installed = await invoke('is_sunshine_installed')
      const creds = await getSunshineCreds()
      if (!installed || !creds?.password) {
        notify({
          title: 'Streaming setup needed',
          message: 'Another PC tried to stream from this one. Enable streaming in Settings → Streaming.',
        })
        const err = new Error('This PC is not set up as a streaming host yet')
        err.code = 'host_not_provisioned'
        throw err
      }

      if (!(await invoke('is_sunshine_service_running'))) {
        const err = new Error('The streaming service is not running on the host — restart the host PC')
        err.code = 'sunshine_not_running'
        throw err
      }

      const game = await findLocalGameByCloudId(gameId)
      if (!game || game.status !== 'installed' || !game.install_path) {
        const err = new Error('That game is no longer installed on the host PC')
        err.code = 'game_not_installed'
        throw err
      }

      const exeExists = await invoke('path_exists', { path: game.install_path })
      if (!exeExists) {
        const err = new Error('The game files were not found on the host PC')
        err.code = 'game_missing'
        throw err
      }

      let appName
      try {
        appName = await ensureSunshineApp(game)
      } catch (err) {
        if (String(err?.message || '').includes('401')) {
          notify({
            title: 'Streaming needs repair',
            message: 'The streaming service rejected Launch Deck’s credentials. Toggle streaming OFF and ON in Settings → Streaming to repair it.',
          })
          const authErr = new Error('The host’s streaming service needs repair — on the host PC, toggle streaming off and on in Settings → Streaming')
          authErr.code = 'host_auth'
          throw authErr
        }
        throw err
      }
      trackStreamedSession(game, userId)

      const lanIp = await invoke('get_local_ip').catch(() => '')
      const hostname = await invoke('get_hostname').catch(() => 'PC')

      notify({
        title: 'Stream starting',
        message: `${game.normalized_title || game.title} is being streamed from this PC.`,
      })

      return { appName, lanIp, hostname }
    },

    /** Best-effort cleanup when the client cancels or ends a stream. */
    end_stream: async ({ gameId }) => {
      const game = await findLocalGameByCloudId(gameId)
      const exeName = exeNameFromPath(game?.install_path)
      if (exeName) {
        await invoke('kill_process_by_name', { processName: exeName }).catch(() => {})
      }
      return { ended: true }
    },
  }
}
