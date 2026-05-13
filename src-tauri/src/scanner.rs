use pelite::pe64::{Pe, PeFile};
use pelite::resources::version_info::VersionInfo;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use walkdir::WalkDir;
use winreg::enums::*;
use winreg::RegKey;

use crate::{fetch_game_data, GameData};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableMetadata {
    pub product_name: Option<String>,
    pub company: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScannedGame {
    pub name: String,
    pub executable: String,
    pub source: String, // "steam" | "scan"
    pub confidence: u32,
    pub metadata: Option<ExecutableMetadata>,
    pub game_data: Option<GameData>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub current: usize,
    pub total: usize,
    pub status: String,
}

// ---------------------------------------------
// FILTER LISTS
// ---------------------------------------------

const MIN_FILE_SIZE: u64 = 3 * 1024 * 1024; // 3MB

const SKIP_NAMES: &[&str] = &[
    // Uninstallers
    "unins000",
    "unins001",
    "unins002",
    "uninstall",
    "uninstaller",
    // Installers / setup
    "setup",
    "installer",
    "install",
    // Updaters
    "update",
    "updater",
    "autoupdate",
    // Crash handlers
    "crash",
    "crashhandler",
    "crashreporter",
    "crashpad_handler",
    "crashpad",
    // Microsoft redistributables
    "vcredist",
    "vcredist_x64",
    "vcredist_x86",
    "vc_redist",
    "dxsetup",
    "dxwebsetup",
    "dotnetfx",
    "dotnet",
    "ue4prereqsetup",
    "ueprereqsetup",
    "prerequisite",
    // OpenAL / PhysX / XNA / etc.
    "oalinst",
    "physxsetup",
    // Anti-cheat short names (EAC.exe, BE_Service.exe, etc.)
    "eac",
    "eac_launcher",
    "be_service",
    "beservice",
    "easyanticheat_setup",
    "battleye_installer",
    // Misc launchers / tools
    "launcher",
    "config",
    "settings",
];

const SKIP_CONTAINS: &[&str] = &[
    "redist",
    "setup",
    "crash",
    "report",
    "unin",
    "vc_red",
    "dxweb",
    "debug",
    "test",
    "wizard",
    "tool",
    "helper",
    "cleaner",
    "sumatra",
    "pdf",
    "crack",
    "patch",
    "bonus",
    "artbook",
    "soundtrack",
    "server",
    "attestation",
    "overlay",
    "browser",
    "cef",
    "shipping_dbg",
    "anticheat",
    "trial",
    "showcase",
    "systemsoftware",
    "dedicatedserver",
    // Catches "eac_launcher", "eac_service", etc. (not just exact "eac")
    "launcher",
    // Microsoft runtimes / frameworks (catches netfx35_x64, netfx40_client, etc.)
    "netfx",
    // XNA Framework installers
    "xnafx",
    // OpenAL installer
    "oalinst",
    // PhysX setup
    "physxsetup",
    // Easy Anti-Cheat / BattleEye
    "easyanticheat",
    "battleye",
    // .NET Desktop / ASP.NET Core runtime installers
    "windowsdesktop",
    "aspnetcore",
    // Prerequisite patterns
    "_prereq",
    "prereqsetup",
    // Installer patterns not covered by exact SKIP_NAMES
    // (catches "GameInstaller.exe", "setup_x64.exe", "install_helper.exe", etc.)
    "install",
    // Background service executables (catches "EAC_Service.exe", "be_service.exe", etc.)
    "_service",
    "_svc",
    // Activation / registration helpers
    "activate",
    "register",
    "register_",
    // Diagnostic / reporting tools
    "diagnos",
    "dxdiag",
    // Benchmark and stress-test exes that appear in some game folders
    "benchmark",
    "stresstest",
    // Shader pre-compilation tools
    "shadercache",
    "shadercomp",
    // Unreal Engine Editor executables (not playable games)
    "unrealedit",
    "ue4edit",
    "ue5edit",
    // VR / graphics benchmark tools
    "vr_perf",
    "vrperft",
    "perftest",
];

// Folders that never contain the primary game executable — skip them entirely
const SKIP_FOLDERS: &[&str] = &[
    "windows",
    "system32",
    "program files",
    "program files (x86)",
    "appdata",
    "$recycle.bin",
    "system volume information",
    // Common game-install redist sub-folders
    "_commonredist",
    "commonredist",
    "_redist",
    "redistributables",
    "redist",
    "prerequisites",
    "_prerequisites",
    "directx",
    "vcredist",
    "dotnet",
    "physx",
    "xnafx",
    // Misc non-game sub-folders
    "content",
    "launcher",
    "support",
];

// Product-name keywords that identify a non-game Microsoft runtime/tool.
// Applied when the PE CompanyName contains "microsoft".
const MICROSOFT_NONGAME_PRODUCTS: &[&str] = &[
    "framework",
    "runtime",
    "redistributable",
    "visual c++",
    "directx",
    ".net",
    "windows desktop",
    "asp.net",
    "visual basic",
    "c runtime",
];

// ---------------------------------------------
// HELPER FUNCTIONS
// ---------------------------------------------

fn normalize_name(name: &str) -> String {
    let mut clean = name.to_lowercase();
    if let Some(pos) = clean.rfind('.') {
        clean.truncate(pos); // remove extension
    }
    clean = clean.replace('_', " ").replace('.', " ").replace('-', " ");

    // Remove "edition", "game of the year" etc. (optional, could be complex)
    clean.trim().to_string()
}

/// Returns true if `stem` (lowercase, alphanumeric) could be an abbreviation formed
/// from the leading characters of consecutive words in `phrase` (lowercase).
/// Example: "grw" → true for "ghost recon wildlands" (G-R-W initials).
fn is_exe_abbreviation_of(stem: &str, phrase: &str) -> bool {
    if stem.len() < 2 || stem.len() > 8 {
        return false;
    }
    // Split phrase into words of at least 2 chars (skip articles / single-char tokens)
    let words: Vec<&str> = phrase
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| w.len() >= 2)
        .collect();
    if words.len() < stem.len() {
        return false;
    }
    let stem_bytes = stem.as_bytes();
    // Try every starting position within the word list
    'outer: for start in 0..=(words.len().saturating_sub(stem.len())) {
        for (i, &ch) in stem_bytes.iter().enumerate() {
            let first = words[start + i].as_bytes()[0];
            if first != ch {
                continue 'outer;
            }
        }
        return true;
    }
    false
}

