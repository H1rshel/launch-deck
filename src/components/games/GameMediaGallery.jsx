import { useState, useRef, useCallback, useEffect } from 'react'
import { Play, ChevronLeft, ChevronRight, X, Maximize2 } from 'lucide-react'

// ── Intelligent trailer selection (exported for potential reuse) ───────────────
const TRAILER_PATTERNS = [
  /official\s+(game\s+)?trailer/i,
  /announcement\s+trailer/i,
  /reveal\s+trailer/i,
  /launch\s+trailer/i,
  /cinematic\s+trailer/i,
  /\btrailer\b/i,
  /announcement/i,
  /reveal/i,
  /official/i,
]

export function selectBestTrailer(videos) {
  if (!videos?.length) return null
  for (const pattern of TRAILER_PATTERNS) {
    const match = videos.find(v => v.name && pattern.test(v.name))
    if (match) return match
  }
  return videos[0]
}

// ── Shared carousel scroll logic ──────────────────────────────────────────────

function useCarouselScroll(itemCount) {
  const scrollRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft]   = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setCanScrollLeft(scrollLeft > 4)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 4)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateScrollState()
    el.addEventListener('scroll', updateScrollState, { passive: true })
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState, itemCount])

  const scroll = useCallback((dir) => {
    const el = scrollRef.current
    if (!el) return
    const first = el.querySelector(':scope > *')
    const w = first ? first.getBoundingClientRect().width + 12 : el.clientWidth * 0.6
    el.scrollBy({ left: dir * Math.max(160, w * 2), behavior: 'smooth' })
  }, [])

  return { scrollRef, canScrollLeft, canScrollRight, scroll }
}

// ── Video carousel ────────────────────────────────────────────────────────────

