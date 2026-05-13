import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SettingsProvider } from './context/SettingsContext'
import { AuthProvider } from './context/AuthContext'
import { GameProvider } from './context/GameContext'
import { NotificationProvider } from './context/NotificationContext'
import App from './App'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
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
  </React.StrictMode>
)
