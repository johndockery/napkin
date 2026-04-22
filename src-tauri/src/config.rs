//! User config loader. Reads a small JSON file and hands it to the frontend.
//!
//! JSON avoids adding a TOML dep; the file is user-written and small enough
//! that keeping both serializer and parser in serde_json is fine. Unknown
//! keys are preserved as raw JSON so the frontend can evolve the schema
//! without a round-trip through Rust.

use std::path::PathBuf;

pub(crate) fn config_path() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("napkin").join("config.json");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config/napkin/config.json")
}

#[tauri::command]
pub(crate) fn load_config() -> serde_json::Value {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            serde_json::from_str::<serde_json::Value>(&content).unwrap_or_else(|_| {
                eprintln!(
                    "napkin: {} is not valid JSON, falling back to defaults",
                    path.display()
                );
                serde_json::json!({})
            })
        }
        Err(_) => serde_json::json!({}),
    }
}
