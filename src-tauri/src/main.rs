#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod scanner;

use base64::Engine;
use dotenv::dotenv;
use reqwest::Client;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::{Mutex, RwLock};
use walkdir::WalkDir;

const APP_USER_AGENT: &str = concat!(
    "LaunchDeck/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/H1rshel/launch-deck)"
);

fn app_http_client() -> Client {
    Client::builder()
        .user_agent(APP_USER_AGENT)
        .build()
        .unwrap_or_else(|_| Client::new())
}

fn get_env(key: &str) -> Result<String, String> {
    dotenv().ok();

    if let Ok(val) = std::env::var(key) {
        return Ok(val);
    }

    let compiled = match key {
        "IGDB_CLIENT_ID" => option_env!("IGDB_CLIENT_ID"),
        "IGDB_CLIENT_SECRET" => option_env!("IGDB_CLIENT_SECRET"),
        "ITAD_API_KEY" => option_env!("ITAD_API_KEY"),
        "STEAM_API_KEY" => option_env!("STEAM_API_KEY"),
        "VITE_GAMES_DB_API_KEY" => option_env!("VITE_GAMES_DB_API_KEY"),
        "VITE_RAWG_API_KEY" => option_env!("VITE_RAWG_API_KEY"),
        "VITE_SGD_API_KEY" => option_env!("VITE_SGD_API_KEY"),
        "VITE_SUPABASE_ANON_KEY" => option_env!("VITE_SUPABASE_ANON_KEY"),
        "VITE_SUPABASE_URL" => option_env!("VITE_SUPABASE_URL"),
        _ => None,
    };

    if let Some(val) = compiled {
        if !val.trim().is_empty() {
            return Ok(val.trim().to_string());
        }
    }

    Err(format!("{} not found", key))
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const SKIP_NAMES: &[&str] = &[
    "unins000",
    "unins001",
    "uninstall",
    "setup",
    "installer",
    "install",
    "update",
    "updater",
    "crash",
    "crashhandler",
    "crashreporter",
    "crashpad_handler",
    "crashpad",
    "ue4prereqsetup",
    "ueprereqsetup",
    "redist",
    "vcredist",
    "vcredist_x64",
    "vcredist_x86",
    "dxsetup",
    "dxwebsetup",
    "dotnetfx",
    "prerequisite",
    "7za",
    "aria2c",
    "steamclient",
    "steamclient64",
    "pythonw",
    "python",
    "cefprocess",
    "subprocess",
    "helper",
    "notification_helper",
    "nacl64",
    "wow_helper",
    "launcher",
    "gamelaunch",
    "start",
];

// Substrings — if the exe stem contains any of these, skip it
const SKIP_CONTAINS: &[&str] = &[
    "uninstall",
    "crashpad",
    "crashhandler",
    "crashreport",
    "redist",
    "setup",
    "installer",
    "anticheat",
    "anti_cheat",
    "easyanticheat",
    "battleye",
    "launcher",
    "gameservice",
    "showcase",
    "trial",
    "demo",
    "benchmark",
    "editor",
    "server",
    "dedicated",
];

const SKIP_FOLDERS: &[&str] = &[
    "redist",
    "redistributable",
    "redistributables",
    "_redist",
    "_commonredist",
    "directx",
    "vcredist",
    "dotnet",
    "__installer",
    "support",
    "crashreporter",
    "crashpad",
    "node_modules",
    ".git",
    "windows",
    "system32",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "temp",
    "tmp",
    "$recycle.bin",
    "system volume information",
    "perflogs",
    "winsxs",
    "recovery",
];

#[tauri::command]
fn scan_for_exes(folders: Vec<String>) -> Vec<String> {
    let mut exe_paths = Vec::new();

    for folder in &folders {
        let path = std::path::Path::new(folder);
        if !path.exists() || !path.is_dir() {
            continue;
        }

        for entry in WalkDir::new(path)
            .max_depth(5)
            .into_iter()
            .filter_entry(|e| {
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    return !SKIP_FOLDERS.contains(&name.as_str());
                }
                true
            })
            .filter_map(|e| e.ok())
        {
            let entry_path = entry.path();
            if !entry_path.is_file() {
                continue;
            }

            let ext = entry_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");

            if !ext.eq_ignore_ascii_case("exe") {
                continue;
            }

            let stem = entry_path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let lower = stem.to_lowercase();

            // Exact name match
            if SKIP_NAMES.contains(&lower.as_str()) {
                continue;
            }

            // Substring match
            if SKIP_CONTAINS.iter().any(|s| lower.contains(s)) {
                continue;
            }

            exe_paths.push(entry_path.to_string_lossy().to_string());
        }
    }

    exe_paths
}

#[derive(Serialize, Clone)]
struct GameExitedPayload {
    game_id: String,
    elapsed_seconds: u64,
}

#[tauri::command]
fn launch_game(app_handle: tauri::AppHandle, game_id: String, path: String) -> Result<(), String> {
    let exe = std::path::Path::new(&path);
    if !exe.exists() {
        return Err(format!("File not found: {}", path));
    }

    let dir = exe.parent().unwrap_or(exe);
    let start = std::time::Instant::now();

    let mut child = std::process::Command::new(&path)
        .current_dir(dir)
        .spawn()
        .map_err(|e| format!("Failed to launch: {}", e))?;

    // Wait for the process to exit in a background thread, then emit playtime
    std::thread::spawn(move || {
        let _ = child.wait();
        let elapsed_secs = start.elapsed().as_secs();
        let _ = app_handle.emit(
            "game_exited",
            GameExitedPayload {
                game_id,
                elapsed_seconds: elapsed_secs,
            },
        );
    });

    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameData {
    pub id: u32,
    pub name: String,
    pub release_date: Option<String>,
    pub genres: Vec<String>,
    pub platforms: Vec<String>,
    pub cover: Option<String>,
    pub hero: Option<String>,
    pub logo: Option<String>,
}

#[derive(Deserialize)]
struct RawgResponse {
    results: Vec<RawgGame>,
}

#[derive(Deserialize)]
struct RawgGame {
    id: u32,
    name: String,
    released: Option<String>,
    background_image: Option<String>,
    genres: Option<Vec<RawgGenre>>,
    platforms: Option<Vec<RawgPlatformContainer>>,
}

#[derive(Deserialize)]
struct RawgGenre {
    name: String,
}

#[derive(Deserialize)]
struct RawgPlatformContainer {
    platform: RawgPlatform,
}

#[derive(Deserialize)]
struct RawgPlatform {
    name: String,
}

#[derive(Deserialize)]
struct SgdSearchResponse {
    success: bool,
    data: Vec<SgdSearchItem>,
}

#[derive(Deserialize)]
struct SgdSearchItem {
    id: u32,
    name: String,
    release_date: Option<i64>,
}

#[derive(Serialize)]
struct SteamGridGameResponse {
    id: u32,
    name: String,
    release_date: Option<i64>,
}

#[derive(Deserialize)]
struct SgdAssetResponse {
    success: bool,
    data: Vec<SgdAsset>,
}

#[derive(Deserialize)]
struct SgdAsset {
    url: String,
    author: Option<SgdAuthor>,
    style: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Deserialize)]
struct SgdAuthor {
    name: String,
}

#[derive(Deserialize)]
struct TgdbSearchResponse {
    code: i32,
    data: TgdbData,
    include: Option<TgdbInclude>,
}

#[derive(Deserialize)]
struct TgdbData {
    games: Vec<TgdbGame>,
}

#[derive(Deserialize)]
struct TgdbGame {
    id: u32,
    game_title: String,
    release_date: Option<String>,
}

#[derive(Deserialize)]
struct TgdbInclude {
    boxart: Option<TgdbBoxart>,
}

#[derive(Deserialize)]
struct TgdbBoxart {
    base_url: TgdbBoxartBaseUrl,
    data: std::collections::HashMap<String, Vec<TgdbBoxartItem>>,
}

#[derive(Deserialize)]
struct TgdbBoxartBaseUrl {
    original: String,
}

#[derive(Deserialize)]
struct TgdbBoxartItem {
    #[serde(rename = "type")]
    item_type: String,
    side: Option<String>,
    filename: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GamesDbResult {
    name: String,
    release_date: Option<String>,
    image_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SteamGridCoverResponse {
    url: String,
    author: String,
    style: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WebImageResult {
    url: String,
    width: u32,
    height: u32,
    source: String,
}

#[tauri::command]
async fn get_game_data(query: String) -> Result<GameData, String> {
    fetch_game_data(&query).await
}

pub async fn fetch_game_data(query: &str) -> Result<GameData, String> {
    dotenv().ok();

    let rawg_key = get_env("VITE_RAWG_API_KEY")
        .map_err(|_| "VITE_RAWG_API_KEY not set in .env".to_string())?;
    let sgd_key = get_env("VITE_SGD_API_KEY")
        .map_err(|_| "VITE_SGD_API_KEY not set in .env".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let safe_query = query.replace(" ", "%20");

    // 1. RAWG API Call
    let rawg_url = format!(
        "https://api.rawg.io/api/games?search={}&key={}",
        safe_query, rawg_key
    );
    let rawg_res = client
        .get(&rawg_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch from RAWG: {}", e))?
        .json::<RawgResponse>()
        .await
        .map_err(|e| format!("Failed to parse RAWG response: {}", e))?;

    let rawg_game = rawg_res
        .results
        .into_iter()
        .next()
        .ok_or_else(|| "No game found on RAWG".to_string())?;

    let mut game_data = GameData {
        id: rawg_game.id,
        name: rawg_game.name,
        release_date: rawg_game.released,
        genres: rawg_game
            .genres
            .unwrap_or_default()
            .into_iter()
            .map(|g| g.name)
            .collect(),
        platforms: rawg_game
            .platforms
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.platform.name)
            .collect(),
        cover: rawg_game.background_image.clone(),
        hero: None,
        logo: None,
    };

    // 2. SteamGridDB Fetch
    let safe_query = query.replace(" ", "%20");
    let sgd_search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        safe_query
    );
    let sgd_search_res = client
        .get(&sgd_search_url)
        .header("Authorization", format!("Bearer {}", sgd_key))
        .send()
        .await;

    // We do not fail the whole command if SGD fails, we just try to get images if possible.
    if let Ok(res) = sgd_search_res {
        if let Ok(search_data) = res.json::<SgdSearchResponse>().await {
            if search_data.success && !search_data.data.is_empty() {
                let sgd_id = search_data.data[0].id;

                // Fetch Grids
                if let Ok(grid_res) = client
                    .get(&format!("https://www.steamgriddb.com/api/v2/grids/game/{}?dimensions=600x900,342x482,460x215", sgd_id))
                    .header("Authorization", format!("Bearer {}", sgd_key))
                    .send()
                    .await
                {
                    if let Ok(grid_data) = grid_res.json::<SgdAssetResponse>().await {
                        if grid_data.success && !grid_data.data.is_empty() {
                            game_data.cover = Some(grid_data.data[0].url.clone());
                        }
                    }
                }

                // Fetch Heroes — prefer 4K (3840x1240), fall back to HD (1920x620)
                let mut hero_url: Option<String> = None;
                if let Ok(hero_res) = client
                    .get(&format!(
                        "https://www.steamgriddb.com/api/v2/heroes/game/{}?dimensions=3840x1240",
                        sgd_id
                    ))
                    .header("Authorization", format!("Bearer {}", sgd_key))
                    .send()
                    .await
                {
                    if let Ok(hero_data) = hero_res.json::<SgdAssetResponse>().await {
                        if hero_data.success && !hero_data.data.is_empty() {
                            hero_url = Some(hero_data.data[0].url.clone());
                        }
                    }
                }
                if hero_url.is_none() {
                    if let Ok(hero_res) = client
                        .get(&format!(
                            "https://www.steamgriddb.com/api/v2/heroes/game/{}?dimensions=1920x620",
                            sgd_id
                        ))
                        .header("Authorization", format!("Bearer {}", sgd_key))
                        .send()
                        .await
                    {
                        if let Ok(hero_data) = hero_res.json::<SgdAssetResponse>().await {
                            if hero_data.success && !hero_data.data.is_empty() {
                                hero_url = Some(hero_data.data[0].url.clone());
                            }
                        }
                    }
                }
                game_data.hero = hero_url;

                // Fetch Logos
                if let Ok(logo_res) = client
                    .get(&format!(
                        "https://www.steamgriddb.com/api/v2/logos/game/{}?types=static",
                        sgd_id
                    ))
                    .header("Authorization", format!("Bearer {}", sgd_key))
                    .send()
                    .await
                {
                    if let Ok(logo_data) = logo_res.json::<SgdAssetResponse>().await {
                        if logo_data.success && !logo_data.data.is_empty() {
                            game_data.logo = Some(logo_data.data[0].url.clone());
                        }
                    }
                }
            }
        }
    }

    Ok(game_data)
}

#[tauri::command]
async fn search_steamgrid_assets(
    query: String,
    asset_type: String,
) -> Result<Vec<SteamGridCoverResponse>, String> {
    dotenv().ok();
    let sgd_key = get_env("VITE_SGD_API_KEY")
        .map_err(|_| "VITE_SGD_API_KEY not set in .env".to_string())?;
    let client = Client::new();
    let safe_query = query.replace(" ", "%20");

    let sgd_search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        safe_query
    );
    let search_res = client
        .get(&sgd_search_url)
        .header("Authorization", format!("Bearer {}", sgd_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let search_data = search_res
        .json::<SgdSearchResponse>()
        .await
        .map_err(|e| e.to_string())?;

    if search_data.success && !search_data.data.is_empty() {
        let sgd_id = search_data.data[0].id;

        let endpoint_url = match asset_type.as_str() {
            "grids" => format!(
                "https://www.steamgriddb.com/api/v2/grids/game/{}?dimensions=600x900",
                sgd_id
            ),
            "heroes" => format!("https://www.steamgriddb.com/api/v2/heroes/game/{}", sgd_id),
            "logos" => format!(
                "https://www.steamgriddb.com/api/v2/logos/game/{}?types=static",
                sgd_id
            ),
            _ => format!("https://www.steamgriddb.com/api/v2/grids/game/{}", sgd_id),
        };

        let grid_res = client
            .get(&endpoint_url)
            .header("Authorization", format!("Bearer {}", sgd_key))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let grid_data = grid_res
            .json::<SgdAssetResponse>()
            .await
            .map_err(|e| e.to_string())?;

        if grid_data.success {
            return Ok(grid_data
                .data
                .into_iter()
                .filter(|_g| true)
                .map(|g| SteamGridCoverResponse {
                    url: g.url,
                    author: g
                        .author
                        .map(|a| a.name)
                        .unwrap_or_else(|| "Unknown".to_string()),
                    style: g.style.unwrap_or_else(|| "Cover".to_string()),
                })
                .collect());
        }
    }

    Ok(vec![])
}

#[tauri::command]
async fn search_steamgrid_games(query: String) -> Result<Vec<SteamGridGameResponse>, String> {
    dotenv().ok();
    let sgd_key = get_env("VITE_SGD_API_KEY")
        .map_err(|_| "VITE_SGD_API_KEY not set in .env".to_string())?;
    let client = Client::new();
    let safe_query = query.replace(" ", "%20");
    let sgd_search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        safe_query
    );

    let search_res = client
        .get(&sgd_search_url)
        .header("Authorization", format!("Bearer {}", sgd_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let search_data = search_res
        .json::<SgdSearchResponse>()
        .await
        .map_err(|e| e.to_string())?;

    if search_data.success {
        return Ok(search_data
            .data
            .into_iter()
            .map(|item| SteamGridGameResponse {
                id: item.id,
                name: item.name,
                release_date: item.release_date,
            })
            .collect());
    }

    Ok(vec![])
}

#[tauri::command]
async fn search_games_db(query: String) -> Result<Vec<GamesDbResult>, String> {
    dotenv().ok();
    let api_key = get_env("VITE_GAMES_DB_API_KEY")
        .map_err(|_| "VITE_GAMES_DB_API_KEY not set in .env".to_string())?;

    let client = Client::new();
    let safe_query = query.replace(' ', "+");
    let url = format!(
        "https://api.thegamesdb.net/v1/Games/ByGameName?apikey={}&name={}&fields=game_title,release_date&include=boxart&limit=10",
        api_key, safe_query
    );

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("TheGamesDB request failed: {}", e))?;

    let data = res
        .json::<TgdbSearchResponse>()
        .await
        .map_err(|e| format!("Failed to parse TheGamesDB response: {}", e))?;

    if data.code != 200 {
        return Err(format!("TheGamesDB API error: code {}", data.code));
    }

    let base_url = data
        .include
        .as_ref()
        .and_then(|inc| inc.boxart.as_ref())
        .map(|ba| ba.base_url.original.clone())
        .unwrap_or_else(|| "https://cdn.thegamesdb.net/images/original/".to_string());

    let boxart_data = data
        .include
        .as_ref()
        .and_then(|inc| inc.boxart.as_ref())
        .map(|ba| &ba.data);

    // Deduplicate by title — TheGamesDB returns one entry per platform
    let mut seen = std::collections::HashSet::new();
    Ok(data
        .data
        .games
        .into_iter()
        .filter(|g| seen.insert(g.game_title.clone()))
        .take(5)
        .map(|g| {
            let image_url = boxart_data
                .and_then(|bd| bd.get(&g.id.to_string()))
                .and_then(|items| {
                    items
                        .iter()
                        .find(|i| i.item_type == "boxart" && i.side.as_deref() == Some("front"))
                        .or_else(|| items.first())
                })
                .map(|item| format!("{}{}", base_url, item.filename));

            GamesDbResult {
                name: g.game_title,
                release_date: g.release_date,
                image_url,
            }
        })
        .collect())
}

// ── Steam OAuth (OpenID) ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SteamProfileResponse {
    response: SteamProfilePlayers,
}

#[derive(Deserialize)]
struct SteamProfilePlayers {
    players: Vec<SteamPlayer>,
}

#[derive(Deserialize)]
struct SteamPlayer {
    steamid: String,
    personaname: String,
    avatarfull: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SteamConnectResult {
    steam_id: String,
    persona_name: String,
    avatar_url: String,
}

/// Extract the raw query string from an HTTP GET request first line.
fn extract_query_string(request: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let path = first_line.split_ascii_whitespace().nth(1)?;
    path.split_once('?').map(|(_, q)| q.to_owned())
}

/// Verify the Steam OpenID assertion via `check_authentication` and return the SteamID64.
///
/// Per the OpenID 2.0 spec the relying party must POST the callback parameters back to
/// Steam (with `openid.mode` replaced by `check_authentication`) and confirm that Steam
/// responds with `is_valid:true` before trusting the claimed identity.
async fn verify_openid_assertion(
    client: &reqwest::Client,
    query_string: &str,
) -> Result<String, String> {
    // Parse all URL-decoded key→value pairs from the callback query string
    let params: Vec<(String, String)> = query_string
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            let decoded = urlencoding::decode(v).ok()?.into_owned();
            Some((k.to_owned(), decoded))
        })
        .collect();

    // User cancelled the Steam login
    if params
        .iter()
        .any(|(k, v)| k == "openid.mode" && v == "cancel")
    {
        return Err("Steam login was cancelled.".to_string());
    }

    // Extract SteamID64 from openid.claimed_id
    let claimed_id = params
        .iter()
        .find(|(k, _)| k == "openid.claimed_id" || k == "openid.identity")
        .map(|(_, v)| v.as_str())
        .ok_or_else(|| "Steam did not return a valid identity — please try again.".to_string())?;

    let steam_id = claimed_id
        .split('/')
        .last()
        .filter(|id| id.len() >= 17 && id.chars().all(|c| c.is_ascii_digit()))
        .map(String::from)
        .ok_or_else(|| "Could not parse SteamID64 from the OpenID response.".to_string())?;

    // Build the check_authentication POST body: same params, mode replaced
    let verify_params: Vec<(String, String)> = params
        .into_iter()
        .map(|(k, v)| {
            if k == "openid.mode" {
                (k, "check_authentication".to_owned())
            } else {
                (k, v)
            }
        })
        .collect();

    // Encode as application/x-www-form-urlencoded manually — reqwest 0.13
    // removed the .form() helper from RequestBuilder without a feature flag.
    let form_body: String = verify_params
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let response = client
        .post("https://steamcommunity.com/openid/login")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await
        .map_err(|e| format!("Steam verification request failed: {e}"))?;

    let body: String = response
        .text()
        .await
        .map_err(|e| format!("Steam verification response unreadable: {e}"))?;

    if body.contains("is_valid:true") {
        Ok(steam_id)
    } else {
        Err("Steam could not verify this login. Please try again.".to_string())
    }
}

#[tauri::command]
async fn connect_steam() -> Result<SteamConnectResult, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    dotenv().ok();
    let steam_key = get_env("STEAM_API_KEY").unwrap_or_default();

    // Bind local callback listener (try a small port range)
    let (listener, port) = {
        let mut result: Option<(tokio::net::TcpListener, u16)> = None;
        for p in [27384u16, 27385, 27386, 27387, 27388] {
            if let Ok(l) = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", p)).await {
                result = Some((l, p));
                break;
            }
        }
        result.ok_or_else(|| {
            "Could not bind to any available port for the Steam auth callback".to_string()
        })?
    };

    // Build Steam OpenID 2.0 redirect URL.
    // Use 127.0.0.1 explicitly — on Windows 11 "localhost" resolves to ::1 (IPv6)
    // but our TcpListener is bound to 127.0.0.1 (IPv4), so the callback would fail.
    let return_to = format!("http://127.0.0.1:{}/callback", port);
    let realm = format!("http://127.0.0.1:{}", port);
    let steam_openid_url = format!(
        "https://steamcommunity.com/openid/login?\
        openid.ns={ns}&\
        openid.mode=checkid_setup&\
        openid.return_to={rt}&\
        openid.realm={realm}&\
        openid.identity={id}&\
        openid.claimed_id={cid}",
        ns = urlencoding::encode("http://specs.openid.net/auth/2.0"),
        rt = urlencoding::encode(&return_to),
        realm = urlencoding::encode(&realm),
        id = urlencoding::encode("http://specs.openid.net/auth/2.0/identifier_select"),
        cid = urlencoding::encode("http://specs.openid.net/auth/2.0/identifier_select"),
    );

