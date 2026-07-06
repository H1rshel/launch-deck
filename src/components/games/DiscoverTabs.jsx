import { Sparkles, Compass, Flame, Diamond, Heart } from 'lucide-react'
import { useTabIndicator } from '../../hooks/useTabIndicator'

export const DISCOVER_TABS = [
  { id: 'for_you',     label: 'For You',      Icon: Sparkles },
  { id: 'top_100',     label: 'Top 100',      Icon: Compass },
  { id: 'trending',    label: 'Trending',     Icon: Flame },
  { id: 'hidden_gems', label: 'Hidden Gems',  Icon: Diamond },
  { id: 'following',   label: 'Following',    Icon: Heart },
]

export default function DiscoverTabs({ active, onChange, counts = {}, size = 'md' }) {
  const { tabRef, indicatorStyle } = useTabIndicator(active)
  return (
    <div ref={tabRef} className={`upcoming-tabs upcoming-tabs--${size}`} role="tablist">
      <span className="tab-slider" style={indicatorStyle} aria-hidden="true" />
      {DISCOVER_TABS.map(({ id, label, Icon }) => {
        const isActive = id === active
        const count = counts[id]
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            data-tab-active={isActive ? 'true' : undefined}
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

