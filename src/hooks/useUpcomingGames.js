import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./useAuth";
import { followBus } from "../lib/followBus";
import {
  applyCachedFollowChange,
  gameKey as followedGameKey,
  getCachedFollowedSet,
  loadFollowedSet,
  mergeCachedFollowedGames,
  setCachedFollowedSet,
} from "../lib/followedGamesStore";

// ── Module-level TTL cache ────────────────────────────────────────────────────
// Keyed by userId + request params. Survives tab switches, page navigation,
// and component remounts — the most common cause of redundant API calls.
const _feedCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — recent releases update frequently

// Set by preloadUpcomingFeeds so the hook's synchronous useState initializer
// can look up cached data before useAuth() resolves the user.
let _preloadedUserId = null;

function _cacheKey(userId, feed, timeframe, page, date_from, date_to, sort) {
  return [
    userId || "anon",
    feed,
    timeframe,
    page,
    date_from || "",
    date_to || "",
    sort || "",
  ].join("|");
}

function _getCached(key) {
  const entry = _feedCache.get(key);
  if (!entry) return null;
  // Cache key format: userId|feed|timeframe|page|date_from|date_to|sort
  const feedInKey = key.split("|")[1];
  const ttl = feedInKey === "recent" ? RECENT_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) {
    _feedCache.delete(key);
    return null;
  }
  return entry;
}

function _setCache(key, payload) {
  _feedCache.set(key, { ...payload, ts: Date.now() });
}

/** Bust the Following feed cache only (used when the feed list needs refreshing). */
export function bustFollowingFeedCache() {
  for (const [k] of _feedCache) {
    if (k.includes("|following|")) _feedCache.delete(k);
  }
}

/**
 * Bust ALL cached feed entries for a given user.
 * Called after follow/unfollow because every feed's cached response contains
 * the shared `facets` object (with `following_count`). Leaving other feeds
 * cached would cause stale badge counts when switching tabs.
 */
export function bustAllUserFeedCache(userId) {
  const prefix = (userId || "anon") + "|";
  for (const [k] of _feedCache) {
    if (k.startsWith(prefix)) _feedCache.delete(k);
  }
}

function _byReleaseDateAsc(a, b) {
  if (!a.release_date && !b.release_date) return 0;
  if (!a.release_date) return 1;
  if (!b.release_date) return -1;
  return new Date(a.release_date).getTime() - new Date(b.release_date).getTime();
}

/**
 * Targeted cache update after a follow/unfollow action.
 * - When `game` is provided: optimistically adds/removes it from every cached
 *   'following' feed page — no API re-fetch needed, game appears instantly.
 * - When `game` is null: deletes the 'following' entries so the next render
 *   triggers a fresh fetch (safe fallback when game data is unavailable).
 * - Updates following_count facets in-place for all other feeds.
 * diff = +1 for follow, -1 for unfollow.
 */
