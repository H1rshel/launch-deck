import { useState } from "react"
import { getGameImages } from "../../utils/imageHandler"

export { getGameImages }

/**
 * Wraps an image with a shimmer skeleton that fades out once the image loads.
 * The outer div inherits border-radius from the parent via CSS.
 */
function LazyImageWrap({ src, alt, className = "", imgClassName = "", style, onError, ...props }) {
  const [loaded, setLoaded] = useState(false)

  if (!src) return null

  return (
    <div
      className={`lazy-image-wrap${loaded ? ' lazy-image-wrap--loaded' : ''} ${className}`}
      style={style}
      {...props}
    >
      <div className="lazy-image__skeleton" />
      <img
        src={src}
        alt={alt}
        className={`lazy-image__img ${imgClassName}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={onError}
      />
    </div>
  )
}

export function ImageWithFallback({ primary, fallback, alt, className, style, imgClassName, ...props }) {
  const [errorLevel, setErrorLevel] = useState(0)

  const currentSrc = errorLevel === 0 ? (primary || fallback) : fallback

  if (!currentSrc || errorLevel >= 2) {
    return (
      <div
        className={`game-img-placeholder ${className || ''}`}
        style={style}
        {...props}
      >
        <span className="game-img-placeholder__label">{alt}</span>
      </div>
    )
  }

  return (
    <LazyImageWrap
      src={currentSrc}
      alt={alt || "Game Image"}
      className={`game-img ${className || ''}`}
      imgClassName={imgClassName}
      style={style}
      onError={() => {
        if (fallback && errorLevel === 0) {
          setErrorLevel(1)
        } else {
          setErrorLevel(2)
        }
      }}
    />
  )
}

export function GameCard({ game, className = "", ...props }) {
  const { cover, hero } = getGameImages(game)
  return (
    <div className={`game-card-img ${className}`} {...props}>
      <ImageWithFallback
        primary={cover}
        fallback={hero}
        alt={game?.displayTitle || "Game Cover"}
        className="game-card-img__image"
      />
    </div>
  )
}

export function GameHero({ game, className = "", children, ...props }) {
  const { hero, cover } = getGameImages(game)
  return (
    <div className={`game-hero-img ${className}`} {...props}>
      <ImageWithFallback
        primary={hero}
        fallback={cover}
        alt={game?.displayTitle || "Game Hero"}
        className="game-hero-img__image"
      />
      <div className="game-hero-img__overlay" />
      {children}
    </div>
  )
}

export function GameBackground({ game, className = "", ...props }) {
  const { hero, cover } = getGameImages(game)

  if (!hero && !cover) {
    return <div className={`game-bg ${className}`} style={{ background: game?.gradient || '#333' }} {...props} />
  }

  return (
    <div className={`game-bg ${className}`} {...props}>
      <ImageWithFallback
        primary={hero}
        fallback={cover}
        alt=""
        className="game-bg__image"
      />
    </div>
  )
}

export function GameLogo({ game, className = "", ...props }) {
  const { logo } = getGameImages(game)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  if (!logo || failed) return null

  return (
    <div className={`lazy-image-wrap${loaded ? ' lazy-image-wrap--loaded' : ''} game-logo-wrap`}>
      <div className="lazy-image__skeleton" style={{ borderRadius: 4 }} />
      <img
        src={logo}
        alt={`${game?.displayTitle || "Game"} Logo`}
        className={`lazy-image__img game-logo-img ${className}`}
        style={{ objectFit: 'contain' }}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        {...props}
      />
    </div>
  )
}
