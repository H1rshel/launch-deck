import { useState, useEffect, useMemo, useCallback } from 'react'
import { Play, Download, Heart, HeartOff, Trophy, Info, Trash2, Ban, MonitorPlay } from 'lucide-react'
import { getGameImages } from '../../utils/imageHandler'
import { ImageWithFallback, GameLogo } from '../../components/ui/GameImages'
import { getInstallTarget } from '../../lib/launcher'
import { useInputLayer } from '../input/InputProvider'
import { playSfx } from '../audio/sounds'
import { ButtonGlyph } from '../components/HintBar'

/**
 * Per-game action sheet — the "options" panel a console opens on a
 * long-press / options button: play, favorite, achievements, details, remove.
 */
export default function GameActionSheet({
  game,
  achData,
  onClose,
  onPrimary,
  streamSource,
  toggleFavorite,
  onShowAchievements,
  onViewDetails,
  onRemove,
}) {
  const [index, setIndex] = useState(0)

  const options = useMemo(() => {
    const list = []
    if (game.installed) list.push({ id: 'primary', label: 'Play', icon: Play })
    else if (streamSource) list.push({ id: 'primary', label: `Stream from ${streamSource.hostname}`, icon: MonitorPlay })
    else if (getInstallTarget(game)) list.push({ id: 'primary', label: 'Install', icon: Download })
    else list.push({ id: 'primary', label: 'Not Installed', icon: Ban, disabled: true })
    list.push({
      id: 'favorite',
      label: game.favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: game.favorite ? HeartOff : Heart,
    })
    if (achData?.progress) list.push({ id: 'achievements', label: 'View Achievements', icon: Trophy })
    list.push({ id: 'details', label: 'View in Desktop Mode', icon: Info })
    list.push({ id: 'remove', label: 'Remove from Library', icon: Trash2, danger: true })
    return list
  }, [game, achData, streamSource])

  useEffect(() => {
    if (index > options.length - 1) setIndex(Math.max(0, options.length - 1))
  }, [options.length, index])

  const activate = useCallback(
    (opt) => {
      if (!opt || opt.disabled) return
      playSfx('select')
      switch (opt.id) {
        case 'primary':
          onClose()
          onPrimary(game)
          break
        case 'favorite':
          toggleFavorite(game.id)
          onClose()
          break
        case 'achievements':
          onClose()
          onShowAchievements()
          break
        case 'details':
          onViewDetails(game)
          break
        case 'remove':
          onClose()
          onRemove(game.id)
          break
        default:
          break
      }
    },
    [game, onClose, onPrimary, toggleFavorite, onShowAchievements, onViewDetails, onRemove]
  )

  useInputLayer((action) => {
    switch (action) {
      case 'up':
        setIndex((i) => { if (i > 0) playSfx('nav'); return Math.max(0, i - 1) })
        return
      case 'down':
        setIndex((i) => { if (i < options.length - 1) playSfx('nav'); return Math.min(options.length - 1, i + 1) })
        return
      case 'accept':
        activate(options[index])
        return
      case 'back':
        playSfx('back')
        onClose()
        return
      default:
        return
    }
  })

  const images = getGameImages(game)

  return (
    <div className="cos-sheet-backdrop" onClick={onClose}>
      <div className="cos-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cos-sheet__cover">
          <ImageWithFallback
            primary={images.cover}
            fallback={images.hero}
            alt={game.displayTitle}
            className="cos-sheet__cover-img"
          />
        </div>

        <div className="cos-sheet__body">
          <div className="cos-sheet__identity">
            <GameLogo game={game} className="cos-sheet__logo" />
            {!images.logo && <h3 className="cos-sheet__title">{game.displayTitle}</h3>}
          </div>

          <div className="cos-sheet__options">
            {options.map((opt, i) => {
              const Icon = opt.icon
              const focusedOpt = i === index
              return (
                <button
                  key={opt.id}
                  className={[
                    'cos-sheet__option',
                    focusedOpt ? 'cos-sheet__option--focused' : '',
                    opt.danger ? 'cos-sheet__option--danger' : '',
                    opt.disabled ? 'cos-sheet__option--disabled' : '',
                  ].join(' ')}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => activate(opt)}
                >
                  <Icon size={17} />
                  <span>{opt.label}</span>
                </button>
              )
            })}
          </div>

          <div className="cos-sheet__hints">
            <span className="cos-hint">
              <ButtonGlyph action="accept" />
              <span className="cos-hint__label">Select</span>
            </span>
            <span className="cos-hint">
              <ButtonGlyph action="back" />
              <span className="cos-hint__label">Close</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
