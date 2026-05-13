import { useState, useCallback, useEffect } from 'react'
import { X, Trash2, ChevronRight } from 'lucide-react'
import { FEEDBACK_REASON_LABELS } from '../../lib/executableNorm'

/**
 * Modal shown when the user removes a game or rejects a detected EXE candidate.
 * Collects a reason (and optional free-text for "Other") before finalizing removal.
 *
 * @param {{
 *   game: { displayTitle?: string, title: string, install_path?: string } | null,
 *   onConfirm: (reason: string, details: string|null) => void,
 *   onCancel: () => void,
 * }} props
 */
export default function DeleteFeedbackModal({ game, onConfirm, onCancel }) {
  const [selected, setSelected] = useState(null)
  const [details, setDetails] = useState('')
  const [closing, setClosing] = useState(false)

  // Reset state whenever the modal opens for a new game
  useEffect(() => {
    setSelected(null)
    setDetails('')
    setClosing(false)
  }, [game])

  const animateOut = useCallback((callback) => {
    setClosing(true)
    setTimeout(callback, 220)
  }, [])

  const handleConfirm = useCallback(() => {
    if (!selected) return
    animateOut(() => onConfirm(selected, selected === 'Other' ? (details.trim() || null) : null))
  }, [selected, details, animateOut, onConfirm])

  const handleCancel = useCallback(() => {
    animateOut(onCancel)
  }, [animateOut, onCancel])

  // Keyboard handling
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') handleCancel()
      if (e.key === 'Enter' && selected) handleConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleCancel, handleConfirm, selected])

  if (!game) return null

  const title = game.displayTitle || game.title || 'this game'

  return (
    <div
      className={`delete-modal__backdrop${closing ? ' delete-modal__backdrop--closing' : ''}`}
      onClick={handleCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Remove game"
    >
      <div
        className={`delete-modal${closing ? ' delete-modal--closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="delete-modal__header">
          <div className="delete-modal__header-left">
            <Trash2 size={16} className="delete-modal__trash-icon" />
            <h2 className="delete-modal__title">Remove Game</h2>
          </div>
          <button
            className="delete-modal__close"
            onClick={handleCancel}
            aria-label="Cancel"
          >
            <X size={17} />
          </button>
        </div>

        {/* ── Prompt ── */}
        <p className="delete-modal__prompt">
          Why are you removing{' '}
          <span className="delete-modal__game-name">&ldquo;{title}&rdquo;</span>?
        </p>

        {/* ── Reason list ── */}
        <div className="delete-modal__reasons" role="radiogroup" aria-label="Removal reason">
          {FEEDBACK_REASON_LABELS.map((label) => (
            <button
              key={label}
              role="radio"
              aria-checked={selected === label}
              className={`delete-modal__reason${selected === label ? ' delete-modal__reason--active' : ''}`}
              onClick={() => setSelected(label)}
            >
              <span className="delete-modal__reason-radio">
                {selected === label && (
                  <span className="delete-modal__reason-radio-dot" />
                )}
              </span>
              <span className="delete-modal__reason-label">{label}</span>
              {selected === label && label !== 'Other' && (
                <ChevronRight size={13} className="delete-modal__reason-check" />
              )}
            </button>
          ))}
        </div>

        {/* ── "Other" free-text field ── */}
        {selected === 'Other' && (
          <div className="delete-modal__other-wrap">
            <textarea
              className="delete-modal__other-input"
              placeholder="Optional: tell us more…"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={2}
              maxLength={500}
              autoFocus
            />
          </div>
        )}

        {/* ── Footer ── */}
        <div className="delete-modal__footer">
          <button className="delete-modal__btn delete-modal__btn--cancel" onClick={handleCancel}>
            Keep Game
          </button>
          <button
            className="delete-modal__btn delete-modal__btn--confirm"
            onClick={handleConfirm}
            disabled={!selected}
          >
            Remove Game
          </button>
        </div>
      </div>
    </div>
  )
}