fn extract_metadata(exe_path: &Path) -> Option<ExecutableMetadata> {
    // Avoid heavy PE memory parsing on colossal Denuvo executables (>200MB)
    let meta = fs::metadata(exe_path).ok()?;
    if meta.len() > 200 * 1024 * 1024 {
        return None;
    }

    let file_data = fs::read(exe_path).ok()?;
    let pe = PeFile::from_bytes(&file_data).ok()?;
    let resources = pe.resources().ok()?;
    let version_info = resources.version_info().ok()?;

    let mut product_name = None;
    let mut company = None;

    let file_info = version_info.file_info();
    for (_lang, string_map) in &file_info.strings {
        if let Some(v) = string_map.get("ProductName") {
            if !v.is_empty() {
                product_name = Some(v.clone());
            }
        }
        if let Some(v) = string_map.get("CompanyName") {
            if !v.is_empty() {
                company = Some(v.clone());
            }
        }
        break;
    }

    Some(ExecutableMetadata {
        product_name,
        company,
    })
}

// ---------------------------------------------
// STEAM DETECTION
// ---------------------------------------------

fn get_steam_path() -> Option<PathBuf> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let steam_key = hkcu.open_subkey("Software\\Valve\\Steam").ok()?;
    let steam_path: String = steam_key.get_value("SteamPath").ok()?;
    Some(PathBuf::from(steam_path))
}

fn parse_steam_libraries() -> Vec<PathBuf> {
    let mut libs = Vec::new();
    if let Some(steam_path) = get_steam_path() {
        let default_lib = steam_path.join("steamapps");
        if default_lib.exists() {
            libs.push(default_lib);
        }

        let vdf_path = steam_path.join("steamapps").join("libraryfolders.vdf");
        if let Ok(content) = fs::read_to_string(&vdf_path) {
            for line in content.lines() {
                if line.contains("\"path\"") {
                    let parts: Vec<&str> = line.split('"').collect();
                    if parts.len() >= 4 {
                        let path = parts[3].replace("\\\\", "\\");
                        let lib_path = PathBuf::from(path).join("steamapps");
                        if lib_path.exists() {
                            libs.push(lib_path);
                        }
                    }
                }
            }
        }
    }
    libs
}

struct SteamGameInfo {
    app_id: u32,
    name: String,
    install_dir: String,
    library_path: PathBuf,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SteamInstalledGame {
    pub app_id: u32,
    pub name: String,
    pub install_path: String, // Full path to steamapps/common/<installdir>
}

fn parse_steam_manifests() -> Vec<SteamGameInfo> {
    let libs = parse_steam_libraries();
    let mut games = Vec::new();

    for lib in libs {
        if let Ok(entries) = fs::read_dir(&lib) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("acf") {
                    if let Ok(content) = fs::read_to_string(&path) {
                        let mut app_id = 0u32;
                        let mut name = String::new();
                        let mut install_dir = String::new();
                        for line in content.lines() {
                            let parts: Vec<&str> = line.split('"').collect();
                            if parts.len() >= 4 {
                                match parts[1] {
                                    "appid" => app_id = parts[3].parse().unwrap_or(0),
                                    "name" => name = parts[3].to_string(),
                                    "installdir" => install_dir = parts[3].to_string(),
                                    _ => {}
                                }
                            }
                        }
                        if !name.is_empty() && !install_dir.is_empty() {
                            games.push(SteamGameInfo {
                                app_id,
                                name,
                                install_dir,
                                library_path: lib.clone(),
                            });
                        }
                    }
                }
            }
        }
    }
    games
}

#[tauri::command]
pub async fn scan_steam_library() -> Vec<SteamInstalledGame> {
    let manifests = parse_steam_manifests();
    let mut games = Vec::new();

    for m in manifests {
        let install_path = m.library_path.join("common").join(&m.install_dir);
        if install_path.exists() {
            games.push(SteamInstalledGame {
                app_id: m.app_id,
                name: m.name,
                install_path: install_path.to_string_lossy().to_string(),
            });
        }
    }

    games
}

fn get_steam_directory_map() -> HashMap<PathBuf, String> {
    let mut map = HashMap::new();
    let steam_games = parse_steam_manifests();

    for game in steam_games {
        // e.g., "C:\SteamLibrary\steamapps\common\Alan Wake 2" -> "Alan Wake 2"
        let game_dir = game.library_path.join("common").join(&game.install_dir);
        if let Ok(canon) = game_dir.canonicalize() {
            map.insert(canon, game.name);
        } else {
            map.insert(game_dir, game.name);
        }
    }
    map
}

