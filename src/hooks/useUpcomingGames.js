import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./useAuth";
import { followBus } from "../lib/followBus";
import { getAppMeta, setAppMeta } from "../lib/db";
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
// Past the TTL an entry stops counting as fresh but stays worth showing while
// a refresh runs. Only past this much wider bound is it dropped for good.
const STALE_RENDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Set by preloadUpcomingFeeds so the hook's synchronous useState initializer
// can look up cached data before useAuth() resolves the user.
let _preloadedUserId = null;

// ── Persistence ───────────────────────────────────────────────────────────────
// The in-memory cache above is lost on every app restart, so without a durable
// copy the dashboard's Upcoming row re-hits the edge function on each launch —
// a visible skeleton delay every single time. The cache lives in SQLite (see
// below); localStorage keeps only the last user id, which is small enough to
// store reliably and is needed synchronously to key a lookup on first render.
const _LAST_USER_KEY = "ld_upcoming_last_user_id";

// Older builds tried to keep the whole cache here. Drop anything they left.
try {
  localStorage.removeItem("ld_upcoming_feed_cache_v1");
} catch {
  /* ignore */
}

try {
  _preloadedUserId = localStorage.getItem(_LAST_USER_KEY) || null;
} catch {
  /* ignore */
}

// The feed cache itself is NOT kept here. Inspecting the WebView2 store found
// `ld_upcoming_last_user_id` written and `ld_upcoming_feed_cache_v1` absent,
// every launch, while the SQLite mirror of the same JSON held 367 KB — the
// blob simply does not survive a localStorage write at that size. Retrying it
// each time bought nothing and cost a synchronous main-thread serialize of the
// whole cache on the way. SQLite is the store; this key is only the pointer.

// ── Durable persistence (SQLite app_meta) ────────────────────────────────────
// SQLite is the only store that actually holds this cache, so it is the only
// one written. It is read asynchronously, which is why the hydration below
// publishes a version bump the hook subscribes to.
const _SQLITE_KEY = "upcoming_feed_cache_v1";
const _LAST_USER_SQLITE_KEY = "upcoming_last_user_id";

function _warnPersist(what, err) {
  // Every failure here used to be swallowed by an empty catch, which is
  // exactly why a cache that never persisted went unnoticed.
  console.warn(`[useUpcomingFeeds] ${what}:`, err?.message ?? err);
}

// Hydration is asynchronous, but the hook's useState initializers run on the
// very first render — long before it lands. Without a way to hear about it, a
// hook that mounted to an empty cache stayed empty and went to the network for
// data that was already on disk. That is what made every single launch a cold
// fetch, skeletons and all.
let _cacheVersion = 0;
const _cacheListeners = new Set();

function _bumpCacheVersion() {
  _cacheVersion += 1;
  for (const listener of _cacheListeners) {
    try {
      listener(_cacheVersion);
    } catch {
      /* a bad subscriber must not stop the others */
    }
  }
}

export function subscribeToFeedCache(listener) {
  _cacheListeners.add(listener);
  return () => _cacheListeners.delete(listener);
}

export function getFeedCacheVersion() {
  return _cacheVersion;
}

function _mergeIntoCache(obj) {
  const now = Date.now();
  for (const [k, v] of Object.entries(obj || {})) {
    // A copy already in memory is at least as fresh as a stored one.
    if (_feedCache.has(k)) continue;
    // Restored up to the stale-render bound, not the TTL: a past-TTL entry is
    // exactly the one worth painting while its refresh runs.
    if (v && typeof v.ts === "number" && now - v.ts <= STALE_RENDER_MAX_AGE_MS)
      _feedCache.set(k, v);
  }
}

