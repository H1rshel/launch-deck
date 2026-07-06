import { useRef, useState, useCallback, useLayoutEffect, useEffect } from 'react'

/**
 * Drives a sliding "active tab" indicator for a segmented tab bar.
 *
 * Usage:
 *   const { tabRef, indicatorStyle } = useTabIndicator(activeId, tabsSignature)
 *   <div ref={tabRef} className="tabs">
 *     <span className="tabs__slider" style={indicatorStyle} />
 *     ...buttons... (mark the active one with data-tab-active="true")
 *   </div>
 *
 * The indicator is positioned to exactly overlay the active button (using its
 * offset box), so a CSS transition on transform/width/height makes it glide
 * smoothly between tabs. `signature` should change whenever the set of tabs
 * changes (e.g. tabs shown/hidden) so the position recomputes.
 */
export function useTabIndicator(activeValue, signature = '') {
  const tabRef = useRef(null)
  const [indicatorStyle, setIndicatorStyle] = useState({ opacity: 0 })

  const recompute = useCallback(() => {
    const container = tabRef.current
    if (!container) return
    const active = container.querySelector('[data-tab-active="true"]')
    if (!active) {
      setIndicatorStyle((s) => ({ ...s, opacity: 0 }))
      return
    }
    setIndicatorStyle({
      opacity: 1,
      transform: `translate(${active.offsetLeft}px, ${active.offsetTop}px)`,
      width: `${active.offsetWidth}px`,
      height: `${active.offsetHeight}px`,
    })
  }, [])

  // Position synchronously after layout so there is no first-paint flash.
  useLayoutEffect(() => {
    recompute()
  }, [activeValue, signature, recompute])

  // Keep the indicator aligned when the bar resizes or tabs are added/removed.
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
  }, [signature, recompute])

  return { tabRef, indicatorStyle }
}