fn collect_exe_paths(path: &str) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let root = Path::new(path);
    if !root.exists() || !root.is_dir() {
        return results;
    }

    // Fast pass to grab all exes in real-time
    for entry in WalkDir::new(root)
        .max_depth(7)
        .into_iter()
        .filter_entry(|e| {
            // Never filter the root itself (depth 0) — the caller explicitly chose this folder.
            // Only prune known non-game sub-directories.
            if e.depth() > 0 && e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                return !SKIP_FOLDERS.contains(&name.as_str());
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("exe") {
            results.push(p.to_path_buf());
        }
    }

    results
}

// Messages sent from the blocking scanner thread to the async event emitter
enum ScanMessage {
    Progress(ScanProgress),
    GameFound(ScannedGame),
    Done(Vec<ScannedGame>),
}

#[tauri::command]
pub async fn advanced_scan(
    app: tauri::AppHandle,
    folders: Vec<String>,
) -> Result<Vec<ScannedGame>, String> {
    let _ = app.emit("scan-started", ());
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            current: 0,
            total: 100,
            status: "Preparing...".to_string(),
        },
    );

    let (tx, rx) = std::sync::mpsc::channel::<ScanMessage>();

    // Heavy synchronous work runs on a dedicated OS thread
    std::thread::spawn(move || {
        // Phase 1: collect all exe paths
        let mut exe_paths = Vec::new();
        for folder in &folders {
            if folder.is_empty() {
                continue;
            }
            let _ = tx.send(ScanMessage::Progress(ScanProgress {
                current: 0,
                total: 100,
                status: format!(
                    "Sweeping {}...",
                    Path::new(folder)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ),
            }));
            let mut paths = collect_exe_paths(folder);
            exe_paths.append(&mut paths);
        }

        let total_exes = exe_paths.len();
        let mut all_scanned = Vec::new();
        let steam_dirs = get_steam_directory_map();

        // Phase 2: process each exe
        for (i, p) in exe_paths.into_iter().enumerate() {
            let exe_name = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // Send progress for every exe — the async side will throttle display
            let _ = tx.send(ScanMessage::Progress(ScanProgress {
                current: i + 1,
                total: total_exes,
                status: format!("Validating {}...", exe_name),
            }));

            let stem = p
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if SKIP_NAMES.contains(&stem.as_ref()) || SKIP_CONTAINS.iter().any(|s| stem.contains(s))
            {
                continue;
            }

            // Also reject if any ancestor folder is a known redist/support folder
            // (catches cases where collect_exe_paths walked in before filtering could apply)
            let in_skip_folder = p.ancestors().skip(1).any(|ancestor| {
                if let Some(name) = ancestor.file_name() {
                    let n = name.to_string_lossy().to_lowercase();
                    SKIP_FOLDERS.contains(&n.as_str())
                } else {
                    false
                }
            });
            if in_skip_folder {
                continue;
            }

            if let Ok(meta) = fs::metadata(&p) {
                let is_small = meta.len() < MIN_FILE_SIZE;
                if is_small {
                    // Most small exes are non-game (updaters, tiny stubs, tools).
                    // Allow only those that look like root-level stub launchers:
                    // the exe sits beside a folder with the same name (e.g.
                    // Hellblade2.exe + Hellblade2/), or beside an Engine/ directory
                    // (Unreal Engine layout like Lies of P / LOP.exe + Engine/).
                    let is_stub_launcher = p.parent().map_or(false, |parent| {
                        if let Ok(entries) = fs::read_dir(parent) {
                            for entry in entries.flatten() {
                                if !entry.file_type().map_or(false, |ft| ft.is_dir()) {
                                    continue;
                                }
                                let dir_name = entry
                                    .file_name()
                                    .to_string_lossy()
                                    .to_lowercase();
                                if dir_name == stem || dir_name == "engine" {
                                    return true;
                                }
                            }
                        }
                        false
                    });
                    if !is_stub_launcher {
                        continue;
                    }
                }

                let parent_dir = p
                    .parent()
                    .and_then(|pa| pa.file_name())
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let metadata = extract_metadata(&p);

                // Skip exes that PE metadata identifies as Microsoft runtimes/redistributables
                if let Some(m) = &metadata {
                    if let Some(company) = &m.company {
                        if company.to_lowercase().contains("microsoft") {
                            if let Some(prod) = &m.product_name {
                                let prod_lower = prod.to_lowercase();
                                if MICROSOFT_NONGAME_PRODUCTS
                                    .iter()
                                    .any(|kw| prod_lower.contains(kw))
                                {
                                    continue;
                                }
                            }
                        }
                    }
                    // Skip Unreal Engine Editor / tooling executables regardless of company
                    if let Some(prod) = &m.product_name {
                        let prod_lower = prod.to_lowercase();
                        if prod_lower.contains("unreal engine") || prod_lower.contains("unreal editor") {
                            continue;
                        }
                    }
                }

                let mut confidence = 20;
                let mut possible_name = stem.clone();
                let mut got_good_name = false;

                if let Some(m) = &metadata {
                    if let Some(prod_name) = &m.product_name {
                        confidence += 30;
                        possible_name = prod_name.clone();
                        got_good_name = true;
                    }
                }

                if !got_good_name {
                    let mut current_dir = p.parent();
                    let mut good_dir_name = parent_dir.clone();
                    let generic_dirs = [
                        "bin", "binaries", "win64", "win32", "x64", "x86", "64", "32",
                    ];

                    while let Some(dir) = current_dir {
                        let d_name = dir
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        if d_name.is_empty() {
                            break;
                        }
                        let d_lower = d_name.to_lowercase();

                        if generic_dirs.contains(&d_lower.as_str()) {
                            current_dir = dir.parent();
                            continue;
                        }

                        // Non-generic directory — use as candidate name.
                        good_dir_name = d_name;

                        // If the name has spaces it's a proper human-readable game title — stop.
                        // Also stop for long names (>12 chars) which are usually descriptive.
                        if good_dir_name.contains(' ') || good_dir_name.len() > 12 {
                            break;
                        }

                        // Short single-word name (e.g. "LiesofP") may be a CamelCase abbreviation.
                        // Keep walking upward to look for a better multi-word ancestor.
                        current_dir = dir.parent();
                    }

                    // Confidence bonuses from the resolved ancestor folder name.
                    // Compute these before good_dir_name is potentially moved into possible_name.
                    let good_dir_lower = good_dir_name.to_lowercase();
                    let clean_ancestor = normalize_name(&good_dir_name);
                    if clean_ancestor.contains(&normalize_name(&possible_name))
                        || normalize_name(&possible_name).contains(&clean_ancestor)
                    {
                        confidence += 10;
                    }
                    // Abbreviation bonus: exe stem matches initials of ancestor folder words.
                    // e.g. "grw" → "Ghost Recon Wildlands" inside "Tom Clancy's Ghost Recon Wildlands".
                    if is_exe_abbreviation_of(&stem, &good_dir_lower) {
                        confidence += 30;
                    }

                    if good_dir_name.contains(' ') || good_dir_name.len() > possible_name.len() {
                        possible_name = good_dir_name;
                    } else {
                        possible_name = normalize_name(&possible_name);
                    }
                }

                // Stub launchers are the preferred launch target — boost them
                // so they win deduplication against the full shipping binary.
                if is_small {
                    confidence += 25;
                }
                // Cap UE shipping builds at 25 so stub launchers (45+) always win
                // dedup, but the exe stays above the 20-point emission threshold
                // in case no companion stub exists.  (Steam lookup runs later and
                // overrides confidence to 90, so this cap is harmless for Steam games.)
                if (stem.contains("win64") || stem.contains("win32"))
                    && stem.contains("shipping")
                {
                    confidence = confidence.min(25);
                }

                let mut g = ScannedGame {
                    name: possible_name,
                    executable: p.to_string_lossy().to_string(),
                    source: "scan".to_string(),
                    confidence,
                    metadata,
                    game_data: None,
                };

                // Enhance with Steam Lookup
                let mut matched_steam_name = None;
                if let Some(parent) = p.parent() {
                    let parent_canon = parent
                        .canonicalize()
                        .unwrap_or_else(|_| parent.to_path_buf());
                    let mut current_dir = Some(parent_canon.as_path());
                    while let Some(dir) = current_dir {
                        if let Some(steam_name) = steam_dirs.get(dir) {
                            matched_steam_name = Some(steam_name.clone());
                            break;
                        }
                        current_dir = dir.parent();
                    }
                }

                if let Some(name) = matched_steam_name {
                    g.name = name;
                    g.source = "steam".to_string();
                    g.confidence = 90;
                }

                // Final name-based filter: discard known non-game titles that can slip
                // through (e.g. Steam-matched "SteamVR Performance Test", PE-named
                // "Unreal Engine", etc.)
                {
                    let n = g.name.to_lowercase();
                    if n.contains("performance test")
                        || n.contains("unreal engine")
                        || n.contains("unreal editor")
                        || (n.contains("benchmark") && !n.contains("mark of"))
                    {
                        continue;
                    }
                }

                if g.confidence >= 20 || g.source == "steam" {
                    let _ = tx.send(ScanMessage::GameFound(g.clone()));
                    all_scanned.push(g);
                }
            }
        }

        // Deduplicate
        let mut unique_games: HashMap<String, ScannedGame> = HashMap::new();
        for g in all_scanned {
            let key = g
                .name
                .to_lowercase()
                .replace(|c: char| !c.is_alphanumeric(), "");
            if let Some(existing) = unique_games.get(&key) {
                let override_existing = if g.source == "steam" && existing.source != "steam" {
                    true
                } else if g.source != "steam" && existing.source == "steam" {
                    false
                } else {
                    g.confidence > existing.confidence
                };
                if override_existing {
                    unique_games.insert(key, g);
                }
            } else {
                unique_games.insert(key, g);
            }
        }

        let mut high_conf_games: Vec<_> = unique_games.into_values().collect();
        high_conf_games.sort_by(|a, b| b.confidence.cmp(&a.confidence));

        let _ = tx.send(ScanMessage::Done(high_conf_games));
    });

    // Async-friendly event emitter: polls the std channel with small sleeps
    let mut final_result = Vec::new();
    let mut last_progress_emit = std::time::Instant::now();

    loop {
        match rx.try_recv() {
            Ok(ScanMessage::Progress(p)) => {
                // Throttle progress emissions to ~20fps (50ms) for silky smooth UI
                let now = std::time::Instant::now();
                if now.duration_since(last_progress_emit).as_millis() >= 50 || p.current == p.total
                {
                    let _ = app.emit("scan-progress", p);
                    last_progress_emit = now;
                }
            }
            Ok(ScanMessage::GameFound(g)) => {
                let _ = app.emit("game-found", g);
            }
            Ok(ScanMessage::Done(results)) => {
                final_result = results;
                break;
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                // Channel empty but sender alive — sleep briefly to avoid busy-waiting
                // Must use tokio::time::sleep inside an async command to avoid blocking the Tokio worker
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                break;
            }
        }
    }

    Ok(final_result)
}