    // Open the Steam OpenID login page in the default browser.
    // Use PowerShell Start-Process on Windows: cmd.exe misinterprets '&' in the
    // query string as a command separator, and explorer.exe ignores HTTP URLs
    // and opens File Explorer instead. PowerShell handles URLs correctly and
    // the single-quoted argument prevents any shell metacharacter expansion.
    // The OpenID URL only contains URL-safe chars so no single-quote escaping needed.
    #[cfg(target_os = "windows")]
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &format!("Start-Process '{}'", steam_openid_url),
        ])
        .spawn()
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&steam_openid_url)
        .spawn()
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&steam_openid_url)
        .spawn()
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    // Shared HTTP client — reused for OpenID verification and Steam profile lookup
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Success page returned to the browser tab after Steam redirects back
    let success_html = concat!(
        "<!DOCTYPE html><html><head><title>Launch Deck</title>",
        "<style>*{margin:0;padding:0;box-sizing:border-box}",
        "body{background:#0a0e17;color:#e8ecf4;font-family:'Segoe UI',sans-serif;",
        "display:flex;align-items:center;justify-content:center;height:100vh}",
        ".card{background:#111827;border-radius:16px;padding:40px 48px;text-align:center;",
        "box-shadow:8px 8px 20px #060a12,-4px -4px 12px #1e2a42;max-width:380px}",
        ".icon{font-size:48px;margin-bottom:16px}",
        ".title{font-size:20px;font-weight:700;color:#00d4ff;margin-bottom:8px}",
        ".sub{color:#8b99b2;font-size:13px}</style></head>",
        "<body><div class='card'>",
        "<div class='icon'>&#10003;</div>",
        "<p class='title'>Steam Account Connected!</p>",
        "<p class='sub'>You can close this window and return to Launch Deck.</p>",
        "</div><script>setTimeout(()=>window.close(),3000)</script>",
        "</body></html>"
    );
    let success_response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        success_html.len(),
        success_html
    );

    // Wait up to 120 s for Steam's callback; skip favicon / preflight noise
    let verify_result = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                continue;
            };
            let mut buf = vec![0u8; 8192];
            let Ok(n) = stream.read(&mut buf).await else {
                continue;
            };
            if n == 0 {
                continue;
            }
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let first_line = request.lines().next().unwrap_or("");

            if first_line.contains("/callback") && first_line.contains("openid") {
                // Respond to the browser immediately so the success page appears
                stream.write_all(success_response.as_bytes()).await.ok();
                drop(stream);

                // Verify the assertion with Steam before trusting the SteamID
                if let Some(query) = extract_query_string(&request) {
                    return verify_openid_assertion(&client, &query).await;
                }
                return Err("Steam callback did not contain a valid query string.".to_string());
            } else {
                // Silence favicon / other browser-initiated requests
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .ok();
            }
        }
    })
    .await;

    let steam_id = match verify_result {
        Err(_elapsed) => return Err("Steam login timed out (120 s). Please try again.".to_string()),
        Ok(inner) => inner?,
    };

    // Fetch the Steam profile (persona name + avatar) when an API key is available
    if !steam_key.trim().is_empty() {
        let url = format!(
            "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key={}&steamids={}",
            steam_key.trim(),
            steam_id
        );
        if let Ok(res) = client.get(&url).send().await {
            if let Ok(data) = res.json::<SteamProfileResponse>().await {
                if let Some(player) = data.response.players.into_iter().next() {
                    return Ok(SteamConnectResult {
                        steam_id,
                        persona_name: player.personaname,
                        avatar_url: player.avatarfull,
                    });
                }
            }
        }
    }

    // Return without profile info when no API key is configured
    Ok(SteamConnectResult {
        steam_id,
        persona_name: String::new(),
        avatar_url: String::new(),
    })
}

// ── Steam Achievements ────────────────────────────────────────────────────────

// RAWG game-detail response (only the stores field is needed)
#[derive(Deserialize)]
struct RawgGameDetailStores {
    stores: Option<Vec<RawgStoreEntry>>,
}

#[derive(Deserialize)]
struct RawgStoreEntry {
    url: String,
    store: RawgStoreInfo,
}

#[derive(Deserialize)]
struct RawgStoreInfo {
    slug: String,
}

// Steam Store search (storesearch API — no key required)
#[derive(Deserialize)]
struct SteamStoreSearchResponse {
    items: Option<Vec<SteamStoreItem>>,
}

#[derive(Deserialize)]
struct SteamStoreItem {
    id: u32,
    name: String,
}

// SteamGridDB full game-detail (for external platform mapping)
#[derive(Deserialize)]
struct SgdGameDetailResponse {
    success: bool,
    data: Option<SgdGameDetailData>,
}

#[derive(Deserialize)]
struct SgdGameDetailData {
    external_platform_data: Option<Vec<SgdExternalPlatform>>,
}

#[derive(Deserialize)]
struct SgdExternalPlatform {
    uid: String,
    name: String,
}

// Steam ISteamUserStats/GetPlayerAchievements/v1
#[derive(Deserialize)]
struct SteamAchievementsResponse {
    playerstats: SteamPlayerStats,
}

#[derive(Deserialize)]
struct SteamPlayerStats {
    success: Option<bool>,
    error: Option<String>,
    achievements: Option<Vec<SteamPlayerAchievement>>,
}

#[derive(Deserialize)]
struct SteamPlayerAchievement {
    apiname: String,
    achieved: u32,
    unlocktime: u64,
}

// Steam ISteamUserStats/GetSchemaForGame/v2
#[derive(Deserialize)]
struct SteamSchemaResponse {
    game: SteamSchemaGame,
}

#[derive(Deserialize)]
struct SteamSchemaGame {
    #[serde(rename = "availableGameStats")]
    available_game_stats: Option<SteamGameStats>,
}

#[derive(Deserialize)]
struct SteamGameStats {
    achievements: Option<Vec<SteamSchemaAchievement>>,
}

#[derive(Deserialize)]
struct SteamSchemaAchievement {
    name: String,
    #[serde(rename = "displayName")]
    display_name: String,
    description: Option<String>,
    icon: String,
    icongray: String,
}

// Return types sent to the frontend
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AchievementsResult {
    available: bool,
    reason: Option<String>,
    progress: Option<AchievementProgress>,
    achievements: Option<Vec<AchievementItem>>,
}

