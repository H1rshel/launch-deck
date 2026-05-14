import { useState, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "react-router-dom"
import { invoke } from "@tauri-apps/api/core"
import {
  UPDATE_MODES,
  getCurrentAppVersion,
  isUpdaterAvailable,
  checkForUpdates,
  downloadAndInstallUpdate,
  relaunchApp,
} from "../services/updateService"
import { clearUpdateBanner } from "../services/updateState"
import TopBar from "../components/layout/TopBar"
import PageHeader from "../components/layout/PageHeader"
import { useAuth } from "../hooks/useAuth"
import { useScanner } from "../hooks/useScanner"
import { useSettingsContext } from "../context/SettingsContext"
import { useNotifications } from "../context/NotificationContext"
import ScanResultsModal from "../components/games/ScanResultsModal"
import AddSingleGameModal from "../components/games/AddSingleGameModal"
import { Select } from "../components/ui/Select"
import {
  Monitor,
  Palette,
  Library,
  Pipette,
  FolderSearch,
  Plus,
  Trash2,
  Loader,
  Sparkles,
  PackagePlus,
  ExternalLink,
  X,
  CheckCircle2,
  Gamepad2,
  LogOut,
  Settings as SettingsIcon,
  RefreshCcw,
  Download,
  RotateCcw,
  Zap,
  Circle,
  CheckCircle,
} from "lucide-react"
import SteamIconSolid from "../components/icons/SteamIconSolid"
import GogIcon from "../components/icons/GogIcon"
import EpicIcon from "../components/icons/EpicIcon"
import UbisoftIcon from "../components/icons/UbisoftIcon"

const UBISOFT_AVATAR_APP_ID = "f68a4bb5-608a-4ff2-8123-be8ef797e0a6"

function getUbisoftAvatarCandidates(accountId, avatarUrl = "") {
  const id = String(accountId || "").trim()
  const urls = [
    avatarUrl,
    id ? `https://ubisoft-avatars.akamaized.net/${id}/default_256_256.png` : "",
    id ? `https://ubisoft-avatars.akamaized.net/${id}/default_146_146.png` : "",
    id
      ? `https://ubisoft-avatars.akamaized.net/${id}/default_256_256.png?appId=${UBISOFT_AVATAR_APP_ID}`
      : "",
    id
      ? `https://ubisoft-avatars.akamaized.net/${id}/default_146_146.png?appId=${UBISOFT_AVATAR_APP_ID}`
      : "",
  ].filter(Boolean)

  return [...new Set(urls)]
}

function WiredToggle({ settingKey, label, description }) {
  const { settings, setSetting } = useSettingsContext()
  const checked = !!settings[settingKey]
  return (
    <div className="setting-row">
      <div className="setting-row__info">
        <span className="setting-row__label">{label}</span>
        {description && <span className="setting-row__desc">{description}</span>}
      </div>
      <button
        className={`setting-toggle ${checked ? "setting-toggle--on" : ""}`}
        onClick={() => setSetting(settingKey, !checked)}
      >
        <span className="setting-toggle__knob" />
      </button>
    </div>
  )
}

const ACCENT_OPTIONS = [
  { key: "cyan",   color: "#00d4ff", label: "Cyan",   isDefault: true },
  { key: "blue",   color: "#3b82f6", label: "Blue" },
  { key: "indigo", color: "#6366f1", label: "Indigo" },
  { key: "purple", color: "#7b2ff7", label: "Purple" },
  { key: "pink",   color: "#ec4899", label: "Pink" },
  { key: "rose",   color: "#f43f5e", label: "Rose" },
  { key: "orange", color: "#f97316", label: "Orange" },
  { key: "amber",  color: "#f5a623", label: "Amber" },
  { key: "lime",   color: "#a3e635", label: "Lime" },
  { key: "green",  color: "#22c55e", label: "Green" },
  { key: "teal",   color: "#14b8a6", label: "Teal" },
]

function AccentColorPicker() {
  const { settings, setSetting } = useSettingsContext()
  const isCustom = typeof settings.accentColor === "string" &&
    settings.accentColor.startsWith("#")
  const customHex = isCustom ? settings.accentColor : "#00d4ff"

  return (
    <div className="setting-row setting-row--block">
      <div className="setting-row__info">
        <span className="setting-row__label">Accent color</span>
        <span className="setting-row__desc">
          Primary highlight used across buttons, active states, and UI accents
        </span>
      </div>
      <div className="setting-accent-picker">
        {ACCENT_OPTIONS.map(({ key, color, label, isDefault }) => (
          <button
            key={key}
            className={[
              "setting-accent-swatch",
              settings.accentColor === key ? "setting-accent-swatch--active" : "",
              isDefault ? "setting-accent-swatch--default" : "",
            ].join(" ")}
            style={{ "--swatch-color": color }}
            onClick={() => setSetting("accentColor", key)}
            title={isDefault ? `${label} — default` : label}
          />
        ))}
        <label
          className={[
            "setting-accent-swatch",
            "setting-accent-swatch--custom",
            isCustom ? "setting-accent-swatch--active" : "",
          ].join(" ")}
          style={isCustom ? { "--swatch-color": customHex } : {}}
          title={isCustom ? `Custom: ${customHex}` : "Custom color"}
        >
          <input
            type="color"
            className="setting-accent-custom-input"
            value={customHex}
            onChange={(e) => setSetting("accentColor", e.target.value)}
          />
          {!isCustom && <Pipette size={11} className="setting-accent-custom-icon" />}
        </label>
      </div>
    </div>
  )
}

function StartupModeRow() {
  const { settings, setSetting } = useSettingsContext()
  return (
    <div className="setting-row">
      <div className="setting-row__info">
        <span className="setting-row__label">Startup mode</span>
        <span className="setting-row__desc">
          How Launch Deck opens each time you launch it
        </span>
      </div>
      <div className="setting-segmented">
        <button
          className={`setting-segmented__btn ${settings.startupMode === "normal" ? "setting-segmented__btn--active" : ""}`}
          onClick={() => setSetting("startupMode", "normal")}
        >
          <Monitor size={13} />
          Normal
        </button>
        <button
          className={`setting-segmented__btn ${settings.startupMode === "console" ? "setting-segmented__btn--active" : ""}`}
          onClick={() => setSetting("startupMode", "console")}
        >
          <Gamepad2 size={13} />
          Console
        </button>
      </div>
    </div>
  )
}

const SORT_OPTIONS = [
  { value: "name",    label: "Name (A–Z)" },
  { value: "recent",  label: "Recently Played" },
  { value: "rating",  label: "Rating" },
  { value: "release", label: "Release Date" },
]

function DefaultSortRow() {
  const { settings, setSetting } = useSettingsContext()
  return (
    <div className="setting-row">
      <div className="setting-row__info">
        <span className="setting-row__label">Default sort order</span>
        <span className="setting-row__desc">
          How your library is sorted when you open it
        </span>
      </div>
      <Select
        value={settings.defaultSort}
        onChange={(val) => setSetting("defaultSort", val)}
        options={SORT_OPTIONS}
      />
    </div>
  )
}

function SteamConnectingOverlay({ onCancel }) {
  return (
    <div className="steam-overlay__backdrop">
      <div className="steam-overlay">
        <button
          className="steam-overlay__close"
          onClick={onCancel}
          title="Cancel"
        >
          <X size={16} />
        </button>
        <div className="steam-overlay__icon-wrap">
          <SteamIconSolid className="steam-overlay__icon" />
          <span className="steam-overlay__pulse" />
        </div>
        <h3 className="steam-overlay__title">Complete Steam login</h3>
        <p className="steam-overlay__subtitle">
          A browser window has opened. Follow the steps below:
        </p>
        <ol className="steam-overlay__steps">
          <li className="steam-overlay__step">
            <span className="steam-overlay__step-num">1</span>
            <span>
              Sign in with your Steam credentials in the browser window that
              just opened
            </span>
            <ExternalLink size={13} className="steam-overlay__step-ext" />
          </li>
          <li className="steam-overlay__step">
            <span className="steam-overlay__step-num">2</span>
            <span>Once logged in, Steam will redirect automatically</span>
          </li>
          <li className="steam-overlay__step">
            <span className="steam-overlay__step-num">3</span>
            <span>
              Launch Deck will detect the login and connect your account
            </span>
          </li>
        </ol>
        <div className="steam-overlay__waiting">
          <Loader size={14} className="settings__spinner" />
          <span>Waiting for Steam…</span>
        </div>
      </div>
    </div>
  )
}

function SteamPlatformRow() {
  const [profile, setProfile] = useState(() => {
    const id = localStorage.getItem("steamId")
    if (!id) return null
    return {
      steamId: id,
      personaName: localStorage.getItem("steamPersonaName") || "",
      avatarUrl: localStorage.getItem("steamAvatarUrl") || "",
    }
  })
  const [connecting, setConnecting] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  const [error, setError] = useState(null)
  const cancelRef = useState(() => ({ current: false }))[0]

  useEffect(() => {
    if (!justConnected) return
    const t = setTimeout(() => setJustConnected(false), 2000)
    return () => clearTimeout(t)
  }, [justConnected])

  async function handleConnect() {
    cancelRef.current = false
    setConnecting(true)
    setError(null)
    try {
      const result = await invoke("connect_steam")
      if (!cancelRef.current) {
        localStorage.setItem("steamId", result.steamId)
        localStorage.setItem("steamPersonaName", result.personaName)
        localStorage.setItem("steamAvatarUrl", result.avatarUrl)
        setProfile(result)
        setJustConnected(true)
      }
    } catch (err) {
      if (!cancelRef.current) {
        setError(
          typeof err === "string"
            ? err
            : "Connection failed. Please try again.",
        )
      }
    } finally {
      setConnecting(false)
    }
  }

  function handleCancel() {
    cancelRef.current = true
    setConnecting(false)
  }

  function handleDisconnect() {
    localStorage.removeItem("steamId")
    localStorage.removeItem("steamPersonaName")
    localStorage.removeItem("steamAvatarUrl")
    setProfile(null)
    setError(null)
    setJustConnected(false)
  }

  return (
    <>
      {connecting && <SteamConnectingOverlay onCancel={handleCancel} />}
      <div className="settings__platform-row">
        <div className="settings__platform-row__logo">
          <SteamIconSolid className="settings__platform-logo-icon settings__platform-logo-icon--steam" />
        </div>
        <div className="settings__platform-row__info">
          <span className="settings__platform-row__name">Steam</span>
          {!profile && (
            <span className="settings__platform-row__desc">
              Opens Steam login in your browser
            </span>
          )}
        </div>
        <div className="settings__platform-row__action">
          {justConnected && (
            <span className="settings__platform-success">
              <CheckCircle2 size={13} /> Connected
            </span>
          )}
          {profile ? (
            <div className="settings__platform-connected">
              {profile.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt=""
                  className="settings__platform-avatar"
                />
              ) : (
                <div className="settings__platform-avatar settings__platform-avatar--placeholder">
                  <SteamIconSolid className="settings__platform-avatar-icon" />
                </div>
              )}
              <span className="settings__platform-username">
                {profile.personaName || "Steam User"}
              </span>
              <button
                className="settings__platform-disconnect"
                onClick={handleDisconnect}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              className="settings__platform-btn settings__platform-btn--steam"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? (
                <Loader size={14} className="settings__spinner" />
              ) : (
                <SteamIconSolid className="settings__platform-btn-icon" />
              )}
              {connecting ? "Connecting…" : "Connect Steam"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="settings__platform-error">{error}</p>}
    </>
  )
}

function GogPlatformRow() {
  const [profile, setProfile] = useState(() => {
    const id = localStorage.getItem("gogUserId")
    if (!id) return null
    return { userId: id, username: localStorage.getItem("gogUsername") || "" }
  })
  const [connecting, setConnecting] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!justConnected) return
    const t = setTimeout(() => setJustConnected(false), 2000)
    return () => clearTimeout(t)
  }, [justConnected])

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    try {
      const result = await invoke("connect_gog")
      localStorage.setItem("gogUserId", result.userId)
      localStorage.setItem("gogUsername", result.username)
      localStorage.setItem("gogAccessToken", result.accessToken)
      localStorage.setItem("gogRefreshToken", result.refreshToken)
      setProfile({ userId: result.userId, username: result.username })
      setJustConnected(true)
    } catch (err) {
      setError(
        typeof err === "string" ? err : "Connection failed. Please try again.",
      )
    } finally {
      setConnecting(false)
    }
  }

  function handleDisconnect() {
    localStorage.removeItem("gogUserId")
    localStorage.removeItem("gogUsername")
    localStorage.removeItem("gogAccessToken")
    localStorage.removeItem("gogRefreshToken")
    setProfile(null)
    setError(null)
    setJustConnected(false)
  }

  return (
    <>
      <div className="settings__platform-row">
        <div className="settings__platform-row__logo">
          <GogIcon className="settings__platform-logo-icon settings__platform-logo-icon--gog" />
        </div>
        <div className="settings__platform-row__info">
          <span className="settings__platform-row__name">GOG</span>
          {!profile && (
            <span className="settings__platform-row__desc">
              Imports your GOG library including uninstalled games
            </span>
          )}
        </div>
        <div className="settings__platform-row__action">
          {justConnected && (
            <span className="settings__platform-success">
              <CheckCircle2 size={13} /> Connected
            </span>
          )}
          {profile ? (
            <div className="settings__platform-connected">
              <div className="settings__platform-avatar settings__platform-avatar--placeholder settings__platform-avatar--gog">
                <GogIcon className="settings__platform-avatar-icon" />
              </div>
              <span className="settings__platform-username">
                {profile.username || "GOG User"}
              </span>
              <button
                className="settings__platform-disconnect"
                onClick={handleDisconnect}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              className="settings__platform-btn settings__platform-btn--gog"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? (
                <Loader size={14} className="settings__spinner" />
              ) : (
                <GogIcon className="settings__platform-btn-icon" />
              )}
              {connecting ? "Connecting…" : "Connect GOG"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="settings__platform-error">{error}</p>}
    </>
  )
}

