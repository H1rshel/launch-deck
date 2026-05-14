import { useState, useCallback, useRef, useEffect } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { useGameContext } from "../context/GameContext"
import {
  searchCovers,
  searchSteamGridAssets,
  searchGame,
  searchGamesDB,
  searchWebImages,
} from "../lib/rawg"
import { setIgdbCache, setGameDetailsCache } from "../lib/db"
import {
  buildMetadataCacheKey,
  normalizeMetadataPayload,
  GAME_DETAIL_PROVIDERS,
  GAME_DETAIL_TTLS,
  getStaleAfterIso,
} from "../lib/gameDetailCache"
import { Select } from "../components/ui/Select"
import {
  GameCard,
  GameBackground,
  GameLogo,
  getGameImages,
} from "../components/ui/GameImages"
import AchievementsPreview from "../components/games/AchievementsPreview"
import AchievementsModal from "../components/games/AchievementsModal"
import PlaytimeDisplay from "../components/games/PlaytimeDisplay"
import PlaytimeStats from "../components/games/PlaytimeStats"
import HowLongToBeatPanel from "../components/games/HowLongToBeatPanel"
import SimilarGamesPanel from "../components/games/SimilarGamesPanel"
import GamePerformanceCard from "../components/games/GamePerformanceCard"
import TopBar from "../components/layout/TopBar"
import { canInstallGame } from "../lib/launcher"
import {
  useGameMetadata,
  useSteamPlaytime,
  useSteamAchievements,
  useUbisoftPlaytime,
  useUbisoftAchievements,
  useUbisoftCoreChallenges,
  useHltb,
} from "../hooks/useGameDetailData"
import { useOnlineStatus } from "../hooks/useOnlineStatus"
import { useVisibility } from "../hooks/useVisibility"
import {
  Play,
  Square,
  Star,
  HardDrive,
  Calendar,
  FolderOpen,
  Trash2,
  Pencil,
  Check,
  X,
  Image,
  Heart,
  Search,
  Loader,
  MonitorPlay,
  Move,
  Clock,
  History,
  Copy,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Code2,
  Building2,
} from "lucide-react"

function formatDate(dateString) {
  if (!dateString) return "Unknown"
  const d = new Date(dateString)
  if (isNaN(d.getTime())) return dateString
  const day = d.getDate().toString().padStart(2, "0")
  const month = (d.getMonth() + 1).toString().padStart(2, "0")
  const year = d.getFullYear()
  return `${day}/${month}/${year}`
}

function relativeTime(dateString) {
  if (!dateString) return null
  const d = new Date(dateString)
  if (isNaN(d.getTime())) return null
  const diffMs = Date.now() - d.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  if (diffSecs < 60) return "Just now"
  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 30) return `${diffDays} days ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths === 1) return "1 month ago"
  if (diffMonths < 12) return `${diffMonths} months ago`
  const diffYears = Math.floor(diffMonths / 12)
  return diffYears === 1 ? "1 year ago" : `${diffYears} years ago`
}

function uniqueText(values, limit = Infinity) {
  const items = []
  const seen = new Set()

  for (const value of values || []) {
    const text =
      typeof value === "string" ? value.trim() : value?.name?.trim?.()
    if (!text) continue

    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(text)

    if (items.length >= limit) break
  }

  return items
}

function getStoreSources(game) {
  if (!game) return []

  const sources = []
  if (game.steam_app_id) sources.push("Steam")
  if (game.gog_id) sources.push("GOG")
  if (game.epic_id) sources.push("Epic Games")
  if (game.ubisoft_id) sources.push("Ubisoft Connect")
  return sources
}

function getPrimaryAccountProvider(game) {
  if (!game) return null

  const platform = String(game.platform || "").toLowerCase()

  if (game.ubisoft_id && platform.includes("ubisoft")) return "ubisoft"
  if (game.steam_app_id && platform.includes("steam")) return "steam"
  if (game.gog_id && platform.includes("gog")) return "gog"
  if (game.epic_id && platform.includes("epic")) return "epic"
  if (game.ubisoft_id && !game.steam_app_id) return "ubisoft"
  if (game.steam_app_id) return "steam"
  if (game.gog_id) return "gog"
  if (game.epic_id) return "epic"

  return null
}

function buildAssetWebSearchQuery(query, activeTab) {
  const trimmed = query.trim()
  if (activeTab === "cover") return `${trimmed} game cover art`
  if (activeTab === "logo") return `${trimmed} game logo transparent png`
  return `${trimmed} game wallpaper key art`
}

function toIsoFromUnixSeconds(value) {
  if (!value || value < 1) return ""
  const date = new Date(value * 1000)
  return isNaN(date.getTime()) ? "" : date.toISOString()
}

function getAccountLastPlayed(primaryProvider, playtimeData) {
  if (!playtimeData) return ""
  if (primaryProvider === "steam") {
    return toIsoFromUnixSeconds(playtimeData.lastPlayedSteam)
  }
  return playtimeData.lastPlayed || ""
}

function getAccountPlaytimeMinutes(primaryProvider, playtimeData) {
  if (!playtimeData?.available) return null
  if (primaryProvider === "steam") {
    return typeof playtimeData.steamPlaytime === "number" &&
      playtimeData.steamPlaytime > 0
      ? playtimeData.steamPlaytime
      : null
  }
  return typeof playtimeData.playtimeMinutes === "number" &&
    playtimeData.playtimeMinutes > 0
    ? playtimeData.playtimeMinutes
    : null
}

function pickLatestDate(...values) {
  let latest = ""
  let latestTime = 0

  for (const value of values) {
    const time = new Date(value || "").getTime()
    if (!Number.isFinite(time) || time <= latestTime) continue
    latestTime = time
    latest = value
  }

  return latest
}

const ESRB_IMAGES = {
  AO: "/esrb-ao.png",
  EC: "/esrb-ec.png",
  E: "/esrb-e.png",
  T: "/esrb-t.png",
  M: "/esrb-m.png",
  RP: "/esrb-rp.png",
}

function getEsrbImage(organization, rating) {
  if (organization !== "ESRB" || !rating) return null
  return ESRB_IMAGES[rating] || null
}

function formatCompanyNames(companies) {
  const names = uniqueText((companies || []).map((company) => company?.name))

  if (names.length === 0) return ""
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]}, ${names[1]} +${names.length - 2} more`
}

function EditNameInput({ value, onSave, onCancel }) {
  const [text, setText] = useState(value)
  return (
    <div className="game-detail__edit-name">
      <input
        className="game-detail__name-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) onSave(text.trim())
          if (e.key === "Escape") onCancel()
        }}
      />
      <button
        className="game-detail__edit-btn"
        onClick={() => text.trim() && onSave(text.trim())}
      >
        <Check size={16} />
      </button>
      <button className="game-detail__edit-btn" onClick={onCancel}>
        <X size={16} />
      </button>
    </div>
  )
}

