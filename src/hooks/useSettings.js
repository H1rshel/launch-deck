import { useState, useEffect, useCallback } from 'react'

const PREFIX = 'ld_setting_'

const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

// Push the close-to-tray preference down to the Rust window-close handler.
function syncCloseToTray(enabled) {
  if (!isTauri) return
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('set_close_to_tray', { enabled: !!enabled }))
    .catch(() => {})
}

export const SETTING_DEFAULTS = {
  startupMode: 'normal',
  launchAtStartup: false,
  startMinimized: false,
  animationsEnabled: true,
  closeToTray: false,
  compactMode: false,
  accentColor: 'cyan',
  defaultSort: 'name',
  confirmBeforeLaunch: false,
  updateMode: 'notify_only',
  includeBetaUpdates: false,
  lastUpdateCheckAt: null,
}

export function readSetting(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return SETTING_DEFAULTS[key]
    return JSON.parse(raw)
  } catch {
    return SETTING_DEFAULTS[key]
  }
}

const ACCENT_COLORS = {
  cyan:   '#00d4ff',
  blue:   '#3b82f6',
  indigo: '#6366f1',
  purple: '#7b2ff7',
  pink:   '#ec4899',
  rose:   '#f43f5e',
  orange: '#f97316',
  amber:  '#f5a623',
  lime:   '#a3e635',
  green:  '#22c55e',
  teal:   '#14b8a6',
}

function applyEffects(settings) {
  const root = document.documentElement
  root.classList.toggle('no-animations', !settings.animationsEnabled)
  root.classList.toggle('compact-mode', !!settings.compactMode)
  // Custom hex (from the colour-picker input) starts with '#'; preset keys do not
  const color = settings.accentColor?.startsWith('#')
    ? settings.accentColor
    : (ACCENT_COLORS[settings.accentColor] ?? ACCENT_COLORS.cyan)
  root.style.setProperty('--accent-cyan', color)
}

function loadAll() {
  // NOTE: a previous build force-re-enabled animations on every launch, which
  // overrode the user's choice and made the "Animations" performance toggle
  // useless. The user's saved preference is now respected as-is.
  const out = {}
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    out[key] = readSetting(key)
  }
  return out
}

export function useSettings() {
  const [settings, setSettings] = useState(() => {
    const initial = loadAll()
    if (typeof document !== 'undefined') applyEffects(initial)
    return initial
  })

  useEffect(() => {
    applyEffects(settings)
  }, [settings])

  // Keep the native close-to-tray handler in sync (also restores it on startup).
  useEffect(() => {
    syncCloseToTray(settings.closeToTray)
  }, [settings.closeToTray])

  const setSetting = useCallback((key, value) => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {}
    setSettings(prev => ({ ...prev, [key]: value }))
  }, [])

  return { settings, setSetting }
}
