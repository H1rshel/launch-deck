import { Link } from 'react-router-dom'
import { Bell, BellOff, Check } from 'lucide-react'
import { useCountdown } from '../../hooks/useCountdown'
import { useAuth } from '../../hooks/useAuth'

// ── Platform display helpers ──────────────────────────────────────────────────

const PLATFORM_ABBREV = {
  'PC (Microsoft Windows)': 'PC',
  'PC': 'PC',
  'PlayStation 5': 'PS5',
  'PlayStation 4': 'PS4',
  'PlayStation 3': 'PS3',
  'Xbox Series X|S': 'XSX',
  'Xbox Series X': 'XSX',
  'Xbox One': 'XB1',
  'Nintendo Switch': 'NSW',
  'Nintendo Switch 2': 'NSW2',
  'iOS': 'iOS',
  'Android': 'AND',
  'macOS': 'MAC',
  'Linux': 'LNX',
}

function abbreviatePlatform(p) {
  if (!p) return ''
  return PLATFORM_ABBREV[p] ?? p.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 4)
}

function normalizePlatforms(platforms) {
  if (!platforms) return []
  if (Array.isArray(platforms)) return platforms
  if (typeof platforms === 'string') {
    try { return JSON.parse(platforms) } catch { return [platforms] }
  }
  return []
}

// ── Date formatting ───────────────────────────────────────────────────────────

function formatReleaseDate(dateStr, precision) {
  if (!dateStr) return 'TBA'
  const d = new Date(dateStr)
  if (isNaN(d)) return 'TBA'
  if (precision === 'year')  return d.getFullYear().toString()
  if (precision === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Countdown display ─────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0') }

function CountdownDisplay({ releaseDate }) {
  const { days, hours, minutes, seconds, released, totalMs } = useCountdown(releaseDate)

  if (released) {
    return (
      <div className="upcoming-card__countdown upcoming-card__countdown--released">
        <span className="upcoming-card__available">Available Now</span>
      </div>
    )
  }

  const modClass =
    totalMs < 3_600_000  ? 'upcoming-card__countdown--urgent' :
    totalMs < 86_400_000 ? 'upcoming-card__countdown--soon'   : ''

  return (
    <div className={`upcoming-card__countdown ${modClass}`} aria-label="Time until release">
      {days > 0 && (
        <span className="upcoming-card__unit">
          <strong>{days}</strong><small>d</small>
        </span>
      )}
      <span className="upcoming-card__unit">
        <strong>{pad(hours)}</strong><small>h</small>
      </span>
      <span className="upcoming-card__unit">
        <strong>{pad(minutes)}</strong><small>m</small>
      </span>
      {days === 0 && (
        <span className="upcoming-card__unit">
          <strong>{pad(seconds)}</strong><small>s</small>
        </span>
      )}
    </div>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────

export default function UpcomingGameCard({ game, isFollowed, onToggleFollow, deal = null }) {
  const { user } = useAuth()

  const platforms  = normalizePlatforms(game.platforms)
  const coverUrl   = game.cover_url ?? game.banner_url ?? null
  const title      = game.name ?? game.title ?? 'Unknown Game'
  const releaseDate = game.release_date ?? null
  const developer  = Array.isArray(game.developer_names) && game.developer_names.length > 0
    ? game.developer_names[0] : null
  const franchise  = game.franchise_name ?? null

  const totalMs  = releaseDate ? new Date(releaseDate).getTime() - Date.now() : Infinity
  const isSoon   = totalMs < 86_400_000 && totalMs > 0
  const isUrgent = totalMs < 3_600_000  && totalMs > 0

  const cardClass = [
    'upcoming-card',
    isSoon     ? 'upcoming-card--soon'     : '',
    isUrgent   ? 'upcoming-card--urgent'   : '',
    isFollowed ? 'upcoming-card--followed' : '',
  ].filter(Boolean).join(' ')

  const detailHref = `/upcoming/${game.source}/${encodeURIComponent(game.source_game_id)}`

  // Follow click must not navigate — trap the event.
  const handleFollowClick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onToggleFollow(game)
  }

  return (
    <Link 
      to={detailHref} 
      state={{ searchResult: game }} 
      className={cardClass} 
      aria-label={`${title} — view details`}
    >

      {/* ── Cover ── */}
      <div className="upcoming-card__cover">
        {coverUrl ? (
          <img className="upcoming-card__img" src={coverUrl} alt="" loading="lazy" />
        ) : (
          <div className="upcoming-card__img-placeholder">
            <span>{title[0]?.toUpperCase()}</span>
          </div>
        )}
        <div className="upcoming-card__cover-overlay" />

        {/* Platform badges */}
        {platforms.length > 0 && (
          <div className="upcoming-card__platforms">
            {platforms.slice(0, 3).map((p) => (
              <span key={p} className="upcoming-card__platform-badge">
                {abbreviatePlatform(p)}
              </span>
            ))}
            {platforms.length > 3 && (
              <span className="upcoming-card__platform-badge">+{platforms.length - 3}</span>
            )}
          </div>
        )}

        {/* Followed badge */}
        {isFollowed && (
          <div className="upcoming-card__followed-badge" aria-label="Following">
            <Check size={9} strokeWidth={3} />
          </div>
        )}

        {/* Deal badge */}
        {deal?.onSale && (
          <div className="upcoming-card__deal-badge" aria-label={`${deal.savings}% off`}>
            -{deal.savings}%
          </div>
        )}

        {/* Release date chip */}
        <div className="upcoming-card__date-chip">
          {formatReleaseDate(releaseDate, game.release_date_precision)}
        </div>
      </div>

      {/* ── Info ── */}
      <div className="upcoming-card__info">
        {(franchise || developer) && (
          <p className="upcoming-card__sub">{franchise ?? developer}</p>
        )}

        <h3 className="upcoming-card__title" title={title}>{title}</h3>

        {/* Pinned row: countdown + CTA always at the bottom */}
        <div className="upcoming-card__footer">
          {releaseDate ? (
            <CountdownDisplay releaseDate={releaseDate} />
          ) : (
            <span className="upcoming-card__tba">TBA</span>
          )}

          <button
            type="button"
            className={`upcoming-card__follow-btn ${isFollowed ? 'upcoming-card__follow-btn--active' : ''}`}
            onClick={handleFollowClick}
            disabled={!user}
            title={user ? (isFollowed ? 'Unfollow' : 'Follow') : 'Sign in to follow'}
            aria-label={isFollowed ? 'Unfollow' : 'Follow'}
          >
            {isFollowed ? <BellOff size={12} /> : <Bell size={12} />}
          </button>
        </div>
      </div>
    </Link>
  )
}
