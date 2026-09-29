/**
 * GamepadEngine — low-level controller polling for Console Mode.
 *
 * Polls the Gamepad API on requestAnimationFrame and translates raw
 * buttons/axes into semantic actions. Directions (d-pad + left stick)
 * get hold-to-repeat with an initial delay (DAS-style), every other
 * button fires on the pressed edge only.
 *
 * Sampling is throttled to MIN_SAMPLE_INTERVAL_MS and suspended entirely
 * while the document is hidden. rAF runs at the display refresh rate, so on
 * a 240Hz panel an ungated loop makes 240 navigator.getGamepads() device
 * enumerations a second — and keeps making them while the window merely
 * sits behind another one, because WebView2 only throttles rAF for a
 * minimised window, not an occluded one.
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

// Minimum gap between real pad reads (~125Hz). Still 15x faster than
// REPEAT_INTERVAL_MS, so edge detection and hold-to-repeat behave
// identically, but the cost stops scaling with the monitor's refresh rate.
const MIN_SAMPLE_INTERVAL_MS = 8

/** Best-effort controller family from the gamepad id string. */
export function detectPadType(id = '') {
  const s = id.toLowerCase()
  // Note: a bare "Wireless Controller" id is NOT treated as PlayStation —
  // many generic pads report that string but have Xbox-style face buttons;
  // genuine Sony pads carry the 054c vendor id in the id string anyway.
  if (
    s.includes('dualsense') ||
    s.includes('dualshock') ||
    s.includes('054c') || // Sony vendor id
    s.includes('playstation')
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
    this._lastSample = 0
    // Set when resuming from hidden: re-read the held state without emitting,
    // so a button held across the pause cannot fire a phantom edge.
    this._needsBaseline = false
    this._poll = this._poll.bind(this)
    this._onVisibility = this._onVisibility.bind(this)
  }

  start() {
    if (this.rafId != null) return
    document.addEventListener('visibilitychange', this._onVisibility)
    if (!document.hidden) this.rafId = requestAnimationFrame(this._poll)
  }

  stop() {
    document.removeEventListener('visibilitychange', this._onVisibility)
    if (this.rafId != null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    this.prevPressed = {}
    this.dirState = { up: null, down: null, left: null, right: null }
    this._needsBaseline = false
  }

  /** Suspend polling while hidden; resume and re-baseline when shown again. */
  _onVisibility() {
    if (document.hidden) {
      if (this.rafId != null) cancelAnimationFrame(this.rafId)
      this.rafId = null
      return
    }
    if (this.rafId == null) {
      this._needsBaseline = true
      this._lastSample = 0
      this.rafId = requestAnimationFrame(this._poll)
    }
  }

  _poll(ts) {
    // rAF itself is cheap; navigator.getGamepads() is not, so gate the read.
    if (ts - this._lastSample < MIN_SAMPLE_INTERVAL_MS) {
      this.rafId = requestAnimationFrame(this._poll)
      return
    }
    this._lastSample = ts

    // Indexed scan instead of Array.from(...).find(...): this runs ~125x a
    // second and the intermediate array was pure GC churn.
    const pads = navigator.getGamepads?.()
    let pad = null
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        if (pads[i]?.connected) {
          pad = pads[i]
          break
        }
      }
    }

    if (pad) {
      if (!this.connected) {
        this.connected = true
        this.padType = detectPadType(pad.id)
        this.onConnectionChange?.({ connected: true, padType: this.padType })
        // Baseline whatever is already held (e.g. the Start press that
        // entered Console Mode) so it can't fire as a fresh edge.
        this._baseline(pad)
        this._needsBaseline = false
      } else if (this._needsBaseline) {
        this._baseline(pad)
        this._needsBaseline = false
      } else {
        this._readPad(pad)
      }
    } else if (this.connected) {
      this.connected = false
      this.padType = null
      this.prevPressed = {}
      this.dirState = { up: null, down: null, left: null, right: null }
      this._needsBaseline = false
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