#[derive(Serialize)]
struct AchievementProgress {
    unlocked: u32,
    total: u32,
    percentage: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AchievementItem {
    id: String,
    name: String,
    description: String,
    icon: String,
    unlocked: bool,
    unlock_time: Option<u64>,
}

/// Extract Steam AppID by trying Steam Store search first, then SteamGridDB, then RAWG.
async fn resolve_steam_appid(
    client: &reqwest::Client,
    query: &str,
    rawg_key: &str,
    sgd_key: &str,
) -> Option<u32> {
    // Strip trailing year suffixes like "(2018)", edition tags, etc.
    let clean = {
        let t = query.trim();
        if let Some(idx) = t.rfind('(') {
            let suffix = &t[idx..];
            if suffix.len() >= 5
                && suffix.ends_with(')')
                && suffix[1..suffix.len() - 1]
                    .trim()
                    .chars()
                    .all(|c| c.is_ascii_digit())
            {
                t[..idx].trim()
            } else {
                t
            }
        } else {
            t
        }
    };
    let encoded = clean.replace(' ', "%20");

    // ── Primary: Steam Store search (no API key needed) ──────────────────────
    let steam_search_url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
        encoded
    );
    if let Ok(res) = client
        .get(&steam_search_url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
    {
        if let Ok(data) = res.json::<SteamStoreSearchResponse>().await {
            let items = data.items.unwrap_or_default();
            // Try exact name match first, then fall back to first result
            let query_lower = query.to_lowercase();
            let best = items
                .iter()
                .find(|i| i.name.to_lowercase() == query_lower)
                .or_else(|| items.first());
            if let Some(item) = best {
                return Some(item.id);
            }
        }
    }

    // ── Secondary: SteamGridDB ───────────────────────────────────────────────
    let sgd_search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        encoded
    );
    if let Ok(res) = client
        .get(&sgd_search_url)
        .header("Authorization", format!("Bearer {}", sgd_key))
        .send()
        .await
    {
        if let Ok(data) = res.json::<SgdSearchResponse>().await {
            if data.success && !data.data.is_empty() {
                let sgd_id = data.data[0].id;
                // Fetch full game detail to get external platform data
                let detail_url = format!("https://www.steamgriddb.com/api/v2/games/id/{}", sgd_id);
                if let Ok(detail_res) = client
                    .get(&detail_url)
                    .header("Authorization", format!("Bearer {}", sgd_key))
                    .send()
                    .await
                {
                    if let Ok(detail) = detail_res.json::<SgdGameDetailResponse>().await {
                        if detail.success {
                            if let Some(game_data) = detail.data {
                                if let Some(platforms) = game_data.external_platform_data {
                                    for p in &platforms {
                                        if p.name == "steam" {
                                            if let Ok(appid) = p.uid.parse::<u32>() {
                                                return Some(appid);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Tertiary: RAWG stores ────────────────────────────────────────────────
    let rawg_search_url = format!(
        "https://api.rawg.io/api/games?search={}&key={}&page_size=1",
        encoded, rawg_key
    );
    if let Ok(res) = client.get(&rawg_search_url).send().await {
        if let Ok(data) = res.json::<RawgResponse>().await {
            if let Some(game) = data.results.into_iter().next() {
                let detail_url =
                    format!("https://api.rawg.io/api/games/{}?key={}", game.id, rawg_key);
                if let Ok(detail_res) = client.get(&detail_url).send().await {
                    if let Ok(detail) = detail_res.json::<RawgGameDetailStores>().await {
                        for store in detail.stores.unwrap_or_default() {
                            if store.store.slug == "steam" {
                                // URL format: https://store.steampowered.com/app/{id}/...
                                let parts: Vec<&str> = store.url.split('/').collect();
                                if let Some(pos) = parts.iter().position(|&s| s == "app") {
                                    if let Some(id_str) = parts.get(pos + 1) {
                                        if let Ok(appid) = id_str.parse::<u32>() {
                                            return Some(appid);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
async fn get_steam_achievements(
    query: String,
    steam_id: String,
) -> Result<AchievementsResult, String> {
    dotenv().ok();

    let unavailable = |reason: &str| AchievementsResult {
        available: false,
        reason: Some(reason.to_string()),
        progress: None,
        achievements: None,
    };

    let steam_key = get_env("STEAM_API_KEY").unwrap_or_default();
    if steam_key.trim().is_empty() {
        return Ok(unavailable(
            "Steam API key not configured. Add STEAM_API_KEY to .env",
        ));
    }
    if steam_id.trim().is_empty() {
        return Ok(unavailable("No Steam ID provided"));
    }

    let rawg_key =
        get_env("VITE_RAWG_API_KEY").map_err(|_| "VITE_RAWG_API_KEY not set".to_string())?;
    let sgd_key =
        get_env("VITE_SGD_API_KEY").map_err(|_| "VITE_SGD_API_KEY not set".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Step 1 – resolve Steam AppID
    let appid = match resolve_steam_appid(&client, &query, &rawg_key, &sgd_key).await {
        Some(id) => id,
        None => return Ok(unavailable("No Steam AppID found for this game")),
    };

    // Step 2 – fetch player achievements
    let player_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?appid={}&key={}&steamid={}",
        appid, steam_key, steam_id.trim()
    );

    let player_stats = match client.get(&player_url).send().await {
        Ok(res) => match res.json::<SteamAchievementsResponse>().await {
            Ok(body) => body.playerstats,
            Err(_) => return Ok(unavailable("Could not parse Steam achievements response")),
        },
        Err(_) => return Ok(unavailable("Failed to reach Steam API")),
    };

    // Private profile or game has no stats
    if player_stats.success == Some(false) {
        let reason = player_stats
            .error
            .unwrap_or_else(|| "Steam profile is private or game has no achievements".to_string());
        return Ok(unavailable(&reason));
    }

    let player_achievements = player_stats.achievements.unwrap_or_default();
    if player_achievements.is_empty() {
        return Ok(unavailable("This game has no achievements"));
    }

    // Step 3 – fetch achievement schema (display names, icons)
    let schema_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?appid={}&key={}",
        appid, steam_key
    );

    let schema_map: std::collections::HashMap<String, SteamSchemaAchievement> =
        match client.get(&schema_url).send().await {
            Ok(res) => match res.json::<SteamSchemaResponse>().await {
                Ok(body) => body
                    .game
                    .available_game_stats
                    .and_then(|s| s.achievements)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|a| (a.name.clone(), a))
                    .collect(),
                Err(_) => std::collections::HashMap::new(),
            },
            Err(_) => std::collections::HashMap::new(),
        };

    // Step 4 – merge player data + schema
    let unlocked_count = player_achievements
        .iter()
        .filter(|a| a.achieved == 1)
        .count() as u32;
    let total = player_achievements.len() as u32;
    let percentage = (unlocked_count as f32 / total as f32) * 100.0;

    let mut achievements: Vec<AchievementItem> = player_achievements
        .into_iter()
        .map(|pa| {
            let schema = schema_map.get(&pa.apiname);
            let unlocked = pa.achieved == 1;
            AchievementItem {
                id: pa.apiname.clone(),
                name: schema
                    .map(|s| s.display_name.clone())
                    .unwrap_or_else(|| pa.apiname.clone()),
                description: schema
                    .and_then(|s| s.description.clone())
                    .unwrap_or_default(),
                icon: schema.map(|s| s.icon.clone()).unwrap_or_default(),
                unlocked,
                unlock_time: if unlocked && pa.unlocktime > 0 {
                    Some(pa.unlocktime)
                } else {
                    None
                },
            }
        })
        .collect();

    // Sort: unlocked first (newest first), then locked alphabetically
    achievements.sort_by(|a, b| match (a.unlocked, b.unlocked) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (true, true) => b.unlock_time.cmp(&a.unlock_time),
        (false, false) => a.name.cmp(&b.name),
    });

    Ok(AchievementsResult {
        available: true,
        reason: None,
        progress: Some(AchievementProgress {
            unlocked: unlocked_count,
            total,
            percentage,
        }),
        achievements: Some(achievements),
    })
}

// ── Steam Playtime ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SteamOwnedGamesResponse {
    response: SteamOwnedGamesData,
}

#[derive(Deserialize)]
struct SteamOwnedGamesData {
    games: Option<Vec<SteamOwnedGame>>,
}

#[derive(Deserialize)]
struct SteamOwnedGame {
    appid: u32,
    playtime_forever: u32,
    rtime_last_played: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SteamPlaytimeData {
    steam_playtime: u32,    // minutes
    last_played_steam: u64, // unix timestamp (seconds)
    app_id: u32,
}

/// Fetch Steam playtime for a game by title + Steam ID.
/// Resolves the Steam AppID internally via SteamGridDB/RAWG, then queries GetOwnedGames.
/// Returns None if the game isn't on Steam, the profile is private, or keys are missing.
#[tauri::command]
async fn get_steam_playtime(
    query: String,
    steam_id: String,
) -> Result<Option<SteamPlaytimeData>, String> {
    dotenv().ok();

    let steam_key = get_env("STEAM_API_KEY").unwrap_or_default();
    if steam_key.trim().is_empty() || steam_id.trim().is_empty() {
        return Ok(None);
    }

    let rawg_key = match get_env("VITE_RAWG_API_KEY") {
        Ok(k) if !k.trim().is_empty() => k,
        _ => return Ok(None),
    };
    let sgd_key = match get_env("VITE_SGD_API_KEY") {
        Ok(k) if !k.trim().is_empty() => k,
        _ => return Ok(None),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let app_id = match resolve_steam_appid(&client, &query, &rawg_key, &sgd_key).await {
        Some(id) => id,
        None => return Ok(None),
    };

    let url = format!(
        "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/\
         ?key={}&steamid={}&include_played_free_games=1&appids_filter[0]={}",
        steam_key.trim(),
        steam_id.trim(),
        app_id
    );

    if let Ok(res) = client.get(&url).send().await {
        if let Ok(data) = res.json::<SteamOwnedGamesResponse>().await {
            if let Some(games) = data.response.games {
                if let Some(game) = games.into_iter().next() {
                    return Ok(Some(SteamPlaytimeData {
                        steam_playtime: game.playtime_forever,
                        last_played_steam: game.rtime_last_played.unwrap_or(0),
                        app_id,
                    }));
                }
            }
        }
    }

    Ok(None)
}

// ── Steam Install ─────────────────────────────────────────────────────────────

/// Open the Steam install dialog for a game via the steam:// protocol.
#[tauri::command]
fn install_steam_game(app_id: u32) -> Result<(), String> {
    let url = format!("steam://install/{}", app_id);

    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd.exe")
        .args(["/c", "start", "", &url])
        .spawn()
        .map_err(|e| format!("Failed to open Steam install: {e}"))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open Steam install: {e}"))?;

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open Steam install: {e}"))?;

    Ok(())
}

#[tauri::command]
fn install_ubisoft_game(app_id: String) -> Result<(), String> {
    let launch_id = scanner::resolve_ubisoft_install_id(&app_id).unwrap_or(app_id);
    let url = format!("uplay://launch/{}/0", launch_id);
    open_url(url)
}

#[cfg(target_os = "windows")]
fn is_process_running(process_name: &str) -> bool {
    let trimmed = process_name.trim();
    if trimmed.is_empty() {
        return false;
    }

    let filter = format!("IMAGENAME eq {}", trimmed);
    let mut cmd = std::process::Command::new("tasklist");
    cmd.creation_flags(0x08000000);
    let output = cmd.args(["/FO", "CSV", "/NH", "/FI", &filter])
        .output();

    let Ok(output) = output else {
        return false;
    };

    if !output.status.success() {
        return false;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
    let needle = format!("\"{}\"", trimmed.to_lowercase());
    stdout.lines().any(|line| line.starts_with(&needle))
}

#[cfg(not(target_os = "windows"))]
fn is_process_running(process_name: &str) -> bool {
    let trimmed = process_name.trim();
    if trimmed.is_empty() {
        return false;
    }

    let process_name = trimmed.strip_suffix(".exe").unwrap_or(trimmed);
    std::process::Command::new("pgrep")
        .args(["-x", process_name])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Check whether a process with the given name is currently running.
/// Uses the same platform-specific helper as wait_for_processes.
#[tauri::command]
fn check_process_running(process_name: String) -> bool {
    is_process_running(&process_name)
}

#[tauri::command]
async fn wait_for_processes(process_names: Vec<String>, timeout_ms: Option<u64>) -> Result<bool, String> {
    let process_names: Vec<String> = process_names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();

    if process_names.is_empty() {
        return Ok(false);
    }

    let timeout_ms = timeout_ms.unwrap_or(8_000).clamp(250, 20_000);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let poll_interval = Duration::from_millis(350);

    loop {
        if process_names
            .iter()
            .any(|process_name| is_process_running(process_name))
        {
            return Ok(true);
        }

        if Instant::now() >= deadline {
            return Ok(false);
        }

        tokio::time::sleep(poll_interval).await;
    }
}

/// Open any URL in the system default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd.exe")
        .args(["/c", "start", "", &url])
        .spawn()
        .map_err(|e| format!("Failed to open URL: {e}"))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open URL: {e}"))?;

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open URL: {e}"))?;

    Ok(())
}

#[tauri::command]
fn open_in_file_manager(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No path provided".to_string());
    }

    let candidate = std::path::PathBuf::from(trimmed);
    let target = if candidate.is_dir() {
        candidate
    } else if let Some(parent) = candidate.parent() {
        parent.to_path_buf()
    } else {
        return Err("Could not resolve folder from path".to_string());
    };

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer.exe")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {e}"))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {e}"))?;

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {e}"))?;

    Ok(())
}

// ── Steam Owned Games ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SteamOwnedGamesWithInfoResponse {
    response: SteamOwnedGamesWithInfoData,
}

#[derive(Deserialize)]
struct SteamOwnedGamesWithInfoData {
    games: Option<Vec<SteamOwnedGameWithInfo>>,
}

#[derive(Deserialize)]
struct SteamOwnedGameWithInfo {
    appid: u32,
    name: String,
    playtime_forever: u32,
    rtime_last_played: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SteamOwnedGameResult {
    app_id: u32,
    name: String,
    playtime_minutes: u32,
    last_played: u64,
}

/// Fetch all games owned by the user on Steam (installed or not).
/// Requires STEAM_API_KEY in .env and a valid SteamID64.
#[tauri::command]
async fn get_steam_owned_games(steam_id: String) -> Result<Vec<SteamOwnedGameResult>, String> {
    dotenv().ok();

    let steam_key = get_env("STEAM_API_KEY").unwrap_or_default();
    if steam_key.trim().is_empty() || steam_id.trim().is_empty() {
        return Ok(vec![]);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let url = format!(
        "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/\
         ?key={}&steamid={}&include_appinfo=1&include_played_free_games=1",
        steam_key.trim(),
        steam_id.trim()
    );

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Steam API request failed: {e}"))?;

    let data: SteamOwnedGamesWithInfoResponse = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse Steam owned games response: {e}"))?;

    let games = data.response.games.unwrap_or_default();
    Ok(games
        .into_iter()
        .map(|g| SteamOwnedGameResult {
            app_id: g.appid,
            name: g.name,
            playtime_minutes: g.playtime_forever,
            last_played: g.rtime_last_played.unwrap_or(0),
        })
        .collect())
}

// ─── Web Image Search (DuckDuckGo) ───────────────────────────────────────────

/// Extract the VQD security token DDG embeds in its search page.
fn extract_vqd(html: &str) -> Option<String> {
    for pattern in &["vqd='", "vqd=\""] {
        if let Some(pos) = html.find(pattern) {
            let start = pos + pattern.len();
            let close = if pattern.ends_with('\'') { '\'' } else { '"' };
            if let Some(end) = html[start..].find(close) {
                let vqd = &html[start..start + end];
                if !vqd.is_empty() {
                    return Some(vqd.to_string());
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn search_web_images(query: String) -> Result<Vec<WebImageResult>, String> {
    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let encoded = urlencoding::encode(&query);

    // Step 1 — get the VQD token from the DDG search page
    let ddg_page = format!("https://duckduckgo.com/?q={}&iax=images&ia=images", encoded);
    let html = client
        .get(&ddg_page)
        .header("User-Agent", ua)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Search init failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Search init read failed: {}", e))?;

    let vqd = extract_vqd(&html)
        .ok_or_else(|| "Could not obtain search token — please try again".to_string())?;

    // Step 2 — fetch the image JSON
    let img_api = format!(
        "https://duckduckgo.com/i.js?q={}&o=json&p=1&s=0&u=bing&f=,,,,,&l=wt-wt&vqd={}",
        encoded,
        urlencoding::encode(&vqd)
    );
    let json_text = client
        .get(&img_api)
        .header("User-Agent", ua)
        .header("Referer", "https://duckduckgo.com/")
        .header("Accept", "application/json, */*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Image search request failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Image search read failed: {}", e))?;

    // Parse JSON: { "results": [{ "image": url, "width": w, "height": h, "source": s }, ...] }
    let data: serde_json::Value = serde_json::from_str(&json_text)
        .map_err(|_| "Failed to parse image results".to_string())?;

    let arr = data["results"]
        .as_array()
        .ok_or_else(|| "No image results returned".to_string())?;

    let results: Vec<WebImageResult> = arr
        .iter()
        .filter_map(|item| {
            let url = item["image"].as_str()?.to_string();
            if url.len() < 10 {
                return None;
            }
            let width = item["width"].as_u64().unwrap_or(0) as u32;
            let height = item["height"].as_u64().unwrap_or(0) as u32;
            let source = item["source"].as_str().unwrap_or("Web").to_string();
            Some(WebImageResult {
                url,
                width,
                height,
                source,
            })
        })
        .take(30)
        .collect();

    Ok(results)
}

// Deserializer that accepts either a JSON string or number and converts to String.
// Needed because some APIs (GOG) return user IDs as integers.
fn deserialize_string_or_int<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    use serde_json::Value;
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

// ── GOG OAuth2 ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GogProfile {
    user_id: String,
    username: String,
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
struct GogTokenResponse {
    access_token: String,
    refresh_token: String,
    // GOG may return user_id as a string or integer, or omit it
    #[serde(default, deserialize_with = "deserialize_string_or_int")]
    user_id: String,
}

#[derive(Deserialize)]
struct GogUserData {
    username: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GogTokensResult {
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GogProductsPage {
    total_pages: u32,
    products: Vec<GogProduct>,
}

#[derive(Deserialize)]
struct GogProduct {
    id: u64,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GogOwnedGame {
    app_id: u64,
    title: String,
}

fn truncate_error_snippet(value: &str, max_chars: usize) -> String {
    let mut snippet: String = value.chars().take(max_chars).collect();
    if value.chars().count() > max_chars {
        snippet.push_str("...");
    }
    snippet
}

async fn read_json_response_text(res: reqwest::Response, context: &str) -> Result<String, String> {
    let status = res.status();
    let body = res.text().await.map_err(|e| format!("{context}: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "{context} returned {}: {}",
            status,
            truncate_error_snippet(&body, 240)
        ));
    }

    Ok(body)
}

#[tauri::command]
async fn connect_gog(app: tauri::AppHandle) -> Result<GogProfile, String> {
    use std::time::Duration;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    // Close any stale auth window from a previous attempt
    if let Some(old) = app.get_webview_window("gog-auth") {
        old.close().ok();
    }

    // Use implicit flow: GOG returns the access token directly in the URL fragment
    // (#access_token=...&refresh_token=...&user_id=...) — no server-side code exchange needed,
    // no client credentials required, no CORS issues.
    let auth_url_str = concat!(
        "https://login.gog.com/auth",
        "?client_id=46899977096215655",
        "&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient",
        "&response_type=token",
        "&layout=client2"
    );
    let auth_url =
        tauri::Url::parse(auth_url_str).map_err(|e| format!("Invalid GOG auth URL: {e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<String, String>>(1);

    let app_for_nav = app.clone();
    let tx_for_nav = tx.clone();

    let _win = WebviewWindowBuilder::new(&app, "gog-auth", WebviewUrl::External(auth_url))
        .title("Connect GOG Account")
        .inner_size(500.0, 700.0)
        .on_navigation(move |url: &tauri::Url| {
            // Phase 2: JS read the fragment and forwarded the token data here
            if url.host_str() == Some("localhost") && url.path() == "/__gog__" {
                let at  = url.query_pairs().find(|(k,_)| k=="at" ).map(|(_,v)| v.into_owned()).unwrap_or_default();
                let rt  = url.query_pairs().find(|(k,_)| k=="rt" ).map(|(_,v)| v.into_owned()).unwrap_or_default();
                let uid = url.query_pairs().find(|(k,_)| k=="uid").map(|(_,v)| v.into_owned()).unwrap_or_default();
                tx_for_nav.try_send(if at.is_empty() {
                    Err("GOG did not return an access token.".to_string())
                } else {
                    Ok(serde_json::json!({"at": at, "rt": rt, "uid": uid}).to_string())
                }).ok();
                let app_close = app_for_nav.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if let Some(w) = app_close.get_webview_window("gog-auth") { w.close().ok(); }
                });
                return false;
            }

            if url.host_str() == Some("localhost") && url.path() == "/__gog_err__" {
                let msg = url.query_pairs().find(|(k,_)| k=="msg").map(|(_,v)| v.into_owned())
                    .unwrap_or_else(|| "Unknown error".to_string());
                tx_for_nav.try_send(Err(format!("GOG login failed: {msg}"))).ok();
                let app_close = app_for_nav.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if let Some(w) = app_close.get_webview_window("gog-auth") { w.close().ok(); }
                });
                return false;
            }

            // Phase 1: GOG redirects to on_login_success with the token in the URL fragment.
            // Allow navigation so the page loads, then eval JS to read window.location.hash
            // and forward the token data to our localhost signal URL.
            if url.host_str() == Some("embed.gog.com") && url.path().starts_with("/on_login_success") {
                let app_clone = app_for_nav.clone();
                let tx_clone  = tx_for_nav.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    if let Some(win) = app_clone.get_webview_window("gog-auth") {
                        let js = concat!(
                            "(function(){",
                            "var h=window.location.hash.slice(1);",
                            "if(!h){window.location.href='https://localhost/__gog_err__?msg=no_fragment';return;}",
                            "var p=new URLSearchParams(h);",
                            "var at=p.get('access_token');",
                            "if(!at){window.location.href='https://localhost/__gog_err__?msg='+encodeURIComponent('no token, hash='+h);return;}",
                            "var q=new URLSearchParams();",
                            "q.set('at',at);",
                            "q.set('rt',p.get('refresh_token')||'');",
                            "q.set('uid',p.get('user_id')||'');",
                            "window.location.href='https://localhost/__gog__?'+q.toString();",
                            "})()"
                        );
                        let _ = win.eval(js);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    tx_clone.try_send(Err("GOG login timed out reading token. Please try again.".to_string())).ok();
                });
                return true; // allow navigation so the fragment is set
            }

            true
        })
        .build()
        .map_err(|e| format!("Failed to open GOG login: {e}"))?;

    let result = tokio::time::timeout(Duration::from_secs(120), rx.recv())
        .await
        .map_err(|_| "GOG login timed out (120 s). Please try again.".to_string())?
        .ok_or_else(|| "GOG login was cancelled.".to_string())?;
    let payload = result?;

    let v: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|e| format!("Failed to parse GOG token payload: {e}"))?;
    let access_token = v["at"].as_str().unwrap_or("").to_string();
    let refresh_token = v["rt"].as_str().unwrap_or("").to_string();
    let user_id = v["uid"].as_str().unwrap_or("").to_string();

    // Fetch the GOG username with the access token (standard Bearer auth, no CORS issue)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let user_data: GogUserData = client
        .get("https://embed.gog.com/userData.json")
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch GOG profile: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse GOG profile: {e}"))?;

    Ok(GogProfile {
        user_id,
        username: user_data.username,
        access_token,
        refresh_token,
    })
}

#[tauri::command]
async fn refresh_gog_token(refresh_token: String) -> Result<GogTokensResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let refresh_url = format!(
        "https://auth.gog.com/token\
         ?client_id=46899977096215655\
         &client_secret=9203d324-9e2c-4571-952d-5b116cd0a9a6\
         &grant_type=refresh_token\
         &refresh_token={}",
        urlencoding::encode(&refresh_token)
    );

    let res = client
        .get(&refresh_url)
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|e| format!("GOG token refresh failed: {e}"))?;

    let body = read_json_response_text(res, "GOG token refresh failed").await?;
    let tokens: GogTokenResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "Failed to parse GOG refresh response: {e}. Response snippet: {}",
            truncate_error_snippet(&body, 240)
        )
    })?;

    Ok(GogTokensResult {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

#[tauri::command]
async fn get_gog_owned_games(access_token: String) -> Result<Vec<GogOwnedGame>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut all_games: Vec<GogOwnedGame> = Vec::new();
    let mut page = 1u32;
    let mut total_pages = 1u32;

    while page <= total_pages {
        let url = format!(
            "https://embed.gog.com/account/getFilteredProducts?mediaType=1&page={}",
            page
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity")
            .send()
            .await
            .map_err(|e| format!("GOG library request failed (page {page}): {e}"))?;

        let body =
            read_json_response_text(res, &format!("GOG library request failed (page {page})"))
                .await?;
        let data: GogProductsPage = serde_json::from_str(&body).map_err(|e| {
            format!(
                "Failed to parse GOG library page {page}: {e}. Response snippet: {}",
                truncate_error_snippet(&body, 240)
            )
        })?;

        if page == 1 {
            total_pages = data.total_pages;
        }

        for product in data.products {
            all_games.push(GogOwnedGame {
                app_id: product.id,
                title: product.title,
            });
        }

        page += 1;
    }

    Ok(all_games)
}

// ── Epic Games OAuth2 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpicProfile {
    account_id: String,
    display_name: String,
    access_token: String,
    refresh_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpicTokensResult {
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
struct EpicTokenResponse {
    access_token: String,
    refresh_token: String,
    account_id: String,
    // Epic's token response uses camelCase for this field
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct EpicLibraryPage {
    records: Vec<EpicLibraryRecord>,
    #[serde(rename = "responseMetadata")]
    response_metadata: Option<EpicLibraryResponseMeta>,
}

#[derive(Deserialize)]
struct EpicLibraryRecord {
    #[serde(rename = "appName")]
    app_name: String,
    metadata: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct EpicLibraryResponseMeta {
    #[serde(rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpicOwnedGame {
    app_id: String,
    title: String,
}

/// Open an in-app Epic Games login window, intercept the api/redirect JSON body
/// via evaluate_script, extract the authorization code, exchange it for tokens.
/// Uses launcherAppClient2 credentials (publicly documented in EpicResearch community project).
#[tauri::command]
async fn connect_epic(app: tauri::AppHandle) -> Result<EpicProfile, String> {
    use std::time::Duration;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    const CLIENT_ID: &str = "34a02cf8f4414e29b15921876da36f9a";
    const CLIENT_SECRET: &str = "daafbccc737745039dffe53d94fc76cf";

    if let Some(old) = app.get_webview_window("epic-auth") {
        old.close().ok();
    }

    let redirect_path = format!(
        "https://www.epicgames.com/id/api/redirect?clientId={}&responseType=code",
        CLIENT_ID
    );
    let login_url_str = format!(
        "https://www.epicgames.com/id/login?redirectUrl={}",
        urlencoding::encode(&redirect_path)
    );
    let login_url =
        tauri::Url::parse(&login_url_str).map_err(|e| format!("Invalid Epic auth URL: {e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<String, String>>(1);

    let app_for_nav = app.clone();
    let tx_for_nav = tx.clone();

    let _win = WebviewWindowBuilder::new(&app, "epic-auth", WebviewUrl::External(login_url))
        .title("Connect Epic Games Account")
        .inner_size(520.0, 720.0)
        .on_navigation(move |url: &tauri::Url| {
            let href = url.as_str();

            // Phase 2: intercept the localhost redirect that carries the auth code.
            // Epic navigates to https://localhost/launcher/authorized?code=... after the
            // fetch() call below resolves — extract the code from query params.
            if (url.host_str() == Some("localhost") || url.host_str() == Some("127.0.0.1"))
                && url.path().contains("/launcher/authorized")
            {
                let code = url
                    .query_pairs()
                    .find(|(k, _)| k == "code")
                    .map(|(_, v)| v.into_owned());
                match code {
                    Some(c) => {
                        tx_for_nav.try_send(Ok(c)).ok();
                    }
                    None => {
                        tx_for_nav
                            .try_send(Err("Epic did not return an auth code.".to_string()))
                            .ok();
                    }
                }
                let app_close = app_for_nav.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if let Some(w) = app_close.get_webview_window("epic-auth") {
                        w.close().ok();
                    }
                });
                return false; // block navigation to localhost
            }

            // Phase 1: when the WebView lands on the api/redirect endpoint, use fetch()
            // (which runs inside the WebView and carries its session cookies) to re-request
            // the URL, parse the JSON, and navigate to redirectUrl — which is the localhost
            // URL above that Phase 2 will intercept.
            if href.contains("/id/api/redirect") && href.contains("responseType=code") {
                let app_clone = app_for_nav.clone();
                let tx_clone = tx_for_nav.clone();
                std::thread::spawn(move || {
                    // Small delay to let the page settle before eval
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if let Some(win) = app_clone.get_webview_window("epic-auth") {
                        let _ = win.eval(
                            "fetch(window.location.href)\
                                .then(function(r){return r.json();})\
                                .then(function(d){\
                                    if(d&&d.redirectUrl){window.location.href=d.redirectUrl;}\
                                })\
                                .catch(function(e){console.error('Epic fetch error',e);});",
                        );
                    }
                    // Safety: if Phase 2 never fires within 10 s, send failure
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    tx_clone
                        .try_send(Err(
                            "Failed to extract Epic auth code. Please try again.".to_string()
                        ))
                        .ok();
                });
            }

            true
        })
        .build()
        .map_err(|e| format!("Failed to open Epic login window: {e}"))?;

    let result = tokio::time::timeout(Duration::from_secs(120), rx.recv())
        .await
        .map_err(|_| "Epic login timed out (120 s). Please try again.".to_string())?
        .ok_or_else(|| "Epic login was cancelled.".to_string())?;
    let code = result?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let token_res = client
        .post("https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token")
        .basic_auth(CLIENT_ID, Some(CLIENT_SECRET))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=authorization_code&code={}",
            urlencoding::encode(&code)
        ))
        .send()
        .await
        .map_err(|e| format!("Epic token exchange failed: {e}"))?;

    let tokens: EpicTokenResponse = token_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse Epic token response: {e}"))?;

    let display_name = tokens
        .display_name
        .unwrap_or_else(|| tokens.account_id.clone());

    Ok(EpicProfile {
        account_id: tokens.account_id,
        display_name,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

#[tauri::command]
async fn refresh_epic_token(refresh_token: String) -> Result<EpicTokensResult, String> {
    const CLIENT_ID: &str = "34a02cf8f4414e29b15921876da36f9a";
    const CLIENT_SECRET: &str = "daafbccc737745039dffe53d94fc76cf";

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let token_res = client
        .post("https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token")
        .basic_auth(CLIENT_ID, Some(CLIENT_SECRET))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=refresh_token&refresh_token={}",
            urlencoding::encode(&refresh_token)
        ))
        .send()
        .await
        .map_err(|e| format!("Epic token refresh failed: {e}"))?;

    let body = read_json_response_text(token_res, "Epic token refresh failed").await?;
    let tokens: EpicTokenResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Epic refresh response: {e}"))?;

    Ok(EpicTokensResult {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// Fetch all games owned by the user via the Epic Games library service.
/// Requires a valid Epic access token obtained from connect_epic.
#[tauri::command]
async fn get_epic_owned_games(access_token: String) -> Result<Vec<EpicOwnedGame>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut all_games: Vec<EpicOwnedGame> = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        let url = match &cursor {
            None => "https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true".to_string(),
            Some(c) => format!(
                "https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true&cursor={}",
                urlencoding::encode(c)
            ),
        };

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity")
            .send()
            .await
            .map_err(|e| format!("Epic library request failed: {e}"))?;

        let body = read_json_response_text(res, "Epic library request failed").await?;
        let page: EpicLibraryPage = serde_json::from_str(&body).map_err(|e| {
            format!(
                "Failed to parse Epic library response: {e}. Response snippet: {}",
                truncate_error_snippet(&body, 240)
            )
        })?;

        for record in page.records {
            if record.app_name.is_empty() {
                continue;
            }
            let title = record
                .metadata
                .as_ref()
                .and_then(|m| m.get("title"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| record.app_name.clone());

            all_games.push(EpicOwnedGame {
                app_id: record.app_name,
                title,
            });
        }

        cursor = page
            .response_metadata
            .as_ref()
            .and_then(|m| m.next_cursor.clone());

        if cursor.is_none() {
            break;
        }
    }

    Ok(all_games)
}

// ── Ubisoft Connect OAuth ─────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UbisoftProfile {
    account_id: String,
    username: String,
    avatar_url: String,
    access_token: String,
    refresh_token: String,
    session_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UbisoftPlaytimeData {
    playtime_minutes: u32,
    last_played: Option<String>,
    app_id: String,
    space_id: String,
}

#[derive(Default)]
struct UbisoftCachedStats {
    playtime_minutes: Option<u32>,
    last_played: Option<String>,
}

#[derive(Clone)]
struct UbisoftSessionContext {
    access_token: String,
    session_id: String,
    account_id: Option<String>,
}

#[derive(Clone)]
struct CachedUbisoftSession {
    context: UbisoftSessionContext,
    cached_at_unix: u64,
}

#[derive(Clone)]
struct CachedUbisoftSessionFailure {
    error: String,
    cached_at_unix: u64,
}

#[derive(Default, Clone)]
struct UbisoftStoredAuth {
    access_token: Option<String>,
    refresh_token: Option<String>,
    session_id: Option<String>,
    account_id: Option<String>,
    genome_id: Option<String>,
}

const UBISOFT_CONNECT_APP_ID: &str = "f68a4bb5-608a-4ff2-8123-be8ef797e0a6";
const UBISOFT_FALLBACK_APP_ID: &str = "afb4b43c-f1f7-41b7-bcef-a635d8c83822";
const UBISOFT_PRODPAGE_APP_ID: &str = "d8524c7f-390b-40b9-8c5f-ca8d8476bee9";
const UBISOFT_WEB_APP_ID: &str = "314d4fef-e568-454a-ae06-43e3bece12a6";
const UBISOFT_LOCALE_CODE: &str = "en-US";
const UBISOFT_GRAPHQL_ENDPOINT: &str =
    "https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql";
const UBISOFT_SESSION_CACHE_TTL_SECONDS: u64 = 10 * 60;
const UBISOFT_SESSION_FAILURE_BACKOFF_SECONDS: u64 = 60;
const UBISOFT_GET_GAME_QUERY: &str = r#"
query GetGame($spaceId: String!, $shouldIncludeStatsFields: Boolean = true) {
  game(spaceId: $spaceId, platform: PC) {
    id
    spaceId
    name
    description
    lowBoxArtUrl
    backgroundUrl
    logoColorUrl
    logoFlatUrl
    lowThumbnailUrl
    avatarUrl
    releaseDate
    viewer {
      meta {
        id
        lastPlayedDate
        playTime @include(if: $shouldIncludeStatsFields)
        completionPercentage @include(if: $shouldIncludeStatsFields)
      }
    }
  }
}
"#;
const UBISOFT_GET_ACHIEVEMENTS_QUERY: &str = r#"
query GetAchievements($spaceId: String!, $productId: Int) {
  game(spaceId: $spaceId) {
    id
    viewer {
      meta {
        id
        achievements(productId: $productId) {
          totalCount
          completedCount
          nodes {
            id
            achievementId
            title
            description
            icon
            viewer {
              meta {
                id
                completionDate
                isCompleted
              }
            }
          }
        }
      }
    }
  }
}
"#;
const UBISOFT_GET_CLASSIC_CHALLENGES_QUERY: &str = r#"
query GetClassicChallenges($spaceId: String!) {
  game(spaceId: $spaceId) {
    id
    viewer {
      meta {
        id
        classicChallenges {
          totalCount
          totalXpCount
          completedCount
          xpEarnedCount
          nodes {
            id
            challengeId
            description
            name
            xpPrize
            targetCompletion
            icon
            viewer {
              meta {
                id
                completionDate
                isCompleted
                currentCompletion
              }
            }
          }
        }
      }
    }
  }
}
"#;

fn ubisoft_service_worker_cache_root() -> Option<std::path::PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let path = std::path::PathBuf::from(local_app_data)
        .join("Ubisoft Game Launcher")
        .join("cache")
        .join("http2")
        .join("Default")
        .join("Service Worker")
        .join("CacheStorage");
    path.exists().then_some(path)
}

fn extract_json_slice<'a>(raw: &'a str, start_idx: usize) -> Option<&'a str> {
    let bytes = raw.as_bytes();
    let mut idx = start_idx;

    while idx < bytes.len() && bytes[idx] != b'{' && bytes[idx] != b'[' {
        idx += 1;
    }
    if idx >= bytes.len() {
        return None;
    }

    let open = bytes[idx];
    let close = if open == b'{' { b'}' } else { b']' };
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;

    for end in idx..bytes.len() {
        let ch = bytes[end];
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == b'\\' {
                escaped = true;
            } else if ch == b'"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            b'"' => in_string = true,
            b'{' | b'[' if ch == open => depth += 1,
            b'}' | b']' if ch == close => {
                depth -= 1;
                if depth == 0 {
                    return raw.get(idx..=end);
                }
            }
            _ => {}
        }
    }

    None
}

fn read_ubisoft_cached_json(url_fragment: &str) -> Option<serde_json::Value> {
    let root = ubisoft_service_worker_cache_root()?;

    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }

        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let raw = String::from_utf8_lossy(&bytes);
        let Some(url_idx) = raw.find(url_fragment) else {
            continue;
        };
        let Some(json_slice) = extract_json_slice(&raw, url_idx + url_fragment.len()) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(json_slice) {
            return Some(value);
        }
    }

    None
}

fn as_non_empty_string(value: &serde_json::Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    } else if let Some(n) = value.as_u64() {
        return Some(n.to_string());
    }
    None
}

fn parse_u32_value(value: &serde_json::Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .or_else(|| {
            value
                .as_i64()
                .filter(|value| *value >= 0)
                .and_then(|value| u32::try_from(value).ok())
        })
        .or_else(|| {
            value
                .as_str()
                .and_then(|value| value.trim().parse::<u32>().ok())
        })
}

fn parse_i64_value(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| {
            value
                .as_str()
                .and_then(|value| value.trim().parse::<i64>().ok())
        })
}

fn ids_match(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

fn read_cached_ubisoft_playtime(space_id: &str, app_id: &str) -> UbisoftCachedStats {
    let mut stats = UbisoftCachedStats::default();
    let Some(payload) = read_ubisoft_cached_json("/v1/profiles/me/gamesplayed") else {
        return stats;
    };
    let Some(games) = payload
        .get("gamesPlayed")
        .or_else(|| payload.get("games"))
        .and_then(serde_json::Value::as_array)
    else {
        return stats;
    };

    for game in games {
        let game_space_id = game
            .get("spaceId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let applications = game
            .get("applications")
            .and_then(serde_json::Value::as_array)
            .or_else(|| game.get("platforms").and_then(serde_json::Value::as_array));
        let matching_application = applications.and_then(|applications| {
            applications.iter().find(|application| {
                application
                    .get("applicationId")
                    .or_else(|| application.get("appId"))
                    .and_then(serde_json::Value::as_str)
                    .map(|candidate| ids_match(candidate, app_id))
                    .unwrap_or(false)
            })
        });

        let space_matches = !space_id.trim().is_empty() && ids_match(game_space_id, space_id);
        if !space_matches && matching_application.is_none() {
            continue;
        }

        stats.playtime_minutes = game
            .get("playTime")
            .or_else(|| game.get("playtime"))
            .and_then(parse_u32_value)
            .map(|s| s / 60)
            .or_else(|| game.get("playTimeMinutes").and_then(parse_u32_value))
            .or_else(|| game.get("playedMinutes").and_then(parse_u32_value))
            .or_else(|| {
                matching_application
                    .and_then(|application| {
                        application
                            .get("playTime")
                            .or_else(|| application.get("playtime"))
                            .and_then(parse_u32_value)
                            .map(|s| s / 60)
                            .or_else(|| application.get("playTimeMinutes").and_then(parse_u32_value))
                            .or_else(|| application.get("playedMinutes").and_then(parse_u32_value))
                    })
            });

        stats.last_played = game
            .get("lastPlayed")
            .and_then(|last_played| last_played.get("updatedAt"))
            .and_then(as_non_empty_string)
            .or_else(|| {
                matching_application
                    .and_then(|application| application.get("lastPlayed"))
                    .and_then(|last_played| last_played.get("updatedAt"))
                    .and_then(as_non_empty_string)
            });

        break;
    }

    stats
}

fn find_cached_product_id_in_value(
    value: &serde_json::Value,
    space_id: &str,
    app_id: &str,
) -> Option<i64> {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|item| find_cached_product_id_in_value(item, space_id, app_id)),
        serde_json::Value::Object(map) => {
            let matches_space = map
                .get("spaceId")
                .and_then(serde_json::Value::as_str)
                .map(|candidate| ids_match(candidate, space_id))
                .unwrap_or(false);
            let app_field = map
                .get("applicationId")
                .or_else(|| map.get("appId"))
                .and_then(serde_json::Value::as_str);
            let matches_app = app_field
                .map(|candidate| ids_match(candidate, app_id))
                .unwrap_or(false);
            let app_is_unspecified = app_field.is_none();

            if matches_space && (matches_app || app_is_unspecified) {
                if let Some(product_id) = map.get("productId").and_then(parse_i64_value) {
                    return Some(product_id);
                }
            }

            map.values()
                .find_map(|item| find_cached_product_id_in_value(item, space_id, app_id))
        }
        _ => None,
    }
}

fn find_cached_ubisoft_product_id(space_id: &str, app_id: &str) -> Option<i64> {
    let root = ubisoft_service_worker_cache_root()?;

    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }

        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let raw = String::from_utf8_lossy(&bytes);
        if !raw.contains("public-ubiservices.ubi.com")
            || !raw.contains("productId")
            || !raw.contains(space_id)
        {
            continue;
        }

        let Some(url_idx) = raw.find("https://public-ubiservices.ubi.com") else {
            continue;
        };
        let Some(json_slice) = extract_json_slice(&raw, url_idx) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(json_slice) else {
            continue;
        };
        if let Some(product_id) = find_cached_product_id_in_value(&value, space_id, app_id) {
            return Some(product_id);
        }
    }

    None
}

fn first_graphql_error(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("errors")
        .and_then(serde_json::Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("message"))
        .and_then(as_non_empty_string)
}

fn find_json_string_deep(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, entry) in map {
                if keys.iter().any(|candidate| key.eq_ignore_ascii_case(candidate)) {
                    if let Some(value) = as_non_empty_string(entry) {
                        return Some(value);
                    }
                }
            }

            map.values()
                .find_map(|entry| find_json_string_deep(entry, keys))
        }
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|entry| find_json_string_deep(entry, keys)),
        _ => None,
    }
}

fn build_ubisoft_session_request_headers(
    request: reqwest::RequestBuilder,
    authorization_scheme: &str,
    ticket: &str,
    ubi_app_id: &str,
    genome_id: Option<&str>,
) -> reqwest::RequestBuilder {
    let auth_header = if is_jwt_token(ticket) {
        format!("Bearer {}", ticket.trim())
    } else {
        format!("{} t={}", authorization_scheme.trim(), ticket.trim())
    };
    let mut request = request
        .header("Authorization", auth_header)
        .header("Ubi-AppId", ubi_app_id)
        .header("Ubi-LocaleCode", UBISOFT_LOCALE_CODE)
        .header("Ubi-RequestedPlatformType", "uplay")
        .header("Accept", "application/json")
        .header("Content-Type", "application/json");

    if let Some(genome_id) = genome_id.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.header("GenomeId", genome_id);
    }

    request
}

fn current_unix_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn ubisoft_session_cache() -> &'static Mutex<HashMap<String, CachedUbisoftSession>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedUbisoftSession>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ubisoft_session_failure_cache() -> &'static Mutex<HashMap<String, CachedUbisoftSessionFailure>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedUbisoftSessionFailure>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ubisoft_session_creation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn build_ubisoft_session_cache_key(account_id: Option<&str>) -> String {
    account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("__default__")
        .to_ascii_lowercase()
}

fn launchdeck_webview_root() -> Option<std::path::PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let path = std::path::PathBuf::from(local_app_data)
        .join("com.launchdeck.app")
        .join("EBWebView")
        .join("Default");
    path.exists().then_some(path)
}

fn read_text_file_lossy(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn extract_token_like(value: &str) -> Option<String> {
    // Skip leading non-token characters (binary LevelDB headers, quotes, whitespace).
    // Ubisoft session tickets can start with any alphanumeric character (including digits
    // like '6', letters like 'A', etc.) and may contain '~' as a separator.
    let start_idx = value
        .char_indices()
        .find(|&(_, ch)| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .map(|(i, _)| i)?;

    let mut token = String::new();
    for ch in value[start_idx..].chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '=' | '~') {
            token.push(ch);
        } else if !token.is_empty() {
            break;
        }
    }

    (token.len() >= 80).then_some(token)
}

fn extract_uuid_like(value: &str) -> Option<String> {
    let mut candidate = String::new();
    for ch in value.chars() {
        if ch.is_ascii_hexdigit() || ch == '-' {
            candidate.push(ch);
            if candidate.len() >= 36 {
                break;
            }
        } else if !candidate.is_empty() {
            candidate.clear();
        }
    }

    (candidate.len() == 36).then_some(candidate.to_ascii_lowercase())
}

fn find_token_after_anchor(raw: &str, anchor: &str, window: usize) -> Option<String> {
    let idx = raw.find(anchor)?;
    let start = idx + anchor.len();
    let mut end = (start + window).min(raw.len());
    while end > start && !raw.is_char_boundary(end) {
        end -= 1;
    }
    extract_token_like(&raw[start..end])
}

fn find_uuid_after_anchor(raw: &str, anchor: &str, window: usize) -> Option<String> {
    let idx = raw.find(anchor)?;
    let start = idx + anchor.len();
    let mut end = (start + window).min(raw.len());
    while end > start && !raw.is_char_boundary(end) {
        end -= 1;
    }
    extract_uuid_like(&raw[start..end])
}

fn find_genome_id_in_launchdeck_storage() -> Option<String> {
    let root = launchdeck_webview_root()?;

    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }

        let Some(raw) = read_text_file_lossy(entry.path()) else {
            continue;
        };

        if let Some(genome_id) = find_uuid_after_anchor(&raw, "genomeId=", 64) {
            return Some(genome_id);
        }
    }

    None
}

fn read_launchdeck_cached_ubisoft_auth() -> UbisoftStoredAuth {
    let mut auth = UbisoftStoredAuth {
        genome_id: find_genome_id_in_launchdeck_storage(),
        ..UbisoftStoredAuth::default()
    };
    let Some(root) = launchdeck_webview_root().map(|path| path.join("Local Storage").join("leveldb")) else {
        return auth;
    };
    if !root.exists() {
        return auth;
    }

    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }

        let Some(raw) = read_text_file_lossy(entry.path()) else {
            continue;
        };

        if auth.access_token.is_none() {
            auth.access_token = find_token_after_anchor(&raw, "ubisoftAccessToken", 4096);
        }
        if auth.refresh_token.is_none() {
            auth.refresh_token = find_token_after_anchor(&raw, "rememberMeTicket", 8192);
        }
        if auth.session_id.is_none() {
            auth.session_id = find_uuid_after_anchor(&raw, "ubisoftSessionId", 256);
        }
        if auth.account_id.is_none() {
            auth.account_id = find_uuid_after_anchor(&raw, "ubisoftAccountId", 256);
        }

        if auth.access_token.is_some()
            && auth.refresh_token.is_some()
            && auth.session_id.is_some()
            && auth.account_id.is_some()
            && auth.genome_id.is_some()
        {
            break;
        }
    }

    auth
}

fn read_launcher_cached_ubisoft_auth() -> UbisoftStoredAuth {
    let mut auth = UbisoftStoredAuth::default();
    let Some(local_app_data) = std::env::var("LOCALAPPDATA").ok() else {
        return auth;
    };
    let root = std::path::PathBuf::from(local_app_data)
        .join("Ubisoft Game Launcher")
        .join("cache")
        .join("http2")
        .join("Default")
        .join("Local Storage")
        .join("leveldb");
    if !root.exists() {
        return auth;
    }

    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }

        let Some(raw) = read_text_file_lossy(entry.path()) else {
            continue;
        };

        if auth.session_id.is_none() {
            auth.session_id = find_uuid_after_anchor(&raw, "\"sessionId\":\"", 96)
                .or_else(|| find_uuid_after_anchor(&raw, "shellSessionId\":\"", 96));
        }
        if auth.account_id.is_none() {
            auth.account_id = find_uuid_after_anchor(&raw, "\"profileId\":\"", 96);
        }
        // Try to read the launcher's own session ticket — it auto-refreshes so this is fresher
        // than anything captured from our OAuth popup, which expires after a few hours.
        if auth.access_token.is_none() {
            // The LevelDB may contain the raw JSON: {"ticket":"Ubi_v1 t=...", ...}
            auth.access_token = find_token_after_anchor(&raw, "\"ticket\":\"", 4096)
                .filter(|t| t.len() >= 64 && !t.starts_with("twoFactorAuth"))
                .or_else(|| find_token_after_anchor(&raw, "Ubi_v1 t=", 4096)
                    .filter(|t| t.len() >= 64));
        }

        if auth.session_id.is_some() && auth.account_id.is_some() && auth.access_token.is_some() {
            break;
        }
    }

    if let Some(ref t) = auth.access_token {
        eprintln!(
            "[UBI] launcher LevelDB token found: prefix={:?} len={}",
            &t[..t.len().min(12)],
            t.len(),
        );
    } else {
        eprintln!("[UBI] launcher LevelDB token NOT found");
    }

    auth
}

fn resolve_stored_ubisoft_auth(
    access_token: Option<&str>,
    refresh_token: Option<&str>,
    session_id: Option<&str>,
    account_id: Option<&str>,
) -> UbisoftStoredAuth {
    let launchdeck_auth = read_launchdeck_cached_ubisoft_auth();
    let launcher_auth = read_launcher_cached_ubisoft_auth();

    // When the launcher has a fresh access_token, prefer it over our stored token
    // (the OAuth popup token expires after ~3h, the launcher auto-refreshes).
    let best_access_token = launcher_auth.access_token
        .or_else(|| access_token
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned))
        .or(launchdeck_auth.access_token.clone());