// ---------------------------------------------
// MULTI-LAUNCHER DETECTION
// ---------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LauncherGame {
    pub name: String,
    pub install_path: String, // game directory (not exe)
    pub platform: String,     // "GOG" | "Epic" | "Ubisoft" | "EA" | "Battle.net"
    pub launcher_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UbisoftOwnedGame {
    pub app_id: String,
    pub title: String,
}

#[derive(Clone, Debug)]
struct UbisoftConfigGame {
    app_id: String,
    install_id: String,
    space_id: String,
    title: String,
}

fn unquote_ubisoft_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0] as char;
        let last = trimmed.as_bytes()[trimmed.len() - 1] as char;
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn extract_ubisoft_launcher_install_id(value: &str) -> Option<String> {
    let marker = r"Launcher\Installs\";
    let start = value.find(marker)? + marker.len();
    let install_id: String = value[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();

    if install_id.is_empty() {
        None
    } else {
        Some(install_id)
    }
}

fn normalize_ubisoft_title(value: &str) -> String {
    value
        .replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn looks_like_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    looks_like_uuid_bytes(bytes)
}

fn looks_like_uuid_bytes(bytes: &[u8]) -> bool {
    if bytes.len() != 36 {
        return false;
    }
    for (idx, ch) in bytes.iter().enumerate() {
        let is_dash = matches!(idx, 8 | 13 | 18 | 23);
        if is_dash {
            if *ch != b'-' {
                return false;
            }
        } else if !(*ch as char).is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn is_ubisoft_placeholder_name(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_lowercase();
    if matches!(
        lower.as_str(),
        "live" | "ubisoftconnect_qc" | "ubsioftconnect_qc"
    ) {
        return true;
    }
    let placeholder = lower.strip_prefix('l').unwrap_or("");
    !placeholder.is_empty() && placeholder.chars().all(|ch| ch.is_ascii_digit())
}

fn should_skip_ubisoft_title(title: &str) -> bool {
    let lower = title.to_lowercase();
    lower.contains("uplay client")
        || lower.contains("ubisoft connect")
        || lower.contains("technical test")
        || lower.contains("test server")
        || lower.ends_with(" pts")
        || lower.contains(" - pts")
}

fn ubisoft_launcher_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_app_data).join("Ubisoft Game Launcher"));
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("Ubisoft")
                .join("Ubisoft Game Launcher"),
        );
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Ubisoft")
                .join("Ubisoft Game Launcher"),
        );
    }
    candidates.push(PathBuf::from(
        r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher",
    ));
    candidates.push(PathBuf::from(
        r"C:\Program Files\Ubisoft\Ubisoft Game Launcher",
    ));

    candidates.into_iter().find(|path| path.exists())
}

