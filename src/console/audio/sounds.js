/**
 * Console Mode sound engine.
 *
 * Nav/selection cues are decoded once into Web Audio buffers so they fire
 * with zero latency. Distinct cues are derived from the same samples via
 * playback rate + gain so we don't need extra assets:
 *   nav    — small tick when moving focus
 *   select — confirm
 *   back   — confirm pitched down
 *   open   — confirm pitched up slightly (overlays opening)
 */
import gameNavSfx from '../../assets/sounds/game-nav.wav'
import selectionSfx from '../../assets/sounds/selection.wav'

const SOUNDS_KEY = 'ld_console_sounds'

let ctx = null
let buffers = { nav: null, select: null }
let enabled = readEnabled()

function readEnabled() {
  try {
    return JSON.parse(localStorage.getItem(SOUNDS_KEY) ?? 'true')
  } catch {
    return true
  }
}

export function soundsEnabled() {
  return enabled
}

export function setSoundsEnabled(value) {
  enabled = !!value
  try {
    localStorage.setItem(SOUNDS_KEY, JSON.stringify(enabled))
  } catch {}
}

export function initSounds() {
  if (ctx) return
  ctx = new AudioContext()
  const load = (url, key) =>
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { buffers[key] = buf })
      .catch(() => {})
  load(gameNavSfx, 'nav')
  load(selectionSfx, 'select')
}

export function disposeSounds() {
  if (ctx) {
    ctx.close().catch(() => {})
    ctx = null
    buffers = { nav: null, select: null }
  }
}

const CUES = {
  nav: { buffer: 'nav', rate: 1, gain: 0.9 },
  select: { buffer: 'select', rate: 1, gain: 1 },
  back: { buffer: 'select', rate: 0.82, gain: 0.75 },
  open: { buffer: 'select', rate: 1.12, gain: 0.85 },
}

export function playSfx(name) {
  if (!enabled || !ctx) return
  const cue = CUES[name]
  const buf = cue && buffers[cue.buffer]
  if (!buf) return
  if (ctx.state === 'suspended') ctx.resume()
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = cue.rate
  const gain = ctx.createGain()
  gain.gain.value = cue.gain
  src.connect(gain)
  gain.connect(ctx.destination)
  src.start(0)
}
