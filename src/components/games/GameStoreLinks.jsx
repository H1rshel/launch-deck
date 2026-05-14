import { ExternalLink, Loader, ShoppingCart, TrendingDown, AlertCircle } from 'lucide-react'
import { useItadDeals } from '../../hooks/useItadDeals'
import { usePriceDeals } from '../../hooks/usePriceDeals'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

// ── IGDB website category → store metadata ────────────────────────────────────
const STORE_MAP = {
  1:  { name: 'Official Site', key: 'official' },
  13: { name: 'Steam',         key: 'steam' },
  16: { name: 'Epic Games',    key: 'epic' },
  17: { name: 'GOG',           key: 'gog' },
  15: { name: 'itch.io',       key: 'itch' },
}

const PLATFORM_STORE_CATS = new Set([1, 13, 15, 16, 17])

const COMMUNITY_MAP = {
  6:  { name: 'Twitch',    key: 'twitch' },
  9:  { name: 'YouTube',   key: 'youtube' },
  14: { name: 'Reddit',    key: 'reddit' },
  18: { name: 'Discord',   key: 'discord' },
  4:  { name: 'Facebook',  key: 'facebook' },
  5:  { name: 'Twitter',   key: 'twitter' },
  8:  { name: 'Instagram', key: 'instagram' },
  3:  { name: 'Wikipedia', key: 'wikipedia' },
}
const COMMUNITY_CATS = new Set(Object.keys(COMMUNITY_MAP).map(Number))

// ── Store SVG icons ───────────────────────────────────────────────────────────

function SteamIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658a3.387 3.387 0 0 1 1.912-.59c.064 0 .128.002.191.006l2.861-4.142V8.91a4.528 4.528 0 0 1 4.524-4.524 4.528 4.528 0 0 1 4.524 4.524 4.528 4.528 0 0 1-4.524 4.524h-.105l-4.076 2.911c0 .052.004.105.004.159a3.392 3.392 0 0 1-3.39 3.393 3.396 3.396 0 0 1-3.322-2.73L.377 14.472C1.701 19.905 6.376 24 11.979 24c6.627 0 12.004-5.373 12.004-12S18.606 0 11.979 0zM7.54 18.21l-1.473-.61a2.544 2.544 0 0 0 4.737-.838 2.543 2.543 0 0 0-2.541-2.545c-.244 0-.48.037-.706.103l1.523.63a1.868 1.868 0 0 1-1.422 3.452l-.118-.192zm8.4-5.367a3.019 3.019 0 0 0 3.016-3.016 3.019 3.019 0 0 0-3.016-3.016 3.019 3.019 0 0 0-3.016 3.016 3.019 3.019 0 0 0 3.016 3.016zm-.003-5.277a2.264 2.264 0 0 1 2.262 2.261 2.264 2.264 0 0 1-2.262 2.262 2.264 2.264 0 0 1-2.261-2.262 2.264 2.264 0 0 1 2.261-2.261z"/>
    </svg>
  )
}

function EpicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3.537 0C2.165 0 1.66.506 1.66 1.879V22.12c0 1.374.504 1.879 1.877 1.879h16.926c1.374 0 1.877-.505 1.877-1.879V1.879C22.34.506 21.837 0 20.463 0H3.537zm6.166 5.596h4.297c.558 0 .924.368.924.922v.462c0 .554-.366.922-.924.922H11.33v1.846h2.67c.558 0 .924.369.924.923v.462c0 .554-.366.922-.924.922H11.33v1.846h2.67c.558 0 .924.368.924.922v.462c0 .554-.366.922-.924.922H9.703c-.558 0-.924-.368-.924-.922V6.518c0-.554.366-.922.924-.922z"/>
    </svg>
  )
}

function GogIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 3.6c4.636 0 8.4 3.764 8.4 8.4s-3.764 8.4-8.4 8.4S3.6 16.636 3.6 12 7.364 3.6 12 3.6zm0 2.4a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/>
    </svg>
  )
}

const STORE_ICONS = { steam: SteamIcon, epic: EpicIcon, gog: GogIcon }