export function updateFeedCachesOnFollow(userId, diff, game = null) {
  const prefix = (userId || "anon") + "|";
  const gameId = game ? followedGameKey(game.source, game.source_game_id) : null;
  let foundFollowingEntry = false;

  for (const [k, v] of _feedCache) {
    if (!k.startsWith(prefix)) continue;

    if (k.includes("|following|")) {
      foundFollowingEntry = true;
      if (game && diff > 0) {
        // Optimistically add the game to every cached following page
        const alreadyIn = v.items.some(
          (g) => followedGameKey(g.source, g.source_game_id) === gameId
        );
        if (!alreadyIn) {
          const newItems = [...v.items, game].sort(_byReleaseDateAsc);
          const newMeta = { ...v.meta, total_count: (v.meta?.total_count || 0) + 1 };
          const newFacets = v.facets
            ? { ...v.facets, following_count: Math.max(0, (v.facets.following_count ?? 0) + 1) }
            : v.facets;
          _feedCache.set(k, { ...v, items: newItems, meta: newMeta, facets: newFacets });
        }
      } else if (game && diff < 0) {
        // Optimistically remove the game from every cached following page
        const newItems = v.items.filter(
          (g) => followedGameKey(g.source, g.source_game_id) !== gameId
        );
        const newMeta = { ...v.meta, total_count: Math.max(0, (v.meta?.total_count || 0) - 1) };
        const newFacets = v.facets
          ? { ...v.facets, following_count: Math.max(0, (v.facets.following_count ?? 0) - 1) }
          : v.facets;
        _feedCache.set(k, { ...v, items: newItems, meta: newMeta, facets: newFacets });
      } else {
        // No game info available — delete to force a fresh API fetch
        _feedCache.delete(k);
      }
    } else if (v.facets) {
      _feedCache.set(k, {
        ...v,
        facets: {
          ...v.facets,
          following_count: Math.max(0, (v.facets.following_count ?? 0) + diff),
        },
      });
    }
  }

  // When following a game but no |following| cache entry existed yet (user
  // never visited the Following tab), create a synthetic entry so the game
  // appears immediately when the tab is opened.
  if (!foundFollowingEntry && diff > 0 && game) {
    const savedPeriod = sessionStorage.getItem("upcoming_period") || "all";
    const savedSort = sessionStorage.getItem("upcoming_sort") || "popularity";
    const timeframe = TIMEFRAME_MAP[savedPeriod] || "rest_of_year";
    const key = _cacheKey(userId, "following", timeframe, 1, undefined, undefined, savedSort);

    // Borrow facets from any existing entry for this user
    let facets = null;
    for (const [k, v] of _feedCache) {
      if (k.startsWith(prefix) && v.facets) {
        facets = { ...v.facets };
        break;
      }
    }

    _setCache(key, {
      items: [game],
      meta: { total_count: 1, has_more: true },
      facets,
    });
  }
}

const TIMEFRAME_MAP = {
  week: "week",
  month: "month",
  quarter: "quarter",
  all: "rest_of_year",
};

const ALL_FEEDS = ["for_you", "following", "soon", "recent", "big_releases", "popular"];

// In-flight preload promises keyed by cache key. Lets the useUpcomingGames
// effect await an already-running preload instead of firing a duplicate call.
const _preloadInflight = new Map();

/**
 * Pre-warm the cache by fetching each feed individually.
 * activeFeed is awaited so callers know when the priority data is ready.
 * Remaining feeds start in parallel immediately.
 * Duplicate calls for the same key are deduplicated automatically.
 */
export async function preloadUpcomingFeeds(userId, activeFeed = "for_you") {
  if (!userId) return;
  _preloadedUserId = userId;
  const followedSetPromise = loadFollowedSet(userId).catch(() => new Set());

  const savedPeriod = sessionStorage.getItem("upcoming_period") || "all";
  const savedSort = sessionStorage.getItem("upcoming_sort") || "popularity";
  const timeframe = TIMEFRAME_MAP[savedPeriod] || "rest_of_year";
  const sort = savedSort;

  function _preloadFeed(feedName) {
    const key = _cacheKey(userId, feedName, timeframe, 1, undefined, undefined, sort);
    if (_getCached(key)) return Promise.resolve();
    if (_preloadInflight.has(key)) return _preloadInflight.get(key);

    const promise = (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("get-upcoming-feeds", {
          body: { feed: feedName, timeframe, page: 1, page_size: 48, sort },
        });
        if (error || !data || data.error) return;
        if (!data.items) return;
        _setCache(key, {
          items: data.items,
          meta: data.meta ?? {},
          facets: data.facets ?? null,
        });
        if (feedName === "following") {
          mergeCachedFollowedGames(userId, data.items);
        }
      } catch (e) {
        if (import.meta.env.DEV)
          console.warn("[useUpcomingFeeds] preload failed for", feedName, ":", e);
      } finally {
        _preloadInflight.delete(key);
      }
    })();

    _preloadInflight.set(key, promise);
    return promise;
  }

  // Start all remaining feeds in parallel immediately — no delay so dashboard
  // tab switches are cache-hits from the first user interaction onward.
  const remainingFeeds = ALL_FEEDS.filter(f => f !== activeFeed);
  if (remainingFeeds.length > 0) {
    Promise.all(remainingFeeds.map(_preloadFeed)).catch(() => {});
  }

  // Await the active feed and followed-set cache so first paint already knows
  // which cards should render with followed styling.
  await Promise.all([_preloadFeed(activeFeed), followedSetPromise]);
}