    // Session ID and account ID from launcher should also match the launcher's token
    let best_session_id = if best_access_token.is_some() && launcher_auth.session_id.is_some() {
        launcher_auth.session_id.clone()
    } else {
        session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or(launchdeck_auth.session_id.clone())
            .or(launcher_auth.session_id.clone())
    };

    let best_account_id = launcher_auth.account_id.clone()
        .or_else(|| account_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned))
        .or(launchdeck_auth.account_id.clone());

    UbisoftStoredAuth {
        access_token: best_access_token,
        refresh_token: refresh_token
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or(launchdeck_auth.refresh_token),
        session_id: best_session_id,
        account_id: best_account_id,
        genome_id: launchdeck_auth.genome_id,
    }
}

fn normalize_ubisoft_ticket(ticket: &str, authorization_scheme: &str) -> Option<String> {
    let trimmed = ticket.trim();
    if trimmed.is_empty() {
        return None;
    }

    // JWT tokens (eyJ...) must be returned as-is; they use Bearer scheme, not Ubi_v1
    if trimmed.starts_with("eyJ") {
        return Some(trimmed.to_string());
    }

    let preferred_keys = if authorization_scheme.eq_ignore_ascii_case("rm_v1") {
        &[
            "rememberMeTicket",
            "refreshToken",
            "refresh_token",
            "ticket",
            "sessionTicket",
        ][..]
    } else {
        &[
            "ticket",
            "accessToken",
            "access_token",
            "sessionTicket",
            "rememberMeTicket",
        ][..]
    };

    let candidate = if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(trimmed).is_ok()
    {
        let value = serde_json::from_str::<serde_json::Value>(trimmed).ok()?;
        find_json_string_deep(&value, preferred_keys)
            .or_else(|| {
                find_json_string_deep(
                    &value,
                    &[
                        "rememberMeTicket",
                        "ticket",
                        "accessToken",
                        "access_token",
                        "sessionTicket",
                        "refreshToken",
                        "refresh_token",
                    ],
                )
            })
            .unwrap_or_else(|| trimmed.to_string())
    } else {
        trimmed.to_string()
    };

    let normalized = candidate
        .strip_prefix("Ubi_v1 t=")
        .or_else(|| candidate.strip_prefix("rm_v1 t="))
        .or_else(|| candidate.strip_prefix("t="))
        .unwrap_or(candidate.as_str())
        .trim()
        .to_string();

    (!normalized.is_empty()).then_some(normalized)
}

/// Returns true if the given token looks like a JWT (base64url-encoded header `eyJ...`)
fn is_jwt_token(token: &str) -> bool {
    token.trim().starts_with("eyJ")
}

/// Build the correct Authorization header value for a given token.
/// JWTs require `Bearer <token>`; legacy Ubi tickets use `Ubi_v1 t=<ticket>`.
fn ubisoft_auth_header(token: &str) -> String {
    let t = token.trim();
    if is_jwt_token(t) {
        format!("Bearer {}", t)
    } else {
        format!("Ubi_v1 t={}", t)
    }
}

fn decode_base64_url_segment(segment: &str) -> Option<Vec<u8>> {
    let trimmed = segment.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut normalized = trimmed.replace('-', "+").replace('_', "/");
    while normalized.len() % 4 != 0 {
        normalized.push('=');
    }

    base64::engine::general_purpose::STANDARD
        .decode(normalized)
        .ok()
}

fn extract_ubisoft_session_id_from_ticket(ticket: &str) -> Option<String> {
    let normalized = normalize_ubisoft_ticket(ticket, "Ubi_v1")?;
    let first_segment = normalized.split('.').next().unwrap_or(normalized.as_str());
    let decoded = decode_base64_url_segment(first_segment)?;
    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    find_json_string_deep(&value, &["sid", "sessionId", "session_id"])
}

fn looks_like_ubisoft_session_ticket(ticket: &str) -> bool {
    let normalized = normalize_ubisoft_ticket(ticket, "Ubi_v1");
    let Some(ticket) = normalized.as_deref() else {
        return false;
    };

    if ticket.len() < 80 {
        return false;
    }

    true
}

async fn create_ubisoft_session(
    ticket: &str,
    authorization_scheme: &str,
    account_id: Option<&str>,
    genome_id: Option<&str>,
) -> Result<UbisoftSessionContext, String> {
    let Some(ticket) = normalize_ubisoft_ticket(ticket, authorization_scheme) else {
        return Err("Missing Ubisoft authentication ticket".to_string());
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let body = serde_json::json!({
        "rememberMe": false,
    });
    let account_id = account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let mut last_error = None;

    for ubi_app_id in [
        UBISOFT_CONNECT_APP_ID,
        UBISOFT_WEB_APP_ID,
        UBISOFT_PRODPAGE_APP_ID,
        UBISOFT_FALLBACK_APP_ID,
    ] {
        let response = build_ubisoft_session_request_headers(
            client.post("https://public-ubiservices.ubi.com/v3/profiles/sessions"),
            authorization_scheme,
            &ticket,
            ubi_app_id,
            genome_id,
        )
        .json(&body)
        .send()
        .await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(format!("Ubisoft session request failed: {error}"));
                continue;
            }
        };

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to read Ubisoft session response: {error}"))?;

        if !status.is_success() {
            last_error = Some(format!(
                "Ubisoft session request failed with status {}. Response snippet: {}",
                status,
                truncate_error_snippet(&body, 240)
            ));
            continue;
        }

        let payload: serde_json::Value = serde_json::from_str(&body).map_err(|error| {
            format!(
                "Failed to parse Ubisoft session response: {error}. Response snippet: {}",
                truncate_error_snippet(&body, 240)
            )
        })?;

        let resolved_access_token = find_json_string_deep(
            &payload,
            &["ticket", "accessToken", "access_token", "sessionTicket"],
        )
        .and_then(|t| normalize_ubisoft_ticket(&t, "Ubi_v1"))
        .unwrap_or_else(|| ticket.to_string());
        let resolved_session_id =
            find_json_string_deep(&payload, &["sessionId", "session_id"])
                .or_else(|| extract_ubisoft_session_id_from_ticket(&resolved_access_token));
        let resolved_account_id = account_id.clone().or_else(|| {
            find_json_string_deep(&payload, &["profileId", "userId", "accountId"])
        });

        if let Some(session_id) = resolved_session_id {
            return Ok(UbisoftSessionContext {
                access_token: resolved_access_token,
                session_id,
                account_id: resolved_account_id,
            });
        }

        last_error = Some("Ubisoft session response did not include a session ID".to_string());
    }

    Err(last_error.unwrap_or_else(|| "Could not create a Ubisoft session".to_string()))
}

async fn ensure_ubisoft_session(
    app: &tauri::AppHandle,
    access_token: Option<&str>,
    refresh_token: Option<&str>,
    session_id: Option<&str>,
    account_id: Option<&str>,
) -> Result<UbisoftSessionContext, String> {
    let stored_auth =
        resolve_stored_ubisoft_auth(access_token, refresh_token, session_id, account_id);
    let explicit_access_token = access_token
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let explicit_session_id = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let access_token = stored_auth.access_token.as_deref();
    let refresh_token = stored_auth.refresh_token.as_deref();
    let session_id = stored_auth.session_id.as_deref();
    let account_id = stored_auth.account_id.as_deref();
    let genome_id = stored_auth.genome_id.as_deref();
    let cache_key = build_ubisoft_session_cache_key(account_id);

    let cache = ubisoft_session_cache().lock().await;
    if let Some(cached) = cache.get(&cache_key) {
        let age = current_unix_timestamp().saturating_sub(cached.cached_at_unix);
        if age <= UBISOFT_SESSION_CACHE_TTL_SECONDS {
            return Ok(cached.context.clone());
        }
    }
    drop(cache);

    let _creation_guard = ubisoft_session_creation_lock().lock().await;

    let cache = ubisoft_session_cache().lock().await;
    if let Some(cached) = cache.get(&cache_key) {
        let age = current_unix_timestamp().saturating_sub(cached.cached_at_unix);
        if age <= UBISOFT_SESSION_CACHE_TTL_SECONDS {
            return Ok(cached.context.clone());
        }
    }
    drop(cache);

    let failure_cache = ubisoft_session_failure_cache().lock().await;
    if let Some(cached_failure) = failure_cache.get(&cache_key) {
        let age = current_unix_timestamp().saturating_sub(cached_failure.cached_at_unix);
        if age <= UBISOFT_SESSION_FAILURE_BACKOFF_SECONDS {
            return Err(cached_failure.error.clone());
        }
    }
    drop(failure_cache);

    eprintln!(
        "[UBI] ensure_ubisoft_session: has_refresh={} has_explicit_access={} has_explicit_session={} has_stored_access={} has_stored_session={}",
        refresh_token.is_some(),
        explicit_access_token.is_some(),
        explicit_session_id.is_some(),
        access_token.is_some(),
        session_id.is_some(),
    );
    if let Some(t) = access_token {
        eprintln!(
            "[UBI] stored access_token prefix={:?} len={} is_jwt={}",
            &t[..t.len().min(12)],
            t.len(),
            t.trim().starts_with("eyJ"),
        );
    }
    if let Some(t) = refresh_token {
        eprintln!(
            "[UBI] stored refresh_token prefix={:?} len={} is_jwt={}",
            &t[..t.len().min(12)],
            t.len(),
            t.trim().starts_with("eyJ"),
        );
    }
    // Re-bind for the rest of the function
    let access_token = stored_auth.access_token.as_deref();
    let refresh_token = stored_auth.refresh_token.as_deref();
    let session_id = stored_auth.session_id.as_deref();

    if let Some(refresh_token) = refresh_token {
        match create_ubisoft_session(refresh_token, "rm_v1", account_id, genome_id).await {
            Ok(context) => {
                eprintln!("[UBI] rm_v1 session upgrade succeeded");
                let mut cache = ubisoft_session_cache().lock().await;
                cache.insert(
                    cache_key.clone(),
                    CachedUbisoftSession {
                        context: context.clone(),
                        cached_at_unix: current_unix_timestamp(),
                    },
                );
                ubisoft_session_failure_cache()
                    .lock()
                    .await
                    .remove(&cache_key);
                return Ok(context);
            }
            Err(error) => {
                eprintln!("[UBI] rm_v1 session upgrade failed: {}", error);
                // Do not return early; fall back to the access token
            }
        }
    }

    // Try to exchange the stored Ubi_v1 ticket for a fresh game-platform session.
    // A web-login token is typically bound to the account-site app_id; calling
    // /v3/profiles/sessions with it + the game app_id issues a new ticket that the
    // game GraphQL endpoint accepts.  Stale/expired tickets yield a 401 here and
    // fall through to the direct path below.
    if let Some(access_token) = access_token.filter(|t| !is_jwt_token(t) && looks_like_ubisoft_session_ticket(t)) {
        eprintln!(
            "[UBI] attempting create_ubisoft_session with Ubi_v1 access_token: prefix={:?} len={}",
            &access_token[..access_token.len().min(12)],
            access_token.len(),
        );
        match create_ubisoft_session(access_token, "Ubi_v1", account_id, genome_id).await {
            Ok(context) => {
                eprintln!("[UBI] create_ubisoft_session with Ubi_v1 access_token succeeded");
                let mut cache = ubisoft_session_cache().lock().await;
                cache.insert(
                    cache_key.clone(),
                    CachedUbisoftSession {
                        context: context.clone(),
                        cached_at_unix: current_unix_timestamp(),
                    },
                );
                ubisoft_session_failure_cache()
                    .lock()
                    .await
                    .remove(&cache_key);
                return Ok(context);
            }
            Err(e) => {
                eprintln!("[UBI] create_ubisoft_session with Ubi_v1 failed: {e}");
            }
        }
    }

    // Fallback: use the stored session ticket + session_id directly.
    // Useful when the token was already issued for the game platform and doesn't
    // need an exchange (e.g. read from the launcher's LevelDB cache).
    // execute_ubisoft_graphql will detect INVALID_TICKET and attempt a silent refresh.
    if let (Some(access_token), Some(session_id)) = (access_token, session_id) {
        if looks_like_ubisoft_session_ticket(access_token) {
            eprintln!(
                "[UBI] using stored access_token+session_id directly: prefix={:?} len={}",
                &access_token[..access_token.len().min(12)],
                access_token.len(),
            );
            let context = UbisoftSessionContext {
                access_token: access_token.to_string(),
                session_id: session_id.to_string(),
                account_id: account_id.map(ToOwned::to_owned),
            };
            let mut cache = ubisoft_session_cache().lock().await;
            cache.insert(
                cache_key.clone(),
                CachedUbisoftSession {
                    context: context.clone(),
                    cached_at_unix: current_unix_timestamp(),
                },
            );
            ubisoft_session_failure_cache()
                .lock()
                .await
                .remove(&cache_key);
            return Ok(context);
        }
    }

    // For JWT/OAuth tokens (Bearer), attempt to exchange for a new Ubisoft session.
    if let Some(access_token) = access_token.filter(|t| is_jwt_token(t)) {
        eprintln!(
            "[UBI] attempting create_ubisoft_session with JWT access_token: prefix={:?} len={}",
            &access_token[..access_token.len().min(12)],
            access_token.len(),
        );
        if let Ok(context) =
            create_ubisoft_session(access_token, "Ubi_v1", account_id, genome_id).await
        {
            eprintln!("[UBI] create_ubisoft_session with JWT access_token succeeded");
            let mut cache = ubisoft_session_cache().lock().await;
            cache.insert(
                cache_key.clone(),
                CachedUbisoftSession {
                    context: context.clone(),
                    cached_at_unix: current_unix_timestamp(),
                },
            );
            ubisoft_session_failure_cache()
                .lock()
                .await
                .remove(&cache_key);
            return Ok(context);
        }
    }

    // FINAL FALLBACK: If tokens are stale, missing, or rm_v1 failed, attempt a silent background
    // webview refresh if the user has a valid "Remember Me" cookie in their webview session.
    eprintln!("[UBI] all direct token checks failed. Attempting silent webview refresh...");
    if let Ok(context) = refresh_ubisoft_session_silently(app).await {
        let mut cache = ubisoft_session_cache().lock().await;
        cache.insert(
            cache_key.clone(),
            CachedUbisoftSession {
                context: context.clone(),
                cached_at_unix: current_unix_timestamp(),
            },
        );
        ubisoft_session_failure_cache().lock().await.remove(&cache_key);
        return Ok(context);
    }

    let error = "Connect your Ubisoft account in Settings to sync Ubisoft data".to_string();
    ubisoft_session_failure_cache().lock().await.insert(
        cache_key,
        CachedUbisoftSessionFailure {
            error: error.clone(),
            cached_at_unix: current_unix_timestamp(),
        },
    );
    Err(error)
}

