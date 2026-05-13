export default function GlowPanel({ children, className = '', glow = false, style = {} }) {
  return (
    <div
      className={`glow-panel ${glow ? 'glow-panel--active' : ''} ${className}`}
      style={style}
    >
      {children}
    </div>
  )
}
