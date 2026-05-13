export default function Logo({ size = 80, showText = false, className = "" }) {
  return (
    <div className={`logo ${showText ? "logo--inline" : ""} ${className}`}>
      <div className="logo__frame" style={{ width: size, height: size }}>
        <img
          src="/launch-deck-logo-alt.png"
          alt="Launch Deck"
          className="logo__img"
          draggable={false}
        />
      </div>

      {showText && <span className="logo__text">Launch Deck</span>}
    </div>
  )
}