async fn fetch_ubisoft_graphql(
    access_token: &str,
    session_id: &str,
    account_id: Option<&str>,
    query: &str,
    variables: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let body = serde_json::json!({
        "query": query,
        "variables": variables,
    });

    let mut last_error = None;

    let account_id = account_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let auth_hdr = ubisoft_auth_header(access_token);
    eprintln!(
        "[UBI] fetch_ubisoft_graphql: auth_header_scheme={:?} session_id_len={} account_id={:?}",
        if auth_hdr.starts_with("Bearer") { "Bearer" } else { "Ubi_v1" },
        session_id.trim().len(),
        account_id,
    );

    for ubi_app_id in [
        UBISOFT_CONNECT_APP_ID,
        UBISOFT_WEB_APP_ID,
        UBISOFT_PRODPAGE_APP_ID,
        UBISOFT_FALLBACK_APP_ID,
    ] {
        let mut request = client
            .post(UBISOFT_GRAPHQL_ENDPOINT)
            .header("Authorization", &auth_hdr)
            .header("Ubi-SessionId", session_id.trim())
            .header("Ubi-AppId", ubi_app_id)
            .header("Ubi-LocaleCode", UBISOFT_LOCALE_CODE)
            .header("Ubi-RequestedPlatformType", "uplay")
            .header("Accept", "application/json")
            .header("Content-Type", "application/json");

        if let Some(account_id) = account_id {
            request = request.header("Ubi-ProfileId", account_id);
        }

        let response = request.json(&body).send().await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(format!("Ubisoft GraphQL request failed: {error}"));
                continue;
            }
        };

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to read Ubisoft GraphQL response: {error}"))?;
        eprintln!("[UBI] graphql app_id={} status={} body_prefix={:?}", ubi_app_id, status, &body[..body.len().min(200)]);

        if !status.is_success() {
            last_error = Some(format!(
                "Ubisoft GraphQL request failed with status {}. Response snippet: {}",
                status,
                truncate_error_snippet(&body, 240)
            ));
            continue;
        }

        let payload: serde_json::Value = serde_json::from_str(&body).map_err(|error| {
            format!(
                "Failed to parse Ubisoft GraphQL response: {error}. Response snippet: {}",
                truncate_error_snippet(&body, 240)
            )
        })?;

        if payload
            .get("data")
            .map(|data| !data.is_null())
            .unwrap_or(false)
        {
            return Ok(payload);
        }

        last_error = Some(
            first_graphql_error(&payload)
                .unwrap_or_else(|| "Ubisoft GraphQL returned no data".to_string()),
        );
    }

    Err(last_error.unwrap_or_else(|| "Ubisoft GraphQL request failed".to_string()))
}

fn build_unavailable_achievements(reason: &str) -> AchievementsResult {
    AchievementsResult {
        available: false,
        reason: Some(reason.to_string()),
        progress: None,
        achievements: None,
    }
}

async fn execute_ubisoft_graphql(
    app: &tauri::AppHandle,
    access_token: Option<&str>,
    refresh_token: Option<&str>,
    session_id: Option<&str>,
    account_id: Option<&str>,
    query: &str,
    variables: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session = ensure_ubisoft_session(app, access_token, refresh_token, session_id, account_id).await?;
    let active_account = session.account_id.as_deref().or(account_id);
    
    match fetch_ubisoft_graphql(&session.access_token, &session.session_id, active_account, query, variables.clone()).await {
        Ok(payload) => Ok(payload),
        Err(e) => {
            if e.contains("INVALID_TICKET") || e.to_lowercase().contains("invalid authorization header") || e.to_lowercase().contains("unauthorized") {
                eprintln!("[UBI] Token expired (INVALID_TICKET) during graphQL fetch. Attempting forced silent refresh...");
                
                let cache_key = build_ubisoft_session_cache_key(active_account);
                ubisoft_session_cache().lock().await.remove(&cache_key);
                
                if let Ok(new_session) = refresh_ubisoft_session_silently(app).await {
                    eprintln!("[UBI] Forced silent refresh succeeded, retrying graphql...");
                    ubisoft_session_cache().lock().await.insert(
                        cache_key.clone(),
                        CachedUbisoftSession {
                            context: new_session.clone(),
                            cached_at_unix: current_unix_timestamp(),
                        },
                    );

                    fetch_ubisoft_graphql(&new_session.access_token, &new_session.session_id, active_account, query, variables).await
                } else {
                    // All token refresh attempts exhausted.  Cache the failure so the next 60 s of
                    // parallel calls skip the expensive retry cycle and return promptly.
                    let friendly = "Connect your Ubisoft account in Settings to sync Ubisoft data".to_string();
                    ubisoft_session_failure_cache().lock().await.insert(
                        cache_key,
                        CachedUbisoftSessionFailure {
                            error: friendly.clone(),
                            cached_at_unix: current_unix_timestamp(),
                        },
                    );
                    Err(friendly)
                }
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
async fn get_ubisoft_playtime(
    app: tauri::AppHandle,
    app_id: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    session_id: Option<String>,
    account_id: Option<String>,
) -> Result<Option<UbisoftPlaytimeData>, String> {
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() {
        return Ok(None);
    }

    let space_id = scanner::resolve_ubisoft_space_id(&app_id).unwrap_or_default();
    let account_id = account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(resolve_cached_ubisoft_account_id);
    let cached = if space_id.is_empty() {
        UbisoftCachedStats::default()
    } else {
        read_cached_ubisoft_playtime(&space_id, &app_id)
    };

    let mut live = None;
    if !space_id.is_empty() {
        if let Ok(payload) = execute_ubisoft_graphql(
            &app,
            access_token.as_deref(),
            refresh_token.as_deref(),
            session_id.as_deref(),
            account_id.as_deref(),
            UBISOFT_GET_GAME_QUERY,
            serde_json::json!({
                "spaceId": space_id,
                "shouldIncludeStatsFields": true,
            }),
        )
        .await
        {
                let meta = payload
                    .get("data")
                    .and_then(|data| data.get("game"))
                    .and_then(|game| game.get("viewer"))
                    .and_then(|viewer| viewer.get("meta"));

                if let Some(meta) = meta {
                    let playtime_minutes = meta
                        .get("playTime")
                        .and_then(parse_u32_value)
                        .map(|seconds| seconds / 60)
                        .or(cached.playtime_minutes)
                        .unwrap_or(0);
                    let last_played = meta
                        .get("lastPlayedDate")
                        .and_then(as_non_empty_string)
                        .or_else(|| cached.last_played.clone());

                    if playtime_minutes > 0 || last_played.is_some() {
                        live = Some(UbisoftPlaytimeData {
                            playtime_minutes,
                            last_played,
                            app_id: app_id.clone(),
                            space_id: space_id.clone(),
                        });
                    }
                }
        }
    }
    if live.is_some() {
        return Ok(live);
    }

    if cached.playtime_minutes.is_some() || cached.last_played.is_some() {
        return Ok(Some(UbisoftPlaytimeData {
            playtime_minutes: cached.playtime_minutes.unwrap_or(0),
            last_played: cached.last_played,
            app_id,
            space_id,
        }));
    }

    Ok(None)
}

#[tauri::command]
async fn get_ubisoft_achievements(
    app: tauri::AppHandle,
    app_id: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    session_id: Option<String>,
    account_id: Option<String>,
) -> Result<AchievementsResult, String> {
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() {
        return Ok(build_unavailable_achievements("No Ubisoft App ID provided"));
    }

    let access_token = access_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let Some(space_id) = scanner::resolve_ubisoft_space_id(&app_id) else {
        return Ok(build_unavailable_achievements(
            "No Ubisoft space ID found for this game",
        ));
    };

    let account_id = account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(resolve_cached_ubisoft_account_id);
    let product_id = find_cached_ubisoft_product_id(&space_id, &app_id);
    let payload = match execute_ubisoft_graphql(
        &app,
        access_token.as_deref(),
        refresh_token.as_deref(),
        session_id.as_deref(),
        account_id.as_deref(),
        UBISOFT_GET_ACHIEVEMENTS_QUERY,
        serde_json::json!({
            "spaceId": space_id,
            "productId": product_id,
        }),
    )
    .await
    {
        Ok(payload) => payload,
        Err(error) => return Ok(build_unavailable_achievements(&error)),
    };

    let achievements = payload
        .get("data")
        .and_then(|data| data.get("game"))
        .and_then(|game| game.get("viewer"))
        .and_then(|viewer| viewer.get("meta"))
        .and_then(|meta| meta.get("achievements"));

    let Some(achievements) = achievements else {
        return Ok(build_unavailable_achievements(
            "Ubisoft achievements unavailable for this game",
        ));
    };

    let total = achievements
        .get("totalCount")
        .and_then(parse_u32_value)
        .unwrap_or(0);
    let completed = achievements
        .get("completedCount")
        .and_then(parse_u32_value)
        .unwrap_or(0);

    let mut items = achievements
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|node| {
                    let id = node
                        .get("achievementId")
                        .or_else(|| node.get("id"))
                        .and_then(as_non_empty_string)?;
                    let name = node
                        .get("title")
                        .or_else(|| node.get("name"))
                        .and_then(as_non_empty_string)
                        .unwrap_or_else(|| id.clone());
                    let description = node
                        .get("description")
                        .and_then(as_non_empty_string)
                        .unwrap_or_default();
                    let icon = node
                        .get("icon")
                        .and_then(as_non_empty_string)
                        .unwrap_or_default();
                    let unlocked = node
                        .get("viewer")
                        .and_then(|viewer| viewer.get("meta"))
                        .and_then(|meta| meta.get("isCompleted"))
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);

                    Some(AchievementItem {
                        id,
                        name,
                        description,
                        icon,
                        unlocked,
                        unlock_time: None,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if total == 0 && items.is_empty() {
        return Ok(build_unavailable_achievements(
            "This game has no Ubisoft achievements",
        ));
    }

    items.sort_by(|left, right| match (left.unlocked, right.unlocked) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => left.name.cmp(&right.name),
    });

    let resolved_total = total.max(completed);

    Ok(AchievementsResult {
        available: true,
        reason: None,
        progress: Some(AchievementProgress {
            unlocked: completed,
            total: resolved_total,
            percentage: if resolved_total > 0 {
                (completed as f32 / resolved_total as f32) * 100.0
            } else {
                0.0
            },
        }),
        achievements: Some(items),
    })
}

#[tauri::command]
async fn get_ubisoft_core_challenges(
    app: tauri::AppHandle,
    app_id: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    session_id: Option<String>,
    account_id: Option<String>,
) -> Result<AchievementsResult, String> {
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() {
        return Ok(build_unavailable_achievements("No Ubisoft App ID provided"));
    }

    let access_token = access_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let Some(space_id) = scanner::resolve_ubisoft_space_id(&app_id) else {
        return Ok(build_unavailable_achievements(
            "No Ubisoft space ID found for this game",
        ));
    };

    let account_id = account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(resolve_cached_ubisoft_account_id);
    let payload = match execute_ubisoft_graphql(
        &app,
        access_token.as_deref(),
        refresh_token.as_deref(),
        session_id.as_deref(),
        account_id.as_deref(),
        UBISOFT_GET_CLASSIC_CHALLENGES_QUERY,
        serde_json::json!({
            "spaceId": space_id,
        }),
    )
    .await
    {
        Ok(payload) => payload,
        Err(error) => return Ok(build_unavailable_achievements(&error)),
    };

    let classic_challenges = payload
        .get("data")
        .and_then(|data| data.get("game"))
        .and_then(|game| game.get("viewer"))
        .and_then(|viewer| viewer.get("meta"))
        .and_then(|meta| meta.get("classicChallenges"));

    let Some(classic_challenges) = classic_challenges else {
        return Ok(build_unavailable_achievements(
            "Ubisoft core challenges unavailable for this game",
        ));
    };

    let total = classic_challenges
        .get("totalCount")
        .and_then(parse_u32_value)
        .unwrap_or(0);
    let completed = classic_challenges
        .get("completedCount")
        .and_then(parse_u32_value)
        .unwrap_or(0);

    let mut items = classic_challenges
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|node| {
                    let id = node
                        .get("challengeId")
                        .or_else(|| node.get("id"))
                        .and_then(as_non_empty_string)?;
                    let name = node
                        .get("name")
                        .or_else(|| node.get("title"))
                        .and_then(as_non_empty_string)
                        .unwrap_or_else(|| id.clone());
                    let description = node
                        .get("description")
                        .and_then(as_non_empty_string)
                        .unwrap_or_default();
                    let icon = node
                        .get("icon")
                        .and_then(as_non_empty_string)
                        .unwrap_or_default();
                    let unlocked = node
                        .get("viewer")
                        .and_then(|viewer| viewer.get("meta"))
                        .and_then(|meta| meta.get("isCompleted"))
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);

                    Some(AchievementItem {
                        id,
                        name,
                        description,
                        icon,
                        unlocked,
                        unlock_time: None,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if total == 0 && items.is_empty() {
        return Ok(build_unavailable_achievements(
            "This game has no Ubisoft core challenges",
        ));
    }

    items.sort_by(|left, right| match (left.unlocked, right.unlocked) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => left.name.cmp(&right.name),
    });

    let resolved_total = total.max(completed);

    Ok(AchievementsResult {
        available: true,
        reason: None,
        progress: Some(AchievementProgress {
            unlocked: completed,
            total: resolved_total,
            percentage: if resolved_total > 0 {
                (completed as f32 / resolved_total as f32) * 100.0
            } else {
                0.0
            },
        }),
        achievements: Some(items),
    })
}

fn build_ubisoft_avatar_url(profile_id: &str) -> String {
    if profile_id.trim().is_empty() {
        return String::new();
    }
    format!(
        "https://ubisoft-avatars.akamaized.net/{}/default_256_256.png?appId={}",
        profile_id.trim(),
        UBISOFT_CONNECT_APP_ID
    )
}

fn ubisoft_ownership_dir() -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            std::path::PathBuf::from(local_app_data)
                .join("Ubisoft Game Launcher")
                .join("cache")
                .join("ownership"),
        );
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(
            std::path::PathBuf::from(program_files_x86)
                .join("Ubisoft")
                .join("Ubisoft Game Launcher")
                .join("cache")
                .join("ownership"),
        );
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(
            std::path::PathBuf::from(program_files)
                .join("Ubisoft")
                .join("Ubisoft Game Launcher")
                .join("cache")
                .join("ownership"),
        );
    }
    candidates.push(std::path::PathBuf::from(
        r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\cache\ownership",
    ));
    candidates.push(std::path::PathBuf::from(
        r"C:\Program Files\Ubisoft\Ubisoft Game Launcher\cache\ownership",
    ));

    candidates.into_iter().find(|path| path.exists())
}

fn resolve_cached_ubisoft_account_id() -> Option<String> {
    let dir = ubisoft_ownership_dir()?;
    let entries: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .collect();

    if entries.len() != 1 {
        return None;
    }

    entries[0]
        .file_name()
        .to_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
}

fn first_non_empty_json_str(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn apply_ubisoft_identity_from_value(
    value: &serde_json::Value,
    account_id: &mut String,
    username: &mut String,
) {
    if account_id.is_empty() {
        if let Some(id) =
            first_non_empty_json_str(value, &["profileId", "userId", "accountId", "id"])
        {
            *account_id = id;
        }
    }

    if username.is_empty() {
        if let Some(name) = first_non_empty_json_str(
            value,
            &["nameOnPlatform", "username", "displayName", "name"],
        ) {
            *username = name;
        }
    }
}

fn apply_ubisoft_identity_from_response(
    value: &serde_json::Value,
    account_id: &mut String,
    username: &mut String,
) {
    let profiles = value
        .get("profiles")
        .and_then(serde_json::Value::as_array)
        .or_else(|| value.as_array());

    if let Some(profiles) = profiles {
        let preferred = profiles
            .iter()
            .find(|profile| {
                profile
                    .get("platformType")
                    .and_then(serde_json::Value::as_str)
                    .map(|platform| {
                        let lower = platform.to_ascii_lowercase();
                        lower == "uplay" || lower == "ubisoft" || lower == "pc"
                    })
                    .unwrap_or(false)
            })
            .or_else(|| profiles.first());

        if let Some(profile) = preferred {
            apply_ubisoft_identity_from_value(profile, account_id, username);
        }
    }

    apply_ubisoft_identity_from_value(value, account_id, username);
}

/// Open the Ubisoft account login page in a webview.
/// An initialization script intercepts all localStorage writes and XHR/fetch responses
/// before any page JS runs, capturing the auth ticket the instant Ubisoft's page receives it —
/// regardless of whether the user was already logged in or logs in fresh.
async fn refresh_ubisoft_session_silently(app: &tauri::AppHandle) -> Result<UbisoftSessionContext, String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    // Spin up an invisible window mapped to the Ubisoft login page.
    let auth_url = tauri::Url::parse(&format!(
        "https://account.ubisoft.com/en-US/login?appId={}",
        urlencoding::encode(UBISOFT_CONNECT_APP_ID)
    )).map_err(|e| format!("Invalid URL: {e}"))?;

    let init_script = r#"
(function(){
  if(window.__ubi_hooked__)return;
  window.__ubi_hooked__=true;
  var pendingToken='';
  var pendingSessionId='';
  var flushTimer=0;

  function extractTicket(value){
    if(typeof value!=='string'||!value)return '';
    var normalized=String(value).trim();
    var m=normalized.match(/(?:^|\s)(?:Ubi_v1|ubi_v1|rm_v1)\s+t=([^\s"',;]+)/i);
    if(m)return m[1];
    if(normalized.length>40 && normalized.indexOf(' ')===-1 && normalized.indexOf('eyJ')===0)return normalized;
    return '';
  }

  function trySessionPayload(text){
    if(!text)return;
    try{
      var j=JSON.parse(text);
      // Only capture a proper session response (ticket + sessionId)
      var ticket=extractTicket(j.ticket||j.sessionTicket||j.accessToken||j.access_token||'');
      if(ticket&&ticket.length>32){
        if(!pendingToken||ticket.startsWith('eyJ'))pendingToken=ticket;
      }
      if(j.sessionId&&!pendingSessionId)pendingSessionId=j.sessionId;
    }catch(e){}
    if(pendingToken&&pendingSessionId){
      if(!flushTimer){
        flushTimer=setTimeout(function(){
          var xhr=new XMLHttpRequest();
          xhr.open('POST','http://127.0.0.1:__UBI_PORT__/__ubi__?token='+encodeURIComponent(pendingToken)+'&sessionId='+encodeURIComponent(pendingSessionId),true);
          xhr.send();
        },300);
      }
    }
  }

  // Hook XHR (track URL and inspect sessions responses)
  if(typeof XMLHttpRequest!=='undefined'&&XMLHttpRequest.prototype){
    var _open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url){
      try{this.__ubi_url__=url||'';}catch(e){}
      return _open.apply(this,arguments);
    };
    var _send=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send=function(){
      this.addEventListener('load',function(){
        try{
          if(this.__ubi_url__&&this.__ubi_url__.indexOf('/v3/profiles/sessions')!==-1){
            trySessionPayload(this.responseText);
          }
        }catch(e){}
      },false);
      return _send.apply(this,arguments);
    };
  }

  // Hook fetch (modern Ubisoft pages use fetch, not XHR)
  if(typeof window.fetch==='function'){
    var _fetch=window.fetch;
    window.fetch=function(){
      return _fetch.apply(window,arguments).then(function(resp){
        try{
          if(resp&&resp.url&&resp.url.indexOf('/v3/profiles/sessions')!==-1){
            resp.clone().text().then(function(t){try{trySessionPayload(t);}catch(e){}});
          }
        }catch(e){}
        return resp;
      });
    };
  }

  // After page settles, explicitly trigger a cookie-based session refresh
  setTimeout(function(){
    if(pendingToken)return;
    var path=window.location.pathname||'';
    var isLogin=path.indexOf('/login')!==-1||path.indexOf('/register')!==-1||path.indexOf('/oauth')!==-1;
    if(!isLogin&&window.location.origin&&window.location.origin.indexOf('ubisoft.com')!==-1){
      fetch('https://public-ubiservices.ubi.com/v3/profiles/sessions',{
        method:'POST',
        credentials:'include',
        headers:{'Ubi-AppId':'__APP_ID__','Content-Type':'application/json','Ubi-RequestedPlatformType':'uplay','Accept':'application/json'},
        body:'{"rememberMe":true}'
      }).catch(function(){});
    }
  },1500);
})();
"#;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(_) => return Err("Failed to start callback server".to_string()),
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let init_script = init_script
        .replace("__UBI_PORT__", &port.to_string())
        .replace("__APP_ID__", UBISOFT_CONNECT_APP_ID);

    let (tx_server, rx_server) = tokio::sync::oneshot::channel::<Result<UbisoftSessionContext, String>>();
    let tx_server = std::sync::Arc::new(std::sync::Mutex::new(Some(tx_server)));

    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut reader = BufReader::new(&mut stream);
            let mut request_line = String::new();
            let _ = reader.read_line(&mut request_line).await;

            let response = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nOK";
            let _ = stream.write_all(response.as_bytes()).await;

            let result: Result<UbisoftSessionContext, String> = (|| {
                let path = request_line.split_whitespace().nth(1).unwrap_or("");
                if !path.starts_with("/__ubi__") {
                    return Err("Unexpected path".to_string());
                }
                let query = path.split('?').nth(1).unwrap_or("");
                let mut token = String::new();
                let mut session_id = String::new();
                
                for pair in query.split('&') {
                    let mut parts = pair.splitn(2, '=');
                    let k = parts.next().unwrap_or("");
                    let v = parts.next().unwrap_or("").replace('+', " ");
                    let mut out = String::new();
                    let mut chars = v.chars();
                    while let Some(c) = chars.next() {
                        if c == '%' {
                            let h1 = chars.next().unwrap_or('0');
                            let h2 = chars.next().unwrap_or('0');
                            if let Ok(byte) = u8::from_str_radix(&format!("{}{}", h1, h2), 16) {
                                out.push(byte as char);
                            }
                        } else {
                            out.push(c);
                        }
                    }
                    if k == "token" { token = out.clone(); }
                    if k == "sessionId" { session_id = out.clone(); }
                }
                
                Ok(UbisoftSessionContext {
                    access_token: token,
                    session_id,
                    account_id: None,
                })
            })();

            if let Ok(mut guard) = tx_server.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(result);
                }
            }
        }
    });

    let app_for_close = app.clone();
    
    if let Some(old) = app.get_webview_window("ubisoft-auth-silent") {
        old.close().ok();
    }

    let _win = WebviewWindowBuilder::new(app, "ubisoft-auth-silent", WebviewUrl::External(auth_url))
        .title("Ubisoft Background Auth")
        .visible(false) // SILENT background refresh
        .initialization_script(&init_script) 
        .build()
        .map_err(|e| format!("Failed to open hidden Ubisoft login window: {e}"))?;

    let result = tokio::time::timeout(std::time::Duration::from_secs(10), rx_server)
        .await
        .map_err(|_| "Silent login timed out".to_string())?
        .map_err(|_| "Channel closed".to_string())?;

    if let Some(w) = app_for_close.get_webview_window("ubisoft-auth-silent") { 
        w.close().ok(); 
    }

    let context = result?;
    eprintln!("[UBI] silent background refresh SUCCEEDED! token_len={}", context.access_token.len());
    
    Ok(context)
}

