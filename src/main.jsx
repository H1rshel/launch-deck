import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SettingsProvider } from './context/SettingsContext'
import { AuthProvider } from './context/AuthContext'
import { GameProvider } from './context/GameContext'
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

root.render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <SettingsProvider>
          <AuthProvider>
            <NotificationProvider>
              <GameProvider>
                <App />
              </GameProvider>
            </NotificationProvider>
          </AuthProvider>
        </SettingsProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>
)

requestAnimationFrame(() => {
  appMounted = true
})