function EpicPlatformRow() {
  const [profile, setProfile] = useState(() => {
    const id = localStorage.getItem("epicAccountId")
    if (!id) return null
    return {
      accountId: id,
      displayName: localStorage.getItem("epicDisplayName") || "",
    }
  })
  const [connecting, setConnecting] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!justConnected) return
    const t = setTimeout(() => setJustConnected(false), 2000)
    return () => clearTimeout(t)
  }, [justConnected])

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    try {
      const result = await invoke("connect_epic")
      localStorage.setItem("epicAccountId", result.accountId)
      localStorage.setItem("epicDisplayName", result.displayName)
      localStorage.setItem("epicAccessToken", result.accessToken)
      localStorage.setItem("epicRefreshToken", result.refreshToken)
      setProfile({
        accountId: result.accountId,
        displayName: result.displayName,
      })
      setJustConnected(true)
    } catch (err) {
      setError(
        typeof err === "string" ? err : "Connection failed. Please try again.",
      )
    } finally {
      setConnecting(false)
    }
  }

  function handleDisconnect() {
    localStorage.removeItem("epicAccountId")
    localStorage.removeItem("epicDisplayName")
    localStorage.removeItem("epicAccessToken")
    localStorage.removeItem("epicRefreshToken")
    setProfile(null)
    setError(null)
    setJustConnected(false)
  }

  return (
    <>
      <div className="settings__platform-row">
        <div className="settings__platform-row__logo">
          <EpicIcon className="settings__platform-logo-icon settings__platform-logo-icon--epic" />
        </div>
        <div className="settings__platform-row__info">
          <span className="settings__platform-row__name">Epic Games</span>
          {!profile && (
            <span className="settings__platform-row__desc">
              Imports your Epic Games library including uninstalled games
            </span>
          )}
        </div>
        <div className="settings__platform-row__action">
          {justConnected && (
            <span className="settings__platform-success">
              <CheckCircle2 size={13} /> Connected
            </span>
          )}
          {profile ? (
            <div className="settings__platform-connected">
              <div className="settings__platform-avatar settings__platform-avatar--placeholder settings__platform-avatar--epic">
                <EpicIcon className="settings__platform-avatar-icon" />
              </div>
              <span className="settings__platform-username">
                {profile.displayName || "Epic User"}
              </span>
              <button
                className="settings__platform-disconnect"
                onClick={handleDisconnect}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              className="settings__platform-btn settings__platform-btn--epic"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? (
                <Loader size={14} className="settings__spinner" />
              ) : (
                <EpicIcon className="settings__platform-btn-icon" />
              )}
              {connecting ? "Connecting…" : "Connect Epic"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="settings__platform-error">{error}</p>}
    </>
  )
}

