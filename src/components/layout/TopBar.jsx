import { Search, Bell, Minus, Maximize2, Minimize2, X, Cloud, Loader2, ArrowLeft } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useGameContext } from '../../context/GameContext'
import { useProfileAvatar } from '../../hooks/useProfileAvatar'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useState, useEffect, useRef } from 'react'
import NotificationTray from '../ui/NotificationTray'
import { useNotifications } from '../../context/NotificationContext'
import GlobalSearchPopover from '../search/GlobalSearchPopover'

const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)

export default function TopBar({ searchQuery, onSearchChange, backAction }) {
  const { user } = useAuth()
  const { avatarUrl, isResolving } = useProfileAvatar()
  const { isCloudSyncing, isEnriching } = useGameContext()
  const { unreadCount } = useNotifications()
  const [isMaximized, setIsMaximized] = useState(false)
  const [isNotifOpen, setIsNotifOpen] = useState(false)
  const [avatarError, setAvatarError] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const inputRef = useRef(null)
  const effectiveUrl = !avatarError ? avatarUrl : null
  const isGlobalSearch = !onSearchChange

  useEffect(() => {
    if (isTauri) {
      getCurrentWindow().isMaximized().then(setIsMaximized).catch(console.warn)
    }
  }, [])

  async function handleMinimize() {
    if (isTauri) await getCurrentWindow().minimize()
  }

  async function handleMaximize() {
    if (!isTauri) return
    const win = getCurrentWindow()
    const maximized = await win.isMaximized()
    if (maximized) {
      await win.unmaximize()
      setIsMaximized(false)
    } else {
      await win.maximize()
      setIsMaximized(true)
    }
  }

  async function handleClose() {
    if (isTauri) await getCurrentWindow().close()
  }

  return (
    <header className={`topbar${searchFocused ? ' topbar--search-focused' : ''}`} data-tauri-drag-region>

      {/* ── Ambient layers (self-clipped so topbar can overflow) ─ */}
      <div className="topbar__deco-layer" aria-hidden="true">
        <div className="topbar__ambient" />
        <div className="topbar__streak" />
      </div>

      {/* ── LEFT: Back navigation (detail pages) ─────────────── */}
      {backAction && (
        <button
          type="button"
          className="topbar__back"
          onClick={backAction}
          aria-label="Go back"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
      )}

      {/* ── CENTER: Premium search command bar ────────────────── */}
      <div className="topbar__search-zone">
        <div
          className={`topbar__search${searchFocused ? ' topbar__search--focused' : ''}${isGlobalSearch ? ' topbar__search--global' : ''}`}
          onClick={isGlobalSearch ? () => setGlobalSearchOpen(true) : undefined}
        >
          <Search size={15} className="topbar__search-icon" strokeWidth={2} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search your gaming universe…"
            value={isGlobalSearch ? '' : (searchQuery || '')}
            onChange={isGlobalSearch ? undefined : (e) => onSearchChange?.(e.target.value)}
            className="topbar__search-input"
            readOnly={isGlobalSearch}
            onFocus={() => {
              if (isGlobalSearch) {
                setGlobalSearchOpen(true)
                inputRef.current?.blur()
                return
              }
              setSearchFocused(true)
            }}
            onBlur={() => setSearchFocused(false)}
          />
          {!isGlobalSearch && searchQuery && (
            <button
              className="topbar__search-clear"
              onClick={() => { onSearchChange?.(''); inputRef.current?.focus() }}
              tabIndex={-1}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <GlobalSearchPopover
          isOpen={globalSearchOpen}
          onClose={() => setGlobalSearchOpen(false)}
        />
      </div>

      {/* ── RIGHT: Status + actions ───────────────────────────── */}
      <div className="topbar__actions">

        {/* Sync / enrichment status */}
        <div
          className="topbar__sync-status"
          title={isEnriching ? 'Fetching game metadata…' : isCloudSyncing ? 'Syncing to cloud…' : 'Cloud synced'}
        >
          {isEnriching && (
            <Loader2 size={15} className="topbar__sync-icon topbar__sync-icon--enriching spinning" />
          )}
          <Cloud
            size={15}
            className={`topbar__sync-icon${isCloudSyncing ? ' spinning' : ''}${(!isCloudSyncing && !isEnriching) ? ' topbar__sync-icon--idle' : ''}`}
          />
        </div>

        {/* Notifications */}
        <div className="topbar__notif-wrapper">
          <button
            className={`topbar__icon-btn${isNotifOpen ? ' topbar__icon-btn--active' : ''}`}
            onClick={() => setIsNotifOpen((prev) => !prev)}
            aria-label="Notifications"
          >
            <Bell size={18} strokeWidth={1.8} />
            {unreadCount > 0 && (
              <span className="topbar__notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
            )}
          </button>
          <NotificationTray isOpen={isNotifOpen} onClose={() => setIsNotifOpen(false)} />
        </div>

        {/* Profile avatar */}
        <div className="topbar__profile">
          {isResolving ? (
            <div className="topbar__avatar topbar__avatar--placeholder" style={{ opacity: 0.5 }}>
              <Loader2 size={13} className="spinning" />
            </div>
          ) : effectiveUrl ? (
            <img
              src={effectiveUrl}
              alt="Profile"
              className="topbar__avatar"
              onError={() => setAvatarError(true)}
            />
          ) : (
            <div className="topbar__avatar topbar__avatar--placeholder">
              {user?.email?.[0]?.toUpperCase() || '?'}
            </div>
          )}
        </div>

        {/* Native window controls */}
        {isTauri && (
          <div className="topbar__wincontrols">
            <button className="topbar__winctr topbar__winctr--minimize" onClick={handleMinimize} title="Minimize">
              <Minus size={12} />
            </button>
            <button className="topbar__winctr topbar__winctr--maximize" onClick={handleMaximize} title={isMaximized ? 'Restore' : 'Maximize'}>
              {isMaximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
            </button>
            <button className="topbar__winctr topbar__winctr--close" onClick={handleClose} title="Close">
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
