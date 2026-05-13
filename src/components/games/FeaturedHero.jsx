import { useNavigate } from 'react-router-dom'
import { Play, Info, Star } from 'lucide-react'
import { useGameContext } from '../../context/GameContext'
import { canInstallGame } from '../../lib/launcher'

import { getGameImages } from '../../utils/imageHandler'

export default function FeaturedHero({ game }) {
  const navigate = useNavigate()
  const { playGame, installGame } = useGameContext()

  if (!game) return null

  const { hero, cover } = getGameImages(game)
  const bgImage = hero || cover
  const bgStyle = bgImage
    ? { backgroundImage: `url(${bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: game.gradient }
  const installable = canInstallGame(game)

  function handlePlay() {
    playGame(game).catch((err) => console.error(err))
  }

  function handleInstall() {
    installGame(game).catch((err) => console.error(err))
  }

  function handleDetails() {
    navigate(`/game/${game.id}`)
  }

  return (
    <section className="featured-hero featured-hero--animated" style={bgStyle}>
      <div className="featured-hero__content">
        <span className="featured-hero__badge">Featured</span>
        <h1 className="featured-hero__title">{game.displayTitle}</h1>
        {game.release_date && (
          <p className="featured-hero__desc">
            {game.release_date.includes('-')
              ? game.release_date.split('-').reverse().join('/')
              : game.release_date}
          </p>
        )}
        <div className="featured-hero__actions">
          {game.installed ? (
            <button className="featured-hero__btn featured-hero__btn--play" onClick={handlePlay}>
              <Play size={20} fill="currentColor" />
              Play Now
            </button>
          ) : (
            <button
              className="featured-hero__btn featured-hero__btn--play"
              onClick={handleInstall}
              disabled={!installable}
              title={installable ? 'Open launcher install flow' : 'No launcher install target is available'}
            >
              Install
            </button>
          )}
          <button className="featured-hero__btn featured-hero__btn--info" onClick={handleDetails}>
            <Info size={20} />
            Details
          </button>
        </div>
        <div className="featured-hero__stats">
          <span>{game.playtime} played</span>
          <span className="featured-hero__dot" />
          <span>{game.platform}</span>
          {game.rating > 0 && (
            <>
              <span className="featured-hero__dot" />
              <span>
                <Star size={12} fill="var(--accent-amber)" stroke="var(--accent-amber)" style={{ verticalAlign: '-1px' }} />
                {' '}{game.rating.toFixed(1)}
              </span>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
