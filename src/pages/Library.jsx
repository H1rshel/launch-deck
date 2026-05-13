import { useState, useMemo, useCallback } from "react"
import TopBar from "../components/layout/TopBar"
import PageHeader from "../components/layout/PageHeader"
import GameGrid from "../components/games/GameGrid"
import CompactGameCard from "../components/games/CompactGameCard"
import CollectionSearchModal from "../components/games/CollectionSearchModal"
import { useGames } from "../hooks/useGames"
import { useGameContext } from "../context/GameContext"
import { getGameImages } from "../utils/imageHandler"
import {
  ArrowUpDown,
  RefreshCw,
  Layers,
  ChevronDown,
  Sparkles,
  Loader,
  Search,
  Pencil,
  LibraryBig,
} from "lucide-react"
import { Select } from "../components/ui/Select"

const filters = [
  { key: "all", label: "All Games" },
  { key: "installed", label: "Installed" },
  { key: "not_installed", label: "Not Installed" },
  { key: "favorites", label: "Favorites" },
  { key: "collections", label: "Collections" },
]

const sorts = [
  { key: "name", label: "Name" },
  { key: "rating", label: "Rating" },
  { key: "recent", label: "Last Played" },
  { key: "release", label: "Release Date" },
]

function FranchiseGroupedView({
  games,
  onEnrich,
  isFranchiseEnriching,
  onRefetchGroup,
  onClearGame,
  onSetCollection,
  onClearCollection,
}) {
  const [collapsed, setCollapsed] = useState(new Set())
  const [closing, setClosing] = useState(new Set())
  const [collectionModal, setCollectionModal] = useState(null) // { game } or { games, groupName } or null
  const [renameModal, setRenameModal] = useState(null) // { groupName, games } or null
  const [searchFilter, setSearchFilter] = useState("")

  const { groups, ungrouped, allCollectionNames } = useMemo(() => {
    const map = new Map()
    const ungrouped = []
    const allNames = new Set()
    for (const game of games) {
      // User override takes priority, then IGDB collection, then franchise
      const key =
        game.user_collection ||
        game.collectionNames?.[0] ||
        game.franchiseNames?.[0]
      if (key) {
        allNames.add(key)
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(game)
      } else {
        ungrouped.push(game)
      }
    }
    let groups = [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, gs]) => ({ name, games: gs }))
    return { groups, ungrouped, allCollectionNames: [...allNames].sort() }
  }, [games])

  // Filter groups by search
  const filteredGroups = useMemo(() => {
    if (!searchFilter.trim()) return groups
    const q = searchFilter.toLowerCase()
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        g.games.some((game) => game.displayTitle.toLowerCase().includes(q)),
    )
  }, [groups, searchFilter])

  function isOpen(key) {
    return !collapsed.has(key)
  }
  function isClosing(key) {
    return closing.has(key)
  }

  function toggle(key) {
    if (closing.has(key)) return
    if (!collapsed.has(key)) {
      setClosing((prev) => new Set([...prev, key]))
      setTimeout(() => {
        setCollapsed((prev) => new Set([...prev, key]))
        setClosing((prev) => {
          const n = new Set(prev)
          n.delete(key)
          return n
        })
      }, 300)
    } else {
      setCollapsed((prev) => {
        const n = new Set(prev)
        n.delete(key)
        return n
      })
    }
  }

  function collapseAll() {
    setCollapsed(
      new Set(
        groups
          .map((g) => g.name)
          .concat(ungrouped.length > 0 ? ["__other__"] : []),
      ),
    )
  }

  function expandAll() {
    setCollapsed(new Set())
  }

  // Move a single game to a collection
  const handleMoveGame = useCallback((game) => {
    setCollectionModal({ game })
  }, [])

  // Rename an entire collection
  const handleRenameGroup = useCallback((groupName, groupGames) => {
    setRenameModal({ groupName, games: groupGames })
  }, [])

  // Handle collection selection from modal
  const handleCollectionSelect = useCallback(
    (collectionName) => {
      if (collectionModal?.game) {
        onSetCollection(collectionModal.game.id, collectionName)
      }
      setCollectionModal(null)
    },
    [collectionModal, onSetCollection],
  )

  // Handle rename - moves all games in old group to new collection name
  const handleRenameSelect = useCallback(
    (newName) => {
      if (renameModal?.games) {
        for (const game of renameModal.games) {
          onSetCollection(game.id, newName)
        }
      }
      setRenameModal(null)
    },
    [renameModal, onSetCollection],
  )

  const showEnrichPrompt =
    onEnrich && groups.length === 0 && ungrouped.length > 0

  if (groups.length === 0 && ungrouped.length === 0) {
    return (
      <div className="library__collections-empty">
        <Layers size={48} className="library__collections-empty-icon" />
        <p className="library__collections-empty-title">
          No collection data yet
        </p>
        <p className="library__collections-empty-hint">
          Fetch collection and series metadata from IGDB to group your library.
        </p>
        {onEnrich && (
          <button
            className="library__enrich-btn"
            onClick={() => onEnrich()}
            disabled={isFranchiseEnriching}
          >
            {isFranchiseEnriching ? (
              <>
                <Loader
                  size={14}
                  className="library__enrich-btn-icon--spinning"
                />{" "}
                Fetching…
              </>
            ) : (
              <>
                <Sparkles size={14} /> Fetch Franchise Data
              </>
            )}
          </button>
        )}
      </div>
    )
  }

  function renderGroup(key, groupGames, label) {
    const previewGames = groupGames.slice(0, 4)
    const heroGame = groupGames[0]
    const heroImage = heroGame
      ? getGameImages(heroGame).hero || getGameImages(heroGame).cover
      : null
    const open = isOpen(key)
    const animOut = isClosing(key)
    const isOther = key === "__other__"

    return (
      <div
        key={key}
        className={`fgroup${open && !animOut ? " fgroup--open" : ""}`}
      >
        {/* ── Header with hero background ── */}
        <div className="fgroup__header" onClick={() => toggle(key)}>
          {heroImage && !isOther && (
            <div
              className="fgroup__header-bg"
              style={{ backgroundImage: `url(${heroImage})` }}
            />
          )}
          <div className="fgroup__header-overlay" />

          {/* Cover stack */}
          <div className="fgroup__covers">
            {previewGames.map((g, i) => {
              const img = getGameImages(g).cover
              return (
                <div
                  key={g.id}
                  className="fgroup__cover-thumb"
                  style={{
                    "--idx": i,
                    background: img
                      ? `url(${img}) center / cover no-repeat`
                      : g.gradient ||
                        "linear-gradient(135deg, #667eea, #764ba2)",
                  }}
                />
              )
            })}
          </div>

          {/* Info */}
          <div className="fgroup__info">
            <span className="fgroup__name">{label}</span>
            <span className="fgroup__count">
              {groupGames.length} game{groupGames.length !== 1 ? "s" : ""}
              {groupGames.some((g) => g.user_collection) && (
                <span className="fgroup__count-custom"> · custom</span>
              )}
            </span>
          </div>

          {/* Actions */}
          <div className="fgroup__actions" onClick={(e) => e.stopPropagation()}>
            {!isOther && (
              <button
                className="fgroup__action-btn"
                title="Rename collection"
                onClick={() => handleRenameGroup(label, groupGames)}
              >
                <Pencil size={12} />
              </button>
            )}
            {onRefetchGroup && !isOther && (
              <button
                className="fgroup__action-btn"
                title="Re-fetch from IGDB"
                disabled={isFranchiseEnriching}
                onClick={() => onRefetchGroup(groupGames)}
              >
                <RefreshCw
                  size={12}
                  className={isFranchiseEnriching ? "fgroup__spin" : ""}
                />
              </button>
            )}
          </div>

          <ChevronDown
            size={16}
            className={`fgroup__chevron${!open && !animOut ? " fgroup__chevron--collapsed" : ""}`}
          />
        </div>

        {/* ── Compact game cards ── */}
        {(open || animOut) && (
          <div
            className={`fgroup__content${animOut ? " fgroup__content--closing" : ""}`}
          >
            <div className="fgroup__game-grid">
              {groupGames.map((game) => (
                <CompactGameCard
                  key={game.id}
                  game={game}
                  onMoveToCollection={handleMoveGame}
                  onRemoveFromCollection={
                    game.user_collection
                      ? () => onClearCollection(game.id)
                      : undefined
                  }
                  onClearFranchise={onClearGame}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="library__collections">
      {/* Toolbar */}
      <div className="library__collections-toolbar">
        <div className="library__collections-search">
          <Search size={13} />
          <input
            className="library__collections-search-input"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Filter collections…"
          />
        </div>
        <div className="library__collections-toolbar-actions">
          <button
            className="fgroup__action-btn"
            onClick={expandAll}
            title="Expand all"
          >
            <ChevronDown size={13} />
            <span>Expand</span>
          </button>
          <button
            className="fgroup__action-btn"
            onClick={collapseAll}
            title="Collapse all"
          >
            <ChevronDown size={13} style={{ transform: "rotate(-90deg)" }} />
            <span>Collapse</span>
          </button>
          {onEnrich && (
            <button
              className="library__enrich-btn library__enrich-btn--compact"
              onClick={() => onEnrich()}
              disabled={isFranchiseEnriching}
            >
              {isFranchiseEnriching ? (
                <>
                  <Loader size={12} className="fgroup__spin" /> Fetching…
                </>
              ) : (
                <>
                  <Sparkles size={12} /> Auto-detect
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {showEnrichPrompt && (
        <div className="library__enrich-banner">
          <span className="library__enrich-banner-text">
            {ungrouped.length} game{ungrouped.length !== 1 ? "s" : ""} missing
            franchise data.
          </span>
          <button
            className="library__enrich-btn"
            onClick={() => onEnrich()}
            disabled={isFranchiseEnriching}
          >
            {isFranchiseEnriching ? (
              <>
                <Loader size={13} className="fgroup__spin" /> Fetching…
              </>
            ) : (
              <>
                <Sparkles size={13} /> Fetch Franchise Data
              </>
            )}
          </button>
        </div>
      )}

      {filteredGroups.map(({ name, games: gs }) => renderGroup(name, gs, name))}

      {ungrouped.length > 0 &&
        !searchFilter.trim() &&
        renderGroup("__other__", ungrouped, "Other")}

      {/* Collection search modals */}
      <CollectionSearchModal
        open={!!collectionModal}
        onClose={() => setCollectionModal(null)}
        onSelect={handleCollectionSelect}
        title={
          collectionModal?.game
            ? `Move "${collectionModal.game.displayTitle}"`
            : "Choose Collection"
        }
        existingCollections={allCollectionNames}
      />
      <CollectionSearchModal
        open={!!renameModal}
        onClose={() => setRenameModal(null)}
        onSelect={handleRenameSelect}
        title={
          renameModal
            ? `Rename "${renameModal.groupName}"`
            : "Rename Collection"
        }
        existingCollections={allCollectionNames}
      />
    </div>
  )
}

export default function Library() {
  const {
    games,
    gameCounts,
    filter,
    setFilter,
    sortBy,
    setSortBy,
    searchQuery,
    setSearchQuery,
  } = useGames()
  const {
    removeGame,
    syncLibrary,
    syncing,
    syncStatus,
    enrichFranchiseData,
    isFranchiseEnriching,
    refetchFranchiseForGames,
    clearGameFranchise,
    setGameCollection,
    clearGameCollection,
  } = useGameContext()

  const totalCount = gameCounts.all ?? games.length

  return (
    <div className="page library page--unified">
      <TopBar searchQuery={searchQuery} onSearchChange={setSearchQuery} />
      <PageHeader
        variant="compact"
        eyebrow="Library"
        eyebrowIcon={LibraryBig}
        title="Game Library"
        image="/game-library.png"
        subtitle={`${totalCount} game${totalCount !== 1 ? "s" : ""} across your collections`}
        actions={
          <button
            className="library__rescan-btn"
            onClick={syncLibrary}
            disabled={syncing}
            title={syncing ? syncStatus || "Syncing..." : "Rescan library"}
          >
            <RefreshCw
              size={14}
              className={syncing ? "library__rescan-icon--spinning" : ""}
            />
            {syncing ? syncStatus || "Syncing..." : "Rescan"}
          </button>
        }
      />
      <div className="page__content">
        <div className="glass-panel library__toolbar">
          <div className="library__toolbar-group library__filters">
            {filters.map((f) => (
              <button
                key={f.key}
                className={`library__filter-btn ${
                  filter === f.key ? "library__filter-btn--active" : ""
                }`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="library__filter-count">
                  {gameCounts[f.key] ?? 0}
                </span>
              </button>
            ))}
          </div>
          <div className="library__toolbar-spacer" />
          <div className="library__toolbar-divider" />
          <div className="library__sort library__toolbar-group">
            <ArrowUpDown size={14} className="library__sort-icon" />
            <Select
              value={sortBy}
              onChange={setSortBy}
              options={sorts.map((s) => ({ label: s.label, value: s.key }))}
            />
          </div>
        </div>

        {filter === "collections" ? (
          <FranchiseGroupedView
            games={games}
            onEnrich={enrichFranchiseData}
            isFranchiseEnriching={isFranchiseEnriching}
            onRefetchGroup={refetchFranchiseForGames}
            onClearGame={clearGameFranchise}
            onSetCollection={setGameCollection}
            onClearCollection={clearGameCollection}
          />
        ) : (
          <GameGrid games={games} onRemoveGame={removeGame} />
        )}
      </div>
    </div>
  )
}