let _sqliteHydration = null;
/** Merge the durable copy in. Idempotent; callers await before fetching. */
function _hydrateFromSqlite() {
  if (!_sqliteHydration) {
    _sqliteHydration = (async () => {
      try {
        const [raw, lastUser] = await Promise.all([
          getAppMeta(_SQLITE_KEY),
          getAppMeta(_LAST_USER_SQLITE_KEY),
        ]);
        if (raw) _mergeIntoCache(JSON.parse(raw));
        // Cache keys are user-scoped, so a restored cache is useless without
        // the id that keys it.
        if (!_preloadedUserId && lastUser) _preloadedUserId = lastUser;
      } catch (err) {
        _warnPersist("SQLite cache hydrate failed", err);
      } finally {
        // Wake any hook that already rendered against an empty cache.
        _bumpCacheVersion();
      }
    })();
  }
  return _sqliteHydration;
}

// Start reading the durable cache the instant this module is imported, rather
// than waiting for the first preloadUpcomingFeeds() call — which sits behind
// auth resolving and then behind its own followed-set round trip. This is a
// local SQLite read; it typically lands within the first few frames, so the
// dashboard row paints from disk instead of waiting on the network.
_hydrateFromSqlite();

let _persistTimer = null;
function _persistCache() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    // Only page 1 of each feed is worth keeping. Pages 2+ exist to restore an
    // accumulated "load more" list within a session; on a cold start the user
    // is back on page 1 regardless, and persisting every page is what grew
    // this blob to 367 KB — the whole of which was re-serialized on each write.
    const obj = {};
    for (const [k, v] of _feedCache) {
      if (k.split("|")[3] !== "1") continue;
      obj[k] = v;
    }

    let json;
    try {
      json = JSON.stringify(obj);
    } catch (err) {
      _warnPersist("cache serialization failed", err);
      return;
    }

    setAppMeta(_SQLITE_KEY, json).catch((err) =>
      _warnPersist("SQLite cache write failed", err),
    );
  }, 500);
}

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

// Cache key format: userId|feed|timeframe|page|date_from|date_to|sort
function _ttlFor(key) {
  return key.split("|")[1] === "recent" ? RECENT_CACHE_TTL_MS : CACHE_TTL_MS;
}

/** Fresh enough to serve WITHOUT going to the network. */
function _getCached(key) {
  const entry = _feedCache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age > _ttlFor(key)) {
    // Deliberately not deleted at the TTL any more — see _getRenderableCached.
    if (age > STALE_RENDER_MAX_AGE_MS) _feedCache.delete(key);
    return null;
  }
  return entry;
}

/**
 * The best entry to PUT ON SCREEN, which is a different question from whether
 * the cache is fresh enough to skip the network.
 *
 * With a 24h TTL and an app people open about once a day, the cached copy was
 * essentially always a little past expiry at launch — so the persisted cache
 * was thrown away and every start paid for a cold fetch behind a skeleton row,
 * which is the thing the cache existed to prevent. Upcoming releases do not
 * churn by the hour: showing yesterday's copy immediately and refreshing it
 * behind the user's back is strictly better than showing nothing.
 */
function _getRenderableCached(key) {
  const entry = _feedCache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age > STALE_RENDER_MAX_AGE_MS) {
    _feedCache.delete(key);
    return null;
  }
  return { entry, stale: age > _ttlFor(key) };
}

function _setCache(key, payload) {
  _feedCache.set(key, { ...payload, ts: Date.now() });
  _persistCache();
}

// Rebuild the full "load more" list (pages 1..page) from cache. Returns null if
// any page isn't cached. Lets the grid restore its accumulated list after the
// user navigates to a game detail and back (or reopens the app) instead of
// snapping back to page 1.
function _accumulateFromCache(userId, feed, timeframe, page, date_from, date_to, sort, limit) {
  const acc = [];
  for (let p = 1; p <= page; p++) {
    const cached = _getCached(
      _cacheKey(userId, feed, timeframe, p, date_from, date_to, sort)
    );
    if (!cached) return null;
    acc.push(...cached.items.slice(0, limit));
  }
  return acc;
}

/** Bust the Following feed cache only (used when the feed list needs refreshing). */
export function bustFollowingFeedCache() {
  let mutated = false;
  for (const [k] of _feedCache) {
    if (k.includes("|following|")) {
      _feedCache.delete(k);
      mutated = true;
    }
  }
  // Must reach the persisted copy too, or the busted entries come straight
  // back from disk on the next launch.
  if (mutated) _persistCache();
}

