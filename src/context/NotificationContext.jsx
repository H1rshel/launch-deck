import { createContext, useContext, useState, useCallback, useEffect } from 'react'

const generateId = () => {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2, 15)
}

const NotificationContext = createContext(null)

const STORAGE_KEY = 'launchdeck_notifications'

export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })

  // Keep localStorage in sync
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications))
  }, [notifications])

  const addNotification = useCallback(({
    title,
    message,
    type = 'info',
    image = null,
    gameIds = null,
    gamesInfo = null,
    upcomingLink = null,
    saleGamesInfo = null,
    route = null,
    routeState = null,
    dedupeKey = null,
  }) => {
    const newNotif = {
      id: generateId(),
      title,
      message,
      type,
      time: new Date().toISOString(),
      read: false,
      ...(dedupeKey && { dedupeKey }),
      ...(image && { image }),
      ...(gameIds && { gameIds }),
      ...(gamesInfo && { gamesInfo }),
      ...(upcomingLink && { upcomingLink }),
      ...(saleGamesInfo && { saleGamesInfo }),
      ...(route && { route }),
      ...(routeState && { routeState }),
    }
    setNotifications((prev) => {
      if (dedupeKey && prev.some((n) => n.dedupeKey === dedupeKey)) {
        return prev
      }
      return [newNotif, ...prev].slice(0, 50)
    }) // keep last 50
  }, [])

  const markAsRead = useCallback((id) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    )
  }, [])

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }, [])

  const removeNotification = useCallback((id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
  }, [])

  const unreadCount = notifications.filter((n) => !n.read).length

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        addNotification,
        markAsRead,
        markAllAsRead,
        removeNotification,
        clearAll,
      }}
    >
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotifications() {
  const context = useContext(NotificationContext)
  if (!context) throw new Error('useNotifications must be used within a NotificationProvider')
  return context
}
