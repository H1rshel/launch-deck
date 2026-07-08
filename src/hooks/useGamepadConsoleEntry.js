import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { detectPadType } from '../console/input/gamepad'

const START_BUTTON = 9 // Start / Menu / Options

/**
 * Desktop-mode bridge to Console Mode: while a controller is connected,
 * pressing Start/Menu anywhere in the desktop UI enters Console Mode.
 *
 * Returns live state so the UI can show a visible affordance (the
 * ControllerDock) instead of a one-shot toast:
 *   { connected, padType, enterConsole }
 *
 * Mounted in AppLayout, so it never runs while Console Mode itself is open
 * (the /console route renders outside AppLayout).
 */
export function useGamepadConsoleEntry() {
  const navigate = useNavigate()
  const [connected, setConnected] = useState(false)
  const [padType, setPadType] = useState(null)
  const stateRef = useRef({ wasConnected: false, prevStart: false })

  const enterConsole = useCallback(() => {
    try {
      getCurrentWindow().setFullscreen(true).catch(() => {})
    } catch {}
    navigate('/console')
  }, [navigate])

  useEffect(() => {
    // A cheap 140ms poll: one getGamepads() call and a single button check.
    const id = setInterval(() => {
      const pad = Array.from(navigator.getGamepads?.() ?? []).find((p) => p?.connected)
      const s = stateRef.current

      if (!pad) {
        if (s.wasConnected) {
          s.wasConnected = false
          setConnected(false)
          setPadType(null)
        }
        s.prevStart = false
        return
      }

      if (!s.wasConnected) {
        s.wasConnected = true
        // Swallow whatever is held during connection so it can't insta-trigger
        s.prevStart = !!pad.buttons[START_BUTTON]?.pressed
        setConnected(true)
        setPadType(detectPadType(pad.id))
        return
      }

      const pressed = !!pad.buttons[START_BUTTON]?.pressed
      if (pressed && !s.prevStart) enterConsole()
      s.prevStart = pressed
    }, 140)

    return () => clearInterval(id)
  }, [enterConsole])

  return { connected, padType, enterConsole }
}