/**
 * Bust ALL cached feed entries for a given user.
 * Called after follow/unfollow because every feed's cached response contains
 * the shared `facets` object (with `following_count`). Leaving other feeds
 * cached would cause stale badge counts when switching tabs.
 */
export function bustAllUserFeedCache(userId) {
  const prefix = (userId || "anon") + "|";
  let mutated = false;
  for (const [k] of _feedCache) {
    if (k.startsWith(prefix)) {
      _feedCache.delete(k);
      mutated = true;
    }
  }
  if (mutated) _persistCache();
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
  // Every branch below mutates _feedCache directly rather than through
  // _setCache, so nothing here used to reach the persisted copy. That was
  // invisible while persistence was broken; now that the cache is durable, an
  // unfollow that isn't written through would be resurrected from disk on the
  // next launch and linger for the whole 24h TTL.
  let mutated = false;

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
          (mutated = true), _feedCache.set(k, { ...v, items: newItems, meta: newMeta, facets: newFacets });
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
        (mutated = true), _feedCache.set(k, { ...v, items: newItems, meta: newMeta, facets: newFacets });
      } else {
        // No game info available — delete to force a fresh API fetch
        (mutated = true), _feedCache.delete(k);
      }
    } else if (v.facets) {
      (mutated = true), _feedCache.set(k, {
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
  } else if (mutated) {
    // _setCache already persists; the direct mutations above do not.
    _persistCache();
  }
}

/**
 * Every distinct game currently listed by a cached "following" page,
 * deduplicated by source key. Lets the library/Following cleanup see entries
 * that are still on screen even though their row is already gone from
 * user_followed_games — which is the state a removal performed in an earlier
 * session (or on another PC) leaves this client in.
 */
export function getCachedFollowingItems(userId) {
  const prefix = (userId || "anon") + "|";
  const byKey = new Map();
  for (const [k, v] of _feedCache) {
    if (!k.startsWith(prefix) || !k.includes("|following|")) continue;
    for (const item of v.items ?? []) {
      const key = followedGameKey(item.source, item.source_game_id);
      if (key && !byKey.has(key)) byKey.set(key, item);
    }
  }
  return byKey;
}

/**
 * Drop cached "following" items that are no longer in the authoritative
 * followed set, and correct the counts that go with them.
 *
 * Self-heals the case this was written for: a game added to the library is
 * removed from user_followed_games server-side, but a cached Following page
 * still lists it — which is what left Crimson Desert showing under Following
 * (and the badge reading 8) after the row had already been deleted.
 */
export function reconcileFollowingCache(userId, followedSet) {
  if (!userId || !(followedSet instanceof Set)) return 0;
  const prefix = userId + "|";
  let removed = 0;
  let mutated = false;

  for (const [k, v] of _feedCache) {
    if (!k.startsWith(prefix) || !k.includes("|following|")) continue;
    if (!Array.isArray(v.items)) continue;

    const kept = v.items.filter((g) =>
      followedSet.has(followedGameKey(g.source, g.source_game_id)),
    );
    if (kept.length === v.items.length) continue;

    removed += v.items.length - kept.length;
    mutated = true;
    _feedCache.set(k, {
      ...v,
      items: kept,
      meta: { ...v.meta, total_count: followedSet.size },
      facets: v.facets ? { ...v.facets, following_count: followedSet.size } : v.facets,
    });
  }

  // The following_count facet is mirrored onto every other feed's cached
  // response, so those go stale too.
  if (mutated) {
    for (const [k, v] of _feedCache) {
      if (!k.startsWith(prefix) || k.includes("|following|") || !v.facets) continue;
      if (v.facets.following_count === followedSet.size) continue;
      _feedCache.set(k, {
        ...v,
        facets: { ...v.facets, following_count: followedSet.size },
      });
    }
    _persistCache();
  }
  return removed;
}

const TIMEFRAME_MAP = {
  week: "week",
  month: "month",
  quarter: "quarter",
  all: "rest_of_year",
};

const ALL_FEEDS = ["for_you", "following", "soon", "recent", "big_releases", "popular"];

// The supabase client caps a request at 60s. That is a sane ceiling for a
// background sync and a terrible one for a row of cards the user is looking
// at: `loading` stays true the whole time and the section shows skeletons,
// which is indistinguishable from the feed being broken. Give the feed its
// own, much shorter deadline so a stall becomes a visible error state that
// the next render can retry, never an indefinite skeleton.
const FEED_REQUEST_TIMEOUT_MS = 20_000;

function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// In-flight preload promises keyed by cache key. Lets the useUpcomingGames
// effect await an already-running preload instead of firing a duplicate call.
const _preloadInflight = new Map();

/**
 * Pre-warm the cache by fetching each feed individually.
 * activeFeed is awaited so callers know when the priority data is ready.
 * Remaining feeds start in parallel immediately.
 * Duplicate calls for the same key are deduplicated automatically.
 */
// One run per user at a time. Both the app shell and the Discover route ask
// for a preload on mount, and an auth event can re-trigger either — each call
// re-ran the followed-set query and the SQLite hydration before it got as far
// as the request-level dedupe below.
const _preloadRuns = new Map();

export function preloadUpcomingFeeds(userId, activeFeed = "for_you") {
  if (!userId) return Promise.resolve();
  const existing = _preloadRuns.get(userId);
  if (existing) return existing;
  const run = _preloadUpcomingFeeds(userId, activeFeed).finally(() =>
    _preloadRuns.delete(userId),
  );
  _preloadRuns.set(userId, run);
  return run;
}

async function _preloadUpcomingFeeds(userId, activeFeed) {
  _preloadedUserId = userId;
  try {
    localStorage.setItem(_LAST_USER_KEY, userId);
  } catch (err) {
    _warnPersist("last-user-id write failed", err);
  }
  // Durable mirror, for the same reason as the feed cache above: the sync
  // localStorage read at module load is what lets the very first render look
  // up cached data before useAuth() resolves, but it can't be relied on alone.
  setAppMeta(_LAST_USER_SQLITE_KEY, userId).catch((err) =>
    _warnPersist("last-user-id SQLite write failed", err),
  );
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

  // One request for every feed, instead of one request PER feed.
  //
  // The edge function has always supported `feed: 'preload'`, which builds all
  // the standard feeds from a single pass over the candidate pool — but this
  // client never called it. It fired six separate invocations, and each one
  // independently re-fetched and re-scored the same ~2,700 rows. Six times the
  // server work for the same result, with the six calls contending against
  // each other, which is what made the dashboard's Upcoming row slow to
  // populate on launch.
  //
  // Falls back to the per-feed path if the bulk call fails for any reason, so
  // this can only ever be faster, never a new failure mode.
  // Bring the durable copy in before deciding to hit the network — otherwise a
  // launch where localStorage came back empty would refetch everything even
  // though SQLite still had it.
  await _hydrateFromSqlite();

  // Awaiting the followed set here also means first paint already knows which
  // cards should render with followed styling. Reconcile before trusting the
  // cache: a game added to the library gets unfollowed server-side, and a
  // cached Following page would otherwise keep listing it until the TTL ran out.
  reconcileFollowingCache(userId, await followedSetPromise);

  const allCached = ALL_FEEDS.every((f) =>
    _getCached(_cacheKey(userId, f, timeframe, 1, undefined, undefined, sort)),
  );
  if (allCached) return;

  const bulkOk = await _preloadAllFeeds(userId, timeframe, sort);
  if (!bulkOk) {
    const remainingFeeds = ALL_FEEDS.filter(f => f !== activeFeed);
    if (remainingFeeds.length > 0) {
      Promise.all(remainingFeeds.map(_preloadFeed)).catch(() => {});
    }
    await _preloadFeed(activeFeed);
  }
}

/**
 * Fetch every standard feed in one `feed: 'preload'` call and seed the cache
 * with each one. Returns false (without throwing) if anything goes wrong, so
 * the caller can fall back to per-feed fetches.
 */
async function _preloadAllFeeds(userId, timeframe, sort) {
  const bulkKey = _cacheKey(userId, "__preload__", timeframe, 1, undefined, undefined, sort);
  if (_preloadInflight.has(bulkKey)) {
    try {
      return await _preloadInflight.get(bulkKey);
    } catch {
      return false;
    }
  }

  // The bulk call fills every feed, but it used to register itself under this
  // one synthetic key — so the hook, which looks itself up by its OWN feed's
  // key, never saw a preload in flight and fired a second, redundant request
  // for a feed the bulk response was already about to deliver. On a cold start
  // that meant the dashboard's Upcoming row raced the very call that was
  // fetching its data, both of them queued behind the cloud sync's requests.
  // Publishing the same promise under each feed's key lets the hook await it.
  const feedKeys = ALL_FEEDS.map((f) =>
    _cacheKey(userId, f, timeframe, 1, undefined, undefined, sort),
  );

  const promise = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke("get-upcoming-feeds", {
        body: { feed: "preload", timeframe, page: 1, page_size: 48, sort },
      });
      if (error || !data || data.error) return false;

      let seeded = 0;
      for (const feedName of ALL_FEEDS) {
        const entry = data[feedName];
        if (!entry || !Array.isArray(entry.items)) continue;
        _setCache(_cacheKey(userId, feedName, timeframe, 1, undefined, undefined, sort), {
          items: entry.items,
          meta: entry.meta ?? {},
          facets: entry.facets ?? null,
        });
        seeded++;
        if (feedName === "following") {
          mergeCachedFollowedGames(userId, entry.items);
        }
      }
      return seeded > 0;
    } catch (e) {
      if (import.meta.env.DEV)
        console.warn("[useUpcomingFeeds] bulk preload failed, falling back:", e);
      return false;
    } finally {
      _preloadInflight.delete(bulkKey);
      for (const k of feedKeys) {
        if (_preloadInflight.get(k) === promise) _preloadInflight.delete(k);
      }
    }
  })();

  _preloadInflight.set(bulkKey, promise);
  // Only claim a feed no per-feed preload is already fetching.
  for (const k of feedKeys) {
    if (!_preloadInflight.has(k)) _preloadInflight.set(k, promise);
  }
  return promise;
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
  // Renderable, not merely fresh: a past-TTL copy still beats a skeleton, and
  // the effect below refreshes it. `loading` starts true for a stale hit so the
  // revalidation is reflected — but with items on screen that reads as
  // isRefetching, never isInitializing, so no skeleton row appears.
  const initRenderable = effectiveUserId ? _getRenderableCached(initKey) : null;
  const initCache = initRenderable?.entry ?? null;
  const initFollowedSet = getCachedFollowedSet(effectiveUserId);

  const [games, setGames] = useState(() => {
    // Restore the full accumulated list (pages 1..page) if it's cached, so
    // returning to this feed at page N doesn't snap back to page 1.
    const acc = effectiveUserId
      ? _accumulateFromCache(effectiveUserId, feed, timeframe, page, date_from, date_to, sort, limit)
      : null;
    return acc ?? (initCache ? initCache.items.slice(0, limit) : []);
  });
  const [meta, setMeta] = useState(() => (initCache ? initCache.meta : null));
  const [facets, setFacets] = useState(() => (initCache ? initCache.facets : null));
  const [loading, setLoading] = useState(() => !initCache || initRenderable.stale);
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

  // The durable cache is read from SQLite asynchronously, so on a cold start it
  // usually lands a few frames AFTER this hook's state initializers have
  // already run against an empty map. Re-run the effect when it does: the
  // cache branch below then paints the row from disk instead of the network.
  const [cacheVersion, setCacheVersion] = useState(() => getFeedCacheVersion());
  useEffect(() => subscribeToFeedCache(setCacheVersion), []);

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
      // Wait until we have a user ID — otherwise we'd fetch as anon and miss
      // personalization. This used to just return, leaving `loading` true from
      // the initial state: with no user there was nothing left to clear it, so
      // the section rendered its skeleton row permanently.
      if (!user?.id) {
        setLoading(false);
        return;
      }
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

      // Paint whatever the cache holds before doing anything on the network.
      // A fresh entry ends the work here; a stale one still goes on screen and
      // the request below becomes a silent background refresh.
      const renderable = _getRenderableCached(key);
      const cached = renderable?.entry ?? null;
      const cacheIsUsable =
        cached && !shouldBypassCache && !(cached.items.length < limit && cached.meta?.has_more);

      if (cacheIsUsable) {
        if (cancelled || currentFetch !== fetchCounter.current) return;
        const slice = cached.items.slice(0, limit);
        setGames((prev) => {
          const acc = _accumulateFromCache(user.id, feed, timeframe, page, date_from, date_to, sort, limit);
          return acc ?? (page === 1 ? slice : [...prev, ...slice]);
        });
        setMeta(cached.meta);
        if (page === 1) setFacets(cached.facets);
        if (feed === "following") {
          mergeCachedFollowedGames(user.id, slice);
          setFollowedSet((prev) => new Set([...prev, ...slice.map((g) => followedGameKey(g.source, g.source_game_id))]));
        }
        setError(null);
        lastFeedRef.current = feed;
        hydratedForRef.current = user.id;

        if (!renderable.stale) {
          setLoading(false);
          return;
        }
        // Stale: fall through and refresh. The rows already rendered above mean
        // this shows as isRefetching, so the user never sees the skeleton.
      }

      // If a preload is in-flight for this key, wait for it instead of
      // firing a duplicate API call.  This bridges the gap between app-init
      // preload and the moment the hook mounts.
      const inflight = _preloadInflight.get(key);
      if (inflight && !shouldBypassCache) {
        // A wedged preload must not pin this row on its skeleton either — fall
        // through to our own request if it hasn't landed in time.
        try {
          await withDeadline(inflight, FEED_REQUEST_TIMEOUT_MS, "feed preload");
        } catch (err) {
          if (import.meta.env.DEV)
            console.warn("[useUpcomingGames] preload wait:", err?.message ?? err);
        }
        if (cancelled || currentFetch !== fetchCounter.current) return;
        const preloaded = _getCached(key);
        if (preloaded && !(preloaded.items.length < limit && preloaded.meta?.has_more)) {
          const slice = preloaded.items.slice(0, limit);
          setGames((prev) => {
            const acc = _accumulateFromCache(user.id, feed, timeframe, page, date_from, date_to, sort, limit);
            return acc ?? (page === 1 ? slice : [...prev, ...slice]);
          });
          setMeta(preloaded.meta);
          if (page === 1) setFacets(preloaded.facets);
          if (feed === "following") {
            mergeCachedFollowedGames(user.id, slice);
            setFollowedSet((prev) => new Set([...prev, ...slice.map((g) => followedGameKey(g.source, g.source_game_id))]));
          }
          setError(null);
          setLoading(false);
          lastFeedRef.current = feed;
          hydratedForRef.current = user.id;
          return;
        }
      }

      // New tab — show cached data instantly if available
      if (!cacheIsUsable && lastFeedRef.current !== feed && page === 1) {
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
            setError(null);
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
        const { data, error: funcErr } = await withDeadline(
          supabase.functions.invoke("get-upcoming-feeds", {
            body: {
              feed,
              timeframe,
              page,
              page_size: Math.max(limit, 48),
              date_from,
              date_to,
              sort,
            },
          }),
          FEED_REQUEST_TIMEOUT_MS,
          "get-upcoming-feeds",
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
        // A previous attempt may have timed out and left the section on its
        // error state; the data is here now, so that message has to go.
        setError(null);
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
  }, [feed, timeframe, page, limit, date_from, date_to, sort, user?.id, followVersion, cacheVersion]);

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
