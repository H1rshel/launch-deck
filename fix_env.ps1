$content = Get-Content -Raw "src-tauri\src\main.rs"

# Insert get_env function after imports
$getEnvFunc = @"
use walkdir::WalkDir;

fn get_env(key: &str) -> Result<String, String> {
    if let Ok(val) = std::env::var(key) {
        return Ok(val);
    }
    let env_content = include_str!("../../.env");
    for line in env_content.lines() {
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == key {
                return Ok(v.trim().to_string());
            }
        }
    }
    Err(format!("{} not found", key))
}

"@

$content = $content -replace 'use walkdir::WalkDir;\r?\n', $getEnvFunc

# Replace all API key usages
$keys = @("STEAM_API_KEY", "VITE_RAWG_API_KEY", "VITE_SGD_API_KEY", "VITE_GAMES_DB_API_KEY", "IGDB_CLIENT_ID", "IGDB_CLIENT_SECRET", "ITAD_API_KEY")

foreach ($key in $keys) {
    $content = $content -replace "std::env::var\(`"$key`"\)", "get_env(`"$key`")"
}

Set-Content -NoNewline -Path "src-tauri\src\main.rs" -Value $content
