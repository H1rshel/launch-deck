import { useState, useEffect, useRef, useCallback } from 'react'

function calculate(releaseDate) {
  const diff = new Date(releaseDate).getTime() - Date.now()
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, released: true, totalMs: 0 }
  return {
    days: Math.floor(diff / 86_400_000),
    hours: Math.floor((diff / 3_600_000) % 24),
    minutes: Math.floor((diff / 60_000) % 60),
    seconds: Math.floor((diff / 1_000) % 60),
    released: false,
    totalMs: diff,
  }
}

export function useCountdown(releaseDate) {
  const [timeLeft, setTimeLeft] = useState(() => calculate(releaseDate))
  const intervalRef = useRef(null)
  const releaseDateRef = useRef(releaseDate)

  const tick = useCallback(() => {
    const t = calculate(releaseDateRef.current)
    setTimeLeft(t)
    if (t.released) clearInterval(intervalRef.current)
  }, [])

  useEffect(() => {
    releaseDateRef.current = releaseDate
    const t = calculate(releaseDate)
    setTimeLeft(t)
    if (t.released) return
    clearInterval(intervalRef.current)
    intervalRef.current = setInterval(tick, 1000)
    return () => clearInterval(intervalRef.current)
  }, [releaseDate, tick])

  return timeLeft
}
