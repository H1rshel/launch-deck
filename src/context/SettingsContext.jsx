import { createContext, useContext } from 'react'
import { useSettings } from '../hooks/useSettings'

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const api = useSettings()
  return (
    <SettingsContext.Provider value={api}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettingsContext() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettingsContext must be used inside SettingsProvider')
  return ctx
}
