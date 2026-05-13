import { useState, useMemo, useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import TopBar from "../components/layout/TopBar"
import { useAuth } from "../hooks/useAuth"
import { useGameContext } from "../context/GameContext"
import { useProfileAvatar } from "../hooks/useProfileAvatar"
import AvatarManager from "../components/profile/AvatarManager"
import { getGameImages } from "../utils/imageHandler"
import { getProfileRank, RANK_LIST } from "../lib/profileRank"
import {
  Gamepad2,
  Clock,
  Calendar,
  Camera,
  Pencil,
  Check,
  X,
  Heart,
  Play,
  History,
  Trophy,
  Loader2,
} from "lucide-react"

function formatDate(dateString) {
  if (!dateString) return "N/A"
  const d = new Date(dateString)
  if (isNaN(d.getTime())) return "N/A"
  const dd = String(d.getDate()).padStart(2, "0")
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

function formatMinutes(minutes) {
  if (!minutes || minutes < 1) return "0h"
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

const RANK_EMBLEMS = {
  Newcomer: "🎮",
  Player: "🕹️",
  Regular: "⚔️",
  Dedicated: "🛡️",
  Veteran: "🏅",
  Elite: "💎",
  Master: "👑",
  Legend: "🔱",
}

export default function Profile() {
  const { user, profile, updateProfile } = useAuth()
  const { games, loading, playGame } = useGameContext()
  const navigate = useNavigate()

  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState("")
  const [isAvatarManagerOpen, setIsAvatarManagerOpen] = useState(false)
  const [rankPanelPos, setRankPanelPos] = useState(null)
  const progressRef = useRef(null)
  const hideTimeoutRef = useRef(null)

  function handleProgressEnter() {
    clearTimeout(hideTimeoutRef.current)
    if (progressRef.current) {
      const rect = progressRef.current.getBoundingClientRect()
      setRankPanelPos({ top: rect.bottom + 6, left: rect.left })
    }
  }

  function handleProgressLeave() {
    hideTimeoutRef.current = setTimeout(() => setRankPanelPos(null), 80)
  }

  const displayName =
    profile?.username || user?.user_metadata?.full_name || "Gamer"

  const { avatarUrl, isResolving } = useProfileAvatar()
  const email = user?.email

  const totalPlaytime = games.reduce(
    (sum, g) => sum + (g.playtime_minutes || 0),
    0,
  )
  const favoriteGames = games.filter((g) => g.favorite)
  const recentGames = [...games]
    .filter((g) => g.lastPlayed)
    .sort((a, b) => new Date(b.lastPlayed) - new Date(a.lastPlayed))
    .slice(0, 10)

  const rankData = useMemo(() => getProfileRank(games), [games])

  const topPlayed = useMemo(() => {
    return [...games]
      .filter((g) => g.playtime_minutes > 0)
      .sort((a, b) => (b.playtime_minutes || 0) - (a.playtime_minutes || 0))
      .slice(0, 3)
  }, [games])

  const heroBgImage = useMemo(() => {
    const bg = topPlayed[0] || favoriteGames[0] || null
    if (!bg) return null
    const { hero, cover } = getGameImages(bg)
    return hero || cover || null
  }, [topPlayed, favoriteGames])

  // Score feedback animation — show "+X pts" when score changes
  const [scoreDelta, setScoreDelta] = useState(null)
  const prevScoreRef = useRef(rankData.finalScore)
  useEffect(() => {
    const prev = prevScoreRef.current
    prevScoreRef.current = rankData.finalScore
    if (prev !== null && rankData.finalScore > prev) {
      setScoreDelta(rankData.finalScore - prev)
      const t = setTimeout(() => setScoreDelta(null), 2000)
      return () => clearTimeout(t)
    }
  }, [rankData.finalScore])

  function startEditName() {
    setNameInput(displayName)
    setEditingName(true)
  }

  async function saveName() {
    if (nameInput.trim() && nameInput.trim() !== displayName) {
      await updateProfile({ username: nameInput.trim() })
    }
    setEditingName(false)
  }

  return (
    <div className="page profile">
      <TopBar />
      <div className="page__content">
        {/* ── Hero ── */}
        <div className="profile__hero">
          {heroBgImage && (
            <div
              className="profile__hero-art"
              style={{ backgroundImage: `url(${heroBgImage})` }}
            />
          )}
          <div className="profile__hero-bg" />
          <div className="profile__avatar-section">
            <div
              className="profile__avatar-wrapper"
              role="button"
              tabIndex={0}
              onClick={() => setIsAvatarManagerOpen(true)}
            >
              {isResolving ? (
                <div
                  className="profile__avatar profile__avatar--placeholder"
                  style={{ opacity: 0.5 }}
                >
                  <Loader2 size={32} className="spinning" />
                </div>
              ) : avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt="Avatar"
                  className="profile__avatar"
                  onError={(e) => {
                    e.target.style.display = "none"
                    e.target.nextSibling.style.display = "flex"
                  }}
                />
              ) : (
                <div className="profile__avatar profile__avatar--placeholder">
                  {(displayName || email)?.[0]?.toUpperCase() || "?"}
                </div>
              )}
              <div className="profile__avatar-overlay">
                <Camera size={18} />
              </div>
            </div>

            <div className="profile__info">
              {editingName ? (
                <div className="profile__edit-row">
                  <input
                    className="profile__name-input"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveName()
                      if (e.key === "Escape") setEditingName(false)
                    }}
                  />
                  <button className="profile__edit-btn" onClick={saveName}>
                    <Check size={14} />
                  </button>
                  <button
                    className="profile__edit-btn"
                    onClick={() => setEditingName(false)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div className="profile__name-row">
                  <h1 className="profile__name">{displayName}</h1>
                  <button
                    className="profile__edit-icon"
                    onClick={startEditName}
                    title="Edit name"
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              )}
              <p className="profile__email">{email}</p>
              <div className="profile__rank-block">
                <span
                  className={`profile__rank-badge${rankData.rank === "Legend" ? " profile__rank-badge--legend" : ""}`}
                >
                  <span className="profile__rank-badge-emblem">
                    {RANK_EMBLEMS[rankData.rank]}
                  </span>
                  {rankData.rank}
                  {scoreDelta !== null && (
                    <span className="profile__rank-score-delta">
                      +{scoreDelta} pts
                    </span>
                  )}
                </span>

                <div
                  ref={progressRef}
                  className="profile__rank-glass-panel"
                  onMouseEnter={handleProgressEnter}
                  onMouseLeave={handleProgressLeave}
                >
                  {/* ── Total Points hero ── */}
                  <div className="profile__rank-total">
                    <span className="profile__rank-total-label">
                      TOTAL POINTS
                    </span>
                    <div className="profile__rank-total-score">
                      <span className="profile__rank-total-value">
                        {rankData.finalScore}
                      </span>
                      <span className="profile__rank-total-unit">pts</span>
                    </div>
                  </div>

                  {/* ── Score breakdown ── */}
                  {rankData.finalScore > 0 && (
                    <div className="profile__rank-breakdown">
                      <div
                        className="profile__rank-breakdown-row"
                        data-tooltip="Total playtime across all games"
                      >
                        <span className="profile__rank-breakdown-label">
                          Experience
                        </span>
                        <span className="profile__rank-breakdown-value profile__rank-breakdown-value--primary">
                          {rankData.experienceScore} pts
                        </span>
                      </div>
                      <div
                        className="profile__rank-breakdown-row"
                        data-tooltip={`${rankData.activeGamesCount} active games × 6 pts each (30+ min played)`}
                      >
                        <span className="profile__rank-breakdown-label">
                          Game Variety
                        </span>
                        <span className="profile__rank-breakdown-value">
                          +{rankData.breadthScore} pts
                        </span>
                      </div>
                      {rankData.launchDeckBonus > 0 && (
                        <div
                          className="profile__rank-breakdown-row"
                          data-tooltip="Bonus for playtime tracked inside Launch Deck"
                        >
                          <span className="profile__rank-breakdown-label">
                            Tracked
                          </span>
                          <span className="profile__rank-breakdown-value profile__rank-breakdown-value--dim">
                            +{rankData.launchDeckBonus} pts
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Progress bar ── */}
                  <div className="profile__rank-progress-section">
                    <div
                      className={`profile__rank-progress-track${!rankData.nextRank ? " profile__rank-progress-track--max" : ""}`}
                      data-next-rank={rankData.nextRank || ""}
                    >
                      <div
                        className="profile__rank-progress-fill"
                        style={{
                          width: `${rankData.progressWithinRankPercent}%`,
                        }}
                      />
                    </div>
                    <div className="profile__rank-progress-footer">
                      <span
                        className={`profile__rank-label-pts${!rankData.nextRank ? " profile__rank-label-pts--max" : ""}`}
                      >
                        {rankData.nextRank
                          ? `Next Rank: ${rankData.nextRank} · ${rankData.pointsToNextRank} pts remaining`
                          : "Maximum Rank Achieved"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {favoriteGames.length >= 5 && (
                <div className="profile__badges" style={{ marginTop: 8 }}>
                  <span className="profile__badge profile__badge--gold">
                    Collector
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <AvatarManager
          isOpen={isAvatarManagerOpen}
          onClose={() => setIsAvatarManagerOpen(false)}
        />

        {/* ── Stats row ── */}
        <div className="profile__stats">
          <div className="stat-card">
            <div className="stat-card__icon-wrap stat-card__icon-wrap--cyan">
              <Gamepad2 size={20} />
            </div>
            <div className="stat-card__info">
              <span className="stat-card__value">{games.length}</span>
              <span className="stat-card__label">Library Size</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-card__icon-wrap stat-card__icon-wrap--purple">
              <Clock size={20} />
            </div>
            <div className="stat-card__info">
              <span className="stat-card__value">
                {formatMinutes(totalPlaytime)}
              </span>
              <span className="stat-card__label">Total Playtime</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-card__icon-wrap stat-card__icon-wrap--pink">
              <Heart size={20} />
            </div>
            <div className="stat-card__info">
              <span className="stat-card__value">{favoriteGames.length}</span>
              <span className="stat-card__label">Favorites</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-card__icon-wrap stat-card__icon-wrap--green">
              <Calendar size={20} />
            </div>
            <div className="stat-card__info">
              <span className="stat-card__value">
                {formatDate(user?.created_at)}
              </span>
              <span className="stat-card__label">Member Since</span>
            </div>
          </div>
        </div>

        {/* ── Most Played ── */}
        {topPlayed.length > 0 && (
          <>
            <h2 className="page__subtitle">
              <Trophy size={18} style={{ color: "var(--accent-amber)" }} />
              Most Played
            </h2>
            <div className="profile__top-played">
              {topPlayed.map((game, i) => {
                const { cover, hero } = getGameImages(game)
                const bgImage = hero || cover
                return (
                  <div
                    key={game.id}
                    className="profile__top-card"
                    onClick={() => navigate(`/game/${game.id}`)}
                  >
                    <div
                      className="profile__top-card-bg"
                      style={
                        bgImage
                          ? {
                              backgroundImage: `url(${bgImage})`,
                              backgroundSize: "cover",
                              backgroundPosition: "center",
                            }
                          : { background: game.gradient }
                      }
                    />
                    <div className="profile__top-card-content">
                      <span className="profile__top-rank">#{i + 1}</span>
                      <div className="profile__top-card-info">
                        <span className="profile__top-title">
                          {game.displayTitle}
                        </span>
                        <div className="profile__top-card-meta">
                          <span className="profile__top-time">
                            {formatMinutes(game.playtime_minutes)}
                          </span>
                          {game.lastPlayed && (
                            <span className="profile__top-last">
                              · {formatDate(game.lastPlayed)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="profile__top-card-actions">
                      <button
                        className="profile__top-action-btn profile__top-action-btn--play"
                        onClick={(e) => {
                          e.stopPropagation()
                          playGame(game)
                        }}
                      >
                        <Play size={11} fill="currentColor" /> Play
                      </button>
                      <button
                        className="profile__top-action-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate(`/game/${game.id}`)
                        }}
                      >
                        Details
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ── Recently Played ── */}
        {recentGames.length > 0 && (
          <>
            <h2 className="page__subtitle">
              <History size={18} style={{ color: "#22c55e" }} />
              Recently Played
            </h2>
            <div className="profile__recent">
              {recentGames.map((game) => {
                const { cover } = getGameImages(game)
                return (
                  <div
                    key={game.id}
                    className="profile__recent-card"
                    onClick={() => navigate(`/game/${game.id}`)}
                  >
                    <div
                      className="profile__recent-cover"
                      style={
                        cover
                          ? {
                              backgroundImage: `url(${cover})`,
                              backgroundSize: "cover",
                              backgroundPosition: "center",
                            }
                          : { background: game.gradient }
                      }
                    />
                    <div className="profile__recent-info">
                      <span className="profile__recent-title">
                        {game.displayTitle}
                      </span>
                      <span className="profile__recent-meta">
                        {formatDate(game.lastPlayed)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ── Favorite Games ── */}
        {favoriteGames.length > 0 && (
          <>
            <h2 className="page__subtitle">
              <Heart size={18} style={{ color: "#ec4899" }} />
              Favorite Games
            </h2>
            <div className="profile__favorites">
              {favoriteGames.slice(0, 6).map((game) => {
                const { cover, hero } = getGameImages(game)
                const bgImage = cover || hero
                return (
                  <div
                    key={game.id}
                    className="profile__fav-card"
                    onClick={() => navigate(`/game/${game.id}`)}
                  >
                    <div
                      className="profile__fav-card-bg"
                      style={
                        bgImage
                          ? {
                              backgroundImage: `url(${bgImage})`,
                              backgroundSize: "cover",
                              backgroundPosition: "center",
                            }
                          : { background: game.gradient }
                      }
                    />
                    <div className="profile__fav-card-content">
                      <span className="profile__fav-title">
                        {game.displayTitle}
                      </span>
                      {game.playtime && (
                        <span className="profile__fav-time">
                          {game.playtime}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* Empty state */}
        {!loading && games.length === 0 && (
          <div className="profile__empty" style={{ marginTop: 48 }}>
            <Gamepad2 size={36} />
            <p>No games yet</p>
            <span>Scan folders to add games to your library</span>
          </div>
        )}
      </div>

      {/* ── Rank panel (hover portal) ── */}
      {rankPanelPos &&
        createPortal(
          <div
            className="profile__rank-panel"
            style={{ top: rankPanelPos.top, left: rankPanelPos.left }}
            onMouseEnter={() => clearTimeout(hideTimeoutRef.current)}
            onMouseLeave={() => setRankPanelPos(null)}
          >
            <div className="profile__rank-panel-title">Rank Progression</div>
            <div className="profile__rank-panel-ranks">
              {RANK_LIST.map((r, i) => {
                const isCurrentRank = r.name === rankData.rank
                const isAchieved = rankData.finalScore >= r.minScore
                const nextR = RANK_LIST[i + 1]
                const rangeLabel = nextR
                  ? `${r.minScore}–${nextR.minScore - 1}`
                  : `${r.minScore}+`
                return (
                  <div
                    key={r.name}
                    className={[
                      "profile__rank-panel-item",
                      isCurrentRank ? "profile__rank-panel-item--current" : "",
                      !isCurrentRank && isAchieved
                        ? "profile__rank-panel-item--achieved"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <span className="profile__rank-panel-dot" />
                    <span className="profile__rank-panel-name">{r.name}</span>
                    <span className="profile__rank-panel-range">
                      {rangeLabel}
                    </span>
                    {isCurrentRank && (
                      <span className="profile__rank-panel-you">you</span>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="profile__rank-panel-stats">
              <div className="profile__rank-panel-stats-title">Your Score</div>
              <div className="profile__rank-panel-stats-row">
                <span className="profile__rank-panel-stat profile__rank-panel-stat--total">
                  {rankData.finalScore} pts
                </span>
              </div>
              {rankData.finalScore > 0 && (
                <div className="profile__rank-panel-stats-breakdown">
                  <div className="profile__rank-panel-stats-breakdown-row">
                    <span>Experience</span>
                    <span>{rankData.experienceScore}</span>
                  </div>
                  {rankData.breadthScore > 0 && (
                    <div className="profile__rank-panel-stats-breakdown-row">
                      <span>Game Variety</span>
                      <span>+{rankData.breadthScore}</span>
                    </div>
                  )}
                  {rankData.launchDeckBonus > 0 && (
                    <div className="profile__rank-panel-stats-breakdown-row profile__rank-panel-stats-breakdown-row--dim">
                      <span>Tracked</span>
                      <span>+{rankData.launchDeckBonus}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="profile__rank-panel-footer">
              <div className="profile__rank-panel-footer-title">Formula</div>
              <div className="profile__rank-panel-footer-formula">
                hours{rankData.totalPlaytimeHours < 20 ? " × 1.5" : ""} + games
                × 6 + tracked bonus
              </div>
              <div className="profile__rank-panel-footer-note">
                Active = ≥ 30 min played · Tracked = Launch Deck hours × 0.5
                {rankData.totalPlaytimeHours < 20 && " · Early boost active"}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