function UbisoftPlatformRow() {
  const [profile, setProfile] = useState(() => {
    const id = localStorage.getItem("ubisoftAccountId")
    if (!id) return null
    return {
      accountId: id,
      username: localStorage.getItem("ubisoftUsername") || "",
      avatarUrl: localStorage.getItem("ubisoftAvatarUrl") || "",
    }
  })
  const [connecting, setConnecting] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  const [error, setError] = useState(null)
  const [avatarIndex, setAvatarIndex] = useState(0)

  const avatarCandidates = profile
    ? getUbisoftAvatarCandidates(profile.accountId, profile.avatarUrl)
    : []

  useEffect(() => {
    setAvatarIndex(0)
  }, [profile?.accountId, profile?.avatarUrl])

  useEffect(() => {
    if (!justConnected) return
    const t = setTimeout(() => setJustConnected(false), 2000)
    return () => clearTimeout(t)
  }, [justConnected])

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    try {
      const result = await invoke("connect_ubisoft")
      const resolvedAvatarUrl =
        result.avatarUrl ||
        getUbisoftAvatarCandidates(result.accountId)[0] ||
        ""
      localStorage.setItem("ubisoftAccountId", result.accountId)
      localStorage.setItem("ubisoftUsername", result.username)
      localStorage.setItem("ubisoftAvatarUrl", resolvedAvatarUrl)
      localStorage.setItem("ubisoftAccessToken", result.accessToken)
      localStorage.setItem("ubisoftRefreshToken", result.refreshToken)
      localStorage.setItem("ubisoftSessionId", result.sessionId || "")
      setProfile({
        accountId: result.accountId,
        username: result.username,
        avatarUrl: resolvedAvatarUrl,
      })
      setJustConnected(true)
    } catch (err) {
      setError(
        typeof err === "string" ? err : "Connection failed. Please try again.",
      )
    } finally {
      setConnecting(false)
    }
  }

  function handleDisconnect() {
    localStorage.removeItem("ubisoftAccountId")
    localStorage.removeItem("ubisoftUsername")
    localStorage.removeItem("ubisoftAvatarUrl")
    localStorage.removeItem("ubisoftAccessToken")
    localStorage.removeItem("ubisoftRefreshToken")
    localStorage.removeItem("ubisoftSessionId")
    setProfile(null)
    setError(null)
    setJustConnected(false)
  }

  return (
    <>
      <div className="settings__platform-row">
        <div className="settings__platform-row__logo">
          <UbisoftIcon className="settings__platform-logo-icon settings__platform-logo-icon--ubisoft" />
        </div>
        <div className="settings__platform-row__info">
          <span className="settings__platform-row__name">Ubisoft Connect</span>
          {!profile && (
            <span className="settings__platform-row__desc">
              Imports your Ubisoft Connect library including uninstalled games
            </span>
          )}
        </div>
        <div className="settings__platform-row__action">
          {justConnected && (
            <span className="settings__platform-success">
              <CheckCircle2 size={13} /> Connected
            </span>
          )}
          {profile ? (
            <div className="settings__platform-connected">
              {avatarCandidates[avatarIndex] ? (
                <img
                  src={avatarCandidates[avatarIndex]}
                  alt=""
                  className="settings__platform-avatar"
                  onError={() => setAvatarIndex((current) => current + 1)}
                />
              ) : (
                <div className="settings__platform-avatar settings__platform-avatar--placeholder settings__platform-avatar--ubisoft">
                  <UbisoftIcon className="settings__platform-avatar-icon" />
                </div>
              )}
              <span className="settings__platform-username">
                {profile.username || "Ubisoft User"}
              </span>
              <button
                className="settings__platform-disconnect"
                onClick={handleDisconnect}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              className="settings__platform-btn settings__platform-btn--ubisoft"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? (
                <Loader size={14} className="settings__spinner" />
              ) : (
                <UbisoftIcon className="settings__platform-btn-icon" />
              )}
              {connecting ? "Connecting…" : "Connect Ubisoft"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="settings__platform-error">{error}</p>}
    </>
  )
}

