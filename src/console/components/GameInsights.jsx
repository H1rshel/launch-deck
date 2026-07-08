import { Hourglass, Gauge } from 'lucide-react'

export const TIER_COLORS = {
  purple: '#a855f7',
  green: '#00ff88',
  cyan: '#00d4ff',
  amber: '#f5a623',
  orange: '#ff8844',
  red: '#ef4444',
  gray: '#8b99b2',
}

function formatHours(hours) {
  if (!hours || hours <= 0) return null
  return `${hours}h`
}

/**
 * Quiet insights cluster in the hero's bottom-right corner: rig performance
 * verdict + HowLongToBeat times. Editorial rows, no boxes — designed to sit
 * over the artwork without fighting it.
 */
export default function GameInsights({ perf, hltb }) {
  if (!perf && !hltb) return null

  const tierColor = perf ? TIER_COLORS[perf.tierColor] || TIER_COLORS.gray : null

  const hltbRows = hltb
    ? [
        { label: 'Story', value: formatHours(hltb.main) },
        { label: 'Extras', value: formatHours(hltb.mainExtra) },
        { label: '100%', value: formatHours(hltb.completionist) },
      ].filter((r) => r.value)
    : []

  return (
    <div className="cos-insights">
      {perf && (
        <div className="cos-insights__block">
          <span className="cos-insights__head">
            <Gauge size={12} />
            Your Rig
          </span>
          <span className="cos-insights__verdict" style={{ color: tierColor }}>
            <span className="cos-insights__dot" style={{ background: tierColor }} />
            {perf.tier}
          </span>
          <span className="cos-insights__sub">{perf.bestTarget}</span>
        </div>
      )}

      {perf && hltbRows.length > 0 && <div className="cos-insights__divider" />}

      {hltbRows.length > 0 && (
        <div className="cos-insights__block">
          <span className="cos-insights__head">
            <Hourglass size={12} />
            Time to Beat
          </span>
          <div className="cos-insights__rows">
            {hltbRows.map((r) => (
              <span key={r.label} className="cos-insights__row">
                <span className="cos-insights__row-label">{r.label}</span>
                <span className="cos-insights__row-value">{r.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
