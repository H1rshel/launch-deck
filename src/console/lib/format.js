export function formatMinutes(minutes) {
  if (!minutes || minutes < 1) return '0m'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export function relativeTime(dateString) {
  if (!dateString) return null
  const d = new Date(dateString)
  if (isNaN(d.getTime())) return null
  const diffSecs = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diffSecs < 60) return 'Just now'
  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 30) return `${diffDays} days ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths === 1) return '1 month ago'
  if (diffMonths < 12) return `${diffMonths} months ago`
  const diffYears = Math.floor(diffMonths / 12)
  return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`
}

export function getDisplayPlaytimeMinutes(game, steamPlaytime) {
  const localMinutes = game?.playtime_minutes || 0
  const importedMinutes =
    steamPlaytime && typeof steamPlaytime.steamPlaytime === 'number'
      ? steamPlaytime.steamPlaytime
      : game?.imported_playtime_minutes || 0
  return localMinutes + importedMinutes
}
