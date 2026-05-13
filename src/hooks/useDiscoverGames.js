import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./useAuth";
import { updateFeedCachesOnFollow } from "./useUpcomingGames";
import { followBus } from "../lib/followBus";
import {
  applyCachedFollowChange,
  gameKey,
  getCachedFollowedSet,
  loadFollowedSet,
  setCachedFollowedSet,
} from "../lib/followedGamesStore";

const _feedCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function _cacheKey(userId, feed, page) {
  return [
    userId || "anon",
    feed,
    page,
  ].join("|");
}

function _getCached(key) {
  const entry = _feedCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    _feedCache.delete(key);
    return null;
  }
  return entry.data;
}

function _setCache(key, data) {
  _feedCache.set(key, { timestamp: Date.now(), data });
}

// Valid feeds for the discover endpoint — 'following' is handled by useUpcomingGames
const DISCOVER_FEEDS = ['for_you', 'top_100', 'trending', 'hidden_gems'];

function mergeUniqueGames(prev, nextItems) {
  const seen = new Set(prev.map((g) => `${g.source}:${g.source_game_id}`));
  const merged = [...prev];
  for (const item of nextItems) {
    const key = `${item.source}:${item.source_game_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
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

export function bustDiscoverCache(userId) {
  const prefix = (userId || "anon") + "|";
  for (const [k] of _feedCache) {
    if (k.startsWith(prefix)) _feedCache.delete(k);
  }
}

export async function preloadDiscoverFeeds(userId, activeTab = 'for_you') {
  const FEEDS = ['for_you', 'top_100', 'trending', 'hidden_gems'];
  const followedSetPromise = userId ? loadFollowedSet(userId).catch(() => new Set()) : Promise.resolve(new Set());

  async function _preloadFeed(feedName) {
    const key = _cacheKey(userId, feedName, 1);
    if (_getCached(key)) return;

    try {
      const { data, error } = await supabase.functions.invoke('get-discover-feeds', {
        body: { feed: feedName, page: 1, page_size: 48 },
      });

      if (error || !data || data.error) return;
      if (!data.items || data.items.length === 0) return;

      _setCache(key, {
        items: data.items ?? [],
        meta: data.meta ?? {},
      });
    } catch (e) {
      console.warn(`[useDiscoverGames] _preloadFeed failed for ${feedName}:`, e)
    }
  }

  try {
    // 1. Fetch active tab immediately
    await Promise.all([_preloadFeed(activeTab), followedSetPromise])

    // 2. Fetch the remaining feeds in parallel immediately — no delay
    const remainingFeeds = FEEDS.filter(f => f !== activeTab)
    if (remainingFeeds.length > 0) {
      Promise.all(remainingFeeds.map(_preloadFeed)).catch(() => {})
    }

  } catch (err) {
    if (import.meta.env.DEV) console.warn('[useDiscoverGames] pre-load failed:', err);
  }
}

export function useDiscoverGames(options = {}) {
  const {
    feed = "top_100",
    page = 1,
    limit = 24,
  } = options;

  const { user } = useAuth();

  const initKey = _cacheKey(user?.id, feed, page);
  const initCache = _getCached(initKey);

  const [games, setGames] = useState(() => initCache ? initCache.items.slice(0, limit) : []);
  const [meta, setMeta] = useState(() => initCache ? initCache.meta : null);

  const [loading, setLoading] = useState(() => !initCache);
  const [error, setError] = useState(null);

  // On first mount, bust any cached empty for_you result (from before edge function fix)
  useEffect(() => {
    if (feed === 'for_you' && user?.id) {
      const key = _cacheKey(user.id, 'for_you', 1)
      const cached = _getCached(key)
      if (cached && cached.items.length === 0) {
        _feedCache.delete(key)
      }
    }
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [followedSet, setFollowedSet] = useState(() => getCachedFollowedSet(user?.id) ?? new Set());

  // Subscribe to cross-hook follow change notifications
  const [followVersion, setFollowVersion] = useState(() => followBus.getVersion());
  useEffect(() => followBus.subscribe(setFollowVersion), []);

  // Prevents stale followedSet DB queries from overwriting optimistic updates.
  // Incremented in toggleFollow before the optimistic setFollowedSet; the effect
  // callback checks the captured value and skips if it no longer matches.
  const followedSetFetchId = useRef(0);
  // Tracks in-progress toggles to prevent double-clicks from follow→unfollow racing.
  const pendingToggles = useRef(new Set());
  const optimisticFollowOverrides = useRef(new Map());

  const fetchCounter = useRef(0);
  const lastFeedRef = useRef(feed);

  useEffect(() => {
    let cancelled = false;
    const currentFetch = ++fetchCounter.current;

    async function fetchFeed() {
      // 'following' is not a valid discover feed — useUpcomingGames handles it
      if (!DISCOVER_FEEDS.includes(feed)) {
        setLoading(false);
        setError(null);
        return;
      }

      const key = _cacheKey(user?.id, feed, page);
      const cached = _getCached(key);

      if (cached) {
        if (!(cached.items.length < limit && cached.meta.has_more)) {
          if (cancelled || currentFetch !== fetchCounter.current) return;
          const slice = cached.items.slice(0, limit);
          setGames((prev) => (page === 1 ? slice : mergeUniqueGames(prev, slice)));
          setMeta(cached.meta);
          setLoading(false);
          lastFeedRef.current = feed;
          return;
        }
      }

      if (lastFeedRef.current !== feed && page === 1) {
        const cached = _getCached(key);
        if (cached) {
          setGames(cached.items.slice(0, limit));
          setMeta(cached.meta);
          setLoading(false);
          lastFeedRef.current = feed;
          return;
        } else {
          setGames([]);
        }
      }
      lastFeedRef.current = feed;

      setLoading(true);
      setError(null);
      try {
        const { data, error: funcErr } = await supabase.functions.invoke(
          "get-discover-feeds",
          {
            body: {
              feed,
              page,
              page_size: Math.max(limit, 48),
            },
          },
        );

        if (funcErr) throw funcErr;
        if (!data || data.error) throw new Error(data?.error || "Empty response");

        if (cancelled || currentFetch !== fetchCounter.current) return;

        // Don't cache empty results — force a fresh fetch next time
        if (data.items && data.items.length > 0) {
          _setCache(key, { items: data.items, meta: data.meta });
        }

        const slice = data.items.slice(0, limit);
        setGames((prev) => (page === 1 ? slice : mergeUniqueGames(prev, slice)));
        setMeta(data.meta);
      } catch (err) {
        if (cancelled || currentFetch !== fetchCounter.current) return;
        if (import.meta.env.DEV) console.warn("[useDiscoverGames] fetch error:", err);
        setError(err?.message ?? String(err));
      } finally {
        if (!cancelled && currentFetch === fetchCounter.current) setLoading(false);
      }
    }

    fetchFeed();
    return () => { cancelled = true; };
  }, [feed, page, limit, user?.id, followVersion]);

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
        if (import.meta.env.DEV) console.warn("[useDiscoverGames] followed-set fetch failed:", err);
      });

    return () => { cancelled = true; };
  }, [user, followVersion]);

  const toggleFollow = async (gameObj) => {
    if (!user) return false;
    const source = String(gameObj.source ?? '').trim().toLowerCase();
    const source_game_id = String(gameObj.source_game_id ?? '').trim();
    if (!source || !source_game_id) return false;

    const gameKeyVal = gameKey(source, source_game_id);

    // Prevent double-clicks from racing: follow→unfollow in quick succession.
    if (pendingToggles.current.has(gameKeyVal)) return false;
    pendingToggles.current.add(gameKeyVal);

    const isAdding = !followedSet.has(gameKeyVal);

    // Invalidate any in-flight followedSet DB queries so their results don't
    // overwrite the optimistic update below.
    followedSetFetchId.current++;
    optimisticFollowOverrides.current.set(gameKeyVal, {
      followed: isAdding,
      ts: Date.now(),
    });

    // Build a normalized snapshot that matches upcoming_games_cache shape.
    // Stored in user_followed_games.metadata so the Following tab can reconstruct
    // the full game object even when the game isn't in upcoming_games_cache
    // (Discover feeds are fetched live from IGDB, not from the cache).
    const releaseDate = gameObj.release_date || null;
    const isReleased = releaseDate && new Date(releaseDate) <= new Date();
    const snapshot = {
      source,
      source_game_id: String(source_game_id),
      name: gameObj.name ?? "",
      cover_url: gameObj.cover_url ?? null,
      banner_url: gameObj.banner_url ?? gameObj.cover_url ?? null,
      release_date: releaseDate,
      release_date_precision: gameObj.release_date_precision ?? "day",
      developer_names: Array.isArray(gameObj.developer_names) ? gameObj.developer_names : [],
      publisher_names: Array.isArray(gameObj.publisher_names) ? gameObj.publisher_names : [],
      genres: Array.isArray(gameObj.genres) ? gameObj.genres : [],
      platforms: Array.isArray(gameObj.platforms) ? gameObj.platforms : [],
      summary: gameObj.summary ?? null,
      franchise_name: gameObj.series_name ?? gameObj.franchise_name ?? null,
      status: isReleased ? "released" : "upcoming",
      hype_score: gameObj.hype_score ?? 0,
      recommendation_base_score: gameObj.quality_score ?? gameObj.recommendation_base_score ?? 0,
      popularity_score: gameObj.popularity_score ?? 0,
      is_aaa: gameObj.is_aaa ?? false,
      is_indie: gameObj.is_indie ?? false,
    };

    // Optimistic UI update
    setFollowedSet((prev) => {
      const next = new Set(prev);
      if (isAdding) next.add(gameKeyVal);
      else next.delete(gameKeyVal);
      setCachedFollowedSet(user.id, next);
      return next;
    });

    try {
      if (isAdding) {
        // Insert follow row + store metadata so the game is always recoverable
        // in the Following tab even if upsert-upcoming-cache fails.
        const { error } = await supabase
          .from('user_followed_games')
          .upsert(
            { user_id: user.id, source, source_game_id: String(source_game_id), metadata: snapshot },
            { onConflict: 'user_id,source,source_game_id', ignoreDuplicates: false }
          );
        if (error) throw error;

        // Also upsert into upcoming_games_cache for faster Following tab loads.
        // Best-effort: failure is non-fatal since metadata is the authoritative fallback.
        await supabase.functions.invoke('upsert-upcoming-cache', {
          body: { gameData: snapshot }
        }).catch(() => {});
      } else {
        const { error } = await supabase
          .from("user_followed_games")
          .delete()
          .eq("user_id", user.id)
          .eq("source", source)
          .eq("source_game_id", String(source_game_id));
        if (error) throw error;
      }

      updateFeedCachesOnFollow(user.id, isAdding ? 1 : -1, isAdding ? snapshot : gameObj);
      setFollowedSet((prev) => {
        const next = new Set(prev);
        if (isAdding) next.add(gameKeyVal);
        else next.delete(gameKeyVal);
        setCachedFollowedSet(user.id, next);
        return next;
      });
      applyCachedFollowChange(user.id, source, source_game_id, isAdding);
      followBus.emit();
      return isAdding;
    } catch (err) {
      console.error("Failed to toggle follow:", err);
      optimisticFollowOverrides.current.delete(gameKeyVal);
      // Revert optimism
      setFollowedSet((prev) => {
        const next = new Set(prev);
        if (!isAdding) next.add(gameKeyVal);
        else next.delete(gameKeyVal);
        setCachedFollowedSet(user.id, next);
        return next;
      });
      return false;
    } finally {
      pendingToggles.current.delete(gameKeyVal);
    }
  };

  const isInitializing = page === 1 && loading && games.length === 0;
  const isRefetching = page === 1 && loading && games.length > 0;

  return {
    games,
    meta,
    loading,
    error,
    isInitializing,
    isRefetching,
    isFollowed: (g) => followedSet.has(gameKey(g.source, g.source_game_id)),
    toggleFollow,
  };
}
