import { useEffect, useState } from 'react'
import { BarChart2, Layers, Clock, TrendingUp, Flame } from 'lucide-react'
import { getGameSessions } from '../../lib/db'

function formatMinutes(m) {
  if (!m || m < 1) return '—'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`
}

function shortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function sessionTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function relativeTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${Math.max(mins, 1)}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return shortDate(iso)
}

function computeInsights(sessions, steamTotal) {
  const insights = []
  if (sessions.length === 0) return insights

  const longestSession = Math.max(...sessions.map((s) => s.duration_minutes || 0))
  const totalLocal = sessions.reduce((s, r) => s + (r.duration_minutes || 0), 0)

  // Longest session this month
  const now = new Date()
  const thisMonth = sessions.filter((s) => {
    const d = new Date(s.start_time)
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  })
  if (thisMonth.length > 0) {
    const longestThisMonth = Math.max(...thisMonth.map((s) => s.duration_minutes || 0))
    if (longestThisMonth >= 30) {
      insights.push({
        text: `Longest this month: ${formatMinutes(longestThisMonth)}`,
        type: 'amber',
      })
    }
  }

  // Streak detection — sessions in last 7 days
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const recentSessions = sessions.filter((s) => new Date(s.start_time).getTime() > weekAgo)
  if (recentSessions.length >= 5) {
    insights.push({
      text: `${recentSessions.length} sessions this week`,
      icon: 'flame',
      type: 'green',
    })
  }

  // Average trend
  if (sessions.length >= 4) {
    const recentHalf = sessions.slice(0, Math.floor(sessions.length / 2))
    const olderHalf = sessions.slice(Math.floor(sessions.length / 2))
    const recentAvg = recentHalf.reduce((s, r) => s + (r.duration_minutes || 0), 0) / recentHalf.length
    const olderAvg = olderHalf.reduce((s, r) => s + (r.duration_minutes || 0), 0) / olderHalf.length
    if (olderAvg > 0) {
      const pctChange = Math.round(((recentAvg - olderAvg) / olderAvg) * 100)
      if (Math.abs(pctChange) >= 15) {
        insights.push({
          text: `${pctChange > 0 ? '+' : ''}${pctChange}% vs earlier sessions`,
          type: pctChange > 0 ? 'cyan' : 'amber',
        })
      }
    }
  }

  return insights.slice(0, 2)
}

export default function PlaytimeStats({ game, steamPlaytime = null }) {
  const [sessions, setSessions] = useState([])

  useEffect(() => {
    getGameSessions(game.id).then(setSessions).catch(() => setSessions([]))
  }, [game.id])

  const steamTotal = steamPlaytime || 0

  if (sessions.length === 0 && !steamTotal) {
    return (
      <div className="playtime-stats__empty">
        <BarChart2 size={28} className="playtime-stats__empty-icon" />
        <div className="playtime-stats__empty-text">
          <span className="playtime-stats__empty-title">No sessions yet</span>
          <span className="playtime-stats__empty-sub">Play the game to start tracking your sessions and playtime.</span>
        </div>
      </div>
    )
  }

  const sessionCount = sessions.length
  const totalLocal = sessions.reduce((s, r) => s + (r.duration_minutes || 0), 0)
  const avgSession = sessionCount > 0 ? Math.round(totalLocal / sessionCount) : 0
  const longestSession = sessionCount > 0
    ? Math.max(...sessions.map((s) => s.duration_minutes || 0))
    : 0
  const grandTotal = totalLocal + steamTotal
  const insights = computeInsights(sessions, steamTotal)

  return (
    <div className="playtime-stats">
      <div className="playtime-stats__panel">

        {/* ── 3-stat summary grid ── */}
        <div className="playtime-stats__grid">
          <div className="playtime-stats__item">
            <div className="playtime-stats__icon-wrap">
              <Layers size={16} />
            </div>
            <div className="playtime-stats__item-info">
              <span className="playtime-stats__label">Total Sessions</span>
              <span className="playtime-stats__value">{sessionCount}</span>
            </div>
          </div>
          <div className="playtime-stats__item">
            <div className="playtime-stats__icon-wrap">
              <Clock size={16} />
            </div>
            <div className="playtime-stats__item-info">
              <span className="playtime-stats__label">Avg. Session</span>
              <span className="playtime-stats__value">{formatMinutes(avgSession)}</span>
            </div>
          </div>
          <div className="playtime-stats__item">
            <div className="playtime-stats__icon-wrap">
              <TrendingUp size={16} />
            </div>
            <div className="playtime-stats__item-info">
              <span className="playtime-stats__label">Longest</span>
              <span className="playtime-stats__value">{formatMinutes(longestSession)}</span>
            </div>
          </div>
        </div>

        {/* ── Session history ── */}
        {sessions.length > 0 && (
          <div className="playtime-stats__history">
            {sessions.slice(0, 10).map((s, i) => {
              const pct = longestSession > 0
                ? Math.max((s.duration_minutes / longestSession) * 100, 3)
                : 0
              return (
                <div
                  key={s.id}
                  className="playtime-stats__row"
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <div className="playtime-stats__row-when">
                    <span className="playtime-stats__row-date">{shortDate(s.start_time)}</span>
                    <span className="playtime-stats__row-time">{sessionTime(s.start_time)}</span>
                  </div>
                  <div className="playtime-stats__row-bar">
                    <div
                      className="playtime-stats__row-fill"
                      style={{ width: `${pct}%`, animationDelay: `${200 + i * 80}ms` }}
                    />
                  </div>
                  <span className="playtime-stats__row-dur">{formatMinutes(s.duration_minutes)}</span>
                  <span className="playtime-stats__row-rel">{relativeTime(s.start_time)}</span>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Session insights ── */}
        {insights.length > 0 && (
          <div className="playtime-stats__insights">
            {insights.map((insight, i) => (
              <span
                key={i}
                className={`playtime-stats__insight${insight.type !== 'cyan' ? ` playtime-stats__insight--${insight.type}` : ''}`}
              >
                {insight.icon === 'flame' && <Flame size={11} />}
                {insight.text}
              </span>
            ))}
          </div>
        )}

        {/* ── Steam vs Local footer ── */}
        {steamTotal > 0 && (
          <div className="playtime-stats__sources">
            <div className="playtime-stats__source-bar">
              <div
                className="playtime-stats__source-fill playtime-stats__source-fill--steam"
                style={{ width: grandTotal > 0 ? `${(steamTotal / grandTotal) * 100}%` : '0%' }}
              />
              <div
                className="playtime-stats__source-fill playtime-stats__source-fill--local"
                style={{ width: grandTotal > 0 ? `${(totalLocal / grandTotal) * 100}%` : '0%' }}
              />
            </div>
            <div className="playtime-stats__source-legend">
              <span className="playtime-stats__legend-item playtime-stats__legend-item--steam">
                Steam · {formatMinutes(steamTotal)}
              </span>
              <span className="playtime-stats__legend-item playtime-stats__legend-item--local">
                Local · {formatMinutes(totalLocal)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
