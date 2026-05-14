import { Bell, Check, Trash2, ShieldAlert, CheckCircle2, Info, X, ChevronRight, Gamepad2 } from 'lucide-react'
import { useNotifications } from '../../context/NotificationContext'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

function getIconForType(type) {
  switch (type) {
    case 'success':
      return <CheckCircle2 size={16} className="notif__icon notif__icon--success" />
    case 'error':
    case 'warning':
      return <ShieldAlert size={16} className="notif__icon notif__icon--error" />
    default:
      return <Info size={16} className="notif__icon notif__icon--info" />
  }
}

function timeAgo(dateString) {
  const diff = Date.now() - new Date(dateString).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function MultiGameDrawer({ games, onSelect, onClose, label = 'Added Games' }) {
  return (
    <div className="notif-games-drawer">
      <div className="notif-games-drawer__header">
        <Gamepad2 size={14} className="notif-games-drawer__icon" />
        <span>{label}</span>
        <button className="notif-games-drawer__close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="notif-games-drawer__list">
        {games.map((g) => (
          <button
            key={g.id || `${g.source}:${g.sourceGameId}`}
            className="notif-games-drawer__item"
            onClick={() => onSelect(g)}
          >
            {g.image ? (
              <img src={g.image} alt="" className="notif-games-drawer__item-cover" />
            ) : (
              <div className="notif-games-drawer__item-cover notif-games-drawer__item-cover--placeholder">
                <Gamepad2 size={14} />
              </div>
            )}
            <span className="notif-games-drawer__item-title">{g.title}</span>
            <ChevronRight size={14} className="notif-games-drawer__item-arrow" />
          </button>
        ))}
      </div>
    </div>
  )
}

export default function NotificationTray({ isOpen, onClose }) {
  const { notifications, unreadCount, markAllAsRead, markAsRead, removeNotification, clearAll } = useNotifications()
  const trayRef = useRef(null)
  const navigate = useNavigate()
  const [drawerNotifId, setDrawerNotifId] = useState(null)

  useEffect(() => {
    if (!isOpen) {
      setDrawerNotifId(null)
      return
    }

    function handleClickOutside(event) {
      if (trayRef.current && !trayRef.current.contains(event.target)) {
        if (!event.target.closest('.topbar__icon-btn')) {
          onClose()
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, onClose])

  function handleNotifClick(n) {
    if (!n.read) markAsRead(n.id)

    if (n.route) {
      navigate(n.route, n.routeState ? { state: n.routeState } : undefined)
      onClose()
    } else if (n.upcomingLink) {
      // Single price-drop notification → upcoming game detail
      navigate(`/upcoming/${n.upcomingLink.source}/${n.upcomingLink.sourceGameId}`)
      onClose()
    } else if (n.saleGamesInfo?.length === 1) {
      const g = n.saleGamesInfo[0]
      navigate(`/upcoming/${g.source}/${g.sourceGameId}`)
      onClose()
    } else if (n.saleGamesInfo?.length > 1) {
      setDrawerNotifId((prev) => (prev === n.id ? null : n.id))
    } else if (n.gameIds?.length === 1) {
      navigate(`/game/${n.gameIds[0]}`)
      onClose()
    } else if (n.gameIds?.length > 1) {
      setDrawerNotifId((prev) => (prev === n.id ? null : n.id))
    }
  }

  function handleGameSelect(game) {
    if (game.source && game.sourceGameId) {
      navigate(`/upcoming/${game.source}/${game.sourceGameId}`)
    } else if (game.id) {
      navigate(`/game/${game.id}`)
    }
    onClose()
    setDrawerNotifId(null)
  }

  const drawerNotif = notifications.find((n) => n.id === drawerNotifId)

  return (
    <>
      <div className={`notif-tray ${isOpen ? 'notif-tray--open' : ''}`} ref={trayRef}>
        <div className="notif-tray__header">
          <div className="notif-tray__title-wrap">
            <Bell size={18} />
            <h3 className="notif-tray__title">Notifications</h3>
            {unreadCount > 0 && <span className="notif-tray__badge">{unreadCount}</span>}
          </div>
          <div className="notif-tray__actions">
            {unreadCount > 0 && (
              <button className="notif-tray__action-btn" onClick={markAllAsRead} title="Mark all as read">
                <Check size={16} />
              </button>
            )}
            {notifications.length > 0 && (
              <button className="notif-tray__action-btn notif-tray__action-btn--clear" onClick={clearAll} title="Clear all">
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>

        <div className="notif-tray__list">
          {notifications.length === 0 ? (
            <div className="notif-tray__empty">
              <Bell size={32} className="notif-tray__empty-icon" />
              <p>No new notifications</p>
            </div>
          ) : (
            notifications.map((n) => {
              const isClickable = !!n.route || n.gameIds?.length > 0 || !!n.upcomingLink || n.saleGamesInfo?.length > 0
              const isMultiGame = n.gameIds?.length > 1 || n.saleGamesInfo?.length > 1
              const isDrawerOpen = drawerNotifId === n.id

              return (
                <div key={n.id} className="notif-item-wrap">
                  <div
                    className={[
                      'notif-item',
                      n.read ? 'notif-item--read' : '',
                      isClickable ? 'notif-item--clickable' : '',
                      isDrawerOpen ? 'notif-item--drawer-open' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => handleNotifClick(n)}
                  >
                    <div className="notif-item__indicator">
                      {n.image ? (
                        <img src={n.image} alt="" className="notif-item__image" />
                      ) : (
                        getIconForType(n.type)
                      )}
                    </div>
                    <div className="notif-item__content">
                      <h4 className="notif-item__title">{n.title}</h4>
                      <p className="notif-item__message">{n.message}</p>
                      <span className="notif-item__time">{timeAgo(n.time)}</span>
                    </div>
                    {isClickable && (
                      <div className="notif-item__nav-hint">
                        {isMultiGame ? (
                          <ChevronRight size={14} className={isDrawerOpen ? 'notif-item__nav-hint--open' : ''} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </div>
                    )}
                    <button
                      className="notif-item__remove"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (drawerNotifId === n.id) setDrawerNotifId(null)
                        removeNotification(n.id)
                      }}
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  {/* Inline drawer for multi-game notifications */}
                  {isDrawerOpen && (drawerNotif?.gamesInfo || drawerNotif?.saleGamesInfo) && (
                    <MultiGameDrawer
                      games={drawerNotif.saleGamesInfo ?? drawerNotif.gamesInfo}
                      onSelect={handleGameSelect}
                      onClose={() => setDrawerNotifId(null)}
                      label={drawerNotif.saleGamesInfo ? 'On Sale Now' : 'Added Games'}
                    />
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}
