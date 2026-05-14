import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import ProtectedRoute from './components/auth/ProtectedRoute'
import AppLayout from './components/layout/AppLayout'
import Login from './pages/Login'
import AuthCallback from './pages/AuthCallback'
import Dashboard from './pages/Dashboard'
import Library from './pages/Library'
import Activity from './pages/Activity'
import Profile from './pages/Profile'
import Settings from './pages/Settings'
import GameDetail from './pages/GameDetail'
import MyRig from './pages/MyRig'
import ConsoleMode from './pages/ConsoleMode'
import UpcomingReleases from './pages/UpcomingReleases'
import UpcomingGameDetail from './pages/UpcomingGameDetail'
import Discover from './pages/Discover'
import { useAuth } from './context/AuthContext'
import { useGameContext } from './context/GameContext'
import { preloadUpcomingFeeds } from './hooks/useUpcomingGames'
import { preloadDiscoverFeeds } from './hooks/useDiscoverGames'
import { usePriceWatcher } from './hooks/usePriceWatcher'
import { UPDATE_MODES, checkAndNotifyUpdate, downloadAndInstallUpdate } from './services/updateService'
import { setUpdateBanner } from './services/updateState'
import { readSetting } from './hooks/useSettings'
import { initDeepLinkHandler } from './services/deepLinkHandler'
import { useNotifications } from './context/NotificationContext'

export default function App() {
  const { loading: authLoading, user } = useAuth()
  const { loading: gameLoading } = useGameContext()
  const { addNotification } = useNotifications()

  usePriceWatcher(user)

  const isLoading = authLoading || gameLoading

  // Register the deep link handler once on mount so OAuth callbacks arrive
  // via launchdeck://auth/callback in installed builds.
  useEffect(() => { initDeepLinkHandler() }, [])

  // Fire off the preloader the moment we have a known user, so that tabs are fully
  // populated in the background before the user even clicks to go to the page.
  useEffect(() => {
    if (!authLoading && user) {
      const TAB_TO_FEED = { forYou: 'for_you', following: 'following', soon: 'soon', recent: 'recent', big: 'big_releases', popular: 'popular' };
      const savedTab = sessionStorage.getItem('upcoming_tab') || 'forYou';
      const activeFeed = TAB_TO_FEED[savedTab] || 'for_you';
      preloadUpcomingFeeds(user.id, activeFeed)
      const discoverTab = sessionStorage.getItem('discover_tab') || 'for_you'
      preloadDiscoverFeeds(user.id, discoverTab)
    }
  }, [authLoading, user])

  // Close the native Tauri splash screen window once React is fully loaded (Auth + DB)
  useEffect(() => {
    if (!isLoading) {
      // Small delay ensures React has painted before showing the window
      const timer = setTimeout(async () => {
        const startupMode = JSON.parse(localStorage.getItem('ld_setting_startupMode') || '"normal"')
        const isConsole = startupMode === 'console'
        await invoke('close_splashscreen', { fullscreen: isConsole, maximize: !isConsole }).catch(console.error)
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [isLoading])

  // Startup update check — runs once after auth + game loading are done and a
  // user is present. Respects the user's updateMode preference. Never throws
  // or shows errors automatically; failures are silently ignored.
  useEffect(() => {
    if (isLoading || !user) return

    const mode = readSetting('updateMode')
    if (mode === UPDATE_MODES.MANUAL_ONLY) return

    let cancelled = false

    async function runStartupCheck() {
      const result = await checkAndNotifyUpdate()
      if (cancelled || result.status !== 'available') return

      if (mode === UPDATE_MODES.NOTIFY_ONLY) {
        setUpdateBanner({
          version: result.version,
          notes: result.notes,
          update: result.update,
        })
        addNotification({
          title: `Launch Deck ${result.version} is available`,
          message: result.notes || 'Open Updates to download and install it.',
          type: 'info',
          route: '/settings',
          routeState: { scrollTo: 'updates' },
          dedupeKey: `update-available-${result.version}`,
        })
        return
      }

      if (mode === UPDATE_MODES.AUTO_DOWNLOAD) {
        // Download silently in the background; show banner when ready
        try {
          await downloadAndInstallUpdate(result.update, () => {})
          if (!cancelled) {
            setUpdateBanner({ version: result.version, notes: result.notes, update: null, ready: true })
            addNotification({
              title: `Launch Deck ${result.version} is ready`,
              message: 'Restart Launch Deck to apply the update.',
              type: 'success',
              route: '/settings',
              routeState: { scrollTo: 'updates' },
              dedupeKey: `update-ready-${result.version}`,
            })
          }
        } catch {
          // Silent failure — user can always check manually in Settings
        }
      }
    }

    runStartupCheck()
    return () => { cancelled = true }
  }, [isLoading, user, addNotification]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Browser/dev OAuth callback — exchanges the PKCE code for a session */}
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/library" element={<Library />} />
        <Route path="/game/:id" element={<GameDetail />} />
        <Route path="/upcoming" element={<UpcomingReleases />} />
        <Route path="/upcoming/:source/:sourceGameId" element={<UpcomingGameDetail />} />
        <Route path="/discover" element={<Discover />} />
        <Route path="/my-rig" element={<MyRig />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route
        path="/console"
        element={
          <ProtectedRoute>
            <ConsoleMode />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}
