//! napkin UI core. Thin client over the napkind unix-socket daemon.

mod client;
mod commands;
mod config;
mod events;

use tauri::Manager;

use crate::client::{start_client, Client};
use crate::commands::{
    diff_decide, open_in_editor, pty_kill, pty_list, pty_resize, pty_spawn, pty_subscribe,
    pty_write, search_history,
};
use crate::config::{
    config_ensure, config_open, config_path_string, config_reset, config_reveal, load_config,
    spawn_config_watcher,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            match start_client(handle.clone()) {
                Ok(client) => {
                    app.manage(client);
                }
                Err(error) => {
                    eprintln!("napkin: failed to connect to napkind: {error}");
                    // Keep the invoke surface available so the frontend gets a
                    // clean error instead of a missing state panic.
                    app.manage(Client::disconnected());
                }
            }
            spawn_config_watcher(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_list,
            pty_subscribe,
            load_config,
            config_path_string,
            config_ensure,
            config_open,
            config_reveal,
            config_reset,
            open_in_editor,
            search_history,
            diff_decide,
        ])
        .run(tauri::generate_context!())
        .expect("error while running napkin");
}
