import { Sparkles, Heart, Clock, Flame, Crown, History } from 'lucide-react'

// Tab registry kept in one place so dashboard + /upcoming share it.
export const UPCOMING_TABS = [
  { id: 'forYou',    label: 'For You',    Icon: Sparkles },
  { id: 'following', label: 'Following',  Icon: Heart },
  { id: 'soon',      label: 'Soon',       Icon: Clock },
  { id: 'recent',    label: 'Recently Released', Icon: History },
  { id: 'big',       label: 'Big Releases', Icon: Crown },
  { id: 'popular',   label: 'Popular',    Icon: Flame },
]

/**
 * Segmented tab switcher for Upcoming Releases.
 *
 * Active state is driven externally; parent owns the current tab so the same
 * tab can persist across route changes if desired.
 *
 * `counts` is optional — when provided, a subtle badge renders next to the
 * label (e.g. unread count on Following).
 */
/**
 * `hiddenIds` — tab ids to remove from the list. Used to hide tabs that
 * have no games (e.g. Big Releases when the cache has no AAA titles).
 */
export default function UpcomingTabs({ active, onChange, counts = {}, size = 'md', hiddenIds = [] }) {
  const visible = UPCOMING_TABS.filter(t => !hiddenIds.includes(t.id))
  return (
    <div className={`upcoming-tabs upcoming-tabs--${size}`} role="tablist">
      {visible.map(({ id, label, Icon }) => {
        const isActive = id === active
        const count    = counts[id]
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            className={`upcoming-tabs__btn ${isActive ? 'upcoming-tabs__btn--active' : ''}`}
            onClick={() => onChange(id)}
            type="button"
          >
            <Icon size={14} strokeWidth={2} />
            <span>{label}</span>
            {typeof count === 'number' && count > 0 && (
              <span className="upcoming-tabs__count">{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
