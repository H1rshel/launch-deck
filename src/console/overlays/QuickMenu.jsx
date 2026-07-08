import { useState, useEffect, useMemo, useCallback } from 'react'
import { ArrowLeft, Square, Volume2, VolumeX, Monitor, Power } from 'lucide-react'
import { useInputLayer } from '../input/InputProvider'
import { playSfx, soundsEnabled, setSoundsEnabled } from '../audio/sounds'
import { ButtonGlyph } from '../components/HintBar'

/**
 * Quick Menu — the console's control center. Slides up from the bottom
 * with system-level actions; captures all input while open.
 */
export default function QuickMenu({ onClose, onExitToDesktop, onQuitApp, activeGame, onEndSession }) {
  const [index, setIndex] = useState(0)
  const [soundsOn, setSoundsOn] = useState(soundsEnabled())
  const [now, setNow] = useState(() => new Date())
  // Quitting the whole app is destructive and irreversible (kills any active
  // game session), so it needs a second press to confirm — unlike the other
  // one-press actions here. Any navigation away from the item cancels it.
  const [confirmingQuit, setConfirmingQuit] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10000)
    return () => clearInterval(id)
  }, [])

  const items = useMemo(() => {
    const list = [{ id: 'resume', label: 'Resume', icon: ArrowLeft }]
    if (activeGame) {
      list.push({
        id: 'end-session',
        label: 'End Session',
        sub: activeGame.displayTitle,
        icon: Square,
        danger: true,
      })
    }
    list.push({
      id: 'sounds',
      label: soundsOn ? 'Sounds On' : 'Sounds Off',
      icon: soundsOn ? Volume2 : VolumeX,
      active: soundsOn,
    })
    list.push({ id: 'desktop', label: 'Desktop Mode', icon: Monitor })
    list.push({
      id: 'quit',
      label: confirmingQuit ? 'Press Again to Quit' : 'Power Off',
      sub: confirmingQuit ? 'This will close Launch Deck' : 'Quit Launch Deck',
      icon: Power,
      danger: true,
    })
    return list
  }, [activeGame, soundsOn, confirmingQuit])

  useEffect(() => {
    if (index > items.length - 1) setIndex(Math.max(0, items.length - 1))
  }, [items.length, index])

  const activate = useCallback(
    (item) => {
      playSfx('select')
      switch (item.id) {
        case 'resume':
          onClose()
          break
        case 'end-session':
          onEndSession()
          onClose()
          break
        case 'sounds': {
          const next = !soundsEnabled()
          setSoundsEnabled(next)
          setSoundsOn(next)
          break
        }
        case 'desktop':
          onExitToDesktop()
          break
        case 'quit':
          if (confirmingQuit) onQuitApp()
          else setConfirmingQuit(true)
          break
        default:
          break
      }
    },
    [onClose, onEndSession, onExitToDesktop, onQuitApp, confirmingQuit]
  )

  useInputLayer((action) => {
    switch (action) {
      case 'left':
        setConfirmingQuit(false)
        setIndex((i) => { if (i > 0) playSfx('nav'); return Math.max(0, i - 1) })
        return
      case 'right':
        setConfirmingQuit(false)
        setIndex((i) => { if (i < items.length - 1) playSfx('nav'); return Math.min(items.length - 1, i + 1) })
        return
      case 'accept':
        activate(items[index])
        return
      case 'back':
      case 'menu':
        playSfx('back')
        setConfirmingQuit(false)
        onClose()
        return
      default:
        return
    }
  })

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="cos-quickmenu-backdrop" onClick={onClose}>
      <div className="cos-quickmenu" onClick={(e) => e.stopPropagation()}>
        <div className="cos-quickmenu__head">
          <div className="cos-quickmenu__clock">
            <span className="cos-quickmenu__time">{time}</span>
            <span className="cos-quickmenu__date">{date}</span>
          </div>
          <span className="cos-quickmenu__hint">
            <ButtonGlyph action="back" />
            <span>Close</span>
          </span>
        </div>

        <div className="cos-quickmenu__items">
          {items.map((item, i) => {
            const Icon = item.icon
            const focusedItem = i === index
            return (
              <button
                key={item.id}
                className={[
                  'cos-quickmenu__item',
                  focusedItem ? 'cos-quickmenu__item--focused' : '',
                  item.danger ? 'cos-quickmenu__item--danger' : '',
                  item.active ? 'cos-quickmenu__item--active' : '',
                ].join(' ')}
                onMouseEnter={() => { setConfirmingQuit(false); setIndex(i) }}
                onClick={() => activate(item)}
              >
                <span className="cos-quickmenu__item-icon">
                  <Icon size={22} />
                </span>
                <span className="cos-quickmenu__item-label">{item.label}</span>
                {item.sub && <span className="cos-quickmenu__item-sub">{item.sub}</span>}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
