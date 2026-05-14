import {
  useState,
  useEffect,
  useCallback,
  useRef,
  createContext,
  useContext,
} from "react";
import {
  initDb,
  getAllGames,
  addGame as dbAdd,
  updateGame as dbUpdate,
  removeGame as dbRemove,
  incrementPlaytime,
  addSession,
  getUnenrichedGames,
  updateGameMetadata,
  getGamesNeedingCollectionEnrich,
  clearGameFranchise as dbClearFranchise,
  setGameCollection as dbSetCollection,
  clearGameCollection as dbClearCollection,
  markGameSeen as dbMarkGameSeen,
} from "../lib/db";
import {
  launchGame as launchExe,
  installGame as installViaLauncher,
  getInstallTarget,
} from "../lib/launcher";
import { syncLibrary } from "../lib/sync";
import { enrichAllGames, enrichCollectionData } from "../lib/rawg";
import { useAuth } from "./AuthContext";
import { useNotifications } from "./NotificationContext";
import {
  syncCloudToLocal,
  syncLocalToCloud,
  queueSyncLocalToCloud,
} from "../lib/cloudSync";
import { submitExecutableFeedback } from "../lib/executableCatalog";
import { classifyDeletionReason } from "../lib/executableNorm";
import DeleteFeedbackModal from "../components/games/DeleteFeedbackModal";
import LaunchConfirmModal from "../components/games/LaunchConfirmModal";
import { supabase } from "../lib/supabase";
import { preloadUpcomingFeeds, updateFeedCachesOnFollow } from "../hooks/useUpcomingGames";
import { getGameImages } from "../utils/imageHandler";
import { followBus } from "../lib/followBus";
import { applyCachedFollowChange } from "../lib/followedGamesStore";

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function normalizeTitleKey(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getGameTitleKeys(game) {
  const keys = new Set();
  [
    game?.title,
    game?.displayTitle,
    game?.normalized_title,
    game?.name,
  ].forEach((value) => {
    const key = normalizeTitleKey(value);
    if (key) keys.add(key);
  });
  return keys;
}

function getFollowTitleKeys(follow, cacheGame, feedGame) {
  const metadata = follow?.metadata ?? {};
  const keys = new Set();
  [
    metadata?.name,
    metadata?.title,
    metadata?.normalized_title,
    cacheGame?.name,
    cacheGame?.title,
    feedGame?.name,
    feedGame?.title,
  ].forEach((value) => {
    const key = normalizeTitleKey(value);
    if (key) keys.add(key);
  });
  return keys;
}

function formatTitleList(titles) {
  if (titles.length <= 2) return titles.map((t) => `"${t}"`).join(" and ");
  return `${titles.slice(0, 2).map((t) => `"${t}"`).join(", ")} and ${titles.length - 2} more`;
}

const GameContext = createContext(null);

export function GameProvider({ children }) {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { user } = useAuth();
  const { addNotification } = useNotifications();

  // Live session tracking
  const [activeGames, setActiveGames] = useState(new Set());
  const [liveElapsed, setLiveElapsed] = useState({}); // { [gameId]: seconds }
  const sessionStartsRef = useRef(new Map()); // Map<gameId, timestamp ms>
  const liveIntervalRef = useRef(null);

  // Loading screen & session summary
  const [launchingGame, setLaunchingGame] = useState(null);
  const [installingGame, setInstallingGame] = useState(null);
  const [sessionSummary, setSessionSummary] = useState(null);
  const [pendingLaunchConfirm, setPendingLaunchConfirm] = useState(null); // { game, resolve }
  const clearSessionSummary = useCallback(() => setSessionSummary(null), []);

  // Background sync state
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const syncIntervalRef = useRef(null);

  const [isCloudSyncing, setIsCloudSyncing] = useState(false);

  useEffect(() => {
    const handleStart = () => setIsCloudSyncing(true);
    const handleEnd = () => setIsCloudSyncing(false);
    window.addEventListener("cloud-sync-start", handleStart);
    window.addEventListener("cloud-sync-end", handleEnd);
    return () => {
      window.removeEventListener("cloud-sync-start", handleStart);
      window.removeEventListener("cloud-sync-end", handleEnd);
    };
  }, []);

  const [isEnriching, setIsEnriching] = useState(false);

  // Toast shown when new games are auto-detected
  const [syncToast, setSyncToast] = useState(null);
  const clearSyncToast = useCallback(() => setSyncToast(null), []);

  const refreshGames = useCallback(async () => {
    try {
      const rows = await getAllGames();
      setGames(rows);
      setError(null);
    } catch (err) {
      console.error("Failed to load games:", err);
      setError(err.message);
    }
  }, []);

  const removeLibraryGamesFromFollowing = useCallback(
    async (libraryGames) => {
      if (!user?.id || !Array.isArray(libraryGames) || libraryGames.length === 0) return [];

      const installedGames = libraryGames.filter(
        (game) => game?.installed || game?.status === "installed" || game?.status === "not_installed",
      );
      if (installedGames.length === 0) return [];

      const gameKeyToGame = new Map();
      for (const game of installedGames) {
        for (const key of getGameTitleKeys(game)) {
          if (!gameKeyToGame.has(key)) gameKeyToGame.set(key, game);
        }
      }
      if (gameKeyToGame.size === 0) return [];

      const { data: follows, error: followErr } = await supabase
        .from("user_followed_games")
        .select("id, source, source_game_id, metadata")
        .eq("user_id", user.id);

      if (followErr || !follows?.length) return [];

      const cacheByKey = new Map();
      const ids = follows.map((follow) => String(follow.source_game_id)).filter(Boolean);
      if (ids.length > 0) {
        const { data: cachedGames } = await supabase
          .from("upcoming_games_cache")
          .select("source, source_game_id, name, title, cover_url")
          .in("source_game_id", ids);

        for (const cacheGame of cachedGames ?? []) {
          cacheByKey.set(`${cacheGame.source}:${String(cacheGame.source_game_id)}`, cacheGame);
        }
      }

      let feedByKey = new Map();
      try {
        const needsFeedFallback = follows.some((follow) => {
          const cacheGame = cacheByKey.get(`${follow.source}:${String(follow.source_game_id)}`);
          return getFollowTitleKeys(follow, cacheGame).size === 0;
        });

        if (needsFeedFallback) {
          const { data } = await supabase.functions.invoke("get-upcoming-feeds", {
            body: {
              feed: "following",
              timeframe: "rest_of_year",
              page: 1,
              page_size: Math.max(48, follows.length),
              sort: "popularity",
            },
          });

          for (const game of data?.items ?? []) {
            feedByKey.set(`${game.source}:${String(game.source_game_id)}`, game);
          }
        }
      } catch (err) {
        console.warn("Could not load Following feed fallback for library cleanup:", err);
        feedByKey = new Map();
      }

      const matches = [];
      for (const follow of follows) {
        const key = `${follow.source}:${String(follow.source_game_id)}`;
        const cacheGame = cacheByKey.get(key);
        const feedGame = feedByKey.get(key);
        const followKeys = getFollowTitleKeys(follow, cacheGame, feedGame);
        for (const key of followKeys) {
          const libraryGame = gameKeyToGame.get(key);
          if (!libraryGame) continue;
          matches.push({ follow, cacheGame, feedGame, libraryGame });
          break;
        }
      }

      if (matches.length === 0) return [];

      const followIds = matches.map((match) => match.follow.id);
      const { error: deleteErr } = await supabase
        .from("user_followed_games")
        .delete()
        .eq("user_id", user.id)
        .in("id", followIds);

      if (deleteErr) {
        console.warn("Failed to remove library games from Following:", deleteErr);
        return [];
      }

      for (const match of matches) {
        updateFeedCachesOnFollow(user.id, -1, {
          ...(match.follow.metadata ?? {}),
          ...(match.cacheGame ?? {}),
          ...(match.feedGame ?? {}),
          source: match.follow.source,
          source_game_id: String(match.follow.source_game_id),
        });
        applyCachedFollowChange(user.id, match.follow.source, match.follow.source_game_id, false);
      }
      followBus.emit();

      const matchedGames = [];
      const seenGameIds = new Set();
      for (const match of matches) {
        const game = match.libraryGame;
        const id = game?.id || `${match.follow.source}:${match.follow.source_game_id}`;
        if (seenGameIds.has(id)) continue;
        seenGameIds.add(id);
        matchedGames.push(game);
      }

      const titles = matchedGames.map((game) => game.displayTitle || game.title || game.name).filter(Boolean);
      if (titles.length === 0) return matchedGames;

      const single = titles.length === 1;
      const toastMessage = single
        ? `"${titles[0]}" is now in your library, so it was removed from Following.`
        : `${titles.length} library games were removed from Following.`;
      setSyncToast({ message: toastMessage });

      addNotification({
        title: single ? "Moved to Library" : "Moved to Library",
        message: single
          ? `"${titles[0]}" is now in your library. Launch Deck removed it from Following to keep your tracking list focused.`
          : `${formatTitleList(titles)} are now in your library. Launch Deck removed them from Following to keep your tracking list focused.`,
        type: "info",
        image: single ? (matchedGames[0]?.cover_url || matchedGames[0]?.hero_url || null) : null,
        gameIds: matchedGames.map((game) => game.id).filter(Boolean),
        gamesInfo: matchedGames.map((game) => ({
          id: game.id,
          title: game.displayTitle || game.title || game.name,
          image: game.cover_url || game.hero_url || null,
        })).filter((game) => game.id && game.title),
      });

      return matchedGames;
    },
    [user?.id, addNotification],
  );

  // Preload cover + hero images for all games as soon as library is loaded
  useEffect(() => {
    if (loading || games.length === 0) return
    for (const game of games) {
      const { cover, hero } = getGameImages(game)
      if (cover) { const img = new Image(); img.src = cover }
      if (hero && hero !== cover) { const img = new Image(); img.src = hero }
    }
  }, [loading, games])

  const followingCleanupRunningRef = useRef(false);
  useEffect(() => {
    if (!user?.id || loading || games.length === 0 || followingCleanupRunningRef.current) return;

    let cancelled = false;
    followingCleanupRunningRef.current = true;
    removeLibraryGamesFromFollowing(games)
      .catch((err) => console.warn("Library/Following cleanup failed:", err))
      .finally(() => {
        followingCleanupRunningRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, loading, games, removeLibraryGamesFromFollowing]);

  const runSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await syncLibrary({ onProgress: setSyncStatus });
      let currentGames = null;
      if (result.added > 0 || result.updated > 0 || result.uninstalled > 0) {
        currentGames = await getAllGames();
        setGames(currentGames);
        setError(null);
      }
      if (result.added > 0) {
        setSyncToast({ count: result.added, titles: result.addedTitles });

        // Enrich metadata for newly added games in the background
        setIsEnriching(true);
        enrichAllGames(getUnenrichedGames, updateGameMetadata)
          .then(async () => {
            // Fetch updated games to grab the image url + ID for the notification
            const updatedGames = await getAllGames();
            if (result.added === 1) {
              const addedGame = updatedGames.find(
                (g) => g.title === result.addedTitles[0],
              );
              const imageUrl =
                addedGame?.cover_url || addedGame?.hero_url || null;
              addNotification({
                title: "New Game Added",
                message: `"${result.addedTitles[0]}" was successfully added to your library.`,
                type: "success",
                image: imageUrl,
                gameIds: addedGame ? [addedGame.id] : null,
              });
            } else {
              const titleList =
                result.addedTitles.length <= 5
                  ? result.addedTitles.map((t) => `"${t}"`).join(", ")
                  : `${result.addedTitles
                      .slice(0, 4)
                      .map((t) => `"${t}"`)
                      .join(", ")} and ${result.addedTitles.length - 4} more`;
              // Collect IDs + images for each added game
              const addedGamesInfo = result.addedTitles
                .map((t) => updatedGames.find((g) => g.title === t))
                .filter(Boolean)
                .map((g) => ({
                  id: g.id,
                  title: g.displayTitle || g.title,
                  image: g.cover_url || g.hero_url || null,
                }));
              addNotification({
                title: "Games Added",
                message: `${result.added} new games added: ${titleList}.`,
                type: "success",
                gameIds: addedGamesInfo.map((g) => g.id),
                gamesInfo: addedGamesInfo,
              });
            }
            refreshGames();
          })
          .catch(console.warn)
          .finally(() => setIsEnriching(false));
      }
      if (currentGames) {
        await removeLibraryGamesFromFollowing(currentGames);
      }

      if (result.uninstalled > 0) {
        const updatedGames = await getAllGames();
        let imageUrl = null;
        if (result.uninstalled === 1) {
          const removedGame = updatedGames.find(
            (g) => g.title === result.uninstalledTitles[0],
          );
          imageUrl = removedGame?.cover_url || removedGame?.hero_url || null;
        }

        addNotification({
          title:
            result.uninstalled === 1 ? "Game Uninstalled" : "Games Uninstalled",
          message:
            result.uninstalled === 1
              ? `"${result.uninstalledTitles[0]}" was removed from your drive.`
              : result.uninstalled === 2
                ? `"${result.uninstalledTitles[0]}" and "${result.uninstalledTitles[1]}" were removed.`
                : `${result.uninstalled} games were removed from your drive.`,
          type: "info",
          image: imageUrl,
        });
      }
    } catch (err) {
      console.warn("Library sync error:", err);
    } finally {
      setSyncing(false);
      setSyncStatus(null);
    }
  }, [syncing, refreshGames, removeLibraryGamesFromFollowing, addNotification]);

  // Initialize DB, load games, then run first sync
  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        // Fetch session directly to bypass hook timing dependencies
        const {
          data: { session },
        } = await supabase.auth.getSession();

        // Preload the Dashboard's default "For You" feed concurrently with DB
        // init.  Promise.allSettled waits for both, so the Dashboard renders
        // with cached data instead of showing skeletons.  Background feeds
        // (other tabs) start in parallel inside preloadUpcomingFeeds and
        // continue after this resolves.
        await Promise.allSettled([
          (async () => {
            await initDb();
            const rows = await getAllGames();
            if (mounted) {
              setGames(rows);
              setError(null);
            }
          })(),
          session?.user?.id
            ? preloadUpcomingFeeds(session.user.id, "for_you")
            : Promise.resolve(),
        ]);
      } catch (err) {
        console.error("Initialization failed:", err);
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }

      // Run first sync after DB is ready (non-blocking)
      if (mounted) {
        runSync();
        syncIntervalRef.current = setInterval(() => {
          if (mounted) runSync();
        }, SYNC_INTERVAL_MS);
      }
    }

    init();
    return () => {
      mounted = false;
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle cloud sync when user logs in or DB finishes loading
  useEffect(() => {
    let mounted = true;
    if (user && !loading) {
      (async () => {
        try {
          const syncResult = await syncCloudToLocal(user.id);
          await syncLocalToCloud(user.id);
          if (mounted) {
            const currentGames = await getAllGames();
            setGames(currentGames);
            setError(null);
            await removeLibraryGamesFromFollowing(currentGames);
            if (syncResult && syncResult.added > 0) {
              setIsEnriching(true);
              enrichAllGames(getUnenrichedGames, updateGameMetadata)
                .then(() => {
                  if (mounted) refreshGames();
                })
                .catch(console.warn)
                .finally(() => {
                  if (mounted) setIsEnriching(false);
                });
            }
          }
        } catch (err) {
          console.error("Cloud sync failed:", err);
        }
      })();
    }
    return () => {
      mounted = false;
    };
  }, [user, loading, refreshGames, removeLibraryGamesFromFollowing]);

  // Cleanup live interval on unmount
  useEffect(() => {
    return () => {
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
    };
  }, []);

  const addGame = useCallback(
    async ({ title, install_path, platform }) => {
      try {
        const newGame = await dbAdd({ title, install_path, platform });
        setGames((prev) => [...prev, newGame]);
        await removeLibraryGamesFromFollowing([newGame]);
        if (user) queueSyncLocalToCloud(user.id);
        // Enrich metadata for the newly added game in the background
        setIsEnriching(true);
        enrichAllGames(getUnenrichedGames, updateGameMetadata)
          .then(() => refreshGames())
          .catch(console.warn)
          .finally(() => setIsEnriching(false));
        return newGame;
      } catch (err) {
        console.error("Failed to add game:", err);
        throw err;
      }
    },
    [user, refreshGames, removeLibraryGamesFromFollowing],
  );

  const updateGame = useCallback(
    async (id, updates) => {
      try {
        await dbUpdate(id, updates);
        await refreshGames();
        if (user) queueSyncLocalToCloud(user.id);
      } catch (err) {
        console.error("Failed to update game:", err);
        throw err;
      }
    },
    [refreshGames, user],
  );

  // ── Two-step remove: show feedback modal, then finalize ──────────────────
  const [pendingRemoveGame, setPendingRemoveGame] = useState(null); // { id, game }

  /** Step 1: called by UI — opens the feedback modal instead of removing immediately. */
  const removeGame = useCallback(
    (id) => {
      const game = games.find((g) => g.id === id) ?? null;
      setPendingRemoveGame({ id, game });
    },
    [games],
  );

  /** Step 2: called by DeleteFeedbackModal on confirm — performs the actual removal. */
  const confirmRemoveGame = useCallback(
    async (reason, details) => {
      if (!pendingRemoveGame) return;
      const { id, game } = pendingRemoveGame;
      setPendingRemoveGame(null);
      try {
        await dbRemove(id);
        setGames((prev) => prev.filter((g) => g.id !== id));
        if (user) queueSyncLocalToCloud(user.id);

        // Persist user feedback to Supabase (non-blocking)
        if (user && game?.install_path) {
          submitExecutableFeedback(user.id, {
            exe_name: game.raw_file_name || "",
            normalized_exe_name: "",
            exe_path: game.install_path || "",
            reason: classifyDeletionReason(reason),
            details: details ?? null,
            user_game_executable_id: null,
          }).catch(() => {});
        }
      } catch (err) {
        console.error("Failed to remove game:", err);
      }
    },
    [pendingRemoveGame, user],
  );

  const cancelRemoveGame = useCallback(() => setPendingRemoveGame(null), []);

  const toggleFavorite = useCallback(
    async (id) => {
      const game = games.find((g) => g.id === id);
      if (!game) return;
      try {
        await dbUpdate(id, { favorite: game.favorite ? 0 : 1 });
        await refreshGames();
        if (user) queueSyncLocalToCloud(user.id);
      } catch (err) {
        console.error("Failed to toggle favorite:", err);
      }
    },
    [games, refreshGames, user],
  );

  const forceEndSession = useCallback(
    async (gameId) => {
      const sessionStart = sessionStartsRef.current.get(gameId);
      if (!sessionStart) return;

      const sessionEnd = Date.now();
      const elapsedSecs = Math.round((sessionEnd - sessionStart) / 1000);
      const elapsedMins = Math.round(elapsedSecs / 60);

      sessionStartsRef.current.delete(gameId);
      setActiveGames((prev) => {
        const n = new Set(prev);
        n.delete(gameId);
        return n;
      });
      setLiveElapsed((prev) => {
        const n = { ...prev };
        delete n[gameId];
        return n;
      });

      if (sessionStartsRef.current.size === 0 && liveIntervalRef.current) {
        clearInterval(liveIntervalRef.current);
        liveIntervalRef.current = null;
      }

      if (elapsedMins > 0) {
        const startIso = new Date(sessionStart).toISOString();
        const endIso = new Date(sessionEnd).toISOString();
        await addSession(gameId, startIso, endIso, elapsedMins).catch(
          console.error,
        );
        await incrementPlaytime(gameId, elapsedMins).catch(console.error);
        if (user) queueSyncLocalToCloud(user.id);
      }
      await refreshGames();

      const game = games.find((g) => g.id === gameId);
      if (game && elapsedSecs >= 10) {
        setSessionSummary({
          game,
          elapsedSecs,
          newAchievements: [],
          achData: null,
          achLoading: false,
        });
      }
    },
    [games, refreshGames, user],
  );

  const playGame = useCallback(
    async (game, { steamId } = {}) => {
      const isTauri =
        typeof window !== "undefined" &&
        !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

      // Optional confirm prompt (Settings → Library → Confirm before launching)
      let shouldConfirm = false;
      try {
        shouldConfirm = JSON.parse(
          localStorage.getItem("ld_setting_confirmBeforeLaunch") || "false",
        );
      } catch {
        shouldConfirm = false;
      }
      if (shouldConfirm) {
        const ok = await new Promise((resolve) => {
          setPendingLaunchConfirm({ game, resolve });
        });
        setPendingLaunchConfirm(null);
        if (!ok) return;
      }

      const sessionStart = Date.now();
      const sessionStartSecs = Math.floor(sessionStart / 1000);

      // Show loading screen
      setLaunchingGame(game);
      const showedAt = Date.now();

      // Launch game FIRST — no awaits before this to avoid blocking
      try {
        await launchExe(game);
      } catch (err) {
        setLaunchingGame(null);
        console.error("Failed to launch game:", err);
        throw err;
      }

      // Keep loading screen up long enough for the game to start
      const MIN_SHOW_MS = 4000;
      const waited = Date.now() - showedAt;
      if (waited < MIN_SHOW_MS) {
        await new Promise((r) => setTimeout(r, MIN_SHOW_MS - waited));
      }

      // Game has had time to load — close loading screen
      setLaunchingGame(null);
      await refreshGames();

      // Mark game as active and start live elapsed timer
      sessionStartsRef.current.set(game.id, sessionStart);
      const activeIso = new Date(sessionStart).toISOString();

      // Proactively update last_played so Hero Banner updates instantly
      dbUpdate(game.id, { last_played: activeIso }).catch(console.error);

      setActiveGames((prev) => {
        const next = new Set(prev);
        next.add(game.id);
        return next;
      });
      setLiveElapsed((prev) => ({ ...prev, [game.id]: 0 }));

      if (!liveIntervalRef.current) {
        liveIntervalRef.current = setInterval(() => {
          setLiveElapsed(() => {
            const next = {};
            for (const [id, start] of sessionStartsRef.current) {
              next[id] = Math.floor((Date.now() - start) / 1000);
            }
            return next;
          });
        }, 1000);
      }

      // Set up playtime listener (game is already running)
      if (isTauri) {
        try {
          const { listen } = await import("@tauri-apps/api/event");

          // Finalizes the session: persists data + shows the end-of-session modal
          const finalizeSession = async (elapsedSecs) => {
            if (!sessionStartsRef.current.has(game.id)) return;
            const sessionEnd = Date.now();
            const elapsedMins = Math.round(elapsedSecs / 60);

            sessionStartsRef.current.delete(game.id);
            setActiveGames((prev) => {
              const n = new Set(prev);
              n.delete(game.id);
              return n;
            });
            setLiveElapsed((prev) => {
              const n = { ...prev };
              delete n[game.id];
              return n;
            });

            if (
              sessionStartsRef.current.size === 0 &&
              liveIntervalRef.current
            ) {
              clearInterval(liveIntervalRef.current);
              liveIntervalRef.current = null;
            }

            if (elapsedMins > 0) {
              const startIso = new Date(sessionStart).toISOString();
              const endIso = new Date(sessionEnd).toISOString();
              await addSession(game.id, startIso, endIso, elapsedMins).catch(
                console.error,
              );
              await incrementPlaytime(game.id, elapsedMins).catch(
                console.error,
              );
              if (user) queueSyncLocalToCloud(user.id);
            }
            await refreshGames();

            if (elapsedSecs >= 10) {
              setSessionSummary({
                game,
                elapsedSecs,
                newAchievements: [],
                achData: null,
                achLoading: !!steamId,
              });
              if (steamId) {
                setTimeout(async () => {
                  try {
                    const postData = await invoke("get_steam_achievements", {
                      query:
                        game.displayTitle ||
                        game.normalized_title ||
                        game.title,
                      steamId,
                      appId: Number.parseInt(game.steam_app_id, 10) || null,
                      steamApiKey: localStorage.getItem("steamApiKey") || "",
                    });
                    const newAchs = (postData?.achievements || []).filter(
                      (a) => a.unlocked && a.unlock_time >= sessionStartSecs,
                    );
                    setSessionSummary((prev) =>
                      prev
                        ? {
                            ...prev,
                            newAchievements: newAchs,
                            achData: postData,
                            achLoading: false,
                          }
                        : null,
                    );
                  } catch {
                    setSessionSummary((prev) =>
                      prev ? { ...prev, achLoading: false } : null,
                    );
                  }
                }, 6000);
              }
            }
          };

          // Poll the OS process list until the game exe is gone, then finalize.
          // Used when the direct child exits quickly (launcher stub pattern).
          const startProcessPolling = (unlisten) => {
            const exeName =
              game.install_path?.replace(/\\/g, "/").split("/").pop() || "";
            if (!exeName) return;

            const pollInterval = setInterval(async () => {
              if (!sessionStartsRef.current.has(game.id)) {
                clearInterval(pollInterval);
                unlisten();
                return;
              }
              try {
                const isRunning = await invoke("check_process_running", {
                  processName: exeName,
                });
                if (!isRunning) {
                  clearInterval(pollInterval);
                  unlisten();
                  const elapsedSecs = Math.round(
                    (Date.now() - sessionStart) / 1000,
                  );
                  await finalizeSession(elapsedSecs);
                }
              } catch {
                // check_process_running unavailable — stop polling silently
                clearInterval(pollInterval);
              }
            }, 10_000);

            // Absolute safety net: end session after 8 hours
            setTimeout(
              async () => {
                if (!sessionStartsRef.current.has(game.id)) return;
                clearInterval(pollInterval);
                unlisten();
                const elapsedSecs = Math.round(
                  (Date.now() - sessionStart) / 1000,
                );
                await finalizeSession(elapsedSecs);
              },
              8 * 60 * 60 * 1000,
            );
          };

          // Primary exit listener emitted by the Rust process watcher
          const STUB_EXIT_THRESHOLD_SECS = 8;
          const unlisten = await listen("game_exited", async (event) => {
            if (event.payload.game_id !== game.id) return;

            // Session already manually ended — clean up listener and exit
            if (!sessionStartsRef.current.has(game.id)) {
              unlisten();
              return;
            }

            const reportedElapsed = event.payload.elapsed_seconds || 0;

            // If the direct process exited in <8 s it was almost certainly a launcher
            // stub (e.g. EA App stub, Epic bootstrap). Keep the session alive and poll
            // the real game exe instead of ending immediately.
            if (reportedElapsed < STUB_EXIT_THRESHOLD_SECS) {
              startProcessPolling(unlisten);
              return;
            }

            unlisten();
            await finalizeSession(reportedElapsed);
          });
        } catch (err) {
          console.warn("Could not set up playtime tracking:", err);
        }
      }
    },
    [refreshGames],
  );

  const installGame = useCallback(async (game) => {
    const installTarget = getInstallTarget(game);
    if (!installTarget) {
      throw new Error("No launcher install target is available for this game");
    }

    setInstallingGame({
      game,
      launcher: installTarget.launcher,
    });
    const showedAt = Date.now();

    try {
      await installViaLauncher(game);
    } catch (err) {
      setInstallingGame(null);
      console.error("Failed to open install flow:", err);
      throw err;
    }

    const MIN_SHOW_MS = 2800;
    const waited = Date.now() - showedAt;
    if (waited < MIN_SHOW_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_SHOW_MS - waited));
    }

    setInstallingGame(null);
  }, []);

  const [isFranchiseEnriching, setIsFranchiseEnriching] = useState(false);

  /**
   * Targeted re-enrichment: fetches collection/franchise data only for games
   * that are already enriched but are missing this metadata.
   * Safe — never overwrites cover/hero/logo/rating.
   */
  const enrichFranchiseData = useCallback(
    async (onProgress) => {
      if (isFranchiseEnriching) return 0;
      setIsFranchiseEnriching(true);
      try {
        const pending = await getGamesNeedingCollectionEnrich();
        if (pending.length === 0) return 0;
        await enrichCollectionData(pending, updateGameMetadata, onProgress);
        await refreshGames();
        return pending.length;
      } catch (err) {
        console.error("Franchise enrichment failed:", err);
        return 0;
      } finally {
        setIsFranchiseEnriching(false);
      }
    },
    [isFranchiseEnriching, refreshGames],
  );

  /** Re-fetch franchise/collection data for a specific list of game objects. */
  const refetchFranchiseForGames = useCallback(
    async (gameList, onProgress) => {
      if (isFranchiseEnriching || !gameList?.length) return 0;
      setIsFranchiseEnriching(true);
      try {
        await enrichCollectionData(gameList, updateGameMetadata, onProgress);
        await refreshGames();
        return gameList.length;
      } catch (err) {
        console.error("Franchise re-fetch failed:", err);
        return 0;
      } finally {
        setIsFranchiseEnriching(false);
      }
    },
    [isFranchiseEnriching, refreshGames],
  );

  /** Clear franchise/collection data for one game so it can be re-enriched. */
  const clearGameFranchise = useCallback(
    async (gameId) => {
      await dbClearFranchise(gameId);
      refreshGames();
    },
    [refreshGames],
  );

  /** Set a user-defined collection override for a game. */
  const setGameCollection = useCallback(
    async (gameId, collectionName) => {
      await dbSetCollection(gameId, collectionName);
      refreshGames();
    },
    [refreshGames],
  );

  /** Clear user-defined collection override, reverting to auto-detected grouping. */
  const clearGameCollection = useCallback(
    async (gameId) => {
      await dbClearCollection(gameId);
      refreshGames();
    },
    [refreshGames],
  );

  /** Mark a game as seen — clears the "New" badge. */
  const markGameSeen = useCallback(async (id) => {
    await dbMarkGameSeen(id);
    setGames((prev) =>
      prev.map((g) => (g.id === id ? { ...g, is_new: 0 } : g)),
    );
  }, []);

  return (
    <GameContext.Provider
      value={{
        games,
        loading,
        error,
        addGame,
        updateGame,
        removeGame,
        toggleFavorite,
        playGame,
        forceEndSession,
        installGame,
        refreshGames,
        activeGames,
        liveElapsed,
        launchingGame,
        installingGame,
        sessionSummary,
        clearSessionSummary,
        syncLibrary: runSync,
        syncing,
        syncStatus,
        syncToast,
        clearSyncToast,
        isCloudSyncing,
        isEnriching,
        enrichFranchiseData,
        isFranchiseEnriching,
        refetchFranchiseForGames,
        clearGameFranchise,
        setGameCollection,
        clearGameCollection,
        markGameSeen,
      }}
    >
      {children}

      {/* Global delete-feedback modal — rendered here so it works from any page */}
      <DeleteFeedbackModal
        game={pendingRemoveGame?.game ?? null}
        onConfirm={confirmRemoveGame}
        onCancel={cancelRemoveGame}
      />

      {/* Launch confirmation modal (Settings → Library → Confirm before launching) */}
      {pendingLaunchConfirm && (
        <LaunchConfirmModal
          game={pendingLaunchConfirm.game}
          onConfirm={() => {
            pendingLaunchConfirm.resolve(true);
            setPendingLaunchConfirm(null);
          }}
          onCancel={() => {
            pendingLaunchConfirm.resolve(false);
            setPendingLaunchConfirm(null);
          }}
        />
      )}
    </GameContext.Provider>
  );
}

export function useGameContext() {
  const context = useContext(GameContext);
  if (!context)
    throw new Error("useGameContext must be used within GameProvider");
  return context;
}