function ImagePicker({ game, onApply, onClose }) {
  const [query, setQuery] = useState(game.displayTitle || game.title || "")
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const [source, setSource] = useState("steamgrid")
  const [isClosing, setIsClosing] = useState(false)

  function handleClose() {
    if (isClosing) return
    setIsClosing(true)
    setTimeout(onClose, 210)
  }
  const [activeTab, setActiveTab] = useState("cover") // cover | hero | logo

  // Track staged changes before applying
  const [stagedImages, setStagedImages] = useState({
    cover: game.cover_url || "",
    hero: game.hero_url || "",
    logo: game.logo_url || "",
  })

  // Hero background-position (percentages), default right-top to match Console Mode
  const [heroPosition, setHeroPosition] = useState(() => {
    if (game.hero_position) {
      const parts = game.hero_position.split(" ")
      const x = parseFloat(parts[0])
      const y = parseFloat(parts[1])
      if (!isNaN(x) && !isNaN(y)) return { x, y }
    }
    return { x: 100, y: 0 }
  })
  const [isDragging, setIsDragging] = useState(false)
  const previewSceneRef = useRef(null)

  // Resolved natural resolutions for hero images
  const [resolutions, setResolutions] = useState({})
  const [resolutionFilter, setResolutionFilter] = useState("all")

  // Has anything been changed from original?
  const hasChanges =
    stagedImages.cover !== (game.cover_url || "") ||
    stagedImages.hero !== (game.hero_url || "") ||
    stagedImages.logo !== (game.logo_url || "") ||
    (!!stagedImages.hero &&
      `${Math.round(heroPosition.x)}% ${Math.round(heroPosition.y)}%` !==
        (game.hero_position || "100% 0%"))

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    setSearchError(null)
    let assets = []
    let fallbackError = null

    const loadWebAssets = async () => {
      const webResults = await searchWebImages(buildAssetWebSearchQuery(query, activeTab))
      const mapped = webResults.map((r) => ({
        name: r.source || "Web Image",
        url: r.url,
        width: r.width,
        height: r.height,
      }))

      const newRes = {}
      webResults.forEach((r) => {
        if (r.width > 0 && r.height > 0) {
          newRes[r.url] = `${r.width}\u00d7${r.height}`
        }
      })
      setResolutions((prev) => ({ ...prev, ...newRes }))
      return mapped
    }
    try {
      if (source === "web") {
        const webResults = await searchWebImages(buildAssetWebSearchQuery(query, activeTab))
        assets = webResults.map((r) => ({
          name: r.source,
          url: r.url,
          width: r.width,
          height: r.height,
        }))
        // Pre-populate resolutions from backend data (skip 0×0 unknowns)
        const newRes = {}
        webResults.forEach((r) => {
          if (r.width > 0 && r.height > 0)
            newRes[r.url] = `${r.width}\u00d7${r.height}`
        })
        setResolutions((prev) => ({ ...prev, ...newRes }))
      } else if (source === "igdb") {
        const raw = await invoke("search_igdb_games", { query: query.trim() })
        assets = []
        for (const r of raw || []) {
          if (activeTab === "cover") {
            if (r.coverUrl) assets.push({ name: r.name, url: r.coverUrl })
          } else if (activeTab === "hero") {
            for (const url of r.artworks || [])
              assets.push({ name: `${r.name} — Artwork`, url })
            for (const url of r.screenshots || [])
              assets.push({ name: `${r.name} — Screenshot`, url })
          } else if (activeTab === "logo") {
            for (const url of r.artworks || [])
              assets.push({ name: `${r.name} — Artwork`, url })
          }
        }
      } else if (source === "rawg") {
        if (activeTab === "cover") {
          const rawrs = await searchCovers(query.trim())
          assets = rawrs.map((r) => ({ name: r.name, url: r.cover_url }))
        } else {
          assets = []
        }
      } else {
        let type = "grids"
        if (activeTab === "hero") type = "heroes"
        if (activeTab === "logo") type = "logos"
        assets = await searchSteamGridAssets(query.trim(), type)
      }
    } catch (err) {
      fallbackError = typeof err === "string" ? err : err?.message || "Search failed"
    }

    if (source !== "web" && assets.length === 0) {
      const fallbackAssets = await loadWebAssets()
      if (fallbackAssets.length > 0) {
        assets = fallbackAssets
      } else if (fallbackError) {
        setSearchError(fallbackError)
      }
    } else if (fallbackError) {
      setSearchError(fallbackError)
    }

    setResults(assets)
    setLoading(false)
  }, [query, source, activeTab])

  function handleSelect(url) {
    setStagedImages((prev) => ({ ...prev, [activeTab]: url }))
  }

  function handleImageLoad(url, e) {
    const { naturalWidth, naturalHeight } = e.target
    if (naturalWidth && naturalHeight) {
      setResolutions((prev) =>
        prev[url]
          ? prev
          : { ...prev, [url]: `${naturalWidth}×${naturalHeight}` },
      )
    }
  }

  function updateFromPointer(e) {
    const el = previewSceneRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = Math.max(
      0,
      Math.min(100, ((e.clientX - rect.left) / rect.width) * 100),
    )
    const y = Math.max(
      0,
      Math.min(100, ((e.clientY - rect.top) / rect.height) * 100),
    )
    setHeroPosition({ x, y })
  }

  function handlePreviewPointerDown(e) {
    e.preventDefault()
    setIsDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
    updateFromPointer(e)
  }

  function handlePreviewPointerMove(e) {
    if (!isDragging) return
    updateFromPointer(e)
  }

  function handlePreviewPointerUp() {
    setIsDragging(false)
  }

  const filteredResults = results.filter((r) => {
    if (resolutionFilter === "all") return true
    const res = resolutions[r.url]
    if (!res) return true // resolution not yet loaded — keep visible
    const w = parseInt(res.split("\u00d7")[0], 10)
    if (resolutionFilter === "hd") return w >= 1920
    if (resolutionFilter === "4k") return w >= 3840
    return true
  })

  return (
    <div
      className={`cover-picker__backdrop${isClosing ? " cover-picker__backdrop--closing" : ""}`}
      onClick={handleClose}
    >
      <div
        className={`cover-picker${isClosing ? " cover-picker--closing" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cover-picker__header">
          <h3 className="cover-picker__title">Change Images</h3>
          <button className="cover-picker__close" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="cover-picker__tabs">
          {["cover", "hero", "logo"].map((tab) => (
            <button
              key={tab}
              className={`cover-picker__tab ${activeTab === tab ? "cover-picker__tab--active" : ""}`}
              onClick={() => {
                setActiveTab(tab)
                setResults([])
                setResolutionFilter("all")
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="cover-picker__search">
          <Select
            value={source}
            onChange={(val) => {
              setSource(val)
              setResults([])
              setSearchError(null)
              setResolutionFilter("all")
            }}
            options={[
              { label: "SteamGridDB", value: "steamgrid" },
              { label: "IGDB", value: "igdb" },
              { label: "RAWG", value: "rawg" },
              { label: "Web Images", value: "web" },
            ]}
          />
          <input
            className="cover-picker__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a game..."
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <button
            className="cover-picker__search-btn"
            onClick={handleSearch}
            disabled={loading}
          >
            {loading ? (
              <Loader size={16} className="settings__spinner" />
            ) : (
              <Search size={16} />
            )}
          </button>
        </div>

        {(activeTab === "hero" || source === "web") && results.length > 0 && (
          <div className="cover-picker__res-filter">
            <span className="cover-picker__res-filter-label">Resolution:</span>
            {[
              { label: "All", value: "all" },
              { label: "HD+", value: "hd", title: "≥1920px wide" },
              { label: "4K+", value: "4k", title: "≥3840px wide" },
            ].map((opt) => (
              <button
                key={opt.value}
                className={`cover-picker__res-filter-btn${resolutionFilter === opt.value ? " cover-picker__res-filter-btn--active" : ""}`}
                onClick={() => setResolutionFilter(opt.value)}
                title={opt.title}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        <div className={`cover-picker__grid cover-picker__grid--${activeTab}`}>
          {filteredResults.map((r, i) => {
            const isSelected = stagedImages[activeTab] === r.url
            return (
              <div
                key={i}
                className={`cover-picker__option ${isSelected ? "cover-picker__option--selected" : ""}`}
                onClick={() => handleSelect(r.url)}
                role="button"
                tabIndex={0}
              >
                <div
                  className={`cover-picker__thumb cover-picker__thumb--${activeTab}`}
                >
                  <img
                    src={r.url}
                    alt={r.name || "Game image"}
                    className="cover-picker__thumb-img"
                    loading="lazy"
                    onLoad={(e) => handleImageLoad(r.url, e)}
                  />
                  {resolutions[r.url] && (
                    <span className="cover-picker__resolution-badge">
                      {resolutions[r.url]}
                    </span>
                  )}
                  {isSelected && (
                    <div className="cover-picker__option-check">
                      <Check size={24} color="#fff" strokeWidth={3} />
                    </div>
                  )}
                </div>
                {activeTab !== "logo" && (
                  <span className="cover-picker__option-name">
                    {r.name ||
                      (source === "web" ? "Web Image" : "SteamGrid Image")}
                  </span>
                )}
              </div>
            )
          })}
          {filteredResults.length === 0 && !loading && (
            <p className="cover-picker__empty">
              {results.length > 0
                ? `No ${resolutionFilter.toUpperCase()}+ images found`
                : `Search for ${activeTab} images`}
            </p>
          )}
        </div>

        {searchError && (
          <div className="cover-picker__custom">
            <span
              className="cover-picker__custom-label"
              style={{ color: "var(--color-error, #f87171)" }}
            >
              {searchError}
            </span>
          </div>
        )}

        {/* Big Picture Mode Preview — only visible on hero tab */}
        {activeTab === "hero" && (
          <div className="cover-picker__bp-preview">
            <span className="cover-picker__bp-preview-label">
              <MonitorPlay size={12} />
              Big Picture Preview
            </span>
            {stagedImages.hero ? (
              <div
                ref={previewSceneRef}
                className={`cover-picker__bp-preview-scene${isDragging ? " cover-picker__bp-preview-scene--dragging" : ""}`}
                onPointerDown={handlePreviewPointerDown}
                onPointerMove={handlePreviewPointerMove}
                onPointerUp={handlePreviewPointerUp}
                onPointerCancel={handlePreviewPointerUp}
              >
                <div
                  className="cover-picker__bp-preview-blur"
                  style={{ backgroundImage: `url(${stagedImages.hero})` }}
                />
                <div
                  className="cover-picker__bp-preview-hero-img"
                  style={{
                    backgroundImage: `url(${stagedImages.hero})`,
                    backgroundPosition: `${Math.round(heroPosition.x)}% ${Math.round(heroPosition.y)}%`,
                  }}
                />
                <div className="cover-picker__bp-preview-overlay" />
                <div className="cover-picker__bp-preview-content">
                  <span className="cover-picker__bp-preview-title">
                    {game.displayTitle}
                  </span>
                  <div className="cover-picker__bp-preview-playbtn">
                    <Play size={7} fill="currentColor" />
                    Play Now
                  </div>
                </div>
                <div className="cover-picker__bp-preview-pos-indicator">
                  {Math.round(heroPosition.x)}% {Math.round(heroPosition.y)}%
                </div>
                {!isDragging && (
                  <div className="cover-picker__bp-preview-drag-hint">
                    <Move size={9} />
                    Drag to reposition
                  </div>
                )}
              </div>
            ) : (
              <div className="cover-picker__bp-preview-empty">
                <MonitorPlay size={20} />
                <span>Select a hero image to preview Big Picture mode</span>
              </div>
            )}
          </div>
        )}

        {/* Pending Changes Preview UI */}
        <div className="cover-picker__preview">
          <div className="cover-picker__preview-images">
            {stagedImages.cover && (
              <div className="cover-picker__preview-item" title="Cover">
                <img
                  src={stagedImages.cover}
                  alt="Cover Preview"
                  className="cover-picker__preview-cover"
                />
              </div>
            )}
            {stagedImages.hero && (
              <div className="cover-picker__preview-item" title="Hero">
                <img
                  src={stagedImages.hero}
                  alt="Hero Preview"
                  className="cover-picker__preview-hero"
                />
              </div>
            )}
            {stagedImages.logo && (
              <div
                className="cover-picker__preview-item cover-picker__preview-item--logo"
                title="Logo"
              >
                <img
                  src={stagedImages.logo}
                  alt="Logo Preview"
                  className="cover-picker__preview-logo"
                />
              </div>
            )}
          </div>
          <div className="cover-picker__actions">
            <button
              className="cover-picker__btn cover-picker__btn--cancel"
              onClick={handleClose}
            >
              Cancel
            </button>
            <button
              className="cover-picker__btn cover-picker__btn--apply"
              onClick={() => onApply(stagedImages, heroPosition)}
              disabled={!hasChanges}
            >
              Apply Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MetadataSearch({ game, onApply, onClose }) {
  const [query, setQuery] = useState(game.displayTitle || game.title || "")
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState("rawg")
  const [searchError, setSearchError] = useState(null)

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    setSearchError(null)
    try {
      let items = []
      if (source === "gamesdb") {
        items = await searchGamesDB(query.trim())
      } else if (source === "igdb") {
        const raw = await invoke("search_igdb_games", { query: query.trim() })
        items = (raw || []).map((r) => ({
          name: r.name,
          background_image: r.coverUrl || null,
          released: r.firstReleaseDate
            ? new Date(r.firstReleaseDate * 1000).toISOString().split("T")[0]
            : "",
          rating: 0,
          _igdb_genres: r.genres || [],
          _igdb_franchise: r.franchise || null,
          _igdbRaw: r,
        }))
      } else {
        items = await searchGame(query.trim())
      }
      setResults(items)
    } catch (err) {
      setResults([])
      setSearchError(
        typeof err === "string" ? err : err?.message || "Search failed",
      )
    }
    setLoading(false)
  }, [query, source])

  function handleSelect(item) {
    const updates = {
      normalized_title: item.name || "",
      release_date: item.released || "",
      metadata_fetched: 1,
    }

    // Only overwrite rating if the source actually provides one
    if ((item.rating || 0) > 0) updates.rating = item.rating

    // Genres: IGDB sends pre-named strings; RAWG sends genre objects [{name}]
    if (item._igdb_genres?.length) {
      updates.genres = item._igdb_genres.join(",")
    } else if (item.genres?.length) {
      updates.genres = item.genres
        .map((g) => (typeof g === "string" ? g : g?.name))
        .filter(Boolean)
        .join(",")
    }

    if (item._igdb_franchise) updates.franchise = item._igdb_franchise

    // Carry raw IGDB data so handleApplyMetadata can populate the detail cache
    if (item._igdbRaw) updates._igdbRaw = item._igdbRaw

    onApply(updates)
  }

  return (
    <div className="cover-picker__backdrop" onClick={onClose}>
      <div className="cover-picker" onClick={(e) => e.stopPropagation()}>
        <div className="cover-picker__header">
          <h3 className="cover-picker__title">
            Search Metadata (
            {source === "gamesdb"
              ? "TheGamesDB"
              : source === "igdb"
                ? "IGDB"
                : "RAWG"}
            )
          </h3>
          <button className="cover-picker__close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="cover-picker__search">
          <Select
            value={source}
            onChange={(val) => {
              setSource(val)
              setResults([])
              setSearchError(null)
            }}
            options={[
              { label: "RAWG", value: "rawg" },
              { label: "IGDB", value: "igdb" },
              { label: "TheGamesDB", value: "gamesdb" },
            ]}
          />
          <input
            className="cover-picker__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for correct game data..."
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            autoFocus
          />
          <button
            className="cover-picker__search-btn"
            onClick={handleSearch}
            disabled={loading}
          >
            {loading ? (
              <Loader size={16} className="settings__spinner" />
            ) : (
              <Search size={16} />
            )}
          </button>
        </div>

        <div className="cover-picker__metadata-results">
          {results.map((r, i) => (
            <div
              key={i}
              className="cover-picker__metadata-item"
              onClick={() => handleSelect(r)}
            >
              {r.background_image ? (
                <img
                  src={r.background_image}
                  alt=""
                  className="cover-picker__metadata-item-img"
                />
              ) : (
                <div className="cover-picker__metadata-item-placeholder" />
              )}
              <div className="cover-picker__metadata-item-info">
                <span className="cover-picker__metadata-item-name">
                  {r.name}
                </span>
                <span className="cover-picker__metadata-item-date">
                  {r.released ? r.released.substring(0, 4) : "Unknown Year"}
                </span>
              </div>
            </div>
          ))}
          {searchError && !loading && (
            <p
              className="cover-picker__empty"
              style={{ color: "var(--color-error, #f87171)" }}
            >
              {searchError}
            </p>
          )}
          {results.length === 0 && !loading && !searchError && (
            <p className="cover-picker__empty">No games found.</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function GameDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const {
    games,
    playGame,
    installGame,
    removeGame,
    updateGame,
    toggleFavorite,
    activeGames,
    forceEndSession,
    refreshGames,
    markGameSeen,
  } = useGameContext()
  const [editingName, setEditingName] = useState(false)
  const [showImagePicker, setShowImagePicker] = useState(false)
  const [showMetadataSearch, setShowMetadataSearch] = useState(false)
  const [showAchievementsModal, setShowAchievementsModal] = useState(false)
  const [showCoreChallengesModal, setShowCoreChallengesModal] = useState(false)
  const [showCollectionDrawer, setShowCollectionDrawer] = useState(false)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const steamId = localStorage.getItem("steamId") || ""
  const ubisoftAccountId = localStorage.getItem("ubisoftAccountId") || ""
  const ubisoftAccessToken = localStorage.getItem("ubisoftAccessToken") || ""
  const ubisoftRefreshToken = localStorage.getItem("ubisoftRefreshToken") || ""
  const ubisoftSessionId = localStorage.getItem("ubisoftSessionId") || ""
  const isOnline = useOnlineStatus()
  const hltbPanelRef = useRef(null)
  const hltbVisible = useVisibility(hltbPanelRef)

  const game = games.find((g) => g.id === id)

  // Clear the "New" badge the first time the user opens this detail page
  useEffect(() => {
    if (game?.is_new) markGameSeen(game.id)
  }, [game?.id, game?.is_new]) // eslint-disable-line react-hooks/exhaustive-deps

  const primaryAccountProvider = getPrimaryAccountProvider(game)
  const steamGame = primaryAccountProvider === "steam" ? game : null
  // Pass game to Ubisoft hooks for any game that has a ubisoft_id, regardless of
  // how the platform string resolves, so playtime/challenges/achievements are always fetched.
  const ubisoftGame = game?.ubisoft_id ? game : null
  const metadataQuery = useGameMetadata(game)
  const steamPlaytimeQuery = useSteamPlaytime(steamGame, steamId, {
    revalidateOnMount: true,
  })
  const steamAchievementsQuery = useSteamAchievements(steamGame, steamId)
  const ubisoftPlaytimeQuery = useUbisoftPlaytime(
    ubisoftGame,
    ubisoftAccessToken,
    ubisoftRefreshToken,
    ubisoftSessionId,
    ubisoftAccountId,
    {
      revalidateOnMount: true,
    },
  )
  const ubisoftAchievementsQuery = useUbisoftAchievements(
    ubisoftGame,
    ubisoftAccessToken,
    ubisoftRefreshToken,
    ubisoftSessionId,
    ubisoftAccountId,
    { revalidateOnMount: true },
  )
  const ubisoftCoreChallengesQuery = useUbisoftCoreChallenges(
    ubisoftGame,
    ubisoftAccessToken,
    ubisoftRefreshToken,
    ubisoftSessionId,
    ubisoftAccountId,
    { revalidateOnMount: true },
  )
  const hltbQuery = useHltb(game, { enabled: hltbVisible })
  const playtimeQuery =
    primaryAccountProvider === "ubisoft"
      ? ubisoftPlaytimeQuery
      : steamPlaytimeQuery
  const achievementsQuery =
    primaryAccountProvider === "ubisoft"
      ? ubisoftAchievementsQuery
      : steamAchievementsQuery

  const extendedDetails = metadataQuery.data
  const loadingDetails = metadataQuery.isLoading
  const accountPlaytime = playtimeQuery.data
  const achData = achievementsQuery.data
  const achLoading = achievementsQuery.isLoading
  const achError = achievementsQuery.error
  const hltbData = hltbQuery.data
  const hltbLoading = hltbQuery.isLoading
  const coreChallengesData = ubisoftCoreChallengesQuery.data
  const coreChallengesLoading = ubisoftCoreChallengesQuery.isLoading
  const coreChallengesError = ubisoftCoreChallengesQuery.error

  const isPlaying = !!game && activeGames.has(game.id)
  const goBack = useCallback(() => navigate(-1), [navigate])

  // When a session ends while on this page, re-fetch game data so playtime
  // and last-played stats update immediately without requiring navigation.
  const wasPlayingRef = useRef(false)
  useEffect(() => {
    if (wasPlayingRef.current && !isPlaying) {
      refreshGames()
    }
    wasPlayingRef.current = isPlaying
  }, [isPlaying, refreshGames])

  if (!game) {
    return (
      <div className="page game-detail">
        <TopBar backAction={goBack} />
        <div className="page__content">
          <div className="game-detail__not-found">
            <h2>Game not found</h2>
            <p>This game may have been removed from your library.</p>
          </div>
        </div>
      </div>
    )
  }

  function handlePlay() {
    playGame(game, { steamId }).catch((err) => console.error(err))
  }

  function handleInstall() {
    installGame(game).catch((err) => console.error(err))
  }

  async function handleRemove() {
    await removeGame(game.id)
    navigate(-1)
  }

  async function handleSaveName(newName) {
    await updateGame(game.id, { normalized_title: newName })
    setEditingName(false)
  }

  async function handleApplyImages(stagedImages, heroPosition) {
    await updateGame(game.id, {
      cover_url: stagedImages.cover,
      hero_url: stagedImages.hero,
      logo_url: stagedImages.logo,
      hero_position: `${Math.round(heroPosition.x)}% ${Math.round(heroPosition.y)}%`,
    })
    setShowImagePicker(false)
  }

  const ownedNames = new Set(
    games.map((g) => (g.normalized_title || g.title || "").toLowerCase()),
  )
  const heroThemeNames = uniqueText(extendedDetails?.themes || [], 2)
  const heroGenreNames = uniqueText(
    [
      ...(extendedDetails?.genres || []).map((genre) => genre.name),
      ...(game.genres || []),
    ],
    heroThemeNames.length > 0 ? 2 : 3,
  )
  const heroStoreSources = getStoreSources(game)
  const { hero: heroImageUrl } = getGameImages(game)
  const heroSubtitleBits = [...heroStoreSources]

  if (game.platform && !heroSubtitleBits.includes(game.platform)) {
    heroSubtitleBits.push(game.platform)
  }

  const heroSubtitleText = heroSubtitleBits.join(" / ")

  const heroSubtitle = heroSubtitleBits.join(" • ")
  const heroCollectionName =
    game.user_collection ||
    game.collectionNames?.[0] ||
    extendedDetails?.collections?.[0]?.name ||
    null
  const heroFranchiseName =
    heroCollectionName ||
    game.franchise ||
    game.franchiseNames?.[0] ||
    extendedDetails?.franchise ||
    extendedDetails?.franchises?.[0]?.name ||
    null
  const heroFranchiseType = heroCollectionName ? "collection" : "franchise"
  const collectionGames = heroFranchiseName
    ? games.filter(
        (g) =>
          (g.user_collection ||
            g.collectionNames?.[0] ||
            g.franchiseNames?.[0]) === heroFranchiseName,
      )
    : []
  const showHeroMeta =
    game.rating > 0 ||
    heroGenreNames.length > 0 ||
    heroThemeNames.length > 0 ||
    (loadingDetails && !extendedDetails)
  const showAboutSection =
    extendedDetails?.developers?.length > 0 ||
    extendedDetails?.publishers?.length > 0 ||
    !!extendedDetails?.description_raw
  const showAboutSkeleton = loadingDetails && !extendedDetails
  const showAboutFallback = !showAboutSkeleton && !showAboutSection
  const releaseDate = extendedDetails?.releaseDate || game.release_date
  const hasSteamLink = primaryAccountProvider === "steam" && !!game.steam_app_id
  const hasUbisoftLink =
    primaryAccountProvider === "ubisoft" && !!game.ubisoft_id
  const importedPlaytime = getAccountPlaytimeMinutes(
    primaryAccountProvider,
    accountPlaytime,
  )
  const displayLastPlayed = pickLatestDate(
    game.lastPlayed,
    getAccountLastPlayed(primaryAccountProvider, accountPlaytime),
  )
  const showAchievementsPanel =
    !!achData ||
    (hasSteamLink && !!steamId) ||
    hasUbisoftLink ||
    !!game?.ubisoft_id
  const showCoreChallengesPanel =
    hasUbisoftLink || !!coreChallengesData || !!game?.ubisoft_id
  const aboutFallbackMessage =
    metadataQuery.error ||
    (isOnline
      ? "Metadata has not been cached for this game yet."
      : "Offline. Cached metadata is not available for this game yet.")
  const installable = canInstallGame(game)

  async function handleSimilarGameClick(similarGame) {
    const nameLower = similarGame.name?.trim().toLowerCase() || ""
    const owned = games.find(
      (g) =>
        (g.normalized_title || g.title || "").trim().toLowerCase() ===
        nameLower,
    )
    if (owned) {
      navigate(`/game/${owned.id}`)
    } else {
      const sourceGameId = String(similarGame.id)
      navigate(`/upcoming/igdb/${encodeURIComponent(sourceGameId)}`, {
        state: {
          searchResult: {
            ...similarGame,
            igdb_id: similarGame.id,
            source: "igdb",
            source_game_id: sourceGameId,
            name: similarGame.name,
            cover_url: similarGame.cover_url || similarGame.coverUrl || null,
            banner_url:
              similarGame.banner_url ||
              similarGame.bannerUrl ||
              similarGame.cover_url ||
              similarGame.coverUrl ||
              null,
          },
        },
      })
    }
  }

  async function handleApplyMetadata(metadata) {
    // Strip private carrier fields that must not go to the DB
    const { _igdbRaw, ...dbUpdates } = metadata
    await updateGame(game.id, dbUpdates)

    if (_igdbRaw) {
      const cacheTitle = dbUpdates.normalized_title || game.displayTitle

      // Extract developers / publishers from the raw IGDB involvedCompanies array
      const developers = (_igdbRaw.involvedCompanies || [])
        .filter((c) => c.isDeveloper && c.name)
        .map((c) => ({ name: c.name, logoUrl: c.logoUrl }))
      const publishers = (_igdbRaw.involvedCompanies || [])
        .filter((c) => c.isPublisher && c.name)
        .map((c) => ({ name: c.name, logoUrl: c.logoUrl }))
      const matchCollections = (_igdbRaw.collections || []).map((c) => ({
        name: c.name,
        slug: c.slug || "",
      }))
      const matchFranchises = (_igdbRaw.franchises || []).map((f) => ({
        name: f.name,
        slug: f.slug || "",
      }))

      // Write the legacy igdb_cache entry (genres, themes, summary, etc.)
      // Note: this table has no developer/publisher columns, so those are omitted here.
      setIgdbCache(cacheTitle, {
        igdb_id: _igdbRaw.id || 0,
        summary: _igdbRaw.summary || "",
        genres: _igdbRaw.genres || [],
        themes: _igdbRaw.themes || [],
        ageRatings: _igdbRaw.ageRatings || [],
        similarGames: _igdbRaw.similarGames || [],
        franchise: _igdbRaw.franchise || "",
        collections: matchCollections,
        franchises: matchFranchises,
      }).catch(console.error)

      // Write the FULL metadata payload (including developers & publishers) into the
      // modern game_details_cache so the About section updates immediately without
      // waiting for a new IGDB API round-trip.
      const updatedGame = {
        ...game,
        normalized_title: dbUpdates.normalized_title || game.normalized_title,
      }
      const metaCacheKey = buildMetadataCacheKey(updatedGame)
      const fullPayload = normalizeMetadataPayload({
        description_raw: _igdbRaw.summary || "",
        storyline: _igdbRaw.storyline || "",
        developers,
        publishers,
        genres: _igdbRaw.genres || [],
        themes: _igdbRaw.themes || [],
        ageRatings: _igdbRaw.ageRatings || [],
        similarGames: _igdbRaw.similarGames || [],
        franchise: _igdbRaw.franchise || null,
        collections: matchCollections,
        franchises: matchFranchises,
      })
      if (fullPayload) {
        const now = new Date().toISOString()
        setGameDetailsCache({
          gameId: game.id,
          provider: GAME_DETAIL_PROVIDERS.metadata,
          cacheKey: metaCacheKey,
          payload: fullPayload,
          cachedAt: now,
          staleAfter: getStaleAfterIso(GAME_DETAIL_TTLS.metadata),
        }).catch(console.error)
      }
    }

    setShowMetadataSearch(false)
    // Force-refresh the metadata query so the UI reflects the change immediately
    metadataQuery.refresh()
  }

  return (
    <div className="page game-detail">
      <TopBar backAction={goBack} />
      <div className="game-detail__hero">
        <GameBackground game={game} className="game-detail__hero-blur-bg" />
        {heroImageUrl && (
          <div
            className="game-detail__hero-bg-image"
            style={{
              backgroundImage: `url(${heroImageUrl})`,
              backgroundPosition: game.hero_position || "50% 30%",
            }}
          />
        )}
        <div className="game-detail__hero-overlay" />
        <button
          className="game-detail__cover-edit"
          onClick={() => setShowImagePicker(true)}
          title="Change media"
        >
          <Image size={16} />
        </button>
        <div className="game-detail__hero-content">
          <GameCard game={game} className="game-detail__hero-poster" />
          <div className="game-detail__hero-text-wrapper">
            <div className="game-detail__hero-header">
              <div className="game-detail__hero-text">
                {editingName ? (
                  <EditNameInput
                    value={game.displayTitle}
                    onSave={handleSaveName}
                    onCancel={() => setEditingName(false)}
                  />
                ) : (
                  <div className="game-detail__logo-title">
                    <GameLogo game={game} className="game-detail__logo" />
                    <div className="game-detail__title-row">
                      <h1 className="game-detail__title">
                        {game.displayTitle}
                      </h1>
                      <button
                        className="game-detail__inline-btn"
                        onClick={() => setEditingName(true)}
                        title="Edit name"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="game-detail__inline-btn"
                        onClick={() => setShowMetadataSearch(true)}
                        title="Search Metadata Online"
                      >
                        <Search size={16} />
                      </button>
                    </div>
                  </div>
                )}

                {heroSubtitleBits.length > 0 && (
                  <div className="game-detail__hero-subtitle">
                    {heroSubtitleText}
                  </div>
                )}

                {heroFranchiseName && (
                  <div className="game-detail__franchise-inline">
                    <span>Part of the</span>
                    <button
                      className="game-detail__franchise-highlight game-detail__franchise-btn"
                      onClick={() => setShowCollectionDrawer(true)}
                      title={`View ${heroFranchiseName} ${heroFranchiseType}`}
                    >
                      {heroFranchiseName}
                    </button>
                    <span>{heroFranchiseType}</span>
                  </div>
                )}

                {showHeroMeta && (
                  <div className="game-detail__hero-meta">
                    {game.rating > 0 && (
                      <span className="game-detail__tag game-detail__tag--rating">
                        <Star
                          size={13}
                          fill="var(--accent-amber)"
                          stroke="var(--accent-amber)"
                        />
                        {game.rating.toFixed(1)}
                      </span>
                    )}
                    {heroGenreNames.map((genre) => (
                      <span
                        key={genre}
                        className="game-detail__tag game-detail__tag--genre"
                      >
                        {genre}
                      </span>
                    ))}
                    {heroThemeNames.map((theme) => (
                      <span
                        key={theme}
                        className="game-detail__tag game-detail__tag--theme"
                      >
                        {theme}
                      </span>
                    ))}
                    {loadingDetails &&
                      heroGenreNames.length === 0 &&
                      heroThemeNames.length === 0 && (
                        <>
                          <span className="game-detail__tag-skeleton" />
                          <span
                            className="game-detail__tag-skeleton"
                            style={{ width: 80 }}
                          />
                        </>
                      )}
                  </div>
                )}

                <div className="game-detail__hero-actions">
                  {isPlaying ? (
                    <button
                      className="game-detail__play-btn game-detail__play-btn--stop"
                      onClick={() => forceEndSession(game.id)}
                    >
                      <Square size={18} fill="currentColor" />
                      Stop Session
                    </button>
                  ) : game.installed ? (
                    <button
                      className="game-detail__play-btn"
                      onClick={handlePlay}
                    >
                      <Play size={22} fill="currentColor" />
                      Play Now
                    </button>
                  ) : (
                    <>
                      <button
                        className="game-detail__play-btn game-detail__play-btn--install"
                        onClick={handleInstall}
                        disabled={!installable}
                        title={
                          installable
                            ? "Open launcher install flow"
                            : "No launcher install target is available"
                        }
                      >
                        Install
                      </button>
                      <button
                        className="game-detail__remove-btn"
                        onClick={async () => {
                          const file = await open({
                            multiple: false,
                            directory: false,
                            title: "Locate Game Executable",
                            filters: [
                              {
                                name: "Executable",
                                extensions: ["exe", "lnk", "bat", "cmd"],
                              },
                            ],
                          })
                          if (file) {
                            await updateGame(game.id, { 
                              install_path: file,
                              status: "installed",
                              raw_file_name: file.split("\\").pop() || "",
                              raw_folder_name: file.split("\\").slice(-2, -1)[0] || "",
                            })
                          }
                        }}
                        title="Locate game executable manually"
                      >
                        <FolderOpen size={16} />
                        Locate
                      </button>
                    </>
                  )}
                  <button
                    className={`game-detail__fav-btn ${game.favorite ? "game-detail__fav-btn--active" : ""}`}
                    onClick={() => toggleFavorite(game.id)}
                    title={
                      game.favorite
                        ? "Remove from favorites"
                        : "Add to favorites"
                    }
                  >
                    <Heart
                      size={18}
                      fill={game.favorite ? "currentColor" : "none"}
                    />
                  </button>
                  <button
                    className="game-detail__remove-btn"
                    onClick={handleRemove}
                  >
                    <Trash2 size={16} />
                    Remove
                  </button>
                </div>
              </div>

              {extendedDetails?.primaryAgeRating &&
                (() => {
                  const { organization, rating, coverUrl } =
                    extendedDetails.primaryAgeRating
                  const esrbSrc = getEsrbImage(organization, rating)
                  return (
                    <div
                      className="game-detail__hero-age-rating"
                      title={`${organization} ${rating}`}
                    >
                      {esrbSrc ? (
                        <img
                          src={esrbSrc}
                          alt={`${organization} ${rating}`}
                          className="game-detail__hero-age-rating-esrb"
                        />
                      ) : coverUrl ? (
                        <img
                          src={coverUrl
                            .replace("t_thumb", "t_cover_small")
                            .replace("//", "https://")}
                          alt={rating}
                          className="game-detail__hero-age-rating-img"
                        />
                      ) : (
                        <div className="game-detail__hero-age-rating-badge">
                          <span className="game-detail__hero-age-rating-org">
                            {organization}
                          </span>
                          <span className="game-detail__hero-age-rating-val">
                            {rating}
                          </span>
                        </div>
                      )}
                    </div>
                  )
                })()}
            </div>
          </div>
        </div>
      </div>

      <div className="game-detail__body">
        {!isOnline && (
          <div className="game-detail__offline-banner">
            <span className="game-detail__offline-dot" />
            <span>Offline mode. Showing cached details where available.</span>
          </div>
        )}

        <div className="game-detail__content-columns">
          <div className="game-detail__main-col">
            <div className="game-detail__stats-row">
              <div className="game-detail__stat">
                <div className="game-detail__stat-icon-wrap">
                  <Clock size={18} className="game-detail__stat-icon" />
                </div>
                <div className="game-detail__stat-info">
                  <PlaytimeDisplay
                    game={game}
                    importedPlaytime={importedPlaytime}
                  />
                  <div className="game-detail__stat-meta">
                    <span className="game-detail__stat-label">Playtime</span>
                    {playtimeQuery.isRefreshing && (
                      <span className="game-detail__section-status">
                        <Loader size={12} className="settings__spinner" />
                        Syncing
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="game-detail__stat">
                <div className="game-detail__stat-icon-wrap">
                  <HardDrive size={18} className="game-detail__stat-icon" />
                </div>
                <div className="game-detail__stat-info">
                  <span className="game-detail__stat-value">
                    {game.installed ? "Installed" : "Not Installed"}
                  </span>
                  <span className="game-detail__stat-label">Status</span>
                </div>
              </div>
              <div className="game-detail__stat">
                <div className="game-detail__stat-icon-wrap">
                  <Calendar size={18} className="game-detail__stat-icon" />
                </div>
                <div className="game-detail__stat-info">
                  <span className="game-detail__stat-value">
                    {formatDate(releaseDate)}
                  </span>
                  <span className="game-detail__stat-label">Release Date</span>
                </div>
              </div>
              {game.rating > 0 && (
                <div className="game-detail__stat">
                  <div className="game-detail__stat-icon-wrap game-detail__stat-icon-wrap--amber">
                    <Star
                      size={18}
                      className="game-detail__stat-icon"
                      fill="var(--accent-amber)"
                      stroke="var(--accent-amber)"
                    />
                  </div>
                  <div className="game-detail__stat-info">
                    <span className="game-detail__stat-value">
                      {game.rating.toFixed(1)} / 5
                    </span>
                    <span className="game-detail__stat-label">Rating</span>
                  </div>
                </div>
              )}
              {displayLastPlayed && (
                <div className="game-detail__stat">
                  <div className="game-detail__stat-icon-wrap">
                    <History size={18} className="game-detail__stat-icon" />
                  </div>
                  <div className="game-detail__stat-info">
                    <span className="game-detail__stat-value">
                      {relativeTime(displayLastPlayed) ||
                        formatDate(displayLastPlayed)}
                    </span>
                    <span className="game-detail__stat-label">Last Played</span>
                  </div>
                </div>
              )}
            </div>

            <div className="game-detail__section">
              <h3 className="game-detail__section-title">Sessions</h3>
              <div className="game-detail__sessions-card">
                <PlaytimeStats game={game} steamPlaytime={importedPlaytime} />
              </div>
            </div>

            {game.install_path && (
              <div className="game-detail__section">
                <h3 className="game-detail__section-title">Installation</h3>
                <div className="game-detail__install-panel">
                  <div className="game-detail__install-path">
                    <FolderOpen
                      size={14}
                      className="game-detail__install-path-icon"
                    />
                    <span className="game-detail__install-path-text">
                      {game.install_path}
                    </span>
                  </div>
                  <div className="game-detail__install-actions">
                    <button
                      className="game-detail__install-action-btn"
                      onClick={() =>
                        invoke("open_in_file_manager", {
                          path: game.install_path,
                        })
                      }
                    >
                      <ExternalLink size={14} />
                      Open Folder
                    </button>
                    <button
                      className="game-detail__install-action-btn"
                      onClick={() =>
                        navigator.clipboard.writeText(game.install_path)
                      }
                    >
                      <Copy size={14} />
                      Copy Path
                    </button>
                    <button
                      className="game-detail__install-action-btn"
                      onClick={async () => {
                        const file = await open({
                          multiple: false,
                          directory: false,
                          title: "Select Executable",
                          filters: [
                            {
                              name: "Executable",
                              extensions: ["exe", "lnk", "bat", "cmd"],
                            },
                          ],
                        })
                        if (file) {
                          await updateGame(game.id, { install_path: file })
                        }
                      }}
                    >
                      <Pencil size={14} />
                      Change EXE
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div
              className={`game-detail__extended${!showAboutSkeleton && extendedDetails ? " game-detail__extended--loaded" : ""}`}
            >
              <div className="game-detail__section">
                <div className="game-detail__section-header">
                  <h3 className="game-detail__section-title">About the Game</h3>
                </div>

                {showAboutSkeleton && (
                  <div className="game-detail__about-panel">
                    <div className="game-detail__description game-detail__description--about">
                      <div
                        className="game-detail__skeleton-block"
                        style={{ width: "100%" }}
                      />
                      <div
                        className="game-detail__skeleton-block"
                        style={{ width: "92%" }}
                      />
                      <div
                        className="game-detail__skeleton-block"
                        style={{ width: "97%" }}
                      />
                      <div
                        className="game-detail__skeleton-block"
                        style={{ width: "88%" }}
                      />
                      <div
                        className="game-detail__skeleton-block"
                        style={{ width: "75%" }}
                      />
                      <div className="game-detail__skeleton-block" />
                    </div>
                  </div>
                )}

                {showAboutSection && (
                  <div className="game-detail__about-panel">
                    {(extendedDetails.developers?.length > 0 ||
                      extendedDetails.publishers?.length > 0) && (
                      <div className="game-detail__about-meta">
                        {extendedDetails.developers?.length > 0 && (
                          <div
                            className="game-detail__about-meta-item"
                            title={extendedDetails.developers
                              .map((d) => d.name)
                              .join(", ")}
                          >
                            <div className="game-detail__about-meta-icon-wrap">
                              <Code2 size={16} />
                            </div>
                            <div className="game-detail__about-meta-text">
                              <span className="game-detail__about-meta-label">
                                Developer
                              </span>
                              <span className="game-detail__about-meta-value">
                                {formatCompanyNames(extendedDetails.developers)}
                              </span>
                            </div>
                          </div>
                        )}
                        {extendedDetails.publishers?.length > 0 && (
                          <div
                            className="game-detail__about-meta-item"
                            title={extendedDetails.publishers
                              .map((p) => p.name)
                              .join(", ")}
                          >
                            <div className="game-detail__about-meta-icon-wrap">
                              <Building2 size={16} />
                            </div>
                            <div className="game-detail__about-meta-text">
                              <span className="game-detail__about-meta-label">
                                Publisher
                              </span>
                              <span className="game-detail__about-meta-value">
                                {formatCompanyNames(extendedDetails.publishers)}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {extendedDetails.description_raw && (
                      <>
                        <div
                          className={`game-detail__description game-detail__description--about${!descriptionExpanded && extendedDetails.description_raw.length > 400 ? " game-detail__description--collapsed" : ""}`}
                        >
                          {extendedDetails.description_raw}
                        </div>
                        {extendedDetails.description_raw.length > 400 && (
                          <button
                            className="game-detail__description-toggle"
                            onClick={() =>
                              setDescriptionExpanded(!descriptionExpanded)
                            }
                          >
                            {descriptionExpanded ? (
                              <>
                                <ChevronUp size={14} /> Show Less
                              </>
                            ) : (
                              <>
                                <ChevronDown size={14} /> Read More
                              </>
                            )}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}

                {showAboutFallback && (
                  <div className="game-detail__about-panel">
                    <div className="game-detail__description game-detail__description--about">
                      {aboutFallbackMessage}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="game-detail__side-col">
            <GamePerformanceCard game={game} />
            {showCoreChallengesPanel && (
              <AchievementsPreview
                data={coreChallengesData}
                loading={coreChallengesLoading}
                refreshing={ubisoftCoreChallengesQuery.isRefreshing}
                error={coreChallengesError}
                onShowAll={() => setShowCoreChallengesModal(true)}
                title="Core Challenges"
                itemLabel="core challenges"
                lockedLabel="Locked Challenges"
                ctaLabel="View All Core Challenges"
              />
            )}
            {showAchievementsPanel && (
              <AchievementsPreview
                data={achData}
                loading={achLoading}
                refreshing={achievementsQuery.isRefreshing}
                error={achError}
                onShowAll={() => setShowAchievementsModal(true)}
              />
            )}
            <div ref={hltbPanelRef}>
              <HowLongToBeatPanel
                data={hltbData}
                loading={hltbLoading}
                refreshing={hltbQuery.isRefreshing}
                error={hltbQuery.error}
              />
            </div>
          </div>
        </div>

        {((loadingDetails && !extendedDetails) ||
          extendedDetails?.similarGames?.length > 0) && (
          <SimilarGamesPanel
            games={extendedDetails?.similarGames}
            loading={loadingDetails && !extendedDetails}
            ownedNames={ownedNames}
            onGameClick={handleSimilarGameClick}
          />
        )}
      </div>

      {showAchievementsModal && (
        <AchievementsModal
          data={achData}
          loading={achLoading && !achData}
          error={!achData ? achError : null}
          onClose={() => setShowAchievementsModal(false)}
        />
      )}

      {showCoreChallengesModal && (
        <AchievementsModal
          data={coreChallengesData}
          loading={coreChallengesLoading && !coreChallengesData}
          error={!coreChallengesData ? coreChallengesError : null}
          onClose={() => setShowCoreChallengesModal(false)}
          title="Core Challenges"
          itemLabel="core challenges"
          lockedLabel="Locked"
        />
      )}

      {showImagePicker && (
        <ImagePicker
          game={game}
          onApply={handleApplyImages}
          onClose={() => setShowImagePicker(false)}
        />
      )}

      {showMetadataSearch && (
        <MetadataSearch
          game={game}
          onApply={handleApplyMetadata}
          onClose={() => setShowMetadataSearch(false)}
        />
      )}

      {showCollectionDrawer && collectionGames.length > 0 && (
        <div
          className="collection-drawer__backdrop"
          onClick={() => setShowCollectionDrawer(false)}
        >
          <div
            className="collection-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="collection-drawer__header">
              <div>
                <h3 className="collection-drawer__title">
                  {heroFranchiseName}
                </h3>
                <span className="collection-drawer__count">
                  {collectionGames.length} game
                  {collectionGames.length !== 1 ? "s" : ""}
                </span>
              </div>
              <button
                className="collection-drawer__close"
                onClick={() => setShowCollectionDrawer(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="collection-drawer__games">
              {collectionGames.map((g) => (
                <button
                  key={g.id}
                  className={`collection-drawer__game${g.id === game.id ? " collection-drawer__game--current" : ""}`}
                  onClick={() => {
                    setShowCollectionDrawer(false)
                    navigate(`/game/${g.id}`)
                  }}
                >
                  <div className="collection-drawer__game-cover">
                    {g.cover_url ? (
                      <img
                        src={g.cover_url}
                        alt={g.displayTitle}
                        className="collection-drawer__game-img"
                      />
                    ) : (
                      <div
                        className="collection-drawer__game-placeholder"
                        style={{
                          background:
                            g.gradient ||
                            "linear-gradient(135deg, #667eea, #764ba2)",
                        }}
                      />
                    )}
                    {g.id === game.id && (
                      <div className="collection-drawer__game-playing">
                        <Play size={12} fill="currentColor" /> Playing
                      </div>
                    )}
                  </div>
                  <span className="collection-drawer__game-title">
                    {g.displayTitle}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
