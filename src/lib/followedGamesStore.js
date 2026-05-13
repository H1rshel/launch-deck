import { supabase } from "./supabase";

const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = new Map();
const _inflight = new Map();

export function gameKey(source, sourceGameId) {
  return `${String(source ?? "").trim().toLowerCase()}:${String(sourceGameId ?? "").trim()}`;
}

export function getCachedFollowedSet(userId) {
  if (!userId) return null;
  const entry = _cache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(userId);
    return null;
  }
  return new Set(entry.set);
}

export function setCachedFollowedSet(userId, followedSet) {
  if (!userId) return;
  _cache.set(userId, { set: new Set(followedSet), ts: Date.now() });
}

export function mergeCachedFollowedGames(userId, games = []) {
  if (!userId || !Array.isArray(games) || games.length === 0) return;
  const next = getCachedFollowedSet(userId) ?? new Set();
  games.forEach((game) => {
    const key = gameKey(game?.source, game?.source_game_id);
    if (key !== ":") next.add(key);
  });
  setCachedFollowedSet(userId, next);
}

export function applyCachedFollowChange(userId, source, sourceGameId, isFollowed) {
  if (!userId) return;
  const next = getCachedFollowedSet(userId) ?? new Set();
  const key = gameKey(source, sourceGameId);
  if (isFollowed) next.add(key);
  else next.delete(key);
  setCachedFollowedSet(userId, next);
}

export async function loadFollowedSet(userId) {
  if (!userId) return new Set();

  const cached = getCachedFollowedSet(userId);
  if (cached) return cached;
  if (_inflight.has(userId)) return _inflight.get(userId);

  const promise = supabase
    .from("user_followed_games")
    .select("source, source_game_id")
    .eq("user_id", userId)
    .then(({ data, error }) => {
      if (error) throw error;
      const followedSet = new Set(
        (data ?? []).map((row) => gameKey(row.source, row.source_game_id)),
      );
      setCachedFollowedSet(userId, followedSet);
      return new Set(followedSet);
    })
    .finally(() => {
      _inflight.delete(userId);
    });

  _inflight.set(userId, promise);
  return promise;
}
