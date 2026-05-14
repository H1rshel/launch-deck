use std::collections::HashMap;

const BUNDLED_ENV_KEYS: &[&str] = &[
    "IGDB_CLIENT_ID",
    "IGDB_CLIENT_SECRET",
    "ITAD_API_KEY",
    "STEAM_API_KEY",
    "VITE_GAMES_DB_API_KEY",
    "VITE_RAWG_API_KEY",
    "VITE_SGD_API_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_URL",
];

fn read_dotenv() -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Ok(contents) = std::fs::read_to_string("../.env") else {
        return values;
    };

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
        values.insert(key.trim().to_string(), value);
    }

    values
}

fn main() {
    let dotenv = read_dotenv();
    println!("cargo:rerun-if-changed=../.env");
    for key in BUNDLED_ENV_KEYS {
        println!("cargo:rerun-if-env-changed={}", key);
        let value = std::env::var(key)
            .ok()
            .or_else(|| dotenv.get(*key).cloned())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if let Some(value) = value {
            println!("cargo:rustc-env={}={}", key, value);
        }
    }

    tauri_build::build()
}
