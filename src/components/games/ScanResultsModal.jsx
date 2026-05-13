import { useState, useCallback, useRef, useEffect } from 'react'
import { X, Check, FolderOpen, Gamepad2, Loader } from 'lucide-react'

export default function ScanResultsModal({ results, coverMap = {}, scanProgress, scanning, gameCount = 0, onConfirm, onCancel }) {
  const [selected, setSelected] = useState(() =>
    new Set(results.map((_, i) => i))
  )
  const [closing, setClosing] = useState(false)
  const prevLength = useRef(results.length)

  // Auto-select newly added games
  useEffect(() => {
    if (results.length > prevLength.current) {
      setSelected(new Set(results.map((_, i) => i)))
    }
    prevLength.current = results.length
  }, [results.length])

  function toggle(idx) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(results.map((_, i) => i)))
  }

  function selectNone() {
    setSelected(new Set())
  }

  const animateOut = useCallback((callback) => {
    setClosing(true)
    setTimeout(callback, 250)
  }, [])

  function handleConfirm() {
    const chosen = results.filter((_, i) => selected.has(i))
    animateOut(() => onConfirm(chosen))
  }

  function handleCancel() {
    animateOut(onCancel)
  }

  const pct = scanProgress?.total > 0
    ? Math.min(100, Math.round((scanProgress.current / scanProgress.total) * 100))
    : 0

  function getCover(item) {
    const key = item.title.toLowerCase()
    return coverMap[key] || null
  }

  // Two-phase: scanning = progress only, done = game list
  const isScanning = scanning && results.length === 0

  return (
    <div className={`scan-modal__backdrop${closing ? ' scan-modal__backdrop--closing' : ''}`} onClick={handleCancel}>
      <div className={`scan-modal${closing ? ' scan-modal--closing' : ''}${isScanning ? ' scan-modal--compact' : ''}`} onClick={(e) => e.stopPropagation()}>

        {isScanning ? (
          /* ──── Phase 1: Scanning in progress ──── */
          <div className="scan-modal__scanning">
            <div className="scan-modal__scanning-header">
              <Loader size={20} className="scan-modal__spin" />
              <h2 className="scan-modal__title">Scanning for Games</h2>
              <button className="scan-modal__close" onClick={handleCancel}>
                <X size={18} />
              </button>
            </div>

            <div className="scan-modal__scanning-body">
              <div className="scan-modal__scanning-stats">
                <span className="scan-modal__scanning-pct">{pct}%</span>
                <span className="scan-modal__scanning-found">
                  {gameCount} game{gameCount !== 1 ? 's' : ''} found
                </span>
              </div>

              <div className="scan-modal__progress-track">
                <div
                  className="scan-modal__progress-fill scan-modal__progress-fill--active"
                  style={{ width: `${Math.max(2, pct)}%` }}
                />
              </div>

              <p className="scan-modal__scanning-status">
                {scanProgress?.status || 'Preparing...'}
              </p>
            </div>
          </div>
        ) : (
          /* ──── Phase 2: Results ready ──── */
          <>
            <div className="scan-modal__header">
              <h2 className="scan-modal__title">Games Found</h2>
              <span className="scan-modal__count">
                {selected.size} of {results.length} selected
              </span>
              <button className="scan-modal__close" onClick={handleCancel}>
                <X size={18} />
              </button>
            </div>

            {scanning && scanProgress?.total > 0 && (
              <div className="scan-modal__progress">
                <div className="scan-modal__progress-track">
                  <div
                    className="scan-modal__progress-fill scan-modal__progress-fill--active"
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
              </div>
            )}

            <div className="scan-modal__actions-top">
              <button className="scan-modal__link" onClick={selectAll}>Select All</button>
              <button className="scan-modal__link" onClick={selectNone}>Select None</button>
            </div>

            <div className="scan-modal__list">
              {results.map((item, idx) => {
                const cover = getCover(item)
                return (
                  <label key={idx} className={`scan-modal__item ${selected.has(idx) ? 'scan-modal__item--selected' : ''}`} onClick={() => toggle(idx)}>
                    <div className="scan-modal__checkbox">
                      {selected.has(idx) && <Check size={14} />}
                    </div>
                    <div className="scan-modal__item-cover">
                      {cover?.cover_url ? (
                        <img src={cover.cover_url} alt="" className="scan-modal__cover-img" />
                      ) : (
                        <div className="scan-modal__cover-placeholder">
                          <Gamepad2 size={18} />
                        </div>
                      )}
                    </div>
                    <div className="scan-modal__item-info">
                      <span className="scan-modal__item-title">
                        {cover?.name || item.title}
                      </span>
                      <span className="scan-modal__item-path">
                        <FolderOpen size={12} />
                        {item.install_path}
                      </span>
                    </div>
                  </label>
                )
              })}
            </div>

            <div className="scan-modal__footer">
              <button className="scan-modal__btn scan-modal__btn--cancel" onClick={handleCancel}>
                Cancel
              </button>
              <button
                className="scan-modal__btn scan-modal__btn--confirm"
                onClick={handleConfirm}
                disabled={selected.size === 0}
              >
                Add {selected.size} Game{selected.size !== 1 ? 's' : ''}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