async function openExternal(url) {
  if (!url) return
  try {
    await openUrl(url)
  } catch {
    try {
      await invoke('open_url', { url })
    } catch {
      window.open(url, '_blank', 'noopener')
    }
  }
}

// ── Normalize ITAD deal to display shape ─────────────────────────────────────
function normalizeItadDeal(d) {
  return {
    store:        d.shopName,
    currentPrice: d.currentPrice,
    regularPrice: d.regularPrice,
    discount:     d.discountPercent,
    currency:     d.currency,
    url:          d.url,
    storeLow:     d.storeLowPrice,
    historyLow:   d.historyLowPrice,
    drm:          d.drm,
    source:       'itad',
  }
}

// ── Normalize CheapShark deal to display shape ───────────────────────────────
function normalizeCsDeal(d) {
  return {
    store:        d.store,
    currentPrice: parseFloat(d.salePrice),
    regularPrice: parseFloat(d.normalPrice),
    discount:     Math.round(d.savings),
    currency:     'USD',
    url:          d.redirectUrl,
    storeLow:     null,
    historyLow:   null,
    drm:          [],
    source:       'cheapshark',
  }
}

// ── Price row ─────────────────────────────────────────────────────────────────

function DealRow({ deal, isBest }) {
  const hasDiscount  = deal.discount > 0.5
  const isFree       = deal.currentPrice === 0
  const currencySign = deal.currency === 'USD' ? '$' : (deal.currency + ' ')
  const fmt = n => `${currencySign}${Number(n).toFixed(2)}`

  return (
    <button
      type="button"
      className={`ugd-deals__row ${isBest ? 'ugd-deals__row--best' : ''}`}
      onClick={() => { void openExternal(deal.url) }}
      title={`Buy on ${deal.store}`}
    >
      <span className="ugd-deals__cell ugd-deals__cell--store">
        <span className="ugd-deals__store">{deal.store}</span>
      </span>

      <span className="ugd-deals__cell ugd-deals__cell--was">
        {hasDiscount && (
          <span className="ugd-deals__normal">{fmt(deal.regularPrice)}</span>
        )}
      </span>

      <span className="ugd-deals__cell ugd-deals__cell--price">
        <span className={`ugd-deals__sale ${isFree ? 'ugd-deals__sale--free' : ''}`}>
          {isFree ? 'FREE' : fmt(deal.currentPrice)}
        </span>
      </span>

      <span className="ugd-deals__cell ugd-deals__cell--cut">
        {hasDiscount && (
          <span className="ugd-deals__badge">-{Math.round(deal.discount)}%</span>
        )}
      </span>

      <span className="ugd-deals__cell ugd-deals__cell--low">
        {deal.historyLow != null && (
          <span className="ugd-deals__histlow" title="All-time low">
            <TrendingDown size={9} />
            {fmt(deal.historyLow)}
          </span>
        )}
      </span>

      <ExternalLink size={10} className="ugd-deals__arrow" />
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function GameStoreLinks({ websites, gameName }) {
  // ITAD — primary source
  const { result: itadResult, loading: itadLoading, error: itadError } = useItadDeals(gameName)

  // CheapShark — fallback source (always fetched in parallel as backup)
  const { deals: csDeals, loading: csLoading } = usePriceDeals(gameName)

  if (!websites?.length && !gameName) return null

  // Categorize IGDB websites
  const storeLinks     = []
  const communityLinks = []
  for (const w of (websites || [])) {
    if (PLATFORM_STORE_CATS.has(w.category)) {
      const info = STORE_MAP[w.category]
      if (info) storeLinks.push({ ...info, url: w.url })
    } else if (COMMUNITY_CATS.has(w.category)) {
      const info = COMMUNITY_MAP[w.category]
      if (info) communityLinks.push({ ...info, url: w.url })
    }
  }

  // Pick the best available deal source
  const itadDeals = (itadResult?.deals || []).map(normalizeItadDeal)
  const csNormalized = (csDeals || []).map(normalizeCsDeal)

  // Use ITAD when available, CheapShark as fallback
  const displayDeals = itadDeals.length > 0 ? itadDeals : csNormalized

  const loading        = itadLoading || (itadDeals.length === 0 && csLoading)
  const hasDeals       = displayDeals.length > 0
  const hasStores      = storeLinks.length > 0
  const hasCommunity   = communityLinks.length > 0
  const usingFallback  = itadDeals.length === 0 && csNormalized.length > 0

  const encodedName = gameName ? encodeURIComponent(gameName) : ''
  const itadUrl     = gameName ? `https://isthereanydeal.com/search/?q=${encodedName}` : null
  const aksUrl      = gameName ? `https://www.allkeyshop.com/blog/catalogue/search-${encodedName}/` : null

  const itadGameUrl = itadResult?.gameSlug
    ? `https://isthereanydeal.com/game/${encodeURIComponent(itadResult.gameSlug)}/info/`
    : itadUrl

  return (
    <div className="ugd-stores">
      {/* Price deals */}
      {loading && (
        <div className="ugd-deals__loading">
          <Loader size={14} className="settings__spinner" />
          <span>Checking prices…</span>
        </div>
      )}

      {!loading && hasDeals && (
        <div className="ugd-deals__panel">
          <div className="ugd-deals__header">
            <ShoppingCart size={13} />
            <span>Best Prices</span>
            {usingFallback && (
              <span className="ugd-deals__source-tag">via CheapShark</span>
            )}
            {!usingFallback && itadResult && (
              <span className="ugd-deals__source-tag">via IsThereAnyDeal</span>
            )}
          </div>
          <div className="ugd-deals__list">
            {displayDeals.slice(0, 8).map((d, i) => (
              <DealRow key={`${d.store}-${i}`} deal={d} isBest={i === 0} />
            ))}
          </div>
          <div className="ugd-deals__footer">
            {itadGameUrl && (
              <button
                type="button"
                className="ugd-deals__more-link"
                onClick={() => { void openExternal(itadGameUrl) }}
              >
                More on IsThereAnyDeal
                <ExternalLink size={11} />
              </button>
            )}
            {aksUrl && (
              <button
                type="button"
                className="ugd-deals__more-link"
                onClick={() => { void openExternal(aksUrl) }}
              >
                AllKeyShop
                <ExternalLink size={11} />
              </button>
            )}
          </div>
        </div>
      )}

      {!loading && !hasDeals && gameName && (
        <div className="ugd-deals__empty">
          <div className="ugd-deals__empty-icon">
            <AlertCircle size={18} strokeWidth={1.5} />
          </div>
          <span>No price data yet</span>
          <span className="ugd-deals__empty-sub">This title may not be available for purchase yet.</span>
          <div className="ugd-deals__footer ugd-deals__footer--empty">
            {itadUrl && (
              <button
                type="button"
                className="ugd-deals__more-link"
                onClick={() => { void openExternal(itadUrl) }}
              >
                Search IsThereAnyDeal
                <ExternalLink size={11} />
              </button>
            )}
            {aksUrl && (
              <button
                type="button"
                className="ugd-deals__more-link"
                onClick={() => { void openExternal(aksUrl) }}
              >
                Search AllKeyShop
                <ExternalLink size={11} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Platform store pages from IGDB */}
      {hasStores && (
        <div className="ugd-stores__group">
          <span className="ugd-stores__group-label">Store Pages</span>
          <div className="ugd-stores__buttons">
            {storeLinks.map(s => {
              const Icon = STORE_ICONS[s.key]
              return (
                <button
                  key={s.key}
                  type="button"
                  className={`ugd-stores__btn ugd-stores__btn--${s.key}`}
                  onClick={() => { void openExternal(s.url) }}
                  title={`Open on ${s.name}`}
                >
                  {Icon ? <Icon /> : <ExternalLink size={13} />}
                  <span>{s.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Community links */}
      {hasCommunity && (
        <div className="ugd-stores__group">
          <span className="ugd-stores__group-label">Community</span>
          <div className="ugd-stores__buttons ugd-stores__buttons--compact">
            {communityLinks.map(c => (
              <button
                key={c.key}
                type="button"
                className="ugd-stores__link"
                onClick={() => { void openExternal(c.url) }}
                title={c.name}
              >
                <ExternalLink size={11} />
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
