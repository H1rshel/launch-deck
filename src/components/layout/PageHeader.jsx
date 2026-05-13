/**
 * Unified page header used across Library, Activity, Settings, Upcoming,
 * and future Discover-style pages.
 *
 *   variant="compact"  — utility pages (Library, Activity, Settings)
 *   variant="hero"     — immersive / discover pages (Upcoming, etc.)
 *
 * Both variants share typography scale, spacing rhythm, glass/blur, and
 * rounded corners (rounded-2xl). Switching variant only changes the
 * background weight, padding, and glow intensity — the rest of the system
 * stays consistent.
 */
export default function PageHeader({
  variant = "compact",
  eyebrow,
  eyebrowIcon: EyebrowIcon,
  title,
  subtitle,
  actions,
  children,
  image,
  className = "",
}) {
  return (
    <header
      className={`page-header page-header--${variant} ${className}`.trim()}
    >
      <div className="page-header__glow" aria-hidden="true" />
      {image && (
        <img
          className="page-header__image"
          src={image}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )}
      <div className="page-header__inner">
        <div className="page-header__text">
          {eyebrow && (
            <div className="page-header__eyebrow">
              {EyebrowIcon && <EyebrowIcon size={13} strokeWidth={2} />}
              <span>{eyebrow}</span>
            </div>
          )}
          <h1 className="page-header__title">{title}</h1>
          {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
      {children && <div className="page-header__extra">{children}</div>}
    </header>
  )
}
