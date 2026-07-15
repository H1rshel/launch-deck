// Streaming support: Sunshine (host) / Moonlight (client) provisioning and
// control. All commands here are Windows-first — Launch Deck ships on Windows.

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hidden_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn streaming_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;
    let dir = base.join("streaming");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    Ok(dir)
}

// ── Identity / network ───────────────────────────────────────────────────────

#[tauri::command]
pub fn get_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "PC".to_string())
}

/// Primary LAN IPv4 of this machine. Uses the connected-UDP-socket trick —
/// no packet is actually sent.
#[tauri::command]
pub fn get_local_ip() -> Result<String, String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket
        .connect("8.8.8.8:80")
        .map_err(|e| e.to_string())?;
    let addr = socket.local_addr().map_err(|e| e.to_string())?;
    Ok(addr.ip().to_string())
}

// ── Downloads ────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct DownloadProgress {
    dest_name: String,
    downloaded: u64,
    total: u64,
}

/// Streams a file into {app_data}/streaming/downloads/{dest_name}, emitting
/// "download_progress" events roughly every 500ms. Returns the final path.
#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    url: String,
    dest_name: String,
) -> Result<String, String> {
    if dest_name.contains('/') || dest_name.contains('\\') || dest_name.contains("..") {
        return Err("Invalid destination name".into());
    }

    let downloads = streaming_dir(&app)?.join("downloads");
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let dest = downloads.join(&dest_name);
    let tmp = downloads.join(format!("{}.part", dest_name));

    let client = reqwest::Client::builder()
        .user_agent(crate::APP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Download failed: {}", e))?;

    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Download interrupted: {}", e))?
    {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 500 {
            last_emit = std::time::Instant::now();
            let _ = app.emit(
                "download_progress",
                DownloadProgress {
                    dest_name: dest_name.clone(),
                    downloaded,
                    total,
                },
            );
        }
    }
    drop(file);

    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "download_progress",
        DownloadProgress {
            dest_name: dest_name.clone(),
            downloaded,
            total: downloaded.max(total),
        },
    );

    Ok(dest.to_string_lossy().to_string())
}

/// Extracts a zip using PowerShell Expand-Archive (no extra crate needed).
/// MUST be async + spawn_blocking: sync Tauri commands run on the main
/// thread, and a multi-second extraction froze the whole window
/// ("Launch Deck is not responding").
#[tauri::command]
pub async fn extract_zip(zip_path: String, dest_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let output = hidden_command("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    zip_path.replace('\'', "''"),
                    dest_dir.replace('\'', "''")
                ),
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Err(format!(
                "Extraction failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Elevated provisioning ────────────────────────────────────────────────────

/// Runs a PowerShell script elevated (one UAC prompt), waits for completion,
/// and verifies success via a marker file the wrapper writes at the end.
/// Returns Err if the user declines the UAC prompt or the script fails.
#[tauri::command]
pub async fn run_elevated_script(app: tauri::AppHandle, script: String) -> Result<(), String> {
    let dir = streaming_dir(&app)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let script_path = dir.join(format!("elevate_{}.ps1", stamp));
    let marker_path = dir.join(format!("elevate_{}.ok", stamp));

    let marker_literal = marker_path.to_string_lossy().replace('\'', "''");
    let full_script = format!(
        "$ErrorActionPreference = 'Stop'\ntry {{\n{}\nSet-Content -LiteralPath '{}' -Value 'ok'\n}} catch {{\n  exit 1\n}}\n",
        script, marker_literal
    );
    std::fs::write(&script_path, &full_script).map_err(|e| e.to_string())?;

    let script_literal = script_path.to_string_lossy().replace('\'', "''");
    // Outer (non-elevated) PowerShell launches the inner one with -Verb RunAs
    // and waits. A declined UAC prompt makes Start-Process throw.
    let launcher = format!(
        "try {{ $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','{}'; exit $p.ExitCode }} catch {{ exit 100 }}",
        script_literal
    );

    let status = tauri::async_runtime::spawn_blocking(move || {
        hidden_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &launcher])
            .status()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let ok = marker_path.exists();
    let _ = std::fs::remove_file(&script_path);
    let _ = std::fs::remove_file(&marker_path);

    if !ok {
        if status.code() == Some(100) {
            return Err("Administrator permission was declined".into());
        }
        return Err(format!(
            "Setup script failed (exit code {:?})",
            status.code()
        ));
    }
    Ok(())
}

// ── Sunshine host ────────────────────────────────────────────────────────────

pub const SUNSHINE_EXE: &str = r"C:\Program Files\Sunshine\sunshine.exe";

#[tauri::command]
pub fn is_sunshine_installed() -> bool {
    std::path::Path::new(SUNSHINE_EXE).exists()
}

#[tauri::command]
pub async fn is_sunshine_service_running() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        let output = hidden_command("sc")
            .args(["query", "SunshineService"])
            .output();
        match output {
            Ok(out) => String::from_utf8_lossy(&out.stdout).contains("RUNNING"),
            Err(_) => false,
        }
    })
    .await
    .unwrap_or(false)
}

