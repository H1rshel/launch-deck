/**
 * GamepadEngine — low-level controller polling for Console Mode.
 *
 * Polls the Gamepad API on requestAnimationFrame and translates raw
 * buttons/axes into semantic actions. Directions (d-pad + left stick)
 * get hold-to-repeat with an initial delay (DAS-style), every other
 * button fires on the pressed edge only.
 *
 * Semantic actions:
 *   up, down, left, right    — d-pad 12-15 or left stick
 *   accept (A/Cross)         — button 0
 *   back (B/Circle)          — button 1
 *   actionX (X/Square)       — button 2
 *   actionY (Y/Triangle)     — button 3
 *   lb, rb                   — buttons 4, 5
 *   lt, rt                   — buttons 6, 7 (digital or analog > 0.5)
 *   view (Back/Share)        — button 8
 *   menu (Start/Options)     — button 9
 */

const EDGE_BUTTONS = {
  0: 'accept',
  1: 'back',
  2: 'actionX',
  3: 'actionY',
  4: 'lb',
  5: 'rb',
  6: 'lt',
  7: 'rt',
  8: 'view',
  9: 'menu',
}

const DIRECTION_BUTTONS = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' }

const STICK_DEADZONE = 0.5
const REPEAT_INITIAL_MS = 380
const REPEAT_INTERVAL_MS = 125

/** Best-effort controller family from the gamepad id string. */
export function detectPadType(id = '') {
  const s = id.toLowerCase()
  if (
    s.includes('dualsense') ||
    s.includes('dualshock') ||
    s.includes('054c') || // Sony vendor id
    s.includes('playstation') ||
    s.includes('wireless controller')
  ) {
    return 'ps'
  }
  if (s.includes('switch') || s.includes('joy-con') || s.includes('057e')) {
    return 'nintendo'
  }
  return 'xbox'
}

export class GamepadEngine {
  /**
   * @param {object} opts
   * @param {(action: string) => void} opts.onAction
   * @param {(info: {connected: boolean, padType: string|null}) => void} opts.onConnectionChange
   */
  constructor({ onAction, onConnectionChange }) {
    this.onAction = onAction
    this.onConnectionChange = onConnectionChange
    this.rafId = null
    this.prevPressed = {}
    this.dirState = { up: null, down: null, left: null, right: null } // { since, lastFire }
    this.connected = false
    this.padType = null
    this._poll = this._poll.bind(this)
  }

  start() {
    if (this.rafId == null) this.rafId = requestAnimationFrame(this._poll)
  }

  stop() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    this.prevPressed = {}
    this.dirState = { up: null, down: null, left: null, right: null }
  }

  _poll() {
    const pads = navigator.getGamepads?.() ?? []
    const pad = Array.from(pads).find((p) => p?.connected)

    if (pad) {
      if (!this.connected) {
        this.connected = true
        this.padType = detectPadType(pad.id)
        this.onConnectionChange?.({ connected: true, padType: this.padType })
        // Baseline whatever is already held (e.g. the Start press that
        // entered Console Mode) so it can't fire as a fresh edge.
        this._baseline(pad)
      } else {
        this._readPad(pad)
      }
    } else if (this.connected) {
      this.connected = false
      this.padType = null
      this.prevPressed = {}
      this.dirState = { up: null, down: null, left: null, right: null }
      this.onConnectionChange?.({ connected: false, padType: null })
    }

    this.rafId = requestAnimationFrame(this._poll)
  }

  /** Record current button/stick state without emitting any actions. */
  _baseline(pad) {
    const now = performance.now()
    for (const idx of Object.keys(EDGE_BUTTONS)) {
      const b = pad.buttons[idx]
      this.prevPressed[idx] = !!(b && (b.pressed || b.value > 0.5))
    }
    const ax = pad.axes[0] ?? 0
    const ay = pad.axes[1] ?? 0
    const active = {
      up: pad.buttons[12]?.pressed || ay < -STICK_DEADZONE,
      down: pad.buttons[13]?.pressed || ay > STICK_DEADZONE,
      left: pad.buttons[14]?.pressed || ax < -STICK_DEADZONE,
      right: pad.buttons[15]?.pressed || ax > STICK_DEADZONE,
    }
    for (const dir of ['up', 'down', 'left', 'right']) {
      this.dirState[dir] = active[dir] ? { since: now, lastFire: now } : null
    }
  }

  _readPad(pad) {
    const now = performance.now()

    // Edge-triggered buttons
    for (const [idx, action] of Object.entries(EDGE_BUTTONS)) {
      const b = pad.buttons[idx]
      const pressed = !!(b && (b.pressed || b.value > 0.5))
      if (pressed && !this.prevPressed[idx]) this.onAction(action)
      this.prevPressed[idx] = pressed
    }

    // Directions: d-pad or left stick, with hold-to-repeat
    const ax = pad.axes[0] ?? 0
    const ay = pad.axes[1] ?? 0
    const active = {
      up: pad.buttons[12]?.pressed || ay < -STICK_DEADZONE,
      down: pad.buttons[13]?.pressed || ay > STICK_DEADZONE,
      left: pad.buttons[14]?.pressed || ax < -STICK_DEADZONE,
      right: pad.buttons[15]?.pressed || ax > STICK_DEADZONE,
    }

    for (const dir of ['up', 'down', 'left', 'right']) {
      const state = this.dirState[dir]
      if (active[dir]) {
        if (!state) {
          this.onAction(dir)
          this.dirState[dir] = { since: now, lastFire: now }
        } else if (
          now - state.since > REPEAT_INITIAL_MS &&
          now - state.lastFire > REPEAT_INTERVAL_MS
        ) {
          this.onAction(dir)
          state.lastFire = now
        }
      } else {
        this.dirState[dir] = null
      }
    }
  }
}
