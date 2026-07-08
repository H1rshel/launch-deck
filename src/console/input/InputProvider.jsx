import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react'
import { GamepadEngine } from './gamepad'

/**
 * Unified input layer for Console Mode.
 *
 * Gamepad + keyboard are translated into the same semantic actions and
 * dispatched to a stack of "input layers". Only the topmost layer receives
 * actions, so overlays (quick menu, action sheets, modals) capture input
 * simply by mounting a layer — no scattered "is modal open" checks.
 *
 * Also tracks which device the user touched last ('gamepad' | 'keyboard' |
 * 'mouse') so the UI can adapt hints and hide the cursor.
 */

const InputContext = createContext(null)

const KEY_ACTIONS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'accept',
  ' ': 'accept',
  Escape: 'back',
  Backspace: 'back',
  q: 'lb',
  Q: 'lb',
  e: 'rb',
  E: 'rb',
  f: 'actionX',
  F: 'actionX',
  y: 'actionY',
  Y: 'actionY',
  m: 'menu',
  M: 'menu',
  Tab: 'menu',
  PageUp: 'lt',
  PageDown: 'rt',
  '[': 'lt',
  ']': 'rt',
  '/': 'actionY',
}

// While a text field (search) is active, only navigation keys act as console
// actions — everything else must reach the text input as real typing.
const TEXT_ENTRY_KEY_ACTIONS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'accept',
  Escape: 'back',
}

// Directions may auto-repeat (held key / held stick); everything else is edge-only.
const REPEATABLE = new Set(['up', 'down', 'left', 'right', 'lt', 'rt'])

export function InputProvider({ enabled = true, children }) {
  const layersRef = useRef([]) // [{ id, handler }] — last entry is topmost
  const nextLayerId = useRef(1)
  const enabledRef = useRef(enabled)
  useEffect(() => { enabledRef.current = enabled }, [enabled])

  const [gamepadConnected, setGamepadConnected] = useState(false)
  const [padType, setPadType] = useState(null)
  const textEntryRef = useRef(false)
  const setTextEntry = useCallback((active) => { textEntryRef.current = !!active }, [])

  // Activity pub/sub — lets the shell run an idle timer (attract mode)
  // without wiring every input source separately.
  const activityListenersRef = useRef(new Set())
  const notifyActivity = useCallback(() => {
    for (const fn of activityListenersRef.current) fn()
  }, [])
  const subscribeActivity = useCallback((fn) => {
    activityListenersRef.current.add(fn)
    return () => activityListenersRef.current.delete(fn)
  }, [])
  const [device, setDevice] = useState('keyboard')
  const deviceRef = useRef(device)
  const setActiveDevice = useCallback((d) => {
    if (deviceRef.current !== d) {
      deviceRef.current = d
      setDevice(d)
    }
  }, [])

  const dispatch = useCallback((action, meta) => {
    if (!enabledRef.current) return
    notifyActivity()
    const layers = layersRef.current
    for (let i = layers.length - 1; i >= 0; i--) {
      const res = layers[i].handler(action, meta)
      // A layer may return false to let the action fall through to the
      // layer beneath it (rarely needed — default is to capture).
      if (res !== false) return
    }
  }, [])

  const pushLayer = useCallback((handler) => {
    const layer = { id: nextLayerId.current++, handler }
    layersRef.current.push(layer)
    return () => {
      const idx = layersRef.current.indexOf(layer)
      if (idx !== -1) layersRef.current.splice(idx, 1)
    }
  }, [])

  // Gamepad engine
  useEffect(() => {
    const engine = new GamepadEngine({
      onAction: (action) => {
        setActiveDevice('gamepad')
        dispatch(action, { source: 'gamepad' })
      },
      onConnectionChange: ({ connected, padType: type }) => {
        setGamepadConnected(connected)
        setPadType(type)
        if (connected) setActiveDevice('gamepad')
      },
    })
    engine.start()
    return () => engine.stop()
  }, [dispatch, setActiveDevice])

  // Keyboard
  useEffect(() => {
    const onKeyDown = (e) => {
      // Ignore synthetic events (e.g. the gamepad→modal bridge re-dispatches
      // key events for modals that live outside the console layer system).
      if (!e.isTrusted) return
      const map = textEntryRef.current ? TEXT_ENTRY_KEY_ACTIONS : KEY_ACTIONS
      const action = map[e.key]
      if (!action) return
      e.preventDefault()
      if (e.repeat && !REPEATABLE.has(action)) return
      setActiveDevice('keyboard')
      dispatch(action, { source: 'keyboard' })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dispatch, setActiveDevice])

  // Mouse presence (throttled) — reveals the cursor, switches hints,
  // and counts as activity for the idle timer
  useEffect(() => {
    let last = 0
    const onMouseMove = () => {
      const now = performance.now()
      if (now - last < 150) return
      last = now
      setActiveDevice('mouse')
      notifyActivity()
    }
    const onMouseDown = () => {
      setActiveDevice('mouse')
      notifyActivity()
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [setActiveDevice, notifyActivity])

  const value = useMemo(
    () => ({ pushLayer, gamepadConnected, padType, device, setActiveDevice, setTextEntry, subscribeActivity }),
    [pushLayer, gamepadConnected, padType, device, setActiveDevice, setTextEntry, subscribeActivity]
  )

  return <InputContext.Provider value={value}>{children}</InputContext.Provider>
}

export function useConsoleInput() {
  const ctx = useContext(InputContext)
  if (!ctx) throw new Error('useConsoleInput must be used inside <InputProvider>')
  return ctx
}

/**
 * Register an input layer while mounted (and `enabled`). The most recently
 * mounted enabled layer receives all semantic actions.
 *
 * @param {(action: string, meta?: {source: string}) => void|false} handler —
 *   return false to pass the action through to the layer beneath.
 * @param {boolean} enabled
 */
export function useInputLayer(handler, enabled = true) {
  const { pushLayer } = useConsoleInput()
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled) return undefined
    return pushLayer((action, meta) => handlerRef.current(action, meta))
  }, [enabled, pushLayer])
}