function VideoCarousel({ videos }) {
  const [lightbox, setLightbox] = useState(null)
  const { scrollRef, canScrollLeft, canScrollRight, scroll } = useCarouselScroll(videos?.length)

  if (!videos?.length) return null

  return (
    <>
      <div className="ugd-media__carousel-wrap">
        {canScrollLeft && (
          <button
            type="button"
            className="ugd-media__carousel-btn ugd-media__carousel-btn--prev"
            onClick={() => scroll(-1)}
            aria-label="Scroll left"
          >
            <ChevronLeft size={16} />
          </button>
        )}

        <div ref={scrollRef} className="ugd-media__carousel">
          {videos.map((v, i) => (
            <button
              key={i}
              type="button"
              className="ugd-media__thumb ugd-media__thumb--video"
              onClick={() => setLightbox(i)}
              aria-label={`Play ${v.name || `Trailer ${i + 1}`}`}
            >
              <img
                src={`https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`}
                alt={v.name || `Trailer ${i + 1}`}
                loading="lazy"
                onError={e => {
                  if (!e.target.src.includes('hqdefault')) {
                    e.target.src = `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`
                  }
                }}
              />
              <div className="ugd-media__thumb-play">
                <Play size={14} fill="currentColor" />
              </div>
              {v.name && (
                <span className="ugd-media__thumb-label">{v.name}</span>
              )}
            </button>
          ))}
        </div>

        {canScrollRight && (
          <button
            type="button"
            className="ugd-media__carousel-btn ugd-media__carousel-btn--next"
            onClick={() => scroll(1)}
            aria-label="Scroll right"
          >
            <ChevronRight size={16} />
          </button>
        )}
      </div>

      {lightbox !== null && (
        <div
          className="ugd-media__lightbox"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-label="Video player"
        >
          <button
            type="button"
            className="ugd-media__lightbox-close"
            onClick={() => setLightbox(null)}
            aria-label="Close"
          >
            <X size={20} />
          </button>

          {lightbox > 0 && (
            <button
              type="button"
              className="ugd-media__lightbox-nav ugd-media__lightbox-nav--prev"
              onClick={e => { e.stopPropagation(); setLightbox(lightbox - 1) }}
              aria-label="Previous trailer"
            >
              <ChevronLeft size={24} />
            </button>
          )}

          <div
            className="ugd-media__lightbox-video"
            onClick={e => e.stopPropagation()}
          >
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${videos[lightbox].videoId}?autoplay=1&rel=0&modestbranding=1`}
              title={videos[lightbox].name || 'Trailer'}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
            {videos[lightbox].name && (
              <span className="ugd-media__lightbox-title">{videos[lightbox].name}</span>
            )}
          </div>

          {lightbox < videos.length - 1 && (
            <button
              type="button"
              className="ugd-media__lightbox-nav ugd-media__lightbox-nav--next"
              onClick={e => { e.stopPropagation(); setLightbox(lightbox + 1) }}
              aria-label="Next trailer"
            >
              <ChevronRight size={24} />
            </button>
          )}

          <span className="ugd-media__lightbox-counter">
            {lightbox + 1} / {videos.length}
          </span>
        </div>
      )}
    </>
  )
}

// ── Screenshot / image carousel ──────────────────────────────────────────────

function MediaCarousel({ images }) {
  const [lightbox, setLightbox] = useState(null)
  const { scrollRef, canScrollLeft, canScrollRight, scroll } = useCarouselScroll(images?.length)

  if (!images?.length) return null

  return (
    <>
      <div className="ugd-media__carousel-wrap">
        {canScrollLeft && (
          <button
            type="button"
            className="ugd-media__carousel-btn ugd-media__carousel-btn--prev"
            onClick={() => scroll(-1)}
            aria-label="Scroll left"
          >
            <ChevronLeft size={16} />
          </button>
        )}

        <div ref={scrollRef} className="ugd-media__carousel">
          {images.map((url, i) => (
            <button
              key={i}
              type="button"
              className="ugd-media__thumb"
              onClick={() => setLightbox(i)}
              aria-label={`View screenshot ${i + 1}`}
            >
              <img src={url} alt={`Screenshot ${i + 1}`} loading="lazy" />
              <div className="ugd-media__thumb-zoom">
                <Maximize2 size={12} />
              </div>
            </button>
          ))}
        </div>

        {canScrollRight && (
          <button
            type="button"
            className="ugd-media__carousel-btn ugd-media__carousel-btn--next"
            onClick={() => scroll(1)}
            aria-label="Scroll right"
          >
            <ChevronRight size={16} />
          </button>
        )}
      </div>

      {lightbox !== null && (
        <div
          className="ugd-media__lightbox"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-label="Screenshot viewer"
        >
          <button
            type="button"
            className="ugd-media__lightbox-close"
            onClick={() => setLightbox(null)}
            aria-label="Close"
          >
            <X size={20} />
          </button>

          <button
            type="button"
            className="ugd-media__lightbox-nav ugd-media__lightbox-nav--prev"
            onClick={e => {
              e.stopPropagation()
              setLightbox((lightbox - 1 + images.length) % images.length)
            }}
            aria-label="Previous"
          >
            <ChevronLeft size={24} />
          </button>

          <img
            src={images[lightbox]}
            alt={`Screenshot ${lightbox + 1}`}
            className="ugd-media__lightbox-img"
            onClick={e => e.stopPropagation()}
          />

          <button
            type="button"
            className="ugd-media__lightbox-nav ugd-media__lightbox-nav--next"
            onClick={e => {
              e.stopPropagation()
              setLightbox((lightbox + 1) % images.length)
            }}
            aria-label="Next"
          >
            <ChevronRight size={24} />
          </button>

          <span className="ugd-media__lightbox-counter">
            {lightbox + 1} / {images.length}
          </span>
        </div>
      )}
    </>
  )
}

// ── Main gallery ──────────────────────────────────────────────────────────────

export default function GameMediaGallery({ videos, screenshots, artworks }) {
  const allImages = [...(artworks || []), ...(screenshots || [])]
  const hasVideos = videos?.length > 0
  const hasImages = allImages.length > 0

  if (!hasVideos && !hasImages) return null

  return (
    <div className="ugd-media">
      {hasVideos && (
        <div className="ugd-media__section">
          <span className="ugd-media__section-label">Trailers</span>
          <VideoCarousel videos={videos} />
        </div>
      )}
      {hasImages && (
        <div className="ugd-media__section">
          <span className="ugd-media__section-label">Screenshots</span>
          <MediaCarousel images={allImages} />
        </div>
      )}
    </div>
  )
}
