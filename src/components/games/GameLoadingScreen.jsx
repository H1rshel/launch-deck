import { useState, useEffect } from 'react'
import { getGameImages } from '../../utils/imageHandler'

export default function GameLoadingScreen({
  game,
  mode = 'launch',
  statusText,
  subtitle,
}) {
  const [visible, setVisible] = useState(false)
  const { hero, cover, logo } = getGameImages(game)
  const bgImage = hero || cover
  const posterImage = cover || hero
  const resolvedTitle = game?.displayTitle || game?.title || 'Game'
  const resolvedStatusText =
    statusText || (mode === 'install' ? 'Opening Installer' : 'Launching')
  const resolvedSubtitle =
    subtitle ||
    (mode === 'install'
      ? 'Loading the installation flow in your launcher'
      : 'Preparing your game session')

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      className={`game-launch-screen game-launch-screen--${mode} ${visible ? 'game-launch-screen--visible' : ''}`}
    >
      {bgImage && (
        <div
          className="game-launch-screen__bg"
          style={{ backgroundImage: `url(${bgImage})` }}
        />
      )}
      <div className="game-launch-screen__overlay" />

      {/* Animated orbs */}
      <div className="game-launch-screen__orb game-launch-screen__orb--1" />
      <div className="game-launch-screen__orb game-launch-screen__orb--2" />

      <div className="game-launch-screen__content">
        {posterImage && (
          <div className="game-launch-screen__poster-wrap">
            <img
              src={posterImage}
              alt={resolvedTitle}
              className="game-launch-screen__poster"
            />
          </div>
        )}

        <div className="game-launch-screen__info">
          <span className="game-launch-screen__eyebrow">
            {mode === 'install' ? 'Installation' : 'Now Playing'}
          </span>
          {logo ? (
            <img
              src={logo}
              alt={resolvedTitle}
              className="game-launch-screen__logo"
            />
          ) : (
            <h1 className="game-launch-screen__title">{resolvedTitle}</h1>
          )}
          <p className="game-launch-screen__subtitle">{resolvedSubtitle}</p>
        </div>

        <div className="game-launch-screen__loading">
          <div className="game-launch-screen__ring" />
          <span className="game-launch-screen__text">{resolvedStatusText}</span>
          <div className="game-launch-screen__dots">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </div>
  )
}
