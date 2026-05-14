const BLOCKED_PRODUCT_WORDS = new Set([
  'addon',
  'artbook',
  'bonus',
  'bundle',
  'chapter',
  'coin',
  'coins',
  'cosmetic',
  'costume',
  'credits',
  'currency',
  'dlc',
  'episode',
  'expansion',
  'guide',
  'map',
  'pack',
  'package',
  'pass',
  'points',
  'skin',
  'skins',
  'soundtrack',
  'starter',
  'upgrade',
  'weapon',
  'weapons',
])

const BLOCKED_PHRASES = [
  'add on',
  'downloadable content',
  'season pass',
  'deluxe upgrade',
  'digital deluxe upgrade',
  'pre order',
  'preorder bonus',
  'interactive map',
]

const ALLOWED_PREFIX_WORDS = new Set([
  'a',
  'an',
  'anthology',
  'collection',
  'dark',
  'edition',
  'gold',
  'meiers',
  'of',
  'part',
  'pictures',
  'sid',
  'standard',
  'the',
  'trilogy',
  'world',
])

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(tm|goty)\b/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function tokens(value) {
  return normalizeText(value).split(' ').filter(Boolean)
}

function hasBlockedProductWords(value) {
  const normalized = normalizeText(value)
  if (!normalized) return false
  if (BLOCKED_PHRASES.some((phrase) => normalized.includes(phrase))) return true
  return tokens(normalized).some((token) => BLOCKED_PRODUCT_WORDS.has(token))
}

function isAllowedPrefix(prefix) {
  const prefixTokens = tokens(prefix)
  if (prefixTokens.length === 0) return true
  if (prefixTokens.length > 5) return false
  return prefixTokens.every((token) => ALLOWED_PREFIX_WORDS.has(token))
}

function wordBoundaryIncludes(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `)
}

function getPrefixBefore(haystack, needle) {
  const index = ` ${haystack} `.indexOf(` ${needle} `)
  if (index < 0) return ''
  return haystack.slice(0, Math.max(0, index)).trim()
}

function getSuffixAfter(haystack, needle) {
  const padded = ` ${haystack} `
  const index = padded.indexOf(` ${needle} `)
  if (index < 0) return ''
  return haystack.slice(index + needle.length).trim()
}

export function isAccurateDealTitle(gameTitle, dealTitle) {
  const wanted = normalizeText(gameTitle)
  const deal = normalizeText(dealTitle)
  if (!wanted || !deal) return false
  if (deal === wanted) return true

  if (hasBlockedProductWords(dealTitle)) return false

  if (wordBoundaryIncludes(deal, wanted)) {
    const prefix = getPrefixBefore(deal, wanted)
    const suffix = getSuffixAfter(deal, wanted)

    if (suffix) return false
    return isAllowedPrefix(prefix)
  }

  return false
}

export function filterAccurateDeals(gameTitle, deals = []) {
  return deals.filter((deal) => isAccurateDealTitle(gameTitle, deal.title))
}

export function cheapSharkRedirectUrl(dealId) {
  const id = String(dealId || '').trim()
  if (!id) return ''
  return `https://www.cheapshark.com/redirect?dealID=${id}`
}
