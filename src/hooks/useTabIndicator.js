import { useRef, useState, useCallback, useLayoutEffect, useEffect } from 'react'

/**
 * Drives a sliding "active tab" indicator for a segmented tab bar.
 *
 * Usage:
 *   const { tabRef, indicatorStyle } = useTabIndicator(activeId)
 *   <div ref={tabRef} className="tabs">
 *     <span className="tab-slider" style={indicatorStyle} />
 *     ...buttons... (mark the active one with data-tab-active="true")
 *   </div>
 *
 * The indicator is positioned to exactly overlay the active button (using its
 * offset box + border-radius), so a CSS transition makes it glide between tabs.
 *
 * Repositions after every render — this is important for tab bars that mount
 * late or conditionally (e.g. a filter row that only appears once results load),
 * where a deps-based effect would miss the moment the element appears. A change
 * check prevents render loops.
 */
export function useTabIndicator() {
  const tabRef = useRef(null)
  const lastRef = useRef(null)
  const [indicatorStyle, setIndicatorStyle] = useState({ opacity: 0 })

  const recompute = useCallback(() => {
    const container = tabRef.current
    if (!container) return

    const active = container.querySelector('[data-tab-active="true"]')
    let next
    if (!active) {
      next = { opacity: 0 }
    } else {
      let borderRadius
      try {
        borderRadius = getComputedStyle(active).borderRadius
      } catch {
        borderRadius = undefined
      }
      next = {
        opacity: 1,
        transform: `translate(${active.offsetLeft}px, ${active.offsetTop}px)`,
        width: `${active.offsetWidth}px`,
        height: `${active.offsetHeight}px`,
        borderRadius,
      }
    }

    // Only update on an actual change, so running this every render can't loop.
    const prev = lastRef.current
    if (
      prev &&
      prev.opacity === next.opacity &&
      prev.transform === next.transform &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.borderRadius === next.borderRadius
    ) {
      return
    }
    lastRef.current = next
    setIndicatorStyle(next)
  }, [])

  // Runs after every render (no deps) — covers active changes AND late/
  // conditional mounts of the tab bar or its buttons.
  useLayoutEffect(recompute)

  // Keep aligned on container/child resize and window resize.
  useEffect(() => {
    const container = tabRef.current
    if (!container) return
    const ro = new ResizeObserver(recompute)
    ro.observe(container)
    for (const child of container.children) ro.observe(child)
    window.addEventListener('resize', recompute)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', recompute)
    }
  }, [recompute])

  return { tabRef, indicatorStyle }
}
