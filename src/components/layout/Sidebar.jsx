import { NavLink, useLocation } from "react-router-dom"
import { useAuth } from "../../hooks/useAuth"
import { useRef } from "react"
import {
  LayoutDashboard,
  Library,
  Activity,
  User,
  Settings,
  LogOut,
  MonitorPlay,
  PcCase,
  CalendarDays,
  Compass,
} from "lucide-react"
import { getCurrentWindow } from "@tauri-apps/api/window"

const navItems = [
  {
    to: "/dashboard",
    icon: LayoutDashboard,
    label: "Dashboard",
    color: "#00d4ff",
  },
  { to: "/library", icon: Library, label: "Library", color: "#7b2ff7" },
  { to: "/upcoming", icon: CalendarDays, label: "Upcoming", color: "#5ee7df" },
  { to: "/discover", icon: Compass, label: "Discover", color: "#a78bfa" },
  { to: "/my-rig", icon: PcCase, label: "My Rig", color: "#ff6b9d" },
  { to: "/activity", icon: Activity, label: "Activity", color: "#00ff88" },
  { to: "/profile", icon: User, label: "Profile", color: "#f5a623" },
  { to: "/settings", icon: Settings, label: "Settings", color: "#8b99b2" },
]

function NavItem({ to, icon: Icon, label, color, isActive }) {
  const linkRef = useRef(null)

  function handleClick() {
    // Trigger click flash effect
    const el = linkRef.current
    if (!el) return
    el.classList.remove("sidebar__link--flash")
    // Force reflow so re-adding the class restarts the animation
    void el.offsetWidth
    el.classList.add("sidebar__link--flash")
  }

  return (
    <NavLink
      ref={linkRef}
      to={to}
      className={`sidebar__link ${isActive ? "sidebar__link--active" : ""}`}
      style={{ "--nav-color": color }}
      onClick={handleClick}
    >
      {/* Left accent bar — always in DOM, animates via CSS */}
      <div className="sidebar__active-bar" />

      {/* Animated background glow on active */}
      <div className="sidebar__link-bg" />

      {/* Icon in colored badge */}
      <div className="sidebar__icon-badge">
        <Icon size={17} strokeWidth={isActive ? 2.3 : 1.7} />
      </div>

      <span className="sidebar__link-text">{label}</span>

      {/* Pulsing dot — always in DOM */}
      <div className="sidebar__active-dot" />
    </NavLink>
  )
}

export default function Sidebar() {
  const { signOut } = useAuth()
  const location = useLocation()

  return (
    <aside className="sidebar">
      <div className="sidebar__ambient" />
      <div className="sidebar__noise" />

      <div className="sidebar__inner">
        <div className="sidebar__brand" data-tauri-drag-region>
          <img
            src="/launch-deck-logo-alt.png"
            alt="Launch Deck"
            className="sidebar__logo-img"
          />
          <div className="sidebar__brand-text-group">
            <span className="sidebar__brand-title">LAUNCH DECK</span>
            <span className="sidebar__brand-sub">Game Launcher</span>
          </div>
        </div>

        <nav className="sidebar__nav">
          {navItems.map((item) => (
            <NavItem
              key={item.to}
              {...item}
              isActive={location.pathname === item.to}
            />
          ))}
        </nav>

        <div className="sidebar__footer">
          <NavLink
            to="/console"
            className="sidebar__console-btn"
            onClick={async () => {
              try {
                if (!document.fullscreenElement) {
                  await document.documentElement
                    .requestFullscreen()
                    .catch(() => {})
                }
                const appWindow = getCurrentWindow()
                await appWindow.setFullscreen(true).catch(() => {})
              } catch (err) {
                console.warn(err)
              }
            }}
          >
            <div className="sidebar__console-icon">
              <MonitorPlay size={16} />
            </div>
            <span>Big Picture</span>
          </NavLink>

          <button className="sidebar__signout" onClick={signOut}>
            <LogOut size={15} />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
