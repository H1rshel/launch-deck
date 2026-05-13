import { useMemo, useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import TopBar from "../components/layout/TopBar"
import PageHeader from "../components/layout/PageHeader"
import {
  Clock,
  Gamepad2,
  TrendingUp,
  Calendar,
  Flame,
  Layers,
  Trophy,
  Activity as ActivityIcon,
} from "lucide-react"
import { useGameContext } from "../context/GameContext"
import { getGameImages } from "../utils/imageHandler"
import { getAllSessions } from "../lib/db"

function formatDate(dateString) {
  if (!dateString) return ""
  const d = new Date(dateString)
  if (isNaN(d.getTime())) return ""
  const dd = String(d.getDate()).padStart(2, "0")
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

function relativeTime(dateString) {
  if (!dateString) return ""
  const d = new Date(dateString)
  if (isNaN(d.getTime())) return ""
  const diffMs = Date.now() - d.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  if (diffSecs < 60) return "Just now"
  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return `${diffDays} days ago`
  return formatDate(dateString)
}

function formatMinutes(minutes) {
  if (!minutes || minutes < 1) return "0m"
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "alltime", label: "All Time" },
]

export default function Activity() {
  const { games, loading } = useGameContext()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState([])
  const [activePeriod, setActivePeriod] = useState("week")

  useEffect(() => {
    getAllSessions()
      .then(setSessions)
      .catch(() => {})
  }, [games])

  // ── Timeline: real sessions + untracked fallback ──────────────────────────
  const sessionTimeline = useMemo(() => {
    const trackedGameIds = new Set(sessions.map((s) => s.game_id))

    const sessionItems = sessions
      .map((s) => {
        const game = games.find((g) => g.id === s.game_id)
        if (!game) return null
        const { cover, hero } = getGameImages(game)
        return {
          key: `session-${s.id}`,
          gameId: game.id,
          title: game.displayTitle,
          type: "session",
          startTime: s.start_time,
          duration: s.duration_minutes,
          gradient: game.gradient,
          coverImage: cover || hero || null,
        }
      })
      .filter(Boolean)

    const untrackedItems = games
      .filter((g) => g.lastPlayed && !trackedGameIds.has(g.id))
      .map((game) => {
        const { cover, hero } = getGameImages(game)
        return {
          key: `game-${game.id}`,
          gameId: game.id,
          title: game.displayTitle,
          type: "untracked",
          startTime: game.lastPlayed,
          duration: null,
          gradient: game.gradient,
          coverImage: cover || hero || null,
        }
      })

    return [...sessionItems, ...untrackedItems].sort(
      (a, b) => new Date(b.startTime) - new Date(a.startTime),
    )
  }, [sessions, games])

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalHours = Math.floor(
    games.reduce(
      (sum, g) =>
        sum + (g.playtime_minutes || 0) + (g.imported_playtime_minutes || 0),
      0,
    ) / 60,
  )

  const weekStats = useMemo(() => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const weekSessions = sessions.filter(
      (s) => new Date(s.start_time) >= weekAgo,
    )
    const weekMinutes = weekSessions.reduce(
      (sum, s) => sum + (s.duration_minutes || 0),
      0,
    )
    const weekGameIds = new Set(weekSessions.map((s) => s.game_id))
    return {
      playtime: formatMinutes(weekMinutes),
      gamesPlayed: weekGameIds.size,
    }
  }, [sessions])

  const avgSessionMins =
    sessions.length > 0
      ? Math.round(
          sessions.reduce((s, r) => s + (r.duration_minutes || 0), 0) /
            sessions.length,
        )
      : 0

  // ── Most Played by period ─────────────────────────────────────────────────
  const topGamesByPeriod = useMemo(() => {
    if (activePeriod === "alltime") {
      return [...games]
        .map((g) => ({
          gameId: g.id,
          game: g,
          minutes:
            (g.playtime_minutes || 0) + (g.imported_playtime_minutes || 0),
          sessionCount: sessions.filter((s) => s.game_id === g.id).length,
        }))
        .filter((item) => item.minutes > 0)
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, 6)
    }

    const cutoff = {
      today: new Date(new Date().setHours(0, 0, 0, 0)).getTime(),
      week: Date.now() - 7 * 24 * 60 * 60 * 1000,
      month: Date.now() - 30 * 24 * 60 * 60 * 1000,
    }[activePeriod]

    const filtered = sessions.filter(
      (s) => new Date(s.start_time).getTime() >= cutoff,
    )
    const byGame = {}
    for (const s of filtered) {
      if (!byGame[s.game_id])
        byGame[s.game_id] = { minutes: 0, sessionCount: 0 }
      byGame[s.game_id].minutes += s.duration_minutes || 0
      byGame[s.game_id].sessionCount += 1
    }

    return Object.entries(byGame)
      .map(([gameId, data]) => ({
        gameId,
        game: games.find((g) => g.id === gameId),
        minutes: data.minutes,
        sessionCount: data.sessionCount,
      }))
      .filter((item) => item.game)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 6)
  }, [sessions, games, activePeriod])

  // ── Group timeline by date ────────────────────────────────────────────────
  const groupedTimeline = useMemo(() => {
    const groups = {}
    for (const item of sessionTimeline) {
      const dateKey = formatDate(item.startTime)
      if (!groups[dateKey]) groups[dateKey] = []
      groups[dateKey].push(item)
    }
    return Object.entries(groups)
  }, [sessionTimeline])

  const maxTopMinutes = topGamesByPeriod[0]?.minutes || 1

  return (
    <div className="page activity page--unified">
      <TopBar />
      <PageHeader
        variant="compact"
        eyebrow="Activity"
        eyebrowIcon={ActivityIcon}
        title="Your Activity"
        subtitle="Track playtime, sessions, and what you've been playing."
        image="/activity.png"
      />
      <div className="page__content">
        {/* ── Stats row (glass container) ── */}
        <div className="glass-panel activity__stats-wrap">
          <div className="activity__stats">
            <div className="stat-card">
              <div className="stat-card__icon-wrap stat-card__icon-wrap--cyan">
                <Gamepad2 size={20} />
              </div>
              <div className="stat-card__info">
                <span className="stat-card__value">{games.length}</span>
                <span className="stat-card__label">Total Games</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card__icon-wrap stat-card__icon-wrap--purple">
                <Clock size={20} />
              </div>
              <div className="stat-card__info">
                <span className="stat-card__value">{totalHours}h</span>
                <span className="stat-card__label">Total Playtime</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card__icon-wrap stat-card__icon-wrap--green">
                <TrendingUp size={20} />
              </div>
              <div className="stat-card__info">
                <span className="stat-card__value">{weekStats.playtime}</span>
                <span className="stat-card__label">This Week</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card__icon-wrap stat-card__icon-wrap--amber">
                <Flame size={20} />
              </div>
              <div className="stat-card__info">
                <span className="stat-card__value">
                  {weekStats.gamesPlayed}
                </span>
                <span className="stat-card__label">Played This Week</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card__icon-wrap stat-card__icon-wrap--pink">
                <Layers size={20} />
              </div>
              <div className="stat-card__info">
                <span className="stat-card__value">{sessions.length}</span>
                <span className="stat-card__label">Total Sessions</span>
              </div>
            </div>
            {avgSessionMins > 0 && (
              <div className="stat-card">
                <div className="stat-card__icon-wrap stat-card__icon-wrap--cyan">
                  <Clock size={20} />
                </div>
                <div className="stat-card__info">
                  <span className="stat-card__value">
                    {formatMinutes(avgSessionMins)}
                  </span>
                  <span className="stat-card__label">Avg. Session</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Most Played (elevated glass container) ── */}
        <div className="glass-panel activity__section activity__section--glass activity__section--highlight">
          <div className="activity__section-head">
            <div className="activity__section-title-row">
              <Trophy size={14} className="activity__section-icon" />
              <h2 className="activity__section-title">Most Played</h2>
            </div>
            <div className="activity__period-tabs">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  className={`activity__period-tab${activePeriod === p.key ? " activity__period-tab--active" : ""}`}
                  onClick={() => setActivePeriod(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {topGamesByPeriod.length === 0 ? (
            <div className="activity__top-empty">
              <span>No sessions tracked for this period</span>
            </div>
          ) : (
            <div className="activity__top-list">
              {topGamesByPeriod.map((item, i) => {
                const { cover, hero } = getGameImages(item.game)
                const img = cover || hero || null
                return (
                  <div
                    key={item.gameId}
                    className="activity__top-item"
                    onClick={() => navigate(`/game/${item.gameId}`)}
                  >
                    <span className="activity__top-rank">#{i + 1}</span>
                    <div
                      className="activity__top-cover"
                      style={
                        img
                          ? {
                              backgroundImage: `url(${img})`,
                              backgroundSize: "cover",
                              backgroundPosition: "center",
                            }
                          : { background: item.game.gradient }
                      }
                    />
                    <div className="activity__top-info">
                      <span className="activity__top-title">
                        {item.game.displayTitle}
                      </span>
                      <div className="activity__top-bar-track">
                        <div
                          className="activity__top-bar-fill"
                          style={{
                            width: `${(item.minutes / maxTopMinutes) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="activity__top-meta">
                      <span className="activity__top-time">
                        {formatMinutes(item.minutes)}
                      </span>
                      {item.sessionCount > 0 && (
                        <span className="activity__top-sessions">
                          {item.sessionCount}{" "}
                          {item.sessionCount === 1 ? "session" : "sessions"}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Recent Sessions timeline (glass container) ── */}
        <div className="glass-panel activity__section activity__section--glass">
          <div className="activity__section-head">
            <div className="activity__section-title-row">
              <Clock size={14} className="activity__section-icon" />
              <h2 className="activity__section-title">Recent Sessions</h2>
            </div>
          </div>

          <div className="activity__timeline">
            {loading ? (
              <div className="activity__empty">
                <p>Loading...</p>
              </div>
            ) : groupedTimeline.length === 0 ? (
              <div className="activity__empty">
                <Calendar size={40} />
                <p>No activity yet</p>
                <span>Launch a game to start tracking your sessions</span>
              </div>
            ) : (
              groupedTimeline.map(([dateLabel, items]) => (
                <div key={dateLabel} className="activity__group">
                  <div className="activity__group-header">
                    <span className="activity__group-date">{dateLabel}</span>
                    <div className="activity__group-line" />
                  </div>
                  {items.map((item) => (
                    <div
                      key={item.key}
                      className="activity__item"
                      onClick={() => navigate(`/game/${item.gameId}`)}
                    >
                      <div
                        className="activity__item-icon"
                        style={
                          item.coverImage
                            ? {
                                backgroundImage: `url(${item.coverImage})`,
                                backgroundSize: "cover",
                                backgroundPosition: "center",
                              }
                            : { background: item.gradient }
                        }
                      />
                      <div className="activity__item-info">
                        <span className="activity__item-title">
                          {item.title}
                        </span>
                        <span className="activity__item-meta">
                          {item.type === "session" && item.duration != null
                            ? `Session · ${formatMinutes(item.duration)}`
                            : "Played"}
                        </span>
                      </div>
                      <span className="activity__item-date">
                        {relativeTime(item.startTime) ||
                          formatDate(item.startTime)}
                      </span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