fn ubisoft_configuration_path() -> Option<PathBuf> {
    ubisoft_launcher_root().map(|root| {
        root.join("cache")
            .join("configuration")
            .join("configurations")
    })
}

fn ubisoft_ownership_dir() -> Option<PathBuf> {
    ubisoft_launcher_root().map(|root| root.join("cache").join("ownership"))
}

fn parse_ubisoft_config_games() -> Vec<UbisoftConfigGame> {
    let Some(config_path) = ubisoft_configuration_path() else {
        return Vec::new();
    };
    let Ok(bytes) = fs::read(config_path) else {
        return Vec::new();
    };

    let text = String::from_utf8_lossy(&bytes).replace('\r', "");
    let mut seen_app_ids = HashSet::new();
    let mut games = Vec::new();

    for chunk in text.split("root:").skip(1) {
        let mut name = String::new();
        let mut display_name = String::new();
        let mut default_title = String::new();
        let mut app_id = String::new();
        let mut install_id = String::new();
        let mut space_id = String::new();
        let mut has_start_game = false;

        let mut in_localizations = false;
        let mut in_default_localization = false;

        for raw_line in chunk.lines() {
            let line = raw_line.trim_end_matches('\0');
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            if trimmed == "start_game:" || trimmed.starts_with("start_game:") {
                has_start_game = true;
                continue;
            }

            if trimmed == "localizations:" {
                in_localizations = true;
                in_default_localization = false;
                continue;
            }

            if in_localizations && trimmed.ends_with(':') && !trimmed.contains(": ") {
                in_default_localization = trimmed == "default:";
                continue;
            }

            if let Some((key, value)) = trimmed.split_once(':') {
                let key = key.trim();
                let parsed = unquote_ubisoft_value(value);

                match key {
                    "register" => {
                        if install_id.is_empty() {
                            if let Some(resolved_install_id) =
                                extract_ubisoft_launcher_install_id(&parsed)
                            {
                                install_id = resolved_install_id;
                            }
                        }
                    }
                    "name" => {
                        if name.is_empty() {
                            name = parsed;
                        }
                    }
                    "display_name" => {
                        if display_name.is_empty() {
                            display_name = parsed;
                        }
                    }
                    "app_id" => {
                        if app_id.is_empty() && looks_like_uuid(&parsed) {
                            app_id = parsed;
                        }
                    }
                    "space_id" => {
                        if space_id.is_empty() && looks_like_uuid(&parsed) {
                            space_id = parsed;
                        }
                    }
                    "achievements_sync_id" => {
                        if install_id.is_empty()
                            && !parsed.is_empty()
                            && parsed.chars().all(|ch| ch.is_ascii_digit())
                        {
                            install_id = parsed;
                        }
                    }
                    "l1" => {
                        if in_localizations && in_default_localization && default_title.is_empty() {
                            default_title = parsed;
                        }
                    }
                    _ => {}
                }
            }
        }

        if !has_start_game || app_id.is_empty() {
            continue;
        }

        let raw_title = if !display_name.trim().is_empty() {
            display_name
        } else if !is_ubisoft_placeholder_name(&name) {
            name
        } else {
            default_title
        };

        let title = normalize_ubisoft_title(&raw_title);
        if title.is_empty()
            || should_skip_ubisoft_title(&title)
            || !seen_app_ids.insert(app_id.clone())
        {
            continue;
        }

        games.push(UbisoftConfigGame {
            app_id,
            install_id,
            space_id,
            title,
        });
    }

    games
}