#[tauri::command]
async fn connect_ubisoft(app: tauri::AppHandle) -> Result<UbisoftProfile, String> {
    use std::time::Duration;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    const APP_ID: &str = UBISOFT_CONNECT_APP_ID;

    if let Some(old) = app.get_webview_window("ubisoft-auth") {
        old.close().ok();
    }

    let auth_url = tauri::Url::parse(&format!(
        "https://account.ubisoft.com/en-US/login?appId={}",
        urlencoding::encode(APP_ID)
    ))
    .map_err(|e| format!("Invalid Ubisoft URL: {e}"))?;


    // Injected before any page JS on every navigation.
    // Patches localStorage, sessionStorage, fetch, and XHR so we see every token
    // the page writes — login response, session refresh, or SDK initialisation.
    // When a valid Ubisoft ticket is detected we navigate to localhost/__ubi__
    // which on_navigation intercepts to close the window and return the token.
    let init_script = r#"
(function(){
  if(window.__ubi_hooked__)return;
  window.__ubi_hooked__=true;
  var _done=false;
  var pendingToken='';
  var pendingUid='';
  var pendingName='';
  var pendingRefresh='';
  var pendingSessionRefresh='';
  var pendingSessionId='';
  var flushTimer=0;
  var firstTokenAt=0;

  function escapeHtml(value){
    return String(value||'').replace(/[&<>\"']/g,function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]||ch;
    });
  }

  function render(html){
    try{
      document.open();
      document.write(html);
      document.close();
    }catch(e){}
  }

  function successHtml(name){
    var title=name?('Connected as '+escapeHtml(name)):'Ubisoft Connect account linked';
    return '<!DOCTYPE html><html><head><meta charset=\"utf-8\">'
      + '<style>'
      + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
      + 'background:radial-gradient(circle at top,#12203d 0%,#0a0e17 52%,#070b12 100%);'
      + 'font-family:Segoe UI,sans-serif;color:#ecf3ff}'
      + '.card{width:min(360px,calc(100vw - 48px));padding:34px 28px;border-radius:22px;'
      + 'background:rgba(14,20,34,.92);border:1px solid rgba(112,159,255,.18);text-align:center;'
      + 'box-shadow:0 24px 80px rgba(0,0,0,.45)}'
      + '.check{width:64px;height:64px;border-radius:999px;margin:0 auto 18px;display:grid;place-items:center;'
      + 'background:linear-gradient(135deg,#31d0aa,#2088ff);font-size:30px;font-weight:700}'
      + 'h1{margin:0 0 10px;font-size:22px}p{margin:0;color:#9db0cf;font-size:14px;line-height:1.55}'
      + '</style></head><body><div class=\"card\"><div class=\"check\">&#10003;</div>'
      + '<h1>Ubisoft Connected</h1><p>'+title+'</p></div></body></html>';
  }

  function extractTicket(value){
    if(typeof value!=='string'||!value)return '';
    var normalized=String(value).trim();
    var headerMatch=normalized.match(/(?:^|\s)(Ubi_v1|ubi_v1|rm_v1)\s+t=([^\s",;]+)/i);
    if(headerMatch)return headerMatch[2];
    if(normalized.length>40 && normalized.indexOf(' ')===-1 && normalized.indexOf('eyJ')===0)return normalized;
    return '';
  }

  function extractSessionId(value){
    if(typeof value!=='string'||!value)return '';
    var match=String(value).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match?match[0]:'';
  }

  function inspectHeaderPair(name,value){
    if(!name||typeof value!=='string'||!value)return;
    var lower=String(name).toLowerCase();
    if(lower==='authorization'){
      var authMatch=value.match(/^(Ubi_v1|ubi_v1|rm_v1)\s+t=(.+)$/i);
      if(authMatch){
        if(authMatch[1].toLowerCase()==='rm_v1'){
          report('', '', '', authMatch[2], '');
        }else{
          report(authMatch[2], '', '', '', '');
        }
        return;
      }
      // Also capture Bearer tokens (modern Ubisoft Connect OAuth2 JWTs)
      var bearerMatch=value.match(/^Bearer\s+([A-Za-z0-9_\-.~=]{40,})$/i);
      if(bearerMatch){
        report(bearerMatch[1], '', '', '', '');
      }
      return;
    }
    if(lower==='ubi-sessionid'){
      var headerSessionId=extractSessionId(value);
      if(headerSessionId){
        report('', '', '', '', headerSessionId);
      }
      return;
    }
    if(lower==='ubi-profileid'){
      report('', value, '', '', '');
    }
  }

  function inspectHeaders(headers){
    if(!headers)return;
    try{
      if(typeof headers.forEach==='function'){
        headers.forEach(function(value,name){
          inspectHeaderPair(name,value);
        });
        return;
      }
      if(Array.isArray(headers)){
        headers.forEach(function(entry){
          if(Array.isArray(entry)&&entry.length>=2){
            inspectHeaderPair(entry[0], entry[1]);
          }
        });
        return;
      }
      Object.keys(headers).forEach(function(name){
        inspectHeaderPair(name, headers[name]);
      });
    }catch(e){}
  }

  function inspectSessionPayload(payload){
    if(!payload||typeof payload!=='object')return;
    var sessionToken=extractTicket(
      payload.ticket||payload.sessionTicket||payload.accessToken||payload.access_token||''
    );
    var sessionId=extractSessionId(
      payload.sessionId||payload.session_id||payload.sessionID||''
    );
    var profileId=payload.profileId||payload.accountId||payload.userId||payload.userID||'';
    var username=payload.nameOnPlatform||payload.username||payload.displayName||payload.name||'';
    var refreshTicket=extractTicket(payload.rememberMeTicket||'');
    if(sessionToken||sessionId||profileId||username||refreshTicket){
      report(sessionToken, profileId, username, refreshTicket, sessionId);
    }
  }

  function getStorage(name){
    try{
      return window[name];
    }catch(e){
      return null;
    }
  }

  function signalUrl(path,query){
    return 'http://127.0.0.1:__UBI_PORT__'+path+(query?('?'+query):'');
  }

  function sendResult(payload){
    var q=new URLSearchParams();
    q.set('uid',(payload&&payload.uid)||'');
    q.set('name',(payload&&payload.name)||'');
    q.set('token',(payload&&payload.token)||'');
    q.set('refresh',(payload&&payload.refresh)||'');
    q.set('sessionId',(payload&&payload.sessionId)||'');
    window.location.replace(signalUrl('/__ubi__',q.toString()));
  }

  function sendError(message){
    window.location.replace(signalUrl('/__ubi_fatal__','msg='+encodeURIComponent(message||'no_token')));
  }

  function clearFlushTimer(){
    if(!flushTimer)return;
    clearTimeout(flushTimer);
    flushTimer=0;
  }

  function mergePending(payload){
    if(!payload||typeof payload!=='object')return false;
    var changed=false;
    if(payload.token&&payload.token!==pendingToken){
      pendingToken=payload.token;
      if(!firstTokenAt)firstTokenAt=Date.now();
      changed=true;
    }
    if(payload.uid&&!pendingUid){
      pendingUid=payload.uid;
      changed=true;
    }
    if(payload.name&&!pendingName){
      pendingName=payload.name;
      changed=true;
    }
    if(payload.refresh&&!pendingRefresh){
      pendingRefresh=payload.refresh;
      changed=true;
    }
    if(payload.sessionId&&!pendingSessionId){
      pendingSessionId=payload.sessionId;
      changed=true;
    }
    return changed;
  }

  function flushPending(force){
    if(_done||!pendingToken)return;

    // Do not flush an incomplete session if the user is on the login page typing.
    var path=window.location.pathname||'';
    var isLogin=path.indexOf('/login')!==-1||path.indexOf('/register')!==-1||path.indexOf('/oauth')!==-1;
    if(!force&&isLogin&&(!pendingUid||!pendingName))return;

    var elapsed=firstTokenAt?Date.now()-firstTokenAt:0;
    if(!force&&elapsed<2500&&(!pendingUid||!pendingName)){
      scheduleFlush();
      return;
    }
    _done=true;
    clearFlushTimer();
    var payload={
      uid:pendingUid||'',
      name:pendingName||'',
      token:pendingToken||'',
      refresh:pendingSessionRefresh||pendingRefresh||'',
      sessionId:pendingSessionId||''
    };
    sendResult(payload);
  }

  function scheduleFlush(){
    if(_done||!pendingToken)return;
    clearFlushTimer();
    var elapsed=firstTokenAt?Date.now()-firstTokenAt:0;
    var delay=(pendingUid&&pendingName)?150:Math.max(300,2500-elapsed);
    flushTimer=setTimeout(function(){
      flushPending(false);
    },delay);
  }

  window.addEventListener('message',function(event){
    var data=event&&event.data;
    if(!data||typeof data!=='object'||!data.__ubisoftBridge__)return;
    if(data.__ubisoftBridge__==='ubisoft-auth-result'){
      if(_done)return;
      mergePending(data.payload||{});
      scheduleFlush();
    }else if(data.__ubisoftBridge__==='ubisoft-auth-error'){
      if(pendingToken){
        scheduleFlush();
        return;
      }
      _done=true;
      sendError(data.payload||'relay_error');
    }
  },false);

  function findFieldDeep(obj,keys,seen){
    if(!obj||typeof obj!=='object')return '';
    if(!seen)seen=[];
    if(seen.indexOf(obj)!==-1)return '';
    seen.push(obj);
    for(var i=0;i<keys.length;i++){
      var direct=obj[keys[i]];
      if(typeof direct==='string'&&direct)return direct;
    }
    for(var key in obj){
      if(!Object.prototype.hasOwnProperty.call(obj,key))continue;
      var nested=obj[key];
      if(nested&&typeof nested==='object'){
        var found=findFieldDeep(nested,keys,seen);
        if(found)return found;
      }
    }
    return '';
  }

  function report(token,uid,name,refresh,sessionId){
    if(_done)return;
    mergePending({
      uid:uid||'',
      name:name||'',
      token:token||'',
      refresh:refresh||'',
      sessionId:sessionId||''
    });
    if(pendingToken){
      scheduleFlush();
    }
  }



  var scanTimer=setInterval(function(){
    if(_done){clearInterval(scanTimer);return;}
    var path=window.location.pathname||'';
    var isLogin=path.indexOf('/login')!==-1||path.indexOf('/register')!==-1||path.indexOf('/oauth')!==-1;
    if(!isLogin&&window.location.origin&&(window.location.origin.indexOf('ubisoft.com')!==-1||window.location.origin.indexOf('ubi.com')!==-1)){
      if(!window.__ubi_sessions_triggered__){
        window.__ubi_sessions_triggered__=true;
        fetch('https://public-ubiservices.ubi.com/v3/profiles/sessions',{
          method:'POST',credentials:'include',
          headers:{'Ubi-AppId':'__APP_ID__','Content-Type':'application/json','Ubi-RequestedPlatformType':'uplay','Accept':'application/json'},
          body:'{"rememberMe":true}'
        }).catch(function(){});
      }
    }
  },700);



  if(typeof window.fetch==='function'){
    var _fetch=window.fetch;
    window.fetch=function(){
      try{
        var input=arguments[0];
        var init=arguments[1]||{};
        if(input&&input.headers)inspectHeaders(input.headers);
        inspectHeaders(init.headers);
      }catch(e){}
      return _fetch.apply(window,arguments).then(function(resp){
        try{
          inspectHeaders(resp&&resp.headers);
          resp.clone().text().then(function(t){
            try{
              if(resp&&resp.url&&resp.url.indexOf('/v3/profiles/sessions')!==-1){
                var sp=JSON.parse(t);
                inspectSessionPayload(sp);
                // Separately capture the fresh rm_v1; pendingRefresh is blocked by !pendingRefresh guard
                var freshRm=sp&&sp.rememberMeTicket?extractTicket(sp.rememberMeTicket):'';
                if(freshRm){
                  pendingSessionRefresh=freshRm;
                  if(!_done){if(pendingUid&&pendingName){flushPending(true);}else{scheduleFlush();}}
                }
              }
            }catch(e){}
          });
        }catch(e){}
        return resp;
      });
    };
  }

  if(typeof XMLHttpRequest!=='undefined'&&XMLHttpRequest.prototype&&XMLHttpRequest.prototype.send){
    var _open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url){
      try{ this.__ubi_url__=url||''; }catch(e){}
      return _open.apply(this,arguments);
    };
    var _setRequestHeader=XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader=function(name,value){
      try{ inspectHeaderPair(name,value); }catch(e){}
      return _setRequestHeader.apply(this,arguments);
    };
    var _send=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send=function(){
      this.addEventListener('load',function(){
        try{
          inspectHeaderPair('Ubi-SessionId', this.getResponseHeader('Ubi-SessionId') || '');
          inspectHeaderPair('Ubi-ProfileId', this.getResponseHeader('Ubi-ProfileId') || '');
          if(this.__ubi_url__&&this.__ubi_url__.indexOf('/v3/profiles/sessions')!==-1){
            var sp=JSON.parse(this.responseText);
            inspectSessionPayload(sp);
            var freshRm=sp&&sp.rememberMeTicket?extractTicket(sp.rememberMeTicket):'';
            if(freshRm){
              pendingSessionRefresh=freshRm;
              if(!_done){if(pendingUid&&pendingName){flushPending(true);}else{scheduleFlush();}}
            }
          }
        }catch(e){}
      },false);
      return _send.apply(this,arguments);
    };
  }

  // Poll for post-login states (for users still on login/register page)
  setInterval(function() {
    if (_done || window.__ubi_sessions_triggered__) return;
    var path = window.location.pathname || '';
    if (path.indexOf('/login') !== -1 || path.indexOf('/register') !== -1 || path.indexOf('/oauth') !== -1) return;
    window.__ubi_sessions_triggered__ = true;
    fetch('https://public-ubiservices.ubi.com/v3/profiles/sessions', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Ubi-AppId': '__APP_ID__',
        'Content-Type': 'application/json',
        'Ubi-RequestedPlatformType': 'uplay',
        'Accept': 'application/json'
      },
      body: '{"rememberMe":true}'
    }).catch(function(){});
  }, 1500);

})();
"#;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to start callback server: {e}"))?;
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

    let init_script = init_script
        .replace("__UBI_PORT__", &port.to_string())
        .replace("__APP_ID__", APP_ID);

    let (tx_server, rx_server) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx_server = std::sync::Arc::new(std::sync::Mutex::new(Some(tx_server)));

    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut reader = BufReader::new(&mut stream);
            let mut request_line = String::new();
            let _ = reader.read_line(&mut request_line).await;

            let html = r##"<!DOCTYPE html><html><body style="background:#0b0d17;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
                <div style="text-align:center;">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#00e676" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    <h2>Ubisoft connected!</h2><p>You can close this window now.</p>
                </div>
                <script>setTimeout(() => window.close(), 1500);</script>
            </body></html>"##;
            let response = format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}", html.len(), html);
            let _ = stream.write_all(response.as_bytes()).await;

            // `request_line` looks like "GET /__ubi__?token=... HTTP/1.1"
            let result: Result<String, String> = (|| {
                fn decode(s: &str) -> String {
                    let with_spaces = s.replace('+', " ");
                    let mut out = String::with_capacity(with_spaces.len());
                    let mut chars = with_spaces.chars();
                    while let Some(c) = chars.next() {
                        if c == '%' {
                            let h1 = chars.next().unwrap_or('0');
                            let h2 = chars.next().unwrap_or('0');
                            if let Ok(byte) = u8::from_str_radix(&format!("{}{}", h1, h2), 16) {
                                out.push(byte as char);
                            }
                        } else {
                            out.push(c);
                        }
                    }
                    out
                }
                fn parse_qs(query: &str) -> std::collections::HashMap<String, String> {
                    query.split('&').filter_map(|pair| {
                        let mut parts = pair.splitn(2, '=');
                        let k = decode(parts.next().unwrap_or(""));
                        let v = decode(parts.next().unwrap_or(""));
                        if k.is_empty() { None } else { Some((k, v)) }
                    }).collect()
                }

                let path = request_line.split_whitespace().nth(1).unwrap_or("");
                if path.starts_with("/__ubi_fatal__") {
                    let query = path.split('?').nth(1).unwrap_or("");
                    let params = parse_qs(query);
                    let msg = params.get("msg").cloned().unwrap_or_else(|| "unknown".to_string());
                    return Err(format!("Could not extract your Ubisoft session ({}).", msg));
                }
                if !path.starts_with("/__ubi__") {
                    return Err("Unexpected callback path".to_string());
                }
                let query = path.split('?').nth(1).unwrap_or("");
                let params = parse_qs(query);
                Ok(serde_json::json!({
                    "uid":       params.get("uid").cloned().unwrap_or_default(),
                    "name":      params.get("name").cloned().unwrap_or_default(),
                    "token":     params.get("token").cloned().unwrap_or_default(),
                    "refresh":   params.get("refresh").cloned().unwrap_or_default(),
                    "sessionId": params.get("sessionId").cloned().unwrap_or_default(),
                }).to_string())
            })();

            if let Ok(mut guard) = tx_server.lock() {
                if let Some(tx) = guard.take() {
                    tx.send(result).ok();
                }
            }
        }
    });

    let app_for_close = app.clone();
    let _win = WebviewWindowBuilder::new(&app, "ubisoft-auth", WebviewUrl::External(auth_url))
        .title("Connect Ubisoft Account")
        .inner_size(520.0, 720.0)
        .initialization_script(&init_script) // the TCP injected port version
        .build()
        .map_err(|e| format!("Failed to open Ubisoft login window: {e}"))?;

    let result = tokio::time::timeout(std::time::Duration::from_secs(300), rx_server)
        .await
        .map_err(|_| "Ubisoft login timed out. Please try again.".to_string())?
        .map_err(|_| "Ubisoft login was cancelled.".to_string())?;

    let payload = result?;

    // Close the auth window
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Some(w) = app_for_close.get_webview_window("ubisoft-auth") { w.close().ok(); }
    });

    let v: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|e| format!("Failed to parse Ubisoft session: {e}"))?;
    let mut account_id = v["uid"].as_str().unwrap_or("").to_string();
    let mut username = v["name"].as_str().unwrap_or("").to_string();
    let mut access_token = v["token"].as_str().unwrap_or("").to_string();
    let refresh_token = v["refresh"].as_str().unwrap_or("").to_string();
    let mut session_id = v["sessionId"].as_str().unwrap_or("").to_string();
    let mut avatar_url = build_ubisoft_avatar_url(&account_id);

    eprintln!(
        "Ubisoft auth callback: uid_present={} name_present={} token_present={} refresh_present={}",
        !account_id.is_empty(),
        !username.is_empty(),
        !access_token.is_empty(),
        !refresh_token.is_empty()
    );

    if account_id.is_empty() {
        if let Some(cached_account_id) = resolve_cached_ubisoft_account_id() {
            account_id = cached_account_id;
        }
    }

    // If the web payload omitted the identity fields, fill them from Ubisoft's API
    // and finally from the local Ubisoft launcher cache.
    if (account_id.is_empty() || username.is_empty()) && !access_token.is_empty() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        for ubi_app_id in [APP_ID, "afb4b43c-f1f7-41b7-bcef-a635d8c83822"] {
            let mut endpoints = vec![
                "https://public-ubiservices.ubi.com/v3/users/me/profiles".to_string(),
                "https://public-ubiservices.ubi.com/v3/users/me".to_string(),
                "https://public-ubiservices.ubi.com/v3/profiles/me".to_string(),
            ];
            if !account_id.is_empty() {
                endpoints.push(format!(
                    "https://public-ubiservices.ubi.com/v3/profiles/{}",
                    urlencoding::encode(&account_id)
                ));
            }

            for endpoint in endpoints {
                if !account_id.is_empty() && !username.is_empty() {
                    break;
                }

                if let Ok(res) = client
                    .get(&endpoint)
                    .header("Authorization", format!("Ubi_v1 t={}", access_token))
                    .header("Ubi-AppId", ubi_app_id)
                    .header("Ubi-RequestedPlatformType", "uplay")
                    .header("Accept", "application/json")
                    .send()
                    .await
                {
                    eprintln!(
                        "Ubisoft profile lookup [{}] {} -> {}",
                        ubi_app_id,
                        endpoint,
                        res.status()
                    );
                    if !res.status().is_success() {
                        continue;
                    }

                    if let Ok(profile) = res.json::<serde_json::Value>().await {
                        apply_ubisoft_identity_from_response(
                            &profile,
                            &mut account_id,
                            &mut username,
                        );
                    }
                }
            }
        }
    }

    if avatar_url.is_empty() && !account_id.is_empty() {
        avatar_url = build_ubisoft_avatar_url(&account_id);
    }

    if session_id.is_empty() {
        let resolved_auth = resolve_stored_ubisoft_auth(
            (!access_token.trim().is_empty()).then_some(access_token.as_str()),
            (!refresh_token.trim().is_empty()).then_some(refresh_token.as_str()),
            None,
            (!account_id.trim().is_empty()).then_some(account_id.as_str()),
        );
        if let Some(resolved_session_id) = resolved_auth.session_id {
            session_id = resolved_session_id;
        }
    }

    eprintln!(
        "Ubisoft resolved profile: account_id={} username_present={} avatar_present={}",
        account_id,
        !username.is_empty(),
        !avatar_url.is_empty()
    );

    if account_id.is_empty() || username.is_empty() {
        return Err("Could not retrieve your Ubisoft profile. Please try again.".to_string());
    }

    if session_id.is_empty() {
        if let Ok(session) = ensure_ubisoft_session(
            &app,
            (!access_token.trim().is_empty()).then_some(access_token.as_str()),
            (!refresh_token.trim().is_empty()).then_some(refresh_token.as_str()),
            None,
            Some(account_id.as_str()),
        )
        .await
        {
            access_token = session.access_token;
            session_id = session.session_id;
            if account_id.is_empty() {
                if let Some(resolved_account_id) = session.account_id {
                    account_id = resolved_account_id;
                }
            }
        }
    }

    Ok(UbisoftProfile {
        account_id,
        username,
        avatar_url,
        access_token,
        refresh_token,
        session_id,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// ── HowLongToBeat ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HltbResult {
    pub available: bool,
    pub main: f64,
    pub main_extra: f64,
    pub completionist: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Deserialize)]
struct HltbSearchResponse {
    data: Vec<HltbGame>,
}

#[derive(Deserialize)]
struct HltbGame {
    comp_main: Option<serde_json::Value>,
    comp_plus: Option<serde_json::Value>,
    comp_100: Option<serde_json::Value>,
}

#[derive(Deserialize, Clone)]
struct HltbInitResponse {
    token: String,
    #[serde(rename = "hpKey")]
    hp_key: String,
    #[serde(rename = "hpVal")]
    hp_val: String,
}

fn hltb_val_to_hours(v: &Option<serde_json::Value>) -> f64 {
    let secs = match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(serde_json::Value::String(s)) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    if secs <= 0.0 {
        return 0.0;
    }
    (secs / 3600.0 * 10.0).round() / 10.0
}

static HLTB_AUTH_CACHE: std::sync::OnceLock<HltbInitResponse> = std::sync::OnceLock::new();

