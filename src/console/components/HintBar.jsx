import { useConsoleInput } from '../input/InputProvider'

/**
 * Button glyphs that adapt to the active input device: Xbox / PlayStation
 * face buttons when a controller is connected, keycaps otherwise.
 */

const PAD_GLYPHS = {
  xbox: {
    accept: { text: 'A', cls: 'cos-glyph--face cos-glyph--xa' },
    back: { text: 'B', cls: 'cos-glyph--face cos-glyph--xb' },
    actionX: { text: 'X', cls: 'cos-glyph--face cos-glyph--xx' },
    actionY: { text: 'Y', cls: 'cos-glyph--face cos-glyph--xy' },
    lb: { text: 'LB', cls: 'cos-glyph--shoulder' },
    rb: { text: 'RB', cls: 'cos-glyph--shoulder' },
    lt: { text: 'LT', cls: 'cos-glyph--shoulder' },
    rt: { text: 'RT', cls: 'cos-glyph--shoulder' },
    menu: { text: '≡', cls: 'cos-glyph--face cos-glyph--sys' },
    dirH: { text: '◀ ▶', cls: 'cos-glyph--dir' },
    dirV: { text: '▲ ▼', cls: 'cos-glyph--dir' },
    dir: { text: '✚', cls: 'cos-glyph--dir' },
  },
  ps: {
    accept: { text: '✕', cls: 'cos-glyph--face cos-glyph--ps-cross' },
    back: { text: '○', cls: 'cos-glyph--face cos-glyph--ps-circle' },
    actionX: { text: '□', cls: 'cos-glyph--face cos-glyph--ps-square' },
    actionY: { text: '△', cls: 'cos-glyph--face cos-glyph--ps-tri' },
    lb: { text: 'L1', cls: 'cos-glyph--shoulder' },
    rb: { text: 'R1', cls: 'cos-glyph--shoulder' },
    lt: { text: 'L2', cls: 'cos-glyph--shoulder' },
    rt: { text: 'R2', cls: 'cos-glyph--shoulder' },
    menu: { text: '≡', cls: 'cos-glyph--face cos-glyph--sys' },
    dirH: { text: '◀ ▶', cls: 'cos-glyph--dir' },
    dirV: { text: '▲ ▼', cls: 'cos-glyph--dir' },
    dir: { text: '✚', cls: 'cos-glyph--dir' },
  },
}

const KEY_GLYPHS = {
  accept: { text: 'Enter', cls: 'cos-glyph--key' },
  back: { text: 'Esc', cls: 'cos-glyph--key' },
  actionX: { text: 'F', cls: 'cos-glyph--key' },
  actionY: { text: 'Y', cls: 'cos-glyph--key' },
  lb: { text: 'Q', cls: 'cos-glyph--key' },
  rb: { text: 'E', cls: 'cos-glyph--key' },
  lt: { text: '[', cls: 'cos-glyph--key' },
  rt: { text: ']', cls: 'cos-glyph--key' },
  menu: { text: 'M', cls: 'cos-glyph--key' },
  dirH: { text: '◀ ▶', cls: 'cos-glyph--key' },
  dirV: { text: '▲ ▼', cls: 'cos-glyph--key' },
  dir: { text: 'Arrows', cls: 'cos-glyph--key' },
}

export function ButtonGlyph({ action }) {
  const { gamepadConnected, padType, device } = useConsoleInput()
  const useGamepad = gamepadConnected && device === 'gamepad'
  const set = useGamepad ? PAD_GLYPHS[padType === 'ps' ? 'ps' : 'xbox'] : KEY_GLYPHS
  const glyph = set[action] || { text: action, cls: 'cos-glyph--key' }
  return <span className={`cos-glyph ${glyph.cls}`}>{glyph.text}</span>
}

/**
 * Bottom hint strip. `hints` = [{ action, label }].
 */
export default function HintBar({ hints = [] }) {
  if (!hints.length) return null
  return (
    <div className="cos-hintbar">
      {hints.map((h) => (
        <span key={`${h.action}-${h.label}`} className="cos-hint">
          <ButtonGlyph action={h.action} />
          <span className="cos-hint__label">{h.label}</span>
        </span>
      ))}
    </div>
  )
}