fn extract_uuid_strings(bytes: &[u8]) -> Vec<String> {
    let mut matches = Vec::new();
    let mut idx = 0usize;

    while idx + 36 <= bytes.len() {
        let slice = &bytes[idx..idx + 36];
        if looks_like_uuid_bytes(slice) {
            matches.push(String::from_utf8_lossy(slice).to_string());
            idx += 36;
        } else {
            idx += 1;
        }
    }

    matches
}

fn resolve_ubisoft_ownership_file(account_id: &str) -> Option<PathBuf> {
    let dir = ubisoft_ownership_dir()?;

    if !account_id.trim().is_empty() {
        let exact = dir.join(account_id.trim());
        if exact.exists() {
            return Some(exact);
        }
    }

    let entries: Vec<PathBuf> = fs::read_dir(&dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.is_file())
        .collect();

    if entries.len() == 1 {
        entries.into_iter().next()
    } else {
        None
    }
}

pub fn get_ubisoft_owned_games_from_cache(
    account_id: &str,
) -> Result<Vec<UbisoftOwnedGame>, String> {
    let config_games = parse_ubisoft_config_games();
    if config_games.is_empty() {
        return Err("Ubisoft Connect game configuration cache was not found.".to_string());
    }

    let Some(ownership_path) = resolve_ubisoft_ownership_file(account_id) else {
        return Err("Ubisoft Connect ownership cache was not found for this profile.".to_string());
    };
    let ownership_bytes = fs::read(&ownership_path)
        .map_err(|err| format!("Failed to read Ubisoft ownership cache: {err}"))?;

    let config_by_app_id: HashMap<_, _> = config_games
        .into_iter()
        .map(|game| (game.app_id.clone(), game))
        .collect();

    let mut seen_app_ids = HashSet::new();
    let mut owned_games = Vec::new();

    for uuid in extract_uuid_strings(&ownership_bytes) {
        if !seen_app_ids.insert(uuid.clone()) {
            continue;
        }
        let Some(config) = config_by_app_id.get(&uuid) else {
            continue;
        };
        owned_games.push(UbisoftOwnedGame {
            app_id: uuid,
            title: config.title.clone(),
        });
    }

    owned_games.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(owned_games)
}

#[tauri::command]
pub async fn get_ubisoft_owned_games(account_id: String) -> Result<Vec<UbisoftOwnedGame>, String> {
    get_ubisoft_owned_games_from_cache(&account_id)
}

pub fn resolve_ubisoft_install_id(app_id: &str) -> Option<String> {
    parse_ubisoft_config_games()
        .into_iter()
        .find(|game| game.app_id.eq_ignore_ascii_case(app_id))
        .and_then(|game| {
            let install_id = game.install_id.trim().to_string();
            if install_id.is_empty() {
                None
            } else {
                Some(install_id)
            }
        })
}

pub fn resolve_ubisoft_space_id(app_id: &str) -> Option<String> {
    parse_ubisoft_config_games()
        .into_iter()
        .find(|game| game.app_id.eq_ignore_ascii_case(app_id))
        .and_then(|game| {
            let space_id = game.space_id.trim().to_string();
            if space_id.is_empty() {
                None
            } else {
                Some(space_id)
            }
        })
}

// ── GOG Galaxy ────────────────────────────────────────────────────────────────
fn scan_gog_library() -> Vec<LauncherGame> {
    let mut games: Vec<LauncherGame> = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    for reg_path in &[
        "SOFTWARE\\GOG.com\\Games",
        "SOFTWARE\\WOW6432Node\\GOG.com\\Games",
    ] {
        if let Ok(gog_key) = hklm.open_subkey(reg_path) {
            for game_id in gog_key.enum_keys().flatten() {
                if let Ok(game_key) = gog_key.open_subkey(&game_id) {
                    let name: String = game_key.get_value("GAMENAME").unwrap_or_default();
                    let path: String = game_key.get_value("PATH").unwrap_or_default();
                    if !name.is_empty() && !path.is_empty() && Path::new(&path).exists() {
                        // Avoid duplicates between 32/64-bit registry views
                        if !games.iter().any(|g| g.launcher_id == game_id) {
                            games.push(LauncherGame {
                                name,
                                install_path: path,
                                platform: "GOG".to_string(),
                                launcher_id: game_id,
                            });
                        }
                    }
                }
            }
        }
    }
    games
}