async fn get_hltb_auth(client: &reqwest::Client) -> Result<HltbInitResponse, String> {
    if let Some(auth) = HLTB_AUTH_CACHE.get() {
        return Ok(auth.clone());
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    // HLTB uses /api/find/init to hand out tokens and header keys
    let res = client
        .get(&format!("https://howlongtobeat.com/api/find/init?t={}", ts))
        .header("Accept", "application/json, text/plain, */*")
        .header("Referer", "https://howlongtobeat.com/")
        .header("Cookie", "hltb_alive=1")
        .send()
        .await
        .map_err(|e| format!("init_req:{}", e))?;

    if !res.status().is_success() {
        return Err(format!("init_status:{}", res.status().as_u16()));
    }

    let auth = res
        .json::<HltbInitResponse>()
        .await
        .map_err(|e| format!("init_json:{}", e))?;

    let _ = HLTB_AUTH_CACHE.set(auth.clone());
    Ok(auth)
}

#[tauri::command]
async fn get_hltb_data(query: String) -> HltbResult {
    macro_rules! fail {
        ($reason:expr) => {{
            let r: String = format!("{}", $reason);
            eprintln!("[HLTB] fail: {}", r);
            return HltbResult {
                available: false,
                main: 0.0,
                main_extra: 0.0,
                completionist: 0.0,
                reason: Some(r),
            };
        }};
    }

    if query.trim().is_empty() {
        fail!("empty_query");
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .build()
    {
        Ok(c) => c,
        Err(e) => fail!(format!("client_build:{}", e)),
    };

    let auth = match get_hltb_auth(&client).await {
        Ok(a) => a,
        Err(e) => fail!(e),
    };

    let terms: Vec<&str> = query.split_whitespace().collect();
    let mut body = serde_json::Map::new();
    body.insert("searchType".into(), "games".into());
    body.insert("searchTerms".into(), serde_json::json!(terms));
    body.insert("searchPage".into(), 1.into());
    body.insert("size".into(), 5.into());
    body.insert(
        "searchOptions".into(),
        serde_json::json!({
            "games": {
                "userId": 0,
                "platform": "",
                "sortCategory": "popular",
                "rangeCategory": "main",
                "rangeTime": { "min": null, "max": null },
                "gameplay": { "perspective": "", "flow": "", "genre": "", "difficulty": "" },
                "rangeYear": { "min": "", "max": "" },
                "modifier": ""
            },
            "users": { "sortCategory": "postcount" },
            "lists": { "sortCategory": "follows" },
            "filter": "",
            "sort": 0,
            "randomizer": 0
        }),
    );
    body.insert("useCache".into(), true.into());

    // They dynamically enforce a honeypot key in the body matching the headers
    body.insert(auth.hp_key.clone(), serde_json::json!(auth.hp_val));

    let res = match client
        .post("https://howlongtobeat.com/api/find")
        .header("Content-Type", "application/json")
        .header("Origin", "https://howlongtobeat.com")
        .header("Referer", "https://howlongtobeat.com/")
        .header("Accept", "application/json, text/plain, */*")
        .header("Cookie", "hltb_alive=1")
        .header("x-auth-token", auth.token)
        .header("x-hp-key", auth.hp_key)
        .header("x-hp-val", auth.hp_val)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => fail!(format!("request:{}", e)),
    };

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let txt = res.text().await.unwrap_or_default();
        eprintln!("[HLTB] err body ({status}): {}", &txt[..txt.len().min(250)]);
        fail!(format!("api_status:{}", status));
    }

    let data = match res.json::<HltbSearchResponse>().await {
        Ok(d) => d,
        Err(e) => fail!(format!("json_parse:{}", e)),
    };

    eprintln!("[HLTB] result count: {}", data.data.len());

    let game = match data.data.into_iter().next() {
        Some(g) => g,
        None => fail!("no_results"),
    };

    HltbResult {
        available: true,
        main: hltb_val_to_hours(&game.comp_main),
        main_extra: hltb_val_to_hours(&game.comp_plus),
        completionist: hltb_val_to_hours(&game.comp_100),
        reason: None,
    }
}

#[tauri::command]
async fn close_splashscreen(window: tauri::Window, fullscreen: Option<bool>, maximize: Option<bool>) {
    use tauri::Manager;

    // Close splashscreen
    if let Some(splashscreen) = window.get_webview_window("splashscreen") {
        let _ = splashscreen.close();
    }
    // Apply window state before show() so the user never sees an intermediate size
    if let Some(main_window) = window.get_webview_window("main") {
        if fullscreen.unwrap_or(false) {
            let _ = main_window.set_fullscreen(true);
        } else if maximize.unwrap_or(false) {
            let _ = main_window.maximize();
        }
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
}

// ─── IGDB API ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TwitchTokenResponse {
    access_token: String,
    expires_in: u64,
}

static IGDB_TOKEN: OnceLock<RwLock<Option<(String, Instant)>>> = OnceLock::new();

