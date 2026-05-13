import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'

const COLLAPSED_HEIGHT = 160  // px before "Read more"

export default function GameDescription({ summary, storyline }) {
  const [expanded, setExpanded]     = useState(false)
  const [needsToggle, setNeedsToggle] = useState(false)
  const bodyRef = useRef(null)

  const hasStoryline = typeof storyline === 'string' && storyline.trim().length > 0
  const hasSummary   = typeof summary   === 'string' && summary.trim().length > 0

  // Detect if content overflows
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    setNeedsToggle(el.scrollHeight > COLLAPSED_HEIGHT + 24)
  }, [summary, storyline])

  if (!hasSummary && !hasStoryline) return null

  return (
    <div className="ugd-desc">
      <div className="ugd-desc__card">
        <div
          ref={bodyRef}
          className={`ugd-desc__body ${expanded ? 'is-expanded' : ''}`}
          style={!expanded && needsToggle ? { maxHeight: COLLAPSED_HEIGHT } : undefined}
        >
          {hasSummary && (
            <p className="ugd-desc__summary">{summary}</p>
          )}

          {hasStoryline && (
            <>
              <h3 className="ugd-desc__sub">Storyline</h3>
              <p className="ugd-desc__storyline">{storyline}</p>
            </>
          )}
        </div>

        {/* Fade overlay when collapsed */}
        {needsToggle && !expanded && (
          <div className="ugd-desc__fade" aria-hidden="true" />
        )}

        {needsToggle && (
          <button
            type="button"
            className="ugd-desc__toggle"
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? 'Show less' : 'Read more'}
            <ChevronDown
              size={14}
              className={`ugd-desc__chevron ${expanded ? 'is-flipped' : ''}`}
            />
          </button>
        )}
      </div>
    </div>
  )
}