// ── Epic Games Launcher ───────────────────────────────────────────────────────
fn scan_epic_library() -> Vec<LauncherGame> {
    let mut games = Vec::new();

    let program_data =
        std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    let manifests_dir = PathBuf::from(&program_data)
        .join("Epic")
        .join("EpicGamesLauncher")
        .join("Data")
        .join("Manifests");

    if !manifests_dir.exists() {
        return games;
    }

    let entries = match fs::read_dir(&manifests_dir) {
        Ok(e) => e,
        Err(_) => return games,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("item") {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Skip incomplete or non-executable entries
        if json["bIsIncompleteInstall"].as_bool().unwrap_or(false) {
            continue;
        }

        let name = json["DisplayName"].as_str().unwrap_or("").to_string();
        let install_location = json["InstallLocation"].as_str().unwrap_or("").to_string();
        let app_name = json["AppName"].as_str().unwrap_or("").to_string();

        if name.is_empty() || install_location.is_empty() {
            continue;
        }

        // Skip the launcher itself, Unreal Engine installs, and other non-games
        let name_lower = name.to_lowercase();
        if name_lower.contains("launcher")
            || name_lower.contains("unreal engine")
            || name_lower.contains("redistributable")
        {
            continue;
        }

        if !Path::new(&install_location).exists() {
            continue;
        }

        games.push(LauncherGame {
            name,
            install_path: install_location,
            platform: "Epic".to_string(),
            launcher_id: app_name,
        });
    }
    games
}

// ── Ubisoft Connect ───────────────────────────────────────────────────────────
fn scan_ubisoft_library() -> Vec<LauncherGame> {
    let mut games: Vec<LauncherGame> = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let config_by_install_id: HashMap<_, _> = parse_ubisoft_config_games()
        .into_iter()
        .filter(|game| !game.install_id.trim().is_empty())
        .map(|game| (game.install_id.clone(), game))
        .collect();

    for reg_path in &[
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ] {
        if let Ok(uninstall_key) = hklm.open_subkey(reg_path) {
            for subkey_name in uninstall_key.enum_keys().flatten() {
                let lower = subkey_name.to_lowercase();
                if !lower.starts_with("uplay install ") {
                    continue;
                }
                if let Ok(game_key) = uninstall_key.open_subkey(&subkey_name) {
                    let name: String = game_key.get_value("DisplayName").unwrap_or_default();
                    let install_path: String =
                        game_key.get_value("InstallLocation").unwrap_or_default();
                    if name.is_empty()
                        || install_path.is_empty()
                        || !Path::new(&install_path).exists()
                    {
                        continue;
                    }
                    let game_id = subkey_name.trim_start_matches("Uplay Install ").to_string();
                    let (resolved_name, resolved_id) = match config_by_install_id.get(&game_id) {
                        Some(config) => (config.title.clone(), config.app_id.clone()),
                        None => (name, game_id),
                    };

                    if !games.iter().any(|g| g.launcher_id == resolved_id) {
                        games.push(LauncherGame {
                            name: resolved_name,
                            install_path,
                            platform: "Ubisoft Connect".to_string(),
                            launcher_id: resolved_id,
                        });
                    }
                }
            }
        }
    }
    games
}

// ── EA App ────────────────────────────────────────────────────────────────────
fn scan_ea_library() -> Vec<LauncherGame> {
    let mut games: Vec<LauncherGame> = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    let ea_publishers = [
        "Electronic Arts",
        "EA Games",
        "EA Sports",
        "BioWare",
        "Respawn Entertainment",
        "Criterion",
        "Maxis",
        "DICE",
    ];
    let skip_names = [
        "ea app",
        "origin",
        "ea anticheat",
        "ea desktop",
        "redistributable",
        "runtime",
        "vcredist",
    ];

    for reg_path in &[
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ] {
        if let Ok(uninstall_key) = hklm.open_subkey(reg_path) {
            for subkey_name in uninstall_key.enum_keys().flatten() {
                if let Ok(game_key) = uninstall_key.open_subkey(&subkey_name) {
                    let publisher: String = game_key.get_value("Publisher").unwrap_or_default();
                    if !ea_publishers.iter().any(|p| publisher.contains(p)) {
                        continue;
                    }
                    let name: String = game_key.get_value("DisplayName").unwrap_or_default();
                    let name_lower = name.to_lowercase();
                    if skip_names.iter().any(|s| name_lower.contains(s)) {
                        continue;
                    }
                    let install_path: String =
                        game_key.get_value("InstallLocation").unwrap_or_default();
                    if name.is_empty()
                        || install_path.is_empty()
                        || !Path::new(&install_path).exists()
                    {
                        continue;
                    }
                    if !games.iter().any(|g| g.name == name) {
                        games.push(LauncherGame {
                            name,
                            install_path,
                            platform: "EA".to_string(),
                            launcher_id: subkey_name,
                        });
                    }
                }
            }
        }
    }
    games
}

// ── Battle.net ────────────────────────────────────────────────────────────────
fn scan_battlenet_library() -> Vec<LauncherGame> {
    let mut games = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    for reg_path in &[
        "SOFTWARE\\WOW6432Node\\Blizzard Entertainment",
        "SOFTWARE\\Blizzard Entertainment",
    ] {
        if let Ok(blizzard_key) = hklm.open_subkey(reg_path) {
            for game_name in blizzard_key.enum_keys().flatten() {
                // Skip the launcher entry itself
                if game_name.eq_ignore_ascii_case("battle.net") {
                    continue;
                }
                if let Ok(game_key) = blizzard_key.open_subkey(&game_name) {
                    let install_path: String =
                        game_key.get_value("InstallPath").unwrap_or_default();
                    if !install_path.is_empty() && Path::new(&install_path).exists() {
                        if !games.iter().any(|g: &LauncherGame| g.name == game_name) {
                            games.push(LauncherGame {
                                name: game_name.clone(),
                                install_path,
                                platform: "Battle.net".to_string(),
                                launcher_id: game_name,
                            });
                        }
                    }
                }
            }
        }
    }
    games
}

/// Scan all supported game launchers and return their installed games.
/// Covers GOG Galaxy, Epic Games, Ubisoft Connect, EA App, and Battle.net.
#[tauri::command]
pub async fn scan_launcher_library() -> Vec<LauncherGame> {
    let mut all = Vec::new();
    all.extend(scan_gog_library());
    all.extend(scan_epic_library());
    all.extend(scan_ubisoft_library());
    all.extend(scan_ea_library());
    all.extend(scan_battlenet_library());
    all
}

// ─── Single-folder exe listing ────────────────────────────────────────────────
// Used by the "Add Single Game" flow. Returns all plausible game exes in a
// single folder, sorted by likelihood score. Separate from advanced_scan so
// we don't lose exes to name-based deduplication.

#[tauri::command]
pub async fn list_game_exes(folder: String) -> Result<Vec<String>, String> {
    let root = Path::new(&folder);
    if !root.exists() || !root.is_dir() {
        return Err(format!("Not a directory: {}", folder));
    }

    let folder_name = root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let _folder_clean: String = folder_name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();

    struct Candidate {
        path: PathBuf,
        score: i32,
    }

    // No size filter here — the user intentionally chose this folder, and some
    // games use small stub loaders (e.g. Ubisoft Connect titles). Filename-pattern
    // filtering is sufficient to exclude non-game exes.
    let mut candidates: Vec<Candidate> = Vec::new();

    for entry in WalkDir::new(root)
        .max_depth(6)
        .into_iter()
        .filter_entry(|e| {
            // Never filter the root itself (depth 0); only prune sub-directories.
            // This ensures we can scan any folder the user explicitly selected,
            // even if its name matches a SKIP_FOLDERS entry (e.g. "launcher").
            if e.depth() > 0 && e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                !SKIP_FOLDERS.contains(&name.as_str())
            } else {
                true
            }
        })
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() || p.extension().and_then(|s| s.to_str()) != Some("exe") {
            continue;
        }

        let stem = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();

        // Filename-pattern filter
        if SKIP_NAMES.contains(&stem.as_ref()) || SKIP_CONTAINS.iter().any(|s| stem.contains(s)) {
            continue;
        }

        // PE-metadata company filter (Microsoft runtimes)
        let pe = extract_metadata(p);
        if let Some(ref m) = pe {
            if let Some(ref company) = m.company {
                if company.to_lowercase().contains("microsoft") {
                    if let Some(ref prod) = m.product_name {
                        let pl = prod.to_lowercase();
                        if MICROSOFT_NONGAME_PRODUCTS.iter().any(|kw| pl.contains(kw)) {
                            continue;
                        }
                    }
                }
            }
        }

        // Scoring
        let depth = entry.depth() as i32;
        let stem_clean: String = stem.chars().filter(|c| c.is_alphanumeric()).collect();
        let mut score = 100i32;

        // Shallower = more likely the main exe
        score -= depth * 8;

        // Score against the root folder name AND every intermediate ancestor folder
        // between the exe and the root. This ensures that e.g. an exe inside
        // "Tom Clancy's Ghost Recon Wildlands/Binaries/Win64/GRW.exe" scores
        // against the game-root name, not just the immediate "Win64" parent.
        let mut best_folder_score = 0i32;
        {
            // Collect all folder names to check: root first, then intermediates
            let mut folder_names_lower: Vec<String> = vec![folder_name.clone()];
            let mut cursor = p.parent();
            while let Some(anc) = cursor {
                if anc == root {
                    break;
                }
                let anc_lower = anc
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                folder_names_lower.push(anc_lower);
                cursor = anc.parent();
            }

            for fname_lower in &folder_names_lower {
                let fname_clean: String =
                    fname_lower.chars().filter(|c| c.is_alphanumeric()).collect();
                if fname_clean.is_empty() {
                    continue;
                }
                let bonus = if stem_clean == fname_clean {
                    60
                } else if stem_clean.contains(&fname_clean) || fname_clean.contains(&stem_clean) {
                    30
                } else if is_exe_abbreviation_of(&stem_clean, fname_lower) {
                    // exe stem matches initials of ancestor-folder words (e.g. GRW → Ghost Recon Wildlands)
                    25
                } else {
                    0
                };
                if bonus > best_folder_score {
                    best_folder_score = bonus;
                }
            }
        }
        score += best_folder_score;

        // Has PE product name (real compiled application, not a random binary)
        if pe.as_ref().and_then(|m| m.product_name.as_ref()).is_some() {
            score += 15;
        }

        // Penalise exes whose name suggests a sub-tool
        if stem.contains("launcher") {
            score -= 20;
        }

        // Penalise Unreal Engine shipping build naming (e.g. "GameName-Win64-Shipping.exe").
        // These are valid game executables, but if a stub launcher exists alongside them it
        // should be preferred as the launch target (better icon, no platform suffix in name).
        if (stem.contains("win64") || stem.contains("win32")) && stem.contains("shipping") {
            score -= 30;
        } else if stem.ends_with("-shipping") || stem.ends_with("_shipping") {
            score -= 20;
        }

        candidates.push(Candidate {
            path: p.to_path_buf(),
            score,
        });
    }

    candidates.sort_by(|a, b| b.score.cmp(&a.score));
    Ok(candidates
        .into_iter()
        .map(|c| c.path.to_string_lossy().into_owned())
        .collect())
}

/// Check whether a path (file or directory) currently exists on disk.
/// Used by the JS side to verify game install status without applying
/// any exe-name or folder-name filters.
#[tauri::command]
pub async fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}
