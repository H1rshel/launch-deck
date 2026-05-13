import { Sparkles, Compass, Flame, Diamond, Heart } from 'lucide-react'

export const DISCOVER_TABS = [
  { id: 'for_you',     label: 'For You',      Icon: Sparkles },
  { id: 'top_100',     label: 'Top 100',      Icon: Compass },
  { id: 'trending',    label: 'Trending',     Icon: Flame },
  { id: 'hidden_gems', label: 'Hidden Gems',  Icon: Diamond },
  { id: 'following',   label: 'Following',    Icon: Heart },
]

export default function DiscoverTabs({ active, onChange, counts = {}, size = 'md' }) {
  return (
    <div className={`upcoming-tabs upcoming-tabs--${size}`} role="tablist">
      {DISCOVER_TABS.map(({ id, label, Icon }) => {
        const isActive = id === active
        const count = counts[id]
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

