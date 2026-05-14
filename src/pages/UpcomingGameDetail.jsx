import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { useCallback, useMemo } from "react";
import {
  Bell,
  BellOff,
  CalendarDays,
  Sparkles,
  Tag,
  Layers,
  Building2,
  Code2,
  Star,
  Users,
  CheckCircle,
} from "lucide-react";
import TopBar from "../components/layout/TopBar";
import { useUpcomingGame } from "../hooks/useUpcomingGame";
import {
  normalizeUpcomingImages,
  normalizeUpcomingVideos,
  useUpcomingGameExtended,
} from "../hooks/useUpcomingGameExtended";
import { useCountdown } from "../hooks/useCountdown";
import { useLibraryProfile } from "../hooks/useLibraryProfile";
import { useAuth } from "../hooks/useAuth";
import { useGameContext } from "../context/GameContext";
import { matchReasons } from "../lib/upcomingScoring";
import GameDescription from "../components/games/GameDescription";
import GameMediaGallery from "../components/games/GameMediaGallery";
import GameStoreLinks from "../components/games/GameStoreLinks";
import { supabase } from "../lib/supabase";

// ── Helpers ───────────────────────────────────────────────────────────────────

function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [v];
    } catch {
      return [v];
    }
  }
  return [];
}

function firstPresent(...values) {
  return values.find((value) => value != null && value !== "") ?? null;
}

function mergeImages(...values) {
  return normalizeUpcomingImages(values.flatMap((value) => asArray(value)));
}

function mergeVideos(...values) {
  return normalizeUpcomingVideos(values.flatMap((value) => asArray(value)));
}

function formatListValue(values) {
  const list = asArray(values)
    .map((value) => {
      if (!value) return "";
      if (typeof value === "string") return value;
      if (value.name) return value.name;
      if (value.rating && value.organization) return `${value.organization} ${value.rating}`;
      if (value.rating) return String(value.rating);
      return "";
    })
    .filter(Boolean);
  return list.length ? list.join(", ") : "";
}

