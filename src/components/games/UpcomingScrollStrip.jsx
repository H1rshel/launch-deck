import { useRef, useEffect, useState, useCallback, Children } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Horizontal scroller with chevron navigation and edge fade masks.
 *
 * - Replaces the previous scrollbar with premium chevron buttons.
 * - Chevrons only appear when scroll is available in that direction.
 * - Scroll amount = ~2.5 cards per click (computed from first child's width).
 * - Smooth scrolling via `scrollTo({ behavior: 'smooth' })`.
 * - Edge fade masks communicate scroll affordance without a scrollbar.
 *
 * Children are rendered in a flex row; each child is responsible for its
 * own width. The strip itself does not constrain child sizes.
 */
export default function UpcomingScrollStrip({ children, ariaLabel = 'Scrollable content' }) {
  const trackRef = useRef(null)
  const [canScrollLeft,  setCanScrollLeft]  = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setCanScrollLeft(scrollLeft > 4)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 4)
  }, [])

  // Measure on mount + on child count changes + on resize
  useEffect(() => {
    updateScrollState()
    const el = trackRef.current
    if (!el) return

    const onScroll = () => updateScrollState()
    el.addEventListener('scroll', onScroll, { passive: true })

    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)

    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [updateScrollState, Children.count(children)])

  const scrollBy = useCallback((direction) => {
    const el = trackRef.current
    if (!el) return
    // Step = approx 2.5 card widths. Fall back to 70% of viewport width.
    const firstCard = el.querySelector(':scope > *')
    const cardWidth = firstCard ? firstCard.getBoundingClientRect().width + 16 : el.clientWidth * 0.7
    const step = Math.max(200, cardWidth * 2.5)
    el.scrollBy({ left: direction * step, behavior: 'smooth' })
  }, [])

  // When either edge is scrollable, show the corresponding fade mask.
  const wrapperClass = [
    'upcoming-strip',
    canScrollLeft  ? 'upcoming-strip--has-left'  : '',
    canScrollRight ? 'upcoming-strip--has-right' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={wrapperClass}>
      <button
        type="button"
        className={`upcoming-strip__chev upcoming-strip__chev--left ${canScrollLeft ? 'is-visible' : ''}`}
        onClick={() => scrollBy(-1)}
        aria-label="Scroll left"
        tabIndex={canScrollLeft ? 0 : -1}
      >
        <ChevronLeft size={18} strokeWidth={2.5} />
      </button>

      <div
        ref={trackRef}
        className="upcoming-strip__track"
        aria-label={ariaLabel}
        role="list"
      >
        {children}
      </div>

      <button
        type="button"
        className={`upcoming-strip__chev upcoming-strip__chev--right ${canScrollRight ? 'is-visible' : ''}`}
        onClick={() => scrollBy(1)}
        aria-label="Scroll right"
        tabIndex={canScrollRight ? 0 : -1}
      >
        <ChevronRight size={18} strokeWidth={2.5} />
      </button>
    </div>
  )
}