function applyFollowOverrides(baseSet, overrides) {
  const next = new Set(baseSet);
  const now = Date.now();

  for (const [key, entry] of overrides) {
    if (now - entry.ts > 15_000) {
      overrides.delete(key);
      continue;
    }

    const alreadyMatches = entry.followed ? next.has(key) : !next.has(key);
    if (alreadyMatches) {
      overrides.delete(key);
      continue;
    }

    if (entry.followed) next.add(key);
    else next.delete(key);
  }

  return next;
}

export function useUpcomingGames(options = {}) {
  const savedPeriod = sessionStorage.getItem("upcoming_period") || "all";
  const savedSort = sessionStorage.getItem("upcoming_sort") || "popularity";

  const {
    feed = "all_upcoming",
    timeframe = TIMEFRAME_MAP[savedPeriod] || "rest_of_year",
    page = 1,
    limit = 24,
    date_from,
    date_to,
    sort = savedSort,
  } = options;

  const { user } = useAuth();

  // ── Synchronous cache hydration ───────────────────────────────────────────
  // Use _preloadedUserId as fallback so the Dashboard can hydrate from the
  // preloaded cache even before useAuth() resolves the user object.
  const effectiveUserId = user?.id || _preloadedUserId;
  const initKey = _cacheKey(effectiveUserId, feed, timeframe, page, date_from, date_to, sort);
  const initCache = effectiveUserId ? _getCached(initKey) : null;
  const initFollowedSet = getCachedFollowedSet(effectiveUserId);

  const [games, setGames] = useState(() => (initCache ? initCache.items.slice(0, limit) : []));
  const [meta, setMeta] = useState(() => (initCache ? initCache.meta : null));
  const [facets, setFacets] = useState(() => (initCache ? initCache.facets : null));
  const [loading, setLoading] = useState(() => !initCache);
  const [error, setError] = useState(null);

  const [followedSet, setFollowedSet] = useState(() => {
    if (initFollowedSet) return initFollowedSet;
    if (feed === "following" && initCache?.items) {
      const seeded = new Set(initCache.items.map((g) => followedGameKey(g.source, g.source_game_id)));
      setCachedFollowedSet(effectiveUserId, seeded);
      return seeded;
    }
    return new Set();
  });

  // Subscribe to cross-hook follow change notifications
  const [followVersion, setFollowVersion] = useState(() => followBus.getVersion());
  useEffect(() => followBus.subscribe(setFollowVersion), []);

  const followedSetFetchId = useRef(0);
  const pendingToggles = useRef(new Set());
  const optimisticFollowOverrides = useRef(new Map());

  // Track current request to ignore stale responses
  const fetchCounter = useRef(0);
  const lastFeedRef = useRef(feed);
  // Track the userId that was used for last successful hydration
  const hydratedForRef = useRef(null);

  // ── Fetch paginated feed from Edge Function ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const currentFetch = ++fetchCounter.current;

    async function fetchFeed() {
      // Wait until we have a user ID — otherwise we'd fetch as anon and miss personalization
      if (!user?.id) return;
      // Follow/unfollow handlers update the feed cache optimistically before
      // emitting followBus, so tab switches can keep using cached Following
      // data instead of re-fetching on every visit.
      const shouldBypassCache = false;

      const key = _cacheKey(
        user.id,
        feed,
        timeframe,
        page,
        date_from,
        date_to,
        sort,
      );

      // If this is the first fetch after the user resolved and data is already preloaded, hydrate immediately
      const cached = _getCached(key);
      if (cached && !shouldBypassCache) {
        if (!(cached.items.length < limit && cached.meta?.has_more)) {
          if (cancelled || currentFetch !== fetchCounter.current) return;
          const slice = cached.items.slice(0, limit);
          setGames((prev) => (page === 1 ? slice : [...prev, ...slice]));
          setMeta(cached.meta);
          if (page === 1) setFacets(cached.facets);
          if (feed === "following") {
            mergeCachedFollowedGames(user.id, slice);
            setFollowedSet((prev) => new Set([...prev, ...slice.map((g) => followedGameKey(g.source, g.source_game_id))]));
          }
          setLoading(false);
          lastFeedRef.current = feed;
          hydratedForRef.current = user.id;
          return;
        }
      }

      // If a preload is in-flight for this key, wait for it instead of
      // firing a duplicate API call.  This bridges the gap between app-init
      // preload and the moment the hook mounts.
      const inflight = _preloadInflight.get(key);
      if (inflight && !shouldBypassCache) {
        await inflight;
        if (cancelled || currentFetch !== fetchCounter.current) return;
        const preloaded = _getCached(key);
        if (preloaded && !(preloaded.items.length < limit && preloaded.meta?.has_more)) {
          const slice = preloaded.items.slice(0, limit);
          setGames((prev) => (page === 1 ? slice : [...prev, ...slice]));
          setMeta(preloaded.meta);
          if (page === 1) setFacets(preloaded.facets);
          if (feed === "following") {
            mergeCachedFollowedGames(user.id, slice);
            setFollowedSet((prev) => new Set([...prev, ...slice.map((g) => followedGameKey(g.source, g.source_game_id))]));
          }
          setLoading(false);
          lastFeedRef.current = feed;
          hydratedForRef.current = user.id;
          return;
        }
      }

      // New tab — show cached data instantly if available
      if (lastFeedRef.current !== feed && page === 1) {
        const freshCache = _getCached(key);
        if (freshCache && !shouldBypassCache) {
          setGames(freshCache.items.slice(0, limit));
          setMeta(freshCache.meta);
          if (feed === "following") {
            mergeCachedFollowedGames(user.id, freshCache.items);
            setFollowedSet((prev) => new Set([...prev, ...freshCache.items.map((g) => followedGameKey(g.source, g.source_game_id))]));
          }
          // Only short-circuit if cache is sufficient (not a partial/synthetic entry)
          if (!(freshCache.items.length < limit && freshCache.meta?.has_more)) {
            setLoading(false);
            lastFeedRef.current = feed;
            return;
          }
          // Partial cache (e.g. synthetic following entry) — show it
          // optimistically but continue to API call for the full list
        } else {
          setGames([]);
        }
      }
      lastFeedRef.current = feed;

      setLoading(true);
      setError(null);
      try {
        const { data, error: funcErr } = await supabase.functions.invoke(
          "get-upcoming-feeds",
          {
            body: {
              feed,
              timeframe,
              page,
              page_size: Math.max(limit, 48),
              date_from,
              date_to,
              sort,
            },
          },
        );

        if (funcErr) throw funcErr;
        if (!data || data.error)
          throw new Error(data?.error || "Empty response");

        if (cancelled || currentFetch !== fetchCounter.current) return;

        _setCache(key, {
          items: data.items,
          meta: data.meta,
          facets: data.facets,
        });

        const slice = data.items.slice(0, limit);
        if (feed === "following") {
          mergeCachedFollowedGames(user.id, data.items);
          setFollowedSet((prev) => new Set([...prev, ...data.items.map((g) => followedGameKey(g.source, g.source_game_id))]));
        }
        setGames((prev) => (page === 1 ? slice : [...prev, ...slice]));
        setMeta(data.meta);
        if (page === 1) setFacets(data.facets);
        hydratedForRef.current = user.id;
      } catch (err) {
        if (cancelled || currentFetch !== fetchCounter.current) return;
        if (import.meta.env.DEV)
          console.warn("[useUpcomingGames] fetch error:", err);
        setError(err?.message ?? String(err));
      } finally {
        if (!cancelled && currentFetch === fetchCounter.current)
          setLoading(false);
      }
    }

    fetchFeed();
    return () => {
      cancelled = true;
    };
  }, [feed, timeframe, page, limit, date_from, date_to, sort, user?.id, followVersion]);

  // ── Fetch followed games (user-specific) ─────────────────────────────────
  useEffect(() => {
    if (!user) {
      setFollowedSet(new Set());
      return;
    }
    const cached = getCachedFollowedSet(user.id);
    if (cached) setFollowedSet(applyFollowOverrides(cached, optimisticFollowOverrides.current));

    let cancelled = false;
    const fetchId = ++followedSetFetchId.current;

    loadFollowedSet(user.id)
      .then((dbSet) => {
        if (cancelled) return;
        if (fetchId !== followedSetFetchId.current) return;
        setFollowedSet(applyFollowOverrides(dbSet, optimisticFollowOverrides.current));
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.warn("[useUpcomingGames] followed-set fetch failed:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [user, followVersion]);

  const isFollowed = useCallback(
    (game) => feed === "following" || followedSet.has(followedGameKey(game.source, game.source_game_id)),
    [feed, followedSet],
  );

  const toggleFollow = useCallback(
    async (game) => {
      if (!user) return;
      const source = String(game.source ?? '').trim().toLowerCase();
      const sourceGameId = String(game.source_game_id ?? '').trim();
      if (!source || !sourceGameId) return;
      const key = followedGameKey(source, sourceGameId);

      // Prevent double-clicks from racing: follow→unfollow in quick succession.
      if (pendingToggles.current.has(key)) return;
      pendingToggles.current.add(key);

      const currently = followedSet.has(key);
      const diff = currently ? -1 : 1;

      // Invalidate any in-flight followedSet DB queries so their results don't
      // overwrite the optimistic update below.
      followedSetFetchId.current++;
      optimisticFollowOverrides.current.set(key, {
        followed: !currently,
        ts: Date.now(),
      });

      // 1. Optimistic update for the followed set
      setFollowedSet((prev) => {
        const next = new Set(prev);
        currently ? next.delete(key) : next.add(key);
        setCachedFollowedSet(user.id, next);
        return next;
      });

      // 2. Optimistic update for the current view's badge count
      setFacets((prev) => {
        if (!prev) return prev;
        return { ...prev, following_count: Math.max(0, prev.following_count + diff) };
      });

      // 3. Optimistic update if user is currently inside the "Following" tab
      if (feed === "following" && currently) {
        setGames((prev) => prev.filter((g) => followedGameKey(g.source, g.source_game_id) !== key));
      }

      // 4. Update the module-level cache
      updateFeedCachesOnFollow(user.id, diff, game);

      try {
        if (currently) {
          const { error: delErr } = await supabase
            .from("user_followed_games")
            .delete()
            .eq("user_id", user.id)
            .eq("source", source)
            .eq("source_game_id", sourceGameId);
          if (delErr) throw delErr;
        } else {
          // Store the game object as metadata so the Following tab can
          // reconstruct the card even if upcoming_games_cache misses this game.
          const { error: insErr } = await supabase
            .from("user_followed_games")
            .upsert(
              {
                user_id: user.id,
                source,
                source_game_id: sourceGameId,
                metadata: { ...game, source, source_game_id: sourceGameId },
              },
              {
                onConflict: "user_id,source,source_game_id",
                ignoreDuplicates: false,
              },
            );
          if (insErr) throw insErr;
        }
        setFollowedSet((prev) => {
          const next = new Set(prev);
          currently ? next.delete(key) : next.add(key);
          setCachedFollowedSet(user.id, next);
          return next;
        });
        applyCachedFollowChange(user.id, source, sourceGameId, !currently);
        followBus.emit();
      } catch (err) {
        optimisticFollowOverrides.current.delete(key);
        // Rollback on failure
        setFollowedSet((prev) => {
          const next = new Set(prev);
          currently ? next.add(key) : next.delete(key);
          setCachedFollowedSet(user.id, next);
          return next;
        });
        if (import.meta.env.DEV)
          console.warn("[toggleFollow] failed:", err?.message ?? err);
      } finally {
        pendingToggles.current.delete(key);
      }
    },
    [user, followedSet, feed],
  );

  const isInitializing = loading && page === 1 && games.length === 0;
  const isRefetching = loading && games.length > 0;

  return {
    games,
    meta,
    facets,
    loading,
    isInitializing,
    isRefetching,
    error,
    isFollowed,
    toggleFollow,
  };
}
