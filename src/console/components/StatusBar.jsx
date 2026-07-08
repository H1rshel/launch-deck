import { useEffect, useState } from 'react'
import { Gamepad2, Wifi, WifiOff, User } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useProfileAvatar } from '../../hooks/useProfileAvatar'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { useConsoleInput } from '../input/InputProvider'
import { ButtonGlyph } from './HintBar'

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10000)
    return () => clearInterval(id)
  }, [])
  return now
}

const SCREENS = [
  { id: 'home', label: 'Home' },
  { id: 'library', label: 'Library' },
]

export default function StatusBar({ screen, onScreenChange }) {
  const { user, profile } = useAuth()
  const { avatarUrl } = useProfileAvatar()
  const isOnline = useOnlineStatus()
  const { gamepadConnected, padType } = useConsoleInput()
  const now = useClock()

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now
    .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase()
  const username =
    profile?.username || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Player'

  return (
    <header className="cos-statusbar">
      <div className="cos-statusbar__brand">
        <img src="/launch-deck-logo-alt.png" alt="" className="cos-statusbar__logo" />
        <span className="cos-statusbar__brand-name">Launch Deck</span>
      </div>

      <nav className="cos-statusbar__tabs">
        <ButtonGlyph action="lb" />
        <div className="cos-statusbar__tab-strip">
          {SCREENS.map((s) => (
            <button
              key={s.id}
              className={`cos-statusbar__tab ${screen === s.id ? 'cos-statusbar__tab--active' : ''}`}
              onClick={() => onScreenChange(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <ButtonGlyph action="rb" />
      </nav>

      <div className="cos-statusbar__system">
        <span
          className={`cos-statusbar__pad ${gamepadConnected ? 'cos-statusbar__pad--on' : ''}`}
          title={
            gamepadConnected
              ? `Controller connected${padType === 'ps' ? ' (PlayStation)' : padType === 'nintendo' ? ' (Nintendo)' : ' (Xbox)'}`
              : 'No controller'
          }
        >
          <Gamepad2 size={17} />
        </span>
        <span
          className={`cos-statusbar__net ${isOnline ? '' : 'cos-statusbar__net--off'}`}
          title={isOnline ? 'Online' : 'Offline'}
        >
          {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
        </span>
        <div className="cos-statusbar__clock">
          <span className="cos-statusbar__time">{time}</span>
          <span className="cos-statusbar__date">{date}</span>
        </div>
        <div className="cos-statusbar__user" title={username}>
          {avatarUrl ? (
            <img src={avatarUrl} alt={username} className="cos-statusbar__avatar" />
          ) : (
            <span className="cos-statusbar__avatar cos-statusbar__avatar--fallback">
              <User size={15} />
            </span>
          )}
        </div>
      </div>
    </header>
  )
}