function PlatformAccountsSection() {
  return (
    <section className="settings__section settings__section--animated settings__section--glass">
      <div className="settings__section-header">
        <Gamepad2 size={20} className="settings__section-icon" />
        <div className="settings__section-header-text">
          <h2 className="settings__section-title">Platform Accounts</h2>
          <p className="settings__section-description">
            Link stores to import your full library, including uninstalled
            games.
          </p>
        </div>
      </div>
      <div className="settings__section-body">
        <div className="settings__platforms-list">
          <SteamPlatformRow />
          <GogPlatformRow />
          <EpicPlatformRow />
          <UbisoftPlatformRow />
        </div>
      </div>
    </section>
  )
}

const UPDATE_BEHAVIOR_OPTIONS = [
  {
    value: UPDATE_MODES.NOTIFY_ONLY,
    label: "Notify me when updates are available",
    desc: "Checks on startup, shows a banner — you choose when to update",
  },
  {
    value: UPDATE_MODES.AUTO_DOWNLOAD,
    label: "Download automatically, ask before restarting",
    desc: "Downloads in background, asks before relaunching",
  },
  {
    value: UPDATE_MODES.MANUAL_ONLY,
    label: "Manual checks only",
    desc: "Only checks when you click the button below",
  },
]

function UpdatesSection() {
  const { settings, setSetting } = useSettingsContext()
  const { addNotification } = useNotifications()
  const [version, setVersion] = useState(null)
  const [checkStatus, setCheckStatus] = useState(null)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const [updateReady, setUpdateReady] = useState(false)
  const updateRef = useRef(null)

  useEffect(() => {
    getCurrentAppVersion().then((v) => setVersion(v))
  }, [])

  const isChecking = checkStatus === "checking"
  const isDownloading = downloadProgress !== null && !updateReady
  const available = checkStatus?.status === "available"
  const notAvailable = checkStatus?.status === "not_available"
  const hasError = checkStatus?.status === "error"

  function formatDate(iso) {
    if (!iso) return null
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    } catch {
      return null
    }
  }

  async function handleCheck() {
    setCheckStatus("checking")
    setDownloadProgress(null)
    setUpdateReady(false)
    updateRef.current = null
    const result = await checkForUpdates()
    setCheckStatus(result)
    setSetting("lastUpdateCheckAt", new Date().toISOString())
    if (result.status === "available") {
      updateRef.current = result.update
      clearUpdateBanner()
      addNotification({
        title: `Launch Deck ${result.version} is available`,
        message: result.notes || "Open Updates to download and install it.",
        type: "info",
        route: "/settings",
        routeState: { scrollTo: "updates" },
        dedupeKey: `update-available-${result.version}`,
      })
    }
  }

  async function handleDownload() {
    if (!updateRef.current) return
    setDownloadProgress({ event: "Started", downloaded: 0, total: 0 })
    try {
      await downloadAndInstallUpdate(updateRef.current, (progress) => {
        setDownloadProgress(progress)
      })
      setUpdateReady(true)
    } catch (err) {
      setCheckStatus({ status: "error", message: err?.message ?? "Download failed." })
      setDownloadProgress(null)
    }
  }

  async function handleRestart() {
    await relaunchApp()
  }

  const pct =
    downloadProgress?.total > 0
      ? Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)
      : null

  return (
    <section
      className="settings__section settings__section--animated settings__section--glass"
      id="settings-updates"
      style={{ animationDelay: "320ms" }}
    >
      <div className="settings__section-header">
        <RefreshCcw size={20} className="settings__section-icon" />
        <div className="settings__section-header-text">
          <h2 className="settings__section-title">Updates</h2>
          <p className="settings__section-description">
            Keep Launch Deck up to date with the latest features and fixes.
          </p>
        </div>
      </div>
      <div className="settings__section-body">
        {/* Version + channel row */}
        <div className="setting-row">
          <div className="setting-row__info">
            <span className="setting-row__label">Current version</span>
            <span className="setting-row__desc">
              {version ? `v${version}` : "—"} · Channel: Stable
            </span>
          </div>
          {settings.lastUpdateCheckAt && (
            <span className="settings__update-last-checked">
              Last checked {formatDate(settings.lastUpdateCheckAt)}
            </span>
          )}
        </div>

        {/* Update behavior */}
        <div className="setting-row setting-row--block">
          <div className="setting-row__info">
            <span className="setting-row__label">Update behavior</span>
          </div>
          <div className="settings__update-mode-list">
            {UPDATE_BEHAVIOR_OPTIONS.map((opt) => {
              const active = settings.updateMode === opt.value
              return (
                <button
                  key={opt.value}
                  className={`settings__update-mode-item${active ? " settings__update-mode-item--active" : ""}`}
                  onClick={() => setSetting("updateMode", opt.value)}
                >
                  <span className="settings__update-mode-dot">
                    {active ? <CheckCircle size={14} /> : <Circle size={14} />}
                  </span>
                  <span className="settings__update-mode-text">
                    <span className="settings__update-mode-label">{opt.label}</span>
                    <span className="settings__update-mode-desc">{opt.desc}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Beta toggle */}
        <div className="setting-row">
          <div className="setting-row__info">
            <span className="setting-row__label">Include beta updates</span>
            <span className="setting-row__desc">
              Opt in to pre-release builds — may be unstable
            </span>
          </div>
          <button
            className={`setting-toggle ${settings.includeBetaUpdates ? "setting-toggle--on" : ""}`}
            onClick={() => setSetting("includeBetaUpdates", !settings.includeBetaUpdates)}
          >
            <span className="setting-toggle__knob" />
          </button>
        </div>

        {/* Status area */}
        {updateReady && (
          <div className="settings__update-card settings__update-card--ready">
            <div className="settings__update-card__header">
              <Zap size={15} className="settings__update-card__icon" />
              <span className="settings__update-card__title">Update ready</span>
            </div>
            <p className="settings__update-card__body">
              Restart Launch Deck to apply the latest version.
            </p>
            <div className="settings__update-card__actions">
              <button
                className="settings__action-btn settings__action-btn--primary"
                onClick={handleRestart}
              >
                <RotateCcw size={14} />
                Restart now
              </button>
            </div>
          </div>
        )}

        {!updateReady && available && checkStatus && (
          <div className="settings__update-card settings__update-card--available">
            <div className="settings__update-card__header">
              <Download size={15} className="settings__update-card__icon" />
              <span className="settings__update-card__title">
                Launch Deck {checkStatus.version} is available
              </span>
            </div>
            {checkStatus.notes && (
              <div className="settings__update-card__notes">
                <p className="settings__update-card__notes-label">What&apos;s new</p>
                <pre className="settings__update-card__notes-body">{checkStatus.notes}</pre>
              </div>
            )}
            {isDownloading && (
              <div className="settings__update-progress">
                <div
                  className="settings__update-progress__bar"
                  style={{ width: pct !== null ? `${pct}%` : "0%" }}
                />
                <span className="settings__update-progress__label">
                  {pct !== null ? `${pct}%` : "Preparing…"}
                </span>
              </div>
            )}
            <div className="settings__update-card__actions">
              {!isDownloading && (
                <button
                  className="settings__action-btn settings__action-btn--primary"
                  onClick={handleDownload}
                >
                  <Download size={14} />
                  Update now
                </button>
              )}
              {isDownloading && (
                <button className="settings__action-btn" disabled>
                  <Loader size={14} className="settings__spinner" />
                  Downloading…
                </button>
              )}
            </div>
          </div>
        )}

        {!updateReady && notAvailable && (
          <p className="settings__update-status settings__update-status--ok">
            <CheckCircle2 size={13} /> Launch Deck is up to date.
          </p>
        )}

        {hasError && (
          <p className="settings__update-status settings__update-status--error">
            {checkStatus.message}
          </p>
        )}

        {/* Check button */}
        {!isUpdaterAvailable() && (
          <p className="settings__update-status">
            Auto-update is only available in installed builds.
          </p>
        )}
        <div className="settings__folder-actions" style={{ marginTop: "12px" }}>
          <button
            className="settings__action-btn"
            onClick={handleCheck}
            disabled={isChecking || isDownloading}
          >
            {isChecking ? (
              <>
                <Loader size={14} className="settings__spinner" />
                Checking…
              </>
            ) : (
              <>
                <RefreshCcw size={14} />
                Check for updates
              </>
            )}
          </button>
        </div>
      </div>
    </section>
  )
}

export default function Settings() {
  const { signOut } = useAuth()
  const location = useLocation()
  const [appVersion, setAppVersion] = useState(null)
  const {
    folders,
    scanning,
    enriching,
    candidates,
    coverMap,
    scanProgress,
    enrichProgress,
    result,
    enrichResult,
    error,
    gameCount,
    addFolder,
    removeFolder,
    scan,
    confirmImport,
    cancelImport,
    enrich,
    pendingAddGame,
    addingGame,
    pendingRestore,
    confirmRestore,
    cancelRestore,
    startAddSingleGame,
    confirmAddSingleGame,
    cancelAddSingleGame,
  } = useScanner()

  useEffect(() => {
    getCurrentAppVersion().then((v) => setAppVersion(v))
  }, [])

  useEffect(() => {
    if (location.state?.scrollTo !== "updates") return
    window.requestAnimationFrame(() => {
      document.getElementById("settings-updates")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    })
  }, [location.state])

  return (
    <div className="page settings page--unified">
      <TopBar />
      <PageHeader
        variant="compact"
        eyebrow="Preferences"
        eyebrowIcon={SettingsIcon}
        title="Settings"
        subtitle="Customize Launch Deck, manage your libraries, and connect accounts."
        image="/settings.png"
        actions={
          <div className="settings__version-pill">
            {appVersion ? `Version ${appVersion}` : "Version unavailable"}
          </div>
        }
      />
      <div className="page__content">
        {/* Game Folders Section */}
        <section className="settings__section settings__section--glass">
          <div className="settings__section-header">
            <FolderSearch size={20} className="settings__section-icon" />
            <div className="settings__section-header-text">
              <h2 className="settings__section-title">Game Folders</h2>
              <p className="settings__section-description">
                Add folders to scan for installed games and enrich metadata.
              </p>
            </div>
          </div>
          <div className="settings__section-body">
            <div className="settings__folders">
              {folders.length === 0 && (
                <p className="settings__folders-empty">
                  No folders added yet. Add a folder to scan for installed
                  games.
                </p>
              )}
              {folders.map((folder) => (
                <div key={folder.id} className="settings__folder-row">
                  <span className="settings__folder-path">{folder.path}</span>
                  <button
                    className="settings__folder-remove"
                    onClick={() => removeFolder(folder.id)}
                    title="Remove folder"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>

            <div className="settings__folder-actions">
              <button className="settings__action-btn" onClick={addFolder}>
                <Plus size={16} />
                Add Game Folder
              </button>
              <button
                className="settings__action-btn"
                onClick={startAddSingleGame}
                disabled={scanning || addingGame}
              >
                <PackagePlus size={16} />
                Add Single Game
              </button>
              <button
                className="settings__action-btn settings__action-btn--primary"
                onClick={scan}
                disabled={scanning || folders.length === 0}
              >
                {scanning ? (
                  <>
                    <Loader size={16} className="settings__spinner" />
                    Scanning...
                  </>
                ) : (
                  <>
                    <FolderSearch size={16} />
                    Scan for Games
                  </>
                )}
              </button>
              <button
                className="settings__action-btn settings__action-btn--accent"
                onClick={enrich}
                disabled={enriching || scanning}
              >
                {enriching ? (
                  <>
                    <Loader size={16} className="settings__spinner" />
                    {enrichProgress
                      ? `Fetching ${enrichProgress.current}/${enrichProgress.total}...`
                      : "Fetching game data..."}
                  </>
                ) : (
                  <>
                    <Sparkles size={16} />
                    Fetch Game Data
                  </>
                )}
              </button>
            </div>

            {result && (
              <p className="settings__scan-result">
                Added {result.added} game{result.added !== 1 ? "s" : ""} to
                library.
              </p>
            )}
            {enrichResult && (
              <p className="settings__scan-result">
                Enriched {enrichResult.enriched} of {enrichResult.total} game
                {enrichResult.total !== 1 ? "s" : ""} with metadata
                {enrichResult.failed > 0
                  ? ` (${enrichResult.failed} not found)`
                  : ""}
                .
              </p>
            )}
            {error && <p className="settings__scan-error">{error}</p>}
          </div>
        </section>

        {/* Display */}
        <section
          className="settings__section settings__section--animated settings__section--glass"
          style={{ animationDelay: "80ms" }}
        >
          <div className="settings__section-header">
            <Monitor size={20} className="settings__section-icon" />
            <div className="settings__section-header-text">
              <h2 className="settings__section-title">Display</h2>
              <p className="settings__section-description">
                Startup behaviour and window presentation.
              </p>
            </div>
          </div>
          <div className="settings__section-body">
            <StartupModeRow />
            <WiredToggle
              settingKey="launchAtStartup"
              label="Launch at startup"
              description="Start Launch Deck automatically when Windows boots"
            />
            <WiredToggle
              settingKey="startMinimized"
              label="Start minimized"
              description="Open to the system tray instead of the main window"
            />
          </div>
        </section>

        {/* Appearance */}
        <section
          className="settings__section settings__section--animated settings__section--glass"
          style={{ animationDelay: "160ms" }}
        >
          <div className="settings__section-header">
            <Palette size={20} className="settings__section-icon" />
            <div className="settings__section-header-text">
              <h2 className="settings__section-title">Appearance</h2>
              <p className="settings__section-description">
                Tailor the look and feel of the launcher.
              </p>
            </div>
          </div>
          <div className="settings__section-body">
            <WiredToggle
              settingKey="animationsEnabled"
              label="Animations"
              description="Enable UI animations and transitions"
            />
            <WiredToggle
              settingKey="compactMode"
              label="Compact mode"
              description="Reduce padding and spacing for a denser layout"
            />
            <AccentColorPicker />
          </div>
        </section>

        {/* Library */}
        <section
          className="settings__section settings__section--animated settings__section--glass"
          style={{ animationDelay: "240ms" }}
        >
          <div className="settings__section-header">
            <Library size={20} className="settings__section-icon" />
            <div className="settings__section-header-text">
              <h2 className="settings__section-title">Library</h2>
              <p className="settings__section-description">
                Control how your game library looks and behaves.
              </p>
            </div>
          </div>
          <div className="settings__section-body">
            <DefaultSortRow />
            <WiredToggle
              settingKey="confirmBeforeLaunch"
              label="Confirm before launching"
              description="Show a prompt before launching a game"
            />
          </div>
        </section>

        <PlatformAccountsSection />

        <UpdatesSection />

        <section className="settings__section settings__section--danger settings__section--glass">
          <div className="settings__section-header">
            <LogOut size={20} className="settings__section-icon" />
            <div className="settings__section-header-text">
              <h2 className="settings__section-title">Account</h2>
            </div>
          </div>
          <div className="settings__section-body">
            <div className="setting-row">
              <div className="setting-row__info">
                <span className="setting-row__label">Sign out</span>
                <span className="setting-row__desc">
                  Sign out of your account on this device
                </span>
              </div>
              <button className="settings__danger-btn" onClick={signOut}>
                Sign Out
              </button>
            </div>
          </div>
        </section>
      </div>

      {pendingAddGame && (
        <AddSingleGameModal
          folderPath={pendingAddGame.folderPath}
          exePath={pendingAddGame.exePath}
          exeOptions={pendingAddGame.exeOptions}
          initialTitle={pendingAddGame.detectedTitle}
          onConfirm={confirmAddSingleGame}
          onClose={cancelAddSingleGame}
          adding={addingGame}
        />
      )}

      {pendingRestore &&
        createPortal(
          <div className="cover-picker__backdrop" onClick={cancelRestore}>
            <div
              className="cover-picker"
              style={{
                maxWidth: "420px",
                padding: "24px",
                textAlign: "center",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ fontSize: "42px", marginBottom: "16px" }}>⚠️</div>
              <h3
                className="cover-picker__title"
                style={{
                  borderBottom: "none",
                  paddingBottom: 0,
                  justifyContent: "center",
                }}
              >
                Game Previously Removed
              </h3>
              <p
                style={{
                  color: "var(--text-muted)",
                  lineHeight: "1.5",
                  marginTop: "16px",
                  fontSize: "15px",
                }}
              >
                <strong>&quot;{pendingRestore.gameName}&quot;</strong> was
                previously removed from your library.
                <br />
                <br />
                Do you want to add it back?
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "16px",
                  justifyContent: "center",
                  marginTop: "32px",
                }}
              >
                <button
                  className="cover-picker__btn cover-picker__btn--cancel"
                  onClick={cancelRestore}
                  disabled={addingGame}
                >
                  Cancel
                </button>
                <button
                  className="cover-picker__btn cover-picker__btn--apply"
                  onClick={confirmRestore}
                  disabled={addingGame}
                >
                  {addingGame ? "Adding…" : "Yes, Add It Back"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {candidates && (
        <ScanResultsModal
          results={candidates}
          coverMap={coverMap}
          scanProgress={scanProgress}
          scanning={scanning}
          gameCount={gameCount}
          onConfirm={confirmImport}
          onCancel={cancelImport}
        />
      )}
    </div>
  )
}