function formatReleaseDate(dateStr, precision) {
  if (!dateStr) return "TBA";
  const d = new Date(dateStr);
  if (isNaN(d)) return "TBA";
  if (precision === "year") return d.getFullYear().toString();
  if (precision === "month")
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ releaseDate }) {
  if (!releaseDate)
    return <span className="ugd-badge ugd-badge--upcoming">Upcoming</span>;
  const rel = new Date(releaseDate);
  const now = new Date();
  if (rel <= now)
    return (
      <span className="ugd-badge ugd-badge--available">Available Now</span>
    );
  const diff = (rel - now) / (1000 * 60 * 60 * 24);
  if (diff <= 30)
    return <span className="ugd-badge ugd-badge--soon">Coming Soon</span>;
  return <span className="ugd-badge ugd-badge--upcoming">Upcoming</span>;
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function CountdownRow({ releaseDate }) {
  const { days, hours, minutes, seconds, released } = useCountdown(releaseDate);
  if (released) return null;
  return (
    <div className="ugd-countdown" aria-label="Time until release">
      <div className="ugd-countdown__unit">
        <strong>{days}</strong>
        <small>days</small>
      </div>
      <div className="ugd-countdown__unit">
        <strong>{pad(hours)}</strong>
        <small>hrs</small>
      </div>
      <div className="ugd-countdown__unit">
        <strong>{pad(minutes)}</strong>
        <small>min</small>
      </div>
      <div className="ugd-countdown__unit">
        <strong>{pad(seconds)}</strong>
        <small>sec</small>
      </div>
    </div>
  );
}

// ── Recommendation section ────────────────────────────────────────────────────

const REASON_TEXT = {
  franchise: (label) => `You follow the ${label} franchise`,
  developer: (label) => `You play games by ${label}`,
  publisher: (label) => `Published by ${label}, which you enjoy`,
  genre: (label) => `You enjoy ${label} games`,
  tag: (label) => `Matches your interest in ${label}`,
};

function RecommendedBecause({ reasons }) {
  if (!reasons?.length) return null;
  return (
    <div className="ugd-reasons">
      <div className="ugd-reasons__head">
        <Sparkles size={13} className="ugd-reasons__icon" />
        <span className="ugd-reasons__label">You may care because…</span>
      </div>
      <div className="ugd-reasons__list">
        {reasons.map((r, i) => {
          const explain = REASON_TEXT[r.kind];
          return (
            <span key={i} className="ugd-reasons__item">
              {explain ? explain(r.label) : r.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Ratings ───────────────────────────────────────────────────────────────────

function ScoreRing({ score, label, icon: Icon, colorClass }) {
  if (score == null) return null;
  const pct = Math.round(score);
  // SVG ring — radius 22, circumference ≈ 138.2
  const R = 22;
  const C = 2 * Math.PI * R;
  const fill = (pct / 100) * C;
  return (
    <div className={`ugd-score-ring ${colorClass ?? ""}`}>
      <div className="ugd-score-ring__svg-wrap">
        <svg
          viewBox="0 0 52 52"
          className="ugd-score-ring__svg"
          aria-hidden="true"
          width="60"
          height="60"
        >
          <circle cx="26" cy="26" r={R} className="ugd-score-ring__track" />
          <circle
            cx="26"
            cy="26"
            r={R}
            className="ugd-score-ring__fill"
            strokeDasharray={`${fill} ${C}`}
            transform="rotate(-90, 26, 26)"
          />
        </svg>
        <div className="ugd-score-ring__center">
          <strong className="ugd-score-ring__pct">{pct}</strong>
        </div>
      </div>
      <span className="ugd-score-ring__label">
        {Icon && <Icon size={10} />}
        {label}
      </span>
    </div>
  );
}

function RatingsSection({
  rating,
  aggregatedRating,
  totalRating,
  ratingCount,
  aggregatedRatingCount,
}) {
  const hasAny = rating != null || aggregatedRating != null;
  if (!hasAny) return null;
  return (
    <section className="ugd-section ugd-section--glass">
      <h2 className="ugd-section__heading">Ratings</h2>
      <div className="ugd-ratings">
        <ScoreRing
          score={rating}
          label={
            ratingCount ? `${ratingCount.toLocaleString()} users` : "Community"
          }
          icon={Users}
          colorClass="ugd-score-ring--community"
        />
        <ScoreRing
          score={aggregatedRating}
          label={
            aggregatedRatingCount
              ? `${aggregatedRatingCount} critics`
              : "Critics"
          }
          icon={Star}
          colorClass="ugd-score-ring--critics"
        />
        {totalRating != null && rating != null && aggregatedRating != null && (
          <ScoreRing
            score={totalRating}
            label="Overall"
            colorClass="ugd-score-ring--overall"
          />
        )}
      </div>
      <p className="ugd-ratings__note">Scores from IGDB · 0 – 100</p>
    </section>
  );
}

// ── Fact row ──────────────────────────────────────────────────────────────────

function Fact({ icon: Icon, label, value }) {
  if (!value || value === "—") return null;
  return (
    <div className="ugd-fact">
      {Icon && <Icon size={13} className="ugd-fact__icon" />}
      <div className="ugd-fact__text">
        <span className="ugd-fact__label">{label}</span>
        <span className="ugd-fact__value">{value}</span>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function normTitle(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export default function UpcomingGameDetail() {
  const { source, sourceGameId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const profile = useLibraryProfile();
  const { games: libraryGames } = useGameContext();

  // searchResult is passed as location state when navigating from IGDB search.
  // It serves as fallback data when the game isn't in our cache (e.g., released
  // games or far-future titles not yet synced).
  const searchResult = location.state?.searchResult ?? null;

  const {
    game: cachedGame,
    loading,
    error,
    isFollowed,
    toggleFollow,
  } = useUpcomingGame(source, sourceGameId);

  // Use cached game if available, fall back to search result data
  const game = cachedGame ?? (loading ? null : (searchResult ? { 
    ...searchResult, 
    source: source, 
    source_game_id: sourceGameId 
  } : null));

  const gameName = game?.name ?? game?.title ?? null;
  const { data: ext, loading: extLoading } = useUpcomingGameExtended(
    gameName,
    sourceGameId,
  );

  // ── Wrap toggleFollow to also upsert into upcoming_games_cache ────────────
  // For games from IGDB search that are not yet in upcoming_games_cache, we
  // upsert BEFORE calling toggleFollow so the game is in the DB by the time
  // followBus fires and the Following tab re-fetches.
  const handleToggleFollow = useCallback(async () => {
    // Only upsert on new follows (!isFollowed) for games not in our DB (!cachedGame)
    if (!isFollowed && game && !cachedGame) {
      const releaseDate = game.release_date ?? null;
      const isReleased = releaseDate && new Date(releaseDate) <= new Date();
      await supabase.functions.invoke('upsert-upcoming-cache', {
        body: {
          gameData: {
            source: source,
            source_game_id: String(sourceGameId),
            name: game.name ?? game.title ?? "",
            cover_url: game.cover_url ?? null,
            banner_url: game.banner_url ?? game.cover_url ?? null,
            release_date: releaseDate,
            release_date_precision: game.release_date_precision ?? "year",
            developer_names: asArray(game.developer_names),
            publisher_names: asArray(game.publisher_names),
            genres: asArray(game.genres),
            platforms: asArray(game.platforms),
            summary: game.summary ?? ext?.summary ?? null,
            franchise_name: game.franchise_name ?? game.series_name ?? null,
            status: isReleased ? "released" : "upcoming",
            hype_score: game.hype_score ?? 0,
          }
        }
      }).catch(() => {});
    }
    await toggleFollow(game);
  }, [
    game,
    cachedGame,
    source,
    sourceGameId,
    ext,
    isFollowed,
    toggleFollow,
  ]);

  const goBack = () => navigate(-1);

  // Check if this upcoming game is already in the user's library by normalised title
  const libraryMatch = useMemo(() => {
    const rawName = game?.name ?? game?.title ?? null;
    if (!rawName) return null;
    const target = normTitle(rawName);
    if (!target) return null;
    return libraryGames.find(
      (g) => normTitle(g.displayTitle || g.title) === target,
    ) ?? null;
  }, [game, libraryGames]);

  if (loading) {
    return (
      <div className="page upcoming-detail">
        <TopBar backAction={goBack} />
        <div className="upcoming-detail__scroll">
          <div className="ugd-skeleton">
            <div className="ugd-skeleton__hero" />
            <div className="ugd-skeleton__body">
              <div
                className="skeleton-line"
                style={{ width: "60%", height: 14 }}
              />
              <div
                className="skeleton-line"
                style={{ width: "40%", height: 36, marginTop: 10 }}
              />
              <div
                className="skeleton-line"
                style={{ width: "80%", height: 14, marginTop: 12 }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="page upcoming-detail">
        <TopBar backAction={goBack} />
        <div className="upcoming-detail__scroll">
          <div className="ugd-error">
            <CalendarDays size={36} strokeWidth={1} />
            <p>{error ?? "This game is no longer in our cache."}</p>
            <button type="button" className="ugd-error__back" onClick={goBack}>
              Go back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  const title = game.name ?? game.title ?? "Unknown Game";
  const developers = asArray(game.developer_names);
  const publishers = asArray(game.publisher_names);
  const genres = asArray(game.genres);
  const themes = asArray(game.themes);
  const tags = asArray(game.tags).slice(0, 12);
  const platforms = asArray(game.platforms);
  const bannerUrl = game.banner_url ?? game.cover_url ?? null;
  const coverUrl = game.cover_url ?? game.banner_url ?? null;
  const summary = typeof game.summary === "string" ? game.summary.trim() : "";

  const reasons = matchReasons(game, profile, 4);
  const descSummary = summary || ext?.summary || "";
  const storyline = ext?.storyline || "";
  const screenshots = mergeImages(
    ext?.screenshots,
    game.screenshots,
    game.screenshot_urls,
    searchResult?.screenshots,
    searchResult?.screenshot_urls,
  );
  const artworks = mergeImages(
    ext?.artworks,
    game.artworks,
    game.artwork_urls,
    searchResult?.artworks,
    searchResult?.artwork_urls,
    game.banner_url,
    searchResult?.banner_url,
  );
  const videos = mergeVideos(ext?.videos, game.videos, searchResult?.videos);
  const websites = asArray(ext?.websites).length
    ? asArray(ext.websites)
    : asArray(game.websites ?? searchResult?.websites);
  const ageRatings = asArray(ext?.age_ratings ?? game.age_ratings ?? searchResult?.age_ratings);
  const gameModes = asArray(ext?.game_modes ?? game.game_modes ?? searchResult?.game_modes);
  const playerPerspectives = asArray(
    ext?.player_perspectives ?? game.player_perspectives ?? searchResult?.player_perspectives,
  );
  const gameEngines = asArray(ext?.game_engines ?? game.game_engines ?? searchResult?.game_engines);

  // Ratings — from IGDB extended data (0-100 scale, null when unavailable)
  const igdbRating = firstPresent(ext?.rating, game.rating, searchResult?.rating);
  const igdbAggRating = firstPresent(
    ext?.aggregated_rating,
    game.aggregated_rating,
    game.aggregatedRating,
    searchResult?.aggregated_rating,
    searchResult?.aggregatedRating,
  );
  const igdbTotalRating = firstPresent(
    ext?.total_rating,
    game.total_rating,
    game.totalRating,
    searchResult?.total_rating,
    searchResult?.totalRating,
  );
  const igdbRatingCount = firstPresent(
    ext?.rating_count,
    game.rating_count,
    game.ratingCount,
    searchResult?.rating_count,
    searchResult?.ratingCount,
  );
  const igdbAggRatingCount = firstPresent(
    ext?.aggregated_rating_count,
    game.aggregated_rating_count,
    game.aggregatedRatingCount,
    searchResult?.aggregated_rating_count,
    searchResult?.aggregatedRatingCount,
  );

  const allTags = [
    ...genres.map((g) => ({ label: g, type: "genre" })),
    ...themes.map((t) => ({ label: t, type: "theme" })),
    ...tags.map((t) => ({ label: t, type: "tag" })),
  ];

  return (
    <div className="page upcoming-detail">
      <TopBar backAction={goBack} />

      <div className="upcoming-detail__scroll">
        {/* ── Cinematic Hero ──────────────────────────────────────────── */}
        <section className="ugd-hero">
          {bannerUrl && (
            <div
              className="ugd-hero__bg"
              style={{ backgroundImage: `url(${bannerUrl})` }}
              aria-hidden="true"
            />
          )}
          <div className="ugd-hero__gradient" aria-hidden="true" />

          <div className="ugd-hero__content">
            {/* Cover art */}
            {coverUrl && (
              <div className="ugd-hero__cover">
                <img src={coverUrl} alt={title} loading="eager" />
              </div>
            )}

            {/* Identity + actions column */}
            <div className="ugd-hero__info">
              {game.franchise_name && (
                <p className="ugd-hero__franchise">{game.franchise_name}</p>
              )}

              <h1 className="ugd-hero__title">{title}</h1>

              {/* Release meta */}
              <div className="ugd-hero__meta">
                <StatusBadge releaseDate={game.release_date} />
                <span className="ugd-hero__date">
                  <CalendarDays size={13} />
                  {formatReleaseDate(
                    game.release_date,
                    game.release_date_precision,
                  )}
                </span>
                {developers[0] && (
                  <span className="ugd-hero__dev">by {developers[0]}</span>
                )}
              </div>

              {/* Genres, tags & library ownership — unified tag row */}
              {(allTags.length > 0 || libraryMatch) && (
                <div className="ugd-hero__tags">
                  {libraryMatch && (
                    <Link
                      to={`/game/${libraryMatch.id}`}
                      className="ugd-hero__tag ugd-hero__tag--library"
                    >
                      <CheckCircle size={11} strokeWidth={2.5} />
                      In your library
                      <span className="ugd-hero__tag-arrow">→</span>
                    </Link>
                  )}
                  {allTags.slice(0, 10).map((t, i) => (
                    <span
                      key={i}
                      className={`ugd-hero__tag ${t.type === "genre" || t.type === "theme" ? "ugd-hero__tag--accent" : ""}`}
                    >
                      {t.label}
                    </span>
                  ))}
                </div>
              )}

              {/* Recommendation context */}
              <RecommendedBecause reasons={reasons} />

              {/* Countdown */}
              {game.release_date && (
                <CountdownRow releaseDate={game.release_date} />
              )}

              {/* Actions */}
              <div className="ugd-hero__actions">
                <button
                  type="button"
                  onClick={handleToggleFollow}
                  disabled={!user}
                  className={`ugd-follow-btn ${isFollowed ? "ugd-follow-btn--following" : "ugd-follow-btn--default"}`}
                  title={
                    user
                      ? isFollowed
                        ? "Unfollow this game"
                        : "Follow to get notified"
                      : "Sign in to follow"
                  }
                >
                  {isFollowed ? <BellOff size={15} /> : <Bell size={15} />}
                  {isFollowed ? "Following" : "Follow"}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ── Two-column body ─────────────────────────────────────────── */}
        <div className="ugd-body">
          {/* ── Left column: About + Media ──────────────────────────── */}
          <div className="ugd-col ugd-col--main">
            {/* About / Description */}
            {extLoading && !descSummary && !storyline ? (
              <section className="ugd-section ugd-ext-section--loading">
                <h2 className="ugd-section__heading">About</h2>
                <div className="ugd-about-skeleton">
                  <div
                    className="skeleton-line"
                    style={{ width: "96%", height: 13 }}
                  />
                  <div
                    className="skeleton-line"
                    style={{ width: "88%", height: 13 }}
                  />
                  <div
                    className="skeleton-line"
                    style={{ width: "93%", height: 13 }}
                  />
                  <div
                    className="skeleton-line"
                    style={{ width: "71%", height: 13 }}
                  />
                  <div
                    className="skeleton-line"
                    style={{ width: "85%", height: 13, marginTop: 10 }}
                  />
                  <div
                    className="skeleton-line"
                    style={{ width: "90%", height: 13 }}
                  />
                  <div
                    className="skeleton-line"
                    style={{ width: "60%", height: 13 }}
                  />
                </div>
              </section>
            ) : descSummary || storyline ? (
              <section className="ugd-section">
                <h2 className="ugd-section__heading">About</h2>
                <GameDescription summary={descSummary} storyline={storyline} />
              </section>
            ) : null}

            {/* Media gallery */}
            {extLoading &&
            videos.length === 0 &&
            screenshots.length === 0 &&
            artworks.length === 0 ? (
              <section className="ugd-section ugd-ext-section--loading">
                <h2 className="ugd-section__heading">Media</h2>
                <div className="ugd-media-skeleton">
                  <div className="ugd-media-skeleton__main skeleton-line" />
                  <div className="ugd-media-skeleton__thumbs">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="ugd-media-skeleton__thumb skeleton-line"
                      />
                    ))}
                  </div>
                </div>
              </section>
            ) : videos.length > 0 ||
              screenshots.length > 0 ||
              artworks.length > 0 ? (
              <section className="ugd-section">
                <h2 className="ugd-section__heading">Media</h2>
                <GameMediaGallery
                  videos={videos}
                  screenshots={screenshots}
                  artworks={artworks}
                />
              </section>
            ) : null}
          </div>

          {/* ── Right column: Prices + Details + Community ──────────── */}
          <div className="ugd-col ugd-col--side">
            {/* Ratings */}
            <RatingsSection
              rating={igdbRating}
              aggregatedRating={igdbAggRating}
              totalRating={igdbTotalRating}
              ratingCount={igdbRatingCount}
              aggregatedRatingCount={igdbAggRatingCount}
            />

            {/* Where to Buy */}
            <section className="ugd-section ugd-section--glass">
              <h2 className="ugd-section__heading">Where to Buy</h2>
              <GameStoreLinks websites={websites} gameName={title} />
            </section>

            {/* Details */}
            <section className="ugd-section ugd-section--glass">
              <h2 className="ugd-section__heading">Details</h2>
              <div className="ugd-facts">
                <Fact
                  icon={CalendarDays}
                  label="Release"
                  value={formatReleaseDate(
                    game.release_date,
                    game.release_date_precision,
                  )}
                />
                <Fact
                  icon={Code2}
                  label="Developer"
                  value={developers.join(", ") || "—"}
                />
                <Fact
                  icon={Building2}
                  label="Publisher"
                  value={publishers.join(", ") || "—"}
                />
                <Fact
                  icon={Layers}
                  label="Platforms"
                  value={platforms.join(", ") || "—"}
                />
                <Fact
                  icon={Tag}
                  label="Modes"
                  value={formatListValue(gameModes)}
                />
                <Fact
                  icon={Users}
                  label="Perspective"
                  value={formatListValue(playerPerspectives)}
                />
                <Fact
                  icon={Code2}
                  label="Engine"
                  value={formatListValue(gameEngines)}
                />
                <Fact
                  icon={Star}
                  label="Age rating"
                  value={formatListValue(ageRatings)}
                />
                {game.franchise_name && (
                  <Fact
                    icon={Tag}
                    label="Franchise"
                    value={game.franchise_name}
                  />
                )}
              </div>
            </section>
          </div>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <p className="ugd-footer-note">
          Metadata from {game.source?.toUpperCase() ?? "IGDB"}
          {" · "}
          <Link to="/upcoming">All upcoming releases</Link>
        </p>
      </div>
    </div>
  );
}
