import { useEffect } from "react"
import { Play } from "lucide-react"
import { getGameImages } from "../../utils/imageHandler"

export default function LaunchConfirmModal({ game, onConfirm, onCancel }) {
  const { cover } = getGameImages(game)
  const title = game.displayTitle || game.title

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onCancel()
      if (e.key === "Enter") onConfirm()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onConfirm, onCancel])

  return (
    <div className="launch-confirm__backdrop" onClick={onCancel}>
      <div className="launch-confirm" onClick={(e) => e.stopPropagation()}>
        {cover && (
          <img src={cover} alt={title} className="launch-confirm__cover" />
        )}
        <div className="launch-confirm__content">
          <p className="launch-confirm__eyebrow">Ready to play</p>
          <h2 className="launch-confirm__title">{title}</h2>
          {game.platform && (
            <p className="launch-confirm__meta">{game.platform}</p>
          )}
          <div className="launch-confirm__actions">
            <button className="launch-confirm__cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              className="launch-confirm__launch"
              onClick={onConfirm}
              autoFocus
            >
              <Play size={14} />
              Launch Now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