async fn get_igdb_token(client: &Client) -> Result<String, String> {
    dotenv().ok();
    let client_id =
        get_env("IGDB_CLIENT_ID").map_err(|_| "IGDB_CLIENT_ID not found".to_string())?;
    let client_secret = get_env("IGDB_CLIENT_SECRET")
        .map_err(|_| "IGDB_CLIENT_SECRET not found".to_string())?;

    let lock = IGDB_TOKEN.get_or_init(|| RwLock::new(None));

    // Check cache
    {
        let cache = lock.read().await;
        if let Some((token, expiry)) = cache.as_ref() {
            if Instant::now() < *expiry {
                return Ok(token.clone());
            }
        }
    }

    // Cache miss or expired, fetch new token
    let url = format!("https://id.twitch.tv/oauth2/token?client_id={}&client_secret={}&grant_type=client_credentials", client_id, client_secret);
    let res = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Twitch Auth error: {}", e))?;
    let data = res
        .json::<TwitchTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse Twitch token: {}", e))?;

    let mut cache = lock.write().await;
    // Buffer the expiry by 5 minutes just to be safe
    let expiry_time = Instant::now() + Duration::from_secs(data.expires_in.saturating_sub(300));
    *cache = Some((data.access_token.clone(), expiry_time));

    Ok(data.access_token)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SimilarGameResult {
    id: u64,
    name: String,
    cover_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IgdbAgeRatingResult {
    organization: Option<String>,
    rating: Option<String>,
    cover_url: Option<String>,
    descriptors: Option<Vec<String>>,
    // Fallbacks just in case
    category_id: Option<u8>,
    rating_id: Option<u8>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IgdbInvolvedCompany {
    name: String,
    logo_url: Option<String>,
    is_developer: bool,
    is_publisher: bool,
    is_porting: bool,
    is_supporting: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IgdbWebsiteResult {
    url: String,
    category: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IgdbVideoResult {
    name: Option<String>,
    video_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IgdbGameResult {
    id: u64,
    slug: Option<String>,
    name: String,
    summary: Option<String>,
    storyline: Option<String>,
    cover_url: Option<String>,
    artworks: Option<Vec<String>>,
    screenshots: Option<Vec<String>>,
    first_release_date: Option<u64>,
    genres: Option<Vec<String>>,
    themes: Option<Vec<String>>,
    keywords: Option<Vec<String>>,
    platforms: Option<Vec<String>>,
    game_modes: Option<Vec<String>>,
    player_perspectives: Option<Vec<String>>,
    game_engines: Option<Vec<String>>,
    age_ratings: Option<Vec<IgdbAgeRatingResult>>,
    similar_games: Option<Vec<SimilarGameResult>>,
    franchise: Option<String>,
    franchise_slug: Option<String>,
    collections: Option<Vec<IgdbCollectionResult>>,
    franchises: Option<Vec<IgdbFranchiseResult>>,
    involved_companies: Option<Vec<IgdbInvolvedCompany>>,
    websites: Option<Vec<IgdbWebsiteResult>>,
    videos: Option<Vec<IgdbVideoResult>>,
    /// IGDB community rating (0-100), present on released games
    rating: Option<f64>,
    rating_count: Option<u64>,
    /// IGDB aggregated critic/external score (0-100)
    aggregated_rating: Option<f64>,
    aggregated_rating_count: Option<u64>,
    /// Combined score (average of the two, when both exist)
    total_rating: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IgdbCollectionResult {
    id: u64,
    name: String,
    slug: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IgdbFranchiseResult {
    id: u64,
    name: String,
    slug: Option<String>,
}

#[derive(Deserialize)]
struct IgdbCover {
    image_id: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct IgdbArtwork {
    image_id: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct IgdbScreenshot {
    image_id: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct IgdbGenre {
    name: String,
}

#[derive(Deserialize)]
struct IgdbTheme {
    name: String,
}

#[derive(Deserialize)]
struct IgdbNamed {
    name: Option<String>,
}

#[derive(Deserialize)]
struct IgdbDescribed {
    description: Option<String>,
}

#[derive(Deserialize)]
struct IgdbAgeRatingRaw {
    category: Option<u8>,
    rating: Option<u8>,
    organization: Option<IgdbNamed>,
    rating_category: Option<serde_json::Value>,
    rating_cover_url: Option<String>,
    rating_content_descriptions: Option<Vec<IgdbDescribed>>,
}

#[derive(Deserialize)]
struct IgdbVideoRaw {
    name: Option<String>,
    video_id: Option<String>,
}

#[derive(Deserialize)]
struct IgdbWebsiteRaw {
    url: Option<String>,
    category: Option<u64>,
}

#[derive(Deserialize)]
struct IgdbSimilarCover {
    image_id: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct IgdbSimilarGame {
    id: u64,
    name: Option<String>,
    cover: Option<IgdbSimilarCover>,
}

#[derive(Deserialize)]
struct IgdbFranchise {
    name: String,
    slug: Option<String>,
}

#[derive(Deserialize)]
struct IgdbCollection {
    id: u64,
    name: String,
    slug: Option<String>,
}

#[derive(Deserialize)]
struct IgdbFranchiseItem {
    id: u64,
    name: String,
    slug: Option<String>,
}

#[derive(Deserialize)]
struct IgdbRawCompany {
    name: Option<String>,
    logo: Option<IgdbCover>,
}

#[derive(Deserialize)]
struct IgdbRawInvolvedCompany {
    company: Option<IgdbRawCompany>,
    developer: Option<bool>,
    publisher: Option<bool>,
    porting: Option<bool>,
    supporting: Option<bool>,
}

#[derive(Deserialize)]
struct IgdbRawGame {
    id: u64,
    slug: Option<String>,
    name: String,
    summary: Option<String>,
    storyline: Option<String>,
    cover: Option<IgdbCover>,
    artworks: Option<Vec<IgdbArtwork>>,
    screenshots: Option<Vec<IgdbScreenshot>>,
    first_release_date: Option<u64>,
    genres: Option<Vec<IgdbGenre>>,
    themes: Option<Vec<IgdbTheme>>,
    keywords: Option<Vec<IgdbNamed>>,
    platforms: Option<Vec<IgdbNamed>>,
    game_modes: Option<Vec<IgdbNamed>>,
    player_perspectives: Option<Vec<IgdbNamed>>,
    game_engines: Option<Vec<IgdbNamed>>,
    age_ratings: Option<Vec<IgdbAgeRatingRaw>>,
    similar_games: Option<Vec<IgdbSimilarGame>>,
    franchise: Option<IgdbFranchise>,
    collections: Option<Vec<IgdbCollection>>,
    franchises: Option<Vec<IgdbFranchiseItem>>,
    involved_companies: Option<Vec<IgdbRawInvolvedCompany>>,
    websites: Option<Vec<IgdbWebsiteRaw>>,
    videos: Option<Vec<IgdbVideoRaw>>,
    rating: Option<f64>,
    rating_count: Option<u64>,
    aggregated_rating: Option<f64>,
    aggregated_rating_count: Option<u64>,
    total_rating: Option<f64>,
}

#[tauri::command]
async fn search_igdb_games(query: String) -> Result<Vec<IgdbGameResult>, String> {
    dotenv().ok();
    let client_id =
        get_env("IGDB_CLIENT_ID").map_err(|_| "IGDB_CLIENT_ID not found".to_string())?;

    let client = Client::new();
    let token = get_igdb_token(&client).await?;

    // Sanitize query to avoid IGDB syntax errors
    let clean_query = query.replace("\"", "");
    let body = format!("search \"{}\"; fields slug, name, summary, storyline, cover.url, cover.image_id, artworks.url, artworks.image_id, screenshots.url, screenshots.image_id, videos.video_id, videos.name, first_release_date, genres.name, themes.name, platforms.name, game_modes.name, player_perspectives.name, game_engines.name, keywords.name, age_ratings.category, age_ratings.rating, age_ratings.organization.name, age_ratings.rating_category.rating, age_ratings.rating_cover_url, age_ratings.rating_content_descriptions.description, similar_games.name, similar_games.cover.url, similar_games.cover.image_id, franchise.name, franchise.slug, franchises.id, franchises.name, franchises.slug, collections.id, collections.name, collections.slug, websites.url, websites.category, involved_companies.company.name, involved_companies.company.logo.image_id, involved_companies.developer, involved_companies.publisher, involved_companies.porting, involved_companies.supporting, rating, rating_count, aggregated_rating, aggregated_rating_count, total_rating; limit 20;", clean_query);

    let res = client
        .post("https://api.igdb.com/v4/games")
        .header("Client-ID", client_id)
        .header("Authorization", format!("Bearer {}", token))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("IGDB Request failed: {}", e))?;

    let status = res.status();
    let body_text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read IGDB response body: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "IGDB API error {}: {}",
            status,
            &body_text[..body_text.len().min(300)]
        ));
    }

    let raw_games = serde_json::from_str::<Vec<IgdbRawGame>>(&body_text).map_err(|e| {
        format!(
            "Failed to parse IGDB response: {} | snippet: {}",
            e,
            &body_text[..body_text.len().min(300)]
        )
    })?;

    let mut mapped = Vec::new();
    for rg in raw_games {
        // Build image URLs prioritizing image_id if available (much safer format)
        let build_image_url =
            |img_id: Option<String>, url: Option<String>, size: &str| -> Option<String> {
                if let Some(id) = img_id {
                    Some(format!(
                        "https://images.igdb.com/igdb/image/upload/{}/{}.jpg",
                        size, id
                    ))
                } else if let Some(u) = url {
                    Some(u.replace("t_thumb", size).replace("//", "https://"))
                } else {
                    None
                }
            };

        let cover_url = rg
            .cover
            .and_then(|c| build_image_url(c.image_id, c.url, "t_1080p"));
        let artworks = rg.artworks.map(|arts| {
            arts.into_iter()
                .filter_map(|a| build_image_url(a.image_id, a.url, "t_1080p"))
                .collect()
        });

        let screenshots = rg.screenshots.map(|shots| {
            shots
                .into_iter()
                .filter_map(|s| build_image_url(s.image_id, s.url, "t_1080p"))
                .collect()
        });

        let genres = rg.genres.map(|g| g.into_iter().map(|x| x.name).collect());
        let themes = rg.themes.map(|t| t.into_iter().map(|x| x.name).collect());
        let keywords = rg
            .keywords
            .map(|kw| kw.into_iter().filter_map(|x| x.name).collect());
        let platforms = rg
            .platforms
            .map(|p| p.into_iter().filter_map(|x| x.name).collect());
        let game_modes = rg
            .game_modes
            .map(|gm| gm.into_iter().filter_map(|x| x.name).collect());
        let player_perspectives = rg
            .player_perspectives
            .map(|pp| pp.into_iter().filter_map(|x| x.name).collect());
        let game_engines = rg
            .game_engines
            .map(|ge| ge.into_iter().filter_map(|x| x.name).collect());

        let franchise_slug = rg.franchise.as_ref().and_then(|f| f.slug.clone());
        let franchise = rg.franchise.map(|f| f.name);
        let collections = rg.collections.map(|cols| {
            cols.into_iter()
                .map(|c| IgdbCollectionResult {
                    id: c.id,
                    name: c.name,
                    slug: c.slug,
                })
                .collect()
        });
        let franchises = rg.franchises.map(|frs| {
            frs.into_iter()
                .map(|f| IgdbFranchiseResult {
                    id: f.id,
                    name: f.name,
                    slug: f.slug,
                })
                .collect()
        });

        let age_ratings = rg.age_ratings.map(|ratings| {
            ratings
                .into_iter()
                .map(|r| {
                    let rating_val = r
                        .rating_category
                        .as_ref()
                        .and_then(|rc| rc.get("rating").or_else(|| rc.get("name")))
                        .and_then(|v| {
                            v.as_str()
                                .map(|s| s.to_string())
                                .or_else(|| v.as_u64().map(|n| n.to_string()))
                        })
                        .or_else(|| {
                            r.rating_category
                                .as_ref()
                                .and_then(|rc| rc.as_str().map(|s| s.to_string()))
                        })
                        .or_else(|| {
                            r.rating_category
                                .as_ref()
                                .and_then(|rc| rc.as_u64().map(|n| n.to_string()))
                        });

                    IgdbAgeRatingResult {
                        organization: r.organization.and_then(|o| o.name),
                        rating: rating_val,
                        cover_url: r.rating_cover_url,
                        descriptors: r
                            .rating_content_descriptions
                            .map(|descs| descs.into_iter().filter_map(|d| d.description).collect()),
                        category_id: r.category,
                        rating_id: r.rating,
                    }
                })
                .collect()
        });

        let websites = rg.websites.map(|ws| {
            ws.into_iter()
                .filter_map(|w| match (w.url, w.category) {
                    (Some(u), Some(c)) => Some(IgdbWebsiteResult {
                        url: u,
                        category: c,
                    }),
                    _ => None,
                })
                .collect()
        });

        let videos = rg.videos.map(|vs| {
            vs.into_iter()
                .filter_map(|v| {
                    v.video_id.map(|vid| IgdbVideoResult {
                        name: v.name,
                        video_id: vid,
                    })
                })
                .collect()
        });

        let similar_games = rg.similar_games.map(|sims| {
            sims.into_iter()
                .filter(|s| s.name.is_some())
                .map(|s| SimilarGameResult {
                    id: s.id,
                    name: s.name.unwrap_or_default(),
                    cover_url: s
                        .cover
                        .and_then(|c| build_image_url(c.image_id, c.url, "t_cover_big")),
                })
                .collect()
        });

        let involved_companies = rg.involved_companies.map(|ics| {
            ics.into_iter()
                .filter_map(|ic| {
                    let name = ic.company.as_ref().and_then(|c| c.name.clone())?;
                    let logo_url =
                        ic.company
                            .as_ref()
                            .and_then(|c| c.logo.as_ref())
                            .and_then(|l| {
                                build_image_url(l.image_id.clone(), l.url.clone(), "t_1080p")
                            });
                    Some(IgdbInvolvedCompany {
                        name,
                        logo_url,
                        is_developer: ic.developer.unwrap_or(false),
                        is_publisher: ic.publisher.unwrap_or(false),
                        is_porting: ic.porting.unwrap_or(false),
                        is_supporting: ic.supporting.unwrap_or(false),
                    })
                })
                .collect()
        });

        mapped.push(IgdbGameResult {
            id: rg.id,
            slug: rg.slug,
            name: rg.name,
            summary: rg.summary,
            storyline: rg.storyline,
            cover_url,
            artworks,
            screenshots,
            first_release_date: rg.first_release_date,
            genres,
            themes,
            keywords,
            platforms,
            game_modes,
            player_perspectives,
            game_engines,
            age_ratings,
            similar_games,
            franchise,
            franchise_slug,
            collections,
            franchises,
            involved_companies,
            websites,
            videos,
            rating: rg.rating,
            rating_count: rg.rating_count,
            aggregated_rating: rg.aggregated_rating,
            aggregated_rating_count: rg.aggregated_rating_count,
            total_rating: rg.total_rating,
        });
    }

    Ok(mapped)
}

/// Fetch a single IGDB game by its numeric ID.
/// Returns the same IgdbGameResult shape but queries `where id = N;` for accuracy.
#[tauri::command]
async fn get_igdb_game_by_id(game_id: u64) -> Result<Option<IgdbGameResult>, String> {
    dotenv().ok();
    let client_id =
        get_env("IGDB_CLIENT_ID").map_err(|_| "IGDB_CLIENT_ID not found".to_string())?;

    let client = Client::new();
    let token = get_igdb_token(&client).await?;

    let body = format!(
        "where id = {}; fields slug, name, summary, storyline, cover.url, cover.image_id, artworks.url, artworks.image_id, screenshots.url, screenshots.image_id, videos.video_id, videos.name, first_release_date, genres.name, themes.name, platforms.name, game_modes.name, player_perspectives.name, game_engines.name, keywords.name, age_ratings.category, age_ratings.rating, age_ratings.organization.name, age_ratings.rating_category.rating, age_ratings.rating_cover_url, age_ratings.rating_content_descriptions.description, similar_games.name, similar_games.cover.url, similar_games.cover.image_id, franchise.name, franchise.slug, franchises.id, franchises.name, franchises.slug, collections.id, collections.name, collections.slug, websites.url, websites.category, involved_companies.company.name, involved_companies.company.logo.image_id, involved_companies.developer, involved_companies.publisher, involved_companies.porting, involved_companies.supporting, rating, rating_count, aggregated_rating, aggregated_rating_count, total_rating; limit 1;",
        game_id
    );

    let res = client
        .post("https://api.igdb.com/v4/games")
        .header("Client-ID", client_id)
        .header("Authorization", format!("Bearer {}", token))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("IGDB Request failed: {}", e))?;

    let status = res.status();
    let body_text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read IGDB response body: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "IGDB API error {}: {}",
            status,
            &body_text[..body_text.len().min(300)]
        ));
    }

    let raw_games = serde_json::from_str::<Vec<IgdbRawGame>>(&body_text).map_err(|e| {
        format!(
            "Failed to parse IGDB response: {} | snippet: {}",
            e,
            &body_text[..body_text.len().min(300)]
        )
    })?;

    if raw_games.is_empty() {
        return Ok(None);
    }

    // Re-use the same mapping logic from search_igdb_games by calling it inline
    // We just need to map the first result
    let rg = raw_games.into_iter().next().unwrap();

    let build_image_url =
        |img_id: Option<String>, url: Option<String>, size: &str| -> Option<String> {
            if let Some(id) = img_id {
                Some(format!(
                    "https://images.igdb.com/igdb/image/upload/{}/{}.jpg",
                    size, id
                ))
            } else if let Some(u) = url {
                Some(u.replace("t_thumb", size).replace("//", "https://"))
            } else {
                None
            }
        };

    let cover_url = rg
        .cover
        .and_then(|c| build_image_url(c.image_id, c.url, "t_1080p"));
    let artworks = rg.artworks.map(|arts| {
        arts.into_iter()
            .filter_map(|a| build_image_url(a.image_id, a.url, "t_1080p"))
            .collect()
    });
    let screenshots = rg.screenshots.map(|shots| {
        shots
            .into_iter()
            .filter_map(|s| build_image_url(s.image_id, s.url, "t_1080p"))
            .collect()
    });
    let genres = rg.genres.map(|g| g.into_iter().map(|x| x.name).collect());
    let themes = rg.themes.map(|t| t.into_iter().map(|x| x.name).collect());
    let keywords = rg
        .keywords
        .map(|kw| kw.into_iter().filter_map(|x| x.name).collect());
    let platforms = rg
        .platforms
        .map(|p| p.into_iter().filter_map(|x| x.name).collect());
    let game_modes = rg
        .game_modes
        .map(|gm| gm.into_iter().filter_map(|x| x.name).collect());
    let player_perspectives = rg
        .player_perspectives
        .map(|pp| pp.into_iter().filter_map(|x| x.name).collect());
    let game_engines = rg
        .game_engines
        .map(|ge| ge.into_iter().filter_map(|x| x.name).collect());
    let franchise_slug = rg.franchise.as_ref().and_then(|f| f.slug.clone());
    let franchise = rg.franchise.map(|f| f.name);
    let collections = rg.collections.map(|cols| {
        cols.into_iter()
            .map(|c| IgdbCollectionResult {
                id: c.id,
                name: c.name,
                slug: c.slug,
            })
            .collect()
    });
    let franchises = rg.franchises.map(|frs| {
        frs.into_iter()
            .map(|f| IgdbFranchiseResult {
                id: f.id,
                name: f.name,
                slug: f.slug,
            })
            .collect()
    });
    let age_ratings = rg.age_ratings.map(|ratings| {
        ratings
            .into_iter()
            .map(|r| {
                let rating_val = r
                    .rating_category
                    .as_ref()
                    .and_then(|rc| rc.get("rating").or_else(|| rc.get("name")))
                    .and_then(|v| {
                        v.as_str()
                            .map(|s| s.to_string())
                            .or_else(|| v.as_u64().map(|n| n.to_string()))
                    })
                    .or_else(|| {
                        r.rating_category
                            .as_ref()
                            .and_then(|rc| rc.as_str().map(|s| s.to_string()))
                    })
                    .or_else(|| {
                        r.rating_category
                            .as_ref()
                            .and_then(|rc| rc.as_u64().map(|n| n.to_string()))
                    });
                IgdbAgeRatingResult {
                    organization: r.organization.and_then(|o| o.name),
                    rating: rating_val,
                    cover_url: r.rating_cover_url,
                    descriptors: r
                        .rating_content_descriptions
                        .map(|descs| descs.into_iter().filter_map(|d| d.description).collect()),
                    category_id: r.category,
                    rating_id: r.rating,
                }
            })
            .collect()
    });
    let videos = rg.videos.map(|vs| {
        vs.into_iter()
            .filter_map(|v| {
                v.video_id.map(|vid| IgdbVideoResult {
                    name: v.name,
                    video_id: vid,
                })
            })
            .collect()
    });
    let websites = rg.websites.map(|ws| {
        ws.into_iter()
            .filter_map(|w| match (w.url, w.category) {
                (Some(u), Some(c)) => Some(IgdbWebsiteResult {
                    url: u,
                    category: c,
                }),
                _ => None,
            })
            .collect()
    });
    let similar_games = rg.similar_games.map(|sims| {
        sims.into_iter()
            .filter(|s| s.name.is_some())
            .map(|s| SimilarGameResult {
                id: s.id,
                name: s.name.unwrap_or_default(),
                cover_url: s
                    .cover
                    .and_then(|c| build_image_url(c.image_id, c.url, "t_cover_big")),
            })
            .collect()
    });
    let involved_companies = rg.involved_companies.map(|ics| {
        ics.into_iter()
            .filter_map(|ic| {
                let name = ic.company.as_ref().and_then(|c| c.name.clone())?;
                let logo_url = ic
                    .company
                    .as_ref()
                    .and_then(|c| c.logo.as_ref())
                    .and_then(|l| build_image_url(l.image_id.clone(), l.url.clone(), "t_1080p"));
                Some(IgdbInvolvedCompany {
                    name,
                    logo_url,
                    is_developer: ic.developer.unwrap_or(false),
                    is_publisher: ic.publisher.unwrap_or(false),
                    is_porting: ic.porting.unwrap_or(false),
                    is_supporting: ic.supporting.unwrap_or(false),
                })
            })
            .collect()
    });

    Ok(Some(IgdbGameResult {
        id: rg.id,
        slug: rg.slug,
        name: rg.name,
        summary: rg.summary,
        storyline: rg.storyline,
        cover_url,
        artworks,
        screenshots,
        first_release_date: rg.first_release_date,
        genres,
        themes,
        keywords,
        platforms,
        game_modes,
        player_perspectives,
        game_engines,
        age_ratings,
        similar_games,
        franchise,
        franchise_slug,
        collections,
        franchises,
        involved_companies,
        websites,
        videos,
        rating: rg.rating,
        rating_count: rg.rating_count,
        aggregated_rating: rg.aggregated_rating,
        aggregated_rating_count: rg.aggregated_rating_count,
        total_rating: rg.total_rating,
    }))
}

// ─── CheapShark Price Deals ───

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CheapSharkDeal {
    title: String,
    sale_price: String,
    normal_price: String,
    savings: String,
    store_id: String,
    deal_id: String,
    thumb: String,
}

#[tauri::command]
async fn fetch_cheapshark_deals(game_title: String) -> Result<Vec<CheapSharkDeal>, String> {
    let client = app_http_client();
    let encoded = urlencoding::encode(&game_title);
    let url = format!(
        "https://www.cheapshark.com/api/1.0/deals?title={}&upperPrice=100&pageSize=12&sortBy=Price",
        encoded
    );

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("CheapShark request failed: {}", e))?;

    let status = res.status();
    let body_text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read CheapShark response: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "CheapShark API error {}: {}",
            status,
            &body_text[..body_text.len().min(300)]
        ));
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawDeal {
        title: Option<String>,
        sale_price: Option<String>,
        normal_price: Option<String>,
        savings: Option<String>,
        #[serde(rename = "storeID")]
        store_id: Option<String>,
        #[serde(rename = "dealID")]
        deal_id: Option<String>,
        thumb: Option<String>,
    }

    let raw: Vec<RawDeal> =
        serde_json::from_str(&body_text).map_err(|e| format!("Parse error: {}", e))?;

    let deals = raw
        .into_iter()
        .filter_map(|d| {
            Some(CheapSharkDeal {
                title: d.title?,
                sale_price: d.sale_price.unwrap_or_default(),
                normal_price: d.normal_price.unwrap_or_default(),
                savings: d.savings.unwrap_or_default(),
                store_id: d.store_id.unwrap_or_default(),
                deal_id: d.deal_id.unwrap_or_default(),
                thumb: d.thumb.unwrap_or_default(),
            })
        })
        .collect();

    Ok(deals)
}

// ─── IsThereAnyDeal Integration ───

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ItadDeal {
    shop_name: String,
    shop_id: u64,
    current_price: f64,
    regular_price: f64,
    discount_percent: i32,
    currency: String,
    url: String,
    drm: Vec<String>,
    platforms: Vec<String>,
    store_low_price: Option<f64>,
    history_low_price: Option<f64>,
    timestamp: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ItadResult {
    game_id: String,
    game_slug: Option<String>,
    title: String,
    deals: Vec<ItadDeal>,
}

#[tauri::command]
async fn fetch_itad_deals(game_title: String) -> Result<ItadResult, String> {
    dotenv().ok();
    let api_key = get_env("ITAD_API_KEY")
        .map_err(|_| "ITAD_API_KEY not found in .env".to_string())?;

    let client = app_http_client();

    // Step 1: Search for the game to get its ITAD game ID
    let encoded_title = urlencoding::encode(&game_title);
    let search_url = format!(
        "https://api.isthereanydeal.com/games/search/v1?title={}&key={}&results=1",
        encoded_title, api_key
    );

    let search_res = client
        .get(&search_url)
        .send()
        .await
        .map_err(|e| format!("ITAD search request failed: {}", e))?;

    let search_status = search_res.status();
    let search_body = search_res
        .text()
        .await
        .map_err(|e| format!("Failed to read ITAD search response: {}", e))?;

    if !search_status.is_success() {
        return Err(format!(
            "ITAD search API error {}: {}",
            search_status,
            &search_body[..search_body.len().min(300)]
        ));
    }

    #[derive(Deserialize)]
    struct ItadSearchItem {
        id: String,
        slug: Option<String>,
        title: Option<String>,
    }

    let search_results: Vec<ItadSearchItem> = serde_json::from_str(&search_body)
        .map_err(|e| {
            format!(
                "Failed to parse ITAD search response: {} | snippet: {}",
                e,
                &search_body[..search_body.len().min(300)]
            )
        })?;

    let found = search_results
        .into_iter()
        .next()
        .ok_or_else(|| "No matching game found on IsThereAnyDeal".to_string())?;

    let game_id = found.id;
    let game_slug = found.slug;
    let matched_title = found
        .title
        .unwrap_or_else(|| game_title.clone());

    // Step 2: Fetch current prices for the game
    let prices_url = format!(
        "https://api.isthereanydeal.com/games/prices/v2?key={}&country=US&nondeals=true&capacity=24",
        api_key
    );

    let prices_body = serde_json::to_string(&vec![&game_id])
        .map_err(|e| format!("Failed to serialize game IDs: {}", e))?;

    let prices_res = client
        .post(&prices_url)
        .header("Content-Type", "application/json")
        .body(prices_body)
        .send()
        .await
        .map_err(|e| format!("ITAD prices request failed: {}", e))?;

    let prices_status = prices_res.status();
    let prices_text = prices_res
        .text()
        .await
        .map_err(|e| format!("Failed to read ITAD prices response: {}", e))?;

    if !prices_status.is_success() {
        return Err(format!(
            "ITAD prices API error {}: {}",
            prices_status,
            &prices_text[..prices_text.len().min(300)]
        ));
    }

    #[derive(Deserialize)]
    struct PriceShop {
        id: Option<u64>,
        name: Option<String>,
    }

    #[derive(Deserialize)]
    struct PriceAmount {
        amount: Option<f64>,
        currency: Option<String>,
    }

    #[derive(Deserialize)]
    struct DrmEntry {
        name: Option<String>,
    }

    #[derive(Deserialize)]
    struct PlatformEntry {
        name: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawItadDeal {
        shop: Option<PriceShop>,
        price: Option<PriceAmount>,
        regular: Option<PriceAmount>,
        cut: Option<i32>,
        store_low: Option<PriceAmount>,
        history_low: Option<PriceAmount>,
        drm: Option<Vec<DrmEntry>>,
        platforms: Option<Vec<PlatformEntry>>,
        timestamp: Option<String>,
        url: Option<String>,
    }

    #[derive(Deserialize)]
    struct PriceResultEntry {
        deals: Option<Vec<RawItadDeal>>,
    }

    let price_results: Vec<PriceResultEntry> = serde_json::from_str(&prices_text)
        .map_err(|e| {
            format!(
                "Failed to parse ITAD prices: {} | snippet: {}",
                e,
                &prices_text[..prices_text.len().min(300)]
            )
        })?;

    let deals = price_results
        .into_iter()
        .flat_map(|pr| pr.deals.unwrap_or_default())
        .filter_map(|d| {
            let shop = d.shop?;
            let price = d.price?;
            let regular = d.regular;

            Some(ItadDeal {
                shop_name: shop
                    .name
                    .unwrap_or_else(|| format!("Store #{}", shop.id.unwrap_or(0))),
                shop_id: shop.id.unwrap_or(0),
                current_price: price.amount.unwrap_or(0.0),
                regular_price: regular
                    .as_ref()
                    .and_then(|r| r.amount)
                    .unwrap_or(price.amount.unwrap_or(0.0)),
                discount_percent: d.cut.unwrap_or(0),
                currency: price
                    .currency
                    .unwrap_or_else(|| "USD".to_string()),
                url: d.url.unwrap_or_default(),
                drm: d
                    .drm
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|dr| dr.name)
                    .collect(),
                platforms: d
                    .platforms
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|p| p.name)
                    .collect(),
                store_low_price: d.store_low.and_then(|sl| sl.amount),
                history_low_price: d.history_low.and_then(|hl| hl.amount),
                timestamp: d.timestamp,
            })
        })
        .collect();

    Ok(ItadResult {
        game_id,
        game_slug,
        title: matched_title,
        deals,
    })
}

// ─── Hardware Detection ───

#[derive(Serialize, Clone)]
struct HardwareCpuInfo {
    raw_name: String,
    cores: u32,
    threads: u32,
    max_clock_mhz: u32,
}

#[derive(Serialize, Clone)]
struct HardwareGpuInfo {
    raw_name: String,
    vram_bytes: u64,
    driver_version: String,
}

#[derive(Serialize, Clone)]
struct HardwareRamInfo {
    total_bytes: u64,
    speed_mhz: u32,
}

#[derive(Serialize, Clone)]
struct HardwareStorageDevice {
    model: String,
    size_bytes: u64,
    media_type: String,
    is_system_drive: bool,
}

#[derive(Serialize, Clone)]
struct HardwareDisplayInfo {
    width: u32,
    height: u32,
    refresh_rate: u32,
}

#[derive(Serialize, Clone)]
struct HardwareOsInfo {
    name: String,
    version: String,
    build: String,
}

#[derive(Serialize, Clone)]
struct HardwareSnapshot {
    cpu: Option<HardwareCpuInfo>,
    gpus: Vec<HardwareGpuInfo>,
    ram: Option<HardwareRamInfo>,
    storage: Vec<HardwareStorageDevice>,
    display: Option<HardwareDisplayInfo>,
    os: Option<HardwareOsInfo>,
    platform_type: String,
    motherboard: String,
}

fn parse_u32(s: &str) -> u32 {
    s.trim().parse::<u32>().unwrap_or(0)
}

fn parse_u64(s: &str) -> u64 {
    s.trim().parse::<u64>().unwrap_or(0)
}

/// Run a single PowerShell script that collects all hardware info at once,
/// returning a delimited text blob. One process = no startup overhead per query.
#[tauri::command]
async fn detect_hardware() -> HardwareSnapshot {
    // Single PS invocation collects everything. Fields are newline-separated,
    // multi-value rows use "^^^" as record separator and "|||" as field separator.
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1
$allGpus = Get-CimInstance Win32_VideoController
$virtualKeywords = @('Virtual','Basic Display','Remote Desktop','Parsec','IndirectDisplay','IDD Display','Generic Monitor','Meta Virtual','Oculus Virtual')
$gpus = $allGpus | Where-Object {
  $name = $_.Name
  $isVirtual = ($virtualKeywords | Where-Object { $name -like "*$_*" }).Count -gt 0
  -not $isVirtual -and $_.AdapterRAM -gt 0
}
if (-not $gpus) {
  $gpus = $allGpus | Where-Object {
    $name = $_.Name
    ($virtualKeywords | Where-Object { $name -like "*$_*" }).Count -eq 0
  }
}
if (-not $gpus) { $gpus = $allGpus }
$cs   = Get-CimInstance Win32_ComputerSystem
$mem  = Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1
$os   = Get-CimInstance Win32_OperatingSystem
$mb   = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
$enc  = Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1
try { $disks = Get-PhysicalDisk } catch { $disks = @() }
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $scr = [System.Windows.Forms.Screen]::PrimaryScreen
  $dispW = $scr.Bounds.Width; $dispH = $scr.Bounds.Height
} catch { $dispW = 0; $dispH = 0 }
$sysDiskNum = try {
  $letter = $env:SystemDrive.Replace(':','')
  Get-Partition -DriveLetter $letter | Select-Object -First 1 -ExpandProperty DiskNumber
} catch { -1 }
$regBase = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
$regVram = @{}
try {
  Get-ChildItem $regBase -ErrorAction SilentlyContinue | ForEach-Object {
    $desc = (Get-ItemProperty $_.PSPath -Name 'DriverDesc' -ErrorAction SilentlyContinue).DriverDesc
    $mem  = (Get-ItemProperty $_.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
    if ($desc -and $mem) { $regVram[$desc] = [long]$mem }
  }
} catch {}
$gpuLines = ($gpus | ForEach-Object {
  $name = $_.Name
  $vram = if ($regVram.ContainsKey($name)) { $regVram[$name] } else { [long]$_.AdapterRAM }
  "$name|||$vram|||$($_.DriverVersion)"
}) -join '^^^'
$diskLines = @()
$di = 0
foreach ($d in $disks) {
  $isSys = if ($sysDiskNum -eq $di) { '1' } else { '0' }
  $diskLines += "$($d.FriendlyName)|||$($d.Size)|||$($d.MediaType)|||$($d.BusType)|||$isSys"
  $di++
}
$diskStr = $diskLines -join '^^^'
$refresh = ($gpus | Select-Object -First 1).CurrentRefreshRate
$chassis = ($enc.ChassisTypes -join ',')
"CPU_NAME=$($cpu.Name)"
"CPU_CORES=$($cpu.NumberOfCores)"
"CPU_THREADS=$($cpu.NumberOfLogicalProcessors)"
"CPU_CLOCK=$($cpu.MaxClockSpeed)"
"GPUS=$gpuLines"
"RAM_TOTAL=$($cs.TotalPhysicalMemory)"
"RAM_SPEED=$($mem.Speed)"
"DISKS=$diskStr"
"DISP=$dispW|||$dispH"
"REFRESH=$refresh"
"OS_NAME=$($os.Caption)"
"OS_VER=$($os.Version)"
"OS_BUILD=$($os.BuildNumber)"
"MB=$($mb.Manufacturer) $($mb.Product)"
"CHASSIS=$chassis"
"#;

    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("powershell");
        
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();

    // Parse key=value lines
    let mut kv: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for line in output.lines() {
        if let Some((k, v)) = line.split_once('=') {
            kv.insert(k.trim(), v.trim());
        }
    }

    let get = |k: &str| kv.get(k).copied().unwrap_or("").trim().to_string();

    // CPU
    let cpu_name = get("CPU_NAME");
    let cpu = if !cpu_name.is_empty() {
        Some(HardwareCpuInfo {
            raw_name: cpu_name,
            cores: parse_u32(&get("CPU_CORES")),
            threads: parse_u32(&get("CPU_THREADS")),
            max_clock_mhz: parse_u32(&get("CPU_CLOCK")),
        })
    } else {
        None
    };

    // GPUs
    let gpus: Vec<HardwareGpuInfo> = get("GPUS")
        .split("^^^")
        .filter(|s| !s.trim().is_empty())
        .map(|line| {
            let p: Vec<&str> = line.split("|||").collect();
            HardwareGpuInfo {
                raw_name: p.first().unwrap_or(&"").trim().to_string(),
                vram_bytes: p.get(1).map(|s| parse_u64(s)).unwrap_or(0),
                driver_version: p.get(2).unwrap_or(&"").trim().to_string(),
            }
        })
        .filter(|g| !g.raw_name.is_empty() && !g.raw_name.to_lowercase().contains("microsoft basic"))
        .collect();

    // RAM
    let ram_total = parse_u64(&get("RAM_TOTAL"));
    let ram = if ram_total > 0 {
        Some(HardwareRamInfo {
            total_bytes: ram_total,
            speed_mhz: parse_u32(&get("RAM_SPEED")),
        })
    } else {
        None
    };

    // Storage
    let storage: Vec<HardwareStorageDevice> = get("DISKS")
        .split("^^^")
        .filter(|s| !s.trim().is_empty())
        .enumerate()
        .map(|(_idx, line)| {
            let p: Vec<&str> = line.split("|||").collect();
            let model = p.first().unwrap_or(&"").trim().to_string();
            let size = p.get(1).map(|s| parse_u64(s)).unwrap_or(0);
            let media_raw = p.get(2).unwrap_or(&"").trim().to_lowercase();
            let bus_raw = p.get(3).unwrap_or(&"").trim().to_lowercase();
            let is_system = p.get(4).map(|s| s.trim() == "1").unwrap_or(_idx == 0);

            let media_type = if bus_raw.contains("nvme") {
                "nvme"
            } else if media_raw.contains("ssd") || media_raw == "4" {
                "sata_ssd"
            } else if media_raw.contains("hdd") || media_raw == "3" {
                "hdd"
            } else if media_raw == "0" || media_raw.contains("unspecified") {
                "nvme" // unspecified + no nvme bus typically means NVMe on modern systems
            } else {
                "unknown"
            }
            .to_string();

            HardwareStorageDevice { model, size_bytes: size, media_type, is_system_drive: is_system }
        })
        .collect();

    // Display
    let display = {
        let disp = get("DISP");
        let p: Vec<&str> = disp.split("|||").collect();
        let w = p.first().map(|s| parse_u32(s)).unwrap_or(0);
        let h = p.get(1).map(|s| parse_u32(s)).unwrap_or(0);
        if w > 0 && h > 0 {
            Some(HardwareDisplayInfo {
                width: w,
                height: h,
                refresh_rate: parse_u32(&get("REFRESH")),
            })
        } else {
            None
        }
    };

    // OS
    let os_name = get("OS_NAME");
    let os = if !os_name.is_empty() {
        Some(HardwareOsInfo {
            name: os_name,
            version: get("OS_VER"),
            build: get("OS_BUILD"),
        })
    } else {
        None
    };

    // Platform type
    let chassis_types = get("CHASSIS");
    let laptop_types = ["8","9","10","11","12","14","18","21","31","32"];
    let desktop_types = ["3","4","5","6","7","15","16","17","24"];
    let platform_type = chassis_types
        .split(',')
        .fold("unknown", |acc, t| {
            let t = t.trim();
            if acc == "laptop" { acc }
            else if laptop_types.contains(&t) { "laptop" }
            else if acc == "unknown" && desktop_types.contains(&t) { "desktop" }
            else { acc }
        })
        .to_string();

    HardwareSnapshot {
        cpu,
        gpus,
        ram,
        storage,
        display,
        os,
        platform_type,
        motherboard: get("MB"),
    }
}

#[tauri::command]
async fn fetch_image_base64(url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let res = client.get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| e.to_string())?;
        
    if !res.status().is_success() {
        return Err(format!("Image server responded with status: {}", res.status()));
    }
    
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[cfg(target_os = "windows")]
fn configure_webview2_startup() {
    const EXTRA_ARGS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    const REQUIRED_ARGS: &[&str] = &[
        "--disable-gpu",
        "--disable-gpu-compositing",
    ];

    let existing = std::env::var(EXTRA_ARGS_ENV).unwrap_or_default();
    let mut args = existing
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();

    for required in REQUIRED_ARGS {
        if !args.iter().any(|arg| arg == required) {
            args.push((*required).to_string());
        }
    }

    std::env::set_var(EXTRA_ARGS_ENV, args.join(" "));
}

#[cfg(not(target_os = "windows"))]
fn configure_webview2_startup() {}

fn main() {
    configure_webview2_startup();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(12)).await;

                use tauri::Manager;

                if let Some(main_window) = app_handle.get_webview_window("main") {
                    if main_window.is_visible().unwrap_or(false) {
                        return;
                    }

                    if let Some(splashscreen) = app_handle.get_webview_window("splashscreen") {
                        let _ = splashscreen.close();
                    }

                    let _ = main_window.maximize();
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            close_splashscreen,
            scan_for_exes,
            launch_game,
            get_game_data,
            search_steamgrid_assets,
            search_steamgrid_games,
            search_games_db,
            search_web_images,
            connect_steam,
            get_steam_achievements,
            get_steam_playtime,
            get_ubisoft_achievements,
            get_ubisoft_core_challenges,
            get_ubisoft_playtime,
            get_steam_owned_games,
            install_steam_game,
            install_ubisoft_game,
            check_process_running,
            wait_for_processes,
            open_url,
            open_in_file_manager,
            connect_gog,
            refresh_gog_token,
            get_gog_owned_games,
            connect_epic,
            refresh_epic_token,
            get_epic_owned_games,
            connect_ubisoft,
            scanner::get_ubisoft_owned_games,
            scanner::advanced_scan,
            scanner::list_game_exes,
            scanner::path_exists,
            scanner::scan_steam_library,
            scanner::scan_launcher_library,
            get_hltb_data,
            search_igdb_games,
            get_igdb_game_by_id,
            fetch_cheapshark_deals,
            fetch_itad_deals,
            detect_hardware,
            fetch_image_base64
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
