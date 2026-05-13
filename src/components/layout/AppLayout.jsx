import { Outlet } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Sidebar from './Sidebar'
import { useGameContext } from '../../context/GameContext'
import GameLoadingScreen from '../games/GameLoadingScreen'
import SessionEndModal from '../games/SessionEndModal'
import SyncToast from '../ui/SyncToast'
import UpdateBanner from '../ui/UpdateBanner'
import NowPlayingBar from '../ui/NowPlayingBar'
import { getUpdateBanner, subscribeUpdateBanner } from '../../services/updateState'

export default function AppLayout() {
  const {
    launchingGame,
    installingGame,
    sessionSummary,
    clearSessionSummary,
    syncToast,
    clearSyncToast,
    activeGames,
  } = useGameContext()

  const hasActiveGame = activeGames.size > 0

  // Subscribe to the module-level update banner state
  const [updateBanner, setUpdateBanner] = useState(() => getUpdateBanner())
  useEffect(() => {
    return subscribeUpdateBanner((banner) => setUpdateBanner(banner))
  }, [])

  return (
    <div className={`app-layout${hasActiveGame ? ' app-layout--playing' : ''}`}>
      <Sidebar />
      <main className="app-layout__main">
        <Outlet />
      </main>

      {hasActiveGame && <NowPlayingBar />}

      {launchingGame && <GameLoadingScreen game={launchingGame} />}
      {installingGame && (
        <GameLoadingScreen
          game={installingGame.game}
          mode="install"
          statusText={`Opening ${installingGame.launcher}`}
          subtitle={`Preparing the installation flow in ${installingGame.launcher}.`}
        />
      )}
      {sessionSummary && (
        <SessionEndModal summary={sessionSummary} onClose={clearSessionSummary} />
      )}
      {syncToast && <SyncToast toast={syncToast} onDismiss={clearSyncToast} />}
      {updateBanner && <UpdateBanner banner={updateBanner} />}
    </div>
  )
}
