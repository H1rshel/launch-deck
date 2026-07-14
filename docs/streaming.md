# Game Streaming & Multi-PC Sync

Added in v0.1.51. Lets a user play games installed on one of their PCs from any
other PC signed into the same account, and makes a fresh install mirror the
main PC (library, images + positions, favorites, collections, descriptions,
settings).

## Architecture

**Stack:** Sunshine (LizardByte) as the streaming host, Moonlight (moonlight-qt
portable) as the client. Launch Deck auto-provisions both — the user never
sees them, enters PINs, or opens their UIs.

**Supabase tables** (`supabase/migrations/20260714000000_streaming_and_device_sync.sql`):

| Table | Purpose |
|---|---|
| `user_devices` | One row per PC: hostname, hardware summary, LAN IP, host flags, `last_seen` heartbeat (60s; online = < 3 min) |
| `device_game_installs` | Which games are installed on which PC (cloud game_id) |
| `user_settings` | Whitelisted synced preferences (whole-doc LWW) |
| `user_game_metadata` | Per-game description / chosen-metadata payloads |
| `device_commands` | Command bus between PCs (Realtime + poll fallback) |
| `games` (extended) | +14 customization columns: hero_position, favorite, user_collection, genres, franchises, … |

**Device identity:** UUID generated once per install, stored in the local
SQLite `app_meta` table (`src/lib/db.js`, SCHEMA_VERSION 3) — survives WebView2
profile resets. All device logic in `src/lib/devices.js`.

## Host flow (Settings → Streaming → toggle ON)

`src/lib/streaming/provision.js#provisionSunshineHost`:
1. Download the Sunshine NSIS installer (GitHub latest) via the Rust
   `download_file` command (progress events).
2. Generate random credentials (persisted in `app_meta`).
3. One elevated PowerShell script (single UAC prompt): silent install `/S` →
   `sunshine.exe --creds` → restart `SunshineService`. The installer adds
   firewall rules and the auto-start service itself.
4. Verify `GET /api/apps`, then flag `user_devices.sunshine_provisioned`.

The host runs a command listener (`src/lib/streaming/commandBus.js` +
`streamingHost.js`) answering:
- `pair_request` — POSTs the client's PIN to Sunshine `/api/pin` (2s retry ≤ 60s).
- `prepare_stream` — resolves the game locally, creates/updates a Sunshine app
  entry (`LD: <cloudGameId>`, cmd = game exe, `wait-all`, `auto-detach`),
  starts host-side session tracking (process polling → playtime + cloud sync),
  returns `{appName, lanIp}`.
- `end_stream` — best-effort game process kill.

## Client flow (Stream button)

`src/lib/streaming/streamingClient.js#streamGame`:
1. Ensure Moonlight portable exists (downloaded/extracted to app data, no admin).
2. Pair if needed: generate a 4-digit PIN, send it to the host over the command
   bus, run `Moonlight.exe pair <ip> --pin <PIN>`; exit code 0 = paired
   (source of truth — guards Sunshine issue #3944).
3. `prepare_stream` → `Moonlight.exe stream <ip> "LD: <id>" --quit-after
   --display-mode fullscreen --resolution … --fps … [--bitrate …]`.
4. `moonlight_exited` event ends the session; `--quit-after` makes Sunshine
   terminate the game on the host.

The Stream button appears wherever a game is **not installed locally** but
**installed on an online, provisioned host** (`StreamingContext.getStreamSource`):
GameDetail hero, GameCard, FeaturedHero, console-mode primary action +
GameActionSheet. Overlay: `src/components/games/StreamingOverlay.jsx`.

## Sync behavior on a new PC

- Library arrives as `not_installed` (existing cloudSync behavior) **with**
  images, hero positions, favorites, custom collections, metadata fields, and
  descriptions (`user_game_metadata` pull).
- Settings arrive via `user_settings` (see `SYNCED_SETTING_KEYS` /
  `SYNCED_RAW_KEYS` in `src/lib/settingsSync.js`). Machine-specific settings
  (startup, tray, game folders, stream quality) and OAuth tokens stay local.
- Cloud sync degrades gracefully if the migration is missing (column-detection
  fallbacks in `cloudSync.js`).

## Known limitations / follow-ups

- **LAN only** (v1). WAN needs UPnP/Tailscale — future phase.
- **Gamepad passthrough while streaming** may require ViGEmBus on the host
  (recent Sunshine builds no longer bundle it). Keyboard/mouse works out of the box.
- Launcher-stub games (Epic/EA bootstrap exes) stream via Sunshine
  `auto-detach`; ending the stream may not kill the real game process.
- Sunshine credentials stored plaintext in local SQLite (DPAPI follow-up).
- Two-PC end-to-end testing checklist: fresh login mirrors library/settings →
  device appears online in Settings → Stream button on the second PC →
  first stream downloads Moonlight + pairs with zero prompts → playtime lands
  on both PCs → uninstalling on the host removes the button within 5 min.
