import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SettingsProvider } from './context/SettingsContext'
import { AuthProvider } from './context/AuthContext'
import { GameProvider } from './context/GameContext'
import { StreamingProvider } from './context/StreamingContext'
import { NotificationProvider } from './context/NotificationContext'
import App from './App'
import AppErrorBoundary, { StartupRecoveryScreen } from './components/ui/AppErrorBoundary'
import './styles/global.css'

const rootElement = document.getElementById('root')
let appMounted = false
const root = ReactDOM.createRoot(rootElement)

function renderStartupRecovery(error) {
  if (!rootElement || appMounted) return

  root.render(
    <StartupRecoveryScreen
      title="Launch Deck could not start"
      message="The interface did not mount in time. Reload the app, or reset startup state if this keeps happening."
      details={error?.message || (error ? String(error) : null)}
    />
  )
}

window.addEventListener('error', (event) => {
  if (!appMounted) renderStartupRecovery(event.error || event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  if (!appMounted) renderStartupRecovery(event.reason)
})

setTimeout(() => {
  if (!appMounted && rootElement && rootElement.childElementCount === 0) {
    renderStartupRecovery()
  }
}, 15000)

// Android tablets get the slim streaming-only experience: no scanners,
// no local library, no desktop chrome — just the cloud library and the
// Moonlight handoff. Desktop keeps the full app.
const IS_ANDROID = /android/i.test(navigator.userAgent)
const MobileApp = IS_ANDROID ? React.lazy(() => import('./mobile/MobileApp')) : null

root.render(
  <React.StrictMode>
    <AppErrorBoundary>
      {IS_ANDROID ? (
        <BrowserRouter>
          <AuthProvider>
            <React.Suspense fallback={null}>
              <MobileApp />
            </React.Suspense>
          </AuthProvider>
        </BrowserRouter>
      ) : (
        <BrowserRouter>
          <SettingsProvider>
            <AuthProvider>
              <NotificationProvider>
                <GameProvider>
                  <StreamingProvider>
                    <App />
                  </StreamingProvider>
                </GameProvider>
              </NotificationProvider>
            </AuthProvider>
          </SettingsProvider>
        </BrowserRouter>
      )}
    </AppErrorBoundary>
  </React.StrictMode>
)

requestAnimationFrame(() => {
  appMounted = true
})
