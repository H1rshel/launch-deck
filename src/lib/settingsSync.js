import { supabase } from './supabase'

// Syncs whitelisted preferences to the user_settings Supabase table so a new
// PC feels identical after login. Whole-document last-write-wins.
//
// Machine-specific settings (launchAtStartup, startMinimized, closeToTray,
// game folders, streaming quality) and OAuth access/refresh tokens are
// deliberately NOT synced.

// ld_setting_* keys (managed by useSettings)
export const SYNCED_SETTING_KEYS = [
  'startupMode',
  'animationsEnabled',
  'compactMode',
  'accentColor',
  'defaultSort',
  'confirmBeforeLaunch',
  'updateMode',
  'includeBetaUpdates',
]

// Raw localStorage keys (platform account identifiers — public IDs, plus the
// Steam Web API key the user entered; it lives only in the user's own
// RLS-protected row).
export const SYNCED_RAW_KEYS = [
  'steamId',
  'steamApiKey',
  'steamPersonaName',
  'steamAvatarUrl',
  'gogUserId',
  'gogUsername',
  'epicAccountId',
  'epicDisplayName',
  'ubisoftAccountId',
  'ubisoftUsername',
  'ubisoftAvatarUrl',
]

const SETTING_PREFIX = 'ld_setting_'
const SYNCED_AT_KEY = 'ld_settings_synced_at'
const PUSH_DEBOUNCE_MS = 2000

// Fired after a cloud pull rewrites localStorage so live UI can reload values.
export const SETTINGS_UPDATED_EVENT = 'ld-settings-updated'

let tableAvailable = null
let pushTimer = null
let currentUserId = null

function isTableMissing(error) {
  return error?.code === '42P01' || error?.code === 'PGRST205'
}

function collectLocalSettings() {
  const doc = {}
  for (const key of SYNCED_SETTING_KEYS) {
    const raw = localStorage.getItem(SETTING_PREFIX + key)
    if (raw !== null) {
      try {
        doc[key] = JSON.parse(raw)
      } catch { /* skip malformed */ }
    }
  }
  const rawValues = {}
  for (const key of SYNCED_RAW_KEYS) {
    const value = localStorage.getItem(key)
    if (value !== null && value !== '') rawValues[key] = value
  }
  if (Object.keys(rawValues).length > 0) doc.__raw = rawValues
  return doc
}

function applyCloudSettings(doc) {
  let changed = false

  for (const key of SYNCED_SETTING_KEYS) {
    if (!(key in doc)) continue
    const serialized = JSON.stringify(doc[key])
    if (localStorage.getItem(SETTING_PREFIX + key) !== serialized) {
      localStorage.setItem(SETTING_PREFIX + key, serialized)
      changed = true
    }
  }

  const rawValues = doc.__raw || {}
  for (const key of SYNCED_RAW_KEYS) {
    if (!(key in rawValues)) continue
    if (localStorage.getItem(key) !== rawValues[key]) {
      localStorage.setItem(key, rawValues[key])
      changed = true
    }
  }

  if (changed) {
    window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT))
  }
  return changed
}

/**
 * Pull cloud settings on login. Applies them only when the cloud document is
 * newer than the last state this PC saw; otherwise pushes local state up so
 * the cloud row exists.
 */
export async function pullSettings(userId) {
  if (!userId || tableAvailable === false) return
  currentUserId = userId

  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('settings, updated_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) {
      if (isTableMissing(error)) {
        tableAvailable = false
        console.warn('user_settings table missing — settings will not sync across PCs until the Supabase migration is applied.')
        return
      }
      throw error
    }
    tableAvailable = true

    if (!data) {
      // First device to sync — seed the cloud row from local state.
      await pushSettingsNow(userId)
      return
    }

    const lastSyncedAt = localStorage.getItem(SYNCED_AT_KEY) || ''
    if (data.updated_at && data.updated_at > lastSyncedAt) {
      applyCloudSettings(data.settings || {})
      localStorage.setItem(SYNCED_AT_KEY, data.updated_at)
    } else {
      // Local is same-or-newer — make sure the cloud reflects it.
      await pushSettingsNow(userId)
    }
  } catch (err) {
    console.warn('pullSettings failed:', err?.message ?? err)
  }
}

export async function pushSettingsNow(userId = currentUserId) {
  if (!userId || tableAvailable === false) return
  try {
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('user_settings')
      .upsert(
        { user_id: userId, settings: collectLocalSettings(), updated_at: now },
        { onConflict: 'user_id' },
      )
    if (error) {
      if (isTableMissing(error)) {
        tableAvailable = false
        return
      }
      throw error
    }
    tableAvailable = true
    localStorage.setItem(SYNCED_AT_KEY, now)
  } catch (err) {
    console.warn('pushSettings failed:', err?.message ?? err)
  }
}

/** Debounced push — call after any synced key changes. */
export function queueSettingsPush(userId = currentUserId) {
  if (!userId) return
  currentUserId = userId
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    pushSettingsNow(userId)
  }, PUSH_DEBOUNCE_MS)
}

export function isSyncedSettingKey(key) {
  return SYNCED_SETTING_KEYS.includes(key)
}
