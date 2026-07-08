import { useState, useEffect } from 'react'
import { Gamepad2 } from 'lucide-react'

/**
 * Floating affordance shown while a controller is connected in desktop mode.
 * Expands on connect to teach the shortcut, then settles into a small badge;
 * hovering re-expands it and clicking enters Console Mode directly.
 */
export default function ControllerDock({ connected, padType, onEnter }) {
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    if (!connected) return undefined
    setExpanded(true)
    const timer = setTimeout(() => setExpanded(false), 8000)
    return () => clearTimeout(timer)
  }, [connected])

  if (!connected) return null

  return (
    <button
      className={`controller-dock ${expanded ? 'controller-dock--expanded' : ''}`}
      onClick={onEnter}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      title="Enter Console Mode"
    >
      <span className="controller-dock__icon">
        <Gamepad2 size={19} />
      </span>
      <span className="controller-dock__text">
        <span>Press</span>
        <kbd className="controller-dock__key">{padType === 'ps' ? 'OPTIONS' : '≡'}</kbd>
        <span>for</span>
        <strong>Console Mode</strong>
      </span>
    </button>
  )
}
