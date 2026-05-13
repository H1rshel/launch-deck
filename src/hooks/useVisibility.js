import { useEffect, useState } from 'react'

export function useVisibility(ref, options = {}) {
  const { root = null, rootMargin = '200px', threshold = 0.05 } = options
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const element = ref?.current
    if (!element) return

    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setIsVisible(true)
      },
      { root, rootMargin, threshold },
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, root, rootMargin, threshold])

  return isVisible
}