/// Stable per-Windows-install identifier — survives app reinstalls, DB
/// resets, and first-launch races (unlike a generated-and-persisted UUID).
#[tauri::command]
pub fn get_machine_guid() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
        use winreg::RegKey;
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags("SOFTWARE\\Microsoft\\Cryptography", KEY_READ | KEY_WOW64_64KEY)
            .map_err(|e| e.to_string())?;
        let guid: String = key.get_value("MachineGuid").map_err(|e| e.to_string())?;
        Ok(guid.trim().to_lowercase())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("MachineGuid is Windows-only".into())
    }
}

/// Calls the local Sunshine REST API (https://localhost:47990). Sunshine uses
/// a self-signed cert, so this dedicated client skips TLS verification —
/// acceptable because the connection never leaves localhost.
#[tauri::command]
pub async fn sunshine_api(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    username: String,
    password: String,
) -> Result<serde_json::Value, String> {
    if !path.starts_with('/') {
        return Err("Path must start with /".into());
    }

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://localhost:47990{}", path);
    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        other => return Err(format!("Unsupported method: {}", other)),
    };

    request = request.basic_auth(&username, Some(&password));
    if let Some(json_body) = body {
        request = request.json(&json_body);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Sunshine API unreachable: {}", e))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("Sunshine API {} — {}", status.as_u16(), text));
    }

    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) => Ok(value),
        Err(_) => Ok(serde_json::json!({ "raw": text })),
    }
}

// ── Moonlight client ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct MoonlightExitedPayload {
    session_id: String,
    code: i32,
}

/// Spawns Moonlight with the given args and emits "moonlight_exited" with the
/// exit code when it closes. session_id lets the frontend match launches.
#[tauri::command]
pub fn launch_moonlight(
    app: tauri::AppHandle,
    exe_path: String,
    args: Vec<String>,
    session_id: String,
) -> Result<(), String> {
    let exe = std::path::Path::new(&exe_path);
    if !exe.exists() {
        return Err(format!("Moonlight not found at {}", exe_path));
    }
    let dir = exe.parent().map(|p| p.to_path_buf());

    let mut cmd = std::process::Command::new(&exe_path);
    cmd.args(&args);
    if let Some(d) = dir {
        cmd.current_dir(d);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch Moonlight: {}", e))?;

    std::thread::spawn(move || {
        let code = child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(-1);
        let _ = app.emit("moonlight_exited", MoonlightExitedPayload { session_id, code });
    });

    Ok(())
}

/// Force-terminates a process by image name (used to cancel a stream).
#[tauri::command]
pub async fn kill_process_by_name(process_name: String) -> Result<(), String> {
    if process_name.trim().is_empty() || process_name.contains(&['/', '\\', '"'][..]) {
        return Err("Invalid process name".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = hidden_command("taskkill")
            .args(["/IM", &process_name, "/F"])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            // Process not running is fine for a cancel path
            let msg = String::from_utf8_lossy(&output.stderr).to_string();
            if !msg.contains("not found") && !msg.contains("128") {
                return Err(msg);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
